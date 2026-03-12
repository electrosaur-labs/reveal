/**
 * Engine — Reusable configuration and execution for the Recipe Engine.
 *
 * Accumulates archetype and parameter settings. Stateless — does not hold
 * image data or palette. Can be reused across multiple images.
 *
 * @module recipe/Engine
 */

const ArchetypeLoader = require('../analysis/ArchetypeLoader');
const ParameterGenerator = require('../analysis/ParameterGenerator');
const PosterizationEngine = require('../engines/PosterizationEngine');
const SeparationEngine = require('../engines/SeparationEngine');
const BilateralFilter = require('../preprocessing/BilateralFilter');
const { Palette } = require('./Palette');
const Result = require('./Result');

// All valid parameter keys (union of CONFIG_CATEGORIES)
const VALID_PARAMS = new Set([
    // Structural
    'targetColors', 'engineType', 'centroidStrategy', 'distanceMetric',
    'lWeight', 'cWeight', 'bWeight', 'blackBias',
    'vibrancyMode', 'vibrancyBoost', 'highlightThreshold', 'highlightBoost',
    'paletteReduction', 'enablePaletteReduction', 'hueLockAngle', 'shadowPoint',
    'colorMode', 'preserveWhite', 'preserveBlack', 'ignoreTransparent',
    'neutralCentroidClampThreshold', 'neutralSovereigntyThreshold',
    'chromaGate', 'preprocessingIntensity', 'refinementPasses', 'splitMode',
    'substrateMode', 'substrateTolerance', 'enableHueGapAnalysis',
    'quantizer', 'chromaAxisWeight',
    // Mechanical
    'minVolume', 'speckleRescue', 'shadowClamp',
    // Production
    'ditherType', 'meshSize', 'trapSize',
    // Target colors range
    'minColors', 'maxColors', 'targetColorsSlider'
]);

class Engine {
    constructor() {
        this._archetypeName = null;
        this._params = {};
    }

    /**
     * Load a named archetype and apply its parameters.
     * Optional overrides merge on top.
     *
     * @param {string} name - Archetype name (e.g., "salamander", "chameleon")
     * @param {Object} [overrides] - Parameters to override
     */
    applyArchetype(name, overrides = {}) {
        if (typeof name !== 'string' || !name) {
            throw new Error('Engine.applyArchetype: name must be a non-empty string');
        }

        // Validate override keys
        this._validateKeys(overrides, 'Engine.applyArchetype overrides');

        // Verify the archetype exists
        const archetypes = ArchetypeLoader.loadArchetypes();
        const found = archetypes.find(a =>
            a.id === name || a.name === name ||
            a.id === name.toLowerCase() || a.name.toLowerCase() === name.toLowerCase()
        );

        if (!found) {
            const available = archetypes.map(a => a.id).join(', ');
            throw new Error(
                `Engine.applyArchetype: unknown archetype "${name}". ` +
                `Available: ${available}`
            );
        }

        this._archetypeName = found.id;
        // Store overrides — they'll be applied at quantize() time via ParameterGenerator
        this._params = { ...this._params, ...overrides };
    }

    /**
     * Set a single parameter. Throws on unrecognized keys.
     *
     * @param {string} key - Parameter name
     * @param {*} value - Parameter value
     */
    setParam(key, value) {
        if (!VALID_PARAMS.has(key)) {
            throw new Error(
                `Engine.setParam: unrecognized parameter "${key}". ` +
                `Valid parameters: ${[...VALID_PARAMS].sort().join(', ')}`
            );
        }
        this._params[key] = value;
    }

    /**
     * Set multiple parameters at once. Throws on any unrecognized key.
     *
     * @param {Object} params - Key/value pairs
     */
    setParams(params) {
        if (!params || typeof params !== 'object') {
            throw new Error('Engine.setParams: params must be an object');
        }
        this._validateKeys(params, 'Engine.setParams');
        Object.assign(this._params, params);
    }

    /**
     * Quantize an image: run preprocessing + posterization.
     * Returns a new Palette. The engine is not mutated.
     *
     * @param {Image} image - Frozen Image object
     * @param {Object} [options] - Override params for this call only
     * @returns {Palette}
     */
    quantize(image, options = {}) {
        this._validateImage(image);
        this._validateKeys(options, 'Engine.quantize options');

        // Merge: archetype params + engine params + call-time overrides
        const config = this._resolveConfig(image, options);

        // Preprocessing: bilateral filter
        let labPixels = image.labPixels;
        if (config.preprocessingIntensity && config.preprocessingIntensity !== 'off') {
            const intensity = config.preprocessingIntensity === 'auto'
                ? BilateralFilter.autoIntensity(image.labPixels, image.width, image.height)
                : config.preprocessingIntensity;

            if (intensity !== 'off') {
                labPixels = BilateralFilter.apply(
                    image.labPixels, image.width, image.height,
                    { intensity, bitDepth: image.bitDepth }
                );
            }
        }

        // Posterize — ensure bitDepth and format are in config so engines know it's Lab data
        config.bitDepth = image.bitDepth;
        config.format = 'lab';
        const targetColors = config.targetColors || 8;
        const result = PosterizationEngine.posterize(
            labPixels, image.width, image.height, targetColors, config
        );

        // Convert posterization result to Palette
        const labColors = result.paletteLab || result.palette.map(rgb => {
            return require('../color/LabEncoding').rgbToLab(rgb);
        });

        return new Palette(labColors, {
            coverages: this._computeCoverages(result.assignments, labColors.length, image.width * image.height)
        });
    }

    /**
     * Separate an image using the given palette.
     * Maps every pixel to the nearest palette color.
     * Returns a new Result.
     *
     * @param {Image} image - Frozen Image object
     * @param {Palette} palette - Palette from quantize() (possibly modified by surgery)
     * @param {Object} [options] - Override params (ditherType, distanceMetric, etc.)
     * @returns {Result}
     */
    separate(image, palette, options = {}) {
        this._validateImage(image);
        if (!palette || !palette.colors) {
            throw new Error('Engine.separate: palette must be a Palette object');
        }
        this._validateKeys(options, 'Engine.separate options');

        const config = { ...this._params, ...options };

        // Build Lab palette array for SeparationEngine
        const labPalette = palette._entries.map(e => ({
            L: e.L, a: e.a, b: e.b
        }));

        // Map pixels to palette
        const colorIndices = SeparationEngine.mapPixelsToPalette(
            image.labPixels, labPalette, image.width, image.height, {
                ditherType: config.ditherType || 'none',
                distanceMetric: config.distanceMetric || 'cie76',
                meshCount: config.meshSize,
                bitDepth: image.bitDepth
            }
        );

        return new Result({
            colorIndices,
            labPalette,
            width: image.width,
            height: image.height,
            metadata: {
                archetype: this._archetypeName,
                quantizer: config.quantizer || 'median-cut',
                engineType: config.engineType,
                ditherType: config.ditherType || 'none',
                distanceMetric: config.distanceMetric || 'cie76'
            }
        });
    }

    // ─── Internal ───

    /**
     * Resolve full config from archetype + params + overrides.
     * @private
     */
    _resolveConfig(image, overrides) {
        let config = {};

        // If an archetype is set, generate config from DNA
        if (this._archetypeName) {
            config = ParameterGenerator.generate(image.dna, {
                manualArchetypeId: this._archetypeName
            });
        }

        // Layer engine params on top
        Object.assign(config, this._params);

        // Layer call-time overrides on top
        Object.assign(config, overrides);

        return config;
    }

    /**
     * Compute per-color coverage from assignments.
     * @private
     */
    _computeCoverages(assignments, paletteSize, totalPixels) {
        if (!assignments || totalPixels === 0) return null;
        const counts = new Uint32Array(paletteSize);
        for (let i = 0; i < assignments.length; i++) {
            if (assignments[i] < paletteSize) {
                counts[assignments[i]]++;
            }
        }
        return Array.from(counts).map(c => c / totalPixels);
    }

    /**
     * Validate that all keys in an object are recognized parameters.
     * @private
     */
    _validateKeys(obj, context) {
        for (const key of Object.keys(obj)) {
            if (!VALID_PARAMS.has(key)) {
                throw new Error(
                    `${context}: unrecognized parameter "${key}". ` +
                    `Valid parameters: ${[...VALID_PARAMS].sort().join(', ')}`
                );
            }
        }
    }

    /**
     * Validate that input is a Recipe Image.
     * @private
     */
    _validateImage(image) {
        if (!image || !image.labPixels || !image.width || !image.height || !image.dna) {
            throw new Error('Engine: image must be a Recipe Image with labPixels, width, height, and dna');
        }
    }
}

module.exports = Engine;
