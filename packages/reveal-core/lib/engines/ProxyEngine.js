/**
 * ProxyEngine - Low-resolution proxy for real-time parameter updates
 *
 * Maintains an 800px "digital twin" for fast response during UI scrubbing.
 * Architecture:
 * - Fixed 800px resolution (long edge)
 * - 16-bit LAB buffer (maintains full tonal range)
 * - Bilinear downsampling from source
 * - Bilateral filter preprocessing (matches reveal-adobe pipeline)
 * - State persistence: holds current separation state in memory
 * - Incremental updates: re-runs only affected steps
 *
 * @module ProxyEngine
 */

const logger = require('../utils/logger');

const PosterizationEngine = require('./PosterizationEngine');
const SeparationEngine = require('./SeparationEngine');
const PreviewEngine = require('./PreviewEngine');
const BilateralFilter = require('../preprocessing/BilateralFilter');
const MechanicalKnobs = require('./MechanicalKnobs');
const DNAFidelity = require('../metrics/DNAFidelity');
const RevelationError = require('../metrics/RevelationError');
const LabEncoding = require('../color/LabEncoding');
const SuggestedColorAnalyzer = require('../analysis/SuggestedColorAnalyzer');

// Proxy-safe overrides for resolution-dependent thresholds.
// snapThreshold, densityFloor, and ghostFloor are all calibrated for full-res
// pixel counts and must be reset at proxy resolution to prevent palette collapse.
// ghostFloor=0.01 (1%) requires 4,800+ pixels/color at 800px proxy — too
// aggressive for tonal gradations; reset to default 0.1% (PaletteDistiller MIN_COVERAGE).
// paletteReduction is ΔE-based (resolution-independent) — passed through
// from the archetype config so preview matches production.
//
// bitDepth:16 — ProxyEngine always receives true 16-bit Lab from PhotoshopBridge
// (componentSize:16 confirmed working 2026-02-16). Without this, ParameterGenerator
// omits bitDepth (it has no opinion on bit depth), causing the engine to use 8-bit
// thresholds: brown-dampener activates and mangles warm centroid placement, causing
// oranges/yellows to be missed. Force 16-bit here so engine thresholds match the data.
const PROXY_SAFE_OVERRIDES = Object.freeze({
    format: 'lab',
    bitDepth: 16,
    snapThreshold: 0,
    densityFloor: 0,
    preservedUnifyThreshold: 0.5,
});

/**
 * @typedef {Object} ProxyInitResult
 * @property {Uint8Array} previewBuffer - RGBA preview pixels (4 bytes per pixel)
 * @property {Array<{L:number,a:number,b:number}>} palette - Lab palette (perceptual ranges)
 * @property {{width:number,height:number}} dimensions - Proxy dimensions
 * @property {Object} metadata - Engine statistics from posterization
 * @property {number} elapsedMs - Total processing time in ms
 */

/**
 * @typedef {Object} ProxyUpdateResult
 * @property {Uint8Array} previewBuffer - Updated RGBA preview pixels
 * @property {Array<{L:number,a:number,b:number}>} palette - Current Lab palette
 * @property {Object} metadata - Engine statistics
 */

class ProxyEngine {
    static PROXY_TARGET_SIZE = 1000; // Target long edge in pixels

    constructor() {
        this.proxyBuffer = null;        // 512px 16-bit LAB buffer (may be bilaterally filtered)
        this._rawProxyBuffer = null;    // 512px unfiltered stride-3 buffer — canonical source for re-filtering
        this._proxyPreprocessingIntensity = null; // intensity applied to current proxyBuffer
        this.separationState = null;    // Cached palette + indices + masks (may be mutated by knobs)
        this._baselineState = null;     // Clean snapshot from last posterize (never mutated by knobs)
        this.sourceMetadata = null;     // Original dimensions, DNA
    }

    /**
     * Initialize proxy from source image
     * @param {Uint16Array} labPixels - Source 16-bit LAB data
     * @param {number} width - Source width
     * @param {number} height - Source height
     * @param {Object} initialConfig - Posterization config
     * @returns {Promise<Object>} Proxy state
     */
    async initializeProxy(labPixels, width, height, initialConfig) {
        // --- Input validation ---
        if (!labPixels || !(labPixels instanceof Uint16Array)) {
            throw new Error('initializeProxy: labPixels must be a Uint16Array');
        }
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
            throw new Error(`initializeProxy: width and height must be positive integers (got ${width}x${height})`);
        }
        if (labPixels.length < width * height * 3) {
            throw new Error(`initializeProxy: labPixels too short (${labPixels.length}) for ${width}x${height}x3 = ${width * height * 3}`);
        }
        if (!initialConfig || typeof initialConfig !== 'object') {
            throw new Error('initializeProxy: initialConfig is required and must be an object');
        }

        const startTime = performance.now();

        // 1. Stride-3 subsample — picks every 3rd pixel, no blending.
        //    Matches the batch pipeline exactly, preserving rare color clusters
        //    that bilinear averaging would blend away.
        const result = this._strideSubsample(labPixels, width, height);
        const rawBuffer = result.buffer;  // unfiltered, canonical source for per-archetype re-filtering
        const proxyW = result.width;
        const proxyH = result.height;

        // Store raw buffer BEFORE bilateral filtering.
        // rePosterize calls derive per-archetype buffers from _rawProxyBuffer so
        // preprocessingIntensity changes (e.g. 'auto' Chameleon → 'off' warm_sovereign)
        // take effect immediately without requiring a full re-ingest.
        this._rawProxyBuffer = rawBuffer;

        // 2. Bilateral filter preprocessing — applied to a COPY so _rawProxyBuffer stays clean.
        const preprocessingIntensity = initialConfig.preprocessingIntensity || 'auto';
        let proxyBuffer;
        if (preprocessingIntensity !== 'off') {
            proxyBuffer = new Uint16Array(rawBuffer); // copy — never mutate the raw source
            const isHeavy = preprocessingIntensity === 'heavy';
            const radius = isHeavy ? 5 : 3;
            BilateralFilter.applyBilateralFilterLab(proxyBuffer, proxyW, proxyH, radius, 5000);
        } else {
            proxyBuffer = rawBuffer; // no filtering — use raw directly (same reference is fine)
        }
        this._proxyPreprocessingIntensity = preprocessingIntensity;

        this.proxyBuffer = proxyBuffer;
        this._originalRGBA = null;  // Invalidate cached original preview

        const proxyConfig = { ...initialConfig, ...PROXY_SAFE_OVERRIDES };

        const posterizeResult = PosterizationEngine.posterize(
            proxyBuffer, proxyW, proxyH, proxyConfig.targetColors, proxyConfig
        );
        // Use posterize's built-in assignments (box membership) directly.
        // Skips the expensive mapPixelsToPaletteAsync nearest-neighbor pass.
        const colorIndices = posterizeResult.assignments;

        // 4. Generate masks from color indices
        const masks = [];
        for (let i = 0; i < posterizeResult.paletteLab.length; i++) {
            const mask = SeparationEngine.generateLayerMask(colorIndices, i, proxyW, proxyH);
            masks.push(mask);
        }

        // 5. Cache separation state
        this.separationState = {
            palette: posterizeResult.paletteLab,
            rgbPalette: posterizeResult.paletteLab.map(c => LabEncoding.labToRgbD50(c)),
            colorIndices: colorIndices,
            masks: masks,
            width: proxyW,
            height: proxyH,
            distanceMetric: initialConfig.distanceMetric || 'cie76',
            metadata: posterizeResult.metadata || {}
        };

        // Snapshot baseline so mechanical knobs can restore from clean state
        this._snapshotBaseline();

        // 5. Store source metadata
        this.sourceMetadata = {
            originalWidth: width,
            originalHeight: height,
            dna: posterizeResult.dna,
            bitDepth: initialConfig.bitDepth || 16,
            targetColors: initialConfig.targetColors || initialConfig.targetColorsSlider || 0
        };

        // Track substrate mode so getSuggestedColors respects archetype config
        this._substrateMode = initialConfig.substrateMode || 'auto';

        // 6. Generate clean preview (no knobs yet).
        // Caller (SessionState) follows up with updateProxy() to apply knobs.
        const previewBuffer = this._generatePreviewFromIndices(
            this.separationState.colorIndices,
            this.separationState.rgbPalette,
            proxyW,
            proxyH
        );

        const elapsed = performance.now() - startTime;

        return {
            previewBuffer,
            palette: this.separationState.palette,
            dimensions: { width: proxyW, height: proxyH },
            metadata: this.separationState.metadata,
            elapsedMs: elapsed
        };
    }

    /**
     * Re-posterize the existing proxyBuffer with a new config.
     * Skips downsampling — uses the stored 512px buffer directly.
     * Used for archetype swaps where the source pixels haven't changed.
     *
     * @param {Object} config - New posterization config
     * @returns {Promise<Object>} Updated proxy state
     */
    async rePosterize(config) {
        if (!this.proxyBuffer || !this.separationState) {
            throw new Error('Proxy not initialized — call initializeProxy first');
        }

        const startTime = performance.now();
        const proxyW = this.separationState.width;
        const proxyH = this.separationState.height;

        // Regenerate proxyBuffer if preprocessing intensity changed between archetypes.
        // Chameleon uses 'auto' (bilateral filter applied); warm_sovereign and similar use 'off'
        // (raw pixels). Without this, an 'off' archetype runs on Chameleon's filtered buffer,
        // causing ~9% chroma reduction (bilateral averaging compresses extreme chroma).
        const newIntensity = config.preprocessingIntensity !== undefined
            ? config.preprocessingIntensity
            : 'auto'; // undefined → 'auto' (matches initializeProxy default)
        if (newIntensity !== this._proxyPreprocessingIntensity && this._rawProxyBuffer) {
            if (newIntensity !== 'off') {
                const buf = new Uint16Array(this._rawProxyBuffer); // copy raw, then filter
                const isHeavy = newIntensity === 'heavy';
                const radius = isHeavy ? 5 : 3;
                BilateralFilter.applyBilateralFilterLab(buf, proxyW, proxyH, radius, 5000);
                this.proxyBuffer = buf;
            } else {
                this.proxyBuffer = this._rawProxyBuffer; // use raw (no filter)
            }
            this._proxyPreprocessingIntensity = newIntensity;
        }

        const proxyConfig = { ...config, ...PROXY_SAFE_OVERRIDES };

        const posterizeResult = PosterizationEngine.posterize(
            this.proxyBuffer, proxyW, proxyH, proxyConfig.targetColors, proxyConfig
        );
        const colorIndices = posterizeResult.assignments;

        // 3. Masks
        const masks = [];
        for (let i = 0; i < posterizeResult.paletteLab.length; i++) {
            masks.push(SeparationEngine.generateLayerMask(colorIndices, i, proxyW, proxyH));
        }

        // 4. Update cached state (proxyBuffer unchanged)
        this.separationState = {
            palette: posterizeResult.paletteLab,
            rgbPalette: posterizeResult.paletteLab.map(c => LabEncoding.labToRgbD50(c)),
            colorIndices,
            masks,
            width: proxyW,
            height: proxyH,
            distanceMetric: config.distanceMetric || 'cie76',
            metadata: posterizeResult.metadata || {}
        };

        // Update sourceMetadata.targetColors for the new archetype
        // (different archetypes may request different screen counts)
        this.sourceMetadata.targetColors = config.targetColors || config.targetColorsSlider || 0;

        // Track substrate mode for getSuggestedColors
        this._substrateMode = config.substrateMode || 'auto';

        // Snapshot baseline so mechanical knobs can restore from clean state
        this._snapshotBaseline();

        // 5. Generate clean preview (no knobs yet).
        // Caller (SessionState) follows up with updateProxy() to apply knobs.
        const previewBuffer = this._generatePreviewFromIndices(
            colorIndices,
            posterizeResult.palette,
            proxyW,
            proxyH
        );

        const elapsed = performance.now() - startTime;

        return {
            previewBuffer,
            palette: this.separationState.palette,
            dimensions: { width: proxyW, height: proxyH },
            metadata: this.separationState.metadata,
            elapsedMs: elapsed
        };
    }

    /**
     * Update proxy with new parameters (FAST PATH)
     *
     * Restores from baseline before applying knobs so that changes are
     * always relative to the clean posterization output — not accumulated
     * on top of previous knob mutations. This makes slider changes fully
     * reversible.
     *
     * @param {Object} paramChanges - Only changed parameters
     * @returns {Promise<Object>} Updated preview data
     */
    async updateProxy(paramChanges) {
        if (!this.separationState) {
            throw new Error('Proxy not initialized');
        }

        const startTime = performance.now();

        // Restore clean baseline before applying any changes.
        // Without this, knob effects accumulate destructively
        // (e.g. pruned colors can never come back).
        if (this._baselineState) {
            this._restoreFromBaseline();
        }

        // Apply knobs FIRST on the baseline palette.
        // minVolume classifies colors into hue sectors for rescue decisions —
        // if we applied the palette override first, the overridden color's new
        // hue sector could lose its sector rescue, causing the swatch to be
        // pruned and disappear. Running knobs on the baseline preserves the
        // same weak/strong/rescue classification the user saw before editing.
        await this._applyKnobs(paramChanges);

        // Apply palette override AFTER knobs — swap ink colors without
        // re-separating. In screen printing, "override" means "same plate,
        // different ink." Plate assignments (colorIndices + masks) stay fixed;
        // only the palette and rgbPalette update so the preview shows the
        // new ink color on the existing plate coverage.
        // DO NOT call _recomputeSeparation() — that would redistribute
        // every pixel to nearest color, causing cascade: swatches rearrange,
        // paper reassigns, coverage shifts, revert lands on wrong swatch.
        if ('paletteOverride' in paramChanges) {
            this.separationState.palette = paramChanges.paletteOverride;
            this.separationState.rgbPalette = paramChanges.paletteOverride.map(
                lab => LabEncoding.labToRgbD50(lab)
            );
        }

        // Generate preview from masks (reflects despeckle + shadowClamp).
        // Pixels where all masks are 0 (isolated speckles removed) show as white.
        const previewBuffer = this._generatePreviewFromMasks(
            this.separationState.masks,
            this.separationState.colorIndices,
            this.separationState.rgbPalette,
            this.separationState.width,
            this.separationState.height
        );

        const elapsed = performance.now() - startTime;

        return {
            previewBuffer,
            palette: this.separationState.palette,
            metadata: this.separationState.metadata,
            elapsedMs: elapsed
        };
    }

    /**
     * Posterize the proxy buffer with a given config and return ONLY the palette.
     * Does NOT modify separationState or _baselineState — purely read-only.
     * Used for progressive palette preview on non-active archetype cards.
     *
     * @param {Object} config - Posterization config (from ParameterGenerator)
     * @returns {Promise<{labPalette: Array, rgbPalette: Array}>}
     */
    async getPaletteForConfig(config) {
        if (!this.proxyBuffer || !this.separationState) {
            throw new Error('Proxy not initialized');
        }

        const proxyW = this.separationState.width;
        const proxyH = this.separationState.height;

        const proxyConfig = { ...config, ...PROXY_SAFE_OVERRIDES };
        const buf = this._bufferForConfig(proxyConfig);

        const result = PosterizationEngine.posterize(
            buf, proxyW, proxyH, proxyConfig.targetColors, proxyConfig
        );

        return { labPalette: result.paletteLab, rgbPalette: result.palette };
    }

    /**
     * Like getPaletteForConfig but also runs separation and computes DNAFidelity.
     * Used by background palette loop to collect per-archetype fidelity scores.
     *
     * @param {Object} config - Posterization config
     * @param {Object} inputDNA - Original image DNA for fidelity comparison
     * @returns {Promise<{labPalette, rgbPalette, fidelity: number}>}
     */
    async getPaletteWithFidelity(config, inputDNA) {
        if (!this.proxyBuffer || !this.separationState) {
            throw new Error('Proxy not initialized');
        }

        const proxyW = this.separationState.width;
        const proxyH = this.separationState.height;

        const proxyConfig = { ...config, ...PROXY_SAFE_OVERRIDES };
        const buf = this._bufferForConfig(proxyConfig);

        const result = PosterizationEngine.posterize(
            buf, proxyW, proxyH, proxyConfig.targetColors, proxyConfig
        );
        // Use posterize's built-in assignments for fidelity calculation
        const colorIndices = result.assignments;

        const fidelityResult = DNAFidelity.fromIndices(
            inputDNA, colorIndices, result.paletteLab, proxyW, proxyH
        );

        return {
            labPalette: result.paletteLab,
            rgbPalette: result.palette,
            fidelity: fidelityResult.fidelity
        };
    }

    /**
     * Like getPaletteForConfig but also runs separation and computes mean ΔE.
     * Used by background palette loop to rank archetypes by actual quality.
     *
     * @param {Object} config - Posterization config
     * @returns {Promise<{labPalette, rgbPalette, meanDeltaE: number}>}
     */
    async getPaletteWithQuality(config, knobs) {
        if (!this.proxyBuffer || !this.separationState) {
            throw new Error('Proxy not initialized');
        }

        const proxyW = this.separationState.width;
        const proxyH = this.separationState.height;
        const pixelCount = proxyW * proxyH;

        const proxyConfig = { ...config, ...PROXY_SAFE_OVERRIDES };
        const buf = this._bufferForConfig(proxyConfig);

        const result = PosterizationEngine.posterize(
            buf, proxyW, proxyH, proxyConfig.targetColors, proxyConfig
        );
        const colorIndices = result.assignments;

        // Apply minVolume so ΔE matches the live post-knob state.
        // minVolume remaps pixels from weak colors → biggest ΔE impact.
        // speckleRescue/shadowClamp operate on masks (minor ΔE effect, skip here).
        if (knobs && knobs.minVolume != null && knobs.minVolume > 0) {
            const target = config.targetColors || 0;
            const maxColors = target > 0 ? target + 2 : 0;
            MechanicalKnobs.applyMinVolume(
                colorIndices, result.paletteLab, pixelCount,
                knobs.minVolume, { maxColors }
            );
        }

        const meanDeltaE = RevelationError.meanDeltaE16(
            this.proxyBuffer, colorIndices, result.paletteLab, pixelCount
        );

        // Structural fidelity: what fraction of major color boundaries survive
        const edgeResult = RevelationError.edgeSurvival16(
            this.proxyBuffer, colorIndices, proxyW, proxyH
        );

        return {
            labPalette: result.paletteLab,
            rgbPalette: result.palette,
            meanDeltaE,
            edgeSurvival: edgeResult.edgeSurvival,
            significantEdges: edgeResult.significantEdges,
            survivedEdges: edgeResult.survivedEdges
        };
    }

    /**
     * Add a new color to the palette and re-separate all pixels.
     * The new color becomes a first-class palette entry — pixels redistribute
     * via nearest-neighbor so the added color gets real coverage.
     *
     * @param {{L: number, a: number, b: number}} labColor - Lab color to add
     * @returns {Promise<Object>} Updated preview data
     */
    async addColorAndReseparate(labColor) {
        if (!this.separationState || !this.proxyBuffer) {
            throw new Error('Proxy not initialized');
        }

        // Append to current separation state palette
        this.separationState.palette.push({ ...labColor });
        this.separationState.rgbPalette.push(LabEncoding.labToRgbD50(labColor));

        // Full nearest-neighbor re-separation with expanded palette
        await this._recomputeSeparation();

        // Take new baseline snapshot (added color is now part of baseline)
        this._snapshotBaseline();

        // Generate preview
        const previewBuffer = this._generatePreviewFromMasks(
            this.separationState.masks,
            this.separationState.colorIndices,
            this.separationState.rgbPalette,
            this.separationState.width,
            this.separationState.height
        );

        return {
            previewBuffer,
            palette: this.separationState.palette,
            metadata: this.separationState.metadata,
            elapsedMs: 0
        };
    }

    /**
     * Remove a color from the palette and re-separate all pixels.
     * Splices the color out, remaps indices, and runs nearest-neighbor
     * so remaining colors absorb the removed color's pixels.
     *
     * @param {number} colorIndex - Index of the color to remove
     * @returns {Promise<Object>} Updated preview data
     */
    async removeColorAndReseparate(colorIndex) {
        if (!this.separationState || !this.proxyBuffer) {
            throw new Error('Proxy not initialized');
        }

        const palette = this.separationState.palette;
        if (colorIndex < 0 || colorIndex >= palette.length) {
            throw new Error(`Invalid color index: ${colorIndex}`);
        }
        if (palette.length <= 1) {
            throw new Error('Cannot remove the last remaining color');
        }

        // Splice from palette and rgbPalette
        this.separationState.palette.splice(colorIndex, 1);
        this.separationState.rgbPalette.splice(colorIndex, 1);

        // Full nearest-neighbor re-separation with reduced palette
        await this._recomputeSeparation();

        // Take new baseline snapshot
        this._snapshotBaseline();

        // Generate preview
        const previewBuffer = this._generatePreviewFromMasks(
            this.separationState.masks,
            this.separationState.colorIndices,
            this.separationState.rgbPalette,
            this.separationState.width,
            this.separationState.height
        );

        return {
            previewBuffer,
            palette: this.separationState.palette,
            metadata: this.separationState.metadata,
            elapsedMs: 0
        };
    }

    /**
     * Get full-res parameters for production render
     * @returns {Object} Parameters for high-res posterization
     */
    getProductionConfig() {
        return {
            ...this.sourceMetadata,
            palette: this.separationState.palette,
            targetColors: this.separationState.palette.length
        };
    }

    /**
     * Get the original (pre-posterization) proxy image as an RGBA buffer.
     * Converts the cached Lab16 proxyBuffer to display-ready RGBA.
     * Result is cached — invalidated on next initializeProxy().
     *
     * @returns {{buffer: Uint8ClampedArray, width: number, height: number}|null}
     */
    getOriginalPreviewRGBA() {
        if (!this.proxyBuffer || !this.separationState) return null;

        const w = this.separationState.width;
        const h = this.separationState.height;

        // Return cached result if proxy hasn't changed
        if (this._originalRGBA && this._originalRGBA.width === w && this._originalRGBA.height === h) {
            return this._originalRGBA;
        }

        const pixelCount = w * h;

        // Lab16 → Lab8 → RGB (3ch) → RGBA (4ch)
        const lab8 = LabEncoding.convertEngine16bitTo8bitLab(this.proxyBuffer, pixelCount);
        const rgb = LabEncoding.lab8bitToRgb(lab8, pixelCount);

        const rgba = new Uint8ClampedArray(pixelCount * 4);
        for (let i = 0; i < pixelCount; i++) {
            const src = i * 3;
            const dst = i * 4;
            rgba[dst]     = rgb[src];
            rgba[dst + 1] = rgb[src + 1];
            rgba[dst + 2] = rgb[src + 2];
            rgba[dst + 3] = 255;
        }

        this._originalRGBA = { buffer: rgba, width: w, height: h };
        return this._originalRGBA;
    }

    /**
     * Get suggested colors — distinctive image colors not covered by the palette.
     * Uses "Rare Earth" algorithm: edge-weighted perceptual bucketing with
     * distinctiveness scoring and palette exclusion.
     *
     * @returns {Array<{L, a, b, source, reason, score}>}
     */
    getSuggestedColors() {
        if (!this.separationState || !this.proxyBuffer) return [];

        const state = this.separationState;
        return SuggestedColorAnalyzer.analyze(
            this.proxyBuffer, state.width, state.height, state.palette,
            { substrateMode: this._substrateMode || 'auto' }
        );
    }

    /**
     * Return the appropriate pixel buffer for a given config's preprocessingIntensity.
     * Configs with 'off' preprocessing must use the raw (unfiltered) buffer so their
     * palette centroids are not compressed by the bilateral filter. All read-only
     * methods (getPaletteForConfig, getPaletteWithFidelity, getPaletteWithQuality)
     * use this so background scoring always reflects the config's true output.
     * @private
     */
    _bufferForConfig(config) {
        const intensity = config.preprocessingIntensity;
        if (intensity === 'off' && this._rawProxyBuffer) {
            return this._rawProxyBuffer;
        }
        return this.proxyBuffer;
    }

    /**
     * Deep-copy current separationState as the clean baseline.
     * Called after initializeProxy and rePosterize — never after knob application.
     * @private
     */
    _snapshotBaseline() {
        const s = this.separationState;
        this._baselineState = {
            palette: s.palette.map(c => ({ ...c })),
            rgbPalette: s.rgbPalette ? s.rgbPalette.map(c =>
                typeof c === 'string' ? c : { ...c }
            ) : null,
            colorIndices: new Uint8Array(s.colorIndices),
            masks: s.masks.map(m => new Uint8Array(m)),
            width: s.width,
            height: s.height,
            distanceMetric: s.distanceMetric || 'cie76',
            metadata: { ...(s.metadata || {}) }
        };
    }

    /**
     * Restore separationState from the clean baseline snapshot.
     * @private
     */
    _restoreFromBaseline() {
        const b = this._baselineState;
        this.separationState = {
            palette: b.palette.map(c => ({ ...c })),
            rgbPalette: b.rgbPalette ? b.rgbPalette.map(c =>
                typeof c === 'string' ? c : { ...c }
            ) : null,
            colorIndices: new Uint8Array(b.colorIndices),
            masks: b.masks.map(m => new Uint8Array(m)),
            width: b.width,
            height: b.height,
            distanceMetric: b.distanceMetric || 'cie76',
            metadata: { ...(b.metadata || {}) }
        };
    }

    // ─── Baseline Snapshot (for archetype state cache) ──────

    /**
     * Deep-copy the current baseline state + preprocessing intensity
     * so it can be restored later without re-posterizing.
     * @returns {Object} Opaque snapshot — pass to restoreBaselineSnapshot()
     */
    getBaselineSnapshot() {
        if (!this._baselineState) return null;
        const b = this._baselineState;
        return {
            palette: b.palette.map(c => ({ ...c })),
            rgbPalette: b.rgbPalette ? b.rgbPalette.map(c =>
                typeof c === 'string' ? c : { ...c }
            ) : null,
            colorIndices: new Uint8Array(b.colorIndices),
            masks: b.masks.map(m => new Uint8Array(m)),
            width: b.width,
            height: b.height,
            distanceMetric: b.distanceMetric || 'cie76',
            metadata: { ...(b.metadata || {}) },
            preprocessingIntensity: this._proxyPreprocessingIntensity
        };
    }

    /**
     * Restore a previously cached baseline snapshot.
     * Sets both _baselineState and separationState, then generates a preview.
     * Caller follows up with updateProxy() to apply knobs + palette overrides.
     *
     * @param {Object} snapshot - From getBaselineSnapshot()
     * @param {Object} [config] - Archetype config (for sourceMetadata sync)
     * @returns {{previewBuffer: Uint8ClampedArray, palette: Array, dimensions: Object, metadata: Object, elapsedMs: number}}
     */
    restoreBaselineSnapshot(snapshot, config) {
        const startTime = performance.now();

        // Restore preprocessing state — if the cached archetype used a different
        // filter intensity, swap the proxyBuffer to match
        if (snapshot.preprocessingIntensity !== this._proxyPreprocessingIntensity && this._rawProxyBuffer) {
            const intensity = snapshot.preprocessingIntensity;
            if (intensity && intensity !== 'off') {
                const buf = new Uint16Array(this._rawProxyBuffer);
                const isHeavy = intensity === 'heavy';
                const radius = isHeavy ? 5 : 3;
                BilateralFilter.applyBilateralFilterLab(buf, snapshot.width, snapshot.height, radius, 5000);
                this.proxyBuffer = buf;
            } else {
                this.proxyBuffer = this._rawProxyBuffer;
            }
            this._proxyPreprocessingIntensity = intensity;
        }

        // Deep-copy into _baselineState
        this._baselineState = {
            palette: snapshot.palette.map(c => ({ ...c })),
            rgbPalette: snapshot.rgbPalette ? snapshot.rgbPalette.map(c =>
                typeof c === 'string' ? c : { ...c }
            ) : null,
            colorIndices: new Uint8Array(snapshot.colorIndices),
            masks: snapshot.masks.map(m => new Uint8Array(m)),
            width: snapshot.width,
            height: snapshot.height,
            distanceMetric: snapshot.distanceMetric || 'cie76',
            metadata: { ...(snapshot.metadata || {}) }
        };

        // Also set separationState from the restored baseline
        this._restoreFromBaseline();

        // Sync metadata that rePosterize normally sets
        if (config) {
            this.sourceMetadata.targetColors = config.targetColors || config.targetColorsSlider || 0;
            this._substrateMode = config.substrateMode || 'auto';
        }

        // Generate clean preview (no knobs)
        const previewBuffer = this._generatePreviewFromIndices(
            this.separationState.colorIndices,
            this.separationState.rgbPalette,
            snapshot.width,
            snapshot.height
        );

        const elapsed = performance.now() - startTime;

        return {
            previewBuffer,
            palette: this.separationState.palette,
            dimensions: { width: snapshot.width, height: snapshot.height },
            metadata: this.separationState.metadata,
            elapsedMs: elapsed
        };
    }

    /**
     * Stride subsample — picks every Nth pixel, no interpolation.
     * Stride computed dynamically to target PROXY_TARGET_SIZE (800px long edge).
     * For small images already under target, stride=1 (no downsampling).
     * @private
     */
    _strideSubsample(labPixels, srcWidth, srcHeight) {
        const longEdge = Math.max(srcWidth, srcHeight);
        const s = Math.max(1, Math.ceil(longEdge / ProxyEngine.PROXY_TARGET_SIZE));
        const dstWidth = Math.ceil(srcWidth / s);
        const dstHeight = Math.ceil(srcHeight / s);
        const dstBuffer = new Uint16Array(dstWidth * dstHeight * 3);

        let dp = 0;
        for (let y = 0; y < srcHeight; y += s) {
            for (let x = 0; x < srcWidth; x += s) {
                const sp = (y * srcWidth + x) * 3;
                dstBuffer[dp++] = labPixels[sp];
                dstBuffer[dp++] = labPixels[sp + 1];
                dstBuffer[dp++] = labPixels[sp + 2];
            }
        }

        return {
            buffer: dstBuffer,
            width: dstWidth,
            height: dstHeight
        };
    }

    /**
     * Apply all mechanical knobs from a config/paramChanges object.
     * @private
     */
    async _applyKnobs(params) {
        if (params.minVolume !== undefined) {
            await this._applyMinVolume(params.minVolume);
        }
        if (params.speckleRescue !== undefined) {
            await this._applySpeckleRescue(params.speckleRescue);
        }
        if (params.shadowClamp !== undefined) {
            await this._applyShadowClamp(params.shadowClamp);
        }
    }

    /**
     * Apply minVolume pruning — delegates to MechanicalKnobs.
     * @private
     */
    async _applyMinVolume(minVolumePercent) {
        const { palette, colorIndices, width, height } = this.separationState;
        const pixelCount = width * height;
        const target = this.sourceMetadata?.targetColors || 0;
        const maxColors = target > 0 ? target + 2 : 0;

        MechanicalKnobs.applyMinVolume(colorIndices, palette, pixelCount, minVolumePercent, { maxColors });

        // Rebuild masks (pruned colors get all-zero masks)
        await this._rebuildMasks();
    }

    /**
     * Apply speckle rescue — delegates to MechanicalKnobs.
     * Passes originalWidth for proxy-aware threshold scaling.
     * @private
     */
    async _applySpeckleRescue(thresholdPixels) {
        const { masks, colorIndices, width, height } = this.separationState;
        const originalWidth = this.sourceMetadata && this.sourceMetadata.originalWidth;

        MechanicalKnobs.applySpeckleRescue(
            masks, colorIndices, width, height, thresholdPixels, originalWidth
        );
    }

    /**
     * Apply shadow clamp — delegates to MechanicalKnobs.
     * @private
     */
    async _applyShadowClamp(clampPercent) {
        const { masks, colorIndices, palette, width, height } = this.separationState;

        MechanicalKnobs.applyShadowClamp(
            masks, colorIndices, palette, width, height, clampPercent
        );
    }

    /**
     * Re-run separation with updated palette
     * @private
     */
    async _recomputeSeparation() {

        // Get new color indices — use the archetype's metric (not hardcoded CIE76)
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            this.proxyBuffer,
            this.separationState.palette,
            null,
            this.separationState.width,
            this.separationState.height,
            { ditherType: 'none', distanceMetric: this.separationState.distanceMetric || 'cie76' }
        );

        // Generate new masks
        const masks = [];
        for (let i = 0; i < this.separationState.palette.length; i++) {
            const mask = SeparationEngine.generateLayerMask(
                colorIndices,
                i,
                this.separationState.width,
                this.separationState.height
            );
            masks.push(mask);
        }

        this.separationState.colorIndices = colorIndices;
        this.separationState.masks = masks;

    }

    /**
     * Rebuild masks from color indices
     * @private
     */
    async _rebuildMasks() {
        const { width, height, colorIndices, palette } = this.separationState;
        const numColors = palette.length;
        const totalPixels = width * height;

        // Create new masks
        const masks = [];
        for (let i = 0; i < numColors; i++) {
            masks.push(new Uint8Array(totalPixels));
        }

        // Populate masks
        for (let i = 0; i < totalPixels; i++) {
            const colorIdx = colorIndices[i];
            masks[colorIdx][i] = 255;
        }

        this.separationState.masks = masks;
    }

    /**
     * Generate RGBA preview buffer from color indices
     * @private
     */
    _generatePreviewFromIndices(colorIndices, rgbPalette, width, height) {
        if (!rgbPalette || !colorIndices) {
            throw new Error('Missing rgbPalette or colorIndices');
        }

        const pixelCount = width * height;
        const previewBuffer = new Uint8ClampedArray(pixelCount * 4);

        for (let i = 0; i < pixelCount; i++) {
            const colorIdx = colorIndices[i];

            if (colorIdx >= rgbPalette.length) {
                logger.error(`[ProxyEngine] Color index ${colorIdx} out of bounds (palette size: ${rgbPalette.length})`);
                continue;
            }

            const colorEntry = rgbPalette[colorIdx];

            if (!colorEntry) {
                logger.error(`[ProxyEngine] Undefined color at index ${colorIdx}`);
                continue;
            }

            // Handle both hex strings and {r, g, b} objects
            let color;
            if (typeof colorEntry === 'string') {
                // It's a hex string, convert it
                color = this._hexToRgb(colorEntry);
            } else {
                // It's already an {r, g, b} object
                color = colorEntry;
            }

            const idx = i * 4;
            previewBuffer[idx] = color.r;
            previewBuffer[idx + 1] = color.g;
            previewBuffer[idx + 2] = color.b;
            previewBuffer[idx + 3] = 255; // Alpha
        }

        return previewBuffer;
    }

    /**
     * Generate preview RGBA buffer from masks (post-knob).
     * Pixels where the assigned mask was removed (despeckled) are shown in
     * the color of whatever mask still covers them. If NO mask covers a pixel
     * (minVolume pruned the color entirely), fall back to colorIndices.
     * Speckle-removed pixels visually merge into their surroundings — they
     * don't show as white because in print they'd absorb into the adjacent ink.
     * @private
     */
    _generatePreviewFromMasks(masks, colorIndices, rgbPalette, width, height) {
        const pixelCount = width * height;
        const previewBuffer = new Uint8ClampedArray(pixelCount * 4);
        const numColors = masks.length;

        for (let i = 0; i < pixelCount; i++) {
            const idx = i * 4;
            const ci = colorIndices[i];
            let colorIdx = ci;

            // If assigned color's mask was eroded, find another active mask
            if (ci >= numColors || masks[ci][i] === 0) {
                let found = -1;
                for (let c = 0; c < numColors; c++) {
                    if (masks[c][i] > 0) {
                        found = c;
                        break;
                    }
                }
                // Fall back to original colorIndices if no mask active
                // (e.g. minVolume pruned the color — it remaps via colorIndices)
                colorIdx = found >= 0 ? found : ci;
            }

            if (colorIdx < rgbPalette.length) {
                const color = typeof rgbPalette[colorIdx] === 'string'
                    ? this._hexToRgb(rgbPalette[colorIdx])
                    : rgbPalette[colorIdx];
                previewBuffer[idx]     = color.r;
                previewBuffer[idx + 1] = color.g;
                previewBuffer[idx + 2] = color.b;
            } else {
                previewBuffer[idx]     = 255;
                previewBuffer[idx + 1] = 255;
                previewBuffer[idx + 2] = 255;
            }
            previewBuffer[idx + 3] = 255;
        }

        return previewBuffer;
    }

    /**
     * Convert hex color string to RGB object
     * @private
     */
    _hexToRgb(hex) {
        // Remove # if present
        hex = hex.replace(/^#/, '');

        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);

        return { r, g, b };
    }
}

// CommonJS export
module.exports = ProxyEngine;
