/**
 * ParameterGenerator v4.0 - DNA v2.0 Data-Driven Archetype System
 * Maps Image DNA to archetype parameters using JSON-defined archetypes
 *
 * CHANGELOG:
 * - v1.x-3.x: Hardcoded archetype classification and parameter overrides
 * - v4.0: DATA-DRIVEN - Loads archetypes from JSON, uses 4D weighted distance matching
 *
 * DNA v2.0 ARCHITECTURE:
 * 1. Load archetype definitions from JSON files (reveal-core/archetypes/*.json)
 * 2. Match image DNA to nearest archetype using 4D weighted Euclidean distance
 * 3. Use archetype parameters directly (NO dynamic overrides)
 * 4. Fixed parameters per archetype ensure predictable, testable behavior
 *
 * BENEFITS:
 * - No "Thermonuclear" morphing or conditional override logic
 * - Archetypes are version-controlled and self-documenting
 * - Adding new archetypes requires zero code changes
 * - Predictable behavior: same DNA always maps to same parameters
 * - Testable: can validate archetype matching independently
 */

const ArchetypeLoader = require('./ArchetypeLoader');
const BilateralFilter = require('../preprocessing/BilateralFilter');

class DynamicConfigurator {

    /**
     * Generate configuration from DNA analysis using data-driven archetypes
     *
     * @param {Object} dna - DNA analysis result
     * @param {Object} [options] - Generation options
     * @param {Uint8ClampedArray} [options.imageData] - RGBA data for entropy calculation
     * @param {number} [options.width] - Image width
     * @param {number} [options.height] - Image height
     * @param {string} [options.preprocessingIntensity='auto'] - 'off', 'auto', 'light', 'heavy'
     * @returns {Object} Complete configuration from matched archetype
     */
    static generate(dna, options = {}) {
        // 1. Match DNA to nearest archetype using 4D weighted distance
        const archetype = ArchetypeLoader.matchArchetype(dna);

        // 2. Clone archetype parameters (deep copy to avoid mutations)
        const params = JSON.parse(JSON.stringify(archetype.parameters));

        // 3. Set bit depth metadata for distance metric selection
        const bitDepth = dna.bitDepth || 8;

        // 4. Configure preprocessing (conditional based on image entropy)
        const preprocessingIntensity = options.preprocessingIntensity || params.preprocessingIntensity || 'auto';
        const preprocessing = BilateralFilter.createPreprocessingConfig(
            { ...dna, archetype: archetype.name },
            options.imageData || null,
            options.width || 0,
            options.height || 0,
            preprocessingIntensity
        );

        if (preprocessing.enabled) {
            console.log(`🔧 Preprocessing: ${preprocessing.intensity} (${preprocessing.reason})`);
        }

        // 5. Build complete configuration
        const config = {
            // Identity
            id: archetype.id,
            name: archetype.name,

            // Core parameters from archetype (FIXED - no overrides)
            targetColors: params.targetColorsSlider || params.targetColors || 10,
            ditherType: params.ditherType || 'blue-noise',
            distanceMetric: params.distanceMetric || 'cie76',

            // Saliency weights
            lWeight: params.lWeight || 1.2,
            cWeight: params.cWeight || 2.0,
            blackBias: params.blackBias || 3.0,

            // Vibrancy
            vibrancyMode: params.vibrancyMode || 'moderate',
            vibrancyBoost: params.vibrancyBoost || 1.4,
            vibrancyThreshold: params.vibrancyThreshold || 10,
            saturationBoost: params.vibrancyBoost || 1.4,  // Legacy alias

            // Highlights
            highlightThreshold: params.highlightThreshold || 90,
            highlightBoost: params.highlightBoost || 1.5,

            // Color merging
            paletteReduction: params.paletteReduction || 6.0,
            enablePaletteReduction: params.enablePaletteReduction !== undefined ? params.enablePaletteReduction : true,

            // Substrate
            substrateMode: params.substrateMode || 'auto',
            substrateTolerance: params.substrateTolerance || 2.0,

            // Hue analysis
            enableHueGapAnalysis: params.enableHueGapAnalysis !== undefined ? params.enableHueGapAnalysis : true,
            hueLockAngle: params.hueLockAngle || 20,

            // Shadow/highlight points
            shadowPoint: params.shadowPoint || 15,

            // Color mode
            colorMode: params.colorMode || 'color',

            // Preservation flags
            preserveWhite: params.preserveWhite !== undefined ? params.preserveWhite : true,
            preserveBlack: params.preserveBlack !== undefined ? params.preserveBlack : true,
            ignoreTransparent: params.ignoreTransparent !== undefined ? params.ignoreTransparent : true,

            // Mask profile
            maskProfile: params.maskProfile || 'Gray Gamma 2.2',

            // Neutral clamping (DNA v2.0 feature)
            neutralCentroidClampThreshold: params.neutralCentroidClampThreshold || 0.5,
            neutralSovereigntyThreshold: params.neutralSovereigntyThreshold || 0,

            // Legacy fields
            rangeClamp: [dna.minL || 0, dna.maxL || 100],

            // Metadata
            meta: {
                archetype: archetype.name,
                archetypeId: archetype.id,
                peakChroma: dna.maxC || dna.c || 0,
                isPhoto: archetype.name.includes('Photo') || archetype.name.includes('Cinematic'),
                isGraphic: archetype.name.includes('Graphic') || archetype.name.includes('Neon'),
                isArchive: bitDepth === 16,
                bitDepth: bitDepth,
                matchDistance: dna.matchDistance || 0  // Set by ArchetypeLoader
            },

            // Preprocessing
            preprocessing
        };

        // Log configuration selection
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 25;
        const meanC = dna.c || 0;
        const peakChroma = dna.maxC || meanC;
        console.log(`🧬 DNA: L=${dna.l?.toFixed(1) || '?'} C=${meanC.toFixed(1)} σL=${l_std_dev.toFixed(1)} peakC=${peakChroma.toFixed(1)}`);
        console.log(`🎯 Archetype: ${archetype.name} → ${config.ditherType}, blackBias=${config.blackBias}, ${config.targetColors} colors`);

        return config;
    }

    /**
     * DEPRECATED: Legacy archetype classification (kept for backward compatibility)
     * Use ArchetypeLoader.matchArchetype() instead
     */
    static getArchetype(dna) {
        console.warn('⚠️ getArchetype() is deprecated. Use ArchetypeLoader.matchArchetype() instead.');
        const archetype = ArchetypeLoader.matchArchetype(dna);
        return archetype.name;
    }

    /**
     * DEPRECATED: Legacy strategy mapper (kept for backward compatibility)
     * Parameters are now embedded in archetype JSON files
     */
    static getStrategy(archetype, dna) {
        console.warn('⚠️ getStrategy() is deprecated. Parameters are now in archetype JSON files.');
        return {
            dither: 'blue-noise',
            bias: 3.0
        };
    }
}

module.exports = DynamicConfigurator;
