/**
 * DNAGenerator - Extract image "DNA" for ParameterGenerator
 *
 * Simplified version of @reveal/core's LabConverter.generateDNA()
 * Adapted for UXP environment (no Buffer/Node dependencies)
 *
 * This module analyzes Lab pixel data to extract statistical characteristics
 * that describe an image's "DNA" - its average lightness, chroma, contrast,
 * and color intensity range. These metrics drive the DynamicConfigurator
 * to generate bespoke separation parameters.
 */
class DNAGenerator {
    /**
     * Generate image DNA from Lab pixel data
     *
     * @param {Uint8ClampedArray|Uint16Array} labPixels - Lab pixels (auto-detects 8-bit vs 16-bit)
     *   8-bit: L: 0-255 (→ 0-100), a/b: 0-255 (→ -128 to +127)
     *   16-bit: L: 0-32768 (→ 0-100), a/b: 0-32768 (→ -128 to +127, 16384 = 0)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} sampleStep - Sample every Nth pixel (default: 40 for speed)
     * @returns {Object} DNA object with { l, c, k, maxC, maxCHue, minL, maxL, yellowDominance }
     *   - l: Average lightness (0-100)
     *   - c: Average chroma (color intensity)
     *   - k: Contrast (maxL - minL)
     *   - maxC: Maximum chroma found in image
     *   - maxCHue: Hue angle (0-360°) of the peak chroma pixel
     *   - minL: Minimum lightness (darkest point)
     *   - maxL: Maximum lightness (brightest point)
     *   - yellowDominance: Yellow dominance score (0-100), weighted by chroma
     */
    static generate(labPixels, width, height, sampleStep = 40) {
        let sumL = 0, sumA = 0, sumB = 0;
        let minL = 100, maxL = 0;
        let maxC = 0;
        let maxCHue = 0;
        let sampleCount = 0;

        // Yellow dominance tracking (50-100° hue range)
        let yellowPixelWeightSum = 0;
        let totalColorWeightSum = 0;

        // Detect 16-bit vs 8-bit data
        // 16-bit: Uint16Array with values 0-32768
        // 8-bit: Uint8Array/Uint8ClampedArray with values 0-255
        const is16Bit = labPixels instanceof Uint16Array;

        // Sample pixels at intervals for performance
        for (let i = 0; i < labPixels.length; i += (3 * sampleStep)) {
            let L, a, b;

            if (is16Bit) {
                // 16-bit Lab encoding (Photoshop native)
                // L: 0-32768 → 0-100
                // a: 0-32768 → -128 to +127 (16384 = 0)
                // b: 0-32768 → -128 to +127 (16384 = 0)
                L = (labPixels[i] / 32768) * 100;
                a = ((labPixels[i + 1] - 16384) / 16384) * 128;
                b = ((labPixels[i + 2] - 16384) / 16384) * 128;
            } else {
                // 8-bit Lab encoding
                // L: 0-255 → 0-100
                // a: 0-255 → -128 to +127
                // b: 0-255 → -128 to +127
                L = (labPixels[i] / 255) * 100;
                a = labPixels[i + 1] - 128;
                b = labPixels[i + 2] - 128;
            }

            sumL += L;
            sumA += a;
            sumB += b;

            // Track lightness range
            if (L < minL) minL = L;
            if (L > maxL) maxL = L;

            // Calculate chroma (color intensity) and track maximum
            const chroma = Math.sqrt(a * a + b * b);
            if (chroma > maxC) {
                maxC = chroma;
                // Calculate hue angle in degrees (0-360°)
                maxCHue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
            }

            // Track yellow dominance (chroma-weighted)
            // Only count pixels with meaningful chroma (>5) to exclude grays
            if (chroma > 5) {
                const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
                const chromaWeight = Math.min(chroma / 100, 1.0); // Normalize to 0-1

                totalColorWeightSum += chromaWeight;

                // Yellow zone: 60-100° (PURE yellows, excludes oranges at 50-60°)
                // This is intentionally narrow to avoid false positives from orange-dominant images
                if (hue >= 60 && hue <= 100) {
                    yellowPixelWeightSum += chromaWeight;
                }
            }

            sampleCount++;
        }

        // Calculate averages
        const avgL = sumL / sampleCount;
        const avgA = sumA / sampleCount;
        const avgB = sumB / sampleCount;
        const avgC = Math.sqrt(avgA * avgA + avgB * avgB);
        const contrast = maxL - minL;

        // Calculate yellow dominance score (0-100)
        // Represents percentage of chromatic pixels in yellow hue range
        const yellowDominance = totalColorWeightSum > 0
            ? (yellowPixelWeightSum / totalColorWeightSum) * 100
            : 0;

        return {
            l: parseFloat(avgL.toFixed(1)),
            c: parseFloat(avgC.toFixed(1)),
            k: parseFloat(contrast.toFixed(1)),
            maxC: parseFloat(maxC.toFixed(1)),
            maxCHue: parseFloat(maxCHue.toFixed(1)),
            minL: parseFloat(minL.toFixed(1)),
            maxL: parseFloat(maxL.toFixed(1)),
            yellowDominance: parseFloat(yellowDominance.toFixed(1))
        };
    }
}

module.exports = DNAGenerator;
