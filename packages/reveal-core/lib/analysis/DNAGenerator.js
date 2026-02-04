/**
 * DNAGenerator v2.0
 * Generates comprehensive image DNA including 12-sector hue analysis
 * for archetype matching and parameter selection.
 */

class DNAGenerator {
    constructor() {
        // 12 hue sectors at 30° intervals (0-360°)
        this.SECTORS = [
            { name: 'red', start: 345, end: 15 },
            { name: 'orange', start: 15, end: 45 },
            { name: 'yellow', start: 45, end: 75 },
            { name: 'chartreuse', start: 75, end: 105 },
            { name: 'green', start: 105, end: 135 },
            { name: 'cyan', start: 135, end: 165 },
            { name: 'azure', start: 165, end: 195 },
            { name: 'blue', start: 195, end: 225 },
            { name: 'purple', start: 225, end: 255 },
            { name: 'magenta', start: 255, end: 285 },
            { name: 'pink', start: 285, end: 315 },
            { name: 'rose', start: 315, end: 345 }
        ];
    }

    /**
     * Generate DNA v2.0 from Lab pixel data
     * @param {Float32Array|Uint16Array} labPixels - Lab pixels (L,a,b triples)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Object} options - Options (bitDepth, etc.)
     * @returns {Object} DNA v2.0 object
     */
    generate(labPixels, width, height, options = {}) {
        const bitDepth = options.bitDepth || 8;
        const totalPixels = width * height;

        // Initialize sector data
        const sectorData = {};
        this.SECTORS.forEach(s => {
            sectorData[s.name] = {
                pixels: [],
                weight: 0,
                lMean: 0,
                cMean: 0,
                cMax: 0
            };
        });

        // Track global statistics
        let lSum = 0, lSqSum = 0;
        let cSum = 0, cMax = 0;
        let kMax = 0, kMin = 100;
        let warmPixels = 0, coolPixels = 0;

        // Process each pixel
        for (let i = 0; i < labPixels.length; i += 3) {
            const L = this._normalizeLab(labPixels[i], 'L', bitDepth);
            const a = this._normalizeLab(labPixels[i + 1], 'a', bitDepth);
            const b = this._normalizeLab(labPixels[i + 2], 'b', bitDepth);

            const C = Math.sqrt(a * a + b * b);
            const h = this._labToHue(a, b);

            // Global statistics
            lSum += L;
            lSqSum += L * L;
            cSum += C;
            cMax = Math.max(cMax, C);
            kMax = Math.max(kMax, L);
            kMin = Math.min(kMin, L);

            // Temperature bias (warm = +b, cool = -b)
            if (Math.abs(b) > 5) {
                if (b > 0) warmPixels++;
                else coolPixels++;
            }

            // Assign to sector (only if chromatic)
            if (C > 5) {
                const sector = this._getSectorForHue(h);
                if (sector) {
                    sectorData[sector.name].pixels.push({ L, C, h });
                    sectorData[sector.name].cMax = Math.max(sectorData[sector.name].cMax, C);
                }
            }
        }

        // Calculate global metrics
        const lMean = lSum / totalPixels;
        const lVariance = (lSqSum / totalPixels) - (lMean * lMean);
        const lStdDev = Math.sqrt(Math.max(0, lVariance));
        const cMean = cSum / totalPixels;
        const k = kMax - kMin; // Contrast

        // Process sector statistics
        let dominantSector = null;
        let maxWeight = 0;

        this.SECTORS.forEach(s => {
            const sector = sectorData[s.name];
            const pixelCount = sector.pixels.length;
            sector.weight = pixelCount / totalPixels;

            if (pixelCount > 0) {
                sector.lMean = sector.pixels.reduce((sum, p) => sum + p.L, 0) / pixelCount;
                sector.cMean = sector.pixels.reduce((sum, p) => sum + p.C, 0) / pixelCount;
            }

            // Track dominant sector
            if (sector.weight > maxWeight) {
                maxWeight = sector.weight;
                dominantSector = s.name;
            }

            // Clean up pixel array (not needed in final output)
            delete sector.pixels;
        });

        // Calculate hue entropy (Shannon entropy of sector weights)
        const hueEntropy = this._calculateEntropy(
            this.SECTORS.map(s => sectorData[s.name].weight)
        );

        // Calculate temperature bias (-1 = cool, +1 = warm)
        const totalTempPixels = warmPixels + coolPixels;
        const temperatureBias = totalTempPixels > 0
            ? (warmPixels - coolPixels) / totalTempPixels
            : 0;

        return {
            version: '2.0',
            global: {
                l: parseFloat(lMean.toFixed(1)),
                c: parseFloat(cMean.toFixed(1)),
                k: parseFloat(k.toFixed(1)),
                l_std_dev: parseFloat(lStdDev.toFixed(1)),
                hue_entropy: parseFloat(hueEntropy.toFixed(3)),
                temperature_bias: parseFloat(temperatureBias.toFixed(2)),
                primary_sector_weight: parseFloat(maxWeight.toFixed(3))
            },
            dominant_sector: dominantSector,
            sectors: sectorData,
            metadata: {
                width,
                height,
                totalPixels,
                bitDepth
            }
        };
    }

    /**
     * Normalize Lab values from encoded format to standard range
     */
    _normalizeLab(value, component, bitDepth) {
        if (bitDepth === 16) {
            // 16-bit: L: 0-32768 → 0-100, a/b: 0-32768 (16384=neutral) → -128 to +127
            if (component === 'L') {
                return (value / 32768) * 100;
            } else {
                return ((value - 16384) / 128);
            }
        } else {
            // 8-bit: L: 0-255 → 0-100, a/b: 0-255 (128=neutral) → -128 to +127
            if (component === 'L') {
                return (value / 255) * 100;
            } else {
                return value - 128;
            }
        }
    }

    /**
     * Convert Lab a,b to hue angle (0-360°)
     */
    _labToHue(a, b) {
        let h = Math.atan2(b, a) * (180 / Math.PI);
        if (h < 0) h += 360;
        return h;
    }

    /**
     * Get sector for a given hue angle
     */
    _getSectorForHue(hue) {
        for (const sector of this.SECTORS) {
            if (sector.start > sector.end) {
                // Wraps around 0° (e.g., red: 345-15)
                if (hue >= sector.start || hue < sector.end) {
                    return sector;
                }
            } else {
                if (hue >= sector.start && hue < sector.end) {
                    return sector;
                }
            }
        }
        return null;
    }

    /**
     * Calculate Shannon entropy of a probability distribution
     * Returns 0 (monochrome) to 1 (uniform rainbow)
     */
    _calculateEntropy(weights) {
        const maxEntropy = Math.log2(this.SECTORS.length);
        let entropy = 0;

        for (const w of weights) {
            if (w > 0) {
                entropy -= w * Math.log2(w);
            }
        }

        return entropy / maxEntropy; // Normalize to 0-1
    }
}

module.exports = DNAGenerator;
