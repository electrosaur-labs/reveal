/**
 * LegacyAdapter - Transitional bridge for Reveal Core
 *
 * Initially routes all calls to the proven monolithic 16-bit engines.
 * This establishes the architectural shim needed for incremental modularization
 * without breaking the reveal-navigator reference implementation.
 */

const PosterizationEngine = require('../engines/PosterizationEngine');
const SeparationEngine = require('../engines/SeparationEngine');
const PreviewEngine = require('../engines/PreviewEngine');
const DocumentValidator = require('../validation/DocumentValidator');
const DNAValidator = require('../validation/DNAValidator');
const ImageHeuristicAnalyzer = require('../analysis/ImageHeuristicAnalyzer');
const LabEncoding = require('../color/LabEncoding');
const BilateralFilter = require('../preprocessing/BilateralFilter');
const ParameterGenerator = require('../analysis/ParameterGenerator');
const DNAGenerator = require('../analysis/DNAGenerator');
const ArchetypeMapper = require('../analysis/ArchetypeMapper');
const ArchetypeLoader = require('../analysis/ArchetypeLoader');
const MechanicalKnobs = require('../engines/MechanicalKnobs');
const TrapEngine = require('../engines/TrapEngine');
const RevelationError = require('../metrics/RevelationError');
const DNAFidelity = require('../metrics/DNAFidelity');
const logger = require('../utils/logger');
const { InterpolatorEngine } = require('../analysis/InterpolatorEngine');

let _interpolatorEngine = null;

const LegacyAdapter = {
    version: '2.0.0-legacy-adapter',
    logger,

    // --- Configuration ---

    generateConfiguration(dna, options = {}) {
        return ParameterGenerator.generate(dna, options);
    },

    generateConfigurationMk2(dna) {
        if (!_interpolatorEngine) {
            const model = require('../analysis/interpolator-model.json');
            _interpolatorEngine = new InterpolatorEngine(model);
        }
        const flatDna = dna.global ? { ...dna.global } : dna;
        const { parameters, blendInfo } = _interpolatorEngine.interpolate(flatDna);
        const config = { ...parameters };
        config.engineType = 'distilled';
        if (config.splitMode === undefined) config.splitMode = 'median';
        if (config.maxColors !== undefined) config.targetColors = config.maxColors;
        if (config.targetColorsSlider === undefined && config.targetColors !== undefined) {
            config.targetColorsSlider = config.targetColors;
        }
        config.speckleRescue = 5;
        config.meta = { blendInfo, engine: 'mk2-interpolator' };
        return config;
    },

    generateConfigurationDistilled(dna) {
        return {
            engineType: 'distilled',
            targetColors: 12,
            targetColorsSlider: 12,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
            peakFinderMaxPeaks: 1,
            splitMode: 'median',
            preprocessingIntensity: 'off',
            distanceMetric: 'cie76',
            ditherType: 'none',
            speckleRescue: 5,
            lWeight: 1.2,
            cWeight: 2.0,
            blackBias: 3.0,
            vibrancyBoost: 1.4,
            highlightThreshold: 90,
            highlightBoost: 1.5,
            shadowPoint: 15,
            paletteReduction: 6.0,
            hueLockAngle: 20,
            chromaGate: 1.0,
            substrateTolerance: 2.0,
            detailRescue: 0,
            neutralCentroidClampThreshold: 0.5,
            neutralSovereigntyThreshold: 0,
        };
    },

    generateConfigurationSalamander(dna) {
        const config = this.generateConfigurationMk2(dna);
        config.engineType = 'distilled';
        config.enablePaletteReduction = false;
        config.snapThreshold = 0;
        config.densityFloor = 0;
        config.preprocessingIntensity = 'off';
        config.ditherType = 'atkinson';
        config.meta = { ...config.meta, engine: 'salamander' };
        return config;
    },

    // --- Analysis ---

    analyzeImage(labPixels, width, height) {
        return ImageHeuristicAnalyzer.analyze(labPixels, width, height);
    },

    // --- Processing ---

    preprocessImage(imageData, width, height, config) {
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
    },

    calculateEntropy(imageData, width, height) {
        return BilateralFilter.calculateEntropyScore(imageData, width, height);
    },

    async posterizeImage(labPixels, width, height, colorCount, parameters = {}, onProgress = null) {
        return PosterizationEngine.posterize(labPixels, width, height, colorCount, parameters, onProgress);
    },

    async separateImage(labPixels, palette, width, height, parameters = {}, onProgress = null) {
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
    },

    generateMask(colorIndices, colorIndex, width, height) {
        return SeparationEngine.generateLayerMask(colorIndices, colorIndex, width, height);
    },

    generatePreview(labPixels, labPalette, rgbPalette) {
        return PreviewEngine.generatePreview(labPixels, labPalette, rgbPalette);
    },

    // --- Utilities ---

    validateDocument(doc) {
        return DocumentValidator.validate(doc);
    },

    validateDNA(dna) {
        return DNAValidator.validate(dna);
    },

    getDefaultParameters() {
        return PosterizationEngine.getDefaultParameters();
    },

    getPresetParameters(presetId) {
        return PosterizationEngine.getPresetParameters(presetId);
    },

    rgbToLab(r, g, b) {
        if (typeof r === 'object') return PosterizationEngine.rgbToLab(r);
        return PosterizationEngine.rgbToLab({ r, g, b });
    },

    labToRgb(L, a, b) {
        if (typeof L === 'object') return PosterizationEngine.labToRgb(L);
        return PosterizationEngine.labToRgb({ L, a, b });
    }
};

module.exports = LegacyAdapter;
