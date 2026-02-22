/**
 * PosterizationEngine - Color Quantization for Screen Printing
 *
 * Reduces images to limited color palettes (3-9 colors) using median cut algorithm.
 * Optimized for screen printing workflow - creates distinct, well-separated colors.
 *
 * MODULAR ARCHITECTURE (v3.0):
 * - LabMedianCut.js: Lab-space median cut quantization
 * - PaletteOps.js: Palette snap, prune, density floor, refinement
 * - HueGapRecovery.js: Hue sector analysis and gap recovery
 * - RgbMedianCut.js: Classic RGB median cut engine
 * - PixelAssignment.js: Stride-based pixel assignment
 * - CentroidStrategies.js: Centroid selection strategies
 * - ColorSpace.js: Lab/RGB conversions (legacy, unused by engine)
 * - HueAnalysis.js: Hue analysis (legacy, unused by engine)
 */

const logger = require("../utils/logger");

// Import modular components
const ColorSpace = require('./ColorSpace');
const HueAnalysis = require('./HueAnalysis');
const { CentroidStrategies } = require('./CentroidStrategies');
const PeakFinder = require('../analysis/PeakFinder');
const LabDistance = require('../color/LabDistance');

// Import extracted modules
const LabMedianCut = require('./LabMedianCut');
const PaletteOps = require('./PaletteOps');
const HueGapRecovery = require('./HueGapRecovery');
const RgbMedianCut = require('./RgbMedianCut');
const PixelAssignment = require('./PixelAssignment');

class PosterizationEngine {
    /**
     * MINIMUM VIABILITY THRESHOLDS
     *
     * Prevents "dust" (tiny stray color regions) from becoming separate screens.
     * Colors below these coverage thresholds are absorbed into neighbors or skipped.
     */
    static MIN_PRESERVED_COVERAGE = 0.001;  // 0.1% for preserved colors (white/black)
    static MIN_HUE_COVERAGE = 0.01;         // 1.0% for hue gap sectors
    static PRESERVED_UNIFY_THRESHOLD = 12.0; // ΔE to unify preserved colors with existing palette colors

    /**
     * CENTRALIZED TUNING PARAMETERS
     *
     * Balanced preset for complex images with skin tones, hair textures,
     * and dark backgrounds.
     *
     * Prevents "washout" by using Soft Peak centroid (top 5%) and Logic-Gated pruning.
     */
    static TUNING = {
        split: {
            highlightBoost: 2.2,    // Balanced multiplier for facial highlights
            vibrancyBoost: 1.6,     // Weights chroma-rich pixels (Greens/Skin)
            minVariance: 10         // Minimum variance to consider splitting
        },
        prune: {
            threshold: 9.0,         // Delta-E distance for merging
            hueLockAngle: 18,       // Degrees (Protects Green from Beige washout)
            whitePoint: 85,         // L-value protection floor for white layer
            shadowPoint: 15         // L-value ceiling for shadow protection (prevents merging L<15 with lighter colors)
        },
        centroid: {
            lWeight: 1.1,           // Saliency Lightness priority
            cWeight: 2.0,           // Saliency Chroma priority
            blackBias: 5.0          // Black boost multiplier (high priority for absolute black in halftones)
        }
    };

    // ========================================================================
    // Utility: Bit Depth Normalization
    // ========================================================================

    /**
     * Normalize bitDepth from various input formats to a number
     * @private
     */
    static _normalizeBitDepth(input) {
        if (typeof input === 'number') {
            return input;
        }
        if (typeof input === 'string') {
            const match = input.match(/(\d+)/);
            if (match) {
                return parseInt(match[1], 10);
            }
        }
        return 8; // Default
    }

    // ========================================================================
    // Public API: Engine Dispatcher
    // ========================================================================

    /**
     * Factory method: Posterize image using specified engine
     *
     * ENGINES:
     * - 'reveal': Lab Median Cut + Hue Gap Analysis (default, highest quality)
     * - 'balanced': Lab Median Cut only (fast, good quality)
     * - 'classic': RGB Median Cut (fastest, basic quality)
     * - 'stencil': Luminance-only quantization (monochrome separations)
     *
     * @param {Uint8ClampedArray|Float32Array} pixels - Pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} targetColors - Target palette size (1-20)
     * @param {Object} options - Engine options
     * @param {string} [options.engineType='reveal'] - Engine to use
     * @param {boolean} [options.enableGridOptimization=true] - Grid sampling (90% faster)
     * @param {boolean} [options.enableHueGapAnalysis] - Force-include missing hues (auto-enabled for 'reveal')
     * @param {number} [options.snapThreshold=8.0] - Perceptual snap threshold (ΔE)
     * @param {string} [options.format='lab'] - Input format ('lab' or 'rgb')
     * @param {boolean} [options.grayscaleOnly=false] - L-channel only mode
     * @param {boolean} [options.preserveWhite=true] - Force white into palette
     * @param {boolean} [options.preserveBlack=true] - Force black into palette
     * @returns {Object} - {palette, paletteLab, assignments, labPixels, metadata}
     */
    static posterize(pixels, width, height, targetColors, options = {}) {
        // Default values
        const engineType = options.engineType || 'reveal';
        const enableGridOptimization = options.enableGridOptimization !== undefined
            ? options.enableGridOptimization
            : true; // DEFAULT TO ON (Architect's requirement)
        const snapThreshold = options.snapThreshold !== undefined ? options.snapThreshold : 8.0;

        // Hue gap analysis: disabled by default to respect exact color count
        // User can re-enable via options.enableHueGapAnalysis = true if desired
        const enableHueGapAnalysis = options.enableHueGapAnalysis !== undefined
            ? options.enableHueGapAnalysis
            : false;

        // STRATEGY SELECTION: Use user-provided strategy or default to SALIENCY for reveal, VOLUMETRIC for others
        const strategyName = options.centroidStrategy || ((engineType === 'reveal' || engineType === 'reveal-mk1.5') ? 'SALIENCY' : 'VOLUMETRIC');
        const strategy = CentroidStrategies[strategyName] || CentroidStrategies.SALIENCY;

        // Validate strategy is a function
        if (typeof strategy !== 'function') {
            logger.error(`❌ Invalid strategy: ${strategyName} is not a function. Available: ${Object.keys(CentroidStrategies).join(', ')}`);
            throw new Error(`Invalid centroid strategy: ${strategyName}`);
        }


        // Build tuning object from options if not provided
        // This allows presets to pass individual parameters (vibrancyBoost, highlightBoost, etc.)
        // without manually constructing the full tuning object
        const tuning = options.tuning || {
            split: {
                highlightBoost: options.highlightBoost !== undefined ? options.highlightBoost : this.TUNING.split.highlightBoost,
                vibrancyBoost: options.vibrancyBoost !== undefined ? options.vibrancyBoost : this.TUNING.split.vibrancyBoost,
                minVariance: this.TUNING.split.minVariance
            },
            prune: {
                threshold: options.paletteReduction !== undefined ? options.paletteReduction : this.TUNING.prune.threshold,
                hueLockAngle: options.hueLockAngle !== undefined ? options.hueLockAngle : this.TUNING.prune.hueLockAngle,
                whitePoint: options.highlightThreshold !== undefined ? options.highlightThreshold : this.TUNING.prune.whitePoint,
                shadowPoint: options.shadowPoint !== undefined ? options.shadowPoint : this.TUNING.prune.shadowPoint,
                isolationThreshold: options.isolationThreshold !== undefined ? options.isolationThreshold : 0.0
            },
            centroid: {
                lWeight: options.lWeight !== undefined ? options.lWeight : this.TUNING.centroid.lWeight,
                cWeight: options.cWeight !== undefined ? options.cWeight : this.TUNING.centroid.cWeight,
                bWeight: options.bWeight !== undefined ? options.bWeight : 1.0,
                blackBias: options.blackBias !== undefined ? options.blackBias : this.TUNING.centroid.blackBias,
                // Normalize bitDepth: handle "bitDepth16" string or number 16
                bitDepth: this._normalizeBitDepth(options.bitDepth),
                vibrancyMode: options.vibrancyMode || 'aggressive',  // 'aggressive', 'linear', 'exponential'
                vibrancyBoost: options.vibrancyBoost !== undefined ? options.vibrancyBoost : 2.2  // Exponential transform exponent
            }
        };

        // Log bitDepth source - either from passed tuning object or normalized from options
        const bitDepthSource = options.tuning ? 'tuning.centroid.bitDepth' : '_normalizeBitDepth(options.bitDepth)';

        // Dispatch to appropriate engine with strategy injection
        switch (engineType) {
            case 'reveal':
                return this._posterizeRevealMk1_0(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis, // Respect user setting (default: false)
                    snapThreshold,
                    strategy,
                    strategyName,  // Pass name for logging
                    tuning
                });

            case 'balanced':
                return this._posterizeBalanced(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis: false, // Always OFF for balanced
                    snapThreshold
                });

            case 'classic':
                return this._posterizeClassic(pixels, width, height, targetColors, options);

            case 'stencil':
                return this._posterizeStencil(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    grayscaleOnly: true // Force L-only
                });

            case 'lab-native':
                return this._posterizeLabNative(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis: false, // Keep it simple initially
                    strategy,
                    strategyName,
                    tuning
                });

            case 'forced-centroid':
                return this._posterizeForcedCentroid(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis: false,  // Disable for clinical mode
                    snapThreshold,
                    strategy,
                    strategyName,
                    tuning,
                    forcedCentroids: options.forcedCentroids || []  // NEW: anchor array
                });

            case 'reveal-mk1.5':
            case 'reveal-mk2':   // Same posterization as Mk 1.5, different param generation
                return this._posterizeRevealMk1_5(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis,  // Respect user setting (same as Mk 1.0)
                    snapThreshold,
                    strategy,
                    strategyName,
                    tuning
                });

            default:
                logger.warn(`⚠️ Unknown engine type '${engineType}', falling back to 'reveal'`);
                return this._posterizeRevealMk1_0(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis, // Respect user setting (default: false)
                    snapThreshold,
                    strategy,
                    strategyName,  // Pass name for logging
                    tuning
                });
        }
    }

    // ========================================================================
    // Color Conversion (kept inline — has gamut mapping logic)
    // ========================================================================

    /**
     * Convert sRGB color to CIELAB color space
     * Pipeline: sRGB → Linear RGB → XYZ → CIELAB (D65 illuminant)
     */
    static rgbToLab(rgb) {
        const r = this._gammaToLinear(rgb.r / 255);
        const g = this._gammaToLinear(rgb.g / 255);
        const b = this._gammaToLinear(rgb.b / 255);

        let x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
        let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
        let z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;

        x = x / 0.95047;
        y = y / 1.00000;
        z = z / 1.08883;

        x = this._xyzToLabHelper(x);
        y = this._xyzToLabHelper(y);
        z = this._xyzToLabHelper(z);

        const L = 116 * y - 16;
        const a = 500 * (x - y);
        const b_value = 200 * (y - z);

        return { L, a, b: b_value };
    }

    /**
     * Convert CIELAB color to sRGB color space with gamut mapping
     * Pipeline: CIELAB → XYZ → Linear RGB → sRGB
     */
    static labToRgb(lab) {
        const MAX_ITERATIONS = 20;
        let currentLab = { L: lab.L, a: lab.a, b: lab.b };
        let iteration = 0;
        let inGamut = false;

        while (!inGamut && iteration < MAX_ITERATIONS) {
            let y = (currentLab.L + 16) / 116;
            let x = currentLab.a / 500 + y;
            let z = y - currentLab.b / 200;

            x = this._labToXyzHelper(x) * 0.95047;
            y = this._labToXyzHelper(y) * 1.00000;
            z = this._labToXyzHelper(z) * 1.08883;

            let r = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
            let g = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
            let b = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

            r = this._linearToGamma(r);
            g = this._linearToGamma(g);
            b = this._linearToGamma(b);

            if (r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1) {
                inGamut = true;
                return {
                    r: Math.round(r * 255),
                    g: Math.round(g * 255),
                    b: Math.round(b * 255)
                };
            }

            currentLab.a *= 0.95;
            currentLab.b *= 0.95;
            iteration++;
        }

        // Fallback: clamp
        let y = (currentLab.L + 16) / 116;
        let x = currentLab.a / 500 + y;
        let z = y - currentLab.b / 200;

        x = this._labToXyzHelper(x) * 0.95047;
        y = this._labToXyzHelper(y) * 1.00000;
        z = this._labToXyzHelper(z) * 1.08883;

        let r = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
        let g = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
        let b = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

        r = this._linearToGamma(r);
        g = this._linearToGamma(g);
        b = this._linearToGamma(b);

        r = Math.max(0, Math.min(255, Math.round(r * 255)));
        g = Math.max(0, Math.min(255, Math.round(g * 255)));
        b = Math.max(0, Math.min(255, Math.round(b * 255)));

        return { r, g, b };
    }

    /** @private sRGB gamma correction (inverse): sRGB → Linear RGB */
    static _gammaToLinear(channel) {
        if (channel <= 0.04045) {
            return channel / 12.92;
        } else {
            return Math.pow((channel + 0.055) / 1.055, 2.4);
        }
    }

    /** @private sRGB gamma correction (forward): Linear RGB → sRGB */
    static _linearToGamma(channel) {
        if (channel <= 0.0031308) {
            return channel * 12.92;
        } else {
            return 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
        }
    }

    /** @private XYZ to Lab helper function (CIE standard function) */
    static _xyzToLabHelper(t) {
        const delta = 6 / 29;
        if (t > delta * delta * delta) {
            return Math.pow(t, 1 / 3);
        } else {
            return t / (3 * delta * delta) + 4 / 29;
        }
    }

    /** @private Lab to XYZ helper function (CIE standard function inverse) */
    static _labToXyzHelper(t) {
        const delta = 6 / 29;
        if (t > delta) {
            return t * t * t;
        } else {
            return 3 * delta * delta * (t - 4 / 29);
        }
    }

    // ========================================================================
    // Public API: Substrate Detection (kept inline — small, standalone)
    // ========================================================================

    /**
     * Auto-detect substrate color from image corners (preview resolution)
     */
    static autoDetectSubstrate(labBytes, width, height, bitDepth = 16) {
        const SAMPLE_SIZE = 10;
        let sumL = 0, sumA = 0, sumB = 0, count = 0;

        const maxValue = 32768;
        const neutralAB = 16384;
        const abScale = 128 / 16384;

        const sample = (x, y) => {
            const i = (y * width + x) * 3;
            sumL += (labBytes[i] / maxValue) * 100;
            sumA += (labBytes[i + 1] - neutralAB) * abScale;
            sumB += (labBytes[i + 2] - neutralAB) * abScale;
            count++;
        };

        for (let y = 0; y < SAMPLE_SIZE; y++) {
            for (let x = 0; x < SAMPLE_SIZE; x++) {
                sample(x, y);
                sample(width - 1 - x, y);
                sample(x, height - 1 - y);
                sample(width - 1 - x, height - 1 - y);
            }
        }

        const detectedSubstrate = {
            L: sumL / count,
            a: sumA / count,
            b: sumB / count
        };

        return detectedSubstrate;
    }

    // ========================================================================
    // Public API: Palette Utilities (kept inline — small helpers)
    // ========================================================================

    /**
     * Convert palette to hex color strings for display
     */
    static paletteToHex(palette) {
        return palette.map(color => {
            const r = color.r.toString(16).padStart(2, '0');
            const g = color.g.toString(16).padStart(2, '0');
            const b = color.b.toString(16).padStart(2, '0');
            return `#${r}${g}${b}`.toUpperCase();
        });
    }

    /**
     * Calculate perceptual distance (CIE76 ΔE) between two hex colors
     */
    static calculateHexDistance(hex1, hex2) {
        const rgb1 = {
            r: parseInt(hex1.slice(1, 3), 16),
            g: parseInt(hex1.slice(3, 5), 16),
            b: parseInt(hex1.slice(5, 7), 16)
        };
        const rgb2 = {
            r: parseInt(hex2.slice(1, 3), 16),
            g: parseInt(hex2.slice(3, 5), 16),
            b: parseInt(hex2.slice(5, 7), 16)
        };

        return RgbMedianCut._colorDistance(rgb1, rgb2);
    }

    // ========================================================================
    // Public API: Backward-Compatible Delegates
    // ========================================================================

    /** Delegate to PaletteOps */
    static calculateCIELABDistance(lab1, lab2, isGrayscale = false) {
        return PaletteOps.calculateCIELABDistance(lab1, lab2, isGrayscale);
    }

    /** Delegate to PaletteOps */
    static applyPerceptualSnap(palette, threshold = 8.0, isGrayscale = false, vibrancyMultiplier = 2.0, strategy = null, tuning = null) {
        return PaletteOps.applyPerceptualSnap(palette, threshold, isGrayscale, vibrancyMultiplier, strategy, tuning);
    }

    /** Delegate to LabMedianCut */
    static medianCutInLabSpace(labPixels, targetColors, grayscaleOnly = false, width = null, height = null, substrateLab = null, substrateTolerance = 3.5, vibrancyMode = 'aggressive', vibrancyBoost = 2.0, highlightThreshold = 92, highlightBoost = 3.0, strategy = null, tuning = null) {
        return LabMedianCut.medianCutInLabSpace(labPixels, targetColors, grayscaleOnly, width, height, substrateLab, substrateTolerance, vibrancyMode, vibrancyBoost, highlightThreshold, highlightBoost, strategy, tuning);
    }

    /** Delegate to RgbMedianCut */
    static analyzeOptimalColorCount(pixels, width, height) {
        return RgbMedianCut.analyzeOptimalColorCount(pixels, width, height);
    }

    /** Delegate to PixelAssignment */
    static reassignWithStride(labPixels, paletteLab, width, height, stride = 1, bitDepth = 16, options = {}) {
        return PixelAssignment.reassignWithStride(labPixels, paletteLab, width, height, stride, bitDepth, options);
    }

    /**
     * LEGACY: Backward compatibility wrapper
     * @deprecated Use posterize() with engineType='reveal' instead
     */
    static posterizeWithLabMedianCut(pixels, width, height, targetColors, snapThreshold = 8.0, options = {}) {
        logger.warn('⚠️ posterizeWithLabMedianCut() is deprecated. Use posterize({engineType: "reveal"}) instead.');
        return this.posterize(pixels, width, height, targetColors, {
            ...options,
            engineType: 'reveal',
            snapThreshold
        });
    }

    // ========================================================================
    // Internal Delegates (used by engine methods)
    // ========================================================================

    /** @private Delegate to PaletteOps */
    static _labDistance(lab1, lab2) {
        return PaletteOps._labDistance(lab1, lab2);
    }

    /** @private Delegate to PaletteOps */
    static _weightedLabDistance(lab1, lab2) {
        return PaletteOps._weightedLabDistance(lab1, lab2);
    }

    /** @private Delegate to PaletteOps */
    static _findNearestInPalette(targetLab, subPalette) {
        return PaletteOps._findNearestInPalette(targetLab, subPalette);
    }

    /** @private Delegate to PaletteOps */
    static _applyDensityFloor(assignments, palette, threshold = 0.005, protectedIndices = new Set()) {
        return PaletteOps._applyDensityFloor(assignments, palette, threshold, protectedIndices);
    }

    /** @private Delegate to PaletteOps */
    static _prunePalette(paletteLab, threshold = null, highlightThreshold = null, targetCount = 0, tuning = null, distanceMetric = 'cie76') {
        return PaletteOps._prunePalette(paletteLab, threshold, highlightThreshold, targetCount, tuning, distanceMetric);
    }

    /** @private Delegate to PaletteOps */
    static _refineKMeans(labPixels, palette) {
        return PaletteOps._refineKMeans(labPixels, palette);
    }

    /** @private Delegate to PaletteOps */
    static _getAdaptiveSnapThreshold(baseThreshold, targetColors, isGrayscale, lRange = 0, colorSpaceExtent = null) {
        return PaletteOps._getAdaptiveSnapThreshold(baseThreshold, targetColors, isGrayscale, lRange, colorSpaceExtent);
    }

    /** @private Delegate to LabMedianCut */
    static _analyzeColorSpace(labPixels) {
        return LabMedianCut._analyzeColorSpace(labPixels);
    }

    /** @private Delegate to HueGapRecovery */
    static _analyzeImageHueSectors(labPixels, chromaThreshold = 5) {
        return HueGapRecovery._analyzeImageHueSectors(labPixels, chromaThreshold);
    }

    /** @private Delegate to HueGapRecovery */
    static _analyzePaletteHueCoverage(palette, chromaThreshold = 5) {
        return HueGapRecovery._analyzePaletteHueCoverage(palette, chromaThreshold);
    }

    /** @private Delegate to HueGapRecovery */
    static _identifyHueGaps(imageHues, paletteCoverage, paletteColorCountsBySector = null) {
        return HueGapRecovery._identifyHueGaps(imageHues, paletteCoverage, paletteColorCountsBySector);
    }

    /** @private Delegate to HueGapRecovery */
    static _findTrueMissingHues(labPixels, currentPalette, gaps, options = {}) {
        return HueGapRecovery._findTrueMissingHues(labPixels, currentPalette, gaps, options);
    }

    /** @private Delegate to HueGapRecovery */
    static _forceIncludeHueGaps(colors, gaps, imageHues = null) {
        return HueGapRecovery._forceIncludeHueGaps(colors, gaps, imageHues);
    }

    /** @private Delegate to HueGapRecovery */
    static _getHueSector(a, b) {
        return HueGapRecovery._getHueSector(a, b);
    }

    /** @private Delegate to PaletteOps */
    static _calculateLabCentroid(colors, grayscaleOnly = false, strategy = null, tuning = null) {
        return PaletteOps._calculateLabCentroid(colors, grayscaleOnly, strategy, tuning);
    }

    /** @private Delegate to PaletteOps */
    static _mergeLabColors(c1, c2) {
        return PaletteOps._mergeLabColors(c1, c2);
    }

    /** @private Delegate to PaletteOps */
    static _mergeBySaliency(c1, c2) {
        return PaletteOps._mergeBySaliency(c1, c2);
    }

    /** @private Delegate to PaletteOps */
    static _getSaliencyWinner(c1, c2) {
        return PaletteOps._getSaliencyWinner(c1, c2);
    }

    /** @private Delegate to PaletteOps */
    static _snapToSource(targetLab, bucket) {
        return PaletteOps._snapToSource(targetLab, bucket);
    }

    /** @private Delegate to RgbMedianCut */
    static _posterizeClassicRgb(pixels, width, height, colorCount, colorDistance = 'cielab') {
        return RgbMedianCut._posterizeClassicRgb(pixels, width, height, colorCount, colorDistance);
    }

    /** @private Delegate to RgbMedianCut */
    static _extractColors(pixels, width, height) {
        return RgbMedianCut._extractColors(pixels, width, height);
    }

    /** @private Delegate to RgbMedianCut */
    static _medianCut(colors, targetCount) {
        return RgbMedianCut._medianCut(colors, targetCount);
    }

    /** @private Delegate to RgbMedianCut */
    static _splitToTarget(buckets, targetCount) {
        return RgbMedianCut._splitToTarget(buckets, targetCount);
    }

    /** @private Delegate to RgbMedianCut */
    static _getDistinctColors(palette, minDistance) {
        return RgbMedianCut._getDistinctColors(palette, minDistance);
    }

    /** @private Delegate to RgbMedianCut */
    static _rgbToLab(r, g, b) {
        return RgbMedianCut._rgbToLab(r, g, b);
    }

    /** @private Delegate to RgbMedianCut */
    static _colorDistance(color1, color2) {
        return RgbMedianCut._colorDistance(color1, color2);
    }

    /** @private Delegate to RgbMedianCut */
    static _getColorRanges(bucket) {
        return RgbMedianCut._getColorRanges(bucket);
    }

    /** @private Delegate to RgbMedianCut */
    static _splitBucket(bucket, channel) {
        return RgbMedianCut._splitBucket(bucket, channel);
    }

    /** @private Delegate to RgbMedianCut */
    static _checkBucketForHueSector(bucket, targetSector, chromaThreshold = 2) {
        return RgbMedianCut._checkBucketForHueSector(bucket, targetSector, chromaThreshold);
    }

    /** @private Delegate to RgbMedianCut */
    static _averageBucket(bucket) {
        return RgbMedianCut._averageBucket(bucket);
    }

    /** @private Delegate to RgbMedianCut */
    static _mapToPalette(pixels, width, height, palette, colorDistance = 'cielab') {
        return RgbMedianCut._mapToPalette(pixels, width, height, palette, colorDistance);
    }

    /** @private Delegate to RgbMedianCut */
    static _buildPalette(colors) {
        return RgbMedianCut._buildPalette(colors);
    }

    /** @private Delegate to LabMedianCut */
    static _splitBoxLab(box, grayscaleOnly = false, tuning = null) {
        return LabMedianCut._splitBoxLab(box, grayscaleOnly, tuning);
    }

    /** @private Delegate to LabMedianCut */
    static _calculateBoxMetadata(box, grayscaleOnly = false, vibrancyMode = 'aggressive', vibrancyMultiplier = 2.0, highlightThreshold = 92, highlightBoost = 3.0, tuning = null) {
        return LabMedianCut._calculateBoxMetadata(box, grayscaleOnly, vibrancyMode, vibrancyMultiplier, highlightThreshold, highlightBoost, tuning);
    }

    /** @private Delegate to LabMedianCut */
    static _calculateSplitPriority(box, sectorEnergy, coveredSectors, grayscaleOnly, hueMultiplier = 5.0, vibrancyMode = 'aggressive', vibrancyMultiplier = 2.0, highlightThreshold = 92, highlightBoost = 3.0, tuning = null) {
        return LabMedianCut._calculateSplitPriority(box, sectorEnergy, coveredSectors, grayscaleOnly, hueMultiplier, vibrancyMode, vibrancyMultiplier, highlightThreshold, highlightBoost, tuning);
    }

    /** @private Delegate to LabMedianCut */
    static _boxContainsHueSector(colors, targetSectors, chromaThreshold = 2.0) {
        return LabMedianCut._boxContainsHueSector(colors, targetSectors, chromaThreshold);
    }

    // ========================================================================
    // Engine: Reveal Mk 1.0
    // ========================================================================

    /**
     * Reveal Engine: Lab-space median cut with hue-aware gap analysis
     * @private
     */
    static _posterizeRevealMk1_0(pixels, width, height, targetColors, options = {}) {
        // 🔧 LEGACY V1 MODE: CIE76 = "Dumb" Euclidean math, no smart features
        const distanceMetric = options.distanceMetric || 'cie76';
        const isLegacyV1Mode = distanceMetric === 'cie76';

        let snapThreshold = options.snapThreshold !== undefined ? options.snapThreshold : 8.0;
        let enablePaletteReduction = options.enablePaletteReduction !== undefined ? options.enablePaletteReduction : true;
        let paletteReduction = options.paletteReduction !== undefined ? options.paletteReduction : 8.0;
        let preservedUnifyThreshold = options.preservedUnifyThreshold !== undefined ? options.preservedUnifyThreshold : 12.0;
        let densityFloor = options.densityFloor !== undefined ? options.densityFloor : 0.005;

        if (isLegacyV1Mode) {
            snapThreshold = 0.0;
            enablePaletteReduction = false;
            preservedUnifyThreshold = 0.5;
            densityFloor = 0.0;
            options.preservedUnifyThreshold = preservedUnifyThreshold;
            options.densityFloor = densityFloor;
        }

        const enableHueGapAnalysis = options.enableHueGapAnalysis !== undefined ? options.enableHueGapAnalysis : false;
        const grayscaleOnly = options.grayscaleOnly !== undefined ? options.grayscaleOnly : false;
        const preserveWhite = options.preserveWhite !== undefined ? options.preserveWhite : false;
        const preserveBlack = options.preserveBlack !== undefined ? options.preserveBlack : false;
        const vibrancyMode = options.vibrancyMode !== undefined ? options.vibrancyMode : 'aggressive';
        const vibrancyBoost = options.vibrancyBoost !== undefined ? options.vibrancyBoost : 2.0;
        const highlightThreshold = options.highlightThreshold !== undefined ? options.highlightThreshold : 92;
        const highlightBoost = options.highlightBoost !== undefined ? options.highlightBoost : 3.0;

        const preserveList = [];
        if (preserveWhite) preserveList.push('white');
        if (preserveBlack) preserveList.push('black');

        const startTime = performance.now();

        const isLabInput = options.format === 'lab';

        const sourceBitDepth = options.bitDepth || 16;
        const isEightBitSource = sourceBitDepth <= 8;

        // Step 1: Convert all pixels to Lab space
        let labPixels;
        let transparentPixels = new Set();

        if (isLabInput) {
            labPixels = new Float32Array(pixels.length);

            const shadowThreshold = isEightBitSource ? 7.5 : 6.0;
            const highlightThreshold = isEightBitSource ? 97.5 : 98.0;

            const maxValue = 32768;
            const neutralAB = 16384;
            const abScale = 128 / 16384;

            let minLRaw = Infinity, maxLRaw = -Infinity;
            let minARaw = Infinity, maxARaw = -Infinity;
            let minBRaw = Infinity, maxBRaw = -Infinity;
            let minL = Infinity, maxL = -Infinity;
            let minA = Infinity, maxA = -Infinity;
            let minB = Infinity, maxB = -Infinity;

            for (let i = 0; i < pixels.length; i += 3) {
                minLRaw = Math.min(minLRaw, pixels[i]);
                maxLRaw = Math.max(maxLRaw, pixels[i]);
                minARaw = Math.min(minARaw, pixels[i + 1]);
                maxARaw = Math.max(maxARaw, pixels[i + 1]);
                minBRaw = Math.min(minBRaw, pixels[i + 2]);
                maxBRaw = Math.max(maxBRaw, pixels[i + 2]);

                labPixels[i] = (pixels[i] / maxValue) * 100;
                labPixels[i + 1] = (pixels[i + 1] - neutralAB) * abScale;
                labPixels[i + 2] = (pixels[i + 2] - neutralAB) * abScale;

                if (labPixels[i] < shadowThreshold) {
                    labPixels[i] = 0;
                    labPixels[i + 1] = 0;
                    labPixels[i + 2] = 0;
                }
                else if (labPixels[i] > highlightThreshold) {
                    labPixels[i] = 100;
                    labPixels[i + 1] = 0;
                    labPixels[i + 2] = 0;
                }

                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
                minA = Math.min(minA, labPixels[i + 1]);
                maxA = Math.max(maxA, labPixels[i + 1]);
                minB = Math.min(minB, labPixels[i + 2]);
                maxB = Math.max(maxB, labPixels[i + 2]);
            }

        } else {
            const ALPHA_THRESHOLD = 10;
            labPixels = new Float32Array((pixels.length / 4) * 3);

            const sourceBitDepth = options.bitDepth || 8;
            const isEightBitSource = sourceBitDepth <= 8;
            const shadowThreshold = isEightBitSource ? 7.5 : 6.0;
            const highlightThreshold = isEightBitSource ? 97.5 : 98.0;

            for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
                const alpha = pixels[i + 3];

                if (alpha < ALPHA_THRESHOLD) {
                    transparentPixels.add(j / 3);
                }

                const rgb = { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] };
                const lab = this.rgbToLab(rgb);
                labPixels[j] = lab.L;
                labPixels[j + 1] = lab.a;
                labPixels[j + 2] = lab.b;

                if (labPixels[j] < shadowThreshold) {
                    labPixels[j] = 0;
                    labPixels[j + 1] = 0;
                    labPixels[j + 2] = 0;
                }
                else if (labPixels[j] > highlightThreshold) {
                    labPixels[j] = 100;
                    labPixels[j + 1] = 0;
                    labPixels[j + 2] = 0;
                }
            }
        }

        // Step 1.5: Separate preserved colors
        let preservedPixelMap = new Map();
        let nonPreservedIndices = [];
        let actualTargetColors = targetColors;

        if (preserveWhite || preserveBlack || transparentPixels.size > 0) {
            const WHITE_L_MIN = 95;
            const BLACK_L_MAX = 10;
            const AB_THRESHOLD = isEightBitSource ? 5 : 0.01;

            let blackLSamples = [];

            for (let i = 0; i < labPixels.length; i += 3) {
                const L = labPixels[i];
                const a = labPixels[i + 1];
                const b = labPixels[i + 2];
                const pixelIndex = i / 3;

                if (transparentPixels.has(pixelIndex)) {
                    continue;
                }

                let isPreserved = false;

                if (preserveWhite && L > WHITE_L_MIN && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                    if (!preservedPixelMap.has('white')) {
                        preservedPixelMap.set('white', new Set());
                    }
                    preservedPixelMap.get('white').add(pixelIndex);
                    isPreserved = true;
                }
                else if (preserveBlack && L < BLACK_L_MAX && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                    if (!preservedPixelMap.has('black')) {
                        preservedPixelMap.set('black', new Set());
                    }
                    preservedPixelMap.get('black').add(pixelIndex);
                    isPreserved = true;

                    if (blackLSamples.length < 10) {
                        blackLSamples.push(L.toFixed(2));
                    }
                }

                if (preserveBlack && !isPreserved && L < BLACK_L_MAX + 5 && blackLSamples.length < 20) {
                    blackLSamples.push(`${L.toFixed(2)}(near)`);
                }

                if (!isPreserved) {
                    nonPreservedIndices.push(pixelIndex);
                }
            }

            const totalPixels = labPixels.length / 3;

            preservedPixelMap.forEach((indices, colorName) => {
                const percent = ((indices.size / totalPixels) * 100).toFixed(1);
            });

            let numPreserved = 0;
            if (preserveWhite) numPreserved++;
            if (preserveBlack) numPreserved++;

            if (numPreserved > 0) {
                actualTargetColors = targetColors - numPreserved;
            }
        } else {
            for (let i = 0; i < labPixels.length / 3; i++) {
                if (!transparentPixels.has(i)) {
                    nonPreservedIndices.push(i);
                }
            }
        }

        // Extract non-preserved pixels
        let nonPreservedLabPixels = labPixels;
        if (nonPreservedIndices.length < labPixels.length / 3) {
            nonPreservedLabPixels = new Float32Array(nonPreservedIndices.length * 3);
            for (let i = 0; i < nonPreservedIndices.length; i++) {
                const srcIdx = nonPreservedIndices[i] * 3;
                nonPreservedLabPixels[i * 3] = labPixels[srcIdx];
                nonPreservedLabPixels[i * 3 + 1] = labPixels[srcIdx + 1];
                nonPreservedLabPixels[i * 3 + 2] = labPixels[srcIdx + 2];
            }
        }

        // Step 1.5: Substrate Detection
        let substrateLab = null;
        const substrateDisabled = options.substrateMode === 'none';

        if (isLabInput && !substrateDisabled) {
            if (!options.substrateMode || options.substrateMode === 'auto') {
                substrateLab = this.autoDetectSubstrate(pixels, width, height, options.bitDepth || 8);
            } else if (options.substrateMode === 'white') {
                substrateLab = { L: 100, a: 0, b: 0 };
            } else if (options.substrateMode === 'black') {
                substrateLab = { L: 0, a: 0, b: 0 };
            } else if (options.substrateLab) {
                substrateLab = options.substrateLab;
            }
        }

        let medianCutTarget = actualTargetColors;
        if (substrateLab) {
            medianCutTarget = actualTargetColors + 1;
        }

        // Step 2: Run median cut in Lab space
        let initialPaletteLab = LabMedianCut.medianCutInLabSpace(
            nonPreservedLabPixels,
            medianCutTarget,
            grayscaleOnly,
            width,
            height,
            substrateLab,
            options.substrateTolerance || 3.5,
            vibrancyMode,
            vibrancyBoost,
            highlightThreshold,
            highlightBoost,
            options.strategy || null,
            options.tuning || null
        );

        // Step 2.5: K-means refinement
        const refinementPasses = options.refinementPasses !== undefined ? options.refinementPasses : 1;
        if (!grayscaleOnly && initialPaletteLab.length > 1 && refinementPasses > 0) {
            for (let pass = 0; pass < refinementPasses; pass++) {
                initialPaletteLab = PaletteOps._refineKMeans(nonPreservedLabPixels, initialPaletteLab);
            }
        }

        // Step 3: Adaptive perceptual snap
        const colorSpaceAnalysis = LabMedianCut._analyzeColorSpace(labPixels);
        const isGrayscale = grayscaleOnly || colorSpaceAnalysis.chromaRange < 10;

        let lRange = 0;
        let colorSpaceExtent = null;

        if (isGrayscale) {
            let minL = Infinity, maxL = -Infinity;
            for (let i = 0; i < labPixels.length; i += 3) {
                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
            }
            lRange = maxL - minL;
        } else {
            let minL = Infinity, maxL = -Infinity;
            let minA = Infinity, maxA = -Infinity;
            let minB = Infinity, maxB = -Infinity;

            for (let i = 0; i < labPixels.length; i += 3) {
                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
                minA = Math.min(minA, labPixels[i + 1]);
                maxA = Math.max(maxA, labPixels[i + 1]);
                minB = Math.min(minB, labPixels[i + 2]);
                maxB = Math.max(maxB, labPixels[i + 2]);
            }

            colorSpaceExtent = {
                lRange: maxL - minL,
                aRange: maxA - minA,
                bRange: maxB - minB
            };
        }

        const adaptiveThreshold = PaletteOps._getAdaptiveSnapThreshold(
            snapThreshold,
            targetColors,
            isGrayscale,
            lRange,
            colorSpaceExtent
        );

        let curatedPaletteLab = PaletteOps.applyPerceptualSnap(
            initialPaletteLab,
            adaptiveThreshold,
            isGrayscale,
            vibrancyBoost,
            options.strategy || null,
            options.tuning || null
        );

        // Palette reduction
        if (enablePaletteReduction && curatedPaletteLab.length > targetColors) {
            const prunedPaletteLab = PaletteOps._prunePalette(curatedPaletteLab, paletteReduction, highlightThreshold, targetColors, options.tuning || null, distanceMetric);
            if (prunedPaletteLab.length < curatedPaletteLab.length) {
                curatedPaletteLab = prunedPaletteLab;
            }
        }

        // Unconditional similarity prune
        if (enablePaletteReduction) {
            const dedupThreshold = Math.max(paletteReduction, 2.0);
            const dedupResult = PaletteOps._prunePalette(curatedPaletteLab, dedupThreshold, highlightThreshold, 0, options.tuning || null, distanceMetric);
            if (dedupResult.length < curatedPaletteLab.length) {
                logger.log(`[Mk1.0] Similarity prune (ΔE<${dedupThreshold}): ${curatedPaletteLab.length} → ${dedupResult.length}`);
                curatedPaletteLab = dedupResult;
            }
        }

        // Hue gap analysis (AFTER snap & pruning)
        if (enableHueGapAnalysis && !grayscaleOnly) {
            if (!initialPaletteLab._allColors || !initialPaletteLab._labPixels) {
                logger.warn(`⚠️ [Hue-Aware Model] Cannot analyze hue gaps - palette data not preserved`);
            } else {
                const hueChromaThreshold = vibrancyMode === 'exponential' ? 1.0 : 5.0;
                const imageHues = HueGapRecovery._analyzeImageHueSectors(initialPaletteLab._labPixels, hueChromaThreshold);
                const { coveredSectors, colorCountsBySector } = HueGapRecovery._analyzePaletteHueCoverage(curatedPaletteLab, hueChromaThreshold);
                const gaps = HueGapRecovery._identifyHueGaps(imageHues, coveredSectors, colorCountsBySector);
                gaps.sort((a, b) => imageHues[b] - imageHues[a]);

                if (gaps.length > 0) {
                    const numPreservedSlots = (preserveWhite ? 1 : 0) + (preserveBlack ? 1 : 0);
                    const availableSlots = actualTargetColors - curatedPaletteLab.length - numPreservedSlots;

                    let gapsToFill;
                    if (availableSlots <= 0) {
                        gapsToFill = gaps;
                        if (gapsToFill.length > 3) {
                            gapsToFill = gaps.slice(0, 3);
                        }
                    } else {
                        gapsToFill = gaps.slice(0, availableSlots);
                    }

                    const candidateColors = HueGapRecovery._findTrueMissingHues(labPixels, curatedPaletteLab, gapsToFill);

                    const MIN_GAP_DISTANCE = 15.0;
                    const forcedColors = candidateColors.filter(candidate => {
                        const minDistanceFromPalette = Math.min(
                            ...curatedPaletteLab.map(p => PaletteOps._labDistance(candidate, p))
                        );
                        if (minDistanceFromPalette < MIN_GAP_DISTANCE) {
                            return false;
                        }
                        return true;
                    });

                    if (forcedColors.length > 0) {
                        forcedColors.forEach(c => { c._minVolumeExempt = true; });
                        curatedPaletteLab = curatedPaletteLab.concat(forcedColors);
                        const { coveredSectors: newCoverage } = HueGapRecovery._analyzePaletteHueCoverage(curatedPaletteLab);
                    }
                }
            }
        }

        // Final safety-net dedup
        {
            const finalDedupThreshold = enablePaletteReduction ? Math.max(paletteReduction, 2.0) : 2.0;
            const dedupFinal = PaletteOps._prunePalette(curatedPaletteLab, finalDedupThreshold, highlightThreshold, 0, options.tuning || null, distanceMetric);
            if (dedupFinal.length < curatedPaletteLab.length) {
                logger.log(`[Mk1.0] Final dedup: ${curatedPaletteLab.length} → ${dedupFinal.length} (removed ${curatedPaletteLab.length - dedupFinal.length} near-duplicates)`);
                curatedPaletteLab = dedupFinal;
            }
        }

        // Step 3.5: Add preserved colors
        const MIN_PRESERVED_COVERAGE = PosterizationEngine.MIN_PRESERVED_COVERAGE;
        const totalPixels = labPixels.length / 3;

        const preservedColors = [];
        let actuallyPreservedWhite = false;
        let actuallyPreservedBlack = false;

        if (preserveWhite) {
            const pixelCount = preservedPixelMap.has('white') ? preservedPixelMap.get('white').size : 0;
            const coverage = pixelCount / totalPixels;

            if (coverage >= MIN_PRESERVED_COVERAGE) {
                const absoluteWhite = { L: 100, a: 0, b: 0 };
                const UNIFY_THRESHOLD = options.preservedUnifyThreshold !== undefined
                    ? options.preservedUnifyThreshold
                    : PosterizationEngine.PRESERVED_UNIFY_THRESHOLD;

                const existingMatch = curatedPaletteLab.find(color =>
                    PaletteOps._labDistance(color, absoluteWhite) < UNIFY_THRESHOLD
                );

                if (!existingMatch) {
                    preservedColors.push(absoluteWhite);
                    actuallyPreservedWhite = true;
                }
            }
        }
        if (preserveBlack) {
            const pixelCount = preservedPixelMap.has('black') ? preservedPixelMap.get('black').size : 0;
            const coverage = pixelCount / totalPixels;

            if (coverage >= MIN_PRESERVED_COVERAGE) {
                const absoluteBlack = { L: 0, a: 0, b: 0 };
                const UNIFY_THRESHOLD = options.preservedUnifyThreshold !== undefined
                    ? options.preservedUnifyThreshold
                    : PosterizationEngine.PRESERVED_UNIFY_THRESHOLD;

                const existingMatch = curatedPaletteLab.find(color =>
                    PaletteOps._labDistance(color, absoluteBlack) < UNIFY_THRESHOLD
                );

                if (!existingMatch) {
                    preservedColors.push(absoluteBlack);
                    actuallyPreservedBlack = true;
                }
            }
        }

        // Step 3.6: Add substrate color
        const substrateColors = [];
        if (substrateLab) {
            if (substrateLab.L < 6.0) {
                // Dark substrate — skip
            } else if (substrateLab.L > 98.0) {
                // Bright substrate — skip
            } else {
                const DUPLICATE_THRESHOLD = 3.0;
                let isDuplicate = false;

                for (const preserved of preservedColors) {
                    const dL = substrateLab.L - preserved.L;
                    const da = substrateLab.a - preserved.a;
                    const db = substrateLab.b - preserved.b;
                    const deltaE = Math.sqrt(dL * dL + da * da + db * db);

                    if (deltaE < DUPLICATE_THRESHOLD) {
                        isDuplicate = true;
                        break;
                    }
                }

                if (!isDuplicate) {
                    substrateColors.push(substrateLab);
                }
            }
        }

        // Final palette assembly
        let finalPaletteLab = [...curatedPaletteLab, ...preservedColors, ...substrateColors];
        let paletteRgb = finalPaletteLab.map(lab => this.labToRgb(lab));

        // Step 5: Pixel assignment
        let assignments = new Uint16Array(pixels.length / (isLabInput ? 3 : 4));

        let preservedColorIndex = curatedPaletteLab.length;
        const whiteIndex = actuallyPreservedWhite ? preservedColorIndex++ : -1;
        const blackIndex = actuallyPreservedBlack ? preservedColorIndex++ : -1;

        const isPreview = options.isPreview === true;
        const useStride = isPreview && options.optimizePreview !== false;
        const ASSIGNMENT_STRIDE = useStride ? (options.previewStride || 4) : 1;

        const whiteSet = preservedPixelMap.get('white');
        const blackSet = preservedPixelMap.get('black');
        const paletteLength = finalPaletteLab.length;

        const palette16 = finalPaletteLab.map(p => ({
            L: (p.L / 100) * 32768,
            a: (p.a + 128) * 128,
            b: (p.b + 128) * 128
        }));

        const useInteger16 = isLabInput && pixels;

        for (let y = 0; y < height; y += ASSIGNMENT_STRIDE) {
            const rowOffset = y * width;

            for (let x = 0; x < width; x += ASSIGNMENT_STRIDE) {
                const anchorI = rowOffset + x;
                let anchorAssignment = 0;

                if (transparentPixels.has(anchorI)) {
                    anchorAssignment = 255;
                } else {
                    let isPreserved = false;

                    if (actuallyPreservedWhite && whiteSet && whiteSet.has(anchorI)) {
                        anchorAssignment = whiteIndex;
                        isPreserved = true;
                    } else if (actuallyPreservedBlack && blackSet && blackSet.has(anchorI)) {
                        anchorAssignment = blackIndex;
                        isPreserved = true;
                    }

                    if (!isPreserved) {
                        const idx = anchorI * 3;
                        let minDistance = Infinity;

                        if (useInteger16) {
                            const rawL = pixels[idx];
                            const rawA = pixels[idx + 1];
                            const rawB = pixels[idx + 2];

                            for (let j = 0; j < paletteLength; j++) {
                                const target16 = palette16[j];
                                const dL = rawL - target16.L;
                                const dA = rawA - target16.a;
                                const dB = rawB - target16.b;

                                const dist = grayscaleOnly ? (dL * dL) : (1.5 * dL * dL + dA * dA + dB * dB);

                                if (dist < minDistance) {
                                    minDistance = dist;
                                    anchorAssignment = j;
                                }
                            }
                        } else {
                            const pL = labPixels[idx];
                            const pA = labPixels[idx + 1];
                            const pB = labPixels[idx + 2];

                            for (let j = 0; j < paletteLength; j++) {
                                const target = finalPaletteLab[j];
                                const dL = pL - target.L;
                                const dA = pA - target.a;
                                const dB = pB - target.b;

                                const dist = grayscaleOnly ? (dL * dL) : (1.5 * dL * dL + dA * dA + dB * dB);

                                if (dist < minDistance) {
                                    minDistance = dist;
                                    anchorAssignment = j;
                                }
                            }
                        }
                    }
                }

                for (let bY = 0; bY < ASSIGNMENT_STRIDE && (y + bY) < height; bY++) {
                    const fillRow = (y + bY) * width;
                    for (let bX = 0; bX < ASSIGNMENT_STRIDE && (x + bX) < width; bX++) {
                        assignments[fillRow + (x + bX)] = anchorAssignment;
                    }
                }
            }
        }

        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(3);

        // Apply density floor
        const densityFloorThreshold = options.densityFloor !== undefined ? options.densityFloor : 0.005;

        if (densityFloorThreshold > 0) {
            const protectedIndices = new Set();
            if (actuallyPreservedWhite) protectedIndices.add(whiteIndex);
            if (actuallyPreservedBlack) protectedIndices.add(blackIndex);
            if (substrateLab) protectedIndices.add(finalPaletteLab.length - 1);

            const densityResult = PaletteOps._applyDensityFloor(
                assignments,
                finalPaletteLab,
                densityFloorThreshold,
                protectedIndices
            );

            if (densityResult.actualCount < finalPaletteLab.length) {
                finalPaletteLab = densityResult.palette;
                assignments = densityResult.assignments;
                paletteRgb = finalPaletteLab.map(lab => this.labToRgb(lab));
            }
        }

        const substrateIndex = substrateLab ? (curatedPaletteLab.length + preservedColors.length) : null;

        return {
            palette: paletteRgb,
            paletteLab: finalPaletteLab,
            assignments,
            labPixels,
            substrateLab,
            substrateIndex,
            metadata: {
                targetColors,
                finalColors: finalPaletteLab.length,
                snapThreshold,
                duration: parseFloat(duration)
            }
        };
    }

    // ========================================================================
    // Engine: Reveal Mk 1.5
    // ========================================================================

    /**
     * Reveal Mk 1.5 Engine: Deterministic Auto-Quantizer with Identity Peaks
     * @private
     */
    static _posterizeRevealMk1_5(pixels, width, height, targetColors, options = {}) {
        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_entry');

        const distanceMetric = options.distanceMetric || 'cie76';
        const isLegacyV1Mode = distanceMetric === 'cie76';

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_metric_parsed');

        let snapThreshold = options.snapThreshold !== undefined ? options.snapThreshold : 8.0;
        let enablePaletteReduction = options.enablePaletteReduction !== undefined ? options.enablePaletteReduction : true;
        let paletteReduction = options.paletteReduction !== undefined ? options.paletteReduction : 8.0;
        let preservedUnifyThreshold = options.preservedUnifyThreshold !== undefined ? options.preservedUnifyThreshold : 12.0;
        let densityFloor = options.densityFloor !== undefined ? options.densityFloor : 0.005;

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_thresholds_set');

        if (isLegacyV1Mode) {
            snapThreshold = 0.0;
            enablePaletteReduction = false;
            preservedUnifyThreshold = 0.5;
            densityFloor = 0.0;
            options.snapThreshold = snapThreshold;
            options.enablePaletteReduction = enablePaletteReduction;
            options.paletteReduction = paletteReduction;
            options.preservedUnifyThreshold = preservedUnifyThreshold;
            options.densityFloor = densityFloor;
        }

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_legacy_mode_done');

        const grayscaleOnly = options.grayscaleOnly !== undefined ? options.grayscaleOnly : false;
        const preserveWhite = options.preserveWhite !== undefined ? options.preserveWhite : false;
        const preserveBlack = options.preserveBlack !== undefined ? options.preserveBlack : false;
        const vibrancyMode = options.vibrancyMode !== undefined ? options.vibrancyMode : 'aggressive';
        const vibrancyBoost = options.vibrancyBoost !== undefined ? options.vibrancyBoost : 2.0;
        const highlightThreshold = options.highlightThreshold !== undefined ? options.highlightThreshold : 92;
        const highlightBoost = options.highlightBoost !== undefined ? options.highlightBoost : 3.0;

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_options_parsed');

        const preserveList = [];
        if (preserveWhite) preserveList.push('white');
        if (preserveBlack) preserveList.push('black');

        const startTime = performance.now();

        const isLabInput = options.format === 'lab';
        if (!isLabInput) {
            throw new Error('[Reveal Mk 1.5] Requires Lab input format (RGB not supported)');
        }

        const sourceBitDepth = options.bitDepth || 16;
        const isEightBitSource = sourceBitDepth <= 8;

        // Step 1: Convert to perceptual Lab space
        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_before_float32array');
        const labPixels = new Float32Array(pixels.length);
        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_float32array_allocated');

        const shadowThreshold = isEightBitSource ? 7.5 : 6.0;
        const highlightThresholdGate = isEightBitSource ? 97.5 : 98.0;

        const maxValue = 32768;
        const neutralAB = 16384;
        const abScale = 128 / 16384;

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_before_pixel_loop');

        for (let i = 0; i < pixels.length; i += 3) {
            labPixels[i] = (pixels[i] / maxValue) * 100;
            labPixels[i + 1] = (pixels[i + 1] - neutralAB) * abScale;
            labPixels[i + 2] = (pixels[i + 2] - neutralAB) * abScale;

            if (labPixels[i] < shadowThreshold) {
                labPixels[i] = 0;
                labPixels[i + 1] = 0;
                labPixels[i + 2] = 0;
            } else if (labPixels[i] > highlightThresholdGate) {
                labPixels[i] = 100;
                labPixels[i + 1] = 0;
                labPixels[i + 2] = 0;
            }
        }

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_pixel_loop_done');

        // Hard Chromance Gate
        const chromaGateThreshold = options.chromaGateThreshold !== undefined ? options.chromaGateThreshold : 0;

        if (chromaGateThreshold > 0) {
            let purgedCount = 0;

            for (let i = 0; i < labPixels.length; i += 3) {
                const a = labPixels[i + 1];
                const b = labPixels[i + 2];
                const chroma = Math.sqrt(a * a + b * b);

                if (chroma < chromaGateThreshold) {
                    labPixels[i + 1] = 0;
                    labPixels[i + 2] = 0;
                    purgedCount++;
                }
            }
        }

        // Shadow Chroma Gate
        const shadowChromaGateL = options.shadowChromaGateL !== undefined ? options.shadowChromaGateL : 0;

        if (shadowChromaGateL > 0) {
            let gatedCount = 0;
            for (let i = 0; i < labPixels.length; i += 3) {
                if (labPixels[i] < shadowChromaGateL) {
                    const a = labPixels[i + 1];
                    const b = labPixels[i + 2];
                    const chroma = Math.sqrt(a * a + b * b);
                    if (chroma < 20) {
                        labPixels[i + 1] = 0;
                        labPixels[i + 2] = 0;
                        gatedCount++;
                    }
                }
            }
        }

        // Identity Peak detection
        const peakFinderMaxPeaks = options.peakFinderMaxPeaks !== undefined ? options.peakFinderMaxPeaks : 1;
        const peakFinderPreferredSectors = options.peakFinderPreferredSectors || null;
        const peakFinderBlacklistedSectors = options.peakFinderBlacklistedSectors || [3, 4];

        let forcedCentroids = [];
        let usedPredefinedAnchors = false;
        let detectedPeaks = [];

        const forcedCentroidsInput = options.forcedCentroids || options.forced_centroids;

        if (forcedCentroidsInput && Array.isArray(forcedCentroidsInput) && forcedCentroidsInput.length > 0) {
            try {
                forcedCentroids = forcedCentroidsInput.map(anchor => {
                    const centroid = {
                        L: Number(anchor.L || anchor.l),
                        a: Number(anchor.a),
                        b: Number(anchor.b)
                    };
                    return centroid;
                });
                usedPredefinedAnchors = true;
            } catch (error) {
                logger.error(`  ✗ Error parsing forcedCentroids: ${error.message}`);
            }
        }

        if (!usedPredefinedAnchors) {
            const peakFinder = new PeakFinder({
                chromaThreshold: 30,
                volumeThreshold: 0.05,
                maxPeaks: peakFinderMaxPeaks,
                preferredSectors: peakFinderPreferredSectors,
                blacklistedSectors: peakFinderBlacklistedSectors
            });

            detectedPeaks = peakFinder.findIdentityPeaks(labPixels, { bitDepth: sourceBitDepth });

            forcedCentroids = detectedPeaks.map(peak => ({
                L: peak.L,
                a: peak.a,
                b: peak.b
            }));

            logger.log(`[Mk1.5] PeakFinder: ${detectedPeaks.length} peaks at ${width}x${height} (bitDepth=${sourceBitDepth}): ${detectedPeaks.map(p => `L=${p.L.toFixed(1)} a=${p.a.toFixed(1)} b=${p.b.toFixed(1)} C=${(Math.sqrt(p.a*p.a+p.b*p.b)).toFixed(1)}`).join(', ') || 'none'}`);
        }

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_peak_detection_done');

        // Preserved colors (white/black)
        let preservedPixelMap = new Map();
        let nonPreservedIndices = [];

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_before_preserved_detection');

        const WHITE_L_MIN = 95;
        const BLACK_L_MAX = 10;
        const AB_THRESHOLD = isEightBitSource ? 5 : 0.01;

        for (let i = 0; i < labPixels.length; i += 3) {
            const L = labPixels[i];
            const a = labPixels[i + 1];
            const b = labPixels[i + 2];
            const pixelIndex = i / 3;

            let isPreserved = false;

            if (preserveWhite && L > WHITE_L_MIN && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                if (!preservedPixelMap.has('white')) {
                    preservedPixelMap.set('white', new Set());
                }
                preservedPixelMap.get('white').add(pixelIndex);
                isPreserved = true;
            } else if (preserveBlack && L < BLACK_L_MAX && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                if (!preservedPixelMap.has('black')) {
                    preservedPixelMap.set('black', new Set());
                }
                preservedPixelMap.get('black').add(pixelIndex);
                isPreserved = true;
            }

            if (!isPreserved) {
                nonPreservedIndices.push(pixelIndex);
            }
        }

        const totalPixels = labPixels.length / 3;
        preservedPixelMap.forEach((indices, colorName) => {
            const percent = ((indices.size / totalPixels) * 100).toFixed(1);
        });

        // Slot reservation
        let numPreserved = 0;
        if (preserveWhite) numPreserved++;
        if (preserveBlack) numPreserved++;

        const numForced = forcedCentroids.length;
        const medianCutTarget = Math.max(1, targetColors - numForced - numPreserved);

        logger.log(`[Mk1.5] Slot budget: targetColors=${targetColors}, numForced=${numForced}, numPreserved=${numPreserved} → medianCutTarget=${medianCutTarget}`);

        // Extract non-preserved pixels
        let nonPreservedLabPixels = labPixels;
        if (nonPreservedIndices.length < labPixels.length / 3) {
            nonPreservedLabPixels = new Float32Array(nonPreservedIndices.length * 3);
            for (let i = 0; i < nonPreservedIndices.length; i++) {
                const srcIdx = nonPreservedIndices[i] * 3;
                nonPreservedLabPixels[i * 3] = labPixels[srcIdx];
                nonPreservedLabPixels[i * 3 + 1] = labPixels[srcIdx + 1];
                nonPreservedLabPixels[i * 3 + 2] = labPixels[srcIdx + 2];
            }
        }

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_before_median_cut');

        // Step 2: Median cut with reduced target
        let initialPaletteLab = LabMedianCut.medianCutInLabSpace(
            nonPreservedLabPixels,
            medianCutTarget,
            grayscaleOnly,
            width,
            height,
            null,
            3.5,
            vibrancyMode,
            vibrancyBoost,
            highlightThreshold,
            highlightBoost,
            options.strategy || null,
            options.tuning || null
        );
        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_median_cut_done');

        logger.log(`[Mk1.5] Median cut produced ${initialPaletteLab.length} colors: ${initialPaletteLab.map(c => `L=${c.L.toFixed(1)} a=${c.a.toFixed(1)} b=${c.b.toFixed(1)}`).join(' | ')}`);

        // K-means refinement
        const refinementPasses = options.refinementPasses !== undefined ? options.refinementPasses : 1;
        if (!grayscaleOnly && initialPaletteLab.length > 1 && refinementPasses > 0) {
            for (let pass = 0; pass < refinementPasses; pass++) {
                initialPaletteLab = PaletteOps._refineKMeans(nonPreservedLabPixels, initialPaletteLab);
            }
        }

        // Step 3: Perceptual snap
        const colorSpaceAnalysis = LabMedianCut._analyzeColorSpace(labPixels);
        const isGrayscale = grayscaleOnly || colorSpaceAnalysis.chromaRange < 10;

        let lRange = 0;
        let colorSpaceExtent = null;

        if (isGrayscale) {
            let minL = Infinity, maxL = -Infinity;
            for (let i = 0; i < labPixels.length; i += 3) {
                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
            }
            lRange = maxL - minL;
        } else {
            let minL = Infinity, maxL = -Infinity;
            let minA = Infinity, maxA = -Infinity;
            let minB = Infinity, maxB = -Infinity;

            for (let i = 0; i < labPixels.length; i += 3) {
                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
                minA = Math.min(minA, labPixels[i + 1]);
                maxA = Math.max(maxA, labPixels[i + 1]);
                minB = Math.min(minB, labPixels[i + 2]);
                maxB = Math.max(maxB, labPixels[i + 2]);
            }

            colorSpaceExtent = {
                lRange: maxL - minL,
                aRange: maxA - minA,
                bRange: maxB - minB
            };
        }

        const adaptiveThreshold = PaletteOps._getAdaptiveSnapThreshold(
            snapThreshold,
            targetColors,
            isGrayscale,
            lRange,
            colorSpaceExtent
        );

        let snappedPaletteLab = PaletteOps.applyPerceptualSnap(
            initialPaletteLab,
            adaptiveThreshold,
            isGrayscale,
            vibrancyBoost,
            options.strategy || null,
            options.tuning || null
        );

        // Step 4: Palette reduction
        if (enablePaletteReduction && snappedPaletteLab.length > medianCutTarget) {
            const prunedPaletteLab = PaletteOps._prunePalette(snappedPaletteLab, paletteReduction, highlightThreshold, medianCutTarget, options.tuning || null, distanceMetric);
            if (prunedPaletteLab.length < snappedPaletteLab.length) {
                snappedPaletteLab = prunedPaletteLab;
            }
        }

        // Step 4a: Unconditional similarity prune
        if (enablePaletteReduction) {
            const dedupThreshold = Math.max(paletteReduction, 2.0);
            const dedupResult = PaletteOps._prunePalette(snappedPaletteLab, dedupThreshold, highlightThreshold, 0, options.tuning || null, distanceMetric);
            if (dedupResult.length < snappedPaletteLab.length) {
                logger.log(`[Mk1.5] Similarity prune (ΔE<${dedupThreshold}): ${snappedPaletteLab.length} → ${dedupResult.length}`);
                snappedPaletteLab = dedupResult;
            }
        }

        // Step 4.5: Hue gap analysis
        const enableHueGapAnalysis = options.enableHueGapAnalysis !== undefined
            ? options.enableHueGapAnalysis : false;

        if (enableHueGapAnalysis && !grayscaleOnly && initialPaletteLab._labPixels) {
            const hueChromaThreshold = vibrancyMode === 'exponential' ? 1.0 : 5.0;
            const imageHues = HueGapRecovery._analyzeImageHueSectors(initialPaletteLab._labPixels, hueChromaThreshold);
            const { coveredSectors, colorCountsBySector } = HueGapRecovery._analyzePaletteHueCoverage(snappedPaletteLab, hueChromaThreshold);
            const gaps = HueGapRecovery._identifyHueGaps(imageHues, coveredSectors, colorCountsBySector);
            gaps.sort((a, b) => imageHues[b] - imageHues[a]);

            if (gaps.length > 0) {
                const gapsToFill = gaps.length > 3 ? gaps.slice(0, 3) : gaps;
                const candidateColors = HueGapRecovery._findTrueMissingHues(labPixels, snappedPaletteLab, gapsToFill);

                const MIN_GAP_DISTANCE = 15.0;
                const forcedColors = candidateColors.filter(candidate => {
                    const minDist = Math.min(
                        ...snappedPaletteLab.map(p => PaletteOps._labDistance(candidate, p))
                    );
                    return minDist >= MIN_GAP_DISTANCE;
                });

                if (forcedColors.length > 0) {
                    forcedColors.forEach(c => { c._minVolumeExempt = true; });
                    snappedPaletteLab = snappedPaletteLab.concat(forcedColors);
                    logger.log(`[Mk1.5] Hue gap rescue: injected ${forcedColors.length} colors for sectors [${gapsToFill.join(', ')}]`);
                } else {
                    logger.log(`[Mk1.5] Hue gap: ${gaps.length} gaps found but no candidates passed ΔE≥${MIN_GAP_DISTANCE} filter`);
                }
            }
        }

        // Anchor injection (after perceptual snap)
        const mergedPalette = [...snappedPaletteLab];
        let addedCount = 0;
        let skippedCount = 0;
        const anchorDuplicateThreshold = 3.0;

        for (const forced of forcedCentroids) {
            const isDuplicate = mergedPalette.some(color =>
                PaletteOps._labDistance(color, forced) < anchorDuplicateThreshold
            );

            if (isDuplicate) {
                skippedCount++;
            } else {
                forced._minVolumeExempt = true;
                mergedPalette.push(forced);
                addedCount++;
            }
        }

        // Step 5: Add preserved colors
        const preservedColors = [];
        let actuallyPreservedWhite = false;
        let actuallyPreservedBlack = false;
        let whiteIndex = -1;
        let blackIndex = -1;

        if (preserveWhite) {
            const whitePixels = preservedPixelMap.get('white');
            if (whitePixels && whitePixels.size >= totalPixels * PosterizationEngine.MIN_PRESERVED_COVERAGE) {
                preservedColors.push({ L: 100, a: 0, b: 0 });
                whiteIndex = mergedPalette.length + preservedColors.length - 1;
                actuallyPreservedWhite = true;
            }
        }

        if (preserveBlack) {
            const blackPixels = preservedPixelMap.get('black');
            if (blackPixels && blackPixels.size >= totalPixels * PosterizationEngine.MIN_PRESERVED_COVERAGE) {
                preservedColors.push({ L: 0, a: 0, b: 0 });
                blackIndex = mergedPalette.length + preservedColors.length - 1;
                actuallyPreservedBlack = true;
            }
        }

        // Final safety-net dedup
        {
            const finalDedupThreshold = enablePaletteReduction ? Math.max(paletteReduction, 2.0) : 2.0;
            const dedupFinal = PaletteOps._prunePalette(mergedPalette, finalDedupThreshold, highlightThreshold, 0, options.tuning || null, distanceMetric);
            if (dedupFinal.length < mergedPalette.length) {
                logger.log(`[Mk1.5] Final dedup: ${mergedPalette.length} → ${dedupFinal.length} (removed ${mergedPalette.length - dedupFinal.length} near-duplicates)`);
                mergedPalette.length = 0;
                mergedPalette.push(...dedupFinal);
                if (actuallyPreservedWhite) whiteIndex = mergedPalette.length + (preservedColors.indexOf(preservedColors.find(c => c.L === 100)));
                if (actuallyPreservedBlack) blackIndex = mergedPalette.length + (preservedColors.indexOf(preservedColors.find(c => c.L === 0)));
            }
        }

        const finalPaletteLab = [...mergedPalette, ...preservedColors];

        // Step 6: Pixel assignment
        const paletteRgb = finalPaletteLab.map(lab => this.labToRgb(lab));
        const assignments = new Uint8Array(width * height);

        const isPreview = options.isPreview === true;
        const useStride = isPreview && options.optimizePreview !== false;
        const ASSIGNMENT_STRIDE = useStride ? (options.previewStride || 4) : 1;

        const paletteLength = finalPaletteLab.length;

        const assignDistanceMetric = options.distanceMetric || 'squared';
        const lWeight = options.lWeight !== undefined ? options.lWeight : 1.0;
        const cWeight = options.cWeight !== undefined ? options.cWeight : 1.0;

        for (let y = 0; y < height; y += ASSIGNMENT_STRIDE) {
            for (let x = 0; x < width; x += ASSIGNMENT_STRIDE) {
                let anchorAssignment = 0;

                for (let bY = 0; bY < ASSIGNMENT_STRIDE && (y + bY) < height; bY += 2) {
                    for (let bX = 0; bX < ASSIGNMENT_STRIDE && (x + bX) < width; bX += 2) {
                        const pixelIndex = (y + bY) * width + (x + bX);
                        const preservedColorKey = [...preservedPixelMap.entries()].find(([_, indices]) => indices.has(pixelIndex));

                        if (preservedColorKey) {
                            const colorName = preservedColorKey[0];
                            if (colorName === 'white' && actuallyPreservedWhite) {
                                anchorAssignment = whiteIndex;
                            } else if (colorName === 'black' && actuallyPreservedBlack) {
                                anchorAssignment = blackIndex;
                            }
                        } else {
                            let minDistance = Infinity;
                            const idx = pixelIndex * 3;

                            const pL = labPixels[idx];
                            const pA = labPixels[idx + 1];
                            const pB = labPixels[idx + 2];

                            for (let j = 0; j < paletteLength; j++) {
                                const target = finalPaletteLab[j];

                                let dist;
                                if (grayscaleOnly) {
                                    const dL = pL - target.L;
                                    dist = dL * dL;
                                } else {
                                    if (assignDistanceMetric === 'cie76') {
                                        dist = LabDistance.cie76SquaredInline(pL, pA, pB, target.L, target.a, target.b);
                                    } else if (assignDistanceMetric === 'cie94') {
                                        const C1 = Math.sqrt(pA * pA + pB * pB);
                                        dist = LabDistance.cie94SquaredInline(pL, pA, pB, target.L, target.a, target.b, C1);
                                    } else if (assignDistanceMetric === 'cie2000') {
                                        dist = LabDistance.cie2000SquaredInline(pL, pA, pB, target.L, target.a, target.b);
                                    } else {
                                        const dL = pL - target.L;
                                        const dA = pA - target.a;
                                        const dB = pB - target.b;
                                        const dC = Math.sqrt(dA * dA + dB * dB);
                                        dist = (lWeight * dL * dL) + (cWeight * dC * dC);
                                    }
                                }

                                if (dist < minDistance) {
                                    minDistance = dist;
                                    anchorAssignment = j;
                                }
                            }
                        }
                    }
                }

                for (let bY = 0; bY < ASSIGNMENT_STRIDE && (y + bY) < height; bY++) {
                    const fillRow = (y + bY) * width;
                    for (let bX = 0; bX < ASSIGNMENT_STRIDE && (x + bX) < width; bX++) {
                        assignments[fillRow + (x + bX)] = anchorAssignment;
                    }
                }
            }
        }

        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(3);

        // Apply density floor
        let finalPaletteLabFiltered = finalPaletteLab;
        let assignmentsFiltered = assignments;

        if (densityFloor > 0) {
            const protectedIndices = new Set();
            if (actuallyPreservedWhite) protectedIndices.add(whiteIndex);
            if (actuallyPreservedBlack) protectedIndices.add(blackIndex);

            const densityResult = PaletteOps._applyDensityFloor(
                assignments,
                finalPaletteLab,
                densityFloor,
                protectedIndices
            );

            if (densityResult.actualCount < finalPaletteLab.length) {
                finalPaletteLabFiltered = densityResult.palette;
                assignmentsFiltered = densityResult.assignments;
            }
        }

        const paletteRgbFiltered = finalPaletteLabFiltered.map(lab => this.labToRgb(lab));

        return {
            palette: paletteRgbFiltered,
            paletteLab: finalPaletteLabFiltered,
            assignments: assignmentsFiltered,
            labPixels,
            substrateLab: null,
            substrateIndex: null,
            metadata: {
                targetColors,
                finalColors: finalPaletteLabFiltered.length,
                autoAnchors: addedCount,
                skippedAnchors: skippedCount,
                detectedPeaks: detectedPeaks.map(p => ({
                    L: p.L.toFixed(1),
                    a: p.a.toFixed(1),
                    b: p.b.toFixed(1),
                    chroma: p.chroma.toFixed(1),
                    volume: (p.volume * 100).toFixed(2) + '%'
                })),
                snapThreshold,
                duration: parseFloat(duration),
                engineType: 'reveal-mk1.5'
            }
        };
    }

    // ========================================================================
    // Engine Wrappers: Balanced, Classic, Stencil
    // ========================================================================

    /**
     * Balanced Engine: Lab Median Cut without hue gap analysis
     * @private
     */
    static _posterizeBalanced(pixels, width, height, targetColors, options = {}) {
        return this._posterizeRevealMk1_0(pixels, width, height, targetColors, {
            ...options,
            enableHueGapAnalysis: false
        });
    }

    /**
     * Classic Engine: RGB Median Cut
     * @private
     */
    static _posterizeClassic(pixels, width, height, targetColors, options = {}) {
        const isLabInput = options.format === 'lab';
        const preserveWhite = options.preserveWhite !== undefined ? options.preserveWhite : true;
        const preserveBlack = options.preserveBlack !== undefined ? options.preserveBlack : true;

        let rgbPixels;
        if (isLabInput) {
            rgbPixels = new Uint8ClampedArray((pixels.length / 3) * 4);

            const maxValue = 32768;
            const neutralAB = 16384;
            const abScale = 128 / 16384;

            for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
                const L = (pixels[i] / maxValue) * 100;
                const a = (pixels[i + 1] - neutralAB) * abScale;
                const b = (pixels[i + 2] - neutralAB) * abScale;
                const rgb = this.labToRgb({ L, a, b });
                rgbPixels[j] = rgb.r;
                rgbPixels[j + 1] = rgb.g;
                rgbPixels[j + 2] = rgb.b;
                rgbPixels[j + 3] = 255;
            }
        } else {
            rgbPixels = pixels;
        }

        const result = RgbMedianCut._posterizeClassicRgb(rgbPixels, width, height, targetColors, 'cielab');
        const paletteLab = result.palette.map(rgb => this.rgbToLab(rgb));

        const numPixels = width * height;
        const assignments = new Uint8Array(numPixels);

        for (let i = 0; i < numPixels; i++) {
            const pixelIndex = i * 4;
            const r = rgbPixels[pixelIndex];
            const g = rgbPixels[pixelIndex + 1];
            const b = rgbPixels[pixelIndex + 2];

            let minDist = Infinity;
            let closestIndex = 0;

            for (let p = 0; p < result.palette.length; p++) {
                const pr = result.palette[p].r;
                const pg = result.palette[p].g;
                const pb = result.palette[p].b;
                const dist = Math.sqrt(
                    (r - pr) ** 2 +
                    (g - pg) ** 2 +
                    (b - pb) ** 2
                );

                if (dist < minDist) {
                    minDist = dist;
                    closestIndex = p;
                }
            }

            assignments[i] = closestIndex;
        }

        const protectedIndices = new Set();

        const densityResult = PaletteOps._applyDensityFloor(
            assignments,
            paletteLab,
            0.005,
            protectedIndices
        );

        if (densityResult.actualCount < paletteLab.length) {
            const cleanPaletteRgb = densityResult.palette.map(lab => this.labToRgb(lab));

            return {
                palette: cleanPaletteRgb,
                paletteLab: densityResult.palette,
                assignments: densityResult.assignments,
                labPixels: null,
                metadata: {
                    engine: 'classic',
                    targetColors,
                    finalColors: densityResult.actualCount
                }
            };
        }

        return {
            palette: result.palette,
            paletteLab,
            assignments,
            labPixels: null,
            metadata: {
                engine: 'classic',
                targetColors,
                finalColors: result.palette.length
            }
        };
    }

    /**
     * Stencil Engine: Luminance-only quantization
     * @private
     */
    static _posterizeStencil(pixels, width, height, targetColors, options = {}) {
        return this._posterizeRevealMk1_0(pixels, width, height, targetColors, {
            ...options,
            grayscaleOnly: true,
            enableHueGapAnalysis: false
        });
    }
}

// Export for use in plugin
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PosterizationEngine;
}
