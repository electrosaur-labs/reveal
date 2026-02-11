/**
 * AnalysisUI - DNA analysis button handler
 *
 * Imports: PluginState, FormHelpers, ColorUtils
 */

const { core } = require("photoshop");

const Reveal = require("@reveal/core");
const ParameterGenerator = require("@reveal/core/lib/analysis/ParameterGenerator");
const logger = Reveal.logger;

const pluginState = require('./PluginState');
const { applyAnalyzedSettings } = require('./FormHelpers');
const { resolveDistanceMetric } = require('./ColorUtils');
const PhotoshopAPI = require("./api/PhotoshopAPI");
const DNAGenerator = require("./DNAGenerator");

/**
 * Handle Analyze Image - Extract DNA and configure parameters
 * Used by both btnAnalyzeAndSet and archetype selector dropdown
 */
async function handleAnalyzeImage() {

    try {
        const result = await core.executeAsModal(async () => {
            const pixelData = await PhotoshopAPI.getDocumentPixels(800, 800);
            return {
                pixels: pixelData.pixels,
                width: pixelData.width,
                height: pixelData.height
            };
        }, { commandName: "Analyze Document DNA" });

        const startTime = Date.now();
        const dna = DNAGenerator.generate(result.pixels, result.width, result.height, 40);
        const dnaTime = Date.now() - startTime;

        const config = ParameterGenerator.generate(dna, {
            imageData: result.pixels,
            width: result.width,
            height: result.height,
            preprocessingIntensity: 'auto',
            manualArchetypeId: pluginState.lastSelectedArchetypeId
        });

        if (config.preprocessing) {
            const pp = config.preprocessing;
            if (pp.entropyScore !== undefined) {
            }
        }

        pluginState.lastImageDNA = {
            ...dna,
            archetype: config.meta?.archetype || null,
            preprocessing: config.preprocessing
        };
        pluginState.lastGeneratedConfig = config;

        let preprocessingDropdownValue = 'off';
        if (config.preprocessing) {
            if (config.preprocessing.enabled) {
                preprocessingDropdownValue = config.preprocessing.intensity || 'light';
            } else {
                preprocessingDropdownValue = 'off';
            }
        }

        const uiSettings = {
            targetColorsSlider: config.targetColors,
            ditherType: config.ditherType,
            distanceMetric: config.distanceMetric || 'auto',

            lWeight: config.lWeight,
            cWeight: config.cWeight,
            blackBias: config.blackBias,

            vibrancyMode: config.vibrancyMode,
            vibrancyBoost: config.vibrancyBoost,
            vibrancyThreshold: config.vibrancyThreshold,

            highlightThreshold: config.highlightThreshold,
            highlightBoost: config.highlightBoost,

            enablePaletteReduction: config.enablePaletteReduction !== false,
            paletteReduction: config.paletteReduction,

            substrateMode: config.substrateMode,
            substrateTolerance: config.substrateTolerance || 3.5,

            neutralSovereigntyThreshold: config.neutralSovereigntyThreshold,
            neutralCentroidClampThreshold: config.neutralCentroidClampThreshold,

            preprocessingIntensity: config.preprocessingIntensity || preprocessingDropdownValue,

            engineType: config.engineType || 'reveal-mk1.5',
            centroidStrategy: config.centroidStrategy || 'SALIENCY',
            hueLockAngle: config.hueLockAngle || 20,
            shadowPoint: config.shadowPoint || 15,
            colorMode: config.colorMode || 'color',
            preserveWhite: config.preserveWhite !== false,
            preserveBlack: config.preserveBlack !== false,
            ignoreTransparent: config.ignoreTransparent !== false,
            enableHueGapAnalysis: config.enableHueGapAnalysis !== false,
            maskProfile: config.maskProfile || 'Gray Gamma 2.2',

            // Production Quality Controls
            minVolume: config.minVolume ?? 1.5,
            speckleRescue: config.speckleRescue ?? 4,
            shadowClamp: config.shadowClamp ?? 6.0
        };

        applyAnalyzedSettings(uiSettings);

        const smartMetric = resolveDistanceMetric('auto', pluginState.lastImageDNA);
        const smartMetricLabels = { 'cie76': 'Poster/Graphic', 'cie94': 'Photographic', 'cie2000': 'Museum Grade' };
        const smartMetricLabel = smartMetricLabels[smartMetric] || smartMetric;

        let preprocessingInfo = 'Off';
        if (config.preprocessing) {
            if (config.preprocessing.enabled) {
                const entropy = config.preprocessing.entropyScore?.toFixed(0) || '?';
                preprocessingInfo = `${config.preprocessing.intensity} (entropy: ${entropy})`;
            } else {
                preprocessingInfo = `Skipped (${config.preprocessing.reason})`;
            }
        }

        const alertMsg = `Image Analysis Complete\n\nProfile: ${config.name}\nArchetype: ${config.meta?.archetype || 'Unknown'}\nColors: ${config.targetColors}\nDither: ${config.ditherType}\nPreprocessing: ${preprocessingInfo}\n\nParameters have been configured.\nClick "Posterize" to generate separations.`;

        alert(alertMsg);

        const archetypeSelector = document.getElementById("archetypeSelector");
        if (archetypeSelector) {
            archetypeSelector.value = 'auto';
        }

    } catch (error) {
        logger.error("Image analysis failed:", error);
        alert(
            `Image analysis failed:\n\n${error.message}\n\n` +
            `Please ensure a document is open and try again.`
        );
    }
}

module.exports = {
    handleAnalyzeImage
};
