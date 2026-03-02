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

// Import canonical config categories from core (single source of truth).
const { CONFIG_CATEGORIES } = Reveal.engines.ParameterGenerator;

// Parameters that only need mask/preview re-render (fast path via ProxyEngine.updateProxy)
const MECHANICAL_KNOBS = new Set(CONFIG_CATEGORIES.MECHANICAL);

// Parameters that only affect production render (not proxy preview).
// Trap pixel sizes are resolution-dependent — meaningless at 512px proxy.
const PRODUCTION_KNOBS = new Set(CONFIG_CATEGORIES.PRODUCTION);

// Session-level equipment settings — survive archetype swaps and are NOT
// cached/restored per archetype.  Physical equipment params only.
const SESSION_KNOBS = new Set([...PRODUCTION_KNOBS]);

// Initial defaults for production-only knobs (archetype configs don't define these).
// Without explicit reset, stale values leak across archetype swaps.
const MECHANICAL_KNOB_DEFAULTS = { minVolume: 0, speckleRescue: 0, shadowClamp: 0 };
const PRODUCTION_KNOB_DEFAULTS = { trapSize: 0, meshSize: 230 };

// Parameters that require full re-posterization (slow path via ProxyEngine.initializeProxy).
const STRUCTURAL_PARAMS = new Set(CONFIG_CATEGORIES.STRUCTURAL);

// Parameters with UI controls that don't yet affect any engine.
// Keep in ALL_KNOBS for config sync and dirty detection, but NOT in
// STRUCTURAL_PARAMS — changing them should not trigger re-posterize.
const UNIMPLEMENTED_KNOBS = new Set(CONFIG_CATEGORIES.UNIMPLEMENTED);

// Union of all user-facing knobs (for snapshot/restore/reset/dirty loops).
// Includes mechanical, production, structural, and unimplemented params.
const ALL_KNOBS = new Set([
    ...MECHANICAL_KNOBS, ...PRODUCTION_KNOBS, ...STRUCTURAL_PARAMS,
    ...UNIMPLEMENTED_KNOBS
]);

// All archetypes get ΔE-scored in the background after splash.
// Scoring is async/non-blocking — carousel updates progressively.
const EAGER_SCORE_COUNT = Infinity;

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

            // Session-level equipment settings (not archetype-driven)
            trapSize: 0,    // 0=off, 1-10px trap expansion
            meshSize: 230,  // Screen mesh TPI (physical equipment, survives archetype swaps)

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
        this.addedColors = new Set();       // palette indices added by user (via "+" button)
        this._checkedSuggestions = [];       // suggested colors marked "must be in final palette"
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

        // Debounce timer
        this._debounceTimer = null;

        // Concurrency guards
        this._updateInFlight = false;
        this._updateQueued = false;
        this._loadInFlight = false;
        this._swapInFlight = false;

        // Generation counter for background scoring cancellation
        this._scoringGeneration = 0;

        // Single source of truth: ΔE per archetype, computed once by background scoring.
        // Everything reads from here — cards, stats panel, sort.
        this._archetypeDeltaE = new Map();
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
        this.addedColors.clear();
        this._archetypeStateCache.clear();
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
        this._loadInFlight = false;
        this._swapInFlight = false;
        this._scoringGeneration++;
        this.state.activeArchetypeId = null;
        this.state.isArchetypeDirty = false;
        this.state.isProcessing = false;
        this.state.productionRenderPending = false;
        this.state.proxyBufferReady = false;
        this.state.isKnobsCustomized = false;
        this.state.highlightColorIndex = -1;

        // Reset session-level knobs to defaults
        this.state.trapSize = 0;
        this.state.meshSize = 230;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    /**
     * Load a new image into the session.
     *
     * Three phases:
     *   Phase 1 — DNA + archetype scoring (~51ms)
     *   Phase 2 — Proxy posterization of top match (~400ms) → previewUpdated + carouselReady
     *   Phase 3 — Background ΔE scoring (~350ms each) → archetypeScored events
     *
     * loadImage blocks until Phase 2 completes (carousel visible, preview ready).
     * Phase 3 ΔE scoring runs in the background — cards update progressively.
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
        if (this._loadInFlight) {
            logger.log('[SessionState] loadImage rejected — already in flight');
            return null;
        }
        this._loadInFlight = true;

        try {
        return await this._loadImageImpl(labPixels, width, height, originalWidth, originalHeight);
        } finally {
            this._loadInFlight = false;
        }
    }

    /** @private */
    async _loadImageImpl(labPixels, width, height, originalWidth, originalHeight) {
        this.imageWidth = width;
        this.imageHeight = height;
        this.originalWidth = originalWidth || width;
        this.originalHeight = originalHeight || height;
        this.paletteOverrides.clear();
        this.mergeHistory.clear();
        this.deletedColors.clear();
        this._archetypeStateCache.clear();

        // ── Phase 1: DNA analysis (~51ms) ──
        // Needed for Chameleon's Mk2 interpolation config.
        this.emit('progress', { phase: 'structural', label: 'Analyzing image DNA\u2026', percent: 35 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        const dnaGen = new Reveal.DNAGenerator();
        this.imageDNA = dnaGen.generate(labPixels, width, height, { bitDepth: 16 });
        logger.log(`[SessionState] DNA generated (dominant_sector=${this.imageDNA.dominant_sector})`);

        this.emit('dnaReady', this.imageDNA);

        // ── Phase 2: Chameleon posterization (~400ms) ──
        // No archetype scoring at startup — just DNA → Chameleon → preview.
        // Other archetypes are scored on-demand when the user clicks their card.
        this.emit('progress', { phase: 'visual', label: 'Initializing navigator\u2026', percent: 55 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        this._chameleonConfig = Reveal.generateConfigurationMk2(this.imageDNA);
        this.currentConfig = this._chameleonConfig;
        this._applyConfigToState(this.currentConfig);
        this.state.activeArchetypeId = 'dynamic_interpolator';
        if (!this.currentConfig.engineType) {
            this.currentConfig.engineType = this.state.engineType;
        }

        this.emit('imageLoaded', { width, height, dna: this.imageDNA });
        this.emit('configChanged', this.currentConfig);

        this.proxyEngine = new Reveal.ProxyEngine();
        const proxyResult = await this.proxyEngine.initializeProxy(
            labPixels, width, height, this.currentConfig
        );

        logger.log(`[SessionState] Chameleon posterized: ${proxyResult.palette.length} colors, ${proxyResult.dimensions.width}x${proxyResult.dimensions.height} in ${proxyResult.elapsedMs.toFixed(0)}ms`);
        this.emit('proxyReady', proxyResult);
        this.emit('progress', { phase: 'visual', label: 'Applying knobs\u2026', percent: 85 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

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

        // Store Chameleon's ΔE
        if (initialAccuracy != null) {
            this._archetypeDeltaE.set('dynamic_interpolator', initialAccuracy);
        }

        // Score Distilled at startup (read-only, uses existing proxy buffer)
        this._distilledConfig = Reveal.generateConfigurationDistilled(this.imageDNA);
        const distilledKnobs = {
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp
        };
        const distilledQuality = await this.proxyEngine.getPaletteWithQuality(
            this._distilledConfig, distilledKnobs
        );
        const distilledAccuracy = distilledQuality.meanDeltaE;
        if (distilledAccuracy != null) {
            this._archetypeDeltaE.set('distilled', distilledAccuracy);
        }

        this.emit('previewUpdated', {
            previewBuffer: knobResult.previewBuffer,
            palette: knobResult.palette,
            activeColorCount: this._countActiveColors(),
            elapsedMs: proxyResult.elapsedMs + knobResult.elapsedMs,
            dimensions: proxyResult.dimensions,
            accuracyDeltaE: initialAccuracy,
            dnaFidelity: initialFidelity
        });

        // ── Phase 3: DNA-scored carousel + background ΔE scoring ──
        // Compute instant DNA scores, build cards sorted by affinity.
        // Then score top N by actual ΔE during remaining splash time.
        this.emit('progress', { phase: 'visual', label: 'Scoring archetypes\u2026', percent: 90 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        const allScores = this.getAllArchetypeScores(); // instant DNA ranking

        // Inject Chameleon's ΔE and screen count (already computed above)
        const chameleonEntry = allScores.find(s => s.id === 'dynamic_interpolator');
        if (chameleonEntry) {
            const sep = this.proxyEngine.separationState;
            const chameleonColors = sep && sep.palette ? sep.palette.length : 0;
            chameleonEntry.meanDeltaE = initialAccuracy;
            chameleonEntry.targetColors = chameleonColors;
            chameleonEntry.sortScore = initialAccuracy != null
                ? this._computeSortScore(initialAccuracy, chameleonColors) : null;
        }

        // Inject Distilled's ΔE (scored above)
        const distilledEntry = allScores.find(s => s.id === 'distilled');
        if (distilledEntry) {
            distilledEntry.meanDeltaE = distilledAccuracy;
            distilledEntry.targetColors = 12;
            distilledEntry.sortScore = distilledAccuracy != null
                ? this._computeSortScore(distilledAccuracy, 12) : null;
        }

        this.emit('carouselReady', { scores: allScores, topMatchId: 'dynamic_interpolator' });
        logger.log(`[SessionState] Carousel ready — ${allScores.length} archetypes sorted by DNA, Chameleon ΔE=${initialAccuracy != null ? initialAccuracy.toFixed(1) : '?'}`);

        // Launch background ΔE scoring for top N (read-only, no state mutation)
        const generation = this._scoringGeneration;
        this._scoreAllArchetypes(allScores, 'dynamic_interpolator', generation);

        return proxyResult;
    }

    /**
     * Compute sort score: raw ΔE + exponential screen count penalty.
     * Baseline 8 screens, no penalty at ≤8. Above 8, penalty grows
     * exponentially: 9→0.5, 10→1.4, 11→2.9, 12→5.0, 14→11.3
     * @private
     */
    _computeSortScore(meanDeltaE, targetColors) {
        const excess = Math.max(0, (targetColors || 0) - 8);
        const penalty = excess > 0 ? 0.5 * Math.pow(1.6, excess - 1) : 0;
        return meanDeltaE + penalty;
    }

    /**
     * Sort scores by sortScore ascending (best adjusted quality first).
     * Entries without ΔE are appended in their original order.
     * @private
     */
    _sortByDeltaE(scores) {
        const copy = scores.slice();
        copy.sort((a, b) => {
            const aS = a.sortScore;
            const bS = b.sortScore;
            const aNull = aS == null || aS !== aS;
            const bNull = bS == null || bS !== bS;
            if (aNull && bNull) return 0;
            if (aNull) return 1;
            if (bNull) return -1;
            return aS - bS;
        });
        return copy;
    }

    /**
     * Background ΔE scoring loop. Scores archetypes one by one and emits
     * `archetypeScored` events so the carousel can update cards progressively.
     * Cancels if `_scoringGeneration` changes (new image or archetype swap).
     *
     * @param {Array} allScores - Score array (mutated in place with meanDeltaE)
     * @param {string} topId - Already-scored top match ID (skip it)
     * @param {number} generation - Generation counter at time of launch
     * @private
     */
    async _scoreAllArchetypes(allScores, topId, generation) {
        // Only eagerly score the top N archetypes by DNA score.
        // The rest get scored on-demand when the user clicks their card.
        // Skip Chameleon and Distilled — both already scored during Phase 2.
        const eagerSlice = allScores
            .filter(s => s.id !== 'dynamic_interpolator' && s.id !== 'distilled')
            .slice(0, EAGER_SCORE_COUNT);
        const total = eagerSlice.length;
        let computed = 0;
        let cancelled = false;

        // Knobs — same for all archetypes in this scoring run
        const knobs = {
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp
        };

        for (const match of eagerSlice) {
            if (this._scoringGeneration !== generation) {
                logger.log(`[SessionState] Background scoring cancelled (gen ${generation} → ${this._scoringGeneration})`);
                cancelled = true;
                break;
            }

            try {
                // Read-only scoring via getPaletteWithQuality — does NOT mutate
                // the active separationState, so the Chameleon preview stays intact.
                const config = match.id === 'distilled'
                    ? Reveal.generateConfigurationDistilled(this.imageDNA)
                    : Reveal.generateConfiguration(this.imageDNA, { manualArchetypeId: match.id });

                const quality = await this.proxyEngine.getPaletteWithQuality(config, knobs);
                const deltaE = quality.meanDeltaE;
                const colors = quality.rgbPalette ? quality.rgbPalette.length : 0;

                if (this._scoringGeneration !== generation) {
                    logger.log(`[SessionState] Background scoring cancelled after await (gen ${generation} → ${this._scoringGeneration})`);
                    cancelled = true;
                    break;
                }

                match.meanDeltaE = deltaE;
                match.targetColors = colors;
                match.sortScore = this._computeSortScore(deltaE, colors);
                this._archetypeDeltaE.set(match.id, deltaE);
                computed++;

                this.emit('archetypeScored', {
                    id: match.id,
                    meanDeltaE: deltaE,
                    targetColors: colors,
                    sortScore: match.sortScore,
                    computed,
                    total
                });

                // Yield to let carousel update the card
                await new Promise(r => setTimeout(r, 5));
            } catch (err) {
                computed++;
                logger.log(`[SessionState] Background scoring failed for ${match.id}: ${err.message}`);
            }
        }

        // No restore needed — getPaletteWithQuality is read-only.

        const sorted = this._sortByDeltaE(allScores);
        logger.log(`[SessionState] Background scoring ${cancelled ? 'cancelled' : 'complete'}: ${computed}/${total} archetypes scored`);
        this.emit('scoringComplete', { scores: sorted, topMatchId: topId });
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
        const hadAddedColors = this.addedColors.size > 0;
        this.addedColors.clear();

        // Clear suggested color selections
        this._cachedSuggestions = null;
        this._checkedSuggestions = [];

        // Delete cache entry so re-entering doesn't restore stale state
        const id = this.state.activeArchetypeId;
        if (id) this._archetypeStateCache.delete(id);

        this.state.isKnobsCustomized = false;
        this.state.highlightColorIndex = -1;
        this.emit('highlightChanged', { colorIndex: -1 });
        this.emit('knobsCustomizedChanged', { customized: false });
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
        this.emit('configChanged', this.currentConfig);  // triggers MechanicalKnobs sync

        // If user had added colors, rePosterize to get a fresh baseline palette
        // (added colors are baked into the baseline — clearing the Set isn't enough)
        if (hadAddedColors && this.proxyEngine && this.currentConfig) {
            this.proxyEngine.rePosterize(this.currentConfig).then(result => {
                this.previewBuffer = result.previewBuffer;
                this.state.proxyBufferReady = true;
                this._emitPreviewUpdated(result);
            }).catch(err => {
                logger.log(`[SessionState.resetToDefaults] rePosterize failed: ${err.message}`);
            });
        } else {
            this._scheduleProxyUpdate();
        }
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
                logger.log(`[SessionState] *** SLOW PATH: re-posterize triggered, overrides=${this.paletteOverrides.size}`);

                // Save user's manual color overrides — these are sacrosanct
                // decisions that must survive re-posterization.
                const savedOverrides = new Map();
                for (const [idx, color] of this.paletteOverrides) {
                    savedOverrides.set(idx, { ...color });
                }

                this._rebuildConfigFromState();

                this.paletteOverrides.clear();
                this.mergeHistory.clear();
                this.deletedColors.clear();
                this._cachedSuggestions = null;
                this._checkedSuggestions = [];
                this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
                result = await this.proxyEngine.rePosterize(this.currentConfig);
                this.state.isArchetypeDirty = false;
                logger.log(`[SessionState] Structural re-posterize: targetColors=${this.currentConfig.targetColors}, palette=${result.palette.length} colors`);

                // Re-inject saved overrides: find closest new palette slot
                // for each user-chosen color and re-establish the override.
                if (savedOverrides.size > 0) {
                    const newPalette = this.proxyEngine._baselineState.palette;
                    const LabDistance = Reveal.LabDistance;
                    const claimed = new Set();  // prevent two overrides claiming same slot

                    for (const [, color] of savedOverrides) {
                        let bestIdx = -1, bestDist = Infinity;
                        for (let i = 0; i < newPalette.length; i++) {
                            if (claimed.has(i)) continue;
                            const d = LabDistance.cie76SquaredInline(
                                color.L, color.a, color.b,
                                newPalette[i].L, newPalette[i].a, newPalette[i].b
                            );
                            if (d < bestDist) { bestDist = d; bestIdx = i; }
                        }
                        if (bestIdx >= 0) {
                            this.paletteOverrides.set(bestIdx, { ...color });
                            claimed.add(bestIdx);
                            logger.log(`[SessionState] Re-injected override Lab=(${color.L.toFixed(1)},${color.a.toFixed(1)},${color.b.toFixed(1)}) → slot ${bestIdx} (dist=${bestDist.toFixed(0)})`);
                        }
                    }
                    this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
                }
            }

            // Build update params — always include palette overrides so they
            // survive the baseline restore inside updateProxy
            const updateParams = { ...this.getMechanicalKnobs() };
            if (this.paletteOverrides.size > 0) {
                updateParams.paletteOverride = this._buildOverriddenPalette();
            }

            result = await this.proxyEngine.updateProxy(updateParams);

            this.previewBuffer = result.previewBuffer;
            this.state.isProcessing = false;
            this.state.proxyBufferReady = true;

            this._emitPreviewUpdated(result);

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
        if (this._swapInFlight) {
            logger.log(`[SessionState] swapArchetype(${archetypeId}) rejected — swap already in flight`);
            return null;
        }
        this._swapInFlight = true;

        // Cancel any in-flight background scoring
        this._scoringGeneration++;

        try {
            // 1. Snapshot outgoing archetype state (always — no gate)
            this._snapshotArchetypeState(this.state.activeArchetypeId);

            // 2. Generate fresh config (clean slate).
            // Chameleon uses Mk2 interpolation from DNA.
            // Distilled uses minimal batch-like settings (no archetype overrides).
            if (archetypeId === 'dynamic_interpolator') {
                this.currentConfig = Reveal.generateConfigurationMk2(this.imageDNA);
            } else if (archetypeId === 'distilled') {
                this.currentConfig = Reveal.generateConfigurationDistilled(this.imageDNA);
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
            this._cachedSuggestions = null;
            this._checkedSuggestions = [];

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
            // Store ΔE so on-demand clicked cards update their display
            if (swapAccuracy != null) {
                this._archetypeDeltaE.set(archetypeId, swapAccuracy);
                this.emit('archetypeScored', { id: archetypeId, meanDeltaE: swapAccuracy });
            }
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
        } finally {
            this._swapInFlight = false;
        }
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

        this._injectChameleon(scores);
        this._injectDistilled(scores);
        return scores;
    }

    // ─── Highlight / Isolation ─────────────────────────────────

    /**
     * Set the highlighted (isolated) color index for preview.
     * @param {number} colorIndex - 0+ to highlight, -1 to clear
     */
    setHighlight(colorIndex) {
        this._ghostLabColor = null;
        this._ghostMode = null;
        this.state.highlightColorIndex = colorIndex;
        this.emit('highlightChanged', { colorIndex });
    }

    /** Clear highlight — restore normal preview. */
    clearHighlight() {
        this._ghostLabColor = null;
        this._ghostMode = null;
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
        // Cancel any in-flight background scoring — palette surgery takes priority
        // and scoring data is stale after a palette edit.
        this._scoringGeneration++;

        logger.log(`[SessionState.override] idx=${colorIndex} Lab=(${newLabColor.L.toFixed(1)},${newLabColor.a.toFixed(1)},${newLabColor.b.toFixed(1)}) overrides=${this.paletteOverrides.size}`);
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

        this._scoringGeneration++;
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
        this._scoringGeneration++;
        const basePalette = this._buildOverriddenPalette();
        if (!basePalette || colorIndex >= basePalette.length) {
            throw new Error(`Invalid palette index: ${colorIndex}`);
        }

        // Include checked suggestions as candidates — they are part of the
        // effective palette at commit time, appended after the base palette.
        const palette = this._checkedSuggestions.length > 0
            ? [...basePalette, ...this._checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
            : basePalette;

        // Collect dead indices (merge sources + already deleted) to skip
        const dead = new Set(this.deletedColors);
        for (const sources of this.mergeHistory.values()) {
            for (const s of sources) dead.add(s);
        }
        dead.add(colorIndex);  // the one we're about to delete

        // Find nearest live color using the session's active distance metric
        const metric = (this.currentConfig && this.currentConfig.distanceMetric) || 'cie76';
        const distFn = metric === 'cie2000' ? Reveal.LabDistance.cie2000SquaredInline
                     : metric === 'cie94'   ? Reveal.LabDistance.cie94SquaredInline
                     :                        Reveal.LabDistance.cie76SquaredInline;

        const src = palette[colorIndex];
        let bestDist = Infinity;
        let bestIdx = -1;
        for (let i = 0; i < palette.length; i++) {
            if (dead.has(i)) continue;
            const d = distFn(
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

        // If best match is a checked suggestion (index beyond base palette),
        // override the deleted slot directly with the suggestion's Lab color
        // instead of going through mergePaletteColors which only knows base indices.
        if (bestIdx >= basePalette.length) {
            const suggestionColor = palette[bestIdx];
            this.paletteOverrides.set(colorIndex, { ...suggestionColor });

            this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });

            if (!this.proxyEngine) return null;
            const overriddenPalette = this._buildOverriddenPalette();
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

        this._scoringGeneration++;
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

    // ─── Add / Remove Colors ─────────────────────────────────

    /**
     * Add a new color to the palette via the "+" button.
     * Calls ProxyEngine.addColorAndReseparate() which expands the
     * baseline palette and runs full nearest-neighbor re-separation
     * so the new color gets real pixel coverage.
     *
     * @param {{L: number, a: number, b: number}} labColor - Lab color to add
     * @returns {Promise<Object|null>} Updated preview data
     */
    async addPaletteColor(labColor) {
        if (!this.proxyEngine || !this.proxyEngine.separationState) {
            throw new Error('Proxy not initialized');
        }

        this._scoringGeneration++;

        // Sanity cap at 20 screens (auto presses max ~14 stations)
        const palette = this.proxyEngine._baselineState.palette;
        if (palette.length >= 20) {
            logger.log('[SessionState.addColor] Max 20 colors reached — ignoring add');
            return null;
        }

        const newIndex = palette.length;
        logger.log(`[SessionState.addColor] Adding Lab=(${labColor.L.toFixed(1)},${labColor.a.toFixed(1)},${labColor.b.toFixed(1)}) at index ${newIndex}`);

        this.addedColors.add(newIndex);

        const result = await this.proxyEngine.addColorAndReseparate(labColor);

        this.previewBuffer = result.previewBuffer;
        this.state.proxyBufferReady = true;

        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
        this._emitPreviewUpdated(result);

        return result;
    }

    /**
     * Remove a user-added color from the palette entirely.
     * Unlike revert (which restores to baseline), this splices the
     * color out of the palette and re-separates so remaining colors
     * absorb its pixels. Only works on colors in addedColors set.
     *
     * @param {number} colorIndex - Index of the added color to remove
     * @returns {Promise<Object|null>} Updated preview data
     */
    async removeAddedColor(colorIndex) {
        if (!this.addedColors.has(colorIndex)) {
            logger.log(`[SessionState.removeAddedColor] Index ${colorIndex} is not an added color — ignoring`);
            return null;
        }

        this._scoringGeneration++;
        logger.log(`[SessionState.removeAddedColor] Removing added color at index ${colorIndex}`);

        // Remove from addedColors; shift tracked indices above the removed one
        this.addedColors.delete(colorIndex);
        const shifted = new Set();
        for (const idx of this.addedColors) {
            shifted.add(idx > colorIndex ? idx - 1 : idx);
        }
        this.addedColors = shifted;

        // Shift paletteOverrides, mergeHistory, deletedColors for indices above removed
        const newOverrides = new Map();
        for (const [idx, color] of this.paletteOverrides) {
            if (idx === colorIndex) continue;  // drop the removed color's override
            const newIdx = idx > colorIndex ? idx - 1 : idx;
            newOverrides.set(newIdx, color);
        }
        this.paletteOverrides = newOverrides;

        const newMergeHistory = new Map();
        for (const [target, sources] of this.mergeHistory) {
            if (target === colorIndex) continue;
            const newTarget = target > colorIndex ? target - 1 : target;
            const newSources = new Set();
            for (const s of sources) {
                if (s === colorIndex) continue;
                newSources.add(s > colorIndex ? s - 1 : s);
            }
            if (newSources.size > 0) newMergeHistory.set(newTarget, newSources);
        }
        this.mergeHistory = newMergeHistory;

        const newDeleted = new Set();
        for (const idx of this.deletedColors) {
            if (idx === colorIndex) continue;
            newDeleted.add(idx > colorIndex ? idx - 1 : idx);
        }
        this.deletedColors = newDeleted;

        const result = await this.proxyEngine.removeColorAndReseparate(colorIndex);

        this.previewBuffer = result.previewBuffer;
        this.state.proxyBufferReady = true;

        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
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

        // ── Palette with hex + coverage (includes checked suggestions for commit) ──
        const basePalette = this._buildOverriddenPalette();
        const palette = this._checkedSuggestions.length > 0
            ? [...basePalette, ...this._checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
            : basePalette;
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
            const rgb = Reveal.labToRgbD50({ L: c.L, a: c.a, b: c.b });
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
        // Spread all config fields except internal/transient metadata.
        // New params added to ParameterGenerator automatically appear in manifests.
        let configSection = {};
        if (this.currentConfig) {
            const { meta, preprocessing, rangeClamp, ...rest } = this.currentConfig;
            configSection = rest;
            // Promote key metadata fields to top level for readability
            if (meta) {
                configSection.archetypeId = meta.archetypeId;
                configSection.matchScore = meta.matchScore;
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

        // Sync latest state → currentConfig, then snapshot all params
        this._rebuildConfigFromState();
        const config = { ...this.currentConfig };

        // Build merge remap: sourceIndex → targetIndex (inverted from mergeHistory)
        // Production render uses this to collapse duplicate palette entries
        // after fresh nearest-neighbor separation at full resolution.
        const mergeRemap = {};
        for (const [target, sources] of this.mergeHistory) {
            for (const src of sources) {
                mergeRemap[src] = target;
            }
        }

        // Baseline palette (pre-override) — used by ProductionWorker for
        // nearest-neighbour separation so overridden slots still attract
        // their original pixels. Overrides are applied to layer fill colours
        // only, not to the separation distance calculation.
        const baselinePalette = this.proxyEngine._baselineState
            ? this.proxyEngine._baselineState.palette.map(c => ({ ...c }))
            : palette;

        // Separation palette: baseline for core slots + suggestions at end.
        // Suggestions are new colours added by the user — their Lab value IS
        // the separation target, so they use the override colour directly.
        const separationPalette = this._checkedSuggestions.length > 0
            ? [...baselinePalette, ...this._checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
            : baselinePalette;

        // Consolidate near-duplicate palette entries created by user edits.
        // Only runs when user has manually edited swatches — engine-produced
        // close colors are intentional and left alone.
        let consolidationMerges = null;
        if (this.paletteOverrides.size > 0) {
            const editedIndices = new Set(this.paletteOverrides.keys());
            const PaletteOps = Reveal.PaletteOps;
            const merges = PaletteOps.consolidateNearDuplicates(palette, editedIndices);
            if (Object.keys(merges).length > 0) {
                consolidationMerges = merges;
                // Fold consolidation merges into the main mergeRemap
                for (const [src, tgt] of Object.entries(merges)) {
                    mergeRemap[parseInt(src)] = tgt;
                }
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

            // Layer fill palette (overrides baked in + suggestions appended)
            palette: this._checkedSuggestions.length > 0
                ? [...palette, ...this._checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
                : palette,

            // Separation palette (baseline colours — overrides do NOT deflect
            // the nearest-neighbour search, only the fill colour changes)
            separationPalette,

            paletteOverrides: Object.fromEntries(this.paletteOverrides),

            // Merge remap: source → target for collapsed colors
            mergeRemap: Object.keys(mergeRemap).length > 0 ? mergeRemap : null,

            // Consolidation info (for diagnostics)
            consolidationMerges,

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
        return Reveal.RevelationError.meanDeltaE16(
            proxy.proxyBuffer, colorIndices, palette, width * height
        );
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

    /**
     * Get the stored ΔE for an archetype (from background scoring).
     * Single source of truth — same value displayed on card and stats panel.
     * @param {string} [archetypeId] - defaults to active archetype
     * @returns {number|null}
     */
    getArchetypeDeltaE(archetypeId) {
        const id = archetypeId || this.state.activeArchetypeId;
        return this._archetypeDeltaE.get(id) || null;
    }

    // ─── State Access ────────────────────────────────────────

    /**
     * Get current separation state (palette, indices, dimensions).
     * Returns null if no proxy is initialized.
     */
    getSeparationState() {
        if (!this.proxyEngine || !this.proxyEngine.separationState) return null;
        return this.proxyEngine.separationState;
    }

    /** Returns a frozen copy of the reactive state. */
    getState() {
        return Object.freeze({ ...this.state });
    }

    /**
     * Returns the current mechanical + production knobs as a single object.
     * Canonical source for knob values — use instead of picking from state.
     * @returns {{minVolume: number, speckleRescue: number, shadowClamp: number, trapSize: number}}
     */
    getMechanicalKnobs() {
        return {
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp,
            trapSize: this.state.trapSize || 0,
        };
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
     * Returns the original (pre-posterization) proxy as an RGBA buffer.
     * Used by the blink comparator to toggle between original and posterized.
     * @returns {{buffer: Uint8ClampedArray, width: number, height: number}|null}
     */
    getOriginalPreviewBuffer() {
        if (!this.proxyEngine) return null;
        return this.proxyEngine.getOriginalPreviewRGBA();
    }

    /**
     * Get suggested colors that the engine found but couldn't include.
     * Surfaces underrepresented sectors, unmatched peaks, and chroma outliers.
     * @returns {Array<{L, a, b, source, reason, impactScore}>}
     */
    getSuggestedColors() {
        if (!this.proxyEngine) return [];
        // Return cached suggestions — computed once per archetype, stable across palette surgery
        if (this._cachedSuggestions) return this._cachedSuggestions;
        this._cachedSuggestions = this.proxyEngine.getSuggestedColors();
        return this._cachedSuggestions;
    }

    /** Suggested colors the user marked "must be in final palette". */
    get checkedSuggestions() {
        return this._checkedSuggestions;
    }

    /** Mark a suggested color as "must be in final palette". */
    addCheckedSuggestion(labColor) {
        this._checkedSuggestions.push({ L: labColor.L, a: labColor.a, b: labColor.b });
    }

    /** Remove a checked suggestion by proximity (ΔE < 4). */
    removeCheckedSuggestion(labColor) {
        const DE_SQ = 16; // 4²
        for (let i = 0; i < this._checkedSuggestions.length; i++) {
            const c = this._checkedSuggestions[i];
            const dL = labColor.L - c.L, da = labColor.a - c.a, db = labColor.b - c.b;
            if (dL * dL + da * da + db * db < DE_SQ) {
                this._checkedSuggestions.splice(i, 1);
                return;
            }
        }
    }

    /** Check if a suggestion is already checked (ΔE < 4). */
    isSuggestionChecked(labColor) {
        const DE_SQ = 16;
        for (const c of this._checkedSuggestions) {
            const dL = labColor.L - c.L, da = labColor.a - c.a, db = labColor.b - c.b;
            if (dL * dL + da * da + db * db < DE_SQ) return true;
        }
        return false;
    }

    /**
     * Generate ghost preview: show which pixels a suggested color would capture.
     * For each pixel, checks if labColor is closer than the pixel's current assignment.
     * Pixels that would be captured → shown in labColor's RGB at full brightness.
     * Non-captured pixels: 'integrated' mode keeps palette color, 'solo' mode dims to #282828.
     *
     * @param {{L: number, a: number, b: number}} labColor - The suggested Lab color
     * @param {'integrated'|'solo'} [mode='integrated'] - Rendering mode
     * @returns {Uint8ClampedArray|null} RGBA buffer, or null if not ready
     */
    generateSuggestionGhostPreview(labColor, mode = 'integrated') {
        if (!this.proxyEngine || !this.proxyEngine.separationState) return null;

        const state = this.proxyEngine.separationState;
        const { colorIndices, palette, rgbPalette, width, height } = state;
        if (!colorIndices || !palette || !rgbPalette) return null;

        const proxyBuffer = this.proxyEngine.proxyBuffer;
        if (!proxyBuffer) return null;

        const pixelCount = width * height;
        const rgba = new Uint8ClampedArray(pixelCount * 4);

        // Pre-compute the suggested color's RGB for captured pixels
        const sugRgb = Reveal.labToRgbD50({ L: labColor.L, a: labColor.a, b: labColor.b });
        const solo = (mode === 'solo');

        // 16-bit Lab encoding constants
        const L_SCALE = 327.68;
        const AB_NEUTRAL = 16384;
        const AB_SCALE = 128;

        for (let i = 0; i < pixelCount; i++) {
            const off3 = i * 3;
            const off4 = i * 4;

            // Decode pixel Lab from 16-bit proxy buffer
            const pL = proxyBuffer[off3] / L_SCALE;
            const pa = (proxyBuffer[off3 + 1] - AB_NEUTRAL) / AB_SCALE;
            const pb = (proxyBuffer[off3 + 2] - AB_NEUTRAL) / AB_SCALE;

            // Distance from pixel to suggested color
            const dSL = pL - labColor.L;
            const dSA = pa - labColor.a;
            const dSB = pb - labColor.b;
            const distToSuggestion = dSL * dSL + dSA * dSA + dSB * dSB;

            // Distance from pixel to its current palette assignment
            const ci = colorIndices[i];
            const assigned = palette[ci];
            const dAL = pL - assigned.L;
            const dAA = pa - assigned.a;
            const dAB = pb - assigned.b;
            const distToAssigned = dAL * dAL + dAA * dAA + dAB * dAB;

            if (distToSuggestion < distToAssigned) {
                // This pixel would be captured by the suggested color
                rgba[off4]     = sugRgb.r;
                rgba[off4 + 1] = sugRgb.g;
                rgba[off4 + 2] = sugRgb.b;
            } else if (solo) {
                // Solo mode: dim non-captured pixels
                rgba[off4]     = 0x28;
                rgba[off4 + 1] = 0x28;
                rgba[off4 + 2] = 0x28;
            } else {
                // Integrated mode: keep normal palette color
                const c = rgbPalette[ci];
                rgba[off4]     = c.r;
                rgba[off4 + 1] = c.g;
                rgba[off4 + 2] = c.b;
            }
            rgba[off4 + 3] = 255;
        }

        return rgba;
    }

    /**
     * Set a suggestion ghost preview (triggered by clicking a suggested swatch).
     * Emits highlightChanged with a ghost buffer instead of a color index.
     * @param {{L: number, a: number, b: number}} labColor
     * @param {'integrated'|'solo'} [mode='integrated'] - 'integrated' shows all colors
     *   with suggestion replacing captured pixels; 'solo' dims non-captured to #282828
     */
    setSuggestionGhost(labColor, mode = 'integrated') {
        const ghostBuffer = this.generateSuggestionGhostPreview(labColor, mode);
        if (ghostBuffer) {
            this._ghostLabColor = { L: labColor.L, a: labColor.a, b: labColor.b };
            this._ghostMode = mode;
            this.state.highlightColorIndex = -2;
            this.emit('highlightChanged', { colorIndex: -2, ghostBuffer });
        }
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
        for (const key of ALL_KNOBS) {
            if (SESSION_KNOBS.has(key)) continue;  // session-level — don't cache per archetype
            knobs[key] = this.state[key];
        }

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
        const addedColors = new Set(this.addedColors);

        this._archetypeStateCache.set(id, {
            knobs,
            paletteOverrides,
            mergeHistory,
            deletedColors,
            addedColors
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

        this.addedColors = new Set(cached.addedColors || []);

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
            this.deletedColors.size > 0 ||
            this.addedColors.size > 0;
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
     * Inject the Chameleon (dynamic_interpolator) entry into a sorted score array.
     * Score is derived from blend distance to nearest Mk2 cluster centroid.
     *
     * @param {Array} scores - Descending-sorted archetype scores from ArchetypeMapper
     * @returns {Array} Same array with Chameleon inserted at correct position
     * @private
     */
    _injectChameleon(scores) {
        const config = this._chameleonConfig || Reveal.generateConfigurationMk2(this.imageDNA);
        const nearestDist = config.meta.blendInfo.neighbors[0].distance;
        const chameleonScore = Math.max(30, Math.min(85, 75 - 10 * nearestDist));

        const entry = {
            id: 'dynamic_interpolator',
            score: chameleonScore,
            _synthetic: {
                name: 'Chameleon',
                description: 'Adaptive interpolation from image DNA. Blends nearest archetype parameters weighted by distance.',
                preferred_sectors: [],
                parameters: {}
            }
        };

        // Insert at correct descending position (avoid Array.sort JSC issues)
        let idx = scores.length;
        for (let i = 0; i < scores.length; i++) {
            if (chameleonScore >= scores[i].score) { idx = i; break; }
        }
        scores.splice(idx, 0, entry);
        return scores;
    }

    /**
     * Inject the Distilled pseudo-archetype entry into a sorted score array.
     * Gets a synthetic DNA score derived from Chameleon's score (both are
     * meta-archetypes that adapt to the image). Placed right after Chameleon.
     * @private
     */
    _injectDistilled(scores) {
        // Derive synthetic DNA score from Chameleon's score (peer meta-archetype)
        const chameleon = scores.find(s => s.id === 'dynamic_interpolator');
        const distilledScore = chameleon ? Math.max(0, chameleon.score - 1) : 50;

        const entry = {
            id: 'distilled',
            score: distilledScore,
            _synthetic: {
                name: 'Distilled',
                description: 'Minimal batch-pipeline posterization. No archetype overrides — pure color extraction with 20→12 distillation.',
                preferred_sectors: [],
                parameters: {}
            }
        };

        // Place right after Chameleon
        const chameleonIdx = chameleon ? scores.indexOf(chameleon) : -1;
        scores.splice(chameleonIdx + 1, 0, entry);
        return scores;
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
        for (const [key, val] of Object.entries(MECHANICAL_KNOB_DEFAULTS)) {
            this.state[key] = val;
            config[key] = val;
        }
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

        return result;
    }
}

module.exports = SessionState;
