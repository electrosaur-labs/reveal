/**
 * ParameterGenerator v3.0 - Expert System Configurator
 * Maps Image DNA to ALL tunable UI parameters
 *
 * CHANGELOG:
 * - v1.3: Chroma Driver for color budgeting
 * - v1.4: Saliency Rescue threshold raised to maxC > 80
 * - v1.5: Dither logic based on l_std_dev instead of k
 * - v1.7: Archetype classification with per-archetype strategies
 * - v1.8: Added distanceMetric selection (CIE76 vs CIE94) based on chroma
 * - v1.9: Simplified distanceMetric selection using peakChroma threshold
 * - v2.0: Added preprocessing configuration (bilateral filter based on entropy)
 * - v3.0: Full parameter mapping - DNA drives ALL UI sliders
 *
 * DISTANCE METRIC SELECTION:
 * - 16-bit images → CIE2000 (museum grade precision)
 * - peakChroma > 80 OR isPhotographic → CIE94 (perceptual)
 * - Otherwise → CIE76 (graphic, faster)
 *
 * FULL PARAMETER MAPPING (v3.0):
 * | DNA Condition           | Parameter          | Value              |
 * |-------------------------|--------------------|--------------------|
 * | isPhoto                 | lWeight            | 1.4                |
 * | isGraphic               | lWeight            | 1.1                |
 * | isArchive               | cWeight            | 2.3                |
 * | bitDepth === 16         | distanceMetric     | 'cie2000'          |
 * | lowChromaDensity > 0.6  | vibrancyMode       | 'exponential'      |
 * | isArchive               | paletteReduction   | 6.5                |
 * | meanL < 30              | substrateMode      | 'black'            |
 * | meanL > 70              | substrateMode      | 'white'            |
 * | meanL < 40              | blackBias          | 8.0                |
 * | isPhoto                 | ditherType         | 'blue-noise'       |
 * | isGraphic               | ditherType         | 'none' or 'atkinson'|
 *
 * ARCHETYPES:
 * - Vector/Flat:    Low variation (l_std_dev < 15). Logos, icons, text.
 * - Vintage/Muted:  Low variation + moderate chroma. Lithographs, WPA posters.
 * - Noir/Mono:      Low chroma + high contrast. B&W photos, woodcuts.
 * - Neon/Vibrant:   Extreme chroma (c > 60). Pop art, neon signs.
 * - Photographic:   High variation + moderate chroma. Natural photos.
 */

const BilateralFilter = require('../preprocessing/BilateralFilter');
class DynamicConfigurator {

    /**
     * Generate configuration from DNA analysis
     *
     * @param {Object} dna - DNA analysis result
     * @param {Object} [options] - Generation options
     * @param {Uint8ClampedArray} [options.imageData] - RGBA data for entropy calculation
     * @param {number} [options.width] - Image width
     * @param {number} [options.height] - Image height
     * @param {string} [options.preprocessingIntensity='auto'] - 'off', 'auto', 'light', 'heavy'
     * @returns {Object} Complete configuration including ALL tunable parameters
     */
    static generate(dna, options = {}) {
        // ================================================================
        // 1. CLASSIFY ARCHETYPE
        // ================================================================
        const archetype = this.getArchetype(dna);

        // ================================================================
        // 2. DERIVE FLAGS FROM DNA
        // ================================================================
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 50;
        const meanL = dna.l || 50;
        const meanC = dna.c || 20;
        const peakChroma = dna.maxC || 0;
        const bitDepth = dna.bitDepth || 8;
        const lowChromaDensity = dna.lowChromaDensity || 0;  // % of pixels with C < 15

        // Derived classification flags
        const isPhoto = archetype === 'Photographic' || (l_std_dev > 25 && meanC > 15 && meanC < 50);
        const isGraphic = archetype === 'Vector/Flat' || l_std_dev < 15;
        const isArchive = bitDepth === 16 && meanC < 30 && l_std_dev > 20;  // 16-bit + muted + detailed
        const isNoir = archetype === 'Noir/Mono' || (meanC < 10 && dna.k > 60);
        const isVibrant = archetype === 'Neon/Vibrant' || meanC > 60;

        // ================================================================
        // 3. SALIENCY WEIGHTS (lWeight, cWeight)
        // ================================================================
        let lWeight = 1.1;  // Default balanced
        let cWeight = 2.0;  // Default balanced

        if (isPhoto) {
            lWeight = 1.4;  // Photos: favor brighter pixels for skin tones
            cWeight = 2.0;
        } else if (isGraphic) {
            lWeight = 1.1;  // Graphics: balanced
            cWeight = 1.8;
        } else if (isArchive) {
            lWeight = 1.2;
            cWeight = 2.3;  // Archives: protect subtle chroma variations
        } else if (isNoir) {
            lWeight = 1.5;  // Noir: strong L priority for tonal separation
            cWeight = 1.2;
        }

        // ================================================================
        // 4. VIBRANCY SETTINGS
        // ================================================================
        let vibrancyMode = 'aggressive';  // Default
        let vibrancyBoost = 1.6;

        if (lowChromaDensity > 0.6 || isArchive) {
            // Muted images: exponential boost to rescue color
            vibrancyMode = 'exponential';
            vibrancyBoost = 2.2;
        } else if (isVibrant) {
            // Already vibrant: gentle linear
            vibrancyMode = 'linear';
            vibrancyBoost = 1.2;
        } else if (meanC < 15) {
            // Low chroma: stronger boost
            vibrancyBoost = 2.0;
        }

        // ================================================================
        // 5. HIGHLIGHT SETTINGS
        // ================================================================
        let highlightThreshold = 85;
        let highlightBoost = 2.2;

        if (isPhoto) {
            highlightThreshold = 85;  // Photos: protect facial highlights
            highlightBoost = 1.8;
        } else if (isGraphic) {
            highlightThreshold = 90;  // Graphics: only extreme whites
            highlightBoost = 2.2;
        } else if (isNoir) {
            highlightThreshold = 80;  // Noir: protect more highlights
            highlightBoost = 3.0;
        }

        // ================================================================
        // 6. DISTANCE METRIC SELECTION
        // ================================================================
        let distanceMetric;
        if (bitDepth === 16) {
            distanceMetric = 'cie2000';  // 16-bit: museum grade precision
        } else if (isGraphic) {
            distanceMetric = 'cie76';    // Graphics: fast, sufficient
        } else if (peakChroma > 80 || isPhoto) {
            distanceMetric = 'cie94';    // Saturated/Photos: perceptual
        } else {
            distanceMetric = 'cie76';    // Default: fast
        }

        // ================================================================
        // 7. PALETTE REDUCTION THRESHOLD
        // ================================================================
        let paletteReduction = 10.0;  // Default ΔE threshold

        if (isArchive) {
            paletteReduction = 6.5;   // Archives: preserve subtle differences
        } else if (isGraphic) {
            paletteReduction = 12.0;  // Graphics: merge more aggressively
        } else if (isPhoto) {
            paletteReduction = 8.0;   // Photos: moderate
        }

        // ================================================================
        // 8. SUBSTRATE MODE (based on mean lightness)
        // ================================================================
        let substrateMode = 'auto';

        if (meanL < 30) {
            substrateMode = 'black';  // Dark image: likely black substrate
        } else if (meanL > 70) {
            substrateMode = 'white';  // Light image: white paper
        }

        // ================================================================
        // 9. BLACK BIAS (halftone protection)
        // ================================================================
        const strategy = this.getStrategy(archetype, dna);
        let blackBias = strategy.bias;

        // Override based on meanL
        if (meanL < 40) {
            blackBias = Math.max(blackBias, 8.0);  // Dark images need strong protection
        } else if (meanL > 60) {
            blackBias = Math.min(blackBias, 3.0);  // Light images: relax
        }

        // ================================================================
        // 10. DITHER TYPE
        // ================================================================
        let ditherType = strategy.dither;

        // Override based on archetype
        if (isPhoto && ditherType === 'atkinson') {
            ditherType = 'blue-noise';  // Photos need smooth gradients
        } else if (isGraphic && peakChroma < 40) {
            ditherType = 'none';  // Flat graphics: no dither needed
        }

        // ================================================================
        // 11. COLOR COUNT LOGIC (The "Chroma Driver")
        // ================================================================
        let idealColors = 8;
        if (meanC > 20) idealColors = 10;
        if (meanC > 50) idealColors = 12;

        // Saliency Rescue: Hidden color spike in muted image
        if (meanC < 12 && peakChroma > 80) {
            console.log(`🚑 Saliency Rescue: ${dna.filename || 'unknown'} (High Value Spike)`);
            idealColors = 10;
        }

        const finalColors = Math.max(4, Math.min(idealColors, 12));

        // ================================================================
        // 12. PREPROCESSING CONFIGURATION
        // ================================================================
        const preprocessingIntensity = options.preprocessingIntensity || 'auto';
        const preprocessing = BilateralFilter.createPreprocessingConfig(
            { ...dna, archetype },
            options.imageData || null,
            options.width || 0,
            options.height || 0,
            preprocessingIntensity
        );

        if (preprocessing.enabled) {
            console.log(`🔧 Preprocessing: ${preprocessing.intensity} (${preprocessing.reason})`);
        }

        // ================================================================
        // LOG CONFIGURATION
        // ================================================================
        console.log(`🧬 DNA: StdDev=${l_std_dev.toFixed(1)} C=${meanC.toFixed(1)} peakC=${peakChroma.toFixed(1)} -> Archetype: ${archetype}, Metric: ${distanceMetric}`);

        // ================================================================
        // RETURN COMPLETE CONFIGURATION
        // ================================================================
        return {
            // Identity
            id: `auto_${archetype.toLowerCase().replace('/', '_')}`,
            name: "Dynamic Bespoke",

            // Core posterization
            targetColors: finalColors,
            ditherType: ditherType,
            distanceMetric: distanceMetric,

            // Saliency weights
            lWeight: lWeight,
            cWeight: cWeight,
            blackBias: blackBias,

            // Vibrancy
            vibrancyMode: vibrancyMode,
            vibrancyBoost: vibrancyBoost,
            saturationBoost: vibrancyBoost,  // Legacy alias

            // Highlights
            highlightThreshold: highlightThreshold,
            highlightBoost: highlightBoost,

            // Color merging
            paletteReduction: paletteReduction,

            // Substrate
            substrateMode: substrateMode,

            // Legacy fields
            rangeClamp: [dna.minL, dna.maxL],

            // Metadata
            meta: {
                archetype,
                peakChroma,
                isPhoto,
                isGraphic,
                isArchive,
                bitDepth
            },

            // Preprocessing
            preprocessing
        };
    }

    /**
     * THE ARCHETYPE CLASSIFIER
     * Based on Tonal Variation (StdDev) and Chroma Intensity
     */
    static getArchetype(dna) {
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 50;
        const c = dna.c || 0;
        const k = dna.k || 0;

        // 1. VECTOR / FLAT
        // Extremely low variation. Flat fields of color.
        // Captures Logos, Text, Icons.
        if (l_std_dev < 15) {
            return 'Vector/Flat';
        }

        // 2. VINTAGE / MUTED
        // Discrete Ink Layers (Low Variation) + Muted Palette (Mod Chroma).
        // Captures WPA Posters, Lithographs.
        if (l_std_dev < 25 && c < 45) {
            return 'Vintage/Muted';
        }

        // 3. NOIR / MONO
        // High Contrast, Low Chroma.
        // Captures Black & White photography or Woodcuts.
        if (c < 10 && k > 60) {
            return 'Noir/Mono';
        }

        // 4. NEON / VIBRANT
        // High Variation (Complex) + Extreme Chroma.
        // Captures Pop Art, Neon Signs, Saturated Photos.
        if (c > 60) {
            return 'Neon/Vibrant';
        }

        // 5. PHOTOGRAPHIC (The Catch-All)
        // High Variation + Moderate Chroma.
        // Natural lighting, continuous tones.
        return 'Photographic';
    }

    /**
     * STRATEGY MAPPER
     * Assigns the correct Dither and Bias to each Archetype
     *
     * Note: Distance metric is now determined at generate() level using:
     *   peakChroma > 80 OR isPhotographic → CIE94, else CIE76
     */
    static getStrategy(archetype, dna) {
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 50;

        switch (archetype) {
            case 'Vector/Flat':
                return {
                    dither: 'atkinson',      // Crisp edges
                    bias: 1.0                // Precision (Don't bias blacks heavily)
                };

            case 'Vintage/Muted':
                return {
                    dither: 'atkinson',      // Retain the "Cut Paper" look
                    bias: 3.0                // Smooth out paper grain in solids
                };

            case 'Noir/Mono':
                return {
                    dither: 'blue-noise',    // Smooth shadow gradients
                    bias: 5.0                // Protect deep blacks at all costs
                };

            case 'Neon/Vibrant':
                return {
                    dither: 'blue-noise',    // Smooth gradients needed for neon glows
                    bias: 2.0
                };

            case 'Photographic':
            default:
                // Check for "Texture Rescue" (Heavy Grain)
                if (l_std_dev > 45) {
                    return { dither: 'blue-noise', bias: 5.0 };
                }
                return {
                    dither: 'blue-noise',    // Standard Photo setting
                    bias: 2.0
                };
        }
    }
}

module.exports = DynamicConfigurator;
