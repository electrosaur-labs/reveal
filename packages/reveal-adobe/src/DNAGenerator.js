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
