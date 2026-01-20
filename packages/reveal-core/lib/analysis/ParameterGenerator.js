/**
 * DynamicConfigurator.js (v1.1 - Commercial Safety)
 * Enforces the 12-Color Ceiling and adapts dither when clamping occurs.
 *
 * COMMERCIAL CONSTRAINT: No print shop sets up 16 screens for a t-shirt.
 * If an image needs 16 colors to be perfect, we clamp to 12 and adapt dithering.
 */
class DynamicConfigurator {

    static generate(dna) {
        // dna = { l: avgL, c: avgC, k: contrast, maxC: maxChroma, minL: ..., maxL: ..., filename: ... }

        // DEFAULT: The "Safe" Middle
        let idealColors = 8;  // What the math WANTS
        let dither = 'BlueNoise';
        let bias = 2.0;
        let saturation = 1.0;

        // --- 1. CALCULATE IDEAL COUNT (Uncapped) ---
        // Complexity Scaling: High Contrast (Texture) + High Color = Needs more buckets
        if (dna.k > 20) idealColors = 10;
        if (dna.k > 40) idealColors = 12; // Extreme texture

        // Saliency/Color Scaling: Wide gamut usage wants more buckets
        if (dna.c > 30) idealColors += 2;
        if (dna.maxC > 80 && dna.c < 15) idealColors = 14; // The "Astronaut" spike

        // Vintage Optimization: Truly flat, low contrast image
        if (dna.k < 10 && dna.c < 10) idealColors = 5;

        // High Chroma + High Contrast (Rich Images): Vibrant, complex images need more buckets
        if (dna.c > 40 && dna.k > 20) idealColors = Math.max(idealColors, 12);

        // --- 2. APPLY THE "COMMERCIAL CLAMP" ---
        // We never go above 12, period. This is a commercial constraint, not technical.
        const CEILING = 12;
        let finalColors = Math.min(idealColors, CEILING);
        finalColors = Math.max(4, finalColors); // Minimum 4 colors

        // --- 3. DETERMINE DITHER STRATEGY ---
        // If we had to clamp the colors (Ideal > Final), we MUST use noise-based dither
        // to hide the banding caused by missing colors.
        const wasClamped = (idealColors > finalColors);

        if (wasClamped) {
            console.log(`⚠️ Commercial Clamp: ${dna.filename || 'unknown'} wanted ${idealColors}, forced to ${finalColors}.`);
            dither = 'BlueNoise'; // Smooths out the banding caused by missing colors
            bias = 1.0; // Relax black bias to recover some dynamic range
        }
        else if (dna.k > 20) {
            // If we have enough colors and high contrast, we can afford Sharp dither
            dither = 'Atkinson';
        }

        // --- 4. RESCUE LOGIC (Overrides) ---
        // THE ASTRONAUT FIX (Saliency Rescue)
        // Scenario: Image is 90% grey (AvgC < 10) but has a bright red flag (MaxC > 50).
        if (dna.c < 12 && dna.maxC > 50) {
            console.log(`🚑 Saliency Rescue: Outlier Color Detected in ${dna.filename || 'unknown'}`);
            finalColors = 12; // Use max budget (respecting CEILING)
            saturation = 1.1; // Boost slightly to help the outlier pop
            bias = 1.0; // Lower black bias to let dark colors breathe
            // Dither stays BlueNoise or whatever was set
        }

        // THE MARRAKECH FIX (Texture Rescue)
        // Scenario: Extreme Contrast (>28) creates scum dots.
        if (dna.k > 28) {
            console.log(`🛡️ Texture Rescue: Noise Suppression for ${dna.filename || 'unknown'}`);
            dither = 'BlueNoise'; // Force Smooth
            bias = 5.0; // Crush the grit
        }

        // --- 5. DYNAMIC BLACK BIAS ---
        // Protect deep blacks in noir images, relax for high-key images
        if (dna.minL < 5 && bias < 3.0) bias = 6.0; // "Noir" protection
        if (dna.minL > 25) bias = Math.min(bias, 1.0); // "High Key" relaxation

        // --- 6. SATURATION BOOST ---
        // Boost dull images, clamp neon images
        if (dna.c < 15 && saturation === 1.0) saturation = 1.15; // Vintage boost
        if (dna.c > 60) saturation = 1.0; // Safety clamp

        return {
            id: `dynamic_${finalColors}c_${dither}`,
            name: "Dynamic Bespoke",
            targetColors: finalColors,
            blackBias: bias,
            saturationBoost: saturation,
            ditherType: dither,
            rangeClamp: [dna.minL, dna.maxL]
        };
    }
}

module.exports = DynamicConfigurator;
