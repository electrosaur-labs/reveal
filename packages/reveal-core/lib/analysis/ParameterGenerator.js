/**
 * DynamicConfigurator.js (v1.5 - Dither Fix)
 * Switched Dither Logic from Global Contrast (K) to Local Variance (StdDev).
 *
 * CALIBRATION UPDATE (2026-01-20):
 * - v1.3: Saliency Rescue fired on vintage posters (maxC 71.2 > 50)
 * - v1.4: Raised threshold to 80, lowered rescue budget to 10
 * - v1.5: Fixed dither logic - uses l_std_dev instead of k to detect vectors
 *
 * The Astronaut (maxC 85.9) gets rescued. The 1848 Poster (maxC 71.2) does not.
 */
class DynamicConfigurator {

    static generate(dna) {
        // dna = { l: avgL, c: avgC, k: contrast, maxC: maxChroma, l_std_dev: stdDev, ... }

        // 1. BASELINE: The Stingy Standard
        let idealColors = 8;

        // 2. EARNING UPGRADES (Chroma Driver)
        if (dna.c > 20) idealColors = 10;
        if (dna.c > 50) idealColors = 12;

        // 3. SALIENCY RESCUE (The Surgical Fix)
        // OLD: if (dna.c < 15 && dna.maxC > 50) -> Fired on vintage posters (71.2)
        // NEW: Strict Threshold + Economic Response
        // - maxC > 80: Only triggers for pure/neon pigments (Astronaut is 85.9)
        // - Target 10: We don't need 12 colors to save 1 spot color.

        if (dna.c < 12 && dna.maxC > 80) {
            console.log(`🚑 Saliency Rescue: ${dna.filename} (High Value Spike)`);
            idealColors = 10; // Cap at 10 (Efficiency Win)
        }

        // 4. COMMERCIAL CLAMP
        const CEILING = 12;
        let finalColors = Math.min(idealColors, CEILING);
        finalColors = Math.max(4, finalColors);

        // 5. DITHER STRATEGY (v1.5 - Variance Driver)
        // OLD BUGGY LOGIC:
        // if (dna.k > 80) dither = 'Atkinson';  (True for 99% of images)
        // if (dna.k > 28) dither = 'BlueNoise'; (True for 100% of images -> Overwrote above)
        //
        // NEW LOGIC: Use Standard Deviation (l_std_dev) to detect "Busyness".

        let dither = 'blue-noise'; // Default for Photos (lowercase to match SeparationEngine)
        let bias = 2.0;

        // Fallback for images without l_std_dev (backwards compatibility)
        const stdDev = dna.l_std_dev !== undefined ? dna.l_std_dev : 50;

        // Condition A: The "Vector" Candidate
        // High Contrast (Sharp range) but Low Variance (Large flat areas).
        // This targets Logos, Comics, and Typography.
        if (dna.k > 60 && stdDev < 25) {
            dither = 'atkinson'; // Keep edges crisp (lowercase to match SeparationEngine)
        }

        // Condition B: The "Texture" Override (Marrakech Rule)
        // If the image is extremely busy/gritty, we MUST use BlueNoise
        // and crank the bias to prevent speckling.
        if (stdDev > 40) {
            dither = 'blue-noise';
            bias = 5.0; // High stability bias
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
