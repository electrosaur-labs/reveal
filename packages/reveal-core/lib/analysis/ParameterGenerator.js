/**
 * DynamicConfigurator v2.0
 * Driven by Archetype Classification (Tonal Variation vs Chroma)
 *
 * CHANGELOG:
 * - v1.3: Chroma Driver for color budgeting
 * - v1.4: Saliency Rescue threshold raised to maxC > 80
 * - v1.5: Dither logic based on l_std_dev instead of k
 * - v1.7: Archetype classification with per-archetype strategies
 * - v1.8: Added distanceMetric selection (CIE76 vs CIE94) based on chroma
 * - v1.9: Simplified distanceMetric selection using peakChroma threshold
 * - v2.0: Added preprocessing configuration (bilateral filter based on entropy)
 *
 * DISTANCE METRIC SELECTION:
 * - peakChroma > 80 OR isPhotographic → CIE94 (perceptual, better for saturated colors)
 * - Otherwise → CIE76 (graphic, faster, sufficient for flat/muted colors)
 *
 * PREPROCESSING (3-Level Perceptual Rescue System):
 * - Level 1: DNA (Archetype Detection) - this module
 * - Level 2: Entropy (Bilateral Filter) - preprocessing module
 * - Level 3: Complexity (CIE2000 Override) - future
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
     * @returns {Object} Complete configuration including preprocessing
     */
    static generate(dna, options = {}) {
        // 1. CLASSIFY ARCHETYPE
        const archetype = this.getArchetype(dna);
        const isPhotographic = archetype === 'Photographic';

        // 2. DEFINE STRATEGY MAP (dither, bias)
        const strategy = this.getStrategy(archetype, dna);

        // 3. DISTANCE METRIC SELECTION
        // peakChroma (maxC) > 80 OR isPhotographic → CIE94 (perceptual)
        // Otherwise → CIE76 (graphic, faster)
        const peakChroma = dna.maxC || 0;
        const distanceMetric = (peakChroma > 80 || isPhotographic) ? 'cie94' : 'cie76';

        console.log(`🧬 DNA: StdDev=${dna.l_std_dev?.toFixed(1) || '?'} C=${dna.c?.toFixed(1) || '?'} peakC=${peakChroma.toFixed(1)} -> Archetype: ${archetype}, Metric: ${distanceMetric}`);

        // 4. COLOR COUNT LOGIC (The "Chroma Driver")
        // Independent of archetype, driven by color complexity
        let idealColors = 8;
        if (dna.c > 20) idealColors = 10;
        if (dna.c > 50) idealColors = 12;

        // Saliency Rescue: Hidden color spike in muted image
        if (dna.c < 12 && peakChroma > 80) {
            console.log(`🚑 Saliency Rescue: ${dna.filename || 'unknown'} (High Value Spike)`);
            idealColors = 10;
        }

        const finalColors = Math.max(4, Math.min(idealColors, 12));

        // 5. PREPROCESSING CONFIGURATION (Level 2: Entropy-based bilateral filter)
        // Adds preprocessing settings based on archetype + entropy analysis
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

        return {
            id: `auto_${archetype.toLowerCase().replace('/', '_')}`,
            name: "Dynamic Bespoke",
            targetColors: finalColors,
            blackBias: strategy.bias,
            saturationBoost: (dna.c < 15) ? 1.15 : 1.0,
            ditherType: strategy.dither,
            distanceMetric: distanceMetric,
            rangeClamp: [dna.minL, dna.maxL],
            meta: { archetype, peakChroma },
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
