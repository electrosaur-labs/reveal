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
const DocumentValidator = require('./lib/validation/DocumentValidator');
const ImageHeuristicAnalyzer = require('./lib/analysis/ImageHeuristicAnalyzer');
const LabDistance = require('./lib/color/LabDistance');
const logger = require('./lib/utils/logger');

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
    return PosterizationEngine.rgbToLab(r, g, b);
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
    return PosterizationEngine.labToRgb(L, a, b);
}

// Export agent-optimized API
module.exports = {
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

    // Metadata
    version: '1.0.0',
    logger
};

// Also export raw engines for advanced use
module.exports.engines = {
    PosterizationEngine,
    SeparationEngine,
    PreviewEngine,
    DocumentValidator,
    ImageHeuristicAnalyzer,

    // Modular components (v2.0)
    ColorSpace: require('./lib/engines/ColorSpace'),
    HueAnalysis: require('./lib/engines/HueAnalysis'),
    CentroidStrategies: require('./lib/engines/CentroidStrategies').CentroidStrategies,
    DitheringStrategies: require('./lib/engines/DitheringStrategies').DitheringStrategies,

    // Lab color distance calculations (v2.1)
    LabDistance: LabDistance
};

// Export LabDistance at top level for convenient access
module.exports.LabDistance = LabDistance;
