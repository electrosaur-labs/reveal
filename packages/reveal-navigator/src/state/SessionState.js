/**
 * SessionState - Centralized state coordinator for Navigator UI
 *
 * Bridges the reactive 512px proxy preview ("Navigation" phase)
 * with final high-fidelity production render.
 */

const EventEmitter = require('./EventEmitter');
const Reveal = require('@electrosaur-labs/core');
const PaletteSurgeryManager = require('./PaletteSurgeryManager');
const ScoringManager = require('./ScoringManager');
const SuggestionManager = require('./SuggestionManager');
const { DIM_COLOR } = require('../utils/pixelProcessing');
const { consolidatePaletteCoverage } = require('../utils/paletteCoverage');

const logger = Reveal.logger;

// Import canonical config categories and knob defaults from core.
const { CONFIG_CATEGORIES, KNOB_DEFAULTS } = Reveal.engines.ParameterGenerator;

const MECHANICAL_KNOBS = new Set(CONFIG_CATEGORIES.MECHANICAL);
const PRODUCTION_KNOBS = new Set(CONFIG_CATEGORIES.PRODUCTION);
const SESSION_KNOBS = new Set([...PRODUCTION_KNOBS]);
const MECHANICAL_KNOB_DEFAULTS = KNOB_DEFAULTS.MECHANICAL;
const PRODUCTION_KNOB_DEFAULTS = KNOB_DEFAULTS.PRODUCTION;

// Parameters that require full re-posterization (slow path).
const STRUCTURAL_PARAMS = new Set([...CONFIG_CATEGORIES.STRUCTURAL]);

// Union of all user-facing knobs for snapshots.
const ALL_KNOBS = new Set([
    ...MECHANICAL_KNOBS, ...PRODUCTION_KNOBS, ...STRUCTURAL_PARAMS, 'meshSize'
]);

const DEBOUNCE_MS = 50;

class SessionState extends EventEmitter {

    constructor() {
        super();

        this.state = {
            activeArchetypeId: null,
            isArchetypeDirty: false,
            trapSize: 2,
            meshSize: 355,
            blackSnap: false,
            blackSnapLMax: Reveal.BlackSnap.DEFAULT_L_MAX,
            isProcessing: false,
            productionRenderPending: false,
            proxyBufferReady: false,
            isKnobsCustomized: false,
            highlightColorIndex: -1
        };

        this._paletteSurgery = new PaletteSurgeryManager();
        this._scoring = new ScoringManager();
        this._scoring.on('archetypeScored', data => this.emit('archetypeScored', data));
        this._scoring.on('scoringComplete', data => this.emit('scoringComplete', data));

        this._suggestions = new SuggestionManager();
        this._suggestions.on('ghostChanged', data => {
            this.state.highlightColorIndex = -2;
            this.emit('highlightChanged', data);
        });

        this._proxyEngine = null;
        this.currentConfig = null;
        this.previewBuffer = null;
        this.imageDNA = null;
        this.imageWidth = 0;
        this.imageHeight = 0;
        // Deliberately not defaulted — the real value must come from the
        // document (PhotoshopBridge.getDocumentInfo() reads doc.resolution
        // directly, no fallback). null means "no document loaded yet"; any
        // code that reads this before a document is loaded is a bug and
        // should fail loudly (NaN/null propagating), not silently use a
        // guessed DPI.
        this.imageResolution = null;
        this.originalWidth = 0;
        this.originalHeight = 0;
        this.baselineColorCount = 0;

        this._archetypeDefaults = null;
        this._archetypeStateCache = new Map();
        this._debounceTimer = null;

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
    /** Genuine overrides only -- excludes paletteOverrides' merge-compat entries. */
    get rawOverrides() { return this._paletteSurgery.rawOverrides; }
    get mergeHistory() { return this._paletteSurgery.mergeHistory; }
    get deletedColors() { return this._paletteSurgery.deletedColors; }
    get addedColors() { return this._paletteSurgery.addedColors; }

    /** Set of displayIndices that are the SOURCE of some merge (dead, absorbed into their target). */
    _mergeSourceIndices() {
        const sources = new Set();
        for (const srcs of this.mergeHistory.values()) for (const s of srcs) sources.add(s);
        return sources;
    }

    get ghostLabColor() { return this._suggestions.ghostLabColor; }
    get ghostMode() { return this._suggestions.ghostMode; }

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
        this._sourceLabPixels = null;
        this._proxyTargetSize = 1000;
        this.imageWidth = 0;
        this.imageHeight = 0;
        this.imageResolution = null; // see constructor comment
        this.originalWidth = 0;
        this.originalHeight = 0;
        this._archetypeDefaults = null;
        this.baselineColorCount = 0;
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
        this.state.trapSize = 2;
        this.state.meshSize = 355;
        this.state.blackSnap = false;
        this.state.blackSnapLMax = Reveal.BlackSnap.DEFAULT_L_MAX;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    async loadImage(labPixels, width, height, originalWidth, originalHeight) {
        if (this._loadInFlight) throw new Error('Load in progress');
        this._loadInFlight = true;
        try {
            return await this._loadImageImpl(labPixels, width, height, originalWidth, originalHeight);
        } finally {
            this._loadInFlight = false;
        }
    }

    /** @private */
    async _loadImageImpl(labPixels, width, height, originalWidth, originalHeight) {
        // Black snap (opt-in, session-level): must run ONCE, here, before
        // DNA/proxy/anything else touches labPixels \u2014 not as a reactive knob.
        // DNA and the proxy are both derived from this same buffer below, and
        // ProductionWorker re-applies the identical transform to its own
        // full-res read (see exportProductionConfig) so preview and commit
        // can't silently disagree the way the mesh-dpi mismatch once did.
        if (this.state.blackSnap) {
            const snapResult = Reveal.BlackSnap.applyBlackSnap(labPixels, width, height, {
                dpi: this.imageResolution,
                lMax: this.state.blackSnapLMax
            });
            logger.log(`[SessionState] Black snap: ${snapResult.snappedPixels} px (${snapResult.snappedPercent.toFixed(2)}%), radius=${snapResult.radiusPx}px, lMax=${this.state.blackSnapLMax}`);
        }

        this._sourceLabPixels = labPixels;
        this.imageWidth = width;
        this.imageHeight = height;
        this.originalWidth = originalWidth || width;
        this.originalHeight = originalHeight || height;
        this._paletteSurgery.reset();
        this._archetypeStateCache.clear();

        this.emit('progress', { label: 'Analyzing image DNA\u2026', percent: 35 });
        await new Promise(r => setTimeout(r, 20)); // yield

        const dnaGen = new Reveal.DNAGenerator();
        this.imageDNA = dnaGen.generate(labPixels, width, height, { bitDepth: 16 });
        this.emit('dnaReady', this.imageDNA);

        this.emit('progress', { label: 'Initializing navigator\u2026', percent: 55 });
        await new Promise(r => setTimeout(r, 20)); // yield
        
        this._chameleonConfig = Reveal.generateConfigurationMk2(this.imageDNA);
        this._salamanderConfig = Reveal.generateConfigurationSalamander(this.imageDNA);

        const archetypes = Reveal.ArchetypeLoader.loadArchetypes();
        const mapper = new Reveal.ArchetypeMapper(archetypes);
        const topMatch = mapper.getBestMatch(this.imageDNA);

        this.currentConfig = Reveal.generateConfiguration(this.imageDNA, { manualArchetypeId: topMatch.id });
        // Not an archetype/reactive knob — set once here and left alone by
        // _rebuildConfigFromState (blackSnap/blackSnapLMax aren't in
        // ALL_KNOBS), so they carry unchanged into exportProductionConfig()
        // for the rest of the session regardless of archetype swaps.
        this.currentConfig.blackSnap = this.state.blackSnap;
        this.currentConfig.blackSnapLMax = this.state.blackSnapLMax;
        this._applyConfigToState(this.currentConfig);
        this.state.activeArchetypeId = topMatch.id;
        this.state.initialArchetypeId = topMatch.id;

        this.proxyEngine = new Reveal.ProxyEngine();

        this.emit('progress', { label: 'Initializing proxy\u2026', percent: 65 });
        await new Promise(r => setTimeout(r, 20));

        const progressCb = (label, percent) => this.emit('progress', { label, percent });

        const proxyResult = await this.proxyEngine.initializeProxy(labPixels, width, height, this.currentConfig, progressCb);
        this.baselineColorCount = proxyResult.palette.length;

        this._paletteSurgery.initialize(this.proxyEngine);

        this.emit('proxyReady', proxyResult);
        this.emit('progress', { label: 'Applying knobs\u2026', percent: 85 });
        await new Promise(r => setTimeout(r, 20));

        const knobResult = await this.proxyEngine.updateProxy(this.getMechanicalKnobs(), progressCb);
        this.previewBuffer = knobResult.previewBuffer;
        this.state.proxyBufferReady = true;
        this.state.isProcessing = false;

        this._scoring.initialize(this.proxyEngine, this.imageDNA, this._chameleonConfig, this._salamanderConfig);
        this._scoring.setArchetypeDeltaE('dynamic_interpolator', this.calculateCurrentAccuracy());

        const distilledConfig = Reveal.generateConfigurationDistilled(this.imageDNA);
        const distilledQuality = await this.proxyEngine.getPaletteWithQuality(distilledConfig, this.getMechanicalKnobs());
        this._scoring.setArchetypeDeltaE('distilled', distilledQuality.meanDeltaE);

        const salamanderConfig = Reveal.generateConfigurationSalamander(this.imageDNA);
        const salamanderQuality = await this.proxyEngine.getPaletteWithQuality(salamanderConfig, this.getMechanicalKnobs());
        this._scoring.setArchetypeDeltaE('salamander', salamanderQuality.meanDeltaE);

        this._emitPreviewUpdated(knobResult);

        const allScores = this._scoring.getAllArchetypeScores();
        const eagerSet = this._scoring.selectEagerSet(allScores);
        this.emit('carouselReady', { scores: allScores, eagerSet, topMatchId: topMatch.id });
        this._scoring.scoreArchetypes(allScores, topMatch.id, this._scoring.scoringGeneration, eagerSet, this.getMechanicalKnobs());

        return proxyResult;
    }

    // ─── Knob Reset ─────────────────────────────────────────

    resetKnob(key) {
        if (!this._archetypeDefaults || this._archetypeDefaults[key] === undefined) return;
        this.updateParameter(key, this._archetypeDefaults[key]);
    }

    resetToDefaults() {
        if (!this._archetypeDefaults) return;
        for (const key of ALL_KNOBS) {
            this.state[key] = this._archetypeDefaults[key];
            if (this.currentConfig) this.currentConfig[key] = this._archetypeDefaults[key];
        }
        this._paletteSurgery.clearEdits();
        this._suggestions.clearForSwap();
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

    getKnobDefault(key) {
        if (!this._archetypeDefaults) return null;
        const v = this._archetypeDefaults[key];
        return v !== undefined ? v : null;
    }

    // ─── Parameter Updates (Reactive Loop) ───────────────────

    confirmStructuralChange() {
        const pending = this._pendingStructuralChange;
        if (!pending) return;
        this._pendingStructuralChange = null;
        this._structuralChangeConfirmed = true;
        if (pending.key === 'proxyResolution') {
            this.reinitializeProxy();
        } else {
            this.updateParameter(pending.key, pending.value);
        }
    }

    cancelStructuralChange() {
        const pending = this._pendingStructuralChange;
        if (!pending) return;
        this._pendingStructuralChange = null;
        if (pending.key !== 'proxyResolution') {
            this.emit('revertParameter', { key: pending.key, value: this.state[pending.key] });
        }
    }

    updateParameter(key, value) {
        if (this.state[key] === value) return;

        if ((STRUCTURAL_PARAMS.has(key) || key === 'meshSize') && this._paletteSurgery.hasEdits()) {
            if (!this._structuralChangeConfirmed) {
                this._pendingStructuralChange = { key, value };
                this.emit('confirmStructuralChange', { key, value });
                return;
            }
            this._structuralChangeConfirmed = false;
        }

        this.state[key] = value;
        if (STRUCTURAL_PARAMS.has(key)) this.state.isArchetypeDirty = true;

        if (ALL_KNOBS.has(key) && this._archetypeDefaults) {
            this.state.isKnobsCustomized = [...ALL_KNOBS].some(k => this.state[k] !== this._archetypeDefaults[k]);
            this.emit('knobsCustomizedChanged', { customized: this.state.isKnobsCustomized });
        }

        this.emit('parameterChanged', { key, value });
        if (PRODUCTION_KNOBS.has(key) && !STRUCTURAL_PARAMS.has(key)) return;
        this._scheduleProxyUpdate();
    }

    /** @private */
    _scheduleProxyUpdate() {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            this.triggerProxyUpdate();
        }, DEBOUNCE_MS);
    }

    async triggerProxyUpdate() {
        if (!this.proxyEngine) return null;
        if (this._updateInFlight) { this._updateQueued = true; return null; }
        this._updateInFlight = true;
        this.state.isProcessing = true;
        this.emit('processingStart');

        try {
            let result;
            if (this.state.isArchetypeDirty) {
                this._rebuildConfigFromState();
                this._paletteSurgery.reset();
                this._suggestions.clearForReposterize();
                this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
                result = await this.proxyEngine.rePosterize(this.currentConfig);
                this.state.isArchetypeDirty = false;
                this.baselineColorCount = result.palette.length;
                this._paletteSurgery.initialize(this.proxyEngine);
                const id = this.state.activeArchetypeId;
                if (id) this._archetypeStateCache.delete(id);
            }

            const updateParams = { ...this.getMechanicalKnobs() };
            if (this._paletteSurgery.hasEdits()) {
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
            logger.log(`[SessionState] Update FAILED: ${err.message}`);
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

    // ─── Archetype Navigation ────────────────────────────────

    async swapArchetype(archetypeId, { skipSurgeryRestore = false, forceFreshBaseline = false } = {}) {
        if (!this.imageDNA || !this.proxyEngine) throw new Error('Not initialized');
        if (this._swapInFlight) { this._swapQueued = archetypeId; return null; }
        this._swapInFlight = true;
        this._scoring.cancelScoring();

        try {
            this._snapshotArchetypeState(this.state.activeArchetypeId);

            if (archetypeId === 'dynamic_interpolator') this.currentConfig = Reveal.generateConfigurationMk2(this.imageDNA);
            else if (archetypeId === 'distilled') this.currentConfig = Reveal.generateConfigurationDistilled(this.imageDNA);
            else if (archetypeId === 'salamander') this.currentConfig = Reveal.generateConfigurationSalamander(this.imageDNA);
            else this.currentConfig = Reveal.generateConfiguration(this.imageDNA, { manualArchetypeId: archetypeId });

            this._applyConfigToState(this.currentConfig);
            this.state.activeArchetypeId = archetypeId;
            this.state.isArchetypeDirty = false;

            this._paletteSurgery.reset();
            this._suggestions.clearForSwap();
            this.state.highlightColorIndex = -1;
            this.emit('highlightChanged', { colorIndex: -1 });

            const cached = this._archetypeStateCache.get(archetypeId);
            this.emit('archetypeChanged', { archetypeId, config: this.currentConfig });

            let result;
            if (cached && cached.baseline && !forceFreshBaseline) {
                result = this.proxyEngine.restoreBaselineSnapshot(cached.baseline, this.currentConfig);
                this.baselineColorCount = result.palette.length;
                this._paletteSurgery.initialize(this.proxyEngine);
            } else {
                if (cached && cached.knobs) {
                    for (const key of STRUCTURAL_PARAMS) if (cached.knobs[key] !== undefined) {
                        this.state[key] = cached.knobs[key];
                        this.currentConfig[key] = cached.knobs[key];
                    }
                }
                result = await this.proxyEngine.rePosterize(this.currentConfig);
                this.baselineColorCount = result.palette.length;
                this._paletteSurgery.initialize(this.proxyEngine);
            }

            this._restoreArchetypeState(archetypeId, { skipSurgeryRestore });
            this.emit('configChanged', this.currentConfig);
            this.emit('knobsCustomizedChanged', { customized: this.state.isKnobsCustomized });
            this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });

            const updateParams = { ...this.getMechanicalKnobs() };
            if (this._paletteSurgery.hasEdits()) updateParams.paletteOverride = this._paletteSurgery.buildOverriddenPalette();
            const knobResult = await this.proxyEngine.updateProxy(updateParams);

            this.previewBuffer = knobResult.previewBuffer;
            this.state.proxyBufferReady = true;
            this.state.isProcessing = false;

            this._emitPreviewUpdated({ ...result, previewBuffer: knobResult.previewBuffer, elapsedMs: result.elapsedMs + knobResult.elapsedMs });
            return result;
        } finally {
            this._swapInFlight = false;
            if (this._swapQueued) {
                const q = this._swapQueued; this._swapQueued = null;
                this.swapArchetype(q);
            }
        }
    }

    async reinitializeProxy() {
        if (!this._sourceLabPixels || !this.proxyEngine || !this.currentConfig) throw new Error('Not loaded');

        if (this._paletteSurgery.hasEdits() && !this._structuralChangeConfirmed) {
            this._pendingStructuralChange = { key: 'proxyResolution' };
            this.emit('confirmStructuralChange', { key: 'proxyResolution' });
            return;
        }
        this._structuralChangeConfirmed = false;

        this._scoring.cancelScoring();
        this._archetypeStateCache.clear();
        this._paletteSurgery.reset();

        this._proxyTargetSize = Reveal.ProxyEngine.PROXY_TARGET_SIZE;
        this.proxyEngine = new Reveal.ProxyEngine();
        const proxyResult = await this.proxyEngine.initializeProxy(this._sourceLabPixels, this.imageWidth, this.imageHeight, this.currentConfig);
        this.baselineColorCount = proxyResult.palette.length;
        this._paletteSurgery.initialize(this.proxyEngine);

        const knobResult = await this.proxyEngine.updateProxy(this.getMechanicalKnobs());
        this.previewBuffer = knobResult.previewBuffer;
        this._scoring.initialize(this.proxyEngine, this.imageDNA, this._chameleonConfig, this._salamanderConfig);

        this.emit('proxyReady', { previewBuffer: knobResult.previewBuffer, palette: knobResult.palette, dimensions: proxyResult.dimensions, elapsedMs: proxyResult.elapsedMs + knobResult.elapsedMs });
    }

    getAllArchetypeScores() { return this._scoring.getAllArchetypeScores(); }

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

        // Resolve through the merge graph before comparing. Merges never
        // touch the proxy's own colorIndices/masks -- updateProxy deliberately
        // skips re-separation ("plate assignments stay fixed, only the
        // palette updates") -- so a pixel belonging to a color that's since
        // been merged into colorIndex still carries its OLD raw index.
        // Without resolving, solo view for a color that has absorbed
        // another only ever showed its own original area, never the area
        // it absorbed.
        const sourceToTarget = new Map();
        for (const [target, sources] of this.mergeHistory) {
            for (const src of sources) sourceToTarget.set(src, target);
        }
        const resolve = (idx) => sourceToTarget.has(idx) ? sourceToTarget.get(idx) : idx;
        const resolvedTarget = resolve(colorIndex);

        const pixelCount = width * height;
        const rgba = new Uint8ClampedArray(pixelCount * 4);

        for (let i = 0; i < pixelCount; i++) {
            const ci = colorIndices[i];
            const off = i * 4;
            if (resolve(ci) === resolvedTarget) {
                const c = rgbPalette[ci];
                rgba[off] = c.r; rgba[off + 1] = c.g; rgba[off + 2] = c.b;
            } else {
                rgba[off] = DIM_COLOR; rgba[off + 1] = DIM_COLOR; rgba[off + 2] = DIM_COLOR;
            }
            rgba[off + 3] = 255;
        }
        return rgba;
    }

    // ─── Palette Surgery ─────────────────────────────────────

    async overridePaletteColor(colorIndex, newLabColor) {
        this._scoring.cancelScoring();
        this._paletteSurgery.setOverride(colorIndex, newLabColor);
        const result = await this.triggerProxyUpdate();
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
        return result;
    }

    async revertPaletteColor(colorIndex) {
        this._scoring.cancelScoring();
        if (this._paletteSurgery.revertOverride(colorIndex)) {
            const result = await this.triggerProxyUpdate();
            this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
            return result;
        }
        return null;
    }

    async deletePaletteColor(colorIndex) {
        this._scoring.cancelScoring();
        const metric = this.currentConfig?.distanceMetric || 'cie76';
        const targetIndex = this._paletteSurgery.findMergeTarget(colorIndex, metric);

        this._paletteSurgery.markDeleted(colorIndex);
        this._paletteSurgery.recordMerge(colorIndex, targetIndex);

        const result = await this.triggerProxyUpdate();
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
        return result;
    }

    async mergePaletteColors(sourceIndex, targetIndex) {
        this._scoring.cancelScoring();
        this._paletteSurgery.recordMerge(sourceIndex, targetIndex);
        const result = await this.triggerProxyUpdate();
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
        return result;
    }

    async addPaletteColor(labColor) {
        this._scoring.cancelScoring();
        const palette = this.proxyEngine._baselineState.palette;
        if (palette.length >= 20) return null;

        await this.proxyEngine.addColorAndReseparate(labColor);
        this.baselineColorCount = this.proxyEngine._baselineState.palette.length;
        // trackAddedColor() already surgically appends the new node to the
        // EXISTING graph (PaletteGraph.addNode) -- do not follow it with
        // initialize(), which calls reset() and rebuilds the whole graph
        // from scratch, discarding every prior merge/delete/override (and,
        // on top of that, re-creating the just-added color as a plain
        // 'active' baseline node instead of an 'added' one, losing its own
        // removability too).
        this._paletteSurgery.trackAddedColor(this.baselineColorCount - 1, labColor);

        const result = await this.triggerProxyUpdate();
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
        return result;
    }

    async removeAddedColor(colorIndex) {
        if (!this.addedColors.has(colorIndex)) return null;
        this._scoring.cancelScoring();
        // Same reasoning as addPaletteColor: removeTrackedColor() already
        // surgically removes the node from the EXISTING graph
        // (PaletteGraph.removeAddedNode) -- no initialize()/reset() needed.
        this._paletteSurgery.removeTrackedColor(colorIndex);
        const result = await this.proxyEngine.removeColorAndReseparate(colorIndex);
        this.baselineColorCount = this.proxyEngine._baselineState.palette.length;
        const finalResult = await this.triggerProxyUpdate();
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
        return finalResult;
    }

    // ─── Production Export ────────────────────────────────────

    buildManifest(productionResult) {
        const PhotoshopBridge = require('../bridge/PhotoshopBridge');
        const docInfo = PhotoshopBridge.getDocumentInfo();
        let archetypeSection = { id: null, name: null, score: 0, breakdown: {}, rankings: [] };
        const activeId = this.state.activeArchetypeId;
        if (activeId) {
            const allScores = this.getAllArchetypeScores();
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
            archetypeSection.rankings = allScores.map(s => ({
                id: s.id, name: nameMap[s.id] || s.id, score: Math.round(s.score * 100) / 100, breakdown: s.breakdown || {}
            }));
        }

        const basePalette = this._paletteSurgery.buildOverriddenPalette();
        const palette = this._suggestions.checkedSuggestions.length > 0
            ? [...basePalette, ...this._suggestions.checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
            : basePalette;
        const sep = this.proxyEngine?.separationState;

        // Resolve merged/deleted slots to their final target BEFORE counting
        // -- without this, a color that absorbed another (or was itself
        // absorbed) shows up twice in the manifest, with its pixel count
        // split between the two entries instead of combined into the
        // surviving one ("why is black appearing twice").
        let pixelCounts = null;
        let survivingIndices = palette ? palette.map((_, i) => i) : [];
        if (sep?.colorIndices && palette) {
            const consolidated = consolidatePaletteCoverage(sep.colorIndices, palette.length, this.mergeHistory);
            pixelCounts = consolidated.pixelCounts;
            survivingIndices = consolidated.survivingIndices;
        }
        const totalPixels = sep ? sep.width * sep.height : 1;
        const paletteSection = survivingIndices.map(i => {
            const c = palette[i];
            const rgb = Reveal.labToRgbD50({ L: c.L, a: c.a, b: c.b });
            const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
            return {
                L: Math.round(c.L * 10) / 10, a: Math.round(c.a * 10) / 10, b: Math.round(c.b * 10) / 10,
                hex: `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toUpperCase(),
                coverage: pixelCounts ? ((pixelCounts[i] / totalPixels) * 100).toFixed(2) + '%' : 'n/a'
            };
        });

        let configSection = {};
        if (this.currentConfig) {
            const { meta, preprocessing, rangeClamp, ...rest } = this.currentConfig;
            configSection = rest;
            if (meta) { configSection.archetypeId = meta.archetypeId; configSection.matchScore = meta.matchScore; }
        }

        const surgery = { overrides: {}, merges: {}, deletions: [...this.deletedColors], added: {} };
        // Merge sources are excluded here, not just because `merges` below
        // already records the relationship: paletteOverrides synthesizes a
        // "compat" entry for them equal to the TARGET's color (for callers
        // that want a flat per-index color list), which is a frozen
        // snapshot, not a real override of the source's own identity.
        const mergeSources = this._mergeSourceIndices();
        for (const [idx, color] of this.rawOverrides) {
            if (this.deletedColors.has(idx) || mergeSources.has(idx)) continue;
            surgery.overrides[String(idx)] = { L: Math.round(color.L * 10) / 10, a: Math.round(color.a * 10) / 10, b: Math.round(color.b * 10) / 10 };
        }
        for (const [target, sources] of this.mergeHistory) surgery.merges[String(target)] = [...sources];
        // Added colors (the "+" button) are user-picked values the archetype
        // can't regenerate on its own -- their Lab already appears in the
        // palette list, but nothing flagged WHICH slots were manual adds
        // vs. natural quantization output, which matters for hand-
        // reproducing a separation (2026-11-12).
        for (const idx of this.addedColors) {
            const c = palette[idx];
            if (c) surgery.added[String(idx)] = { L: Math.round(c.L * 10) / 10, a: Math.round(c.a * 10) / 10, b: Math.round(c.b * 10) / 10 };
        }

        return {
            meta: { generator: 'Reveal Navigator v1.0.0', timestamp: new Date().toISOString(), filename: docInfo ? docInfo.name : 'unknown', width: docInfo ? docInfo.width : this.originalWidth, height: docInfo ? docInfo.height : this.originalHeight, bitDepth: 16 },
            archetype: archetypeSection, config: configSection, knobs: (() => { const k = {}; for (const key of ALL_KNOBS) if (this.state[key] !== undefined) k[key] = this.state[key]; return k; })(),
            surgery, palette: paletteSection, dna: this.imageDNA || {},
            metrics: { avgDeltaE: this.calculateCurrentAccuracy(), layerCount: productionResult ? productionResult.layerCount : 0, elapsedMs: productionResult ? productionResult.elapsedMs : 0 }
        };
    }

    exportProductionConfig() {
        const palette = this._paletteSurgery.buildOverriddenPalette();
        this._rebuildConfigFromState();
        const config = { ...this.currentConfig };
        const mergeRemap = {};
        for (const [target, sources] of this.mergeHistory) for (const src of sources) mergeRemap[src] = target;

        const baselinePalette = this.proxyEngine?._baselineState ? this.proxyEngine._baselineState.palette.map(c => ({ ...c })) : palette;

        // Added colors (the "+" button) have no baseline counterpart, so
        // unlike overrides, including them can't skew the NN search — they
        // just need to BE a candidate at all, or full-res production can
        // never assign a single pixel to them regardless of what the user
        // expects to see. Append in the same position `palette` below uses
        // (right after baseline, before checked suggestions) so colorIndices
        // from mapPixelsToPaletteAsync line up with mergeRemap / labPalette.
        const addedLabColors = [...this.addedColors].sort((a, b) => a - b).map(i => palette[i]);
        const withAdded = addedLabColors.length > 0 ? [...baselinePalette, ...addedLabColors] : baselinePalette;

        const separationPalette = this._suggestions.checkedSuggestions.length > 0
            ? [...withAdded, ...this._suggestions.checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
            : withAdded;

        let consolidationMerges = null;
        if (this.paletteOverrides.size > 0) {
            const EditedSet = new Set(this.paletteOverrides.keys());
            const merges = Reveal.engines.PaletteOps.consolidateNearDuplicates(palette, EditedSet);
            if (Object.keys(merges).length > 0) {
                consolidationMerges = merges;
                for (const [src, tgt] of Object.entries(merges)) mergeRemap[parseInt(src)] = tgt;
            }
        }

        return {
            width: this.imageWidth, height: this.imageHeight, resolution: this.imageResolution, dna: this.imageDNA,
            ...config, activeArchetypeId: this.state.activeArchetypeId,
            palette: this._suggestions.checkedSuggestions.length > 0 ? [...palette, ...this._suggestions.checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))] : palette,
            separationPalette, paletteOverrides: Object.fromEntries(this.paletteOverrides),
            mergeRemap: Object.keys(mergeRemap).length > 0 ? mergeRemap : null, consolidationMerges, generatedConfig: this.currentConfig
        };
    }

    // ─── Save / Load Config ───────────────────────────────────
    //
    // Explicit, user-triggered save/reapply of a separation's settings —
    // distinct from the XMP manifest embedded in the exported PSD (that's
    // passive provenance; this is an active "do the same thing again").
    // Blind replay by design (2026-11-12): no attempt to detect whether
    // the current document is "the same" source — the use case is
    // re-running the same config after fixing something in the source
    // that doesn't change the palette, and it's the user's call whether
    // that's true, not something worth guessing at here.

    /**
     * Serialize the current archetype, knobs, and palette surgery to a
     * plain object suitable for JSON.stringify and later replay via
     * applySavedConfig(). Full (unrounded) precision -- unlike the XMP
     * manifest's palette list, this is for machine replay, not display.
     *
     * @returns {Object}
     */
    exportSavedConfig() {
        const knobs = {};
        for (const key of ALL_KNOBS) if (this.state[key] !== undefined) knobs[key] = this.state[key];

        const basePalette = this._paletteSurgery.buildOverriddenPalette();
        const surgery = { overrides: {}, merges: {}, deletions: [...this.deletedColors], added: {} };
        // Merge sources excluded: paletteOverrides' compat entry for them is
        // a frozen snapshot of the TARGET's color at save time, not a real
        // override of the source's own identity -- replaying it as one
        // corrupts the merged-away swatch's own color (effectiveLab) the
        // next time it's displayed. The merge relationship itself is
        // captured below and is all a replay needs.
        const mergeSources = this._mergeSourceIndices();
        for (const [idx, color] of this.rawOverrides) {
            if (this.deletedColors.has(idx) || mergeSources.has(idx)) continue;
            surgery.overrides[String(idx)] = { L: color.L, a: color.a, b: color.b };
        }
        for (const [target, sources] of this.mergeHistory) surgery.merges[String(target)] = [...sources];
        for (const idx of this.addedColors) {
            const c = basePalette && basePalette[idx];
            if (c) surgery.added[String(idx)] = { L: c.L, a: c.a, b: c.b };
        }

        return {
            formatVersion: 1,
            savedAt: new Date().toISOString(),
            archetypeId: this.state.activeArchetypeId,
            knobs,
            // "Suggested" colors (the hue-gap-rescue ghost picks) are a
            // SEPARATE mechanism from the "+" button -- SuggestionManager
            // tracks them independently and only folds them into the
            // palette at manifest/production export time, never into the
            // live surgery graph, so they'd otherwise be silently dropped
            // by a save/load round trip.
            checkedSuggestions: this._suggestions.checkedSuggestions.map(c => ({ L: c.L, a: c.a, b: c.b })),
            surgery
        };
    }

    /**
     * Replay a config previously produced by exportSavedConfig() onto
     * whatever document is currently loaded. Always swaps to the saved
     * archetype first (even if it's already active) so palette surgery
     * replays onto a guaranteed-clean baseline, same as a fresh archetype
     * pick -- never layered on top of whatever surgery the current
     * session already had.
     *
     * @param {Object} config
     * @returns {Promise<void>}
     */
    async applySavedConfig(config) {
        if (!this.proxyEngine) throw new Error('No document loaded');
        if (!config || typeof config !== 'object') throw new Error('Invalid config');

        if (config.archetypeId) {
            // swapArchetype() normally auto-restores whatever palette surgery
            // is cached for the incoming archetype (interactive back-and-
            // forth) -- including, when the saved archetype is already
            // active, a snapshot-then-restore round trip of the session's
            // OWN current surgery. A replay must land on a clean baseline
            // for the surgery below to apply onto, not whatever the session
            // already had, so suppress that one restore step. Knobs don't
            // need the same treatment: config.knobs (below) always covers
            // every ALL_KNOBS key, so it overwrites anything restored here.
            //
            // forceFreshBaseline matters specifically for added colors: an
            // earlier addPaletteColor() call permanently grows the PROXY
            // ENGINE's own baseline palette (not just graph metadata), so a
            // cached "restore baseline snapshot" for this archetype -- taken
            // while those added colors were still live -- would silently
            // include them already. The surgery replay below then adds them
            // AGAIN on top, producing duplicate colors. Forcing a real
            // rePosterize instead guarantees the baseline reflects only the
            // archetype's own natural output, with nothing added yet.
            await this.swapArchetype(config.archetypeId, { skipSurgeryRestore: true, forceFreshBaseline: true });
        }

        if (config.knobs) {
            for (const [key, value] of Object.entries(config.knobs)) {
                this.updateParameter(key, value);
            }
        }
        // Force the knob changes through now rather than relying on the
        // debounce timer firing on its own after this method returns --
        // callers need an awaitable "fully applied" signal, and any
        // surgery replay below would otherwise race the pending timer.
        if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
        await this.triggerProxyUpdate();

        const surgery = config.surgery || {};

        // Each add/override/merge below triggers its own reseparation+
        // preview update -- suppress the intermediate ones so the preview
        // doesn't visibly flicker through every step, and emit once at
        // the end with the final result instead.
        let lastResult = null;
        this._suppressPreviewEmit = true;
        try {
            // Added colors first, in ascending original-index order, so they
            // land at the same positions they originally did before overrides/
            // merges (which reference those positions) get replayed.
            const addedEntries = Object.entries(surgery.added || {})
                .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10));
            for (const [, lab] of addedEntries) {
                lastResult = await this.addPaletteColor(lab);
            }

            for (const [idxStr, lab] of Object.entries(surgery.overrides || {})) {
                lastResult = await this.overridePaletteColor(parseInt(idxStr, 10), lab);
            }

            // Merges and deletions share the same underlying graph operation
            // (a merge into an exact, recorded target -- no nearest-neighbor
            // search, unlike deletePaletteColor's normal interactive path).
            // A formal delete additionally needs its 'deleted' status flag set
            // for correct dead-swatch styling; a plain drag/shift-click merge
            // does not.
            const deletions = new Set(surgery.deletions || []);
            for (const [targetStr, sources] of Object.entries(surgery.merges || {})) {
                const target = parseInt(targetStr, 10);
                for (const src of sources) {
                    if (deletions.has(src)) this._paletteSurgery.markDeleted(src);
                    lastResult = await this.mergePaletteColors(src, target);
                }
            }
        } finally {
            this._suppressPreviewEmit = false;
        }
        // Checked suggestions: swapArchetype() and the structural-knob
        // replay above both call _suggestions.clearForSwap(), which would
        // wipe these if they were restored any earlier. They don't affect
        // the live proxy/preview (SuggestionManager only folds them into
        // the palette at manifest/production export time), so there's
        // nothing here to await or suppress.
        //
        // Must happen BEFORE _emitPreviewUpdated below, not after: the
        // Navigator UI's suggestions tray only re-renders in response to
        // 'previewUpdated' (PaletteSurgeon has no listener on
        // 'paletteChanged' for it) -- emitting it first meant the UI
        // redrew against an still-empty checkedSuggestions list, then
        // never got told to redraw again once they were actually restored.
        // The underlying data (session.checkedSuggestions) was always
        // correct; nothing ever told the UI to look at it again.
        for (const lab of config.checkedSuggestions || []) {
            this.addCheckedSuggestion(lab);
        }
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });

        // Unconditional, not "if (lastResult)": a saved config with ONLY
        // checked suggestions and no other surgery leaves lastResult null
        // (none of the added/override/merge loops above ever ran), which
        // used to mean 'previewUpdated' never fired at all after this
        // point -- the UI's redraw trigger simply never came, regardless
        // of the reordering above. Falls back to the knobs-flush result
        // already sitting in this.previewBuffer/getPalette() when there
        // was no surgery to produce a fresher one.
        this._emitPreviewUpdated(lastResult || { previewBuffer: this.previewBuffer, palette: this.getPalette(), elapsedMs: 0 });
    }

    // ─── Getters & Helpers ────────────────────────────────────

    getState() { return Object.freeze({ ...this.state }); }
    // this.state never carries a dpi field (it's the reactive per-knob
    // object) — extractMechanicalKnobs would otherwise silently fall back
    // to its own 300dpi default for the LIVE PREVIEW's mesh-aware
    // despeckle, never the real document. imageResolution is the real
    // value (see constructor); merge it in so the fallback is unreachable
    // once a document is loaded.
    getMechanicalKnobs() { return Reveal.engines.ParameterGenerator.extractMechanicalKnobs({ ...this.state, resolution: this.imageResolution }); }
    getPreview() { return this.previewBuffer; }
    getPalette() { return this._paletteSurgery.buildOverriddenPalette(); }
    getDNA() { return this.imageDNA; }

    /**
     * Composite trap expansion zones onto the current preview buffer.
     * Zones are rendered in each ink's RGB color at 70% opacity.
     * Trap size is scaled from full-res points to proxy pixels.
     * Returns null if trap is off, no zones computed, or proxy not ready.
     *
     * @returns {Uint8ClampedArray|null} RGBA buffer with overlay, or null
     */
    generateTrapOverlayBuffer() {
        const sep = this.proxyEngine?.separationState;
        if (!sep?.masks || !sep.palette || !this.previewBuffer) return null;

        const trapSizePts = this.state.trapSize;
        if (!(trapSizePts > 0)) return null;

        // this.previewBuffer existing (checked above) implies a document is
        // loaded, so imageResolution must already be the real value — no
        // fallback. The trailing /72 is the points-per-inch unit constant
        // (1pt = 1/72in), not a DPI guess.
        const fullTrapPx = trapSizePts * this.imageResolution / 72;
        const proxyTrapPx = Math.max(1, Math.round(fullTrapPx * sep.width / this.imageWidth));

        const zoneResult = Reveal.TrapEngine.computeTrapZones(
            sep.masks, sep.palette, sep.width, sep.height, proxyTrapPx
        );
        if (!zoneResult) return null;

        const buf = this.previewBuffer;
        const rgba = new Uint8ClampedArray(buf.length);
        rgba.set(buf);

        // Dim the entire composite so trap zones pop out
        for (let i = 0; i < rgba.length; i += 4) {
            rgba[i]     = Math.round(rgba[i]     * 0.35);
            rgba[i + 1] = Math.round(rgba[i + 1] * 0.35);
            rgba[i + 2] = Math.round(rgba[i + 2] * 0.35);
        }

        // Paint trap zones in full ink color on top of the dimmed composite
        for (let ci = 0; ci < sep.palette.length; ci++) {
            const zone = zoneResult.zones[ci];
            const rgb = sep.rgbPalette?.[ci];
            if (!zone || !rgb) continue;
            for (let p = 0; p < zone.length; p++) {
                if (zone[p] !== 255) continue;
                const off = p * 4;
                rgba[off]     = rgb.r;
                rgba[off + 1] = rgb.g;
                rgba[off + 2] = rgb.b;
            }
        }

        return rgba;
    }
    getSeparationState() { return this.proxyEngine?.separationState; }
    getOriginalPreviewBuffer() { return this.proxyEngine?.getOriginalPreviewRGBA(); }
    getSuggestedColors() { return this._suggestions.getSuggestedColors(); }
    get checkedSuggestions() { return this._suggestions.checkedSuggestions; }
    addCheckedSuggestion(labColor) {
        this._suggestions.addCheckedSuggestion(labColor);
        // 'paletteChanged' is what index.js's Reset-to-Defaults button
        // listens on to un-gray itself -- without this, checking a
        // suggestion left it checked (per isCustomized() below) but the
        // button stayed disabled, with nothing left to ever re-evaluate it.
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
    }
    removeCheckedSuggestion(labColor) {
        this._suggestions.removeCheckedSuggestion(labColor);
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
    }
    isSuggestionChecked(labColor) { return this._suggestions.isSuggestionChecked(labColor); }
    setSuggestionGhost(labColor, mode) { this._suggestions.setSuggestionGhost(labColor, mode); }
    generateSuggestionGhostPreview(labColor, mode) { return this._suggestions.generateSuggestionGhostPreview(labColor, mode); }
    
    getDocumentCoords(proxyX, proxyY) {
        const { width: pw, height: ph } = this.getSeparationState() || { width: this.imageWidth, height: this.imageHeight };
        return { x: Math.round(proxyX * (this.originalWidth / pw)), y: Math.round(proxyY * (this.originalHeight / ph)) };
    }

    calculateCurrentAccuracy() {
        const proxy = this.proxyEngine;
        if (!proxy?.separationState) return null;
        return Reveal.RevelationError.meanDeltaE16(proxy.proxyBuffer, proxy.separationState.colorIndices, proxy.separationState.palette, proxy.separationState.width * proxy.separationState.height);
    }

    calculateCurrentEdgeSurvival() {
        const proxy = this.proxyEngine;
        if (!proxy?.separationState) return null;
        return Reveal.RevelationError.edgeSurvival16(proxy.proxyBuffer, proxy.separationState.colorIndices, proxy.separationState.width, proxy.separationState.height).edgeSurvival;
    }

    calculateDNAFidelity() {
        const sep = this.proxyEngine?.separationState;
        if (!sep?.colorIndices || !this.imageDNA) return null;
        return Reveal.DNAFidelity.fromIndices(this.imageDNA, sep.colorIndices, sep.palette, sep.width, sep.height);
    }

    getArchetypeDeltaE(id) { return this._scoring.getArchetypeDeltaE(id || this.state.activeArchetypeId); }
    getArchetypeSortScore(id) {
        const all = this._scoring.getAllArchetypeScores();
        const entry = all.find(s => s.id === (id || this.state.activeArchetypeId));
        return entry?.sortScore ?? null;
    }

    _snapshotArchetypeState(id) {
        if (!id) return;
        const knobs = {};
        for (const k of ALL_KNOBS) if (!SESSION_KNOBS.has(k)) knobs[k] = this.state[k];
        // Checked ("Suggested") colors are archetype-specific -- they come
        // from THIS archetype's own hue-gap analysis -- so they belong in
        // the same per-archetype cache as knobs/surgery, not as session-
        // wide state. Without this, merely browsing to a different
        // archetype card and back (swapArchetype away then back to the
        // SAME id) permanently lost every checked suggestion, since
        // clearForSwap() empties the live list on every swap and nothing
        // ever restored it.
        this._archetypeStateCache.set(id, {
            knobs,
            baseline: this.proxyEngine?.getBaselineSnapshot(),
            checkedSuggestions: this._suggestions.checkedSuggestions.map(c => ({ ...c })),
            ...this._paletteSurgery.snapshot()
        });
    }

    _restoreArchetypeState(id, { skipSurgeryRestore = false } = {}) {
        const cached = this._archetypeStateCache.get(id);
        if (!cached) return false;
        for (const k of ALL_KNOBS) if (cached.knobs?.[k] !== undefined) {
            this.state[k] = cached.knobs[k];
            if (this.currentConfig) this.currentConfig[k] = cached.knobs[k];
        }
        if (!skipSurgeryRestore) {
            this._paletteSurgery.restore(cached);
            // Same reasoning as palette surgery: a replay (applySavedConfig)
            // wants a clean slate here too, since it replays its own saved
            // checkedSuggestions separately once the archetype swap settles.
            this._suggestions.checkedSuggestions = (cached.checkedSuggestions || []).map(c => ({ ...c }));
        }
        this.state.isKnobsCustomized = !!this._archetypeDefaults && [...ALL_KNOBS].some(k => this.state[k] !== this._archetypeDefaults[k]);
        return true;
    }

    isCustomized() {
        return this.state.isKnobsCustomized || this._paletteSurgery.hasEdits() || this._suggestions.checkedSuggestions.length > 0;
    }

    _emitPreviewUpdated(result) {
        // Swallowed during applySavedConfig's surgery replay -- each
        // added/overridden/merged color would otherwise repaint the
        // preview image on its own, visibly flickering through every
        // intermediate step before landing on the final result.
        if (this._suppressPreviewEmit) return;
        this.emit('previewUpdated', { previewBuffer: result.previewBuffer, palette: result.palette, activeColorCount: this._countActiveColors(), elapsedMs: result.elapsedMs, accuracyDeltaE: this.calculateCurrentAccuracy(), dnaFidelity: this.calculateDNAFidelity() });
    }

    _countActiveColors() {
        const sep = this.proxyEngine?.separationState;
        if (!sep?.colorIndices) return 0;
        const counts = new Uint32Array(sep.palette.length);
        for (let i = 0; i < sep.colorIndices.length; i++) counts[sep.colorIndices[i]]++;
        let active = 0;
        for (let i = 0; i < counts.length; i++) if (counts[i] > 0) active++;
        return active;
    }

    _applyConfigToState(config) {
        for (const [k, v] of Object.entries(MECHANICAL_KNOB_DEFAULTS)) { this.state[k] = config[k] !== undefined ? config[k] : v; config[k] = this.state[k]; }
        for (const [k, v] of Object.entries(PRODUCTION_KNOB_DEFAULTS)) { this.state[k] = v; config[k] = v; }
        if (config.targetColorsSlider !== undefined) this.state.targetColors = config.targetColorsSlider;
        else if (config.targetColors !== undefined) this.state.targetColors = config.targetColors;
        for (const k of ALL_KNOBS) if (k !== 'targetColors' && config[k] !== undefined) this.state[k] = config[k];
        this._archetypeDefaults = {};
        for (const k of ALL_KNOBS) this._archetypeDefaults[k] = this.state[k];
        this.state.isKnobsCustomized = false;
    }

    _rebuildConfigFromState() {
        if (!this.currentConfig) return;
        for (const k of ALL_KNOBS) if (this.state[k] !== undefined) this.currentConfig[k] = this.state[k];
        if (this.state.targetColors) this.currentConfig.targetColorsSlider = this.state.targetColors;
    }
}

module.exports = SessionState;
