/**
 * DynamicConfigurator.js
 * DEPRECATED: Use @reveal/core/lib/analysis/ParameterGenerator instead
 * This file is kept for backward compatibility only.
 */
const ParameterGenerator = require('@reveal/core/lib/analysis/ParameterGenerator');

class DynamicConfigurator {

    /**
     * Generate configuration from DNA analysis
     * @param {Object} dna - DNA analysis result
     * @param {Object} [options] - Generation options (new in v2.0)
     * @param {Uint8ClampedArray} [options.imageData] - RGBA data for entropy calculation
     * @param {number} [options.width] - Image width
     * @param {number} [options.height] - Image height
     * @param {string} [options.preprocessingIntensity='auto'] - 'off', 'auto', 'light', 'heavy'
     * @returns {Object} Complete configuration including preprocessing
     */
    static generate(dna, options = {}) {
        // Delegate to core implementation
        return ParameterGenerator.generate(dna, options);
    }

    // Legacy implementation (kept for reference)
    static _legacyGenerate(dna) {
        // dna = { l: avgL, c: avgC, k: contrast, maxC: maxChroma, minL: ..., maxL: ..., filename: ... }

        // DEFAULT: The "Safe" Middle
        let colorCount = 8;
        let dither = 'BlueNoise';
        let bias = 2.0;
        let saturation = 1.0;

        // --- 1. COMPLEXITY SCALING ---
        // High Contrast (Texture) + High Color = Needs more buckets
        if (dna.k > 20) {
            colorCount = 10;
            dither = 'Atkinson'; // Sharper edges for texture
        }

        // --- 2. THE ASTRONAUT FIX (Saliency Rescue) ---
        // Scenario: Image is 90% grey (AvgC < 10) but has a bright red flag (MaxC > 50).
        // Old Logic: "It's grey. Use 4 colors." -> Flag dies.
        // New Logic: "Hidden Color Spike detected. FORCE MAX BUCKETS."
        if (dna.c < 12 && dna.maxC > 50) {
            console.log(`🚑 Saliency Rescue: Outlier Color Detected in ${dna.filename || 'unknown'}`);
            colorCount = 12; // Force maximum palette
            saturation = 1.1; // Boost slightly to help the outlier pop
            bias = 1.0; // Lower black bias to let dark colors breathe
        }

        // --- 3. THE MARRAKECH FIX (Texture Rescue) ---
        // Scenario: Extreme Contrast (>28) creates scum dots.
        // Fix: Use Smooth Dither and heavy Black Bias to crush noise.
        if (dna.k > 28) {
            console.log(`🛡️ Texture Rescue: Noise Suppression for ${dna.filename || 'unknown'}`);
            dither = 'BlueNoise'; // Force Smooth
            bias = 5.0; // Crush the grit
        }

        // --- 4. VINTAGE OPTIMIZATION ---
        // Scenario: Truly flat, low contrast image.
        // Fix: Use few colors to look like an old poster.
        if (dna.k < 10 && dna.c < 10) {
            colorCount = 5;
            dither = 'BlueNoise';
        }

        // --- 5. HIGH CHROMA + HIGH CONTRAST (Rich Images) ---
        // Scenario: Vibrant, complex images need more buckets
        if (dna.c > 40 && dna.k > 20) {
            colorCount = Math.max(colorCount, 12); // Ensure at least 12
        }

        // --- 6. DYNAMIC BLACK BIAS ---
        // Protect deep blacks in noir images, relax for high-key images
        if (dna.minL < 5 && bias < 3.0) bias = 6.0; // "Noir" protection
        if (dna.minL > 25) bias = Math.min(bias, 1.0); // "High Key" relaxation

        // --- 7. SATURATION BOOST ---
        // Boost dull images, clamp neon images
        if (dna.c < 15 && saturation === 1.0) saturation = 1.15; // Vintage boost
        if (dna.c > 60) saturation = 1.0; // Safety clamp

        // Hard Clamps for Physical Reality
        colorCount = Math.max(4, Math.min(12, colorCount));

        return {
            id: `dynamic_${colorCount}c_${dither}`,
            name: "Dynamic Bespoke",
            targetColors: colorCount,
            blackBias: bias,
            saturationBoost: saturation,
            ditherType: dither,
            rangeClamp: [dna.minL, dna.maxL]
        };
    }
}

module.exports = DynamicConfigurator;
