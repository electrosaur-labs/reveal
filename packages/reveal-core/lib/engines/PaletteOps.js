/**
 * PaletteOps - Palette Management Operations
 *
 * Extracted from PosterizationEngine.js for modularity.
 * Contains all palette merging, pruning, snapping, and distance methods.
 *
 * All methods are static - no instance state required.
 */

const logger = require("../utils/logger");
const { CentroidStrategies } = require('./CentroidStrategies');
const LabDistance = require('../color/LabDistance');

/**
 * Default tuning parameters (mirrors PosterizationEngine.TUNING subset)
 */
const DEFAULT_TUNING = {
    prune: { threshold: 9.0, hueLockAngle: 18, whitePoint: 85, shadowPoint: 15 },
    centroid: { lWeight: 1.1, cWeight: 2.0, blackBias: 5.0 }
};

class PaletteOps {

    /**
     * Calculate perceptual distance between two Lab colors (L-weighted)
     *
     * Performance: Returns SQUARED distance (no sqrt) - sufficient for comparisons.
     * When comparing distances, sqrt is unnecessary since sqrt(a) < sqrt(b) ⟺ a < b.
     *
     * Formula: ΔE² = 1.5*dL² + da² + db²
     * Standard CIE76: ΔE = sqrt(dL² + da² + db²)
     *
     * @param {Object} lab1 - {L, a, b}
     * @param {Object} lab2 - {L, a, b}
     * @returns {number} distanceSquared - Perceptual distance squared (L-weighted)
     */
    static calculateCIELABDistance(lab1, lab2, isGrayscale = false) {
        const deltaL = lab1.L - lab2.L;
        const deltaA = lab1.a - lab2.a;
        const deltaB = lab1.b - lab2.b;

        // Luma-aware weighting per Architect guidance:
        // Grayscale: L_WEIGHT = 3.0 (human vision extremely sensitive to luma steps)
        // Color: L_WEIGHT = 1.5 (balanced tonal structure)
        const L_WEIGHT = isGrayscale ? 3.0 : 1.5;

        // Return squared distance (no sqrt) - faster and sufficient for comparisons
        return L_WEIGHT * deltaL * deltaL + deltaA * deltaA + deltaB * deltaB;
    }

    /**
     * Apply perceptual snap threshold to collapse similar colors
     *
     * Philosophy: "The engine actively curates by removing subtle noise
     * and highlighting core structures (Fidelity to Feature)"
     *
     * @param {Array} palette - Array of Lab colors: [{L, a, b}, ...]
     * @param {number} threshold - ΔE threshold (default 8.0) - regular distance, will be squared for comparison
     * @param {boolean} isGrayscale - Grayscale mode flag
     * @param {number} vibrancyMultiplier - Vibrancy boost multiplier (deprecated, kept for compatibility)
     * @param {Function} strategy - Centroid strategy function
     * @param {Object} tuning - Tuning parameters for centroid calculation
     * @returns {Array} snappedPalette - Curated palette with similar colors merged
     */
    static applyPerceptualSnap(palette, threshold = 8.0, isGrayscale = false, vibrancyMultiplier = 2.0, strategy = null, tuning = null) {
        if (palette.length <= 1) {
            return palette;
        }

        const snapped = [];
        const merged = new Set();
        let totalMerged = 0;

        // Square the threshold for comparison with squared distances
        const thresholdSquared = threshold * threshold;

        for (let i = 0; i < palette.length; i++) {
            if (merged.has(i)) continue;

            // Start a new feature group with this color
            const featureGroup = [palette[i]];
            const featureIndices = [i];

            // Find all colors within snap threshold (using luma-aware distance)
            for (let j = i + 1; j < palette.length; j++) {
                if (merged.has(j)) continue;

                const deltaESquared = this.calculateCIELABDistance(palette[i], palette[j], isGrayscale);

                if (deltaESquared < thresholdSquared) {
                    featureGroup.push(palette[j]);
                    featureIndices.push(j);
                    merged.add(j);
                    totalMerged++;
                }
            }

            // Merge feature group into single representative color (centroid)
            const representative = this._calculateLabCentroid(featureGroup, isGrayscale, strategy, tuning);
            snapped.push(representative);

            if (featureGroup.length > 1) {
            }
        }

        if (totalMerged > 0) {
        } else {
        }

        return snapped;
    }

    /**
     * Calculate representative color for a group of colors in Lab space
     *
     * Grayscale mode: Average L (neutral gray)
     * Color mode: Pick MOST SATURATED color (highest chroma)
     *
     * @private
     */
    /**
     * STRATEGY-AWARE CENTROID CALCULATION
     *
     * Uses injected strategy to determine representative color for a bucket.
     * Falls back to VOLUMETRIC if no strategy provided (backward compatibility).
     *
     * @private
     * @param {Array} colors - Bucket colors
     * @param {boolean} grayscaleOnly - L-channel only mode
     * @param {Function} strategy - Centroid strategy function
     * @param {Object} tuning - Tuning parameters
     * @returns {{L: number, a: number, b: number}} - Representative color
     */
    static _calculateLabCentroid(colors, grayscaleOnly = false, strategy = null, tuning = null) {
        // Safety check: empty colors array
        if (!colors || colors.length === 0) {
            return { L: 50, a: 0, b: 0 }; // Neutral gray fallback
        }

        // Use injected strategy or fallback to VOLUMETRIC
        const centroidStrategy = strategy || CentroidStrategies.VOLUMETRIC;
        const defaultWeights = { lWeight: 1.1, cWeight: 2.0, blackBias: 5.0 };
        const weights = tuning ? tuning.centroid : defaultWeights;

        // Safety check: ensure strategy is a function
        if (typeof centroidStrategy !== 'function') {
            logger.warn(`⚠️ Invalid centroid strategy (not a function), falling back to VOLUMETRIC`);
            return CentroidStrategies.VOLUMETRIC(colors, weights);
        }

        if (grayscaleOnly) {
            // Grayscale mode: Use strategy but force a=b=0
            const result = centroidStrategy(colors, weights);
            return { L: result.L, a: 0, b: 0 };
        } else {
            // Color mode: Use strategy as-is
            return centroidStrategy(colors, weights);
        }
    }

    /**
     * TUNING-AWARE PALETTE PRUNING
     *
     * Merges colors using centralized tuning parameters.
     * Applies hue lock, highlight protection, and saliency-based selection.
     *
     * @private
     * @param {Array<{L: number, a: number, b: number}>} paletteLab - Lab palette
     * @param {number} threshold - Minimum ΔE distance (defaults to TUNING.prune.threshold)
     * @param {number} highlightThreshold - L-value protection floor (defaults to TUNING.prune.whitePoint)
     * @param {number} targetCount - Stop when reaching this count
     * @param {Object} tuning - Tuning config (defaults to TUNING)
     * @returns {Array<{L: number, a: number, b: number}>} - Pruned palette
     */
    static _prunePalette(paletteLab, threshold = null, highlightThreshold = null, targetCount = 0, tuning = null, distanceMetric = 'cie76') {
        const config = tuning || DEFAULT_TUNING;
        const pruneThreshold = threshold !== null ? threshold : config.prune.threshold;
        const highlightProtect = highlightThreshold !== null ? highlightThreshold : config.prune.whitePoint;
        const shadowProtect = config.prune.shadowPoint;
        const hueLock = config.prune.hueLockAngle;

        // Select distance function based on configured metric
        // CIE94/CIE2000 handle dark colors perceptually — no extra weighting needed.
        // CIE76 uses L-weighted variant for dark pairs (avgL < 40).
        const distFn = distanceMetric === 'cie2000' ? LabDistance.cie2000
            : distanceMetric === 'cie94' ? LabDistance.cie94
            : null; // CIE76 uses inline logic below

        let pruned = [...paletteLab];
        let iteration = 0;


        // HUE LOCK PROTECTION + SALIENCY-BASED PRUNING
        // Iterate through pairs, merging only when protection rules allow
        for (let i = 0; i < pruned.length; i++) {
            for (let j = i + 1; j < pruned.length; j++) {
                // STOP if we've reached target count
                if (targetCount > 0 && pruned.length <= targetCount) {
                    return pruned;
                }

                const p1 = pruned[i];
                const p2 = pruned[j];

                // Calculate distance using the configured metric
                let dist;
                if (distFn) {
                    dist = distFn(p1, p2);
                } else {
                    const avgL = (p1.L + p2.L) / 2;
                    dist = avgL < 40 ? this._weightedLabDistance(p1, p2) : this._labDistance(p1, p2);
                }

                if (dist < pruneThreshold) {
                    // Calculate chroma for both colors
                    const chroma1 = Math.sqrt(p1.a * p1.a + p1.b * p1.b);
                    const chroma2 = Math.sqrt(p2.a * p2.a + p2.b * p2.b);

                    // HUE LOCK: Calculate the angle difference in degrees
                    if (chroma1 > 5 && chroma2 > 5) { // Only for chromatic colors
                        const h1 = Math.atan2(p1.b, p1.a) * (180 / Math.PI);
                        const h2 = Math.atan2(p2.b, p2.a) * (180 / Math.PI);
                        let hueDiff = Math.abs(h1 - h2);
                        if (hueDiff > 180) hueDiff = 360 - hueDiff;

                        // PROTECTION: Use centralized hue lock threshold
                        if (hueDiff > hueLock) {
                            continue;
                        }
                    }

                    // HIGHLIGHT PROTECTION: Prevent merging bright highlights with darker colors
                    if ((p1.L > highlightProtect && p2.L <= highlightProtect) || (p1.L <= highlightProtect && p2.L > highlightProtect)) {
                        continue;
                    }

                    // MERGE: Keep the one with higher Saliency score
                    const s1 = (p1.L * 1.5) + (chroma1 * 2.5);
                    const s2 = (p2.L * 1.5) + (chroma2 * 2.5);

                    pruned[i] = s1 > s2 ? p1 : p2;
                    pruned.splice(j, 1);
                    j--; // Adjust index after removal
                    iteration++;

                }
            }
        }


        return pruned;
    }

    /**
     * Apply density floor — prune palette colors with < threshold coverage
     *
     * Prunes palette colors with < 0.5% coverage and reassigns pixels.
     * This treats targetColorCount as a HINT rather than a mandate.
     *
     * @private
     * @param {Uint8Array} assignments - Pixel-to-palette index mappings
     * @param {Array<{L, a, b}>} palette - Lab palette
     * @param {number} threshold - Minimum coverage threshold (default: 0.005 = 0.5%)
     * @param {Set<number>} protectedIndices - Indices that should never be removed (preserved colors, substrate)
     * @returns {Object} - {palette, assignments, actualCount}
     */
    static _applyDensityFloor(assignments, palette, threshold = 0.005, protectedIndices = new Set()) {
        // Input validation
        if (!assignments || !palette || palette.length === 0) {
            return { palette, assignments, actualCount: palette.length };
        }

        const totalPixels = assignments.length;
        const counts = new Array(palette.length).fill(0);

        // Count pixel occupancy for each palette color (skip transparent pixels = 255)
        for (let i = 0; i < totalPixels; i++) {
            const idx = assignments[i];

            // Skip transparent pixels (special value 255)
            if (idx === 255) {
                continue;
            }

            // Validate index bounds
            if (idx < 0 || idx >= palette.length) {
                continue;
            }

            counts[idx]++;
        }

        // Find indices of colors that meet the threshold (or are protected with actual pixels)
        const viableIndices = [];
        counts.forEach((count, i) => {
            const coverage = count / totalPixels;

            // Protected indices (preserved colors, substrate) are kept ONLY if they have pixels
            if (protectedIndices.has(i)) {
                if (count > 0) {
                    // Protected color with actual pixel assignments - keep it
                    viableIndices.push(i);
                } else {
                    // Protected color with 0% coverage - remove it (creates empty mask)
                }
                return;
            }

            // Non-protected colors must meet threshold
            if (coverage >= threshold) {
                viableIndices.push(i);
            } else {
            }
        });

        // If all colors are viable, return original data
        if (viableIndices.length === palette.length) {
            return { palette, assignments, actualCount: palette.length };
        }

        // Edge case: All colors pruned (shouldn't happen in practice)
        if (viableIndices.length === 0) {
            return { palette, assignments, actualCount: palette.length };
        }

        // Create the new, pruned palette
        const cleanPalette = viableIndices.map(idx => palette[idx]);
        const remappedAssignments = new Uint8Array(totalPixels);

        // Re-allocate pixels (preserve transparent pixels)
        for (let i = 0; i < totalPixels; i++) {
            const oldIdx = assignments[i];

            // Preserve transparent pixels (special value 255)
            if (oldIdx === 255) {
                remappedAssignments[i] = 255;
                continue;
            }

            // Validate index bounds
            if (oldIdx < 0 || oldIdx >= palette.length) {
                // Fallback: assign to first color in clean palette
                remappedAssignments[i] = 0;
                continue;
            }

            const newIdxInClean = viableIndices.indexOf(oldIdx);

            if (newIdxInClean !== -1) {
                // Pixel belongs to a survivor
                remappedAssignments[i] = newIdxInClean;
            } else {
                // Pixel belongs to a pruned color; find the nearest SURVIVING color
                const targetColor = palette[oldIdx];
                if (targetColor && cleanPalette.length > 0) {
                    remappedAssignments[i] = this._findNearestInPalette(targetColor, cleanPalette);
                } else {
                    // Fallback: assign to first color
                    remappedAssignments[i] = 0;
                }
            }
        }

        return {
            palette: cleanPalette,
            assignments: remappedAssignments,
            actualCount: cleanPalette.length
        };
    }

    /**
     * K-MEANS REFINEMENT — 1-pass centroid correction after median cut.
     *
     * Median cut splits along axis-aligned boundaries that can bisect natural
     * clusters (e.g. splitting yellow into bright/dark instead of yellow vs green).
     * One pass of k-means reassignment snaps centroids to actual cluster centers.
     *
     * Uses simple weighted mean (NOT SALIENCY) to avoid pulling centroids
     * toward outliers. Only affects median-cut colors — forced peaks and
     * preserved white/black are added later and are not touched.
     *
     * @private
     * @param {Float32Array|Uint16Array} labPixels - Lab pixel data (L,a,b triples)
     * @param {Array<{L,a,b}>} palette - Initial palette from median cut
     * @returns {Array<{L,a,b}>} Refined palette (new array, metadata preserved)
     */
    static _refineKMeans(labPixels, palette) {
        const GRID_STRIDE = 4; // Sample every 4th pixel for performance
        const pixelCount = labPixels.length / 3;

        if (!palette || palette.length <= 1 || pixelCount === 0) return palette;

        const numColors = palette.length;
        const currentPalette = palette.map(c => ({ L: c.L, a: c.a, b: c.b }));

        // Step 1: Reassign each sampled pixel to nearest centroid (CIE76 squared)
        const sumL = new Float64Array(numColors);
        const sumA = new Float64Array(numColors);
        const sumB = new Float64Array(numColors);
        const counts = new Uint32Array(numColors);

        for (let i = 0; i < pixelCount; i += GRID_STRIDE) {
            const idx = i * 3;
            const L = labPixels[idx];
            const a = labPixels[idx + 1];
            const b = labPixels[idx + 2];

            let bestIdx = 0;
            let bestDist = Infinity;

            for (let c = 0; c < numColors; c++) {
                const p = currentPalette[c];
                const dL = L - p.L;
                const da = a - p.a;
                const db = b - p.b;
                const dist = dL * dL + da * da + db * db;
                if (dist < bestDist) {
                    bestDist = dist;
                    bestIdx = c;
                }
            }

            sumL[bestIdx] += L;
            sumA[bestIdx] += a;
            sumB[bestIdx] += b;
            counts[bestIdx]++;
        }

        // Step 2: Recompute centroids using simple weighted mean
        for (let c = 0; c < numColors; c++) {
            if (counts[c] === 0) continue; // Keep previous centroid for empty clusters
            currentPalette[c] = {
                L: sumL[c] / counts[c],
                a: sumA[c] / counts[c],
                b: sumB[c] / counts[c]
            };
        }

        // Preserve metadata for downstream hue gap analysis
        if (palette._allColors) currentPalette._allColors = palette._allColors;
        if (palette._labPixels) currentPalette._labPixels = palette._labPixels;

        return currentPalette;
    }

    /**
     * Get adaptive snap threshold based on target colors and color space
     * @private
     * @param {number} baseThreshold - Base threshold from user (default 8.0)
     * @param {number} targetColors - Target number of colors
     * @param {boolean} isGrayscale - Whether image is grayscale
     * @param {number} lRange - L channel range (maxL - minL), used to calculate minimum spacing
     * @param {Object} colorSpaceExtent - For color mode: {lRange, aRange, bRange}
     * @returns {number} Adaptive threshold
     */
    static _getAdaptiveSnapThreshold(baseThreshold, targetColors, isGrayscale, lRange = 0, colorSpaceExtent = null) {
        // Grayscale images: Calculate threshold based on target color spacing
        // to avoid collapsing explicitly requested colors
        if (isGrayscale && lRange > 0) {
            // Target L spacing for requested color count
            const targetSpacing = lRange / Math.max(1, targetColors - 1);

            // Snap threshold must be LESS than half the target spacing
            // to avoid merging adjacent bands
            // With L_WEIGHT=3.0: deltaE = 1.73 * deltaL
            // So: threshold = 0.4 * targetSpacing * 1.73
            const threshold = 0.4 * targetSpacing * Math.sqrt(3.0);

            return threshold;
        } else if (isGrayscale) {
            // Fallback for grayscale without L range info
            return 2.0; // Per Architect: preserve all grayscale bands
        }

        // Color mode: Calculate threshold based on Lab space extent
        if (colorSpaceExtent) {
            // Estimate typical color spacing in 3D Lab space
            // Use diagonal of color space bounding box divided by target colors
            const labDiagonal = Math.sqrt(
                colorSpaceExtent.lRange * colorSpaceExtent.lRange * 1.5 + // L_WEIGHT=1.5 for color
                colorSpaceExtent.aRange * colorSpaceExtent.aRange +
                colorSpaceExtent.bRange * colorSpaceExtent.bRange
            );

            // Target spacing in 3D Lab space
            const targetSpacing = labDiagonal / Math.max(1, targetColors - 1);

            // Snap threshold: 40% of target spacing to avoid collapsing adjacent colors
            // BUT: Never exceed the user-specified base threshold (e.g., 8.0 ΔE)
            const adaptiveThreshold = 0.4 * targetSpacing;
            const threshold = Math.min(baseThreshold, adaptiveThreshold);

            return threshold;
        }

        // Fallback: Old adaptive thresholding based on target color count
        if (targetColors >= 9) {
            // High color count: User wants fidelity, reduce snap
            return Math.min(baseThreshold, 4.0);
        } else if (targetColors >= 6) {
            // Medium color count: Balanced approach
            return Math.min(baseThreshold, 6.0);
        } else {
            // Low color count: Aggressive reduction
            return baseThreshold; // Use default 8.0
        }
    }

    /**
     * Merge two Lab colors by keeping the one with higher saliency
     *
     * SALIENCY-BASED MERGE: When merging similar colors,
     * keep the one with the highest Saliency (L + Chroma weighted combination)
     * to maintain visual impact for both highlights and vibrant features.
     *
     * @private
     * @param {{L: number, a: number, b: number}} c1 - First color
     * @param {{L: number, a: number, b: number}} c2 - Second color
     * @returns {{L: number, a: number, b: number}} - Color with higher saliency
     */
    static _mergeLabColors(c1, c2) {
        // Calculate saliency scores for both colors
        const chroma1 = Math.sqrt(c1.a * c1.a + c1.b * c1.b);
        const chroma2 = Math.sqrt(c2.a * c2.a + c2.b * c2.b);

        // Saliency: (L × 1.5) + (Chroma × 2.5)
        // Favors both bright highlights and vibrant features
        const s1 = (c1.L * 1.5) + (chroma1 * 2.5);
        const s2 = (c2.L * 1.5) + (chroma2 * 2.5);

        // Keep the one with higher saliency
        return s1 > s2 ? c1 : c2;
    }

    /**
     * SALIENCY-BASED MERGE (Alias for _mergeLabColors)
     *
     * Keeps the color with higher saliency score when merging.
     * Used by pruning logic.
     *
     * @private
     * @param {{L: number, a: number, b: number}} c1 - First color
     * @param {{L: number, a: number, b: number}} c2 - Second color
     * @returns {{L: number, a: number, b: number}} - Color with higher saliency
     */
    static _mergeBySaliency(c1, c2) {
        return this._mergeLabColors(c1, c2);
    }

    /**
     * GET SALIENCY WINNER
     *
     * Picks the "punchiest" color between two merging candidates.
     * Uses balanced formula: (L × 1.2) + (chroma × 2.0)
     *
     * This is an alternative to _mergeLabColors with a more conservative
     * balance between lightness and chroma for pruning operations.
     *
     * @private
     * @param {{L: number, a: number, b: number}} c1 - First color
     * @param {{L: number, a: number, b: number}} c2 - Second color
     * @returns {{L: number, a: number, b: number}} - Color with higher saliency
     */
    static _getSaliencyWinner(c1, c2) {
        const s1 = (c1.L * 1.2) + (Math.sqrt(c1.a ** 2 + c1.b ** 2) * 2.0);
        const s2 = (c2.L * 1.2) + (Math.sqrt(c2.a ** 2 + c2.b ** 2) * 2.0);
        return s1 > s2 ? c1 : c2;
    }

    /**
     * SOURCE-PIXEL SNAPPING: Snap mathematical Lab average to nearest actual source pixel
     *
     * THE "MUDDY" FIX: Prevents washed-out desaturated mid-tones from dominating
     * by ensuring all palette colors are REAL pixels from the source image.
     *
     * When a bucket is too large/diverse, averaging creates muddy colors.
     * This finds the actual pixel closest to the average, prioritizing chroma.
     *
     * @private
     * @param {{L: number, a: number, b: number}} targetLab - Mathematical average color
     * @param {Array<{L: number, a: number, b: number}>} bucket - Array of source pixels
     * @returns {{L: number, a: number, b: number}} - Nearest actual source pixel
     */
    static _snapToSource(targetLab, bucket) {
        if (!bucket || bucket.length === 0) {
            return targetLab;
        }

        let minDistanceSq = Infinity;
        let bestPixel = targetLab;

        // Search the bucket for the pixel that most closely matches the average
        // Use perceptual L-scaling to preserve shadow detail
        for (const pixel of bucket) {
            const dL = targetLab.L - pixel.L;
            const da = targetLab.a - pixel.a;
            const db = targetLab.b - pixel.b;

            // Apply L-scaling for dark colors (preserves shadow texture)
            const avgL = (targetLab.L + pixel.L) / 2;
            const lWeight = avgL < 40 ? 2.0 : 1.0;
            const distSq = (dL * lWeight) ** 2 + (da * da) + (db * db);

            // If this pixel is closer to the target, use it
            // (Chroma prioritization happens implicitly because high-chroma pixels
            // cluster away from neutral grays, so they're naturally "closer" in Lab space
            // when the target average is also chromatic)
            if (distSq < minDistanceSq) {
                minDistanceSq = distSq;
                bestPixel = { L: pixel.L, a: pixel.a, b: pixel.b };
            }
        }

        return bestPixel;
    }

    /**
     * Helper to find the nearest color in a specific subset of the palette
     *
     * @private
     * @param {{L, a, b}} targetLab - Target Lab color
     * @param {Array<{L, a, b}>} subPalette - Subset of palette to search
     * @returns {number} - Index of nearest color in subPalette
     */
    static _findNearestInPalette(targetLab, subPalette) {
        // Input validation
        if (!targetLab || !subPalette || subPalette.length === 0) {
            return 0;  // Fallback to first color
        }

        let minDistance = Infinity;
        let closestIdx = 0;

        for (let i = 0; i < subPalette.length; i++) {
            const p = subPalette[i];
            if (!p) continue;  // Skip invalid entries

            // Standard Euclidean distance in Lab space
            const d = Math.sqrt(
                Math.pow(targetLab.L - p.L, 2) +
                Math.pow(targetLab.a - p.a, 2) +
                Math.pow(targetLab.b - p.b, 2)
            );
            if (d < minDistance) {
                minDistance = d;
                closestIdx = i;
            }
        }
        return closestIdx;
    }

    /**
     * Calculate perceptual distance (ΔE) between two Lab colors
     * @private
     * @param {{L: number, a: number, b: number}} lab1 - First Lab color
     * @param {{L: number, a: number, b: number}} lab2 - Second Lab color
     * @returns {number} - Perceptual distance (ΔE)
     */
    static _labDistance(lab1, lab2) {
        const dL = lab1.L - lab2.L;
        const da = lab1.a - lab2.a;
        const db = lab1.b - lab2.b;
        return Math.sqrt((dL * dL) + (da * da) + (db * db));
    }

    /**
     * PERCEPTUAL L-SCALING: Weighted Lab distance for shadow preservation
     *
     * The human eye is much more sensitive to lightness changes in dark areas
     * than in light areas. This prevents dark greens and shadows from being
     * washed out into a single flat black/dark-grey layer.
     *
     * @private
     * @param {{L: number, a: number, b: number}} lab1 - First Lab color
     * @param {{L: number, a: number, b: number}} lab2 - Second Lab color
     * @returns {number} - Weighted perceptual distance
     */
    static _weightedLabDistance(lab1, lab2) {
        const dL = lab1.L - lab2.L;
        const da = lab1.a - lab2.a;
        const db = lab1.b - lab2.b;

        // Increase the weight of L for darker colors to preserve shadow detail
        // When L < 40 (dark shadows), double the lightness weight
        // This makes the engine treat "dark green" and "black" as more distinct
        const avgL = (lab1.L + lab2.L) / 2;
        const lWeight = avgL < 40 ? 2.0 : 1.0;

        return Math.sqrt((dL * lWeight) ** 2 + da ** 2 + db ** 2);
    }
}

module.exports = PaletteOps;
