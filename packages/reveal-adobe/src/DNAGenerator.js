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
 *
 * DNA v2.0 Features:
 * - Per-sector hue distribution (12 sectors, 30° each)
 * - Lightness standard deviation tracking
 * - Yellow dominance and neutral gravity metrics
 * - Backward compatible with v1.0 (legacy fields preserved)
 */
class DNAGenerator {
    /**
     * 12 hue sectors (30° each) for color distribution analysis
     */
    static SECTORS = [
        'red',        // 0-30°
        'orange',     // 30-60°
        'yellow',     // 60-90°
        'chartreuse', // 90-120°
        'green',      // 120-150°
        'cyan',       // 150-180°
        'blue',       // 180-210°
        'violet',     // 210-240°
        'purple',     // 240-270°
        'magenta',    // 270-300°
        'pink',       // 300-330°
        'crimson'     // 330-360°
    ];

    /**
     * Generate image DNA from Lab pixel data
     *
     * @param {Uint8ClampedArray|Uint16Array} labPixels - Lab pixels (auto-detects 8-bit vs 16-bit)
     *   8-bit: L: 0-255 (→ 0-100), a/b: 0-255 (→ -128 to +127)
     *   16-bit: L: 0-32768 (→ 0-100), a/b: 0-32768 (→ -128 to +127, 16384 = 0)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} sampleStep - Sample every Nth pixel (default: 40 for speed)
     * @param {Object} options - Generation options
     * @param {boolean} options.richDNA - Generate Rich DNA v2.0 with sectors (default: true)
     * @returns {Object} DNA object with legacy fields + optional v2.0 hierarchical structure
     *   Legacy fields: l, c, k, maxC, maxCHue, minL, maxL, yellowDominance, l_std_dev
     *   v2.0 fields: global, sectors (if options.richDNA = true)
     */
    static generate(labPixels, width, height, sampleStep = 40, options = {}) {
        // Default to Rich DNA v2.0
        const generateRichDNA = options.richDNA !== false;

        let sumL = 0, sumA = 0, sumB = 0;
        let minL = 100, maxL = 0;
        let maxC = 0;
        let maxCHue = 0;
        let sampleCount = 0;

        // Yellow dominance tracking (60-100° hue range)
        let yellowPixelWeightSum = 0;
        let greenPixelWeightSum = 0;   // 120-150° green energy
        let bluePixelWeightSum = 0;    // 180-210° blue strength
        let warmPixelWeightSum = 0;    // 0-180° warm tones
        let coolPixelWeightSum = 0;    // 180-360° cool tones
        let totalColorWeightSum = 0;

        // Neutral gravity tracking (chroma < 3.0)
        let neutralPixelCount = 0;
        let neutralLSum = 0;

        // L and C standard deviation tracking
        let sumLSquared = 0;
        let sumCSquared = 0;

        // Chroma density tracking
        let lowChromaCount = 0;   // C < 15
        let highChromaCount = 0;  // C > 50

        // Detect 16-bit vs 8-bit data
        const is16Bit = labPixels instanceof Uint16Array;

        // v2.0: Per-sector tracking (12 sectors, 30° each)
        const sectorData = generateRichDNA ? this.SECTORS.map(name => ({
            name,
            sumL: 0,
            sumLSquared: 0,
            sumC: 0,
            maxC: 0,
            sumH: 0,
            count: 0,
            totalWeight: 0
        })) : null;

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
            sumLSquared += L * L;

            // Track lightness range
            if (L < minL) minL = L;
            if (L > maxL) maxL = L;

            // Calculate chroma (color intensity) and track maximum
            const chroma = Math.sqrt(a * a + b * b);
            sumCSquared += chroma * chroma;

            if (chroma > maxC) {
                maxC = chroma;
                // Calculate hue angle in degrees (0-360°)
                maxCHue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
            }

            // Chroma density tracking
            if (chroma < 15) {
                lowChromaCount++;
            }
            if (chroma > 50) {
                highChromaCount++;
            }

            // NEUTRAL GRAVITY: Track near-neutral pixels (chroma < 3.0)
            const isNeutral = chroma < 3.0;
            if (isNeutral) {
                neutralPixelCount++;
                neutralLSum += L;
            }

            // Track yellow dominance and sector data (chroma-weighted)
            // Only count pixels with meaningful chroma (>5) to exclude grays
            if (chroma > 5) {
                const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
                const chromaWeight = Math.min(chroma / 100, 1.0); // Normalize to 0-1

                totalColorWeightSum += chromaWeight;

                // Hue-specific tracking
                // Yellow zone: 60-100° (PURE yellows, excludes oranges)
                if (hue >= 60 && hue <= 100) {
                    yellowPixelWeightSum += chromaWeight;
                }
                // Green zone: 120-150° (foliage, nature)
                if (hue >= 120 && hue <= 150) {
                    greenPixelWeightSum += chromaWeight;
                }
                // Blue zone: 180-210° (sky, water, denim)
                if (hue >= 180 && hue <= 210) {
                    bluePixelWeightSum += chromaWeight;
                }

                // Warm vs cool balance
                if (hue < 180) {
                    warmPixelWeightSum += chromaWeight;
                } else {
                    coolPixelWeightSum += chromaWeight;
                }

                // v2.0: Bucket into sectors
                if (sectorData) {
                    const sectorIndex = Math.floor(hue / 30) % 12;
                    const sector = sectorData[sectorIndex];
                    sector.sumL += L;
                    sector.sumLSquared += L * L;
                    sector.sumC += chroma;
                    sector.maxC = Math.max(sector.maxC, chroma);
                    sector.sumH += hue;
                    sector.count++;
                    sector.totalWeight += chromaWeight;
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

        // Calculate L standard deviation
        const lVariance = (sumLSquared / sampleCount) - (avgL * avgL);
        const l_std_dev = Math.sqrt(Math.max(0, lVariance));

        // Calculate C standard deviation
        const cVariance = (sumCSquared / sampleCount) - (avgC * avgC);
        const c_std_dev = Math.sqrt(Math.max(0, cVariance));

        // Calculate hue-specific dominance scores (0-100)
        const yellowDominance = totalColorWeightSum > 0
            ? (yellowPixelWeightSum / totalColorWeightSum) * 100
            : 0;
        const greenEnergy = totalColorWeightSum > 0
            ? (greenPixelWeightSum / totalColorWeightSum) * 100
            : 0;
        const blueStrength = totalColorWeightSum > 0
            ? (bluePixelWeightSum / totalColorWeightSum) * 100
            : 0;

        // Calculate warm/cool ratio (>1 means warm-dominant, <1 means cool-dominant)
        const warmCoolRatio = coolPixelWeightSum > 0
            ? warmPixelWeightSum / coolPixelWeightSum
            : warmPixelWeightSum > 0 ? 999 : 1.0;

        // Calculate chroma densities (0-1)
        const lowChromaDensity = lowChromaCount / sampleCount;
        const highChromaDensity = highChromaCount / sampleCount;

        // Legacy v1.0 fields (backward compatible)
        const legacyDNA = {
            l: parseFloat(avgL.toFixed(1)),
            c: parseFloat(avgC.toFixed(1)),
            k: parseFloat(contrast.toFixed(1)),
            maxC: parseFloat(maxC.toFixed(1)),
            maxCHue: parseFloat(maxCHue.toFixed(1)),
            minL: parseFloat(minL.toFixed(1)),
            maxL: parseFloat(maxL.toFixed(1)),
            l_std_dev: parseFloat(l_std_dev.toFixed(1)),
            c_std_dev: parseFloat(c_std_dev.toFixed(1)),
            yellowDominance: parseFloat(yellowDominance.toFixed(1)),
            greenEnergy: parseFloat(greenEnergy.toFixed(1)),
            blueStrength: parseFloat(blueStrength.toFixed(1)),
            warmCoolRatio: parseFloat(warmCoolRatio.toFixed(2)),
            lowChromaDensity: parseFloat(lowChromaDensity.toFixed(3)),
            highChromaDensity: parseFloat(highChromaDensity.toFixed(3)),
            bitDepth: is16Bit ? 16 : 8
        };

        // If not generating Rich DNA, return legacy format only
        if (!generateRichDNA) {
            return legacyDNA;
        }

        // v2.0: Process sector data
        const sectors = {};
        const totalPixels = width * height;

        for (const sector of sectorData) {
            if (sector.count === 0) {
                continue; // Skip empty sectors
            }

            const lMean = sector.sumL / sector.count;
            const lVariance = (sector.sumLSquared / sector.count) - (lMean * lMean);
            const lStdDev = Math.sqrt(Math.max(0, lVariance));

            sectors[sector.name] = {
                weight: parseFloat((sector.totalWeight / Math.max(totalColorWeightSum, 1)).toFixed(3)),
                coverage: parseFloat((sector.count * sampleStep / totalPixels).toFixed(3)),
                lMean: parseFloat(lMean.toFixed(1)),
                lStdDev: parseFloat(lStdDev.toFixed(1)),
                cMean: parseFloat((sector.sumC / sector.count).toFixed(1)),
                cMax: parseFloat(sector.maxC.toFixed(1)),
                hMean: parseFloat((sector.sumH / sector.count).toFixed(1))
            };
        }

        // v2.0: Return hierarchical structure
        return {
            version: '2.0',

            // Legacy top-level fields (backward compatible)
            ...legacyDNA,

            // New hierarchical structure
            global: {
                l: legacyDNA.l,
                c: legacyDNA.c,
                k: legacyDNA.k,
                l_std_dev: legacyDNA.l_std_dev,
                c_std_dev: legacyDNA.c_std_dev,
                maxC: legacyDNA.maxC,
                maxCHue: legacyDNA.maxCHue,
                minL: legacyDNA.minL,
                maxL: legacyDNA.maxL,
                dynamicRange: legacyDNA.k,
                dominantHue: legacyDNA.maxCHue,
                yellowDominance: legacyDNA.yellowDominance,
                greenEnergy: legacyDNA.greenEnergy,
                blueStrength: legacyDNA.blueStrength,
                warmCoolRatio: legacyDNA.warmCoolRatio,
                lowChromaDensity: legacyDNA.lowChromaDensity,
                highChromaDensity: legacyDNA.highChromaDensity,
                chromaticCoverage: parseFloat((totalColorWeightSum / sampleCount).toFixed(3)),
                neutralWeight: parseFloat((neutralPixelCount / sampleCount).toFixed(3)),
                neutralLMean: neutralPixelCount > 0 ? parseFloat((neutralLSum / neutralPixelCount).toFixed(1)) : 0,
                bitDepth: is16Bit ? 16 : 8
            },

            sectors
        };
    }
}

module.exports = DNAGenerator;
