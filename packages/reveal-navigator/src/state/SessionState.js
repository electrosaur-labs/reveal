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
            proxyBufferReady: false,

            // Decision support state
            isKnobsCustomized: false,   // true when any knob differs from archetype defaults
            highlightColorIndex: -1     // -1 = no highlight, 0+ = isolated color
        };

        // Separate from reactive state
        this.paletteOverrides = new Map();  // colorIndex → {L, a, b}
        this.proxyEngine = null;
        this.currentConfig = null;          // Full config from ParameterGenerator
        this.previewBuffer = null;          // Current RGBA preview
        this.imageDNA = null;               // DNA v2.0 snapshot
        this.imageWidth = 0;
        this.imageHeight = 0;

        // Snapshot of knob values from archetype config (for dirty detection)
        this._archetypeDefaults = null;

        // Snapshot cache: archetypeId → {minVolume, speckleRescue, shadowClamp}
        // Saved on swap-out when knobs are customized. NOT auto-restored —
        // user must click "Restore My Tweaks" to apply (Option B: Snapshot).
        this._tweakCache = new Map();

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
        this._tweakCache.clear();

        // 1. DNA analysis — runs on the original live buffer
        const dnaGen = new Reveal.DNAGenerator();
        this.imageDNA = dnaGen.generate(labPixels, width, height, { bitDepth: 16 });
        logger.log(`[SessionState] DNA generated: dominant_sector=${this.imageDNA.dominant_sector}`);

        // 2. Generate config from DNA — BEFORE emitting imageLoaded so that
        //    RadarHUD can read activeArchetypeId for the gold centroid polygon
        this.currentConfig = Reveal.generateConfiguration(this.imageDNA);
        this._applyConfigToState(this.currentConfig);
        logger.log(`[SessionState] Config generated: archetype=${this.currentConfig.id || 'unknown'}`);

        this.emit('imageLoaded', { width, height, dna: this.imageDNA });
        this.emit('configChanged', this.currentConfig);

        // 3. Initialize ProxyEngine — pass the live buffer directly
        //    ProxyEngine.initializeProxy() downsamples to 512px internally
        //    and stores the result in this.proxyEngine.proxyBuffer
        this.proxyEngine = new Reveal.ProxyEngine();
        const proxyResult = await this.proxyEngine.initializeProxy(
            labPixels, width, height, this.currentConfig
        );

        logger.log(`[SessionState] Initial posterize: ${proxyResult.palette.length} colors, ${proxyResult.dimensions.width}x${proxyResult.dimensions.height} in ${proxyResult.elapsedMs.toFixed(0)}ms`);
        this.emit('proxyReady', proxyResult);

        // Apply knobs (speckleRescue, shadowClamp, minVolume) with explicit state values.
        // This ensures the initial preview is consistent with subsequent slider updates.
        const knobResult = await this.proxyEngine.updateProxy({
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp
        });

        this.previewBuffer = knobResult.previewBuffer;
        this.state.proxyBufferReady = true;
        this.state.isProcessing = false;

        // Emit previewUpdated so carousel swatches refresh with correct palette
        const initialAccuracy = this.calculateCurrentAccuracy();
        this.emit('previewUpdated', {
            previewBuffer: knobResult.previewBuffer,
            palette: knobResult.palette,
            activeColorCount: this._countActiveColors(),
            elapsedMs: proxyResult.elapsedMs + knobResult.elapsedMs,
            dimensions: proxyResult.dimensions,
            accuracyDeltaE: initialAccuracy
        });

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
     * Reset ALL mechanical knobs to archetype defaults ("Factory Reset").
     */
    resetAllKnobs() {
        if (!this._archetypeDefaults) return;
        for (const key of MECHANICAL_KNOBS) {
            this.state[key] = this._archetypeDefaults[key];
            if (this.currentConfig) this.currentConfig[key] = this._archetypeDefaults[key];
        }
        this.state.isKnobsCustomized = false;
        this.emit('knobsCustomizedChanged', { customized: false });
        this.emit('configChanged', this.currentConfig);  // triggers MechanicalKnobs sync
        this._scheduleProxyUpdate();
    }

    /**
     * Restore previously cached knob tweaks for the active archetype.
     * Called by the "Restore My Tweaks" UI action.
     */
    restoreTweaks() {
        const id = this.state.activeArchetypeId;
        const cached = id ? this._tweakCache.get(id) : null;
        if (!cached) return;

        for (const key of MECHANICAL_KNOBS) {
            this.state[key] = cached[key];
            if (this.currentConfig) this.currentConfig[key] = cached[key];
        }

        // Detect if restored values differ from archetype defaults
        this.state.isKnobsCustomized =
            this.state.minVolume !== this._archetypeDefaults.minVolume ||
            this.state.speckleRescue !== this._archetypeDefaults.speckleRescue ||
            this.state.shadowClamp !== this._archetypeDefaults.shadowClamp;

        this.emit('knobsCustomizedChanged', { customized: this.state.isKnobsCustomized });
        this.emit('tweaksAvailable', { archetypeId: id, available: false }); // consumed
        this.emit('configChanged', this.currentConfig);  // sync sliders
        this._scheduleProxyUpdate();

        // Clear cache entry — one-shot restore
        this._tweakCache.delete(id);
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
        }

        // Detect knob customization vs archetype defaults
        if (MECHANICAL_KNOBS.has(key) && this._archetypeDefaults) {
            const wasCustomized = this.state.isKnobsCustomized;
            this.state.isKnobsCustomized =
                this.state.minVolume !== this._archetypeDefaults.minVolume ||
                this.state.speckleRescue !== this._archetypeDefaults.speckleRescue ||
                this.state.shadowClamp !== this._archetypeDefaults.shadowClamp;
            if (this.state.isKnobsCustomized !== wasCustomized) {
                this.emit('knobsCustomizedChanged', { customized: this.state.isKnobsCustomized });
            }
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
                // Uses rePosterize to avoid redundant downsample.
                // Clear palette overrides — old indices are meaningless
                // against the new baseline from re-posterization.
                this._rebuildConfigFromState();
                this.paletteOverrides.clear();
                this.emit('paletteChanged', { paletteOverrides: this.paletteOverrides });
                result = await this.proxyEngine.rePosterize(this.currentConfig);
                this.state.isArchetypeDirty = false;
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

            result = await this.proxyEngine.updateProxy(updateParams);

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

        // Snapshot outgoing knob tweaks (only if customized)
        if (this.state.isKnobsCustomized && this.state.activeArchetypeId) {
            this._tweakCache.set(this.state.activeArchetypeId, {
                minVolume: this.state.minVolume,
                speckleRescue: this.state.speckleRescue,
                shadowClamp: this.state.shadowClamp
            });
        }

        // Regenerate config with manual archetype override
        // Sliders always revert to the archetype's recommended values (Option A: Purist)
        this.currentConfig = Reveal.generateConfiguration(this.imageDNA, {
            manualArchetypeId: archetypeId
        });
        this._applyConfigToState(this.currentConfig);

        this.state.activeArchetypeId = archetypeId;
        this.state.isArchetypeDirty = false;
        this.paletteOverrides.clear();

        // Reset decision support state on archetype swap
        this.state.highlightColorIndex = -1;
        this.emit('highlightChanged', { colorIndex: -1 });
        this.state.isKnobsCustomized = false;
        this.emit('knobsCustomizedChanged', { customized: false });

        // Notify UI if this archetype has cached tweaks (Option B: Snapshot)
        const hasTweaks = this._tweakCache.has(archetypeId);
        this.emit('tweaksAvailable', { archetypeId, available: hasTweaks });

        logger.log(`[SessionState] Archetype swap: ${archetypeId}`);

        this.emit('archetypeChanged', { archetypeId, config: this.currentConfig });
        this.emit('configChanged', this.currentConfig);

        logger.log(`[SessionState] Swap config: targetColors=${this.currentConfig.targetColors}, metric=${this.currentConfig.distanceMetric}`);

        // Use rePosterize — re-runs posterize/separate/preview on existing proxyBuffer
        // WITHOUT re-downsampling (avoids data loss from redundant 512→512 copy)
        const result = await this.proxyEngine.rePosterize(this.currentConfig);

        logger.log(`[SessionState] Swap result: ${result.palette.length} colors, ${result.elapsedMs.toFixed(0)}ms`);

        // Apply knobs with explicit state values (not config which may have undefined knobs)
        const knobResult = await this.proxyEngine.updateProxy({
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp
        });

        this.previewBuffer = knobResult.previewBuffer;
        this.state.proxyBufferReady = true;
        this.state.isProcessing = false;

        const swapAccuracy = this.calculateCurrentAccuracy();
        this.emit('previewUpdated', {
            previewBuffer: knobResult.previewBuffer,
            palette: knobResult.palette,
            activeColorCount: this._countActiveColors(),
            elapsedMs: result.elapsedMs + knobResult.elapsedMs,
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
        if (!this.paletteOverrides.has(colorIndex)) return null;

        this.paletteOverrides.delete(colorIndex);

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
        this.emit('previewUpdated', {
            previewBuffer: result.previewBuffer,
            palette: result.palette,
            activeColorCount: this._countActiveColors(),
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

        // Snapshot archetype defaults for dirty detection
        this._archetypeDefaults = {
            minVolume: this.state.minVolume,
            speckleRescue: this.state.speckleRescue,
            shadowClamp: this.state.shadowClamp
        };
        this.state.isKnobsCustomized = false;
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
