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

const PosterizationEngine = require('./PosterizationEngine');
const SeparationEngine = require('./SeparationEngine');
const PreviewEngine = require('./PreviewEngine');
const BilateralFilter = require('../preprocessing/BilateralFilter');
const MechanicalKnobs = require('./MechanicalKnobs');
const DNAFidelity = require('../metrics/DNAFidelity');

class ProxyEngine {
    static PROXY_SIZE = 800; // Fixed resolution for long edge

    constructor() {
        this.proxyBuffer = null;        // 512px 16-bit LAB buffer
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
        const startTime = performance.now();

        // 1. Downsample to 800px (long edge) — skip if input already at proxy size
        //    When Photoshop GPU handles downsampling via targetSize, the input
        //    arrives pre-sized and redundant bilinear is wasteful.
        let proxyBuffer, proxyW, proxyH;
        const longEdge = Math.max(width, height);
        if (longEdge <= ProxyEngine.PROXY_SIZE) {
            // Already at or below proxy size — use input directly
            proxyBuffer = labPixels;
            proxyW = width;
            proxyH = height;
        } else {
            const result = this._downsampleBilinear(labPixels, width, height);
            proxyBuffer = result.buffer;
            proxyW = result.width;
            proxyH = result.height;
        }

        // 2. Bilateral filter preprocessing (matches reveal-adobe pipeline)
        const preprocessingIntensity = initialConfig.preprocessingIntensity || 'auto';
        if (preprocessingIntensity !== 'off') {
            const is16Bit = true; // ProxyEngine always uses 16-bit Lab
            const isHeavy = preprocessingIntensity === 'heavy';
            const radius = isHeavy ? 5 : 3;
            const sigmaR = is16Bit ? 5000 : 3000;
            BilateralFilter.applyBilateralFilterLab(proxyBuffer, proxyW, proxyH, radius, sigmaR);
        }

        this.proxyBuffer = proxyBuffer;

        // Proxy-safe config: disable snap/prune/densityFloor to prevent palette
        // collapse at proxy resolution. Even at 800px, CIE94/CIE2000 archetypes
        // with enablePaletteReduction=true can merge minority colors (e.g. green
        // on the Jethro image). Production uses the locked proxy palette (no
        // re-posterization), so these overrides don't cause preview-vs-production
        // divergence.
        // format: 'lab' is CRITICAL — input is 16-bit Lab, not RGB.
        const proxyConfig = {
            ...initialConfig,
            format: 'lab',
            snapThreshold: 0,
            enablePaletteReduction: false,
            densityFloor: 0,
            preservedUnifyThreshold: 0.5
        };

        // ═══ DIAGNOSTIC: Full posterize config dump ═══
        console.log(`\n═══ [ProxyEngine.initializeProxy] POSTERIZE PARAMS ═══`);
        console.log(`  Image: ${proxyW}×${proxyH} (from ${width}×${height}), format=${proxyConfig.format}, bitDepth=${proxyConfig.bitDepth}`);
        console.log(`  targetColors: ${proxyConfig.targetColors}`);
        console.log(`  engineType: ${proxyConfig.engineType}`);
        console.log(`  centroidStrategy: ${proxyConfig.centroidStrategy}`);
        console.log(`  distanceMetric: ${proxyConfig.distanceMetric}`);
        console.log(`  enableHueGapAnalysis: ${proxyConfig.enableHueGapAnalysis}`);
        console.log(`  enablePaletteReduction: ${proxyConfig.enablePaletteReduction}`);
        console.log(`  paletteReduction: ${proxyConfig.paletteReduction}`);
        console.log(`  densityFloor: ${proxyConfig.densityFloor}`);
        console.log(`  snapThreshold: ${proxyConfig.snapThreshold}`);
        console.log(`  preservedUnifyThreshold: ${proxyConfig.preservedUnifyThreshold}`);
        console.log(`  preserveWhite: ${proxyConfig.preserveWhite}, preserveBlack: ${proxyConfig.preserveBlack}`);
        console.log(`  substrateMode: ${proxyConfig.substrateMode}, substrateTolerance: ${proxyConfig.substrateTolerance}`);
        console.log(`  vibrancyMode: ${proxyConfig.vibrancyMode}, vibrancyBoost: ${proxyConfig.vibrancyBoost}`);
        console.log(`  highlightThreshold: ${proxyConfig.highlightThreshold}, highlightBoost: ${proxyConfig.highlightBoost}`);
        console.log(`  lWeight: ${proxyConfig.lWeight}, cWeight: ${proxyConfig.cWeight}, blackBias: ${proxyConfig.blackBias}`);
        console.log(`  isolationThreshold: ${proxyConfig.isolationThreshold}`);
        console.log(`  hueLockAngle: ${proxyConfig.hueLockAngle}, shadowPoint: ${proxyConfig.shadowPoint}`);
        console.log(`  tuning: ${proxyConfig.tuning ? JSON.stringify(proxyConfig.tuning) : 'NONE (using flat params)'}`);
        console.log(`  archetype: ${proxyConfig.name || 'unknown'} (id=${proxyConfig.id || 'unknown'})`);
        console.log(`  PROXY-SAFE OVERRIDES: snapThreshold=0, enablePaletteReduction=false, densityFloor=0, preservedUnifyThreshold=0.5`);
        console.log(`═══ END ProxyEngine.initializeProxy PARAMS ═══\n`);

        const posterizeResult = await PosterizationEngine.posterize(
            proxyBuffer,
            proxyW,
            proxyH,
            proxyConfig.targetColors,
            proxyConfig
        );

        // ═══ DIAGNOSTIC: Posterize result ═══
        if (posterizeResult.paletteLab) {
            console.log(`\n═══ [ProxyEngine.initializeProxy] POSTERIZE RESULT: ${posterizeResult.paletteLab.length} colors ═══`);
            posterizeResult.paletteLab.forEach((lab, i) => {
                const C = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
                const H = (Math.atan2(lab.b, lab.a) * 180 / Math.PI + 360) % 360;
                console.log(`  [${i}] L=${lab.L.toFixed(1)} a=${lab.a.toFixed(1)} b=${lab.b.toFixed(1)} C=${C.toFixed(1)} H=${H.toFixed(0)}°`);
            });
            console.log(`═══ END ProxyEngine.initializeProxy RESULT ═══\n`);
        }

        // 3. Run separation - get color indices
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            proxyBuffer,                // rawBytes
            posterizeResult.paletteLab, // labPalette
            null,                       // onProgress
            proxyW,                     // width
            proxyH,                     // height
            {
                ditherType: initialConfig.ditherType || 'none',
                distanceMetric: initialConfig.distanceMetric || 'cie76'
            }
        );

        // 4. Generate masks from color indices
        const masks = [];
        for (let i = 0; i < posterizeResult.paletteLab.length; i++) {
            const mask = SeparationEngine.generateLayerMask(colorIndices, i, proxyW, proxyH);
            masks.push(mask);
        }

        // 5. Cache separation state
        this.separationState = {
            palette: posterizeResult.paletteLab,
            rgbPalette: posterizeResult.palette,
            colorIndices: colorIndices,
            masks: masks,
            width: proxyW,
            height: proxyH,
            distanceMetric: initialConfig.distanceMetric || 'cie76',
            statistics: posterizeResult.statistics || {}
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
            statistics: this.separationState.statistics,
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

        // Proxy-safe overrides (same as initializeProxy — prevent palette collapse)
        const proxyConfig = {
            ...config,
            format: 'lab',
            snapThreshold: 0,
            enablePaletteReduction: false,
            densityFloor: 0,
            preservedUnifyThreshold: 0.5
        };

        // ═══ DIAGNOSTIC: Full posterize config dump ═══
        console.log(`\n═══ [ProxyEngine.rePosterize] POSTERIZE PARAMS ═══`);
        console.log(`  Image: ${proxyW}×${proxyH}, format=${proxyConfig.format}, bitDepth=${proxyConfig.bitDepth}`);
        console.log(`  targetColors: ${proxyConfig.targetColors}`);
        console.log(`  engineType: ${proxyConfig.engineType}`);
        console.log(`  centroidStrategy: ${proxyConfig.centroidStrategy}`);
        console.log(`  distanceMetric: ${proxyConfig.distanceMetric}`);
        console.log(`  enableHueGapAnalysis: ${proxyConfig.enableHueGapAnalysis}`);
        console.log(`  enablePaletteReduction: ${proxyConfig.enablePaletteReduction}`);
        console.log(`  paletteReduction: ${proxyConfig.paletteReduction}`);
        console.log(`  densityFloor: ${proxyConfig.densityFloor}`);
        console.log(`  snapThreshold: ${proxyConfig.snapThreshold}`);
        console.log(`  preservedUnifyThreshold: ${proxyConfig.preservedUnifyThreshold}`);
        console.log(`  preserveWhite: ${proxyConfig.preserveWhite}, preserveBlack: ${proxyConfig.preserveBlack}`);
        console.log(`  substrateMode: ${proxyConfig.substrateMode}, substrateTolerance: ${proxyConfig.substrateTolerance}`);
        console.log(`  vibrancyMode: ${proxyConfig.vibrancyMode}, vibrancyBoost: ${proxyConfig.vibrancyBoost}`);
        console.log(`  highlightThreshold: ${proxyConfig.highlightThreshold}, highlightBoost: ${proxyConfig.highlightBoost}`);
        console.log(`  lWeight: ${proxyConfig.lWeight}, cWeight: ${proxyConfig.cWeight}, blackBias: ${proxyConfig.blackBias}`);
        console.log(`  isolationThreshold: ${proxyConfig.isolationThreshold}`);
        console.log(`  hueLockAngle: ${proxyConfig.hueLockAngle}, shadowPoint: ${proxyConfig.shadowPoint}`);
        console.log(`  tuning: ${proxyConfig.tuning ? JSON.stringify(proxyConfig.tuning) : 'NONE (using flat params)'}`);
        console.log(`  archetype: ${proxyConfig.name || 'unknown'} (id=${proxyConfig.id || 'unknown'})`);
        console.log(`  PROXY-SAFE OVERRIDES: snapThreshold=0, enablePaletteReduction=false, densityFloor=0, preservedUnifyThreshold=0.5`);
        console.log(`═══ END ProxyEngine.rePosterize PARAMS ═══\n`);

        const posterizeResult = await PosterizationEngine.posterize(
            this.proxyBuffer,
            proxyW,
            proxyH,
            proxyConfig.targetColors,
            proxyConfig
        );

        // ═══ DIAGNOSTIC: Posterize result ═══
        if (posterizeResult.paletteLab) {
            console.log(`\n═══ [ProxyEngine.rePosterize] POSTERIZE RESULT: ${posterizeResult.paletteLab.length} colors ═══`);
            posterizeResult.paletteLab.forEach((lab, i) => {
                const C = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
                const H = (Math.atan2(lab.b, lab.a) * 180 / Math.PI + 360) % 360;
                console.log(`  [${i}] L=${lab.L.toFixed(1)} a=${lab.a.toFixed(1)} b=${lab.b.toFixed(1)} C=${C.toFixed(1)} H=${H.toFixed(0)}°`);
            });
            console.log(`═══ END ProxyEngine.rePosterize RESULT ═══\n`);
        }

        // 2. Separation
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            this.proxyBuffer,
            posterizeResult.paletteLab,
            null,
            proxyW,
            proxyH,
            {
                ditherType: config.ditherType || 'none',
                distanceMetric: config.distanceMetric || 'cie76'
            }
        );

        // 3. Masks
        const masks = [];
        for (let i = 0; i < posterizeResult.paletteLab.length; i++) {
            masks.push(SeparationEngine.generateLayerMask(colorIndices, i, proxyW, proxyH));
        }

        // 4. Update cached state (proxyBuffer unchanged)
        this.separationState = {
            palette: posterizeResult.paletteLab,
            rgbPalette: posterizeResult.palette,
            colorIndices,
            masks,
            width: proxyW,
            height: proxyH,
            distanceMetric: config.distanceMetric || 'cie76',
            statistics: posterizeResult.statistics || {}
        };

        // Update sourceMetadata.targetColors for the new archetype
        // (different archetypes may request different screen counts)
        this.sourceMetadata.targetColors = config.targetColors || config.targetColorsSlider || 0;

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
            statistics: this.separationState.statistics,
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

        // Apply palette override — swap ink colors without re-separating.
        // In screen printing, "override" means "same plate, different ink."
        // Plate assignments (colorIndices + masks) stay fixed from baseline;
        // only the palette and rgbPalette update so the preview shows
        // the new ink color on the existing plate coverage.
        // DO NOT call _recomputeSeparation() — that would redistribute
        // every pixel to nearest color, causing cascade: swatches rearrange,
        // paper reassigns, coverage shifts, revert lands on wrong swatch.
        if ('paletteOverride' in paramChanges) {
            this.separationState.palette = paramChanges.paletteOverride;
            this.separationState.rgbPalette = paramChanges.paletteOverride.map(
                lab => PosterizationEngine.labToRgb(lab)
            );
        }

        // Apply knobs on top (may prune, despeckle, clamp)
        await this._applyKnobs(paramChanges);

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
            statistics: this.separationState.statistics,
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

        // Proxy-safe overrides (same as initializeProxy/rePosterize)
        const proxyConfig = {
            ...config,
            format: 'lab',
            snapThreshold: 0,
            enablePaletteReduction: false,
            densityFloor: 0,
            preservedUnifyThreshold: 0.5
        };

        const result = await PosterizationEngine.posterize(
            this.proxyBuffer,
            proxyW,
            proxyH,
            proxyConfig.targetColors,
            proxyConfig
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

        const proxyConfig = {
            ...config,
            format: 'lab',
            snapThreshold: 0,
            enablePaletteReduction: false,
            densityFloor: 0,
            preservedUnifyThreshold: 0.5
        };

        const result = await PosterizationEngine.posterize(
            this.proxyBuffer, proxyW, proxyH,
            proxyConfig.targetColors, proxyConfig
        );

        // Run separation to get colorIndices for fidelity calculation
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            this.proxyBuffer, result.paletteLab, null, proxyW, proxyH,
            { ditherType: 'none', distanceMetric: config.distanceMetric || 'cie76' }
        );

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
    async getPaletteWithQuality(config) {
        if (!this.proxyBuffer || !this.separationState) {
            throw new Error('Proxy not initialized');
        }

        const proxyW = this.separationState.width;
        const proxyH = this.separationState.height;

        const proxyConfig = {
            ...config,
            format: 'lab',
            snapThreshold: 0,
            enablePaletteReduction: false,
            densityFloor: 0,
            preservedUnifyThreshold: 0.5
        };

        const result = await PosterizationEngine.posterize(
            this.proxyBuffer, proxyW, proxyH,
            proxyConfig.targetColors, proxyConfig
        );

        // Run nearest-neighbor separation (no dither) to get pixel assignments
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            this.proxyBuffer, result.paletteLab, null, proxyW, proxyH,
            { ditherType: 'none', distanceMetric: 'cie76' }
        );

        // Compute mean CIE76 ΔE between original proxy and posterized assignment
        const palette = result.paletteLab;
        const buf = this.proxyBuffer;
        const pixelCount = proxyW * proxyH;
        const palL = new Float64Array(palette.length);
        const palA = new Float64Array(palette.length);
        const palB = new Float64Array(palette.length);
        for (let j = 0; j < palette.length; j++) {
            palL[j] = palette[j].L;
            palA[j] = palette[j].a;
            palB[j] = palette[j].b;
        }

        let sumDE = 0;
        for (let i = 0; i < pixelCount; i++) {
            const off = i * 3;
            const L = (buf[off] / 32768) * 100;
            const a = ((buf[off + 1] - 16384) / 16384) * 128;
            const b = ((buf[off + 2] - 16384) / 16384) * 128;
            const ci = colorIndices[i];
            const dL = L - palL[ci];
            const da = a - palA[ci];
            const db = b - palB[ci];
            sumDE += Math.sqrt(dL * dL + da * da + db * db);
        }

        return {
            labPalette: result.paletteLab,
            rgbPalette: result.palette,
            meanDeltaE: sumDE / pixelCount
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
            statistics: { ...s.statistics }
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
            statistics: { ...b.statistics }
        };
    }

    /**
     * Bilinear downsample to 800px (long edge)
     * @private
     */
    _downsampleBilinear(labPixels, srcWidth, srcHeight) {
        // Calculate target dimensions (800px on long edge)
        const longEdge = Math.max(srcWidth, srcHeight);
        const scale = ProxyEngine.PROXY_SIZE / longEdge;

        const dstWidth = Math.round(srcWidth * scale);
        const dstHeight = Math.round(srcHeight * scale);

        const dstBuffer = new Uint16Array(dstWidth * dstHeight * 3);

        // Bilinear interpolation
        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                const srcX = x / scale;
                const srcY = y / scale;

                const x0 = Math.floor(srcX);
                const y0 = Math.floor(srcY);
                const x1 = Math.min(x0 + 1, srcWidth - 1);
                const y1 = Math.min(y0 + 1, srcHeight - 1);

                const fx = srcX - x0;
                const fy = srcY - y0;

                // Interpolate L, a, b channels
                for (let c = 0; c < 3; c++) {
                    const v00 = labPixels[(y0 * srcWidth + x0) * 3 + c];
                    const v10 = labPixels[(y0 * srcWidth + x1) * 3 + c];
                    const v01 = labPixels[(y1 * srcWidth + x0) * 3 + c];
                    const v11 = labPixels[(y1 * srcWidth + x1) * 3 + c];

                    const v0 = v00 * (1 - fx) + v10 * fx;
                    const v1 = v01 * (1 - fx) + v11 * fx;
                    const v = v0 * (1 - fy) + v1 * fy;

                    dstBuffer[(y * dstWidth + x) * 3 + c] = Math.round(v);
                }
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
                console.error(`[ProxyEngine] Color index ${colorIdx} out of bounds (palette size: ${rgbPalette.length})`);
                continue;
            }

            const colorEntry = rgbPalette[colorIdx];

            if (!colorEntry) {
                console.error(`[ProxyEngine] Undefined color at index ${colorIdx}`);
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
