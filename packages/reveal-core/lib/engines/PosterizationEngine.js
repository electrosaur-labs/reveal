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
 * - HueAnalysis.js: Hue analysis (legacy, superseded by HueGapRecovery)
 */

const logger = require("../utils/logger");

// Import modular components
const { CentroidStrategies } = require('./CentroidStrategies');
const PeakFinder = require('../analysis/PeakFinder');
const LabDistance = require('../color/LabDistance');
const LabEncoding = require('../color/LabEncoding');
const { LAB16_L_MAX, LAB16_AB_NEUTRAL, L_SCALE, AB_SCALE } = LabEncoding;

// Import extracted modules
const LabMedianCut = require('./LabMedianCut');
const PaletteOps = require('./PaletteOps');
const HueGapRecovery = require('./HueGapRecovery');
const RgbMedianCut = require('./RgbMedianCut');
const PixelAssignment = require('./PixelAssignment');
const RevealMk15Engine = require('./RevealMk15Engine');

/**
 * @typedef {Object} PosterizeOptions
 * @property {string} [engineType='reveal'] - 'reveal'|'reveal-mk1.5'|'balanced'|'classic'|'stencil'
 * @property {string} [centroidStrategy] - 'SALIENCY'|'ROBUST_SALIENCY'|'VOLUMETRIC' (default: SALIENCY for reveal, VOLUMETRIC for others)
 * @property {string} [distanceMetric='cie76'] - 'cie76'|'cie94'|'cie2000'
 * @property {string} [format='lab'] - Input format ('lab')
 * @property {number|string} [bitDepth=8] - 8 or 16
 * @property {number} [lWeight=1.1] - Lightness weight for centroid strategy
 * @property {number} [cWeight=2.0] - Chroma weight for centroid strategy
 * @property {number} [blackBias=5.0] - Black pixel boost in saliency
 * @property {string} [vibrancyMode='aggressive'] - 'subtle'|'moderate'|'aggressive'|'exponential'
 * @property {number} [vibrancyBoost=2.2] - Vibrancy multiplier
 * @property {number} [highlightThreshold=85] - L-value floor for white detection
 * @property {number} [highlightBoost=2.2] - Highlight saliency boost
 * @property {number} [paletteReduction=9.0] - ΔE merge threshold for pruning
 * @property {boolean} [enablePaletteReduction=true] - Enable ΔE-based palette pruning
 * @property {number} [snapThreshold=8.0] - ΔE threshold for snapping similar colors
 * @property {boolean} [enableHueGapAnalysis=false] - Inject missing hue sectors
 * @property {number} [hueLockAngle=18] - Hue protection zone in degrees
 * @property {boolean} [preserveWhite=true] - Force white into palette
 * @property {boolean} [preserveBlack=true] - Force black into palette
 * @property {number} [densityFloor=0] - Minimum pixel density for palette entry
 * @property {string} [splitMode='median'] - 'median'|'variance'
 * @property {number} [chromaAxisWeight=0] - Enables C* as virtual split axis when >0
 * @property {number} [neutralIsolationThreshold=0] - Pre-isolates neutrals (C* < threshold) when >0
 * @property {number} [warmABoost=1.0] - Warm a* boost multiplier
 * @property {number} [shadowPoint=15] - L-value ceiling for shadow protection
 * @property {string} [preprocessingIntensity='auto'] - 'off'|'auto'|'heavy'
 * @property {boolean} [enableGridOptimization=true] - Grid sampling for performance
 * @property {Object} [tuning] - Override entire tuning object (advanced — bypasses flat field mapping)
 */

/**
 * @typedef {Object} PosterizeResult
 * @property {Array<{r:number,g:number,b:number}>} palette - RGB palette
 * @property {Array<{L:number,a:number,b:number}>} paletteLab - Lab palette (perceptual ranges)
 * @property {Uint8Array} assignments - Palette index per pixel
 * @property {Uint16Array|Uint8Array} labPixels - Input pixels (passed through)
 * @property {{L:number,a:number,b:number}|null} substrateLab - Substrate color if detected
 * @property {number|null} substrateIndex - Index of substrate in palette
 * @property {Object} metadata - Engine statistics
 * @property {number} metadata.targetColors - Requested color count
 * @property {number} metadata.finalColors - Actual palette size after pruning
 * @property {number} metadata.snapThreshold - Snap threshold used
 * @property {number} metadata.duration - Processing time in ms
 */

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
            highlightBoost: 2.2,    // Facial highlight rescue — 2.2× lifts L>85 variance so bright skin isn't merged with white substrate. Tuned on CQ100 portraits.
            vibrancyBoost: 1.6,     // Chroma-rich pixel boost — 1.6× up-weights saturated greens/skin. Below 1.4 loses minority greens; above 1.8 over-splits warm tones.
            minVariance: 10,        // Minimum box variance to split further — prevents over-splitting near-uniform patches. CQ100-derived; lower causes 1-pixel boxes.
            chromaAxisWeight: 0,    // 0=disabled; >0 enables C* (chroma magnitude) as virtual split axis
            neutralIsolationThreshold: 0  // 0=disabled; >0 pre-isolates neutrals (C* < threshold) into separate box
        },
        prune: {
            threshold: 9.0,         // ΔE merge distance — 9.0 balances duplicate removal vs distinct hue preservation. <7 merges skin variants; >12 leaves near-duplicate plates.
            hueLockAngle: 18,       // Hue protection zone in degrees — prevents merging colors within 18° of each other. Protects green from beige washout (CQ100 foliage tests).
            whitePoint: 85,         // L-value floor for white detection — colors with L>85 treated as highlights for pruning protection.
            shadowPoint: 15         // L-value ceiling for shadow protection — prevents merging very dark colors (L<15) with lighter neighbors.
        },
        centroid: {
            lWeight: 1.1,           // Saliency lightness priority — slight L emphasis (1.1×) preserves tonal structure without washing out chroma.
            cWeight: 2.0,           // Saliency chroma priority — 2.0× strongly favors saturated pixels as bucket representatives. Key for vivid screen print separations.
            blackBias: 5.0          // Black pixel boost — 5.0× ensures absolute blacks (L<10) snap to true black in halftone originals. Critical for screen print registration marks.
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

    /**
     * Build the nested tuning object from flat config fields.
     *
     * ParameterGenerator outputs flat fields (vibrancyBoost, highlightBoost, etc.)
     * but the internal median-cut code expects nested tuning.split/prune/centroid.
     * This helper centralizes that mapping so callers don't reconstruct it manually.
     *
     * @param {PosterizeOptions} options - Flat config from ParameterGenerator or user
     * @returns {Object} Nested tuning object {split, prune, centroid}
     */
    static _buildTuningFromConfig(options) {
        return {
            split: {
                highlightBoost: options.highlightBoost !== undefined ? options.highlightBoost : this.TUNING.split.highlightBoost,
                vibrancyBoost: options.vibrancyBoost !== undefined ? options.vibrancyBoost : this.TUNING.split.vibrancyBoost,
                minVariance: this.TUNING.split.minVariance,
                chromaAxisWeight: options.chromaAxisWeight !== undefined ? options.chromaAxisWeight : this.TUNING.split.chromaAxisWeight,
                neutralIsolationThreshold: options.neutralIsolationThreshold !== undefined ? options.neutralIsolationThreshold : this.TUNING.split.neutralIsolationThreshold,
                warmABoost: options.warmABoost !== undefined ? options.warmABoost : 1.0,
                splitMode: options.splitMode || 'median'
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
                bitDepth: this._normalizeBitDepth(options.bitDepth),
                vibrancyMode: options.vibrancyMode || 'aggressive',
                vibrancyBoost: options.vibrancyBoost !== undefined ? options.vibrancyBoost : 2.2
            }
        };
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
        // --- Input validation ---
        if (!pixels || !(pixels instanceof Uint16Array || pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) {
            throw new Error('posterize: pixels must be a Uint8Array, Uint8ClampedArray, or Uint16Array');
        }
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
            throw new Error(`posterize: width and height must be positive integers (got ${width}x${height})`);
        }
        if (pixels.length < width * height * 3) {
            throw new Error(`posterize: pixel array too short (${pixels.length}) for ${width}x${height}x3 = ${width * height * 3}`);
        }
        if (!Number.isInteger(targetColors) || targetColors < 1 || targetColors > 20) {
            throw new Error(`posterize: targetColors must be an integer 1-20 (got ${targetColors})`);
        }

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


        // Build tuning object from flat options fields if not provided directly.
        // See _buildTuningFromConfig() for the flat→nested field mapping.
        const tuning = options.tuning || this._buildTuningFromConfig(options);

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

            case 'reveal-mk1.5':
            case 'reveal-mk2':   // Same posterization as Mk 1.5, different param generation
                return RevealMk15Engine.posterize(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis,  // Respect user setting (same as Mk 1.0)
                    snapThreshold,
                    strategy,
                    strategyName,
                    tuning
                });

            case 'distilled':
                return this.distilledPosterize(pixels, width, height, targetColors, options);

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

    /** Convert sRGB color to CIELAB. Delegates to LabEncoding. */
    static rgbToLab(rgb) {
        return LabEncoding.rgbToLab(rgb);
    }

    /** Convert CIELAB to sRGB with gamut mapping. Delegates to LabEncoding. */
    static labToRgb(lab) {
        return LabEncoding.labToRgb(lab);
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

        const sample = (x, y) => {
            const i = (y * width + x) * 3;
            sumL += labBytes[i] / L_SCALE;
            sumA += (labBytes[i + 1] - LAB16_AB_NEUTRAL) / AB_SCALE;
            sumB += (labBytes[i + 2] - LAB16_AB_NEUTRAL) / AB_SCALE;
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
    // Public API: Delegates (used by reveal-adobe)
    // ========================================================================

    /** Delegate to RgbMedianCut */
    static analyzeOptimalColorCount(pixels, width, height) {
        return RgbMedianCut.analyzeOptimalColorCount(pixels, width, height);
    }

    /** Delegate to PixelAssignment */
    static reassignWithStride(labPixels, paletteLab, width, height, stride = 1, bitDepth = 16, options = {}) {
        return PixelAssignment.reassignWithStride(labPixels, paletteLab, width, height, stride, bitDepth, options);
    }

    /** @private Delegate to PaletteOps (used by reveal-adobe/ColorUtils) */
    static _labDistance(lab1, lab2) {
        return PaletteOps._labDistance(lab1, lab2);
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

                labPixels[i] = pixels[i] / L_SCALE;
                labPixels[i + 1] = (pixels[i + 1] - LAB16_AB_NEUTRAL) / AB_SCALE;
                labPixels[i + 2] = (pixels[i + 2] - LAB16_AB_NEUTRAL) / AB_SCALE;

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
        // Wu variance mode defaults to 3 passes (Wu seeds + K-Means polish is the classical combo)
        const defaultPasses = (options.tuning?.split?.splitMode === 'variance') ? 3 : 1;
        const refinementPasses = options.refinementPasses !== undefined ? options.refinementPasses : defaultPasses;
        if (!grayscaleOnly && initialPaletteLab.length > 1 && refinementPasses > 0) {
            for (let pass = 0; pass < refinementPasses; pass++) {
                initialPaletteLab = PaletteOps._refineKMeans(nonPreservedLabPixels, initialPaletteLab, options.tuning || null);
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

            for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
                const L = pixels[i] / L_SCALE;
                const a = (pixels[i + 1] - LAB16_AB_NEUTRAL) / AB_SCALE;
                const b = (pixels[i + 2] - LAB16_AB_NEUTRAL) / AB_SCALE;
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

    // ========================================================================
    // Distilled Posterization (over-quantize → furthest-point reduce)
    // ========================================================================

    /**
     * Over-quantize to 3× targetColors (capped at 20), then reduce to
     * targetColors using coverage-seeded furthest-point sampling.
     *
     * Solves the warm-image L*-dominance problem: with 18–20 buckets the
     * median cut is forced into a-axis/b-axis hue splits, capturing golden yellow vs
     * orange distinctions that direct 6-color quantization collapses.
     *
     * @param {Uint16Array} labPixels    - 16-bit Lab pixels (3 ch, L/a/b interleaved)
     * @param {number}      width
     * @param {number}      height
     * @param {number}      targetColors - Desired final color count
     * @param {Object}      [options]    - Same options as posterize().
     * @returns {{ paletteLab, palette, assignments, metadata }}
     */
    static distilledPosterize(labPixels, width, height, targetColors, options = {}) {
        const { PaletteDistiller } = require('./PaletteDistiller');
        const overCount = PaletteDistiller.overQuantizeCount(targetColors);

        // Over-quantize pass — disable all merging so we get full hue resolution.
        // Force engineType to reveal-mk1.5 for the inner call; 'distilled' is the
        // outer wrapper, not a posterize algorithm — without this we'd recurse.
        // Preserve the centroid strategy that the ORIGINAL engineType would select —
        // reveal-mk1.5 defaults to SALIENCY (a* × 1.6 vibrancy), but the caller's
        // engineType (e.g. 'reveal-mk2') may default to VOLUMETRIC. Without this
        // the strategy override causes a massive redward centroid shift.
        const originalEngineType = options.engineType || 'reveal';
        const impliedStrategy = (originalEngineType === 'reveal' || originalEngineType === 'reveal-mk1.5')
            ? 'SALIENCY' : 'VOLUMETRIC';
        const overResult = PosterizationEngine.posterize(labPixels, width, height, overCount, {
            ...options,
            engineType: 'reveal-mk1.5',
            centroidStrategy: options.centroidStrategy || impliedStrategy,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0
        });

        const largePalette = overResult.paletteLab;
        const pixelCount   = width * height;

        // Distill: select the best targetColors from the large palette.
        const { palette: reducedPalette, remap, selected, ghostsExcluded, coverageCounts } = PaletteDistiller.distill(
            largePalette, overResult.assignments, pixelCount, targetColors, options.ghostFloor
        );

        // Remap assignments from over-quantized indices to reduced indices.
        const remappedAssignments = new Uint8Array(pixelCount);
        const src = overResult.assignments;
        for (let i = 0; i < pixelCount; i++) {
            remappedAssignments[i] = remap[src[i]];
        }

        return {
            palette:     reducedPalette.map(c => PosterizationEngine.labToRgb(c)),
            paletteLab:  reducedPalette,
            assignments: remappedAssignments,
            metadata: {
                ...overResult.metadata,
                engine:        'distilled',
                targetColors,
                overCount,
                finalColors:   reducedPalette.length,
                keptIndices:   selected,
                ghostsExcluded,
                overPaletteLab:   largePalette,
                overCoverageCounts: Array.from(coverageCounts),
            }
        };
    }
}

// Export for use in plugin
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PosterizationEngine;
}
