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

        // HIGH-PERFORMANCE BUFFERS: Eliminate million-object allocation
        const sectorCount = new Uint32Array(12);
        const sectorLSum = new Float64Array(12);
        const sectorCSum = new Float64Array(12);
        const sectorCMax = new Float64Array(12);

        // Pre-compute normalization factors to avoid branching in loop
        let lNorm, abNorm, abNeutral;
        if (bitDepth === 'perceptual') {
            lNorm = 1; abNorm = 1; abNeutral = 0;
        } else if (bitDepth === 16) {
            lNorm = 100 / 32768; abNorm = 1/128; abNeutral = 16384;
        } else {
            lNorm = 100 / 255; abNorm = 1; abNeutral = 128;
        }

        const RAD_TO_DEG = 180 / Math.PI;
        let lSum = 0, lSqSum = 0, cSum = 0, cMaxGlobal = 0;
        let kMax = 0, kMin = 100;
        let warmPixels = 0, coolPixels = 0;

        // CORE LOOP: Minimal overhead
        for (let i = 0; i < labPixels.length; i += 3) {
            // 1. Normalize
            let L, a, b;
            if (bitDepth === 'perceptual') {
                L = labPixels[i]; a = labPixels[i+1]; b = labPixels[i+2];
            } else if (bitDepth === 16) {
                L = labPixels[i] * lNorm;
                a = (labPixels[i+1] - abNeutral) * abNorm;
                b = (labPixels[i+2] - abNeutral) * abNorm;
            } else {
                L = labPixels[i] * lNorm;
                a = labPixels[i+1] - abNeutral;
                b = labPixels[i+2] - abNeutral;
            }

            // 2. Global stats
            const C = Math.sqrt(a * a + b * b);
            lSum += L;
            lSqSum += L * L;
            cSum += C;
            if (C > cMaxGlobal) cMaxGlobal = C;
            if (L > kMax) kMax = L;
            if (L < kMin) kMin = L;

            // 3. Temperature bias (warm = +b, cool = -b)
            if (b > 5) warmPixels++;
            else if (b < -5) coolPixels++;

            // 4. Sector Analysis (only if chromatic)
            if (C > 5) {
                let h = Math.atan2(b, a) * RAD_TO_DEG;
                if (h < 0) h += 360;

                // Fast sector lookup: 360° / 12 = 30° sectors
                // Offset by 15° because Red starts at 345° (-15°)
                let sIdx = Math.floor(((h + 15) % 360) / 30);
                
                sectorCount[sIdx]++;
                sectorLSum[sIdx] += L;
                sectorCSum[sIdx] += C;
                if (C > sectorCMax[sIdx]) sectorCMax[sIdx] = C;
            }
        }

        // --- Post-Processing ---
        const lMean = lSum / totalPixels;
        const lStdDev = Math.sqrt(Math.max(0, (lSqSum / totalPixels) - (lMean * lMean)));
        const cMean = cSum / totalPixels;
        
        const sectorData = {};
        let dominantSector = null;
        let maxSectorWeight = 0;
        const weights = new Float64Array(12);

        for (let j = 0; j < 12; j++) {
            const name = this.SECTORS[j].name;
            const count = sectorCount[j];
            const weight = count / totalPixels;
            weights[j] = weight;

            sectorData[name] = {
                weight: parseFloat(weight.toFixed(4)),
                lMean: count > 0 ? parseFloat((sectorLSum[j] / count).toFixed(1)) : 0,
                cMean: count > 0 ? parseFloat((sectorCSum[j] / count).toFixed(1)) : 0,
                cMax: parseFloat(sectorCMax[j].toFixed(1))
            };

            if (weight > maxSectorWeight) {
                maxSectorWeight = weight;
                dominantSector = name;
            }
        }

        const hueEntropy = this._calculateEntropy(weights);
        const totalTempPixels = warmPixels + coolPixels;

        return {
            version: '2.0',
            global: {
                l: parseFloat(lMean.toFixed(1)),
                c: parseFloat(cMean.toFixed(1)),
                k: parseFloat((kMax - kMin).toFixed(1)),
                l_std_dev: parseFloat(lStdDev.toFixed(1)),
                hue_entropy: parseFloat(hueEntropy.toFixed(3)),
                temperature_bias: parseFloat((totalTempPixels > 0 ? (warmPixels - coolPixels) / totalTempPixels : 0).toFixed(2)),
                primary_sector_weight: parseFloat(maxSectorWeight.toFixed(3))
            },
            dominant_sector: dominantSector || 'gray',
            sectors: sectorData,
            metadata: { width, height, totalPixels, bitDepth }
        };
    }

    static fromPixels(labPixels, width, height, options = {}) {
        const bitDepth = options.bitDepth || (labPixels instanceof Uint16Array ? 16 : 8);
        return (new DNAGenerator()).generate(labPixels, width, height, { bitDepth });
    }

    static fromIndices(colorIndices, labPalette, width, height) {
        const pixelCount = width * height;
        const labPixels = new Float32Array(pixelCount * 3);
        for (let i = 0; i < pixelCount; i++) {
            const pal = labPalette[colorIndices[i]];
            const off = i * 3;
            labPixels[off] = pal.L; labPixels[off + 1] = pal.a; labPixels[off + 2] = pal.b;
        }
        return (new DNAGenerator()).generate(labPixels, width, height, { bitDepth: 'perceptual' });
    }

    _calculateEntropy(weights) {
        const maxEntropy = Math.log2(12);
        let entropy = 0;
        for (const w of weights) {
            if (w > 0) entropy -= w * Math.log2(w);
        }
        return entropy / maxEntropy;
    }
}

module.exports = DNAGenerator;
