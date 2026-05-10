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
            trapSize: 0,
            meshSize: 230,
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
        this.imageResolution = 72;
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
    get mergeHistory() { return this._paletteSurgery.mergeHistory; }
    get deletedColors() { return this._paletteSurgery.deletedColors; }
    get addedColors() { return this._paletteSurgery.addedColors; }

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
        this.imageResolution = 72;
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
        this.state.trapSize = 0;
        this.state.meshSize = 230;
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
        this._applyConfigToState(this.currentConfig);
        this.state.activeArchetypeId = topMatch.id;
        this.state.initialArchetypeId = topMatch.id;

        this.proxyEngine = new Reveal.ProxyEngine();
        
        this.emit('progress', { label: 'Initializing proxy\u2026', percent: 65 });
        await new Promise(r => setTimeout(r, 20)); // yield before expensive posterize
        
        const proxyResult = await this.proxyEngine.initializeProxy(labPixels, width, height, this.currentConfig);
        this.baselineColorCount = proxyResult.palette.length;
        
        this._paletteSurgery.initialize(this.proxyEngine);

        this.emit('proxyReady', proxyResult);
        this.emit('progress', { label: 'Applying knobs\u2026', percent: 85 });
        await new Promise(r => setTimeout(r, 20)); // yield before updateProxy

        const knobResult = await this.proxyEngine.updateProxy(this.getMechanicalKnobs());
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

    getKnobDefault(key) { return this._archetypeDefaults ? this._archetypeDefaults[key] : null; }

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
                this._suggestions.clearForSwap();
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

    async swapArchetype(archetypeId) {
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
            if (cached && cached.baseline) {
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

            this._restoreArchetypeState(archetypeId);
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

        const pixelCount = width * height;
        const rgba = new Uint8ClampedArray(pixelCount * 4);

        for (let i = 0; i < pixelCount; i++) {
            const ci = colorIndices[i];
            const off = i * 4;
            if (ci === colorIndex) {
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
        const { targetIndex, isSuggestion } = this._paletteSurgery.findMergeTarget(colorIndex, metric, this._suggestions.checkedSuggestions);

        this._paletteSurgery.markDeleted(colorIndex);
        if (isSuggestion) {
            const suggestion = this._suggestions.checkedSuggestions[targetIndex - this.baselineColorCount];
            this._paletteSurgery.setOverride(colorIndex, suggestion);
        } else {
            this._paletteSurgery.recordMerge(colorIndex, targetIndex);
        }

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
        this._paletteSurgery.trackAddedColor(this.baselineColorCount - 1, labColor);
        this._paletteSurgery.initialize(this.proxyEngine);

        const result = await this.triggerProxyUpdate();
        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
        return result;
    }

    async removeAddedColor(colorIndex) {
        if (!this.addedColors.has(colorIndex)) return null;
        this._scoring.cancelScoring();
        this._paletteSurgery.removeTrackedColor(colorIndex);
        const result = await this.proxyEngine.removeColorAndReseparate(colorIndex);
        this.baselineColorCount = this.proxyEngine._baselineState.palette.length;
        this._paletteSurgery.initialize(this.proxyEngine);
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
        let pixelCounts = null;
        if (sep?.colorIndices && palette) {
            pixelCounts = new Uint32Array(palette.length);
            for (let i = 0, len = sep.colorIndices.length; i < len; i++) pixelCounts[sep.colorIndices[i]]++;
        }
        const totalPixels = sep ? sep.width * sep.height : 1;
        const paletteSection = (palette || []).map((c, i) => {
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

        const surgery = { overrides: {}, merges: {}, deletions: [] };
        for (const [idx, color] of this.paletteOverrides) {
            if (this.deletedColors.has(idx)) surgery.deletions.push(idx);
            else surgery.overrides[String(idx)] = { L: Math.round(color.L * 10) / 10, a: Math.round(color.a * 10) / 10, b: Math.round(color.b * 10) / 10 };
        }
        for (const [target, sources] of this.mergeHistory) surgery.merges[String(target)] = [...sources];

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
        const separationPalette = this._suggestions.checkedSuggestions.length > 0
            ? [...baselinePalette, ...this._suggestions.checkedSuggestions.map(s => ({ L: s.L, a: s.a, b: s.b }))]
            : baselinePalette;

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

    // ─── Getters & Helpers ────────────────────────────────────

    getState() { return Object.freeze({ ...this.state }); }
    getMechanicalKnobs() { return Reveal.engines.ParameterGenerator.extractMechanicalKnobs(this.state); }
    getPreview() { return this.previewBuffer; }
    getPalette() { return this._paletteSurgery.buildOverriddenPalette(); }
    getDNA() { return this.imageDNA; }
    getSeparationState() { return this.proxyEngine?.separationState; }
    getOriginalPreviewBuffer() { return this.proxyEngine?.getOriginalPreviewRGBA(); }
    getSuggestedColors() { return this._suggestions.getSuggestedColors(); }
    get checkedSuggestions() { return this._suggestions.checkedSuggestions; }
    addCheckedSuggestion(labColor) { this._suggestions.addCheckedSuggestion(labColor); }
    removeCheckedSuggestion(labColor) { this._suggestions.removeCheckedSuggestion(labColor); }
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
        this._archetypeStateCache.set(id, { knobs, baseline: this.proxyEngine?.getBaselineSnapshot(), ...this._paletteSurgery.snapshot() });
    }

    _restoreArchetypeState(id) {
        const cached = this._archetypeStateCache.get(id);
        if (!cached) return false;
        for (const k of ALL_KNOBS) if (cached.knobs?.[k] !== undefined) {
            this.state[k] = cached.knobs[k];
            if (this.currentConfig) this.currentConfig[k] = cached.knobs[k];
        }
        this._paletteSurgery.restore(cached);
        this.state.isKnobsCustomized = !!this._archetypeDefaults && [...ALL_KNOBS].some(k => this.state[k] !== this._archetypeDefaults[k]);
        return true;
    }

    isCustomized() { return this.state.isKnobsCustomized || this._paletteSurgery.hasEdits(); }

    _emitPreviewUpdated(result) {
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
