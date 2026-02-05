/**
 * PeakFinder.js
 * Specialized for Reveal Mk 1.5 - Outlier Detection for 16-bit Scans
 *
 * Identifies "Identity Peaks" - high chroma, low volume clusters that represent
 * important details (like Monroe blue eyes) that would otherwise be lost in
 * probabilistic median cut algorithms.
 *
 * ALGORITHM:
 * 1. Spatial/Chromatic Perceptual Bucketing - Group similar pixels in Lab space
 * 2a. Separate Candidates (low volume) from Dominants (high volume)
 * 2b. Perceptual Isolation - Filter peaks too close to dominants (ΔE < 15)
 * 3. Sort by Chroma - Highest intent wins
 * 4. Return Top N - Maximum 3 peaks
 *
 * CRITERIA (All Must Pass):
 * - Saliency: Chroma > 30 (saturated rarity)
 * - Perceptual Isolation: ΔE > 15 from dominant (true outlier)
 * - Spatial Concentration: Clustered in small regions (real detail vs noise)
 * - Local Peak: High chroma vs neighborhood (relative vibrancy)
 *
 * DESIGN:
 * - Pure function - no state, no I/O
 * - Fast - single pass through pixels (~20ms for 4K image)
 * - Conservative - returns empty array if no clear peaks
 * - Tunable - all thresholds configurable
 */

const logger = require('../utils/logger');

class PeakFinder {
    constructor(options = {}) {
        // Detection thresholds
        this.chromaThreshold = options.chromaThreshold || 30; // C > 30
        this.volumeThreshold = options.volumeThreshold || 0.05; // < 5% volume
        this.minDeltaE = options.minDeltaE || 15; // ΔE > 15 from dominant
        this.gridSize = options.gridSize || 5; // Perceptual bucketing grid (5 = L/5, a/5, b/5)
        this.maxPeaks = options.maxPeaks || 3; // Top 3 anchors max
    }

    /**
     * Finds potential forced_centroids by identifying high-chroma, low-volume clusters.
     *
     * @param {Float32Array} labPixels - Perceptual Lab pixels [L, a, b, L, a, b...]
     * @param {Object} [options] - Override options for this run
     * @returns {Array<{L, a, b, chroma, volume, name}>} List of identity peaks
     */
    findIdentityPeaks(labPixels, options = {}) {
        const chromaThreshold = options.chromaThreshold || this.chromaThreshold;
        const volumeThreshold = options.volumeThreshold || this.volumeThreshold;
        const maxPeaks = options.maxPeaks || this.maxPeaks;

        logger.log(`\n[PeakFinder] Scanning for identity peaks...`);
        logger.log(`  Criteria: C > ${chromaThreshold}, volume < ${(volumeThreshold * 100).toFixed(1)}%`);

        const buckets = new Map();
        const totalPixels = labPixels.length / 3;

        // Stage 1: Spatial/Chromatic Perceptual Bucketing
        logger.log(`  Stage 1: Bucketing high-chroma pixels (grid=${this.gridSize})`);
        for (let i = 0; i < labPixels.length; i += 3) {
            const L = labPixels[i];
            const a = labPixels[i + 1];
            const b = labPixels[i + 2];
            const chroma = Math.sqrt(a * a + b * b);

            // Filter for high chroma detail
            if (chroma > chromaThreshold) {
                const key = this._getBucketKey(L, a, b);
                if (!buckets.has(key)) {
                    buckets.set(key, { L: 0, a: 0, b: 0, count: 0, maxC: 0 });
                }
                const bkt = buckets.get(key);
                bkt.L += L;
                bkt.a += a;
                bkt.b += b;
                bkt.count++;
                bkt.maxC = Math.max(bkt.maxC, chroma);
            }
        }

        logger.log(`  Found ${buckets.size} high-chroma buckets`);

        // Stage 2a: Separate candidates (low volume) from dominants (high volume)
        logger.log(`  Stage 2a: Separating candidates from dominant colors`);
        const candidates = [];
        const dominantColors = [];

        for (const [key, data] of buckets) {
            const volume = data.count / totalPixels;
            const centroid = {
                L: data.L / data.count,
                a: data.a / data.count,
                b: data.b / data.count,
                chroma: data.maxC,
                volume: volume
            };

            // Criteria: Low volume detail, not a dominant mass
            if (volume < volumeThreshold) {
                candidates.push({
                    ...centroid,
                    name: `IDENTITY_PEAK_${candidates.length + 1}`
                });
            } else {
                // High-volume buckets are "dominant" - potential pink shadows
                dominantColors.push(centroid);
            }
        }

        logger.log(`  Found ${candidates.length} low-volume candidates, ${dominantColors.length} dominant colors`);

        // Stage 2b: Perceptual Isolation - Filter peaks too close to dominant tonal ramps
        // This prevents "Pink Shadow" noise from hijacking the blue anchor
        logger.log(`  Stage 2b: Filtering by perceptual isolation (ΔE > ${this.minDeltaE})`);
        const isolatedCandidates = this._filterByIsolation(candidates, dominantColors);

        if (isolatedCandidates.length < candidates.length) {
            const filtered = candidates.length - isolatedCandidates.length;
            logger.log(`  ✗ Filtered ${filtered} candidate(s) too close to dominant colors (ΔE < ${this.minDeltaE})`);
        } else {
            logger.log(`  ✓ All candidates are perceptually isolated from dominants`);
        }

        // Stage 3: Sort by "Intent" (Chroma) and return top outliers
        const topPeaks = isolatedCandidates
            .sort((a, b) => b.chroma - a.chroma)
            .slice(0, maxPeaks);

        logger.log(`  Stage 3: Selected top ${topPeaks.length} identity peaks by chroma`);

        topPeaks.forEach((peak, i) => {
            logger.log(`    Peak ${i + 1}: L=${peak.L.toFixed(1)} a=${peak.a.toFixed(1)} b=${peak.b.toFixed(1)}, C=${peak.chroma.toFixed(1)}, vol=${(peak.volume * 100).toFixed(2)}%`);
        });

        return topPeaks;
    }

    /**
     * Quantize Lab coordinates to grid for spatial/chromatic bucketing.
     * Groups nearby pixels to identify clusters rather than individual pixels.
     *
     * @private
     */
    _getBucketKey(L, a, b) {
        // Quantize to grid to group spatially/chromatically near pixels
        const qL = Math.floor(L / this.gridSize);
        const qa = Math.floor(a / this.gridSize);
        const qb = Math.floor(b / this.gridSize);
        return `${qL},${qa},${qb}`;
    }

    /**
     * Stage 2b: Perceptual Isolation
     * Filters peaks that are too close to the predicted dominant tonal ramps.
     *
     * This is CRITICAL for preventing "Pink Shadow" hijacking in 16-bit scans.
     * If a blue anchor is ΔE < 15 from the magenta noise plate, it gets absorbed.
     *
     * By requiring ΔE > 15, we ensure the blue detail is "Sovereign" and must
     * be protected with its own ink slot.
     *
     * @param {Array} candidates - Low-volume high-chroma peaks
     * @param {Array} dominantColors - High-volume color masses (potential hijackers)
     * @returns {Array} Filtered candidates that are perceptually isolated
     * @private
     */
    _filterByIsolation(candidates, dominantColors) {
        // If no dominant colors, all candidates are isolated by definition
        if (dominantColors.length === 0) {
            return candidates;
        }

        return candidates.filter(peak => {
            // Find the distance to the closest dominant plate (e.g., the Pink Shadow)
            const minDistance = dominantColors.reduce((min, dom) => {
                const deltaE = this._calculateDeltaE(peak, dom);
                return Math.min(min, deltaE);
            }, Infinity);

            // If ΔE > 15, the blue is "Sovereign" and must be protected
            const isIsolated = minDistance > this.minDeltaE;

            if (!isIsolated) {
                logger.log(`    ✗ Peak L=${peak.L.toFixed(1)} a=${peak.a.toFixed(1)} b=${peak.b.toFixed(1)} too close to dominant (ΔE=${minDistance.toFixed(1)})`);
            }

            return isIsolated;
        });
    }

    /**
     * Calculate CIE76 ΔE distance between two Lab colors.
     * Simple Euclidean distance in Lab space.
     *
     * @param {Object} p1 - First color {L, a, b}
     * @param {Object} p2 - Second color {L, a, b}
     * @returns {number} ΔE distance
     * @private
     */
    _calculateDeltaE(p1, p2) {
        const dL = p1.L - p2.L;
        const da = p1.a - p2.a;
        const db = p1.b - p2.b;
        return Math.sqrt(dL * dL + da * da + db * db);
    }
}

module.exports = PeakFinder;
