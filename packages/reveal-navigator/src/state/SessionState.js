/**
 * SessionState - Centralized state coordinator for Navigator UI
 *
 * Bridges the reactive 512px proxy preview ("Navigation" phase)
 * with final high-fidelity production render.
 *
 * Design principles:
 *   - State coordinator, NOT an engine — delegates to @electrosaur-labs/core
 *   - Simple on/off/emit listener pattern (no framework dependency)
 *   - Built-in debounce for slider scrubbing (~50ms)
 *   - ProxyEngine is the hot path for mechanical knobs
 */

const EventEmitter = require('./EventEmitter');
const Reveal = require('@electrosaur-labs/core');
const PaletteSurgeryManager = require('./PaletteSurgeryManager');
const ScoringManager = require('./ScoringManager');
const SuggestionManager = require('./SuggestionManager');
const { DIM_COLOR } = require('../utils/pixelProcessing');

const logger = Reveal.logger;

// Import canonical config categories and knob defaults from core (single source of truth).
const { CONFIG_CATEGORIES, KNOB_DEFAULTS } = Reveal.engines.ParameterGenerator;

// Parameters that only need mask/preview re-render (fast path via ProxyEngine.updateProxy)
const MECHANICAL_KNOBS = new Set(CONFIG_CATEGORIES.MECHANICAL);

// Parameters that only affect production render (not proxy preview).
// Trap pixel sizes are resolution-dependent — meaningless at 512px proxy.
const PRODUCTION_KNOBS = new Set(CONFIG_CATEGORIES.PRODUCTION);

// Session-level equipment settings — survive archetype swaps and are NOT
// cached/restored per archetype.  Physical equipment params only.
const SESSION_KNOBS = new Set([...PRODUCTION_KNOBS]);

// Knob defaults from core — archetype configs don't define these.
const MECHANICAL_KNOB_DEFAULTS = KNOB_DEFAULTS.MECHANICAL;
const PRODUCTION_KNOB_DEFAULTS = KNOB_DEFAULTS.PRODUCTION;

// Parameters that require full re-posterization (slow path via ProxyEngine.initializeProxy).
const STRUCTURAL_PARAMS = new Set(CONFIG_CATEGORIES.STRUCTURAL);

// Union of all user-facing knobs (for snapshot/restore/reset/dirty loops).
// Includes mechanical, production, and structural params.
const ALL_KNOBS = new Set([
    ...MECHANICAL_KNOBS, ...PRODUCTION_KNOBS, ...STRUCTURAL_PARAMS
]);

// Pseudo-archetypes (Chameleon, Distilled, Salamander) are ΔE-scored at startup.
// All other archetypes are scored on-demand when the user clicks their card.

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

        // Palette surgery — extracted to PaletteSurgeryManager
        this._paletteSurgery = new PaletteSurgeryManager();
        // Archetype scoring — extracted to ScoringManager
        this._scoring = new ScoringManager();
        this._scoring.on('archetypeScored', data => this.emit('archetypeScored', data));
        this._scoring.on('scoringComplete', data => this.emit('scoringComplete', data));
        // Suggestions & ghost preview — extracted to SuggestionManager
        this._suggestions = new SuggestionManager();
        this._suggestions.on('ghostChanged', data => {
            this.state.highlightColorIndex = -2;
            this.emit('highlightChanged', data);
        });
        this._proxyEngine = null;
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
        this._swapQueued = null;
    }

    // ─── Proxy Engine ──────────────────────────────────────
    get proxyEngine() { return this._proxyEngine; }
    set proxyEngine(v) {
        this._proxyEngine = v;
        this._paletteSurgery.initialize(v);
        this._suggestions.initialize(v);
    }

    // ─── Palette Surgery Delegation ─────────────────────────
    get paletteOverrides() { return this._paletteSurgery.paletteOverrides; }
    set paletteOverrides(v) { this._paletteSurgery.paletteOverrides = v; }
    get mergeHistory() { return this._paletteSurgery.mergeHistory; }
    set mergeHistory(v) { this._paletteSurgery.mergeHistory = v; }
    get deletedColors() { return this._paletteSurgery.deletedColors; }
    set deletedColors(v) { this._paletteSurgery.deletedColors = v; }
    get addedColors() { return this._paletteSurgery.addedColors; }
    set addedColors(v) { this._paletteSurgery.addedColors = v; }

    /** Current suggestion ghost Lab color, or null if no ghost active. */
    get ghostLabColor() { return this._suggestions.ghostLabColor; }

    /** Current suggestion ghost rendering mode ('integrated' or 'solo'), or null. */
    get ghostMode() { return this._suggestions.ghostMode; }

    /**
     * Reset all session-specific state. Called when the dialog closes
     * so no stale overrides/merges persist into the next invocation.
     */
    reset() {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        this._paletteSurgery.reset();
        this._scoring.reset();
        this._suggestions.reset();
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
        this._swapQueued = null;
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
            throw new Error('Image load already in progress');
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
        const initialEdgeSurvival = this.calculateCurrentEdgeSurvival();
        const initialFidelity = this.calculateDNAFidelity();

        // Initialize ScoringManager for this image
        this._scoring.initialize(this.proxyEngine, this.imageDNA, this._chameleonConfig, this._salamanderConfig);

        // Store Chameleon's ΔE and edge survival
        if (initialAccuracy != null) {
            this._scoring.setArchetypeDeltaE('dynamic_interpolator', initialAccuracy);
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
            this._scoring.setArchetypeDeltaE('distilled', distilledAccuracy);
        }

        // Score Salamander at startup (read-only, like Distilled)
        this._salamanderConfig = Reveal.generateConfigurationSalamander(this.imageDNA);
        const salamanderKnobs = {
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp
        };
        const salamanderQuality = await this.proxyEngine.getPaletteWithQuality(
            this._salamanderConfig, salamanderKnobs
        );
        const salamanderAccuracy = salamanderQuality.meanDeltaE;
        if (salamanderAccuracy != null) {
            this._scoring.setArchetypeDeltaE('salamander', salamanderAccuracy);
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

        const allScores = this._scoring.getAllArchetypeScores(); // instant DNA ranking

        // Inject Chameleon's ΔE, edge survival, and screen count (already computed above)
        const chameleonEntry = allScores.find(s => s.id === 'dynamic_interpolator');
        if (chameleonEntry) {
            const sep = this.proxyEngine.separationState;
            const chameleonColors = sep && sep.palette ? sep.palette.length : 0;
            chameleonEntry.meanDeltaE = initialAccuracy;
            chameleonEntry.edgeSurvival = initialEdgeSurvival;
            chameleonEntry.targetColors = chameleonColors;
            chameleonEntry.sortScore = initialAccuracy != null
                ? this._scoring.computeSortScore(initialAccuracy, chameleonColors, initialEdgeSurvival) : null;
        }

        // Inject Distilled's ΔE and edge survival (scored above)
        const distilledEntry = allScores.find(s => s.id === 'distilled');
        if (distilledEntry) {
            distilledEntry.meanDeltaE = distilledAccuracy;
            distilledEntry.edgeSurvival = distilledQuality.edgeSurvival;
            distilledEntry.targetColors = 12;
            distilledEntry.sortScore = distilledAccuracy != null
                ? this._scoring.computeSortScore(distilledAccuracy, 12, distilledQuality.edgeSurvival) : null;
        }

        // Inject Salamander's ΔE and edge survival (scored above)
        const salamanderEntry = allScores.find(s => s.id === 'salamander');
        if (salamanderEntry) {
            const salamanderColors = salamanderQuality.rgbPalette ? salamanderQuality.rgbPalette.length : 0;
            salamanderEntry.meanDeltaE = salamanderAccuracy;
            salamanderEntry.edgeSurvival = salamanderQuality.edgeSurvival;
            salamanderEntry.targetColors = salamanderColors;
            salamanderEntry.sortScore = salamanderAccuracy != null
                ? this._scoring.computeSortScore(salamanderAccuracy, salamanderColors, salamanderQuality.edgeSurvival) : null;
        }

        // Select tier-1 eager set: 3 pseudo + top-1 per group
        const eagerSet = this._scoring.selectEagerSet(allScores);

        this.emit('carouselReady', { scores: allScores, eagerSet, topMatchId: 'dynamic_interpolator' });
        logger.log(`[SessionState] Carousel ready — ${allScores.length} archetypes, ${eagerSet.size} eager (tier-1), Chameleon ΔE=${initialAccuracy != null ? initialAccuracy.toFixed(1) : '?'}`);

        // Launch background ΔE scoring for eager set only (tier-1)
        const generation = this._scoring.scoringGeneration;
        const knobs = this.getMechanicalKnobs();
        this._scoring.scoreArchetypes(allScores, 'dynamic_interpolator', generation, eagerSet, knobs);

        return proxyResult;
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
        this._suggestions.clearForSwap();

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
     * Confirm a pending structural change that would destroy palette edits.
     * Called by the UI after the user clicks OK on the warning dialog.
     */
    confirmStructuralChange() {
        const pending = this._pendingStructuralChange;
        if (!pending) return;
        this._pendingStructuralChange = null;
        this._structuralChangeConfirmed = true;
        this.updateParameter(pending.key, pending.value);
    }

    /**
     * Cancel a pending structural change — palette edits are preserved.
     * Called by the UI after the user clicks Cancel on the warning dialog.
     * Emits revertParameter so the UI can snap the slider back.
     */
    cancelStructuralChange() {
        const pending = this._pendingStructuralChange;
        if (!pending) return;
        this._pendingStructuralChange = null;
        this.emit('revertParameter', { key: pending.key, value: this.state[pending.key] });
    }

    /**
     * Update a single parameter and schedule a proxy update.
     *
     * @param {string} key - Parameter name
     * @param {*} value - New value
     */
    updateParameter(key, value) {
        if (this.state[key] === value) return;

        // Structural param + palette edits → need confirmation before proceeding
        if (STRUCTURAL_PARAMS.has(key) && this._paletteSurgery.hasEdits()) {
            if (!this._structuralChangeConfirmed) {
                // Stash the pending change and ask for confirmation
                this._pendingStructuralChange = { key, value };
                this.emit('confirmStructuralChange', { key, value });
                return;
            }
            this._structuralChangeConfirmed = false;
        }

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
                // Slow path: structural param changed — full re-posterize.
                // Clean slate: all palette surgery is lost (new palette = new indices).
                logger.log(`[SessionState] *** SLOW PATH: re-posterize triggered, clearing palette surgery`);

                this._rebuildConfigFromState();

                this._paletteSurgery.reset();
                this._suggestions.clearForSwap();
                this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
                result = await this.proxyEngine.rePosterize(this.currentConfig);
                this.state.isArchetypeDirty = false;

                // Invalidate cached baseline — structural change made it stale
                const id = this.state.activeArchetypeId;
                if (id) this._archetypeStateCache.delete(id);

                logger.log(`[SessionState] Structural re-posterize: targetColors=${this.currentConfig.targetColors}, palette=${result.palette.length} colors`);
            }

            // Build update params — always include palette overrides so they
            // survive the baseline restore inside updateProxy
            const updateParams = { ...this.getMechanicalKnobs() };
            if (this.paletteOverrides.size > 0) {
                updateParams.paletteOverride = this._paletteSurgery.buildOverriddenPalette();
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
            this._swapQueued = archetypeId;
            logger.log(`[SessionState] swapArchetype(${archetypeId}) queued — swap already in flight`);
            return null;
        }
        this._swapInFlight = true;

        // Cancel any in-flight background scoring
        this._scoring.cancelScoring();

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
            } else if (archetypeId === 'salamander') {
                this.currentConfig = Reveal.generateConfigurationSalamander(this.imageDNA);
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
            this.addedColors.clear();
            this._suggestions.clearForSwap();

            // Reset decision support state
            this.state.highlightColorIndex = -1;
            this.emit('highlightChanged', { colorIndex: -1 });
            this.state.isKnobsCustomized = false;

            logger.log(`[SessionState] Archetype swap: ${archetypeId}`);

            const cached = archetypeId ? this._archetypeStateCache.get(archetypeId) : null;

            this.emit('archetypeChanged', { archetypeId, config: this.currentConfig });

            let result;
            if (cached && cached.baseline) {
                // ── Fast path: restore cached baseline (skip re-posterize) ──
                // Indices are guaranteed correct because it's the exact same
                // baseline the palette surgery was originally made against.
                result = this.proxyEngine.restoreBaselineSnapshot(cached.baseline, this.currentConfig);
                logger.log(`[SessionState] Swap FAST (cached baseline): ${result.palette.length} colors, ${result.elapsedMs.toFixed(1)}ms`);
            } else {
                // ── Slow path: first visit — need to posterize ──
                if (cached) {
                    for (const key of STRUCTURAL_PARAMS) {
                        if (cached.knobs[key] !== undefined) {
                            this.state[key] = cached.knobs[key];
                            if (this.currentConfig) this.currentConfig[key] = cached.knobs[key];
                        }
                    }
                    if (cached.knobs.targetColors !== undefined) {
                        this.currentConfig.targetColorsSlider = cached.knobs.targetColors;
                    }
                }
                result = await this.proxyEngine.rePosterize(this.currentConfig);
                logger.log(`[SessionState] Swap SLOW (re-posterize): ${result.palette.length} colors, ${result.elapsedMs.toFixed(0)}ms`);
            }

            // Restore knobs + palette surgery
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
                updateParams.paletteOverride = this._paletteSurgery.buildOverriddenPalette();
            }

            const knobResult = await this.proxyEngine.updateProxy(updateParams);

            this.previewBuffer = knobResult.previewBuffer;
            this.state.proxyBufferReady = true;
            this.state.isProcessing = false;

            const swapAccuracy = this.calculateCurrentAccuracy();
            const swapEdgeSurvival = this.calculateCurrentEdgeSurvival();
            // Store ΔE + edge survival so on-demand clicked cards update their display
            if (swapAccuracy != null) {
                this._scoring.setArchetypeDeltaE(archetypeId, swapAccuracy);
                const sep = this.proxyEngine.separationState;
                const swapColors = sep && sep.palette ? sep.palette.length : 0;
                const swapSortScore = this._scoring.computeSortScore(swapAccuracy, swapColors, swapEdgeSurvival);
                this.emit('archetypeScored', {
                    id: archetypeId,
                    meanDeltaE: swapAccuracy,
                    edgeSurvival: swapEdgeSurvival,
                    targetColors: swapColors,
                    sortScore: swapSortScore
                });
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

            // If another swap was queued while we were running, run it now
            if (this._swapQueued !== null) {
                const queuedId = this._swapQueued;
                this._swapQueued = null;
                logger.log(`[SessionState] swapArchetype: draining queued swap → ${queuedId}`);
                this.swapArchetype(queuedId);
            }
        }
    }

    /** Get ranked archetype scores for the current image DNA. */
    getAllArchetypeScores() {
        return this._scoring.getAllArchetypeScores();
    }

    // ─── Highlight / Isolation ─────────────────────────────────

    /**
     * Set the highlighted (isolated) color index for preview.
     * @param {number} colorIndex - 0+ to highlight, -1 to clear
     */
    setHighlight(colorIndex) {
        this._suggestions.clearGhost();
        this.state.highlightColorIndex = colorIndex;
        this.emit('highlightChanged', { colorIndex });
    }

    /** Clear highlight — restore normal preview. */
    clearHighlight() {
        this._suggestions.clearGhost();
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

        for (let i = 0; i < pixelCount; i++) {
            const ci = colorIndices[i];
            const off = i * 4;

            if (ci === colorIndex) {
                const c = rgbPalette[ci];
                rgba[off]     = c.r;
                rgba[off + 1] = c.g;
                rgba[off + 2] = c.b;
            } else {
                rgba[off]     = DIM_COLOR;
                rgba[off + 1] = DIM_COLOR;
                rgba[off + 2] = DIM_COLOR;
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
        this._scoring.cancelScoring();

        logger.log(`[SessionState.override] idx=${colorIndex} Lab=(${newLabColor.L.toFixed(1)},${newLabColor.a.toFixed(1)},${newLabColor.b.toFixed(1)}) overrides=${this.paletteOverrides.size}`);
        this.paletteOverrides.set(colorIndex, { ...newLabColor });

        const overriddenPalette = this._paletteSurgery.buildOverriddenPalette();

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

        this._scoring.cancelScoring();
        this.paletteOverrides.delete(colorIndex);
        this.deletedColors.delete(colorIndex);

        // Clean up merge history: remove this source from whichever target absorbed it
        for (const [target, sources] of this.mergeHistory) {
            sources.delete(colorIndex);
            if (sources.size === 0) this.mergeHistory.delete(target);
        }

        // Cascade: if this index was itself a merge target (had dependents),
        // revert those dependents too — their overrides pointed at this color.
        const dependents = this.mergeHistory.get(colorIndex);
        if (dependents) {
            for (const dep of dependents) {
                this.paletteOverrides.delete(dep);
                this.deletedColors.delete(dep);
            }
            this.mergeHistory.delete(colorIndex);
        }

        const overriddenPalette = this._paletteSurgery.buildOverriddenPalette();

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
        this._scoring.cancelScoring();
        const basePalette = this._paletteSurgery.buildOverriddenPalette();
        if (!basePalette || colorIndex >= basePalette.length) {
            throw new Error(`Invalid palette index: ${colorIndex}`);
        }

        // Include checked suggestions as candidates — they are part of the
        // effective palette at commit time, appended after the base palette.
        const palette = this._suggestions.checkedSuggestions.length > 0
            ? [...basePalette, ...this._suggestions.checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
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
            const overriddenPalette = this._paletteSurgery.buildOverriddenPalette();
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

        this._scoring.cancelScoring();

        // Follow merge chain: if target is itself a merge source, redirect
        // to the ultimate target.  A→B then C→A should become C→B.
        let ultimateTarget = targetIndex;
        for (const [target, sources] of this.mergeHistory) {
            if (sources.has(ultimateTarget)) {
                ultimateTarget = target;
                break;
            }
        }

        logger.log(`[SessionState.merge] source=${sourceIndex} target=${targetIndex}${ultimateTarget !== targetIndex ? ` → ultimate=${ultimateTarget}` : ''} mapSize_before=${this.paletteOverrides.size} keys=[${[...this.paletteOverrides.keys()]}]`);

        // Read from baseline+overrides (the consistent visible state),
        // not separationState.palette which is mutable post-knob state.
        const palette = this._paletteSurgery.buildOverriddenPalette();
        if (!palette || sourceIndex >= palette.length || ultimateTarget >= palette.length) {
            throw new Error(`Invalid palette index: source=${sourceIndex}, target=${ultimateTarget}, size=${palette ? palette.length : 0}`);
        }

        // Clean up: if source was already merged into a different target,
        // remove it from the old target's source set (prevents stale +N badges).
        for (const [target, sources] of this.mergeHistory) {
            if (sources.delete(sourceIndex) && sources.size === 0) {
                this.mergeHistory.delete(target);
            }
        }

        this.paletteOverrides.set(sourceIndex, { ...palette[ultimateTarget] });

        // Track merge relationship on the ultimate target so badge count is correct
        if (!this.mergeHistory.has(ultimateTarget)) {
            this.mergeHistory.set(ultimateTarget, new Set());
        }
        this.mergeHistory.get(ultimateTarget).add(sourceIndex);

        const overriddenPalette = this._paletteSurgery.buildOverriddenPalette();

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

        this._scoring.cancelScoring();

        // Sanity cap at 20 screens (auto presses max ~14 stations)
        const palette = this.proxyEngine._baselineState.palette;
        if (palette.length >= 20) {
            logger.log('[SessionState.addColor] Max 20 colors reached — ignoring add');
            return null;
        }

        const newIndex = palette.length;
        logger.log(`[SessionState.addColor] Adding Lab=(${labColor.L.toFixed(1)},${labColor.a.toFixed(1)},${labColor.b.toFixed(1)}) at index ${newIndex}`);

        this.addedColors.add(newIndex);

        await this.proxyEngine.addColorAndReseparate(labColor);

        // Apply current knobs so the user sees the same result as updateProxy.
        // Without this, the initial add preview skips speckle/shadow knobs —
        // the color appears post-add but vanishes on the next updateProxy call
        // (e.g. archetype swap round-trip) when speckleRescue despeckles it.
        const updateParams = { ...this.getMechanicalKnobs() };
        if (this.paletteOverrides.size > 0) {
            updateParams.paletteOverride = this._paletteSurgery.buildOverriddenPalette();
        }
        const result = await this.proxyEngine.updateProxy(updateParams);

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

        this._scoring.cancelScoring();
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
        const basePalette = this._paletteSurgery.buildOverriddenPalette();
        const palette = this._suggestions.checkedSuggestions.length > 0
            ? [...basePalette, ...this._suggestions.checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
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
        const palette = this._paletteSurgery.buildOverriddenPalette();

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
        const separationPalette = this._suggestions.checkedSuggestions.length > 0
            ? [...baselinePalette, ...this._suggestions.checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
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
            palette: this._suggestions.checkedSuggestions.length > 0
                ? [...palette, ...this._suggestions.checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
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
     * Compute edge survival for the current live separation state.
     * @returns {number|null} Edge survival ratio (0-1), or null if not ready
     */
    calculateCurrentEdgeSurvival() {
        const proxy = this.proxyEngine;
        if (!proxy || !proxy.proxyBuffer || !proxy.separationState) return null;

        const { colorIndices, width, height } = proxy.separationState;
        const result = Reveal.RevelationError.edgeSurvival16(
            proxy.proxyBuffer, colorIndices, width, height
        );
        return result.edgeSurvival;
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
        return this._scoring.getArchetypeDeltaE(id) || null;
    }

    /**
     * Get the stored sortScore for an archetype (from background scoring).
     * @param {string} [archetypeId] - defaults to active archetype
     * @returns {number|null}
     */
    getArchetypeSortScore(archetypeId) {
        const id = archetypeId || this.state.activeArchetypeId;
        const all = this._scoring.allScores;
        if (!all) return null;
        const entry = all.find(s => s.id === id);
        return entry && entry.sortScore != null ? entry.sortScore : null;
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
     * Delegates to core's extractMechanicalKnobs() for consistent field selection.
     * @returns {{minVolume: number, speckleRescue: number, shadowClamp: number, trapSize: number}}
     */
    getMechanicalKnobs() {
        return Reveal.engines.ParameterGenerator.extractMechanicalKnobs(this.state);
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

    /** Get suggested colors that the engine found but couldn't include. */
    getSuggestedColors() {
        return this._suggestions.getSuggestedColors();
    }

    /** Suggested colors the user marked "must be in final palette". */
    get checkedSuggestions() {
        return this._suggestions.checkedSuggestions;
    }

    /** Mark a suggested color as "must be in final palette". */
    addCheckedSuggestion(labColor) {
        this._suggestions.addCheckedSuggestion(labColor);
    }

    /** Remove a checked suggestion by proximity (ΔE < 4). */
    removeCheckedSuggestion(labColor) {
        this._suggestions.removeCheckedSuggestion(labColor);
    }

    /** Check if a suggestion is already checked (ΔE < 4). */
    isSuggestionChecked(labColor) {
        return this._suggestions.isSuggestionChecked(labColor);
    }

    /** Generate ghost preview for a suggested color. */
    generateSuggestionGhostPreview(labColor, mode = 'integrated') {
        return this._suggestions.generateSuggestionGhostPreview(labColor, mode);
    }

    /** Set a suggestion ghost preview. Emits highlightChanged via ghostChanged event. */
    setSuggestionGhost(labColor, mode = 'integrated') {
        this._suggestions.setSuggestionGhost(labColor, mode);
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
        return this._paletteSurgery.buildOverriddenPalette();
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

        this._archetypeStateCache.set(id, {
            knobs,
            baseline: this.proxyEngine ? this.proxyEngine.getBaselineSnapshot() : null,
            ...this._paletteSurgery.snapshot()
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

        // Restore palette surgery via manager (deep-copies internally)
        this._paletteSurgery.restore({
            paletteOverrides: cached.paletteOverrides,
            mergeHistory: cached.mergeHistory,
            deletedColors: cached.deletedColors,
            addedColors: cached.addedColors
        });

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
        return this.state.isKnobsCustomized || this._paletteSurgery.hasEdits();
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
        for (const [key, val] of Object.entries(MECHANICAL_KNOB_DEFAULTS)) {
            // Respect config-provided mechanical knob values (e.g. pseudo-archetypes
            // set speckleRescue: 5 for print-ready masks). Fall back to default.
            const effective = config[key] !== undefined ? config[key] : val;
            this.state[key] = effective;
            config[key] = effective;
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

    // _buildOverriddenPalette → delegated to this._paletteSurgery.buildOverriddenPalette()
}

module.exports = SessionState;
