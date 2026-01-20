/**
 * DynamicConfigurator.js (v1.3 - Chroma Driver)
 * Determines Color Budget based on Saturation (Chroma), not Dynamic Range.
 *
 * INSIGHT: K (contrast/dynamic range) is nearly always 90-100 for photographs.
 * It tells us about lightness range, not color complexity.
 * Chroma (C) is the true indicator of how many colors an image needs.
 *
 * Color Budget by Chroma:
 * - c ≤ 20: 8 colors (muted, vintage, noir)
 * - c > 20: 10 colors (most photographs)
 * - c > 50: 12 colors (hyper vibrant: balloons, flowers, neon)
 *
 * K is still used for dither strategy (sharp edges vs smooth gradients).
 */
class DynamicConfigurator {

    static generate(dna) {
        // dna = { l: avgL, c: avgC, k: contrast, maxC: maxChroma, minL: ..., maxL: ..., filename: ... }

        // 1. BASELINE: The "Stingy" Standard
        let idealColors = 8;

        // 2. EARNING UPGRADES (Driven by Chroma)
        // We pay for Color Complexity, not Lightness Range.
        if (dna.c > 20) idealColors = 10;  // Moderate Saturation (Most Photos)
        if (dna.c > 50) idealColors = 12;  // Hyper Vibrant (balloons, flowers)

        // 3. SALIENCY RESCUE (The Astronaut Rule)
        // Exception: Low Avg Chroma, but High Max Chroma spike.
        if (dna.c < 15 && dna.maxC > 50) {
            console.log(`🚑 Saliency Rescue: ${dna.filename || 'unknown'}`);
            idealColors = 12;
        }

        // 4. COMMERCIAL CLAMP
        let finalColors = Math.min(idealColors, 12);
        finalColors = Math.max(4, finalColors);

        // 5. DITHER STRATEGY
        // We still use K (Dynamic Range) to guess image sharpness needs.
        // If range is massive (80+), we assume sharp edges -> Atkinson.
        // If range is compressed (<80), we assume fog/gradient -> BlueNoise.
        let dither = 'BlueNoise';
        let bias = 2.0;

        if (finalColors >= idealColors && dna.k > 80) {
            dither = 'Atkinson';
        }

        // Handling the "Clamp" (asking for 14, getting 12)
        if (dna.c > 60 && finalColors === 12) {
            // Super rich image clamped to 12? Use BlueNoise to blend.
            dither = 'BlueNoise';
            bias = 1.0;
        }

        return {
            id: `dynamic_${finalColors}c_${dither}`,
            name: "Dynamic Bespoke",
            targetColors: finalColors,
            blackBias: bias,
            saturationBoost: (dna.c < 15) ? 1.15 : 1.0,
            ditherType: dither,
            rangeClamp: [dna.minL, dna.maxL]
        };
    }
}

module.exports = DynamicConfigurator;
