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

// Parameters that require full re-posterization (slow path via ProxyEngine.initializeProxy)
const STRUCTURAL_PARAMS = new Set([
    'targetColors', 'engineType', 'centroidStrategy', 'distanceMetric',
    'lWeight', 'cWeight', 'vibrancyBoost', 'paletteReduction'
]);

const DEBOUNCE_MS = 50;

class SessionState extends EventEmitter {

    constructor() {
        super();

        // Reactive state — UI-facing parameters
        this.state = {
            // Core posterization
            targetColors: 8,
            engineType: 'reveal-mk1.5',
            centroidStrategy: 'SALIENCY',
            distanceMetric: 'cie76',

            // Archetype context
            activeArchetypeId: null,
            isArchetypeDirty: false,

            // Print quality knobs (scrubbable)
            minVolume: 1.5,
            speckleRescue: 4,
            shadowClamp: 8.0,

            // Structural tuning
            lWeight: 1.1,
            cWeight: 2.0,
            vibrancyBoost: 1.6,
            paletteReduction: 9.0,

            // Engine & preview state
            isProcessing: false,
            productionRenderPending: false,
            proxyBufferReady: false
        };

        // Separate from reactive state
        this.paletteOverrides = new Map();  // colorIndex → {L, a, b}
        this.proxyEngine = null;
        this.currentConfig = null;          // Full config from ParameterGenerator
        this.previewBuffer = null;          // Current RGBA preview
        this.imageDNA = null;               // DNA v2.0 snapshot
        this.imageWidth = 0;
        this.imageHeight = 0;

        // Debounce timer
        this._debounceTimer = null;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    /**
     * Load a new image into the session.
     * Runs DNA analysis → config generation → proxy initialization.
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
     * @returns {Promise<Object>} Initial proxy result
     */
    async loadImage(labPixels, width, height) {
        this.imageWidth = width;
        this.imageHeight = height;
        this.paletteOverrides.clear();

        // 1. DNA analysis — runs on the original live buffer
        const dnaGen = new Reveal.DNAGenerator();
        this.imageDNA = dnaGen.generate(labPixels, width, height, { bitDepth: 16 });
        logger.log(`[SessionState] DNA generated: dominant_sector=${this.imageDNA.dominant_sector}`);
        this.emit('imageLoaded', { width, height, dna: this.imageDNA });

        // 2. Generate config from DNA
        this.currentConfig = Reveal.generateConfiguration(this.imageDNA);
        this._applyConfigToState(this.currentConfig);
        logger.log(`[SessionState] Config generated: archetype=${this.currentConfig.id || 'unknown'}`);
        this.emit('configChanged', this.currentConfig);

        // 3. Initialize ProxyEngine — pass the live buffer directly
        //    ProxyEngine.initializeProxy() downsamples to 512px internally
        //    and stores the result in this.proxyEngine.proxyBuffer
        this.proxyEngine = new Reveal.ProxyEngine();
        const proxyResult = await this.proxyEngine.initializeProxy(
            labPixels, width, height, this.currentConfig
        );

        this.previewBuffer = proxyResult.previewBuffer;
        this.state.proxyBufferReady = true;
        this.state.isProcessing = false;

        logger.log(`[SessionState] Initial posterize: ${proxyResult.palette.length} colors, ${proxyResult.dimensions.width}x${proxyResult.dimensions.height} in ${proxyResult.elapsedMs.toFixed(0)}ms`);
        this.emit('proxyReady', proxyResult);

        // Also emit previewUpdated so carousel swatches refresh with correct palette
        const initialAccuracy = this.calculateCurrentAccuracy();
        this.emit('previewUpdated', {
            previewBuffer: proxyResult.previewBuffer,
            palette: proxyResult.palette,
            elapsedMs: proxyResult.elapsedMs,
            dimensions: proxyResult.dimensions,
            accuracyDeltaE: initialAccuracy
        });

        return proxyResult;
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
        }

        this.emit('parameterChanged', { key, value });
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
     * @returns {Promise<Object>} Updated preview data
     */
    async triggerProxyUpdate() {
        if (!this.proxyEngine) return null;

        this.state.isProcessing = true;
        this.emit('processingStart');

        try {
            let result;

            if (this.state.isArchetypeDirty) {
                // Slow path: structural param changed — full re-posterize
                // Uses rePosterize to avoid redundant downsample
                this._rebuildConfigFromState();
                result = await this.proxyEngine.rePosterize(this.currentConfig);
                this.state.isArchetypeDirty = false;
            } else {
                // Fast path: mechanical knob only
                result = await this.proxyEngine.updateProxy({
                    minVolume: this.state.minVolume,
                    speckleRescue: this.state.speckleRescue,
                    shadowClamp: this.state.shadowClamp
                });
            }

            this.previewBuffer = result.previewBuffer;
            this.state.isProcessing = false;
            this.state.proxyBufferReady = true;

            this._emitPreviewUpdated(result);

            return result;
        } catch (err) {
            this.state.isProcessing = false;
            logger.log(`[SessionState] Proxy update failed: ${err.message}`);
            this.emit('error', err);
            return null;
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

        // Regenerate config with manual archetype override
        this.currentConfig = Reveal.generateConfiguration(this.imageDNA, {
            manualArchetypeId: archetypeId
        });
        this._applyConfigToState(this.currentConfig);
        this.state.activeArchetypeId = archetypeId;
        this.state.isArchetypeDirty = false;
        this.paletteOverrides.clear();

        logger.log(`[SessionState] Archetype swap: ${archetypeId}`);

        this.emit('archetypeChanged', { archetypeId, config: this.currentConfig });
        this.emit('configChanged', this.currentConfig);

        // Re-posterize using ProxyEngine's STORED proxyBuffer (valid 512px Lab data)
        // NOT this.labPixels which goes stale in UXP.
        // ProxyEngine._downsampleBilinear will be a no-op (512→512, scale=1.0)
        const proxyW = this.proxyEngine.separationState.width;
        const proxyH = this.proxyEngine.separationState.height;

        logger.log(`[SessionState] Swap config: targetColors=${this.currentConfig.targetColors}, metric=${this.currentConfig.distanceMetric}`);

        // Use rePosterize — re-runs posterize/separate/preview on existing proxyBuffer
        // WITHOUT re-downsampling (avoids data loss from redundant 512→512 copy)
        const result = await this.proxyEngine.rePosterize(this.currentConfig);

        logger.log(`[SessionState] Swap result: ${result.palette.length} colors, ${result.elapsedMs.toFixed(0)}ms`);

        this.previewBuffer = result.previewBuffer;
        this.state.proxyBufferReady = true;
        this.state.isProcessing = false;

        const swapAccuracy = this.calculateCurrentAccuracy();
        this.emit('previewUpdated', {
            previewBuffer: result.previewBuffer,
            palette: result.palette,
            elapsedMs: result.elapsedMs,
            dimensions: result.dimensions,
            accuracyDeltaE: swapAccuracy
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
        return mapper.getTopMatches(this.imageDNA, archetypes.length);
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
        this.paletteOverrides.set(colorIndex, { ...newLabColor });

        const overriddenPalette = this._buildOverriddenPalette();

        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });

        if (!this.proxyEngine) return null;

        const result = await this.proxyEngine.updateProxy({
            paletteOverride: overriddenPalette
        });

        this.previewBuffer = result.previewBuffer;
        this.state.proxyBufferReady = true;

        this.emit('previewUpdated', {
            previewBuffer: result.previewBuffer,
            palette: result.palette,
            elapsedMs: result.elapsedMs
        });

        return result;
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

        // Copy target color into source slot (effectively merges)
        const palette = this.proxyEngine.separationState.palette;
        if (sourceIndex >= palette.length || targetIndex >= palette.length) {
            throw new Error(`Invalid palette index: source=${sourceIndex}, target=${targetIndex}, size=${palette.length}`);
        }

        this.paletteOverrides.set(sourceIndex, { ...palette[targetIndex] });

        const overriddenPalette = this._buildOverriddenPalette();

        this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });

        const result = await this.proxyEngine.updateProxy({
            paletteOverride: overriddenPalette
        });

        this.previewBuffer = result.previewBuffer;
        this.state.proxyBufferReady = true;

        this.emit('previewUpdated', {
            previewBuffer: result.previewBuffer,
            palette: result.palette,
            elapsedMs: result.elapsedMs
        });

        return result;
    }

    // ─── Production Export ────────────────────────────────────

    /**
     * Collapse current state + palette overrides into a single
     * production-ready config object for reveal-batch or reveal-adobe worker.
     *
     * @returns {Object} Collapsed production configuration
     */
    exportProductionConfig() {
        const palette = this._buildOverriddenPalette();

        return {
            // Source metadata
            width: this.imageWidth,
            height: this.imageHeight,
            dna: this.imageDNA,

            // Posterization parameters
            targetColors: this.state.targetColors,
            engineType: this.state.engineType,
            centroidStrategy: this.state.centroidStrategy,
            distanceMetric: this.state.distanceMetric,
            lWeight: this.state.lWeight,
            cWeight: this.state.cWeight,
            vibrancyBoost: this.state.vibrancyBoost,
            paletteReduction: this.state.paletteReduction,

            // Mechanical knobs
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp,

            // Archetype
            activeArchetypeId: this.state.activeArchetypeId,

            // Palette (with overrides baked in)
            palette: palette,
            paletteOverrides: Object.fromEntries(this.paletteOverrides),

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
     * Returns the current palette with any overrides applied.
     * @returns {Array<{L, a, b}>|null}
     */
    getPalette() {
        return this._buildOverriddenPalette();
    }

    // ─── Private Helpers ─────────────────────────────────────

    /**
     * Emit a previewUpdated event with accuracy Delta-E included.
     * @private
     */
    _emitPreviewUpdated(result) {
        const accuracyDeltaE = this.calculateCurrentAccuracy();
        this.emit('previewUpdated', {
            previewBuffer: result.previewBuffer,
            palette: result.palette,
            elapsedMs: result.elapsedMs,
            accuracyDeltaE
        });
    }

    /**
     * Apply config parameters to the reactive state object.
     * @private
     */
    _applyConfigToState(config) {
        if (config.targetColorsSlider !== undefined) {
            this.state.targetColors = config.targetColorsSlider;
        } else if (config.targetColors !== undefined) {
            this.state.targetColors = config.targetColors;
        }
        if (config.engineType !== undefined) this.state.engineType = config.engineType;
        if (config.centroidStrategy !== undefined) this.state.centroidStrategy = config.centroidStrategy;
        if (config.distanceMetric !== undefined) this.state.distanceMetric = config.distanceMetric;
        if (config.lWeight !== undefined) this.state.lWeight = config.lWeight;
        if (config.cWeight !== undefined) this.state.cWeight = config.cWeight;
        if (config.vibrancyBoost !== undefined) this.state.vibrancyBoost = config.vibrancyBoost;
        if (config.paletteReduction !== undefined) this.state.paletteReduction = config.paletteReduction;
        if (config.minVolume !== undefined) this.state.minVolume = config.minVolume;
        if (config.speckleRescue !== undefined) this.state.speckleRescue = config.speckleRescue;
        if (config.shadowClamp !== undefined) this.state.shadowClamp = config.shadowClamp;

        if (config.id) this.state.activeArchetypeId = config.id;
    }

    /**
     * Rebuild currentConfig from the current reactive state.
     * Called before structural re-posterize.
     * @private
     */
    _rebuildConfigFromState() {
        if (!this.currentConfig) return;

        this.currentConfig.targetColors = this.state.targetColors;
        if (this.state.targetColors) {
            this.currentConfig.targetColorsSlider = this.state.targetColors;
        }
        this.currentConfig.engineType = this.state.engineType;
        this.currentConfig.centroidStrategy = this.state.centroidStrategy;
        this.currentConfig.distanceMetric = this.state.distanceMetric;
        this.currentConfig.lWeight = this.state.lWeight;
        this.currentConfig.cWeight = this.state.cWeight;
        this.currentConfig.vibrancyBoost = this.state.vibrancyBoost;
        this.currentConfig.paletteReduction = this.state.paletteReduction;
        this.currentConfig.minVolume = this.state.minVolume;
        this.currentConfig.speckleRescue = this.state.speckleRescue;
        this.currentConfig.shadowClamp = this.state.shadowClamp;
    }

    /**
     * Build a palette array with overrides applied on top of the proxy's current palette.
     * @private
     * @returns {Array<{L, a, b}>|null}
     */
    _buildOverriddenPalette() {
        if (!this.proxyEngine || !this.proxyEngine.separationState) return null;

        const basePalette = this.proxyEngine.separationState.palette;
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
