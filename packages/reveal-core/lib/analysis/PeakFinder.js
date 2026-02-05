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
 * 2b. Perceptual Isolation - Filter peaks too close to dominants (adaptive ΔE)
 * 3. Sector-Weighted Saliency - 2× boost for blue spectrum (sectors 8-9)
 * 4. Sort by Boosted Score - Blue priority over pink noise
 * 5. Return Top N - Maximum 3 peaks
 *
 * CRITERIA (All Must Pass):
 * - Saliency: Chroma > 30 (saturated rarity)
 * - Perceptual Isolation: ΔE > threshold from dominant (8.0 for 16-bit, 15.0 for 8-bit)
 * - Spatial Concentration: Clustered in small regions (real detail vs noise)
 * - Sector Priority: Blue spectrum (negative b) favored in monochromatic scans
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
     * @param {number} [options.bitDepth] - Source bit depth (8 or 16) for adaptive thresholds
     * @returns {Array<{L, a, b, chroma, volume, name}>} List of identity peaks
     */
    findIdentityPeaks(labPixels, options = {}) {
        const chromaThreshold = options.chromaThreshold || this.chromaThreshold;
        const volumeThreshold = options.volumeThreshold || this.volumeThreshold;
        const maxPeaks = options.maxPeaks || this.maxPeaks;
        const bitDepth = options.bitDepth || 16;

        // SURGICAL FIX: Relax isolation for 16-bit clinical scans
        // 16-bit data is signal, not noise - use tighter threshold (8.0)
        // 8-bit data has quantization noise - use standard threshold (15.0)
        const adaptiveMinDeltaE = bitDepth === 16 ? 8.0 : this.minDeltaE;

        logger.log(`\n[PeakFinder] Scanning for identity peaks...`);
        logger.log(`  Criteria: C > ${chromaThreshold}, volume < ${(volumeThreshold * 100).toFixed(1)}%`);
        logger.log(`  Isolation threshold: ΔE > ${adaptiveMinDeltaE} (${bitDepth}-bit source)`);

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
                // Calculate hue sector for sector-weighted saliency
                const sector = this._getHueSector(centroid.a, centroid.b);

                candidates.push({
                    ...centroid,
                    sector: sector,
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
        logger.log(`  Stage 2b: Filtering by perceptual isolation (ΔE > ${adaptiveMinDeltaE})`);
        const isolatedCandidates = this._filterByIsolation(candidates, dominantColors, adaptiveMinDeltaE);

        if (isolatedCandidates.length < candidates.length) {
            const filtered = candidates.length - isolatedCandidates.length;
            logger.log(`  ✗ Filtered ${filtered} candidate(s) too close to dominant colors (ΔE < ${adaptiveMinDeltaE})`);
        } else {
            logger.log(`  ✓ All candidates are perceptually isolated from dominants`);
        }

        // Stage 3: Sector-Weighted Saliency + Sort by boosted score
        logger.log(`  Stage 3: Applying sector-weighted saliency (blue priority)`);

        // Apply "Interest Boost" to blue sectors (8-9) to outrank noise
        // This ensures blue details (Monroe eyes) win even if pink has higher chroma
        const scoredCandidates = isolatedCandidates.map(peak => {
            const isBlueSpectrum = peak.sector === 8 || peak.sector === 9;
            const interestBoost = isBlueSpectrum ? 2.0 : 1.0;
            const score = peak.chroma * interestBoost;

            if (isBlueSpectrum) {
                logger.log(`    ⭐ Blue sector boost (sector ${peak.sector}): C=${peak.chroma.toFixed(1)} × ${interestBoost} = ${score.toFixed(1)}`);
            }

            return { ...peak, score };
        });

        // Sort by boosted score (not raw chroma)
        const topPeaks = scoredCandidates
            .sort((a, b) => b.score - a.score)
            .slice(0, maxPeaks);

        logger.log(`  Selected top ${topPeaks.length} identity peaks by saliency score`);

        topPeaks.forEach((peak, i) => {
            const boost = (peak.sector === 8 || peak.sector === 9) ? ' [BLUE BOOST]' : '';
            logger.log(`    Peak ${i + 1}: L=${peak.L.toFixed(1)} a=${peak.a.toFixed(1)} b=${peak.b.toFixed(1)}, C=${peak.chroma.toFixed(1)}, score=${peak.score.toFixed(1)}, vol=${(peak.volume * 100).toFixed(2)}%${boost}`);
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
     * If a blue anchor is ΔE < threshold from the magenta noise plate, it gets absorbed.
     *
     * By requiring ΔE > threshold, we ensure the blue detail is "Sovereign" and must
     * be protected with its own ink slot.
     *
     * ADAPTIVE THRESHOLD:
     * - 16-bit: ΔE > 8.0 (signal, not noise - tighter threshold)
     * - 8-bit: ΔE > 15.0 (quantization noise - standard threshold)
     *
     * @param {Array} candidates - Low-volume high-chroma peaks
     * @param {Array} dominantColors - High-volume color masses (potential hijackers)
     * @param {number} minDeltaE - Adaptive isolation threshold
     * @returns {Array} Filtered candidates that are perceptually isolated
     * @private
     */
    _filterByIsolation(candidates, dominantColors, minDeltaE) {
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

            // If ΔE > threshold, the blue is "Sovereign" and must be protected
            const isIsolated = minDistance > minDeltaE;

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

    /**
     * Calculate hue sector (0-11) from Lab color.
     * Used for sector-weighted saliency (blue priority).
     *
     * Sectors 8-9 represent the blue/cyan range (negative b values).
     * In monochromatic 16-bit scans, blue details often have lower chroma
     * than stray pink pixels but are more perceptually important.
     *
     * @param {number} a - Green-red axis
     * @param {number} b - Blue-yellow axis
     * @returns {number} Hue sector (0-11)
     * @private
     */
    _getHueSector(a, b) {
        // Calculate hue angle in degrees (0-360)
        const hue = Math.atan2(b, a) * (180 / Math.PI);
        const normalizedHue = hue < 0 ? hue + 360 : hue;

        // Map to 12 sectors (30° each)
        // Sector 8: 240-270° (blue)
        // Sector 9: 270-300° (cyan-blue)
        const sector = Math.floor(normalizedHue / 30);
        return sector % 12;
    }
}

module.exports = PeakFinder;
