/**
 * RevelationError - Chroma-weighted CIE76 fidelity metric (E_rev)
 *
 * Measures color accuracy between original and posterized images,
 * weighting chromatic regions 11× more than achromatic (printing
 * economics: ink color errors are far more visible than gray errors).
 *
 * Two calling conventions:
 *   - fromBuffers()  — 8-bit Lab buffers (batch + adobe backward compat)
 *   - fromIndices()  — 16-bit Lab + palette indices (Navigator native path)
 *
 * Algorithm (two-pass):
 *   Pass 1: Find cMax (peak chroma across sampled original pixels)
 *   Pass 2: Weighted mean ΔE where w = 1 + 10 * (C_i / cMax)
 *
 * @module RevelationError
 */

const RevelationError = {

    /**
     * Compute E_rev from 8-bit Lab buffers.
     *
     * @param {Uint8Array|Uint8ClampedArray} originalLab  - 8-bit Lab (3 bytes/pixel, L:0-255, a/b:0-255 center=128)
     * @param {Uint8Array|Uint8ClampedArray} posterizedLab - 8-bit Lab (same encoding)
     * @param {number} width
     * @param {number} height
     * @param {Object} [options]
     * @param {number} [options.stride=1] - Sample every Nth pixel in each dimension
     * @returns {{ eRev: number, chromaStats: { cMax: number, avgChroma: number, chromaPixelRatio: number } }}
     */
    fromBuffers(originalLab, posterizedLab, width, height, options) {
        const stride = (options && options.stride) || 1;

        // Pass 1: find cMax
        let cMax = 0;
        for (let y = 0; y < height; y += stride) {
            for (let x = 0; x < width; x += stride) {
                const idx = (y * width + x) * 3;
                const a = originalLab[idx + 1] - 128;
                const b = originalLab[idx + 2] - 128;
                const c = Math.sqrt(a * a + b * b);
                if (c > cMax) cMax = c;
            }
        }
        if (cMax < 1) cMax = 1;

        // Pass 2: weighted error
        let sumWE = 0, sumW = 0, sumChroma = 0, chromaCount = 0, sampleCount = 0;
        for (let y = 0; y < height; y += stride) {
            for (let x = 0; x < width; x += stride) {
                const idx = (y * width + x) * 3;

                const L1 = (originalLab[idx] / 255) * 100;
                const a1 = originalLab[idx + 1] - 128;
                const b1 = originalLab[idx + 2] - 128;

                const L2 = (posterizedLab[idx] / 255) * 100;
                const a2 = posterizedLab[idx + 1] - 128;
                const b2 = posterizedLab[idx + 2] - 128;

                const C_i = Math.sqrt(a1 * a1 + b1 * b1);
                const dL = L1 - L2, da = a1 - a2, db = b1 - b2;
                const dE = Math.sqrt(dL * dL + da * da + db * db);
                const w = 1 + 10 * (C_i / cMax);

                sumWE += w * dE;
                sumW += w;
                sumChroma += C_i;
                sampleCount++;
                if (C_i > 5) chromaCount++;
            }
        }

        const eRev = sumW > 0 ? sumWE / sumW : 0;

        return {
            eRev: parseFloat(eRev.toFixed(3)),
            chromaStats: {
                cMax: parseFloat(cMax.toFixed(1)),
                avgChroma: parseFloat((sumChroma / Math.max(sampleCount, 1)).toFixed(1)),
                chromaPixelRatio: parseFloat((chromaCount / Math.max(sampleCount, 1)).toFixed(3))
            }
        };
    },

    /**
     * Compute E_rev from 16-bit Lab pixels + palette indices.
     * Native Navigator path — no 8-bit conversion overhead.
     *
     * @param {Uint16Array} labPixels   - 16-bit Lab interleaved (L,a,b per pixel, PS encoding 0-32768)
     * @param {Uint8Array}  colorIndices - Palette index per pixel
     * @param {Array<{L:number, a:number, b:number}>} labPalette - Palette in perceptual Lab (L:0-100, a/b:-128..+127)
     * @param {number} pixelCount
     * @param {Object} [options]
     * @param {number} [options.stride=1] - Sample every Nth pixel (linear, not 2D)
     * @returns {{ eRev: number, chromaStats: { cMax: number, avgChroma: number, chromaPixelRatio: number } }}
     */
    fromIndices(labPixels, colorIndices, labPalette, pixelCount, options) {
        const stride = (options && options.stride) || 1;
        const paletteSize = labPalette.length;

        // Scale factors: PS 16-bit → perceptual units
        // L: 0-32768 → 0-100    => * (100/32768)
        // a/b: 0-32768, center=16384 → -128..+127  => (v - 16384) * (128/16384)
        const L_SCALE = 100 / 32768;
        const AB_SCALE = 128 / 16384;

        // Pass 1: find cMax (in perceptual a/b units)
        let cMax = 0;
        for (let p = 0; p < pixelCount; p += stride) {
            const off = p * 3;
            const a = (labPixels[off + 1] - 16384) * AB_SCALE;
            const b = (labPixels[off + 2] - 16384) * AB_SCALE;
            const c = Math.sqrt(a * a + b * b);
            if (c > cMax) cMax = c;
        }
        if (cMax < 1) cMax = 1;

        // Pass 2: weighted error
        // Palette is already in perceptual Lab — use directly (no roundtrip)
        let sumWE = 0, sumW = 0, sumChroma = 0, chromaCount = 0, sampleCount = 0;
        for (let p = 0; p < pixelCount; p += stride) {
            const off = p * 3;
            const ci = colorIndices[p];
            if (ci >= paletteSize) continue;

            // Original pixel: 16-bit PS encoding → perceptual
            const L1 = labPixels[off] * L_SCALE;
            const a1 = (labPixels[off + 1] - 16384) * AB_SCALE;
            const b1 = (labPixels[off + 2] - 16384) * AB_SCALE;

            // Posterized pixel: palette is already perceptual {L, a, b}
            const pal = labPalette[ci];
            const L2 = pal.L;
            const a2 = pal.a;
            const b2 = pal.b;

            const C_i = Math.sqrt(a1 * a1 + b1 * b1);
            const dL = L1 - L2, da = a1 - a2, db = b1 - b2;
            const dE = Math.sqrt(dL * dL + da * da + db * db);
            const w = 1 + 10 * (C_i / cMax);

            sumWE += w * dE;
            sumW += w;
            sumChroma += C_i;
            sampleCount++;
            if (C_i > 5) chromaCount++;
        }

        const eRev = sumW > 0 ? sumWE / sumW : 0;

        return {
            eRev: parseFloat(eRev.toFixed(3)),
            chromaStats: {
                cMax: parseFloat(cMax.toFixed(1)),
                avgChroma: parseFloat((sumChroma / Math.max(sampleCount, 1)).toFixed(1)),
                chromaPixelRatio: parseFloat((chromaCount / Math.max(sampleCount, 1)).toFixed(3))
            }
        };
    },
    /**
     * Compute unweighted mean CIE76 ΔE from 16-bit Lab pixels + palette indices.
     * Simple arithmetic mean — no chroma weighting.
     *
     * Used by ProxyEngine (archetype quality ranking) and SessionState (accuracy monitor).
     *
     * @param {Uint16Array} labPixels   - 16-bit Lab interleaved (L,a,b per pixel, PS encoding 0-32768)
     * @param {Uint8Array}  colorIndices - Palette index per pixel
     * @param {Array<{L:number, a:number, b:number}>} labPalette - Palette in perceptual Lab
     * @param {number} pixelCount
     * @returns {number} Mean ΔE (0 = perfect, higher = more deviation)
     */
    meanDeltaE16(labPixels, colorIndices, labPalette, pixelCount) {
        const paletteSize = labPalette.length;

        // Pre-extract palette into flat arrays for hot loop
        const palL = new Float64Array(paletteSize);
        const palA = new Float64Array(paletteSize);
        const palB = new Float64Array(paletteSize);
        for (let i = 0; i < paletteSize; i++) {
            palL[i] = labPalette[i].L;
            palA[i] = labPalette[i].a;
            palB[i] = labPalette[i].b;
        }

        // 16-bit PS encoding → perceptual units
        const L_SCALE = 100 / 32768;
        const AB_SCALE = 128 / 16384;

        let sumDE = 0;
        for (let i = 0; i < pixelCount; i++) {
            const off = i * 3;
            const L = labPixels[off] * L_SCALE;
            const a = (labPixels[off + 1] - 16384) * AB_SCALE;
            const b = (labPixels[off + 2] - 16384) * AB_SCALE;

            const ci = colorIndices[i];
            if (ci >= paletteSize) continue;

            const dL = L - palL[ci];
            const da = a - palA[ci];
            const db = b - palB[ci];
            sumDE += Math.sqrt(dL * dL + da * da + db * db);
        }

        return sumDE / pixelCount;
    }
};

module.exports = RevelationError;
