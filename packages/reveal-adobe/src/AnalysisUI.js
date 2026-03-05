/**
 * AnalysisUI - DNA analysis button handler
 *
 * Imports: PluginState, FormHelpers, ColorUtils
 */

const { core } = require("photoshop");

const Reveal = require("@reveal/core");
const ParameterGenerator = Reveal.ParameterGenerator;
const ArchetypeMapper = Reveal.ArchetypeMapper;
const SeparationEngine = Reveal.engines.SeparationEngine;
const RevelationError = Reveal.RevelationError;
const logger = Reveal.logger;

const pluginState = require('./PluginState');
const { applyAnalyzedSettings, ARCHETYPES } = require('./FormHelpers');
const { resolveDistanceMetric } = require('./ColorUtils');
const PhotoshopAPI = require("./api/PhotoshopAPI");

/**
 * Compute E_rev score. Delegates to @reveal/core RevelationError.fromBuffers().
 */
function computeERev(originalLab8, processedLab8, width, height, stride) {
    const result = RevelationError.fromBuffers(originalLab8, processedLab8, width, height, { stride });
    return result.eRev;
}

/**
 * Run a single archetype trial: posterize → separate → E_rev
 *
 * @param {Uint16Array} lab16 - 16-bit Lab pixels (engine encoding)
 * @param {Uint8Array} lab8 - 8-bit Lab pixels (for E_rev)
 * @param {number} width
 * @param {number} height
 * @param {Object} dna - DNA v2.0 object
 * @param {string} archetypeId - Archetype to trial
 * @param {number} stride - E_rev sampling stride
 * @returns {Promise<number>} E_rev score
 */
async function runArchetypeTrial(lab16, lab8, width, height, dna, archetypeId, stride) {
    const pixelCount = width * height;
    const trialConfig = ParameterGenerator.generate(dna, { manualArchetypeId: archetypeId });

    const posterizeResult = await Reveal.posterizeImage(
        lab16, width, height, 8,
        {
            targetColorsSlider: 8,
            blackBias: trialConfig.blackBias,
            ditherType: trialConfig.ditherType,
            format: 'lab',
            bitDepth: 8,
            engineType: 'reveal',
            centroidStrategy: 'SALIENCY',
            lWeight: trialConfig.lWeight,
            cWeight: trialConfig.cWeight,
            substrateMode: 'auto',
            substrateTolerance: 2.0,
            vibrancyMode: trialConfig.vibrancyMode,
            vibrancyBoost: trialConfig.vibrancyBoost,
            highlightThreshold: trialConfig.highlightThreshold || 85,
            highlightBoost: trialConfig.highlightBoost || 1.0,
            enablePaletteReduction: true,
            paletteReduction: trialConfig.paletteReduction || 10.0,
            hueLockAngle: trialConfig.hueLockAngle || 20,
            shadowPoint: trialConfig.shadowPoint || 15,
            colorMode: 'color',
            preserveWhite: true,
            preserveBlack: true,
            ignoreTransparent: true,
            enableHueGapAnalysis: trialConfig.enableHueGapAnalysis !== false,
        }
    );

    const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
        lab16, posterizeResult.paletteLab, null, width, height,
        { ditherType: 'none', distanceMetric: trialConfig.distanceMetric || 'cie76' }
    );

    // Reconstruct 8-bit Lab from color indices
    const processedLab8 = new Uint8Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const color = posterizeResult.paletteLab[colorIndices[i]];
        processedLab8[i * 3]     = Math.round((color.L / 100) * 255);
        processedLab8[i * 3 + 1] = Math.round(color.a + 128);
        processedLab8[i * 3 + 2] = Math.round(color.b + 128);
    }

    return computeERev(lab8, processedLab8, width, height, stride);
}

/**
 * Audition top archetype candidates and compute E_rev for each.
 *
 * @param {Uint16Array} lab16 - 16-bit Lab pixels
 * @param {Uint8Array} lab8 - 8-bit Lab pixels
 * @param {number} width
 * @param {number} height
 * @param {Object} dna - DNA v2.0 object
 * @returns {Promise<Array<{id, name, description, eRev, dnaScore}>>} Sorted by E_rev ascending
 */
async function auditionArchetypes(lab16, lab8, width, height, dna) {
    // Build archetype array from the plugin's ARCHETYPES constant
    const archetypeList = Object.values(ARCHETYPES).filter(a => a.id && a.centroid);
    const mapper = new ArchetypeMapper(archetypeList);
    const topMatches = mapper.getTopMatches(dna, 3);

    const trials = [];
    for (const match of topMatches) {
        const archetype = archetypeList.find(a => a.id === match.id);
        const eRev = await runArchetypeTrial(lab16, lab8, width, height, dna, match.id, 2);
        trials.push({
            id: match.id,
            name: archetype?.name || match.id,
            description: archetype?.description || '',
            eRev: parseFloat(eRev.toFixed(2)),
            dnaScore: match.score
        });
    }

    // Sort by E_rev ascending (lowest error = best fit)
    trials.sort((a, b) => a.eRev - b.eRev);
    return trials;
}

/**
 * Handle Analyze Image - Extract DNA and configure parameters
 * Used by both btnAnalyzeAndSet and archetype selector dropdown
 */
async function handleAnalyzeImage() {
    const overlay = document.getElementById('busyOverlay');
    if (overlay) overlay.classList.add('active');
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
        const dna = new Reveal.DNAGenerator().generate(result.pixels, result.width, result.height, { bitDepth: 16 });
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
            // Production Quality Controls
            minVolume: config.minVolume ?? 1.5,
            speckleRescue: config.speckleRescue ?? 4,
            shadowClamp: config.shadowClamp ?? 6.0
        };

        applyAnalyzedSettings(uiSettings);

        // Audition top 3 archetype candidates with E_rev scoring
        const lab8 = PhotoshopAPI.lab16to8(result.pixels);
        let auditionResults = null;
        try {
            auditionResults = await auditionArchetypes(
                result.pixels, lab8, result.width, result.height, dna
            );
            // Store for potential UI use
            pluginState.lastAuditionResults = auditionResults;
        } catch (auditionErr) {
            logger.error("Archetype audition failed (non-fatal):", auditionErr);
        }

        // Build enhanced alert message
        if (overlay) overlay.classList.remove('active');
        const alertMsg = buildAnalysisAlert(config, auditionResults);
        alert(alertMsg);

        const archetypeSelector = document.getElementById("archetypeSelector");
        if (archetypeSelector) {
            archetypeSelector.value = 'auto';
        }

    } catch (error) {
        if (overlay) overlay.classList.remove('active');
        logger.error("Image analysis failed:", error);
        alert(
            `Image analysis failed:\n\n${error.message}\n\n` +
            `Please ensure a document is open and try again.`
        );
    }
}

/**
 * Build the analysis-complete alert message.
 * Shows primary archetype fit with E_rev and up to 2 contenders.
 */
function buildAnalysisAlert(config, auditionResults) {
    if (!auditionResults || auditionResults.length === 0) {
        // Fallback: old-style message if audition failed
        return `DNA Analysis Complete\n\n` +
            `Archetype: ${config.meta?.archetype || 'Unknown'}\n` +
            `Colors: ${config.targetColors}  |  Dither: ${config.ditherType}\n\n` +
            `Parameters have been configured.\n` +
            `Click "Posterize" to generate separations.`;
    }

    const primary = auditionResults[0];
    const contenders = auditionResults.slice(1);

    let msg = `DNA Analysis Complete\n\n`;
    msg += `Primary Fit: ${primary.name} (E_rev: ${primary.eRev.toFixed(2)})\n`;
    msg += `${primary.description}\n`;

    if (contenders.length > 0) {
        msg += `\nOther Strong Contenders:\n`;
        for (const c of contenders) {
            msg += `  - ${c.name} (E_rev: ${c.eRev.toFixed(2)})\n`;
        }
    }

    msg += `\n(You can manually select these from the dropdown if you prefer a different style.)\n`;
    msg += `\nParameters configured for ${primary.name}.\n`;
    msg += `Click "Posterize" to generate separations.`;

    return msg;
}

module.exports = {
    handleAnalyzeImage,
    auditionArchetypes,
    buildAnalysisAlert
};
