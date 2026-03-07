/**
 * MetricsCalculator - Computes comprehensive validation metrics
 *
 * Generates three categories of metrics:
 * 1. Global Fidelity - CIE76 DeltaE measurements
 * 2. Feature Preservation - Saliency-weighted error analysis + efficiency penalty
 * 3. Physical Feasibility - Ink stack analysis and density breaches
 *
 * EFFICIENCY PENALTY (2026-01-20):
 * Penalizes "Screen Bloat" to align metrics with economics of print.
 * A 16-color image that looks "perfect" is actually a failure (costs too much).
 * An 8-color image that looks "90% perfect" is a triumph.
 *
 * - <= 8 Colors: No penalty (Efficiency Safe Zone)
 * - > 8 Colors: -1.5 points per extra screen
 *   - 12 colors: -6.0 points (survivable for good images)
 *   - 16 colors: -12.0 points (massive hit)
 */

const DensityScanner = require('@electrosaur-labs/core/lib/metrics/DensityScanner');

// --- EFFICIENCY CONSTANTS ---
const SCREEN_LIMIT = 8;           // No penalty at or below this
const PENALTY_PER_SCREEN = 1.5;   // Points deducted per extra screen

class MetricsCalculator {
    /**
     * Compute all validation metrics
     *
     * @param {Uint8ClampedArray} originalLab - Original Lab pixels (byte encoding)
     * @param {Uint8ClampedArray} processedLab - Posterized Lab pixels (byte encoding)
     * @param {Array} layers - Array of {name, color, mask} objects
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Object} config - Configuration object (optional, for targetColors)
     * @returns {Object} Complete metrics object
     */
    static compute(originalLab, processedLab, layers, width, height, config = {}) {
        const pixelCount = width * height;

        // ==================================================================
        // 1. GLOBAL FIDELITY - DeltaE Measurements
        // ==================================================================

        let totalDeltaE = 0;
        let maxDeltaE = 0;
        const deltaEMap = new Float32Array(pixelCount);

        for (let i = 0; i < pixelCount; i++) {
            const idx = i * 3;

            // Convert byte encoding back to Lab ranges for accurate DeltaE
            const L1 = (originalLab[idx] / 255) * 100;
            const a1 = originalLab[idx + 1] - 128;
            const b1 = originalLab[idx + 2] - 128;

            const L2 = (processedLab[idx] / 255) * 100;
            const a2 = processedLab[idx + 1] - 128;
            const b2 = processedLab[idx + 2] - 128;

            // CIE76 DeltaE formula
            const dL = L1 - L2;
            const da = a1 - a2;
            const db = b1 - b2;
            const dE = Math.sqrt(dL * dL + da * da + db * db);

            totalDeltaE += dE;
            deltaEMap[i] = dE;
            if (dE > maxDeltaE) maxDeltaE = dE;
        }

        const avgDeltaE = totalDeltaE / pixelCount;

        // ==================================================================
        // 2. FEATURE PRESERVATION - Saliency Loss + Efficiency Penalty
        // ==================================================================

        const saliencyLoss = this._computeSaliencyWeightedError(deltaEMap, width, height);

        // Base Revelation Score: Visual fidelity metric
        // Formula: 100 - (avgDeltaE × 1.5) - (saliencyLoss × 2)
        const baseRevScore = Math.max(0, 100 - (avgDeltaE * 1.5) - (saliencyLoss * 2));

        // Efficiency Penalty: Penalize screen bloat
        // <= 8 colors: no penalty, > 8 colors: -1.5 per extra screen
        const screenCount = config.targetColors || layers.length;
        let efficiencyPenalty = 0;
        if (screenCount > SCREEN_LIMIT) {
            efficiencyPenalty = (screenCount - SCREEN_LIMIT) * PENALTY_PER_SCREEN;
        }

        // Final Revelation Score with efficiency penalty applied
        const revScore = Math.max(0, baseRevScore - efficiencyPenalty);

        // ==================================================================
        // 3. PHYSICAL FEASIBILITY - Ink Stack Analysis
        // ==================================================================

        let maxStackHeight = 0;
        let totalInkPixels = 0;
        const stackHeights = new Uint8Array(pixelCount);

        for (let i = 0; i < pixelCount; i++) {
            let stack = 0;
            for (const layer of layers) {
                if (layer.mask[i] > 0) {
                    stack++;
                }
            }
            stackHeights[i] = stack;
            if (stack > 0) totalInkPixels += stack;
            if (stack > maxStackHeight) maxStackHeight = stack;
        }

        const avgInkStack = totalInkPixels / pixelCount;

        // ==================================================================
        // 4. PHYSICAL FEASIBILITY - Density Floor Breaches
        // ==================================================================

        let totalLayerBreaches = 0;
        let totalBreachVolume = 0;
        let worstLayerName = '';
        let maxBreachesInLayer = 0;
        const PRINT_THRESHOLD = 4;  // Industry standard for 230 mesh screens

        layers.forEach((layer, index) => {
            const scanResult = DensityScanner.scan(
                layer.mask,
                width,
                height,
                PRINT_THRESHOLD
            );

            totalLayerBreaches += scanResult.breachCount;
            totalBreachVolume += scanResult.breachVolume;

            if (scanResult.breachCount > maxBreachesInLayer) {
                maxBreachesInLayer = scanResult.breachCount;
                worstLayerName = layer.name || `Layer ${index + 1}`;
            }
        });

        const densityIntegrity = this._calculateIntegrity(totalLayerBreaches, width, height);

        // ==================================================================
        // 5. TRUE INTEGRITY - Coverage + Valid Paper
        // ==================================================================

        const trueIntegrity = this.calculateTrueIntegrity(layers, originalLab, width, height);

        // ==================================================================
        // RETURN COMPLETE METRICS OBJECT
        // ==================================================================

        return {
            global_fidelity: {
                avgDeltaE: parseFloat(avgDeltaE.toFixed(2)),
                maxDeltaE: parseFloat(maxDeltaE.toFixed(2))
            },
            feature_preservation: {
                revelationScore: parseFloat(revScore.toFixed(1)),
                baseScore: parseFloat(baseRevScore.toFixed(1)),
                efficiencyPenalty: parseFloat(efficiencyPenalty.toFixed(1)),
                screenCount: screenCount,
                saliencyLoss: parseFloat(saliencyLoss.toFixed(2))
            },
            physical_feasibility: {
                maxInkStack: maxStackHeight,
                avgInkStack: parseFloat(avgInkStack.toFixed(2)),
                densityFloorBreaches: totalLayerBreaches,
                breachVolume: totalBreachVolume,
                weakestPlate: worstLayerName,
                integrityScore: trueIntegrity.score,
                integrityDetails: trueIntegrity.details,
                densityIntegrity: parseFloat(densityIntegrity)
            }
        };
    }

    /**
     * Compute edge-weighted error (saliency loss)
     * Focuses on errors in high-contrast regions (edges/features)
     *
     * @private
     */
    static _computeSaliencyWeightedError(deltaEMap, width, height) {
        let edgeWeightedError = 0;
        let edgePixelCount = 0;
        const pixelCount = width * height;

        // Simple saliency detection: pixels with high DeltaE are likely edges
        // More sophisticated version could use gradient detection
        for (let i = 0; i < pixelCount; i++) {
            if (deltaEMap[i] > 10.0) {  // Threshold for "noticeable error"
                edgeWeightedError += deltaEMap[i];
                edgePixelCount++;
            }
        }

        return edgePixelCount > 0 ? (edgeWeightedError / edgePixelCount) : 0;
    }

    /**
     * Calculate integrity score with extended tolerance for textured images
     *
     * Revised tolerance strategy (based on real-world visual assessment):
     * - Safe Zone (0-0.5%): Score 100 - microscopic dots invisible in print
     * - Good Zone (0.5-8%): Linear decay 100→60 - visible but printable
     * - Fail Zone (8-12%): Linear decay 60→0 - quality degradation
     * - Critical (>12%): Score 0 - unprintable
     *
     * This extended tolerance accounts for high-texture/high-detail images
     * (like Marrakech Museum with 6.4% noise) that still look visually perfect.
     *
     * @private
     */
    static _calculateIntegrity(breaches, width, height) {
        const totalPixels = width * height;
        const noiseRatio = breaches / totalPixels;

        // Safe Zone (0% to 0.5% noise)
        // Screen emulsion can handle tiny isolated pixels without visible issues
        const SAFE_LIMIT = 0.005;  // 0.5%
        if (noiseRatio <= SAFE_LIMIT) return 100;

        // Good Zone (0.5% to 8.0% noise)
        // Score drops linearly from 100 → 60
        // Extended to accommodate textured images with higher breach counts
        const GOOD_LIMIT = 0.08;  // 8.0%
        if (noiseRatio <= GOOD_LIMIT) {
            const range = GOOD_LIMIT - SAFE_LIMIT;
            const progress = (noiseRatio - SAFE_LIMIT) / range;
            return (100 - (progress * 40)).toFixed(1);  // 100 → 60
        }

        // Fail Zone (8.0% to 12.0% noise)
        // Score drops linearly from 60 → 0
        // Significant quality issues
        const FAIL_LIMIT = 0.12;  // 12.0%
        if (noiseRatio > FAIL_LIMIT) return 0;

        const range = FAIL_LIMIT - GOOD_LIMIT;
        const progress = (noiseRatio - GOOD_LIMIT) / range;
        return (60 - (progress * 60)).toFixed(1);  // 60 → 0
    }

    /**
     * Calculate True Integrity for Screen Printing (Knockout)
     *
     * In knockout separations, pixels are either:
     * 1. Covered by ink (valid)
     * 2. Left as paper/substrate (valid if paper-colored, i.e., L > 90)
     * 3. Void (uncovered and NOT paper-colored = failure)
     *
     * This accounts for intentionally blank paper areas as valid coverage.
     *
     * @param {Array} layers - Array of {mask: Uint8Array} objects
     * @param {Uint8ClampedArray} originalLab - Original Lab pixels (byte encoding)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {Object} - { score, details: { ink, paper, void } }
     */
    static calculateTrueIntegrity(layers, originalLab, width, height) {
        const totalPixels = width * height;

        // 1. Mark all pixels covered by ANY ink layer
        const coveredPixels = new Uint8Array(totalPixels);
        layers.forEach(layer => {
            for (let i = 0; i < totalPixels; i++) {
                if (layer.mask[i] > 0) coveredPixels[i] = 1;
            }
        });

        // 2. Count ink, valid paper, and void pixels
        let inkCount = 0;
        let validPaperCount = 0;
        let voidCount = 0;

        // L > 230 in byte encoding ≈ L* > 90 in perceptual space
        const PAPER_THRESHOLD = 230;

        for (let i = 0; i < totalPixels; i++) {
            if (coveredPixels[i] === 1) {
                inkCount++;
            } else {
                // Check original pixel lightness
                const L = originalLab[i * 3];
                if (L > PAPER_THRESHOLD) {
                    validPaperCount++;
                } else {
                    voidCount++;
                }
            }
        }

        // Score: (ink + validPaper) / total
        const score = ((inkCount + validPaperCount) / totalPixels) * 100;

        return {
            score: parseFloat(score.toFixed(1)),
            details: {
                ink: parseFloat(((inkCount / totalPixels) * 100).toFixed(1)),
                paper: parseFloat(((validPaperCount / totalPixels) * 100).toFixed(1)),
                void: parseFloat(((voidCount / totalPixels) * 100).toFixed(1))
            }
        };
    }

    /**
     * Calculate Revelation Error Score (E_rev)
     * Delegates to @electrosaur-labs/core RevelationError.fromBuffers().
     *
     * @param {Uint8ClampedArray} originalLab - Original Lab pixels (byte encoding, 3 bytes/pixel)
     * @param {Uint8ClampedArray} processedLab - Posterized Lab pixels (byte encoding, 3 bytes/pixel)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Object} [options] - Options
     * @param {number} [options.stride=1] - Sample every Nth pixel (stride=2 → 25% of pixels)
     * @returns {{ eRev: number, chromaStats: { cMax: number, avgChroma: number, chromaPixelRatio: number } }}
     */
    static calculateRevelationErrorScore(originalLab, processedLab, width, height, options = {}) {
        const RevelationError = require('@electrosaur-labs/core').RevelationError;
        return RevelationError.fromBuffers(originalLab, processedLab, width, height, options);
    }
}

module.exports = MetricsCalculator;
