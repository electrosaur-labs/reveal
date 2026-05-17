/**
 * SessionState - Centralized state coordinator for Engineer UI
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
const DNA12 = require('./DNA12');
const { DIM_COLOR } = require('../utils/pixelProcessing');
const PipelineEngine = Reveal.engines.PipelineEngine;
const EngineBuilder = Reveal.engines.EngineBuilder;
const EngineRegistry = Reveal.engines.EngineRegistry;

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
const STRUCTURAL_PARAMS = new Set([...CONFIG_CATEGORIES.STRUCTURAL, 'meshSize']);

// Union of all user-facing knobs (for snapshot/restore/reset/dirty loops).
// Includes mechanical, production, and structural params.
const ALL_KNOBS = new Set([
    ...MECHANICAL_KNOBS, ...PRODUCTION_KNOBS, ...STRUCTURAL_PARAMS, 'meshSize'
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
        this.imageDNA = null;               // DNA v2.0 snapshot (from full-res pixels at load)
        this._currentResolutionDNA = null;  // DNA12 recomputed from current proxy buffer (per-resolution)
        this._rusalkaProxyState = null;      // Snapshot of initializeProxy Rusalka result (authoritative core path)
        this.imageWidth = 0;                // Proxy dimensions
        this.imageHeight = 0;
        this.imageResolution = 72;          // Document PPI (pixels per inch)
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
        this._currentResolutionDNA = null;
        this._rusalkaProxyState = null;
        this._sourceLabPixels = null;
        this._proxyTargetSize = 1000;
        this.imageWidth = 0;
        this.imageHeight = 0;
        this.imageResolution = 72;
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
        this._sourceLabPixels = labPixels; // Retained for proxy re-initialization at different resolutions
        this.imageWidth = width;
        this.imageHeight = height;
        this.originalWidth = originalWidth || width;
        this.originalHeight = originalHeight || height;
        this.paletteOverrides.clear();
        this.mergeHistory.clear();
        this.deletedColors.clear();
        this._archetypeStateCache.clear();

        // ── Phase 1: DNA analysis (~51ms) ──
        this.emit('progress', { phase: 'structural', label: 'Analyzing image DNA\u2026', percent: 35 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        const dnaGen = new Reveal.DNAGenerator();
        this.imageDNA = dnaGen.generate(labPixels, width, height, { bitDepth: 16 });

        // Augment with the Engineer's 12-vector phase-space features. They land
        // at the top level of imageDNA (dna.lMean, dna.spatialEntropy, ...) so
        // EngineBuilder modulation reads them, while v2.0 consumers (ArchetypeMapper,
        // DNAFidelity) keep reading dna.global.* and dna.sectors.* unchanged.
        DNA12.augment(this.imageDNA, labPixels, width, height);

        logger.log(`[SessionState] DNA generated (dominant_sector=${this.imageDNA.dominant_sector})`);
        logger.log(`[SessionState] DNA12: lMean=${this.imageDNA.lMean.toFixed(3)} cMax=${this.imageDNA.cMax.toFixed(3)} hueCount=${this.imageDNA.hueCount.toFixed(3)} hueVar=${this.imageDNA.hueVariance.toFixed(3)} sEntropy=${this.imageDNA.spatialEntropy.toFixed(3)} edge=${this.imageDNA.edgeDensity.toFixed(3)} sal=${this.imageDNA.saliency.toFixed(3)} neutral=${this.imageDNA.neutralAnchor.toFixed(3)} shadow=${this.imageDNA.shadowMass.toFixed(3)} highlight=${this.imageDNA.highlightMass.toFixed(3)}`);

        this.emit('dnaReady', this.imageDNA);

        // ── Phase 2: Archetype selection (~50ms) ──
        // Mapping DNA to archetype personality (identical to Engineer)
        const archetypes = Reveal.ArchetypeLoader.loadArchetypes();
        const mapper = new Reveal.ArchetypeMapper(archetypes);
        const bestArchetype = mapper.getBestMatch(this.imageDNA);
        this._activeArchetype = bestArchetype;
        logger.log(`[SessionState] Image DNA mapped to archetype: ${bestArchetype.id}`);

        // ── Phase 3: Initial posterization using primary goddess engine (~400ms) ──
        this.emit('progress', { phase: 'visual', label: 'Building configuration\u2026', percent: 45 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        // Default to 'aine' goddess engine for initial render.
        // Engine is built from def + DNA — no archetype merge (engineer inversion).
        const initialEngineId = 'aine';
        const engineDef = EngineRegistry.get(initialEngineId);
        const hydratedEngine = EngineBuilder.build(engineDef, this.imageDNA);

        this.currentConfig = Reveal.generateConfiguration(this.imageDNA, {
            manualArchetypeId: bestArchetype.id,
            engineOverride: hydratedEngine
        });
        
        this._applyConfigToState(this.currentConfig);
        this.state.activeArchetypeId = initialEngineId; // In Engineer, "activeArchetypeId" tracks the ENGINE
        this.state.initialArchetypeId = initialEngineId;

        this.emit('imageLoaded', { width, height, dna: this.imageDNA });
        this.emit('configChanged', this.currentConfig);

        this._proxyTargetSize = Reveal.ProxyEngine.PROXY_TARGET_SIZE;
        this.proxyEngine = new Reveal.ProxyEngine();
        
        this.emit('progress', { phase: 'visual', label: 'Downsampling proxy\u2026', percent: 55 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        // OPTIMIZATION: Skip legacy posterization pass inside initializeProxy.
        // We will run the authoritative PipelineEngine next.
        const proxyInit = await this.proxyEngine.initializeProxy(
            labPixels, width, height, { ...this.currentConfig, skipPosterize: true }
        );
        const proxyBuffer = this.proxyEngine.proxyBuffer; // Raw 16-bit Engine Lab
        const proxyW = proxyInit.dimensions.width;
        const proxyH = proxyInit.dimensions.height;

        // Cache resolution-local DNA12 (computed from proxy pixels, not full-res).
        this._currentResolutionDNA = { ...this.imageDNA };
        DNA12.augment(this._currentResolutionDNA, proxyBuffer, proxyW, proxyH);

        this.emit('progress', { phase: 'visual', label: 'Executing pipeline\u2026', percent: 75 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        // AUTHORITATIVE POSTERIZATION: Use the isolated PipelineEngine asynchronously
        const result = await PipelineEngine.executeAsync(proxyBuffer, hydratedEngine, {
            ...this.currentConfig,
            width: proxyW,
            height: proxyH,
            onProgress: (pct) => {
                this.emit('progress', { phase: 'visual', label: 'Executing pipeline\u2026', percent: 65 + (pct * 0.2) });
            }
        });

        this.emit('progress', { phase: 'visual', label: 'Rendering preview\u2026', percent: 85 });
        await new Promise(r => setTimeout(r, 20)); // yield for repaint

        // Install into BOTH separationState and _baselineState
        const { rgbPalette } = this._installPosterizationResult(result, proxyW, proxyH);

        // Convert 16-bit proxy buffer to 8-bit Lab ONLY for the UI preview generator facade
        const proxyBuffer8 = Reveal.LabEncoding.convertEngine16bitTo8bitLab(proxyBuffer, proxyW * proxyH);
        const rgbaBuffer = Reveal.generatePreview(proxyBuffer8, result.palette, rgbPalette);

        logger.log(`[SessionState] ${initialEngineId} posterized via Pipeline: ${result.palette.length} colors in ${result.metadata.elapsedMs}ms`);

        this.previewBuffer = rgbaBuffer;
        this.state.proxyBufferReady = true;
        this.state.isProcessing = false;

        // --- Quality Metrics (EAGER COMPUTATION) ---
        const meanDeltaE = Reveal.RevelationError.meanDeltaE16(
            proxyBuffer, result.assignments, result.palette, proxyW * proxyH
        );
        const edgeResult = Reveal.RevelationError.edgeSurvival16(
            proxyBuffer, result.assignments, proxyW, proxyH
        );
        
        this._scoring.setArchetypeDeltaE(initialEngineId, meanDeltaE);
        const initialFidelity = this.calculateDNAFidelity();

        // Initialize ScoringManager with the 5 goddess engines
        this._scoring.initialize(this.proxyEngine, this._currentResolutionDNA);

        this.emit('proxyReady', {
            previewBuffer: rgbaBuffer,
            palette: result.palette,
            dimensions: { width: proxyW, height: proxyH },
            elapsedMs: result.metadata.elapsedMs
        });

        this.emit('previewUpdated', {
            previewBuffer: rgbaBuffer,
            palette: result.palette,
            activeColorCount: result.palette.length,
            elapsedMs: result.metadata.elapsedMs,
            dimensions: { width: proxyW, height: proxyH },
            accuracyDeltaE: meanDeltaE,
            dnaFidelity: initialFidelity
        });

        // ── Phase 4: Carousel ready with the 5 goddess engines ──
        const goddessEngines = ['aine', 'anu', 'brigid', 'cailleach', 'morrigan', 'rhiannon', 'rusalka'];
        const allScores = goddessEngines.map(id => ({ id, score: 0 }));

        // EAGER RESULTS: Feed the initial engine's stats to ScoringManager so it 
        // doesn't re-calculate the active card in the background loop.
        const eagerResults = new Map();
        eagerResults.set(initialEngineId, {
            palette: result.palette,
            rgbPalette: rgbPalette,
            meanDeltaE: meanDeltaE,
            edgeSurvival: edgeResult.edgeSurvival
        });

        this.emit('carouselReady', { scores: allScores, topMatchId: initialEngineId });
        
        // Launch background ΔE scoring
        const generation = this._scoring.scoringGeneration;
        const knobs = this.getMechanicalKnobs();
        this._scoring.scoreArchetypes(allScores, initialEngineId, generation, eagerResults, knobs);

        return proxyInit;
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
        this.emit('configChanged', this.currentConfig);

        this.state.isArchetypeDirty = true;
        this._scheduleProxyUpdate();
    }

    /**
     * Get the archetype default for a knob key.
     */
    getKnobDefault(key) {
        return this._archetypeDefaults ? this._archetypeDefaults[key] : null;
    }

    // ─── Parameter Updates (Reactive Loop) ───────────────────

    confirmStructuralChange() {
        const pending = this._pendingStructuralChange;
        if (!pending) return;
        this._pendingStructuralChange = null;
        this._structuralChangeConfirmed = true;
        this.updateParameter(pending.key, pending.value);
    }

    cancelStructuralChange() {
        const pending = this._pendingStructuralChange;
        if (!pending) return;
        this._pendingStructuralChange = null;
        this.emit('revertParameter', { key: pending.key, value: this.state[pending.key] });
    }

    updateParameter(key, value) {
        if (this.state[key] === value) return;

        if (STRUCTURAL_PARAMS.has(key) && this._paletteSurgery.hasEdits()) {
            if (!this._structuralChangeConfirmed) {
                this._pendingStructuralChange = { key, value };
                this.emit('confirmStructuralChange', { key, value });
                return;
            }
            this._structuralChangeConfirmed = false;
        }

        this.state[key] = value;

        if (STRUCTURAL_PARAMS.has(key)) {
            this.state.isArchetypeDirty = true;
        }

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

        if (PRODUCTION_KNOBS.has(key) && !STRUCTURAL_PARAMS.has(key)) return;

        this._scheduleProxyUpdate();
    }

    _scheduleProxyUpdate() {
        if (this._debounceTimer !== null) {
            clearTimeout(this._debounceTimer);
        }
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            this.triggerProxyUpdate();
        }, DEBOUNCE_MS);
    }

    async triggerProxyUpdate() {
        if (!this.proxyEngine) return null;

        if (this._updateInFlight) {
            this._updateQueued = true;
            return null;
        }

        this._updateInFlight = true;
        this.state.isProcessing = true;
        this.emit('processingStart');

        try {
            let result;

            if (this.state.isArchetypeDirty) {
                this._rebuildConfigFromState();
                this._paletteSurgery.reset();
                this._suggestions.clearForSwap();
                this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
                result = await this.proxyEngine.rePosterize(this.currentConfig);
                this.state.isArchetypeDirty = false;

                const id = this.state.activeArchetypeId;
                if (id) this._archetypeStateCache.delete(id);
            }

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
            logger.log(`[SessionState] Proxy update FAILED: ${err.message}`);
            this.emit('error', err);
            return null;
        } finally {
            this._updateInFlight = false;
            if (this._updateQueued) {
                this._updateQueued = false;
                this.triggerProxyUpdate();
            }
        }
    }

    // ─── Engine Navigation ────────────────────────────────

    async swapArchetype(engineId) {
        if (!this.imageDNA) {
            throw new Error('No image loaded — call loadImage() first');
        }
        if (!this.proxyEngine || !this.proxyEngine.proxyBuffer) {
            throw new Error('Proxy not initialized — call loadImage() first');
        }
        if (this._swapInFlight) {
            this._swapQueued = engineId;
            return null;
        }
        this._swapInFlight = true;

        this._scoring.cancelScoring();

        try {
            this._snapshotArchetypeState(this.state.activeArchetypeId);

            const engineDef = EngineRegistry.get(engineId);
            const dna = this._currentResolutionDNA || this.imageDNA;
            const hydratedEngine = EngineBuilder.build(engineDef, dna);

            this.currentConfig = Reveal.generateConfiguration(dna, {
                manualArchetypeId: this._activeArchetype.id,
                engineOverride: hydratedEngine
            });
            
            this._applyConfigToState(this.currentConfig);
            this.state.activeArchetypeId = engineId;
            this.state.isArchetypeDirty = false;

            this.paletteOverrides.clear();
            this.mergeHistory.clear();
            this.deletedColors.clear();
            this.addedColors.clear();
            this._suggestions.clearForSwap();

            this.state.highlightColorIndex = -1;
            this.emit('highlightChanged', { colorIndex: -1 });
            this.state.isKnobsCustomized = false;

            logger.log(`[SessionState] Engine swap: ${engineId}`);

            this.emit('archetypeChanged', { archetypeId: engineId, config: this.currentConfig });

            // Per-card isolation: every swap recomputes the posterization fresh.
            // The controls cache (knobs + palette surgery) is restored AFTER
            // installPosterizationResult by _restoreArchetypeState; the raw
            // result itself is never cached (avoids OOM on large images).
            const proxyBuffer = this.proxyEngine.proxyBuffer; // Raw 16-bit Engine Lab
            const proxyW = this.proxyEngine.separationState.width;
            const proxyH = this.proxyEngine.separationState.height;

            // Mk1.5: use the snapshot from initializeProxy (authoritative core path)
            // rather than re-running via PipelineEngine's reimplementation.
            let pipelineRes;
            if (engineId === 'rusalka' && this._rusalkaProxyState) {
                pipelineRes = {
                    palette: this._rusalkaProxyState.palette,
                    assignments: this._rusalkaProxyState.colorIndices,
                    metadata: this._rusalkaProxyState.metadata
                };
            } else {
                pipelineRes = await PipelineEngine.executeAsync(proxyBuffer, hydratedEngine, {
                    ...this.currentConfig,
                    width: proxyW,
                    height: proxyH
                });
            }

            const { rgbPalette } = this._installPosterizationResult(pipelineRes, proxyW, proxyH);

            // Generate RGBA preview from the freshly installed separationState
            const proxyBuffer8 = Reveal.LabEncoding.convertEngine16bitTo8bitLab(proxyBuffer, proxyW * proxyH);
            const rgbaBuffer = Reveal.generatePreview(proxyBuffer8, pipelineRes.palette, rgbPalette);

            const result = {
                previewBuffer: rgbaBuffer,
                palette: pipelineRes.palette,
                dimensions: { width: proxyW, height: proxyH },
                metadata: pipelineRes.metadata,
                elapsedMs: pipelineRes.metadata.elapsedMs
            };

            this._restoreArchetypeState(engineId);

            this.emit('configChanged', this.currentConfig);
            this.emit('knobsCustomizedChanged', { customized: this.state.isKnobsCustomized });
            this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });

            const knobResult = await this.proxyEngine.updateProxy(this.getMechanicalKnobs());

            this.previewBuffer = knobResult.previewBuffer;
            this.state.proxyBufferReady = true;
            this.state.isProcessing = false;

            const swapAccuracy = this.calculateCurrentAccuracy();
            const swapEdgeSurvival = this.calculateCurrentEdgeSurvival();
            const swapFidelity = this.calculateDNAFidelity();

            this.emit('previewUpdated', {
                previewBuffer: knobResult.previewBuffer,
                palette: knobResult.palette,
                activeColorCount: knobResult.palette.length,
                elapsedMs: result.elapsedMs + knobResult.elapsedMs,
                dimensions: result.dimensions,
                accuracyDeltaE: swapAccuracy,
                dnaFidelity: swapFidelity
            });

            return result;
        } finally {
            this._swapInFlight = false;
            if (this._swapQueued !== null) {
                const queuedId = this._swapQueued;
                this._swapQueued = null;
                this.swapArchetype(queuedId);
            }
        }
    }

    async reinitializeProxy() {
        if (!this._sourceLabPixels || !this.proxyEngine || !this.currentConfig) {
            throw new Error('No image loaded — cannot reinitialize proxy');
        }

        this._scoring.cancelScoring();
        this._archetypeStateCache.clear();

        this._proxyTargetSize = Reveal.ProxyEngine.PROXY_TARGET_SIZE;
        this.proxyEngine = new Reveal.ProxyEngine();
        const proxyResult = await this.proxyEngine.initializeProxy(
            this._sourceLabPixels, this.imageWidth, this.imageHeight, this.currentConfig
        );

        // Snapshot the Mk1.5 result before it gets overwritten.
        const proxyBuffer = this.proxyEngine.proxyBuffer;
        const proxyW = proxyResult.dimensions.width;
        const proxyH = proxyResult.dimensions.height;
        const sep = this.proxyEngine.separationState;
        this._rusalkaProxyState = {
            palette: sep.palette.map(c => ({ ...c })),
            colorIndices: new Uint8Array(sep.colorIndices),
            metadata: { ...sep.metadata },
            width: proxyW,
            height: proxyH
        };

        // Re-run the active goddess engine at the new resolution so the preview
        // matches what was shown before the resize (not the Mk1.5 initializeProxy baseline).
        const engineId = this.state.activeArchetypeId;

        // Resolution-local DNA: shallow-copy the frozen 7D global + sector data,
        // then overwrite the 12 resolution-sensitive features (spatialEntropy,
        // edgeDensity, etc.) from the current proxy buffer so EngineBuilder
        // modulation actually shifts between 1000px / 1500px / 2000px.
        // Stored on the instance so swapArchetype can reuse without recomputing.
        this._currentResolutionDNA = { ...this.imageDNA };
        DNA12.augment(this._currentResolutionDNA, proxyBuffer, proxyW, proxyH);
        const resolutionDNA = this._currentResolutionDNA;
        logger.log(`[reinitializeProxy] ${proxyW}x${proxyH} DNA12: sEntropy=${resolutionDNA.spatialEntropy.toFixed(3)} edge=${resolutionDNA.edgeDensity.toFixed(3)} cMax=${resolutionDNA.cMax.toFixed(3)}`);

        if (engineId) {
            let pipelineRes;
            if (engineId === 'rusalka') {
                // Mk1.5 snapshot was already captured above — use it directly.
                pipelineRes = {
                    palette: this._rusalkaProxyState.palette,
                    assignments: this._rusalkaProxyState.colorIndices,
                    metadata: this._rusalkaProxyState.metadata
                };
            } else {
            const engineDef = EngineRegistry.get(engineId);
            const hydratedEngine = EngineBuilder.build(engineDef, resolutionDNA);

            pipelineRes = PipelineEngine.execute(proxyBuffer, hydratedEngine, {
                ...this.currentConfig,
                width: proxyW,
                height: proxyH
            });
            }

            this._installPosterizationResult(pipelineRes, proxyW, proxyH);
        }

        const knobResult = await this.proxyEngine.updateProxy(this.getMechanicalKnobs());

        this.previewBuffer = knobResult.previewBuffer;
        this.state.proxyBufferReady = true;
        this._scoring.initialize(this.proxyEngine, resolutionDNA);

        this.emit('proxyReady', {
            previewBuffer: knobResult.previewBuffer,
            palette: knobResult.palette,
            dimensions: proxyResult.dimensions,
            elapsedMs: proxyResult.elapsedMs + knobResult.elapsedMs
        });

        // Emit previewUpdated so PaletteSurgeon and carousel rebuild their
        // swatch grids against the correct post-pipeline separationState.
        // Without this, swatches keep stale palette indices from the previous
        // resolution, so clicking swatch[i] isolates the wrong plate.
        this.emit('previewUpdated', {
            previewBuffer: knobResult.previewBuffer,
            palette: knobResult.palette,
            activeColorCount: this._countActiveColors(),
            elapsedMs: knobResult.elapsedMs,
            dimensions: proxyResult.dimensions,
            accuracyDeltaE: this.calculateCurrentAccuracy(),
            dnaFidelity: this.calculateDNAFidelity()
        });

        // Restart background scoring at the new resolution so all card swatches refresh.
        const allScores = this._scoring.getAllArchetypeScores();
        const generation = this._scoring.scoringGeneration;
        this._scoring.scoreArchetypes(allScores, engineId, generation, new Set(), this.getMechanicalKnobs());
    }

    getAllArchetypeScores() {
        return this._scoring.getAllArchetypeScores();
    }

    // ─── Highlight / Isolation ─────────────────────────────────

    setHighlight(colorIndex) {
        this._suggestions.clearGhost();
        this.state.highlightColorIndex = colorIndex;
        this.emit('highlightChanged', { colorIndex });
    }

    clearHighlight() {
        this._suggestions.clearGhost();
        this.setHighlight(-1);
    }

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

    async overridePaletteColor(colorIndex, newLabColor) {
        this._scoring.cancelScoring();
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

    async revertPaletteColor(colorIndex) {
        if (!this.paletteOverrides.has(colorIndex) && !this.deletedColors.has(colorIndex)) return null;
        this._scoring.cancelScoring();
        this.paletteOverrides.delete(colorIndex);
        this.deletedColors.delete(colorIndex);
        for (const [target, sources] of this.mergeHistory) {
            sources.delete(colorIndex);
            if (sources.size === 0) this.mergeHistory.delete(target);
        }
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

    async deletePaletteColor(colorIndex) {
        this._scoring.cancelScoring();
        const basePalette = this._paletteSurgery.buildOverriddenPalette();
        if (!basePalette || colorIndex >= basePalette.length) {
            throw new Error(`Invalid palette index: ${colorIndex}`);
        }
        const palette = this._suggestions.checkedSuggestions.length > 0
            ? [...basePalette, ...this._suggestions.checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
            : basePalette;
        const dead = new Set(this.deletedColors);
        for (const sources of this.mergeHistory.values()) {
            for (const s of sources) dead.add(s);
        }
        dead.add(colorIndex);
        const metric = (this.currentConfig && this.currentConfig.distanceMetric) || 'cie76';
        const distFn = metric === 'cie2000' ? Reveal.LabDistance.cie2000SquaredInline
                     : metric === 'cie94'   ? Reveal.LabDistance.cie94SquaredInline
                     :                        Reveal.LabDistance.cie76SquaredInline;
        const src = palette[colorIndex];
        let bestDist = Infinity;
        let bestIdx = -1;
        for (let i = 0; i < palette.length; i++) {
            if (dead.has(i)) continue;
            const d = distFn(src.L, src.a, src.b, palette[i].L, palette[i].a, palette[i].b);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        if (bestIdx === -1) throw new Error('Cannot delete the last remaining color');
        this.deletedColors.add(colorIndex);
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

    async mergePaletteColors(sourceIndex, targetIndex) {
        if (!this.proxyEngine || !this.proxyEngine.separationState) throw new Error('Proxy not initialized');
        this._scoring.cancelScoring();
        let ultimateTarget = targetIndex;
        for (const [target, sources] of this.mergeHistory) {
            if (sources.has(ultimateTarget)) {
                ultimateTarget = target;
                break;
            }
        }
        const palette = this._paletteSurgery.buildOverriddenPalette();
        if (!palette || sourceIndex >= palette.length || ultimateTarget >= palette.length) {
            throw new Error(`Invalid palette index: source=${sourceIndex}, target=${ultimateTarget}`);
        }
        for (const [target, sources] of this.mergeHistory) {
            if (sources.delete(sourceIndex) && sources.size === 0) this.mergeHistory.delete(target);
        }
        this.paletteOverrides.set(sourceIndex, { ...palette[ultimateTarget] });
        if (!this.mergeHistory.has(ultimateTarget)) this.mergeHistory.set(ultimateTarget, new Set());
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

    async addPaletteColor(labColor) {
        if (!this.proxyEngine || !this.proxyEngine.separationState) throw new Error('Proxy not initialized');
        this._scoring.cancelScoring();
        const palette = this.proxyEngine._baselineState.palette;
        if (palette.length >= 20) return null;
        const newIndex = palette.length;
        this.addedColors.add(newIndex);
        await this.proxyEngine.addColorAndReseparate(labColor);
        const updateParams = { ...this.getMechanicalKnobs() };
        if (this.paletteOverrides.size > 0) updateParams.paletteOverride = this._paletteSurgery.buildOverriddenPalette();
        const result = await this.proxyEngine.updateProxy(updateParams);
        this.previewBuffer = result.previewBuffer;
        this.state.proxyBufferReady = true;
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
        this._emitPreviewUpdated(result);
        return result;
    }

    async removeAddedColor(colorIndex) {
        if (!this.addedColors.has(colorIndex)) return null;
        this._scoring.cancelScoring();
        this.addedColors.delete(colorIndex);
        const shifted = new Set();
        for (const idx of this.addedColors) shifted.add(idx > colorIndex ? idx - 1 : idx);
        this.addedColors = shifted;
        const newOverrides = new Map();
        for (const [idx, color] of this.paletteOverrides) {
            if (idx === colorIndex) continue;
            newOverrides.set(idx > colorIndex ? idx - 1 : idx, color);
        }
        this.paletteOverrides = newOverrides;
        const newMergeHistory = new Map();
        for (const [target, sources] of this.mergeHistory) {
            if (target === colorIndex) continue;
            const newTarget = target > colorIndex ? target - 1 : target;
            const newSources = new Set();
            for (const s of sources) if (s !== colorIndex) newSources.add(s > colorIndex ? s - 1 : s);
            if (newSources.size > 0) newMergeHistory.set(newTarget, newSources);
        }
        this.mergeHistory = newMergeHistory;
        const newDeleted = new Set();
        for (const idx of this.deletedColors) if (idx !== colorIndex) newDeleted.add(idx > colorIndex ? idx - 1 : idx);
        this.deletedColors = newDeleted;
        const result = await this.proxyEngine.removeColorAndReseparate(colorIndex);
        this.previewBuffer = result.previewBuffer;
        this.state.proxyBufferReady = true;
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
        this._emitPreviewUpdated(result);
        return result;
    }

    // ─── Production Export ────────────────────────────────────

    buildManifest(productionResult) {
        const PhotoshopBridge = require('../bridge/PhotoshopBridge');
        const docInfo = PhotoshopBridge.getDocumentInfo();
        let archetypeSection = { id: null, name: null, score: 0 };
        if (this._activeArchetype) archetypeSection = { id: this._activeArchetype.id, name: this._activeArchetype.name, score: 1.0 };
        const overrides = {};
        const deletions = [];
        for (const [idx, color] of this.paletteOverrides) {
            if (this.deletedColors.has(idx)) deletions.push(idx);
            else overrides[String(idx)] = { L: Math.round(color.L * 10) / 10, a: Math.round(color.a * 10) / 10, b: Math.round(color.b * 10) / 10 };
        }
        const merges = {};
        for (const [target, sources] of this.mergeHistory) merges[String(target)] = [...sources];
        const palette = this._paletteSurgery.buildOverriddenPalette();
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
            return { L: Math.round(c.L * 10) / 10, a: Math.round(c.a * 10) / 10, b: Math.round(c.b * 10) / 10, hex: `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toUpperCase(), coverage: pixelCounts ? ((pixelCounts[i] / totalPixels) * 100).toFixed(2) + '%' : 'n/a' };
        });
        return {
            meta: { generator: 'Electrosaur Engineer v1.1.0', timestamp: new Date().toISOString(), filename: docInfo ? docInfo.name : 'unknown', width: docInfo ? docInfo.width : this.originalWidth, height: docInfo ? docInfo.height : this.originalHeight, bitDepth: 16 },
            archetype: archetypeSection,
            engineId: this.state.activeArchetypeId,
            knobs: (() => { const k = {}; for (const key of ALL_KNOBS) if (this.state[key] !== undefined) k[key] = this.state[key]; return k; })(),
            surgery: { overrides, merges, deletions },
            palette: paletteSection,
            dna: this.imageDNA || {},
            metrics: { avgDeltaE: this.calculateCurrentAccuracy(), layerCount: productionResult ? productionResult.layerCount : 0, elapsedMs: productionResult ? productionResult.elapsedMs : 0 }
        };
    }

    exportProductionConfig() {
        const palette = this._paletteSurgery.buildOverriddenPalette();
        this._rebuildConfigFromState();
        const config = { ...this.currentConfig };
        const mergeRemap = {};
        for (const [target, sources] of this.mergeHistory) for (const src of sources) mergeRemap[src] = target;
        const baselinePalette = this.proxyEngine._baselineState ? this.proxyEngine._baselineState.palette.map(c => ({ ...c })) : palette;
        return { width: this.imageWidth, height: this.imageHeight, resolution: this.imageResolution, dna: this.imageDNA, ...config, activeArchetypeId: this.state.activeArchetypeId, palette, separationPalette: baselinePalette, paletteOverrides: Object.fromEntries(this.paletteOverrides), mergeRemap: Object.keys(mergeRemap).length > 0 ? mergeRemap : null, generatedConfig: this.currentConfig };
    }

    calculateCurrentAccuracy() {
        const proxy = this.proxyEngine;
        if (!proxy || !proxy.proxyBuffer || !proxy.separationState) return null;
        const { palette, colorIndices, width, height } = proxy.separationState;
        return Reveal.RevelationError.meanDeltaE16(proxy.proxyBuffer, colorIndices, palette, width * height);
    }

    calculateCurrentEdgeSurvival() {
        const proxy = this.proxyEngine;
        if (!proxy || !proxy.proxyBuffer || !proxy.separationState) return null;
        const { colorIndices, width, height } = proxy.separationState;
        const result = Reveal.RevelationError.edgeSurvival16(proxy.proxyBuffer, colorIndices, width, height);
        return result.edgeSurvival;
    }

    calculateDNAFidelity() {
        if (!this.imageDNA || !this.proxyEngine || !this.proxyEngine.separationState) return null;
        const sep = this.proxyEngine.separationState;
        if (!sep.colorIndices || !sep.palette) return null;
        return Reveal.DNAFidelity.fromIndices(this.imageDNA, sep.colorIndices, sep.palette, sep.width, sep.height);
    }

    getArchetypeDeltaE(archetypeId) {
        const id = archetypeId || this.state.activeArchetypeId;
        return this._scoring.getArchetypeDeltaE(id) || null;
    }

    getArchetypeSortScore(archetypeId) {
        const id = archetypeId || this.state.activeArchetypeId;
        const all = this._scoring.allScores;
        if (!all) return null;
        const entry = all.find(s => s.id === id);
        return entry && entry.sortScore != null ? entry.sortScore : null;
    }

    getSeparationState() {
        if (!this.proxyEngine || !this.proxyEngine.separationState) return null;
        return this.proxyEngine.separationState;
    }

    getState() {
        return Object.freeze({ ...this.state });
    }

    getMechanicalKnobs() {
        return Reveal.engines.ParameterGenerator.extractMechanicalKnobs(this.state);
    }

    getDNA() {
        return this.imageDNA;
    }

    getPreview() {
        return this.previewBuffer;
    }

    getOriginalPreviewBuffer() {
        if (!this.proxyEngine) return null;
        return this.proxyEngine.getOriginalPreviewRGBA();
    }

    getSuggestedColors() {
        return this._suggestions.getSuggestedColors();
    }

    get checkedSuggestions() {
        return this._suggestions.checkedSuggestions;
    }

    addCheckedSuggestion(labColor) {
        this._suggestions.addCheckedSuggestion(labColor);
    }

    removeCheckedSuggestion(labColor) {
        this._suggestions.removeCheckedSuggestion(labColor);
    }

    isSuggestionChecked(labColor) {
        return this._suggestions.isSuggestionChecked(labColor);
    }

    generateSuggestionGhostPreview(labColor, mode = 'integrated') {
        return this._suggestions.generateSuggestionGhostPreview(labColor, mode);
    }

    setSuggestionGhost(labColor, mode = 'integrated') {
        this._suggestions.setSuggestionGhost(labColor, mode);
    }

    getDocumentCoords(proxyX, proxyY) {
        const proxyW = this.proxyEngine ? this.proxyEngine.separationState.width : this.imageWidth;
        const proxyH = this.proxyEngine ? this.proxyEngine.separationState.height : this.imageHeight;
        const scaleX = this.originalWidth / proxyW;
        const scaleY = this.originalHeight / proxyH;
        return { x: Math.round(proxyX * scaleX), y: Math.round(proxyY * scaleY) };
    }

    getPalette() {
        return this._paletteSurgery.buildOverriddenPalette();
    }

    // Cache the user's controls (knobs + palette surgery) for this engine so they
    // round-trip on swap-out / swap-in. The posterization result itself is NOT
    // cached — every swap-in recomputes it fresh via PipelineEngine, then writes
    // it into both proxyEngine.separationState and proxyEngine._baselineState
    // (see _installPosterizationResult).
    _snapshotArchetypeState(id) {
        if (!id) return;
        const knobs = {};
        for (const key of ALL_KNOBS) {
            if (SESSION_KNOBS.has(key)) continue;
            knobs[key] = this.state[key];
        }
        this._archetypeStateCache.set(id, {
            knobs,
            ...this._paletteSurgery.snapshot()
        });
    }

    /**
     * Install a fresh PipelineEngine.execute result into the proxy as BOTH
     * the live separationState AND the clean baseline. Without writing
     * _baselineState, the next updateProxy(knobs) call would restore from
     * the previous engine's baseline and silently throw away this engine's
     * result. This is the "every swap is a fresh posterize" invariant.
     *
     * @private
     * @param {Object} pipelineRes - {palette, assignments, metadata} from PipelineEngine
     * @param {number} proxyW
     * @param {number} proxyH
     * @returns {Object} { rgbPalette, masks } for callers that need them
     */
    _installPosterizationResult(pipelineRes, proxyW, proxyH) {
        const palette = pipelineRes.palette;
        const colorIndices = pipelineRes.assignments;
        const rgbPalette = palette.map(c => Reveal.LabEncoding.labToRgbD50(c));
        const masks = palette.map((_, i) => Reveal.generateMask(colorIndices, i, proxyW, proxyH));
        const distanceMetric = (this.currentConfig && this.currentConfig.distanceMetric) || 'cie76';
        const metadata = { ...(pipelineRes.metadata || {}) };

        // Live state (mutated by knobs/surgery during the user's time on this card).
        this.proxyEngine.separationState = {
            palette,
            rgbPalette,
            colorIndices,
            masks,
            width: proxyW,
            height: proxyH,
            distanceMetric,
            metadata
        };

        // Clean baseline that updateProxy() restores from before each knob pass.
        // Deep-copied so subsequent mutations to separationState don't leak in.
        this.proxyEngine._baselineState = {
            palette: palette.map(c => ({ ...c })),
            rgbPalette: rgbPalette.map(c => (typeof c === 'string' ? c : { ...c })),
            colorIndices: new Uint8Array(colorIndices),
            masks: masks.map(m => new Uint8Array(m)),
            width: proxyW,
            height: proxyH,
            distanceMetric,
            metadata: { ...metadata }
        };

        return { rgbPalette, masks };
    }

    _restoreArchetypeState(id) {
        const cached = id ? this._archetypeStateCache.get(id) : null;
        if (!cached) return false;
        for (const key of ALL_KNOBS) {
            if (cached.knobs[key] !== undefined) {
                this.state[key] = cached.knobs[key];
                if (this.currentConfig) this.currentConfig[key] = cached.knobs[key];
            }
        }
        this._paletteSurgery.restore({ paletteOverrides: cached.paletteOverrides, mergeHistory: cached.mergeHistory, deletedColors: cached.deletedColors, addedColors: cached.addedColors });
        this.state.isKnobsCustomized = false;
        if (this._archetypeDefaults) {
            for (const k of ALL_KNOBS) if (this.state[k] !== this._archetypeDefaults[k]) { this.state.isKnobsCustomized = true; break; }
        }
        return true;
    }

    isCustomized() {
        return this.state.isKnobsCustomized || this._paletteSurgery.hasEdits();
    }

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

    _emitPreviewUpdated(result) {
        const accuracyDeltaE = this.calculateCurrentAccuracy();
        const dnaFidelity = this.calculateDNAFidelity();
        this.emit('previewUpdated', { previewBuffer: result.previewBuffer, palette: result.palette, activeColorCount: this._countActiveColors(), elapsedMs: result.elapsedMs, accuracyDeltaE, dnaFidelity });
    }

    _applyConfigToState(config) {
        for (const [key, val] of Object.entries(MECHANICAL_KNOB_DEFAULTS)) {
            const effective = config[key] !== undefined ? config[key] : val;
            this.state[key] = effective;
            config[key] = effective;
        }
        for (const [key, val] of Object.entries(PRODUCTION_KNOB_DEFAULTS)) {
            this.state[key] = val;
            config[key] = val;
        }
        if (config.targetColorsSlider !== undefined) this.state.targetColors = config.targetColorsSlider;
        else if (config.targetColors !== undefined) this.state.targetColors = config.targetColors;
        for (const key of ALL_KNOBS) {
            if (key === 'targetColors') continue;
            if (config[key] !== undefined) this.state[key] = config[key];
        }
        this._archetypeDefaults = {};
        for (const k of ALL_KNOBS) this._archetypeDefaults[k] = this.state[k];
        this.state.isKnobsCustomized = false;
    }

    _rebuildConfigFromState() {
        if (!this.currentConfig) return;
        for (const key of ALL_KNOBS) if (this.state[key] !== undefined) this.currentConfig[key] = this.state[key];
        if (this.state.targetColors) this.currentConfig.targetColorsSlider = this.state.targetColors;
    }

    getInitialArchetypeId() { return this.state.initialArchetypeId; }

    async resetArchetype() { if (this.state.initialArchetypeId) await this.swapArchetype(this.state.initialArchetypeId); }
}

module.exports = SessionState;
