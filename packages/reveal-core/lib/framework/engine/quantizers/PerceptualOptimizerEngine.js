/**
 * Perceptual Optimizer Engine
 * Implements a simplified k-means clustering algorithm for palette generation.
 * Based on the standard k-means algorithm, adapted for perceptual Lab space.
 * 
 * Note: This is a simplified version, not intended for production use
 * without further refinement and robustness checks.
 */

class PerceptualOptimizerEngine {
    /**
     * @param {Float32Array} pixels - Flat array of [L, a, b, ...]
     * @param {Object} config - Parameters object.
     * @param {number} config.targetColors - The desired number of colors in the palette.
     * @param {number} [config.maxIterations=100] - Maximum number of k-means iterations.
     * @param {Array<{L, a, b}>} [_seedPalette] - Optional initial palette to refine.
     * @returns {Array<{L, a, b}>} - The generated palette.
     */
    static quantize(pixels, config) {
        const targetColors = config.targetColors || 8;
        const maxIterations = config.maxIterations || 100;
        const seedPalette = config._seedPalette;

        if (!pixels || pixels.length === 0) {
            return [];
        }

        let centroids = [];
        if (seedPalette && seedPalette.length > 0) {
            centroids = seedPalette.map(c => ({ L: c.L, a: c.a, b: c.b }));
        } else {
            // Initialize centroids randomly from pixel data
            centroids = this._initializeCentroids(pixels, targetColors);
        }

        let assignments = new Uint8Array(pixels.length / 3);
        let oldAssignments = null;
        let iterations = 0;

        while (iterations < maxIterations) {
            // Assign pixels to nearest centroid
            assignments = this._assignPixelsToCentroids(pixels, centroids);

            // Check for convergence (no change in assignments)
            if (oldAssignments && assignments.every((val, index) => val === oldAssignments[index])) {
                break; 
            }
            oldAssignments = assignments;

            // Recalculate centroids
            centroids = this._recalculateCentroids(pixels, assignments, targetColors);
            iterations++;
        }

        return centroids;
    }

    /**
     * Initializes centroids by picking random points from the pixel data.
     * @param {Float32Array} pixels
     * @param {number} numCentroids
     * @returns {Array<{L, a, b}>} Initial centroids
     */
    static _initializeCentroids(pixels, numCentroids) {
        const centroids = [];
        const numPixels = pixels.length / 3;
        const indices = new Set();

        while (indices.size < numCentroids && indices.size < numPixels) {
            indices.add(Math.floor(Math.random() * numPixels));
        }

        for (const index of indices) {
            const offset = index * 3;
            centroids.push({
                L: pixels[offset],
                a: pixels[offset + 1],
                b: pixels[offset + 2]
            });
        }
        return centroids;
    }

    /**
     * Assigns each pixel to the nearest centroid.
     * @param {Float32Array} pixels
     * @param {Array<{L, a, b}>} centroids
     * @returns {Uint8Array} Array of centroid indices for each pixel.
     */
    static _assignPixelsToCentroids(pixels, centroids) {
        const assignments = new Uint8Array(pixels.length / 3);
        for (let i = 0; i < pixels.length; i += 3) {
            const L = pixels[i], a = pixels[i + 1], b = pixels[i + 2];
            let minDistSq = Infinity;
            let nearestCentroidIndex = 0;

            for (let j = 0; j < centroids.length; j++) {
                const c = centroids[j];
                const dL = L - c.L;
                const da = a - c.a;
                const db = b - c.b;
                const distSq = dL * dL + da * da + db * db;

                if (distSq < minDistSq) {
                    minDistSq = distSq;
                    nearestCentroidIndex = j;
                }
            }
            assignments[i / 3] = nearestCentroidIndex;
        }
        return assignments;
    }

    /**
     * Recalculates centroids based on current pixel assignments.
     * @param {Float32Array} pixels
     * @param {Uint8Array} assignments
     * @param {number} numCentroids
     * @returns {Array<{L, a, b}>} New centroids
     */
    static _recalculateCentroids(pixels, assignments, numCentroids) {
        const sums = Array.from({ length: numCentroids }, () => ({ L: 0, a: 0, b: 0, count: 0 }));

        for (let i = 0; i < assignments.length; i++) {
            const centroidIndex = assignments[i];
            const offset = i * 3;
            const L = pixels[offset], a = pixels[offset + 1], b = pixels[offset + 2];

            sums[centroidIndex].L += L;
            sums[centroidIndex].a += a;
            sums[centroidIndex].b += b;
            sums[centroidIndex].count++;
        }

        const centroids = [];
        for (let i = 0; i < numCentroids; i++) {
            if (sums[i].count > 0) {
                centroids.push({
                    L: sums[i].L / sums[i].count,
                    a: sums[i].a / sums[i].count,
                    b: sums[i].b / sums[i].count
                });
            } else {
                // Handle empty clusters - reinitialize centroid randomly?
                // For simplicity, let's just use a default or skip.
                // Using a default might be better to maintain count.
                centroids.push({ L: 50, a: 0, b: 0 }); // Default Lab neutral
            }
        }
        return centroids;
    }
}

module.exports = PerceptualOptimizerEngine;
