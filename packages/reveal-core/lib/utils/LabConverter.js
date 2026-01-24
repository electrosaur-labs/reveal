/**
 * LabConverter - Unified Lab color space conversion utilities
 *
 * Handles conversions between different Lab encodings:
 * - Sharp format: L (0-100), a (-128 to 127), b (-128 to 127)
 * - Photoshop byte encoding: L (0-255), a (0-255), b (0-255)
 * - Perceptual Lab: L (0-100), a (-128 to 127), b (-128 to 127)
 *
 * Also provides color metric calculations (chroma, hue, DeltaE)
 * DeltaE calculations delegate to centralized lib/color/LabDistance.js
 */

const LabDistance = require('../color/LabDistance');

class LabConverter {
    /**
     * Convert Sharp Lab format to Photoshop byte encoding
     *
     * Sharp outputs Lab as raw buffer with:
     * - L: 0-100 (float)
     * - a: -128 to 127 (float)
     * - b: -128 to 127 (float)
     *
     * Photoshop expects:
     * - L: 0-255 (byte) representing 0-100
     * - a: 0-255 (byte) representing -128 to 127
     * - b: 0-255 (byte) representing -128 to 127
     *
     * @param {Buffer} sharpBuffer - Raw buffer from Sharp (3 bytes per pixel)
     * @returns {Uint8ClampedArray} - Photoshop-encoded Lab pixels
     */
    static sharpToPhotoshop(sharpBuffer) {
        const labPixels = new Uint8ClampedArray(sharpBuffer.length);

        for (let i = 0; i < sharpBuffer.length; i += 3) {
            // L: 0-100 → 0-255
            labPixels[i] = Math.round((sharpBuffer[i] / 100) * 255);

            // a: -128 to 127 → 0-255
            labPixels[i + 1] = Math.round(sharpBuffer[i + 1] + 128);

            // b: -128 to 127 → 0-255
            labPixels[i + 2] = Math.round(sharpBuffer[i + 2] + 128);
        }

        return labPixels;
    }

    /**
     * Convert Photoshop byte encoding to perceptual Lab values
     *
     * @param {Uint8ClampedArray|Uint8Array} psBytes - Photoshop-encoded Lab bytes
     * @param {number} index - Pixel index (will read 3 bytes starting here)
     * @returns {Object} - { L: 0-100, a: -128 to 127, b: -128 to 127 }
     */
    static photoshopToPerceptual(psBytes, index) {
        return {
            L: (psBytes[index] / 255) * 100,
            a: psBytes[index + 1] - 128,
            b: psBytes[index + 2] - 128
        };
    }

    /**
     * Convert Photoshop byte encoding to perceptual Lab for entire array
     *
     * @param {Uint8ClampedArray|Uint8Array} psBytes - Photoshop-encoded Lab bytes
     * @returns {Array<Object>} - Array of { L, a, b } objects
     */
    static photoshopArrayToPerceptual(psBytes) {
        const result = [];
        for (let i = 0; i < psBytes.length; i += 3) {
            result.push(this.photoshopToPerceptual(psBytes, i));
        }
        return result;
    }

    /**
     * Convert perceptual Lab to Photoshop byte encoding
     *
     * @param {number} L - Lightness (0-100)
     * @param {number} a - a component (-128 to 127)
     * @param {number} b - b component (-128 to 127)
     * @returns {Object} - { L: 0-255, a: 0-255, b: 0-255 }
     */
    static perceptualToPhotoshop(L, a, b) {
        return {
            L: Math.round((L / 100) * 255),
            a: Math.round(a + 128),
            b: Math.round(b + 128)
        };
    }

    /**
     * Calculate chroma (color intensity) from Lab a/b values
     *
     * C* = √(a² + b²)
     *
     * @param {number} a - Lab a component (-128 to 127)
     * @param {number} b - Lab b component (-128 to 127)
     * @returns {number} - Chroma value (0-180+ typically)
     */
    static calculateChroma(a, b) {
        return Math.sqrt(a * a + b * b);
    }

    /**
     * Calculate hue angle from Lab a/b values
     *
     * h° = arctan(b/a) in degrees (0-360)
     *
     * @param {number} a - Lab a component (-128 to 127)
     * @param {number} b - Lab b component (-128 to 127)
     * @returns {number} - Hue angle in degrees (0-360)
     */
    static calculateHue(a, b) {
        // atan2 returns radians in range [-π, π]
        // Convert to degrees and normalize to 0-360
        const hueRadians = Math.atan2(b, a);
        const hueDegrees = (hueRadians * 180 / Math.PI + 360) % 360;
        return hueDegrees;
    }

    /**
     * Calculate CIE76 Delta E (color difference)
     *
     * ΔE*ab = √((L₂-L₁)² + (a₂-a₁)² + (b₂-b₁)²)
     *
     * Interpretation:
     * - ΔE < 1: Not perceptible by human eyes
     * - 1 < ΔE < 2: Perceptible through close observation
     * - 2 < ΔE < 10: Perceptible at a glance
     * - 11 < ΔE < 49: Colors are more similar than opposite
     * - ΔE > 50: Colors are opposite
     *
     * Delegates to centralized LabDistance module.
     *
     * @param {Object} lab1 - First color { L, a, b }
     * @param {Object} lab2 - Second color { L, a, b }
     * @returns {number} - Delta E value
     */
    static calculateDeltaE(lab1, lab2) {
        return LabDistance.cie76(lab1, lab2);
    }

    /**
     * Calculate Delta E between two Photoshop-encoded pixels
     *
     * @param {Uint8ClampedArray|Uint8Array} psBytes1 - First pixel bytes
     * @param {number} index1 - Index of first pixel
     * @param {Uint8ClampedArray|Uint8Array} psBytes2 - Second pixel bytes
     * @param {number} index2 - Index of second pixel
     * @returns {number} - Delta E value
     */
    static calculateDeltaEPhotoshop(psBytes1, index1, psBytes2, index2) {
        const lab1 = this.photoshopToPerceptual(psBytes1, index1);
        const lab2 = this.photoshopToPerceptual(psBytes2, index2);
        return this.calculateDeltaE(lab1, lab2);
    }

    /**
     * Extract Lab statistics from Photoshop-encoded pixel array
     *
     * @param {Uint8ClampedArray|Uint8Array} psBytes - Photoshop Lab pixels
     * @param {number} sampleStep - Sample every Nth pixel (default: 1 = all pixels)
     * @returns {Object} - { avgL, avgC, minL, maxL, maxC, avgA, avgB }
     */
    static extractStatistics(psBytes, sampleStep = 1) {
        let sumL = 0, sumA = 0, sumB = 0;
        let minL = 100, maxL = 0;
        let maxC = 0;
        let sampleCount = 0;

        // First pass: accumulate sums and find extrema
        for (let i = 0; i < psBytes.length; i += (3 * sampleStep)) {
            const lab = this.photoshopToPerceptual(psBytes, i);

            sumL += lab.L;
            sumA += lab.a;
            sumB += lab.b;

            if (lab.L < minL) minL = lab.L;
            if (lab.L > maxL) maxL = lab.L;

            const chroma = this.calculateChroma(lab.a, lab.b);
            if (chroma > maxC) maxC = chroma;

            sampleCount++;
        }

        const avgL = sumL / sampleCount;

        // Second pass: calculate variance for standard deviation
        let sumSquaredDiffL = 0;
        for (let i = 0; i < psBytes.length; i += (3 * sampleStep)) {
            const lab = this.photoshopToPerceptual(psBytes, i);
            const diffL = lab.L - avgL;
            sumSquaredDiffL += diffL * diffL;
        }

        const varianceL = sumSquaredDiffL / sampleCount;
        const stdDevL = Math.sqrt(varianceL);

        return {
            avgL: avgL,
            avgC: this.calculateChroma(sumA / sampleCount, sumB / sampleCount),
            minL: minL,
            maxL: maxL,
            maxC: maxC,
            avgA: sumA / sampleCount,
            avgB: sumB / sampleCount,
            stdDevL: stdDevL,
            sampleCount: sampleCount
        };
    }

    /**
     * Calculate contrast (K) from lightness statistics
     *
     * K = maxL - minL
     *
     * Interpretation:
     * - K < 10: Very flat, low contrast
     * - K 10-20: Moderate contrast
     * - K 20-30: High contrast
     * - K > 30: Extreme contrast
     *
     * @param {number} minL - Minimum lightness
     * @param {number} maxL - Maximum lightness
     * @returns {number} - Contrast value
     */
    static calculateContrast(minL, maxL) {
        return maxL - minL;
    }

    /**
     * Generate image "DNA" from Photoshop Lab pixels
     *
     * DNA = { l, c, k, maxC, minL, maxL }
     * Used by ParameterGenerator for dynamic configuration
     *
     * @param {Uint8ClampedArray|Uint8Array} psBytes - Photoshop Lab pixels
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} sampleStep - Sample every Nth pixel (default: 40 for speed)
     * @returns {Object} - DNA object
     */
    static generateDNA(psBytes, width, height, sampleStep = 40) {
        const stats = this.extractStatistics(psBytes, sampleStep);
        const contrast = this.calculateContrast(stats.minL, stats.maxL);

        return {
            l: parseFloat(stats.avgL.toFixed(1)),
            c: parseFloat(stats.avgC.toFixed(1)),
            k: parseFloat(contrast.toFixed(1)),
            maxC: parseFloat(stats.maxC.toFixed(1)),
            minL: parseFloat(stats.minL.toFixed(1)),
            maxL: parseFloat(stats.maxL.toFixed(1)),
            l_std_dev: parseFloat(stats.stdDevL.toFixed(1))
        };
    }
}

module.exports = LabConverter;
