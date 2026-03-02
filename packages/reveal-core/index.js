/**
 * Reveal Core - Pure JavaScript Color Separation Engines
 *
 * Agent-optimized API for screen print color separation.
 * Designed for OpenAI function calling with mid-level granularity.
 *
 * All functions are pure computation - no file I/O, no Photoshop dependencies.
 *
 * @module reveal-core
 * @version 1.0.0
 */

const PosterizationEngine = require('./lib/engines/PosterizationEngine');
const SeparationEngine = require('./lib/engines/SeparationEngine');
const PreviewEngine = require('./lib/engines/PreviewEngine');
const ProxyEngine = require('./lib/engines/ProxyEngine');
const DocumentValidator = require('./lib/validation/DocumentValidator');
const DNAValidator = require('./lib/validation/DNAValidator');
const ImageHeuristicAnalyzer = require('./lib/analysis/ImageHeuristicAnalyzer');
const LabDistance = require('./lib/color/LabDistance');
const LabEncoding = require('./lib/color/LabEncoding');
const BilateralFilter = require('./lib/preprocessing/BilateralFilter');
const ParameterGenerator = require('./lib/analysis/ParameterGenerator');
const DNAGenerator = require('./lib/analysis/DNAGenerator');
const ArchetypeMapper = require('./lib/analysis/ArchetypeMapper');
const ArchetypeLoader = require('./lib/analysis/ArchetypeLoader');
const PeakFinder = require('./lib/analysis/PeakFinder');
const MechanicalKnobs = require('./lib/engines/MechanicalKnobs');
const TrapEngine = require('./lib/engines/TrapEngine');
const RevelationError = require('./lib/metrics/RevelationError');
const DNAFidelity = require('./lib/metrics/DNAFidelity');
const SuggestedColorAnalyzer = require('./lib/analysis/SuggestedColorAnalyzer');
const InterpolatorEngine = require('./lib/analysis/InterpolatorEngine').InterpolatorEngine;
const logger = require('./lib/utils/logger');

// Lazy-loaded interpolator engine singleton
let _interpolatorEngine = null;

/**
 * Tool 0: Generate Configuration from DNA
 *
 * Creates complete processing configuration from DNA analysis results.
 * Includes preprocessing settings (bilateral filter), distance metric selection,
 * and all posterization parameters.
 *
 * @param {Object} dna - DNA analysis result from analyzeImage or external analyzer
 * @param {Object} [options] - Configuration options
 * @param {Uint8ClampedArray} [options.imageData] - RGBA data for entropy calculation
 * @param {number} [options.width] - Image width
 * @param {number} [options.height] - Image height
 * @param {string} [options.preprocessingIntensity='auto'] - 'off', 'auto', 'light', 'heavy'
 * @returns {Object} Complete configuration object
 *
 * @example
 * const config = generateConfiguration(dna, {
 *   imageData: rgbaPixels,
 *   width: 800,
 *   height: 600,
 *   preprocessingIntensity: 'auto'
 * });
 * // config.preprocessing.enabled, config.targetColors, config.distanceMetric, etc.
 */
function generateConfiguration(dna, options = {}) {
    return ParameterGenerator.generate(dna, options);
}

/**
 * Tool 0a: Generate Configuration from DNA via Mk II Interpolator
 *
 * Uses cluster-then-interpolate engine (12 learned clusters) instead of
 * the archetype-based ParameterGenerator. Same posterization algorithm
 * (Mk 1.5), different parameter generation — soft blending from learned
 * clusters instead of hard assignment from hand-crafted archetypes.
 *
 * @param {Object} dna - DNA analysis result (7D vector: l, c, k, l_std_dev, hue_entropy, temperature_bias, primary_sector_weight)
 * @returns {Object} Complete configuration object (same shape as generateConfiguration output)
 */
function generateConfigurationMk2(dna) {
    if (!_interpolatorEngine) {
        const model = require('./lib/analysis/interpolator-model.json');
        _interpolatorEngine = new InterpolatorEngine(model);
    }

    // InterpolatorEngine expects flat {l, c, k, ...} but DNAGenerator
    // produces nested {global: {l, c, k, ...}}. Flatten for compatibility.
    const flatDna = dna.global ? { ...dna.global } : dna;
    const { parameters, blendInfo } = _interpolatorEngine.interpolate(flatDna);

    // Build a config object compatible with PosterizationEngine / ProxyEngine.
    // The interpolator returns flat parameters — wrap them in the same shape
    // that ParameterGenerator.generate() produces.
    const config = { ...parameters };

    // Ensure engineType is set to reveal-mk2 so PosterizationEngine dispatches correctly
    config.engineType = 'reveal-mk2';

    // Ensure splitMode has a default (Mk2 interpolator doesn't produce it)
    if (config.splitMode === undefined) config.splitMode = 'median';

    // Map minColors/maxColors to targetColors (use maxColors as the target)
    if (config.maxColors !== undefined) {
        config.targetColors = config.maxColors;
    }
    if (config.targetColorsSlider === undefined && config.targetColors !== undefined) {
        config.targetColorsSlider = config.targetColors;
    }

    // Attach blend info for diagnostics
    config.meta = { blendInfo, engine: 'mk2-interpolator' };

    // Default to distilled engine — consistent with ParameterGenerator's || 'distilled' fallback.
    // Chameleon has no archetype opinion on engine mode; distilled outperforms direct on 25/26 archetypes.
    config.engineMode = 'distilled';

    return config;
}

/**
 * Generate configuration for the Distilled pseudo-archetype.
 * Code-only (no JSON archetype file), like Chameleon.
 *
 * Uses the same minimal settings as the batch command-line pipeline:
 * no archetype-specific centroid strategy, no preprocessing override,
 * no preserveWhite/Black forcing. ProxyEngine defaults preprocessingIntensity
 * to 'auto' (bilateral filter) for clean proxy display.
 *
 * Over-quantizes to 20 colors → reduces to 12 via furthest-point sampling.
 * (PaletteDistiller.overQuantizeCount(12) = min(12×3, 20) = 20 automatically.)
 *
 * @param {Object} dna - Image DNA from DNAGenerator (reserved for future use)
 * @returns {Object} Posterization config
 */
function generateConfigurationDistilled(dna) {
    return {
        engineType: 'reveal-mk2',
        engineMode: 'distilled',
        targetColors: 12,
        targetColorsSlider: 12,
        enablePaletteReduction: false,
        snapThreshold: 0,
        densityFloor: 0,
        peakFinderMaxPeaks: 1,
        splitMode: 'median',
        preprocessingIntensity: 'off', // no bilateral filter — matches batch pipeline exactly
    };
}

/**
 * Tool 0.5: Preprocess Image
 *
 * Apply bilateral filter for noise reduction while preserving edges.
 * Part of the 3-Level Perceptual Rescue System.
 *
 * @param {Uint8ClampedArray} imageData - RGBA pixel data (modified in place)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} config - Preprocessing config (from generateConfiguration().preprocessing)
 * @returns {Object} Processing result
 *
 * @example
 * const config = generateConfiguration(dna, { imageData, width, height });
 * if (config.preprocessing.enabled) {
 *   preprocessImage(imageData, width, height, config.preprocessing);
 * }
 */
function preprocessImage(imageData, width, height, config) {
    if (!config || !config.enabled) {
        return { processed: false, reason: 'Preprocessing disabled' };
    }

    BilateralFilter.applyBilateralFilter(
        imageData,
        width,
        height,
        config.radius || 4,
        config.sigmaR || 30
    );

    return {
        processed: true,
        intensity: config.intensity,
        reason: config.reason
    };
}

/**
 * Tool 0.6: Calculate Entropy Score
 *
 * Measures local variance to detect noise vs texture.
 * Used internally by generateConfiguration for preprocessing decisions.
 *
 * @param {Uint8ClampedArray} imageData - RGBA pixel data
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {number} Entropy score (0-100, higher = noisier)
 */
function calculateEntropy(imageData, width, height) {
    return BilateralFilter.calculateEntropyScore(imageData, width, height);
}

/**
 * Tool 1: Analyze Image Characteristics
 *
 * Detects artistic signatures from Lab pixel data and recommends optimal
 * separation parameters. Fast step-sampled analysis (~5-10ms).
 *
 * @param {Uint8ClampedArray} labPixels - Lab pixel data (3 bytes per pixel: L, a, b)
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @returns {Object} Analysis result
 * @returns {string} returns.signature - Detected signature ("Halftone Portrait", "Vibrant Graphic", etc.)
 * @returns {string} returns.presetId - Recommended preset ID
 * @returns {Object} returns.statistics - Pixel statistics (darkPixels, maxChroma, etc.)
 * @returns {number} returns.timing - Analysis time in milliseconds
 *
 * @example
 * const analysis = analyzeImage(labPixels, 800, 600);
 * console.log(`Detected: ${analysis.signature}`);
 * // => Detected: Halftone Portrait
 */
function analyzeImage(labPixels, width, height) {
    return ImageHeuristicAnalyzer.analyze(labPixels, width, height);
}

/**
 * Tool 2: Generate Color Palette (Posterization)
 *
 * Reduces image to limited color palette (3-9 colors) using median cut algorithm
 * in perceptual Lab color space. Optimized for screen printing workflow.
 *
 * @param {Uint8ClampedArray} labPixels - Lab pixel data (3 bytes per pixel)
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {number} colorCount - Target number of colors (3-9)
 * @param {Object} [parameters] - Algorithm tuning parameters
 * @param {string} [parameters.centroidStrategy='SALIENCY'] - 'SALIENCY' or 'VOLUMETRIC'
 * @param {number} [parameters.blackBias=5.0] - Black protection multiplier
 * @param {number} [parameters.lWeight=1.5] - Lightness weight
 * @param {number} [parameters.cWeight=0.5] - Chroma weight
 * @param {number} [parameters.paletteReduction=4.0] - Similarity threshold (ΔE)
 * @param {Function} [onProgress] - Progress callback (percent: 0-100)
 * @returns {Promise<Object>} Posterization result
 * @returns {Array<{L, a, b}>} returns.labPalette - Palette in Lab space
 * @returns {Array<{r, g, b}>} returns.rgbPalette - Palette in sRGB space (0-255)
 * @returns {Object} returns.substrate - Detected substrate color
 * @returns {Object} returns.statistics - Color distribution statistics
 *
 * @example
 * const result = await posterizeImage(labPixels, 800, 600, 5, {
 *   centroidStrategy: 'SALIENCY',
 *   blackBias: 10.0
 * });
 * console.log(`Generated ${result.labPalette.length} colors`);
 */
async function posterizeImage(labPixels, width, height, colorCount, parameters = {}, onProgress = null) {
    return PosterizationEngine.posterize(
        labPixels,
        width,
        height,
        colorCount,
        parameters,
        onProgress
    );
}

/**
 * Tool 3: Map Pixels to Palette (Separation)
 *
 * Maps each pixel to nearest palette color using perceptual Lab distance.
 * Returns color indices array for mask generation. Optimized with spatial caching.
 *
 * BREAKING CHANGE (v1.1.0): Added width, height parameters for dithering support.
 * Old callers will fall back to nearest-neighbor (no dithering).
 *
 * NEW (v2.1.0): Configurable distance metric (CIE76 or CIE94).
 *
 * @param {Uint8ClampedArray} labPixels - Lab pixel data (3 bytes per pixel)
 * @param {Array<{L, a, b}>} palette - Color palette from posterizeImage()
 * @param {number} width - Image width (required for dithering)
 * @param {number} height - Image height (required for dithering)
 * @param {Object} [parameters] - Separation parameters
 * @param {string} [parameters.ditherType='none'] - 'none', 'floyd-steinberg', 'blue-noise', 'bayer', 'atkinson', 'stucki'
 * @param {string} [parameters.distanceMetric='cie76'] - 'cie76' or 'cie94'
 * @param {Object} [parameters.cie94Params] - CIE94 parameters { kL, k1, k2 }
 * @param {number} [parameters.lWeight=1.5] - Lightness weight for distance (CIE76 only)
 * @param {number} [parameters.snapThreshold=2.0] - Early exit threshold (ΔE)
 * @param {Function} [onProgress] - Progress callback (percent: 0-100)
 * @returns {Promise<Object>} Separation result
 * @returns {Uint8Array} returns.colorIndices - Palette index per pixel (0 to palette.length-1)
 * @returns {Object} returns.metadata - Processing metadata
 *
 * @example
 * const separation = await separateImage(labPixels, result.labPalette, 800, 600, {
 *   ditherType: 'floyd-steinberg',
 *   distanceMetric: 'cie94'  // Optional: improved perceptual accuracy
 * });
 * console.log(`Mapped ${separation.metadata.totalPixels} pixels`);
 */
async function separateImage(labPixels, palette, width, height, parameters = {}, onProgress = null) {
    const ditherType = parameters.ditherType || 'none';
    const distanceMetric = parameters.distanceMetric || 'cie76';
    const cie94Params = parameters.cie94Params;

    const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
        labPixels,
        palette,
        onProgress,
        width,
        height,
        { ditherType, distanceMetric, cie94Params }
    );

    return {
        colorIndices,
        metadata: {
            totalPixels: colorIndices.length,
            paletteSize: palette.length,
            ditherType: ditherType,
            distanceMetric: distanceMetric
        }
    };
}

/**
 * Tool 4: Generate Binary Mask for Color Channel
 *
 * Creates 8-bit grayscale mask where 255 = pixel matches specified color.
 * Used for creating separation layers in image editors.
 *
 * @param {Uint8Array} colorIndices - Output from separateImage()
 * @param {number} colorIndex - Which palette color to mask (0 to palette.length-1)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Uint8ClampedArray} Binary mask (255 = match, 0 = no match)
 *
 * @example
 * const mask = generateMask(separation.colorIndices, 0, 800, 600);
 * // Returns 800*600 byte array with 255 where color 0 appears
 */
function generateMask(colorIndices, colorIndex, width, height) {
    return SeparationEngine.generateLayerMask(colorIndices, colorIndex, width, height);
}

/**
 * Tool 5: Generate RGBA Preview
 *
 * Fast preview generator using squared Euclidean distance.
 * Optimized for real-time UI updates (~10-20ms for 800x800).
 * Returns RGBA buffer ready for canvas display.
 *
 * @param {Uint8ClampedArray} labPixels - Lab pixel data
 * @param {Array<{L, a, b}>} labPalette - Lab palette
 * @param {Array<{r, g, b}>} rgbPalette - RGB palette for fast fill
 * @returns {Uint8ClampedArray} RGBA buffer (4 bytes per pixel)
 *
 * @example
 * const preview = generatePreview(
 *   labPixels,
 *   result.labPalette,
 *   result.rgbPalette
 * );
 * // Use with: ctx.putImageData(new ImageData(preview, width, height), 0, 0)
 */
function generatePreview(labPixels, labPalette, rgbPalette) {
    return PreviewEngine.generatePreview(labPixels, labPalette, rgbPalette);
}

/**
 * Utility: Validate Document Properties
 *
 * Pure validation logic without API calls.
 * Checks color mode, bit depth, layer count, dimensions.
 *
 * @param {Object} doc - Document properties
 * @param {string} doc.mode - Color mode (should be 'LabColorMode')
 * @param {string|number} doc.bitsPerChannel - Bit depth (should be 8)
 * @param {number} doc.width - Width in pixels
 * @param {number} doc.height - Height in pixels
 * @param {Object} doc.layers - Layer collection with length property
 * @returns {Object} Validation result
 * @returns {boolean} returns.valid - True if all checks pass
 * @returns {Array<string>} returns.errors - Blocking errors
 * @returns {Array<string>} returns.warnings - Non-blocking warnings
 */
function validateDocument(doc) {
    return DocumentValidator.validate(doc);
}

/**
 * Utility: Get Default Posterization Parameters
 *
 * Returns default algorithm tuning parameters.
 *
 * @returns {Object} Default parameters
 */
function getDefaultParameters() {
    return PosterizationEngine.getDefaultParameters();
}

/**
 * Utility: Get Preset Parameters by ID
 *
 * Loads preset parameters for common image types.
 *
 * @param {string} presetId - Preset identifier ('halftone-portrait', 'vibrant-graphic', etc.)
 * @returns {Object|null} Preset parameters or null if not found
 */
function getPresetParameters(presetId) {
    return PosterizationEngine.getPresetParameters(presetId);
}

/**
 * Utility: Convert RGB to Lab
 *
 * sRGB to CIELAB conversion with D65 white point.
 * Includes gamma correction and XYZ intermediate step.
 *
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {Object} Lab color
 * @returns {number} returns.L - Lightness (0-100)
 * @returns {number} returns.a - Green-red axis (-128 to +127)
 * @returns {number} returns.b - Blue-yellow axis (-128 to +127)
 */
function rgbToLab(r, g, b) {
    // Accept both rgbToLab(r, g, b) and rgbToLab({r, g, b})
    if (typeof r === 'object') return PosterizationEngine.rgbToLab(r);
    return PosterizationEngine.rgbToLab({ r, g, b });
}

/**
 * Utility: Convert Lab to RGB
 *
 * CIELAB to sRGB conversion with gamut mapping.
 * Handles out-of-gamut colors gracefully.
 *
 * @param {number} L - Lightness (0-100)
 * @param {number} a - Green-red axis (-128 to +127)
 * @param {number} b - Blue-yellow axis (-128 to +127)
 * @returns {Object} RGB color
 * @returns {number} returns.r - Red (0-255)
 * @returns {number} returns.g - Green (0-255)
 * @returns {number} returns.b - Blue (0-255)
 */
function labToRgb(L, a, b) {
    // Accept both labToRgb(L, a, b) and labToRgb({L, a, b})
    if (typeof L === 'object') return PosterizationEngine.labToRgb(L);
    return PosterizationEngine.labToRgb({ L, a, b });
}

// Export agent-optimized API
module.exports = {
    // Configuration generation (new in v2.0)
    generateConfiguration,
    generateConfigurationMk2,
    generateConfigurationDistilled,
    preprocessImage,
    calculateEntropy,

    // Core tools (mid-level granularity for agents)
    analyzeImage,
    posterizeImage,
    separateImage,
    generateMask,
    generatePreview,

    // Utilities
    validateDocument,
    getDefaultParameters,
    getPresetParameters,
    rgbToLab,
    labToRgb,
    labToRgbD50: LabEncoding.labToRgbD50,
    labGamutInfo: LabEncoding.labGamutInfo,

    // DNA validation (v2.2)
    validateDNA: DNAValidator.validate.bind(DNAValidator),

    // Metadata
    version: '2.0.0',
    logger
};

// Also export raw engines for advanced use
module.exports.engines = {
    PosterizationEngine,
    SeparationEngine,
    PreviewEngine,
    ProxyEngine,
    DocumentValidator,
    DNAValidator,
    ImageHeuristicAnalyzer,

    // Distilled posterization (over-quantize → furthest-point reduce)
    PaletteDistiller: require('./lib/engines/PaletteDistiller').PaletteDistiller,

    // Modular components (v2.0)
    HueAnalysis: require('./lib/engines/HueAnalysis'),
    CentroidStrategies: require('./lib/engines/CentroidStrategies').CentroidStrategies,
    DitheringStrategies: require('./lib/engines/DitheringStrategies').DitheringStrategies,

    // Lab color distance calculations (v2.1)
    LabDistance: LabDistance,

    // Centralized Lab encoding conversions (v2.5)
    LabEncoding: LabEncoding,

    // Preprocessing (v2.0)
    BilateralFilter: BilateralFilter,
    ParameterGenerator: ParameterGenerator,

    // DNA v2.0 Archetype System (v2.2)
    DNAGenerator: DNAGenerator,
    ArchetypeMapper: ArchetypeMapper,
    ArchetypeLoader: ArchetypeLoader,

    // Reveal Mk 1.5 - Identity Peak Detection
    PeakFinder: PeakFinder,

    // Suggested Color Analysis - Surface rejected candidate colors
    SuggestedColorAnalyzer: SuggestedColorAnalyzer,

    // Mechanical Knobs - Shared post-separation mask processing (v2.3)
    MechanicalKnobs: MechanicalKnobs,

    // Trapping - Color trap expansion for press registration (v2.4)
    TrapEngine: TrapEngine,

    // Reveal Mk II - Cluster-then-interpolate parameter generation
    InterpolatorEngine: InterpolatorEngine
};

// Export LabDistance at top level for convenient access
module.exports.LabDistance = LabDistance;

// Export LabEncoding at top level for centralized Lab encoding conversions
module.exports.LabEncoding = LabEncoding;

// Export BilateralFilter at top level for convenient access
module.exports.BilateralFilter = BilateralFilter;

// Export ParameterGenerator at top level for convenient access
module.exports.ParameterGenerator = ParameterGenerator;

// Export DNA v2.0 components at top level for convenient access
module.exports.DNAGenerator = DNAGenerator;
module.exports.ArchetypeMapper = ArchetypeMapper;
module.exports.ArchetypeLoader = ArchetypeLoader;
module.exports.DNAValidator = DNAValidator;

// Export ProxyEngine at top level for event-driven UI (Sovereign Foundation)
module.exports.ProxyEngine = ProxyEngine;

// Export CropEngine at top level for viewport/crop operations
module.exports.CropEngine = require('./lib/engines/CropEngine');

// Export LabConverter at top level for RGB↔Lab I/O boundary conversions
module.exports.LabConverter = require('./lib/utils/LabConverter');

// Export MedianFilter at top level for salt-and-pepper noise removal
module.exports.MedianFilter = require('./lib/preprocessing/MedianFilter');


// Export MechanicalKnobs at top level for shared knob processing
module.exports.MechanicalKnobs = MechanicalKnobs;

// Export TrapEngine at top level for color trapping
module.exports.TrapEngine = TrapEngine;

// Export RevelationError at top level for E_rev computation
module.exports.RevelationError = RevelationError;

// Export DNAFidelity at top level for closed-loop posterization audit
module.exports.DNAFidelity = DNAFidelity;

// Export SuggestedColorAnalyzer at top level for palette suggestions
module.exports.SuggestedColorAnalyzer = SuggestedColorAnalyzer;
