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
     * @param {Uint8ClampedArray} labPixels - Lab pixels in byte encoding
     *   L: 0-255 (represents 0-100)
     *   a: 0-255 (represents -128 to +127)
     *   b: 0-255 (represents -128 to +127)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} sampleStep - Sample every Nth pixel (default: 40 for speed)
     * @returns {Object} DNA object with { l, c, k, maxC, minL, maxL }
     *   - l: Average lightness (0-100)
     *   - c: Average chroma (color intensity)
     *   - k: Contrast (maxL - minL)
     *   - maxC: Maximum chroma found in image
     *   - minL: Minimum lightness (darkest point)
     *   - maxL: Maximum lightness (brightest point)
     */
    static generate(labPixels, width, height, sampleStep = 40) {
        let sumL = 0, sumA = 0, sumB = 0;
        let minL = 100, maxL = 0;
        let maxC = 0;
        let sampleCount = 0;

        // Sample pixels at intervals for performance
        for (let i = 0; i < labPixels.length; i += (3 * sampleStep)) {
            // Convert byte encoding to perceptual Lab values
            const L = (labPixels[i] / 255) * 100;      // 0-255 → 0-100
            const a = labPixels[i + 1] - 128;          // 0-255 → -128 to +127
            const b = labPixels[i + 2] - 128;          // 0-255 → -128 to +127

            sumL += L;
            sumA += a;
            sumB += b;

            // Track lightness range
            if (L < minL) minL = L;
            if (L > maxL) maxL = L;

            // Calculate chroma (color intensity) and track maximum
            const chroma = Math.sqrt(a * a + b * b);
            if (chroma > maxC) maxC = chroma;

            sampleCount++;
        }

        // Calculate averages
        const avgL = sumL / sampleCount;
        const avgA = sumA / sampleCount;
        const avgB = sumB / sampleCount;
        const avgC = Math.sqrt(avgA * avgA + avgB * avgB);
        const contrast = maxL - minL;

        return {
            l: parseFloat(avgL.toFixed(1)),
            c: parseFloat(avgC.toFixed(1)),
            k: parseFloat(contrast.toFixed(1)),
            maxC: parseFloat(maxC.toFixed(1)),
            minL: parseFloat(minL.toFixed(1)),
            maxL: parseFloat(maxL.toFixed(1))
        };
    }
}

module.exports = DNAGenerator;
