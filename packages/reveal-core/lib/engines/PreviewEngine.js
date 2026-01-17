/**
 * PreviewEngine.js
 *
 * High-speed preview generator for Reveal.
 * Optimized for UXP performance using Squared Euclidean Lab distance.
 *
 * ARCHITECTURE: Pure Lab Stream
 * - Operates on Lab pixel data directly (no RGB conversions in hot loop)
 * - Pre-caches palette values in flat arrays to avoid object property lookups
 * - Uses Squared Euclidean Distance for 100x speedup over CIEDE2000
 * - Single buffer allocation for maximum performance
 */

class PreviewEngine {
    /**
     * Generates a preview RGBA buffer from Lab data and a palette.
     *
     * Performance: ~10-20ms for 800×800 preview (640K pixels)
     *
     * @param {Uint8Array} labBytes - Raw 3-channel Lab bytes (L, a, b)
     * @param {Array} labPalette - Array of {L, a, b} objects from PosterizationEngine
     * @param {Array} rgbPalette - Array of {r, g, b} objects for fast pixel filling
     * @returns {Uint8ClampedArray} - RGBA buffer ready for putImageData
     */
    static generatePreview(labBytes, labPalette, rgbPalette) {
        const pixelCount = labBytes.length / 3;
        const rgbaBuffer = new Uint8ClampedArray(pixelCount * 4);

        // Local cache of palette values to avoid object property lookups in the loop
        // This optimization is critical for UXP performance (per Architect)
        const paletteL = labPalette.map(p => p.L);
        const paletteA = labPalette.map(p => p.a);
        const paletteB = labPalette.map(p => p.b);
        const paletteR = rgbPalette.map(p => p.r);
        const paletteG = rgbPalette.map(p => p.g);
        const paletteB_rgb = rgbPalette.map(p => p.b);
        const paletteLen = labPalette.length;

        for (let i = 0; i < pixelCount; i++) {
            const lIdx = i * 3;
            const rIdx = i * 4;

            // 1. Map Raw Bytes to Perceptual Lab (Center Fix)
            const L = (labBytes[lIdx] / 255) * 100;
            const a = labBytes[lIdx + 1] - 128;
            const b = labBytes[lIdx + 2] - 128;

            let minDistanceSq = Infinity;
            let bestIndex = 0;

            // 2. Fast Squared Euclidean Distance
            // Removing Math.sqrt() and standardizing weights for speed
            for (let j = 0; j < paletteLen; j++) {
                const dL = L - paletteL[j];
                const da = a - paletteA[j];
                const db = b - paletteB[j];

                const distSq = (dL * dL) + (da * da) + (db * db);

                if (distSq < minDistanceSq) {
                    minDistanceSq = distSq;
                    bestIndex = j;
                }
            }

            // 3. Fast Fill using pre-calculated RGB Palette
            rgbaBuffer[rIdx]     = paletteR[bestIndex];
            rgbaBuffer[rIdx + 1] = paletteG[bestIndex];
            rgbaBuffer[rIdx + 2] = paletteB_rgb[bestIndex];
            rgbaBuffer[rIdx + 3] = 255; // Fully opaque preview
        }

        return rgbaBuffer;
    }
}

module.exports = PreviewEngine;
