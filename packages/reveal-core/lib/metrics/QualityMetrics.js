/**
 * MetricsCalculator - Computes comprehensive validation metrics
 *
 * Generates three categories of metrics:
 * 1. Global Fidelity - CIE76 DeltaE measurements
 * 2. Feature Preservation - Saliency-weighted error analysis
 * 3. Physical Feasibility - Ink stack analysis and density breaches
 */

const DensityScanner = require('./DensityScanner');
const { cie76SquaredInline } = require('../color/LabDistance');

class MetricsCalculator {
    /**
     * Compute all validation metrics
     *
     * @param {Uint8ClampedArray} originalLab - Original Lab pixels (byte encoding)
     * @param {Uint8ClampedArray} processedLab - Posterized Lab pixels (byte encoding)
     * @param {Array} layers - Array of {name, color, mask} objects
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {Object} Complete metrics object
     */
    static compute(originalLab, processedLab, layers, width, height) {
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

            // CIE76 DeltaE formula (using centralized LabDistance)
            const distSq = cie76SquaredInline(L1, a1, b1, L2, a2, b2);
            const dE = Math.sqrt(distSq);

            totalDeltaE += dE;
            deltaEMap[i] = dE;
            if (dE > maxDeltaE) maxDeltaE = dE;
        }

        const avgDeltaE = totalDeltaE / pixelCount;

        // ==================================================================
        // 2. FEATURE PRESERVATION - Saliency Loss
        // ==================================================================

        const saliencyLoss = this._computeSaliencyWeightedError(deltaEMap, width, height);

        // Revelation Score: Custom metric combining average error and feature loss
        // Formula: 100 - (avgDeltaE × 1.5) - (saliencyLoss × 2)
        const revScore = Math.max(0, 100 - (avgDeltaE * 1.5) - (saliencyLoss * 2));

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

        const integrityScore = this._calculateIntegrity(totalLayerBreaches, width, height);

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
                saliencyLoss: parseFloat(saliencyLoss.toFixed(2))
            },
            physical_feasibility: {
                maxInkStack: maxStackHeight,
                avgInkStack: parseFloat(avgInkStack.toFixed(2)),
                densityFloorBreaches: totalLayerBreaches,
                breachVolume: totalBreachVolume,
                weakestPlate: worstLayerName,
                integrityScore: parseFloat(integrityScore)
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
}

module.exports = MetricsCalculator;
