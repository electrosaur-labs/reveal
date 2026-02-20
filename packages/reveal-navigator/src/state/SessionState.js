/**
 * SessionState - Centralized state coordinator for Navigator UI
 *
 * Bridges the reactive 512px proxy preview ("Navigation" phase)
 * with final high-fidelity production render.
 *
 * Design principles:
 *   - State coordinator, NOT an engine — delegates to @reveal/core
 *   - Simple on/off/emit listener pattern (no framework dependency)
 *   - Built-in debounce for slider scrubbing (~50ms)
 *   - ProxyEngine is the hot path for mechanical knobs
 */

const EventEmitter = require('./EventEmitter');
const Reveal = require('@reveal/core');

const logger = Reveal.logger;

// Parameters that only need mask/preview re-render (fast path via ProxyEngine.updateProxy)
const MECHANICAL_KNOBS = new Set(['minVolume', 'speckleRescue', 'shadowClamp']);

// Parameters that only affect production render (not proxy preview).
// Trap pixel sizes are resolution-dependent — meaningless at 512px proxy.
const PRODUCTION_KNOBS = new Set(['trapSize']);

// Initial defaults for production-only knobs (archetype configs don't define these).
// Without explicit reset, stale values leak across archetype swaps.
const PRODUCTION_KNOB_DEFAULTS = { trapSize: 0 };

// Parameters that require full re-posterization (slow path via ProxyEngine.initializeProxy).
// This is the complete set from ParameterGenerator output — any change triggers rePosterize.
const STRUCTURAL_PARAMS = new Set([
    'targetColors', 'engineType', 'centroidStrategy', 'distanceMetric',
    // Saliency weights
    'lWeight', 'cWeight', 'blackBias',
    // Vibrancy
    'vibrancyMode', 'vibrancyBoost', 'vibrancyThreshold',
    // Highlights
    'highlightThreshold', 'highlightBoost',
    // Palette merging
    'paletteReduction', 'enablePaletteReduction',
    // Substrate
    'substrateMode', 'substrateTolerance',
    // Hue analysis
    'enableHueGapAnalysis', 'hueLockAngle',
    // Shadow/tone
    'shadowPoint',
    // Color mode
    'colorMode',
    // Preservation
    'preserveWhite', 'preserveBlack',
    // Neutral clamping
    'neutralCentroidClampThreshold', 'neutralSovereigntyThreshold',
    // Surgical
    'chromaGate', 'detailRescue', 'medianPass',
    // Dither
    'ditherType',
    // Preprocessing
    'preprocessingIntensity',
    // Transparency
    'ignoreTransparent',
    // Mask / Edge
    'maskProfile',
    // Screen mesh
    'meshSize',
    // K-means refinement
    'refinementPasses'
]);

// Union of all user-facing knobs (for snapshot/restore/reset/dirty loops).
// Includes mechanical, production, and ALL structural params from config.
const ALL_KNOBS = new Set([
    ...MECHANICAL_KNOBS, ...PRODUCTION_KNOBS, ...STRUCTURAL_PARAMS
]);

const DEBOUNCE_MS = 50;

class SessionState extends EventEmitter {

    constructor() {
        super();

        // Reactive state — UI-facing parameters.
        // ALL config-driven params start undefined — populated by _applyConfigToState()
        // when the first archetype loads. No hardcoded defaults; the archetype IS the default.
        this.state = {
            // Archetype context
            activeArchetypeId: null,
            isArchetypeDirty: false,

            // Production-only (not in archetype config)
            trapSize: 0,  // 0=off, 1-10px trap expansion

            // Engine & preview state
            isProcessing: false,
            productionRenderPending: false,
            proxyBufferReady: false,

            // Decision support state
            isKnobsCustomized: false,   // true when any knob differs from archetype defaults
            highlightColorIndex: -1     // -1 = no highlight, 0+ = isolated color
        };

        // Separate from reactive state
        this.paletteOverrides = new Map();  // colorIndex → {L, a, b}
        this.mergeHistory = new Map();      // targetIndex → Set<sourceIndex>
        this.deletedColors = new Set();     // colorIndex values deleted via Alt+click
        this.proxyEngine = null;
        this.currentConfig = null;          // Full config from ParameterGenerator
        this.previewBuffer = null;          // Current RGBA preview
        this.imageDNA = null;               // DNA v2.0 snapshot
        this.imageWidth = 0;                // Proxy dimensions
        this.imageHeight = 0;
        this.originalWidth = 0;             // Full document dimensions (for loupe coord mapping)
        this.originalHeight = 0;

        // Snapshot of knob values from archetype config (for dirty detection)
        this._archetypeDefaults = null;

        // Per-archetype state cache: archetypeId → {knobs, paletteOverrides, mergeHistory, deletedColors}
        // Auto-saved on swap-out, auto-restored on swap-in (seamless round-trip).
        this._archetypeStateCache = new Map();

        // Progressive palette generation counter (incremented to cancel in-flight loops)
        this._paletteGeneration = 0;

        // Debounce timer
        this._debounceTimer = null;

        // Concurrency guard: prevents overlapping triggerProxyUpdate calls
        this._updateInFlight = false;
        this._updateQueued = false;
    }

    /**
     * Reset all session-specific state. Called when the dialog closes
     * so no stale overrides/merges persist into the next invocation.
     */
    reset() {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        this.paletteOverrides.clear();
        this.mergeHistory.clear();
        this.deletedColors.clear();
        this._archetypeStateCache.clear();
        this._paletteGeneration = 0;
        this.proxyEngine = null;
        this.currentConfig = null;
        this.previewBuffer = null;
        this.imageDNA = null;
        this.imageWidth = 0;
        this.imageHeight = 0;
        this.originalWidth = 0;
        this.originalHeight = 0;
        this._archetypeDefaults = null;
        this._updateInFlight = false;
        this._updateQueued = false;
        this.state.activeArchetypeId = null;
        this.state.isArchetypeDirty = false;
        this.state.isProcessing = false;
        this.state.productionRenderPending = false;
        this.state.proxyBufferReady = false;
        this.state.isKnobsCustomized = false;
        this.state.highlightColorIndex = -1;

        // Reset production-only knobs (archetype configs don't define these)
        this.state.trapSize = 0;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    /**
     * Load a new image into the session using progressive pulse architecture.
     *
     * Pulse 1 — Structural Lock (~51ms): DNA + score all archetypes → carouselReady
     * Pulse 2 — Best-Fit Preview (~400ms): Top-1 proxy → previewUpdated
     * Pulse 3 — Progressive Palettes (background): Generate palette per card
     *
     * Pulse 1 emits carouselReady BEFORE the heavy proxy init so the browser
     * can paint 17 card frames while the CPU is busy posterizing the active
     * archetype. Cards appear ~550ms into ingest; preview ~400ms later.
     *
     * IMPORTANT: We do NOT copy labPixels — UXP's Uint16Array copy produces
     * stale all-white buffers. Instead, we use the original reference for the
     * initial pipeline, and ProxyEngine stores its own downsampled proxyBuffer
     * internally. For subsequent archetype swaps, we re-posterize from the
     * ProxyEngine's stored proxyBuffer.
     *
     * @param {Uint16Array} labPixels - 16-bit Lab pixel data (L,a,b triples)
     * @param {number} width
     * @param {number} height
     * @param {number} [originalWidth] - Full document width (if PS GPU downsampled)
     * @param {number} [originalHeight] - Full document height (if PS GPU downsampled)
     * @returns {Promise<Object>} Initial proxy result
     */
    async loadImage(labPixels, width, height, originalWidth, originalHeight) {
        this.imageWidth = width;
        this.imageHeight = height;
        this.originalWidth = originalWidth || width;
        this.originalHeight = originalHeight || height;
        this.paletteOverrides.clear();
        this.mergeHistory.clear();
        this.deletedColors.clear();
        this._archetypeStateCache.clear();

        // ── Phase 2: STRUCTURAL — DNA analysis (~51ms) ──
        this.emit('progress', { phase: 'structural', label: 'Analyzing image DNA\u2026', percent: 35 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        const dnaGen = new Reveal.DNAGenerator();
        this.imageDNA = dnaGen.generate(labPixels, width, height, { bitDepth: 16 });
        logger.log(`[SessionState] Pulse 1: DNA generated (dominant_sector=${this.imageDNA.dominant_sector})`);

        this.emit('dnaReady', this.imageDNA);

        // ── Phase 3: STRATEGIC — score all archetypes (<1ms) ──
        this.emit('progress', { phase: 'strategic', label: 'Mapping archetypes\u2026', percent: 50 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        const archetypes = Reveal.ArchetypeLoader.loadArchetypes();
        const mapper = new Reveal.ArchetypeMapper(archetypes);
        const allScores = mapper.getTopMatches(this.imageDNA, archetypes.length);

        // Inject Chameleon — score derived from blend distance to nearest cluster.
        // Close to a cluster centroid → high confidence → higher score.
        // Linear decay: score = 75 - 10 * distance, clamped to [30, 85].
        this._chameleonConfig = Reveal.generateConfigurationMk2(this.imageDNA);
        const nearestDist = this._chameleonConfig.meta.blendInfo.neighbors[0].distance;
        const chameleonScore = Math.max(30, Math.min(85, 75 - 10 * nearestDist));
        const dynamicEntry = {
            id: 'dynamic_interpolator',
            score: chameleonScore,
            _synthetic: { name: 'Chameleon', preferred_sectors: [] }
        };

        // Insert at correct position (allScores already sorted descending by getTopMatches).
        // Avoids Array.sort() which can misbehave in JSC with NaN-adjacent comparisons.
        let insertIdx = allScores.length;
        for (let i = 0; i < allScores.length; i++) {
            if (chameleonScore >= allScores[i].score) { insertIdx = i; break; }
        }
        allScores.splice(insertIdx, 0, dynamicEntry);

        const topMatch = allScores[0];
        logger.log(`[SessionState] Pulse 1: Scored ${allScores.length} entries, Chameleon=${chameleonScore.toFixed(0)} (dist=${nearestDist.toFixed(2)}), top=${topMatch.id} (${topMatch.score.toFixed(0)})`);

        this.emit('carouselReady', { scores: allScores, topMatchId: topMatch.id });

        // ── Phase 4: VISUAL — proxy posterization + knob init (~400ms) ──
        this.emit('progress', { phase: 'visual', label: 'Initializing navigator\u2026', percent: 65 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        // Generate config from the top match.
        // Chameleon uses cached Mk2 config; archetypes use ParameterGenerator.
        if (topMatch.id === 'dynamic_interpolator') {
            this.currentConfig = this._chameleonConfig;
        } else {
            this.currentConfig = Reveal.generateConfiguration(this.imageDNA, {
                manualArchetypeId: topMatch.id
            });
        }
        this._applyConfigToState(this.currentConfig);
        if (!this.currentConfig.engineType) {
            this.currentConfig.engineType = this.state.engineType;
        }

        this.emit('imageLoaded', { width, height, dna: this.imageDNA });
        this.emit('configChanged', this.currentConfig);

        // Initialize ProxyEngine — pass the live buffer directly.
        // If Photoshop GPU already downsampled to proxy size,
        // ProxyEngine will skip redundant _downsampleBilinear().
        this.proxyEngine = new Reveal.ProxyEngine();
        const proxyResult = await this.proxyEngine.initializeProxy(
            labPixels, width, height, this.currentConfig
        );

        logger.log(`[SessionState] Pulse 2: Posterized ${proxyResult.palette.length} colors, ${proxyResult.dimensions.width}x${proxyResult.dimensions.height} in ${proxyResult.elapsedMs.toFixed(0)}ms`);
        this.emit('proxyReady', proxyResult);
        this.emit('progress', { phase: 'visual', label: 'Applying knobs\u2026', percent: 85 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        // Apply knobs (speckleRescue, shadowClamp, minVolume) with explicit state values
        const knobResult = await this.proxyEngine.updateProxy({
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp
        });

        this.previewBuffer = knobResult.previewBuffer;
        this.state.proxyBufferReady = true;
        this.state.isProcessing = false;

        const initialAccuracy = this.calculateCurrentAccuracy();
        const initialFidelity = this.calculateDNAFidelity();
        this.emit('previewUpdated', {
            previewBuffer: knobResult.previewBuffer,
            palette: knobResult.palette,
            activeColorCount: this._countActiveColors(),
            elapsedMs: proxyResult.elapsedMs + knobResult.elapsedMs,
            dimensions: proxyResult.dimensions,
            accuracyDeltaE: initialAccuracy,
            dnaFidelity: initialFidelity
        });

        // ── Pulse 3: Progressive palette previews (background) ──
        setTimeout(() => this._generateRemainingPalettes(topMatch, allScores), 10);

        return proxyResult;
    }

    /**
     * Background task (Pulse 3): generate palette previews + ΔE quality scores
     * for each archetype card. After all palettes are computed, re-sort the
     * carousel by ΔE (ascending = best quality first) and re-emit carouselReady.
     *
     * @private
     */
    async _generateRemainingPalettes(topMatch, scores) {
        const generation = ++this._paletteGeneration;

        // Active archetype's ΔE is already known from proxy separation
        const activeDE = this.calculateCurrentAccuracy();
        const activeMatch = scores.find(s => s.id === topMatch.id);
        if (activeMatch) activeMatch.meanDeltaE = activeDE;

        let computed = 1;  // active already done
        for (const match of scores) {
            if (match.id === topMatch.id) continue;
            if (generation !== this._paletteGeneration) return;

            try {
                const config = match.id === 'dynamic_interpolator'
                    ? Reveal.generateConfigurationMk2(this.imageDNA)
                    : Reveal.generateConfiguration(this.imageDNA, {
                        manualArchetypeId: match.id
                    });
                const palette = await this.proxyEngine.getPaletteWithQuality(config);

                if (generation !== this._paletteGeneration) return;

                match.meanDeltaE = palette.meanDeltaE;
                computed++;

                this.emit('archetypePaletteReady', {
                    archetypeId: match.id,
                    rgbPalette: palette.rgbPalette
                });

                // Progressive re-sort every 5 archetypes (+ final).
                // Entries with ΔE go first (ascending), without ΔE go after.
                if (computed % 5 === 0) {
                    this.emit('carouselReady', { scores: this._sortByDeltaE(scores), topMatchId: topMatch.id });
                }

                await new Promise(r => setTimeout(r, 0));
            } catch (err) {
                logger.log(`[SessionState] Palette gen failed for ${match.id}: ${err.message}`);
            }
        }

        if (generation !== this._paletteGeneration) return;
        // Final re-sort with all ΔE values
        this.emit('carouselReady', { scores: this._sortByDeltaE(scores), topMatchId: topMatch.id });
        logger.log(`[SessionState] Pulse 3 complete: ${computed} archetypes scored by ΔE`);
    }

    /**
     * Sort scores by meanDeltaE ascending (best quality first).
     * Entries without ΔE are appended in their original order.
     * Uses manual insertion to avoid Array.sort() JSC issues.
     * @private
     */
    _sortByDeltaE(scores) {
        const withDE = [];
        const withoutDE = [];
        for (const s of scores) {
            const de = s.meanDeltaE;
            if (de == null || de !== de) { withoutDE.push(s); continue; }
            // Insert ascending
            let idx = withDE.length;
            for (let i = 0; i < withDE.length; i++) {
                if (de <= withDE[i].meanDeltaE) { idx = i; break; }
            }
            withDE.splice(idx, 0, s);
        }
        return withDE.concat(withoutDE);
    }

    // ─── Knob Reset ─────────────────────────────────────────

    /**
     * Reset a single mechanical knob to its archetype default.
     * @param {string} key - 'minVolume', 'speckleRescue', or 'shadowClamp'
     */
    resetKnob(key) {
        if (!this._archetypeDefaults || this._archetypeDefaults[key] === undefined) return;
        this.updateParameter(key, this._archetypeDefaults[key]);
    }

    /**
     * Reset ALL knobs to archetype defaults AND clear palette surgery.
     * Deletes the cache entry for the current archetype so swapping away
     * and back arrives at fresh defaults (no stale restored state).
     */
    resetToDefaults() {
        if (!this._archetypeDefaults) return;

        // Reset all knobs to archetype defaults
        for (const key of ALL_KNOBS) {
            this.state[key] = this._archetypeDefaults[key];
            if (this.currentConfig) this.currentConfig[key] = this._archetypeDefaults[key];
        }

        // Clear palette surgery
        this.paletteOverrides.clear();
        this.mergeHistory.clear();
        this.deletedColors.clear();

        // Delete cache entry so re-entering doesn't restore stale state
        const id = this.state.activeArchetypeId;
        if (id) this._archetypeStateCache.delete(id);

        this.state.isKnobsCustomized = false;
        this.state.highlightColorIndex = -1;
        this.emit('highlightChanged', { colorIndex: -1 });
        this.emit('knobsCustomizedChanged', { customized: false });
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
        this.emit('configChanged', this.currentConfig);  // triggers MechanicalKnobs sync
        this._scheduleProxyUpdate();
    }

    /**
     * Get the archetype default for a knob key, or null if not available.
     * @param {string} key
     * @returns {number|null}
     */
    getKnobDefault(key) {
        return this._archetypeDefaults ? this._archetypeDefaults[key] : null;
    }

    // ─── Parameter Updates (Reactive Loop) ───────────────────

    /**
     * Update a single parameter and schedule a proxy update.
     *
     * @param {string} key - Parameter name
     * @param {*} value - New value
     */
    updateParameter(key, value) {
        if (this.state[key] === value) return;

        this.state[key] = value;

        // Mark archetype dirty when structural param changes
        if (STRUCTURAL_PARAMS.has(key)) {
            this.state.isArchetypeDirty = true;
            logger.log(`[SessionState] Structural param: ${key}=${value} → isArchetypeDirty=true`);
        }

        // Detect knob customization vs archetype defaults
        if (ALL_KNOBS.has(key) && this._archetypeDefaults) {
            const wasCustomized = this.state.isKnobsCustomized;
            this.state.isKnobsCustomized = false;
            for (const k of ALL_KNOBS) {
                if (this.state[k] !== this._archetypeDefaults[k]) {
                    this.state.isKnobsCustomized = true;
                    break;
                }
            }
            if (this.state.isKnobsCustomized !== wasCustomized) {
                this.emit('knobsCustomizedChanged', { customized: this.state.isKnobsCustomized });
            }
        }

        this.emit('parameterChanged', { key, value });

        // Production-only knobs don't affect the 512px proxy preview
        if (PRODUCTION_KNOBS.has(key)) return;

        this._scheduleProxyUpdate();
    }

    /**
     * Debounced wrapper — collapses rapid slider scrubs into single update.
     * @private
     */
    _scheduleProxyUpdate() {
        if (this._debounceTimer !== null) {
            clearTimeout(this._debounceTimer);
        }
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            this.triggerProxyUpdate();
        }, DEBOUNCE_MS);
    }

    /**
     * Execute a proxy update. Chooses fast path (mechanical knob)
     * or slow path (structural re-posterize) based on what changed.
     *
     * Concurrency guard: if an update is already in flight, queue one
     * re-run instead of overlapping. This prevents race conditions
     * where a stale posterization overwrites a fresh one.
     *
     * @returns {Promise<Object>} Updated preview data
     */
    async triggerProxyUpdate() {
        if (!this.proxyEngine) return null;

        // Concurrency guard: if already running, queue a re-run
        if (this._updateInFlight) {
            this._updateQueued = true;
            logger.log(`[SessionState] triggerProxyUpdate: queued (in-flight)`);
            return null;
        }

        this._updateInFlight = true;
        this.state.isProcessing = true;
        this.emit('processingStart');

        try {
            let result;

            if (this.state.isArchetypeDirty) {
                // Slow path: structural param changed — full re-posterize
                // Uses rePosterize to avoid redundant downsample.
                // Clear palette overrides — old indices are meaningless
                // against the new baseline from re-posterization.

                this._rebuildConfigFromState();

                this.paletteOverrides.clear();
                this.mergeHistory.clear();
                this.deletedColors.clear();
                this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
                result = await this.proxyEngine.rePosterize(this.currentConfig);
                this.state.isArchetypeDirty = false;
                logger.log(`[SessionState] Structural re-posterize: targetColors=${this.currentConfig.targetColors}, palette=${result.palette.length} colors`);
            }

            // Build update params — always include palette overrides so they
            // survive the baseline restore inside updateProxy
            const updateParams = {
                minVolume: this.state.minVolume,
                speckleRescue: this.state.speckleRescue,
                shadowClamp: this.state.shadowClamp
            };
            if (this.paletteOverrides.size > 0) {
                updateParams.paletteOverride = this._buildOverriddenPalette();
            }

            logger.log(`[SessionState] triggerProxyUpdate: calling updateProxy...`);
            result = await this.proxyEngine.updateProxy(updateParams);
            logger.log(`[SessionState] triggerProxyUpdate: updateProxy done, palette=${result.palette ? result.palette.length : '?'}`);

            this.previewBuffer = result.previewBuffer;
            this.state.isProcessing = false;
            this.state.proxyBufferReady = true;

            this._emitPreviewUpdated(result);
            logger.log(`[SessionState] triggerProxyUpdate: previewUpdated emitted`);

            return result;
        } catch (err) {
            this.state.isProcessing = false;
            logger.log(`[SessionState] Proxy update FAILED: ${err.message}\n${err.stack}`);
            this.emit('error', err);
            return null;
        } finally {
            this._updateInFlight = false;

            // If another update was queued while we were running, run it now
            if (this._updateQueued) {
                this._updateQueued = false;
                logger.log(`[SessionState] triggerProxyUpdate: draining queued update`);
                this.triggerProxyUpdate();
            }
        }
    }

    // ─── Archetype Navigation ────────────────────────────────

    /**
     * Swap to a different archetype. Regenerates config and re-inits proxy.
     *
     * @param {string} archetypeId - Archetype ID to switch to
     * @returns {Promise<Object>} Updated preview data
     */
    async swapArchetype(archetypeId) {
        if (!this.imageDNA) {
            throw new Error('No image loaded — call loadImage() first');
        }
        if (!this.proxyEngine || !this.proxyEngine.proxyBuffer) {
            throw new Error('Proxy not initialized — call loadImage() first');
        }

        // Cancel any in-flight progressive palette generation
        this._paletteGeneration++;

        // 1. Snapshot outgoing archetype state (always — no gate)
        this._snapshotArchetypeState(this.state.activeArchetypeId);

        // 2. Generate fresh config (clean slate).
        // Chameleon uses Mk2 interpolation from DNA.
        if (archetypeId === 'dynamic_interpolator') {
            this.currentConfig = Reveal.generateConfigurationMk2(this.imageDNA);
        } else {
            this.currentConfig = Reveal.generateConfiguration(this.imageDNA, {
                manualArchetypeId: archetypeId
            });
        }
        this._applyConfigToState(this.currentConfig);
        if (!this.currentConfig.engineType) {
            this.currentConfig.engineType = this.state.engineType;
        }

        this.state.activeArchetypeId = archetypeId;
        this.state.isArchetypeDirty = false;

        // 3. Clear palette surgery (clean slate before re-posterize)
        this.paletteOverrides.clear();
        this.mergeHistory.clear();
        this.deletedColors.clear();

        // Reset decision support state
        this.state.highlightColorIndex = -1;
        this.emit('highlightChanged', { colorIndex: -1 });
        this.state.isKnobsCustomized = false;

        logger.log(`[SessionState] Archetype swap: ${archetypeId}`);

        this.emit('archetypeChanged', { archetypeId, config: this.currentConfig });

        // 4. Re-posterize with fresh archetype config (deterministic palette)
        const result = await this.proxyEngine.rePosterize(this.currentConfig);
        logger.log(`[SessionState] Swap result: ${result.palette.length} colors, ${result.elapsedMs.toFixed(0)}ms`);

        // 5. Auto-restore cached state if returning to a previously visited archetype
        const restored = this._restoreArchetypeState(archetypeId);

        // Emit configChanged so sliders sync (must happen after restore so values are current)
        this.emit('configChanged', this.currentConfig);
        this.emit('knobsCustomizedChanged', { customized: this.state.isKnobsCustomized });
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });

        if (restored) {
            logger.log(`[SessionState] Auto-restored cached state for ${archetypeId}`);
        }

        // 6. Apply knobs + palette overrides via proxy update
        const updateParams = {
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp
        };
        if (this.paletteOverrides.size > 0) {
            updateParams.paletteOverride = this._buildOverriddenPalette();
        }

        const knobResult = await this.proxyEngine.updateProxy(updateParams);

        this.previewBuffer = knobResult.previewBuffer;
        this.state.proxyBufferReady = true;
        this.state.isProcessing = false;

        const swapAccuracy = this.calculateCurrentAccuracy();
        const swapFidelity = this.calculateDNAFidelity();
        this.emit('previewUpdated', {
            previewBuffer: knobResult.previewBuffer,
            palette: knobResult.palette,
            activeColorCount: this._countActiveColors(),
            elapsedMs: result.elapsedMs + knobResult.elapsedMs,
            dimensions: result.dimensions,
            accuracyDeltaE: swapAccuracy,
            dnaFidelity: swapFidelity
        });

        return result;
    }

    /**
     * Get ranked archetype scores for the current image DNA.
     * Used for archetype carousel / picker UI.
     *
     * @returns {Array<{id, score, breakdown}>} All archetypes ranked by score
     */
    getAllArchetypeScores() {
        if (!this.imageDNA) return [];

        const archetypes = Reveal.ArchetypeLoader.loadArchetypes();
        const mapper = new Reveal.ArchetypeMapper(archetypes);
        const scores = mapper.getTopMatches(this.imageDNA, archetypes.length);

        // Inject Chameleon at its scored position
        const config = this._chameleonConfig || Reveal.generateConfigurationMk2(this.imageDNA);
        const nearestDist = config.meta.blendInfo.neighbors[0].distance;
        const chameleonScore = Math.max(30, Math.min(85, 75 - 10 * nearestDist));
        const entry = {
            id: 'dynamic_interpolator',
            score: chameleonScore,
            _synthetic: { name: 'Chameleon', preferred_sectors: [] }
        };
        // Insert at correct position (scores already sorted descending)
        let insertIdx = scores.length;
        for (let i = 0; i < scores.length; i++) {
            if (chameleonScore >= scores[i].score) { insertIdx = i; break; }
        }
        scores.splice(insertIdx, 0, entry);

        return scores;
    }

    // ─── Highlight / Isolation ─────────────────────────────────

    /**
     * Set the highlighted (isolated) color index for preview.
     * @param {number} colorIndex - 0+ to highlight, -1 to clear
     */
    setHighlight(colorIndex) {
        this.state.highlightColorIndex = colorIndex;
        this.emit('highlightChanged', { colorIndex });
    }

    /** Clear highlight — restore normal preview. */
    clearHighlight() {
        this.setHighlight(-1);
    }

    /**
     * Generate an RGBA buffer with one color isolated at full brightness,
     * all other pixels dimmed to dark gray (#282828).
     * Pure read — does NOT mutate any engine state.
     *
     * @param {number} colorIndex - Palette index to isolate
     * @returns {Uint8ClampedArray|null} RGBA buffer, or null if not ready
     */
    generateHighlightPreview(colorIndex) {
        if (!this.proxyEngine || !this.proxyEngine.separationState) return null;

        const { colorIndices, rgbPalette, width, height } = this.proxyEngine.separationState;
        if (!colorIndices || !rgbPalette) return null;

        const pixelCount = width * height;
        const rgba = new Uint8ClampedArray(pixelCount * 4);

        const DIM_R = 0x28, DIM_G = 0x28, DIM_B = 0x28;

        for (let i = 0; i < pixelCount; i++) {
            const ci = colorIndices[i];
            const off = i * 4;

            if (ci === colorIndex) {
                const c = rgbPalette[ci];
                rgba[off]     = c.r;
                rgba[off + 1] = c.g;
                rgba[off + 2] = c.b;
            } else {
                rgba[off]     = DIM_R;
                rgba[off + 1] = DIM_G;
                rgba[off + 2] = DIM_B;
            }
            rgba[off + 3] = 255;
        }

        return rgba;
    }

    // ─── Palette Surgery ─────────────────────────────────────

    /**
     * Override a single palette color (Palette Surgeon edit).
     * Stores override and triggers proxy re-separation with new palette.
     *
     * @param {number} colorIndex - Palette index to override
     * @param {{L: number, a: number, b: number}} newLabColor - New Lab color
     * @returns {Promise<Object>} Updated preview data
     */
    async overridePaletteColor(colorIndex, newLabColor) {
        logger.log(`[SessionState.override] idx=${colorIndex} Lab=(${newLabColor.L.toFixed(1)},${newLabColor.a.toFixed(1)},${newLabColor.b.toFixed(1)}) mapSize_before=${this.paletteOverrides.size}`);
        this.paletteOverrides.set(colorIndex, { ...newLabColor });

        const overriddenPalette = this._buildOverriddenPalette();

        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });

        if (!this.proxyEngine) return null;

        const result = await this.proxyEngine.updateProxy({
            paletteOverride: overriddenPalette,
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp
        });

        this.previewBuffer = result.previewBuffer;
        this.state.proxyBufferReady = true;

        this._emitPreviewUpdated(result);

        return result;
    }

    /**
     * Revert a single palette color override (undo Palette Surgeon edit).
     * Removes the override and triggers proxy re-separation with original palette.
     *
     * @param {number} colorIndex - Palette index to revert
     * @returns {Promise<Object|null>} Updated preview data, or null if not overridden
     */
    async revertPaletteColor(colorIndex) {
        if (!this.paletteOverrides.has(colorIndex) && !this.deletedColors.has(colorIndex)) return null;

        this.paletteOverrides.delete(colorIndex);
        this.deletedColors.delete(colorIndex);

        // Clean up merge history: remove this source from whichever target absorbed it
        for (const [target, sources] of this.mergeHistory) {
            sources.delete(colorIndex);
            if (sources.size === 0) this.mergeHistory.delete(target);
        }

        const overriddenPalette = this._buildOverriddenPalette();

        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });

        if (!this.proxyEngine) return null;

        const result = await this.proxyEngine.updateProxy({
            paletteOverride: overriddenPalette,
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp
        });

        this.previewBuffer = result.previewBuffer;
        this.state.proxyBufferReady = true;

        this._emitPreviewUpdated(result);

        return result;
    }

    /**
     * Delete a palette color by merging it into the nearest remaining color.
     * Uses CIE76 squared distance to find the closest live neighbor.
     *
     * @param {number} colorIndex - Palette index to delete
     * @returns {Promise<Object>} Updated preview data
     */
    async deletePaletteColor(colorIndex) {
        const palette = this._buildOverriddenPalette();
        if (!palette || colorIndex >= palette.length) {
            throw new Error(`Invalid palette index: ${colorIndex}`);
        }

        // Collect dead indices (merge sources + already deleted) to skip
        const dead = new Set(this.deletedColors);
        for (const sources of this.mergeHistory.values()) {
            for (const s of sources) dead.add(s);
        }
        dead.add(colorIndex);  // the one we're about to delete

        // Find nearest live color using CIE76 squared distance
        const src = palette[colorIndex];
        let bestDist = Infinity;
        let bestIdx = -1;
        for (let i = 0; i < palette.length; i++) {
            if (dead.has(i)) continue;
            const d = Reveal.LabDistance.cie76SquaredInline(
                src.L, src.a, src.b,
                palette[i].L, palette[i].a, palette[i].b
            );
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) {
            throw new Error('Cannot delete the last remaining color');
        }

        logger.log(`[SessionState.delete] idx=${colorIndex} → nearest=${bestIdx} (dE²=${bestDist.toFixed(1)})`);

        this.deletedColors.add(colorIndex);
        return this.mergePaletteColors(colorIndex, bestIdx);
    }

    /**
     * Merge one palette color into another.
     * Removes source color and re-maps its pixels to target.
     *
     * @param {number} sourceIndex - Color to remove
     * @param {number} targetIndex - Color to absorb source pixels
     * @returns {Promise<Object>} Updated preview data
     */
    async mergePaletteColors(sourceIndex, targetIndex) {
        if (!this.proxyEngine || !this.proxyEngine.separationState) {
            throw new Error('Proxy not initialized');
        }

        logger.log(`[SessionState.merge] source=${sourceIndex} target=${targetIndex} mapSize_before=${this.paletteOverrides.size} keys=[${[...this.paletteOverrides.keys()]}]`);

        // Read from baseline+overrides (the consistent visible state),
        // not separationState.palette which is mutable post-knob state.
        const palette = this._buildOverriddenPalette();
        if (!palette || sourceIndex >= palette.length || targetIndex >= palette.length) {
            throw new Error(`Invalid palette index: source=${sourceIndex}, target=${targetIndex}, size=${palette ? palette.length : 0}`);
        }

        this.paletteOverrides.set(sourceIndex, { ...palette[targetIndex] });

        // Track merge relationship so UI can show "+N" badge on target
        if (!this.mergeHistory.has(targetIndex)) {
            this.mergeHistory.set(targetIndex, new Set());
        }
        this.mergeHistory.get(targetIndex).add(sourceIndex);

        const overriddenPalette = this._buildOverriddenPalette();

        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });

        const result = await this.proxyEngine.updateProxy({
            paletteOverride: overriddenPalette,
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp
        });

        this.previewBuffer = result.previewBuffer;
        this.state.proxyBufferReady = true;

        this._emitPreviewUpdated(result);

        return result;
    }

    // ─── Production Export ────────────────────────────────────

    /**
     * Build a separation manifest capturing everything about how
     * the production render was produced. Embedded as XMP in the PSD
     * so anyone opening the file later can see exact settings.
     *
     * @param {{layerCount: number, elapsedMs: number}} productionResult
     * @returns {Object} Full manifest object
     */
    buildManifest(productionResult) {
        const PhotoshopBridge = require('../bridge/PhotoshopBridge');
        const docInfo = PhotoshopBridge.getDocumentInfo();

        // ── Archetype scores + rankings ──
        let archetypeSection = { id: null, name: null, score: 0, breakdown: {}, rankings: [] };
        const activeId = this.state.activeArchetypeId;
        if (activeId) {
            const allScores = this.getAllArchetypeScores();
            // Build name lookup from loaded archetypes
            const archetypeDefs = Reveal.ArchetypeLoader.loadArchetypes();
            const nameMap = {};
            for (const a of archetypeDefs) nameMap[a.id] = a.name;

            const match = allScores.find(s => s.id === activeId);
            if (match) {
                archetypeSection = {
                    id: match.id,
                    name: nameMap[match.id] || match.id,
                    score: Math.round(match.score * 100) / 100,
                    breakdown: match.breakdown || {}
                };
            }
            // Include full ranked list (all archetypes with scores)
            archetypeSection.rankings = allScores.map(s => ({
                id: s.id,
                name: nameMap[s.id] || s.id,
                score: Math.round(s.score * 100) / 100,
                breakdown: s.breakdown || {}
            }));
        }

        // ── Surgery section ──
        const overrides = {};
        const deletions = [];
        for (const [idx, color] of this.paletteOverrides) {
            if (this.deletedColors.has(idx)) {
                deletions.push(idx);
            } else {
                overrides[String(idx)] = {
                    L: Math.round(color.L * 10) / 10,
                    a: Math.round(color.a * 10) / 10,
                    b: Math.round(color.b * 10) / 10
                };
            }
        }
        const merges = {};
        for (const [target, sources] of this.mergeHistory) {
            merges[String(target)] = [...sources];
        }

        // ── Palette with hex + coverage ──
        const palette = this._buildOverriddenPalette();
        const PosterizationEngine = Reveal.engines.PosterizationEngine;
        const sep = this.proxyEngine && this.proxyEngine.separationState;
        let pixelCounts = null;
        if (sep && sep.colorIndices && palette) {
            pixelCounts = new Uint32Array(palette.length);
            const ci = sep.colorIndices;
            for (let i = 0, len = ci.length; i < len; i++) pixelCounts[ci[i]]++;
        }
        const totalPixels = sep ? sep.width * sep.height : 1;
        const paletteSection = (palette || []).map((c, i) => {
            const rgb = PosterizationEngine.labToRgb({ L: c.L, a: c.a, b: c.b });
            const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
            const hex = `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toUpperCase();
            const coverage = pixelCounts
                ? ((pixelCounts[i] / totalPixels) * 100).toFixed(2) + '%'
                : 'n/a';
            return {
                L: Math.round(c.L * 10) / 10,
                a: Math.round(c.a * 10) / 10,
                b: Math.round(c.b * 10) / 10,
                hex,
                coverage
            };
        });

        // ── Engine config (ParameterGenerator output) ──
        // Captures the full computed config including adaptive color count
        const configSection = {};
        if (this.currentConfig) {
            const cfg = this.currentConfig;
            configSection.targetColors = cfg.targetColors;
            configSection.distanceMetric = cfg.distanceMetric;
            configSection.ditherType = cfg.ditherType;
            configSection.engineType = cfg.engineType;
            configSection.preprocessingIntensity = cfg.preprocessingIntensity;
            // Archetype color bounds (drives adaptive count clamping)
            if (cfg.meta) {
                configSection.archetypeId = cfg.meta.archetypeId;
                configSection.matchScore = cfg.meta.matchScore;
            }
        }

        return {
            meta: {
                generator: 'Reveal Navigator v1.0.0',
                timestamp: new Date().toISOString(),
                filename: docInfo ? docInfo.name : 'unknown',
                width: docInfo ? docInfo.width : this.originalWidth,
                height: docInfo ? docInfo.height : this.originalHeight,
                bitDepth: 16
            },
            archetype: archetypeSection,
            config: configSection,
            knobs: (() => {
                const k = {};
                for (const key of ALL_KNOBS) {
                    if (this.state[key] !== undefined) k[key] = this.state[key];
                }
                return k;
            })(),
            surgery: {
                overrides,
                merges,
                deletions
            },
            palette: paletteSection,
            dna: this.imageDNA || {},
            metrics: {
                avgDeltaE: this.calculateCurrentAccuracy(),
                layerCount: productionResult ? productionResult.layerCount : 0,
                elapsedMs: productionResult ? productionResult.elapsedMs : 0
            }
        };
    }

    /**
     * Collapse current state + palette overrides into a single
     * production-ready config object for reveal-batch or reveal-adobe worker.
     *
     * @returns {Object} Collapsed production configuration
     */
    exportProductionConfig() {
        const palette = this._buildOverriddenPalette();

        // Start with all knob values from state
        const config = {};
        for (const key of ALL_KNOBS) {
            if (this.state[key] !== undefined) {
                config[key] = this.state[key];
            }
        }

        // Build merge remap: sourceIndex → targetIndex (inverted from mergeHistory)
        // Production render uses this to collapse duplicate palette entries
        // after fresh nearest-neighbor separation at full resolution.
        const mergeRemap = {};
        for (const [target, sources] of this.mergeHistory) {
            for (const src of sources) {
                mergeRemap[src] = target;
            }
        }

        return {
            // Source metadata
            width: this.imageWidth,
            height: this.imageHeight,
            dna: this.imageDNA,

            // ALL posterization + knob parameters (generic from ALL_KNOBS)
            ...config,

            // Archetype
            activeArchetypeId: this.state.activeArchetypeId,

            // Palette (with overrides baked in)
            palette: palette,
            paletteOverrides: Object.fromEntries(this.paletteOverrides),

            // Merge remap: source → target for collapsed colors
            mergeRemap: Object.keys(mergeRemap).length > 0 ? mergeRemap : null,

            // Full config snapshot (for reference)
            generatedConfig: this.currentConfig
        };
    }

    // ─── Accuracy Monitor ─────────────────────────────────────

    /**
     * Calculate average CIE76 Delta-E between the original 512px proxy
     * and the posterized assignment. Measures the "cost" of the current
     * archetype/parameter choice.
     *
     * @returns {number|null} Average ΔE (0 = perfect, higher = more deviation)
     */
    calculateCurrentAccuracy() {
        const proxy = this.proxyEngine;
        if (!proxy || !proxy.proxyBuffer || !proxy.separationState) return null;

        const { palette, colorIndices, width, height } = proxy.separationState;
        const proxyBuf = proxy.proxyBuffer;  // Uint16Array, 16-bit Lab [L,a,b,...]
        const pixelCount = width * height;

        // Decode palette Lab values once (they're already perceptual floats)
        const palL = new Float64Array(palette.length);
        const palA = new Float64Array(palette.length);
        const palB = new Float64Array(palette.length);
        for (let i = 0; i < palette.length; i++) {
            palL[i] = palette[i].L;
            palA[i] = palette[i].a;
            palB[i] = palette[i].b;
        }

        let sumDE = 0;
        for (let i = 0; i < pixelCount; i++) {
            const off = i * 3;
            // Decode 16-bit Lab → perceptual
            const L = (proxyBuf[off] / 32768) * 100;
            const a = ((proxyBuf[off + 1] - 16384) / 16384) * 128;
            const b = ((proxyBuf[off + 2] - 16384) / 16384) * 128;

            const ci = colorIndices[i];
            const dL = L - palL[ci];
            const da = a - palA[ci];
            const db = b - palB[ci];
            sumDE += Math.sqrt(dL * dL + da * da + db * db);
        }

        return sumDE / pixelCount;
    }

    /**
     * Calculate DNA fidelity between input image DNA and posterized output.
     * Detects structural drift (chroma, entropy, temperature) that per-pixel
     * ΔE cannot catch.
     *
     * @returns {Object|null} { global, sectors, sectorDrift, fidelity, alerts }
     */
    calculateDNAFidelity() {
        if (!this.imageDNA || !this.proxyEngine || !this.proxyEngine.separationState) return null;

        const sep = this.proxyEngine.separationState;
        if (!sep.colorIndices || !sep.palette) return null;

        return Reveal.DNAFidelity.fromIndices(
            this.imageDNA,
            sep.colorIndices,
            sep.palette,
            sep.width,
            sep.height
        );
    }

    // ─── State Access ────────────────────────────────────────

    /** Returns a frozen copy of the reactive state. */
    getState() {
        return Object.freeze({ ...this.state });
    }

    /** Returns the DNA v2.0 snapshot for the loaded image. */
    getDNA() {
        return this.imageDNA;
    }

    /** Returns the current RGBA preview buffer. */
    getPreview() {
        return this.previewBuffer;
    }

    /**
     * Map proxy pixel coordinates to full-resolution document coordinates.
     * Used by Loupe to convert preview mouse position → PS sourceBounds.
     *
     * @param {number} proxyX - X coordinate in proxy image space
     * @param {number} proxyY - Y coordinate in proxy image space
     * @returns {{x: number, y: number}} Document pixel coordinates
     */
    getDocumentCoords(proxyX, proxyY) {
        const proxyW = this.proxyEngine ? this.proxyEngine.separationState.width : this.imageWidth;
        const proxyH = this.proxyEngine ? this.proxyEngine.separationState.height : this.imageHeight;
        const scaleX = this.originalWidth / proxyW;
        const scaleY = this.originalHeight / proxyH;
        return {
            x: Math.round(proxyX * scaleX),
            y: Math.round(proxyY * scaleY)
        };
    }

    /**
     * Returns the current palette with any overrides applied.
     * @returns {Array<{L, a, b}>|null}
     */
    getPalette() {
        return this._buildOverriddenPalette();
    }

    // ─── Archetype State Cache ─────────────────────────────────

    /**
     * Snapshot the full customizable state for the given archetype.
     * Always saves — no isKnobsCustomized gate — so returning is seamless.
     *
     * @param {string} id - Archetype ID to snapshot
     * @private
     */
    _snapshotArchetypeState(id) {
        if (!id) return;

        const knobs = {};
        for (const key of ALL_KNOBS) knobs[key] = this.state[key];

        // Deep-copy Maps and Sets to prevent cross-archetype mutation
        const paletteOverrides = new Map();
        for (const [idx, color] of this.paletteOverrides) {
            paletteOverrides.set(idx, { ...color });
        }

        const mergeHistory = new Map();
        for (const [target, sources] of this.mergeHistory) {
            mergeHistory.set(target, new Set(sources));
        }

        const deletedColors = new Set(this.deletedColors);

        this._archetypeStateCache.set(id, {
            knobs,
            paletteOverrides,
            mergeHistory,
            deletedColors
        });
    }

    /**
     * Restore cached state for the given archetype, if it exists.
     * Applies knobs to state/config and restores palette surgery maps.
     *
     * @param {string} id - Archetype ID to restore
     * @returns {boolean} true if state was restored, false if no cache entry
     * @private
     */
    _restoreArchetypeState(id) {
        const cached = id ? this._archetypeStateCache.get(id) : null;
        if (!cached) return false;

        // Restore knobs
        for (const key of ALL_KNOBS) {
            if (cached.knobs[key] !== undefined) {
                this.state[key] = cached.knobs[key];
                if (this.currentConfig) this.currentConfig[key] = cached.knobs[key];
            }
        }

        // Restore palette surgery (deep-copy back to prevent cache mutation)
        this.paletteOverrides.clear();
        for (const [idx, color] of cached.paletteOverrides) {
            this.paletteOverrides.set(idx, { ...color });
        }

        this.mergeHistory.clear();
        for (const [target, sources] of cached.mergeHistory) {
            this.mergeHistory.set(target, new Set(sources));
        }

        this.deletedColors.clear();
        for (const idx of cached.deletedColors) {
            this.deletedColors.add(idx);
        }

        // Detect if restored values differ from archetype defaults
        this.state.isKnobsCustomized = false;
        if (this._archetypeDefaults) {
            for (const k of ALL_KNOBS) {
                if (this.state[k] !== this._archetypeDefaults[k]) {
                    this.state.isKnobsCustomized = true;
                    break;
                }
            }
        }

        return true;
    }

    /**
     * Returns true if any customization exists (knobs or palette surgery).
     * Used by UI to show/hide "Reset to Defaults" button and orange dot.
     *
     * @returns {boolean}
     */
    isCustomized() {
        return this.state.isKnobsCustomized ||
            this.paletteOverrides.size > 0 ||
            this.deletedColors.size > 0;
    }

    // ─── Private Helpers ─────────────────────────────────────

    /**
     * Count palette colors that have at least one pixel assigned.
     * minVolume remaps weak colors to zero coverage without compacting
     * the palette, so palette.length overstates the visible count.
     * @private
     */
    _countActiveColors() {
        const sep = this.proxyEngine && this.proxyEngine.separationState;
        if (!sep || !sep.colorIndices || !sep.palette) return sep ? sep.palette.length : 0;
        const counts = new Uint32Array(sep.palette.length);
        const ci = sep.colorIndices;
        for (let i = 0, len = ci.length; i < len; i++) counts[ci[i]]++;
        let active = 0;
        for (let i = 0; i < counts.length; i++) if (counts[i] > 0) active++;
        return active;
    }

    /**
     * Emit a previewUpdated event with accuracy Delta-E included.
     * @private
     */
    _emitPreviewUpdated(result) {
        const accuracyDeltaE = this.calculateCurrentAccuracy();
        const dnaFidelity = this.calculateDNAFidelity();
        this.emit('previewUpdated', {
            previewBuffer: result.previewBuffer,
            palette: result.palette,
            activeColorCount: this._countActiveColors(),
            elapsedMs: result.elapsedMs,
            accuracyDeltaE,
            dnaFidelity
        });
    }

    /**
     * Apply config parameters to the reactive state object.
     * @private
     */
    _applyConfigToState(config) {
        // Reset production-only knobs to initial values FIRST.
        // Archetype configs don't define these, so without explicit reset
        // stale values from the previous archetype leak through.
        // Also inject into config so MechanicalKnobs._syncFromConfig() can
        // sync sliders — generateConfiguration() never includes these.
        for (const [key, val] of Object.entries(PRODUCTION_KNOB_DEFAULTS)) {
            this.state[key] = val;
            config[key] = val;
        }

        // Handle targetColorsSlider → targetColors alias
        if (config.targetColorsSlider !== undefined) {
            this.state.targetColors = config.targetColorsSlider;
        } else if (config.targetColors !== undefined) {
            this.state.targetColors = config.targetColors;
        }

        // Generic sync: copy all known knob values from config → state.
        // ALL_KNOBS is the canonical set derived from ParameterGenerator output.
        for (const key of ALL_KNOBS) {
            if (key === 'targetColors') continue; // handled above (alias)
            if (config[key] !== undefined) {
                this.state[key] = config[key];
            }
        }

        if (config.id) this.state.activeArchetypeId = config.id;

        // Snapshot archetype defaults for dirty detection (all user-facing knobs)
        this._archetypeDefaults = {};
        for (const k of ALL_KNOBS) {
            this._archetypeDefaults[k] = this.state[k];
        }
        this.state.isKnobsCustomized = false;
    }

    /**
     * Rebuild currentConfig from the current reactive state.
     * Called before structural re-posterize.
     * @private
     */
    _rebuildConfigFromState() {
        if (!this.currentConfig) return;

        // Generic sync: copy ALL knob values from state → config.
        for (const key of ALL_KNOBS) {
            if (this.state[key] !== undefined) {
                this.currentConfig[key] = this.state[key];
            }
        }

        // targetColorsSlider alias (config uses both names)
        if (this.state.targetColors) {
            this.currentConfig.targetColorsSlider = this.state.targetColors;
        }
    }

    /**
     * Build a palette array with overrides applied on top of the BASELINE palette.
     * Uses the clean posterization output (never mutated by knobs) so that
     * override indices remain stable regardless of minVolume compaction.
     * @private
     * @returns {Array<{L, a, b}>|null}
     */
    _buildOverriddenPalette() {
        if (!this.proxyEngine || !this.proxyEngine._baselineState) return null;

        // ALWAYS use the clean, un-mutated baseline palette as the source.
        // Never fall back to separationState.palette — it's a mutable result
        // of knob application and creates index drift when minVolume remaps.
        const basePalette = this.proxyEngine._baselineState.palette;
        const result = basePalette.map(c => ({ ...c }));

        for (const [idx, color] of this.paletteOverrides) {
            if (idx < result.length) {
                result[idx] = { ...color };
            }
        }

        // DIAGNOSTIC: detect all-same palette
        if (result.length > 1) {
            const first = result[0];
            const allSame = result.every(c => c.L === first.L && c.a === first.a && c.b === first.b);
            if (allSame) {
                logger.log(`[SessionState._buildOverriddenPalette] WARNING: ALL ${result.length} colors identical! L=${first.L.toFixed(1)} a=${first.a.toFixed(1)} b=${first.b.toFixed(1)}`);
                logger.log(`[SessionState._buildOverriddenPalette] baseline[0]=(${basePalette[0].L.toFixed(1)},${basePalette[0].a.toFixed(1)},${basePalette[0].b.toFixed(1)}) baseline[1]=(${basePalette[1].L.toFixed(1)},${basePalette[1].a.toFixed(1)},${basePalette[1].b.toFixed(1)})`);
            }
        }

        return result;
    }
}

module.exports = SessionState;
