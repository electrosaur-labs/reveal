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
 * - Spatial complexity metrics (entropy, edge density, local contrast)
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
     * @param {boolean} options.richDNA - Generate Rich DNA v2.0 with sectors and spatial metrics
     * @param {boolean} options.spatialMetrics - Calculate spatial complexity (async-friendly)
     * @returns {Object} DNA object with legacy fields + optional v2.0 hierarchical structure
     *   Legacy fields: l, c, k, maxC, maxCHue, minL, maxL, yellowDominance, l_std_dev
     *   v2.0 fields: global, sectors, spatial (if options.richDNA = true)
     */
    static generate(labPixels, width, height, sampleStep = 40, options = {}) {
        let sumL = 0, sumA = 0, sumB = 0;
        let minL = 100, maxL = 0;
        let maxC = 0;
        let maxCHue = 0;
        let sampleCount = 0;

        // Yellow dominance tracking (50-100° hue range)
        let yellowPixelWeightSum = 0;
        let totalColorWeightSum = 0;

        // Neutral gravity tracking (chroma < 3.0)
        let neutralPixelCount = 0;
        let neutralLSum = 0;

        // L standard deviation tracking
        let sumLSquared = 0;

        // Detect 16-bit vs 8-bit data
        // 16-bit: Uint16Array with values 0-32768
        // 8-bit: Uint8Array/Uint8ClampedArray with values 0-255
        const is16Bit = labPixels instanceof Uint16Array;

        // v2.0: Per-sector tracking (12 sectors, 30° each)
        const sectorData = options.richDNA ? this.SECTORS.map(name => ({
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
            if (chroma > maxC) {
                maxC = chroma;
                // Calculate hue angle in degrees (0-360°)
                maxCHue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
            }

            // NEUTRAL GRAVITY: Track near-neutral pixels (chroma < 3.0)
            // These are mathematically gray and should resist color migration
            const isNeutral = chroma < 3.0;
            if (isNeutral) {
                neutralPixelCount++;
                neutralLSum += L;
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

        // Calculate yellow dominance score (0-100)
        // Represents percentage of chromatic pixels in yellow hue range
        const yellowDominance = totalColorWeightSum > 0
            ? (yellowPixelWeightSum / totalColorWeightSum) * 100
            : 0;

        // Legacy v1.0 fields (backward compatible)
        const legacyDNA = {
            l: parseFloat(avgL.toFixed(1)),
            c: parseFloat(avgC.toFixed(1)),
            k: parseFloat(contrast.toFixed(1)),
            maxC: parseFloat(maxC.toFixed(1)),
            maxCHue: parseFloat(maxCHue.toFixed(1)),
            minL: parseFloat(minL.toFixed(1)),
            maxL: parseFloat(maxL.toFixed(1)),
            yellowDominance: parseFloat(yellowDominance.toFixed(1)),
            l_std_dev: parseFloat(l_std_dev.toFixed(1))
        };

        // If not generating Rich DNA, return legacy format only
        if (!options.richDNA) {
            return legacyDNA;
        }

        // v2.0: Process sector data
        const sectors = {};
        const totalPixels = width * height;
        const chromaticPixelCount = totalColorWeightSum; // Approximate chromatic pixel count

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

        // v2.0: Calculate spatial metrics (if requested)
        let spatial = null;
        if (options.spatialMetrics) {
            spatial = this.calculateSpatialMetrics(labPixels, width, height, is16Bit);
        }

        // v2.0: Return hierarchical structure
        const neutralWeightValue = parseFloat((neutralPixelCount / sampleCount).toFixed(3));
        const chromaticCoverageValue = parseFloat((chromaticPixelCount / sampleCount).toFixed(2));

        console.log(`🔬 DNAGenerator v2.0 - Neutral tracking:`);
        console.log(`   neutralPixelCount: ${neutralPixelCount}, sampleCount: ${sampleCount}`);
        console.log(`   neutralWeight: ${neutralWeightValue} (${(neutralWeightValue * 100).toFixed(1)}%)`);
        console.log(`   chromaticCoverage: ${chromaticCoverageValue}`);

        const dna = {
            version: '2.0',

            // Legacy top-level fields (backward compatible)
            ...legacyDNA,

            // New hierarchical structure
            global: {
                l: legacyDNA.l,
                c: legacyDNA.c,
                k: legacyDNA.k,
                l_std_dev: legacyDNA.l_std_dev,
                maxC: legacyDNA.maxC,
                maxCHue: legacyDNA.maxCHue,
                minL: legacyDNA.minL,
                maxL: legacyDNA.maxL,
                dynamicRange: legacyDNA.k,
                dominantHue: legacyDNA.maxCHue,
                chromaticCoverage: chromaticCoverageValue,
                neutralWeight: neutralWeightValue,
                neutralLMean: neutralPixelCount > 0 ? parseFloat((neutralLSum / neutralPixelCount).toFixed(1)) : 0,
                bitDepth: is16Bit ? 16 : 8
            },

            sectors,

            ...(spatial && { spatial })
        };

        console.log(`🔬 DNAGenerator - Returning DNA with global.neutralWeight=${dna.global.neutralWeight}`);

        return dna;
    }

    /**
     * Calculate spatial complexity metrics
     * @param {Uint8ClampedArray|Uint16Array} labPixels - Lab pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {boolean} is16Bit - Whether data is 16-bit
     * @returns {Object} Spatial metrics
     */
    static calculateSpatialMetrics(labPixels, width, height, is16Bit) {
        // Entropy calculation (reuse from BilateralFilter if available)
        // For UXP, we'll do a simplified version
        let entropy = 0;

        // Simple entropy: Calculate variance in 3x3 neighborhoods
        const stride = 4; // Sample every 4th pixel for speed
        let totalVariance = 0;
        let varianceCount = 0;

        const scale = is16Bit ? (1 / 32768) * 100 : (1 / 255) * 100;

        for (let y = 1; y < height - 1; y += stride) {
            for (let x = 1; x < width - 1; x += stride) {
                const centerIdx = (y * width + x) * 3;
                const centerL = labPixels[centerIdx] * scale;

                // Calculate local variance in 3x3 window
                let sum = 0;
                let sumSq = 0;
                let n = 0;

                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nIdx = ((y + dy) * width + (x + dx)) * 3;
                        const L = labPixels[nIdx] * scale;
                        sum += L;
                        sumSq += L * L;
                        n++;
                    }
                }

                const mean = sum / n;
                const variance = (sumSq / n) - (mean * mean);
                if (variance > 0 && !isNaN(variance)) {
                    totalVariance += Math.sqrt(variance);
                    varianceCount++;
                }
            }
        }

        entropy = varianceCount > 0 ? Math.min(100, (totalVariance / varianceCount) * 2) : 0;

        // Edge density: Simple Sobel edge detection
        let edgeCount = 0;
        let edgeCheckCount = 0;
        const edgeThreshold = 10; // Lab units

        for (let y = 1; y < height - 1; y += stride) {
            for (let x = 1; x < width - 1; x += stride) {
                const idx = (y * width + x) * 3;
                const center = labPixels[idx] * scale;

                // Sobel X
                const left = labPixels[(y * width + (x - 1)) * 3] * scale;
                const right = labPixels[(y * width + (x + 1)) * 3] * scale;
                const gx = right - left;

                // Sobel Y
                const top = labPixels[((y - 1) * width + x) * 3] * scale;
                const bottom = labPixels[((y + 1) * width + x) * 3] * scale;
                const gy = bottom - top;

                const edgeMagnitude = Math.sqrt(gx * gx + gy * gy);
                if (edgeMagnitude > edgeThreshold) {
                    edgeCount++;
                }
                edgeCheckCount++;
            }
        }

        const edgeDensity = edgeCheckCount > 0 ? edgeCount / edgeCheckCount : 0;

        return {
            entropy: parseFloat(entropy.toFixed(1)),
            edgeDensity: parseFloat(edgeDensity.toFixed(3)),
            complexityScore: parseFloat(entropy.toFixed(1)) // Use entropy as complexity score
        };
    }
}

module.exports = DNAGenerator;
