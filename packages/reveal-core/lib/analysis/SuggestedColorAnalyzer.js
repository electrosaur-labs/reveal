/**
 * SuggestedColorAnalyzer — K-Means clustering to find image colors
 * missing from the palette.
 *
 * Approach (from the Architect):
 *   1. K-Means clustering in Lab space to find the image's natural
 *      "centers of gravity" — the actual dominant color populations.
 *   2. Filter out any center within ΔE of the active palette.
 *   3. Return the survivors as suggestions.
 *
 * K-Means finds cluster centers that represent real color populations,
 * not grid-bucket centroids that can split natural clusters across
 * boundaries. With k=16, we get enough candidates to capture both
 * dominant and secondary color themes.
 *
 * Adapted for reveal-core: operates on 16-bit Lab proxy buffer,
 * clusters in perceptual Lab (not RGB), deterministic initialization
 * via k-means++ with seeded PRNG.
 *
 * Pure static module (zero deps, fits reveal-core constraint).
 *
 * @module SuggestedColorAnalyzer
 */

// ─── Constants ────────────────────────────────────────────────

const MAX_SUGGESTIONS = 6;
const PALETTE_EXCLUSION_DE = 10;   // Min CIE76 ΔE from any palette entry
const DEDUP_THRESHOLD = 12;        // Merge candidates within 12 ΔE
const K_CLUSTERS = 16;             // Number of K-Means clusters to find
const K_ITERATIONS = 10;           // K-Means iteration count
const SAMPLE_COUNT = 2000;         // Pixels to sample for K-Means
const MIN_CHROMA = 15;             // Skip near-neutral suggestions
const CAPPED_DIST = 20;            // Cap palette distance contribution at 20 ΔE
const SUBSTRATE_L_HIGH = 92;       // Skip pixels above this L (white substrate)
const SUBSTRATE_L_LOW = 8;         // Skip pixels below this L (black substrate)
const SUBSTRATE_THRESHOLD = 0.30;  // Fraction of pixels to trigger substrate detection

// 16-bit engine encoding constants
const L_SCALE = 327.68;            // L: 0-32768 → 0-100
const AB_NEUTRAL = 16384;          // a/b neutral in 16-bit
const AB_SCALE = 128;              // a/b: offset/128 → perceptual

class SuggestedColorAnalyzer {

    /**
     * Analyze the proxy image via K-Means clustering and return up to 6
     * suggested colors that are important in the image but absent from
     * the palette.
     *
     * @param {Uint16Array} proxyLabBuffer - 16-bit Lab pixel buffer (L,a,b triples)
     * @param {number} width - Proxy width
     * @param {number} height - Proxy height
     * @param {Array<{L,a,b}>} currentPalette - Current palette in perceptual Lab
     * @param {Object} [options] - Optional overrides
     * @param {number} [options.paletteExclusionDE=10] - Min ΔE from palette
     * @param {number} [options.maxSuggestions=6] - Max suggestions to return
     * @param {number} [options.clusterCount=16] - K-Means cluster count
     * @param {string} [options.substrateMode='auto'] - Substrate handling: 'auto'|'white'|'black'|'dark'|'none'
     * @returns {Array<{L, a, b, source, reason, score}>} Sorted by score descending
     */
    static analyze(proxyLabBuffer, width, height, currentPalette, options = {}) {
        if (!proxyLabBuffer || !currentPalette || currentPalette.length === 0) return [];
        if (width < 2 || height < 2) return [];

        const paletteExclDE = options.paletteExclusionDE || PALETTE_EXCLUSION_DE;
        const maxSuggestions = options.maxSuggestions || MAX_SUGGESTIONS;
        const k = options.clusterCount || K_CLUSTERS;
        const substrateMode = options.substrateMode || 'auto';

        const pixelCount = width * height;

        // ─── Phase A: Sample pixels → perceptual Lab ─────────
        const samples = this._samplePixels(proxyLabBuffer, pixelCount, SAMPLE_COUNT, substrateMode);
        if (samples.length === 0) return [];

        // ─── Phase B: K-Means clustering in Lab space ────────
        const clusters = this._kMeansLab(samples, k, K_ITERATIONS);

        // ─── Phase C: Filter against palette ─────────────────
        const candidates = [];
        const maxPop = Math.max(...clusters.map(c => c.count));

        for (const cluster of clusters) {
            if (cluster.count === 0) continue;

            const center = cluster.center;

            // Palette exclusion
            const paletteDist = this._minDistToPalette(center, currentPalette);
            if (paletteDist < paletteExclDE) continue;

            // Chroma filter: skip near-neutrals
            const chroma = Math.sqrt(center.a * center.a + center.b * center.b);
            if (chroma < MIN_CHROMA) continue;

            // Score: population-first with capped palette distance nudge
            // Population × chroma = "how important is this color in the image"
            // Capped palette distance = small bonus for novelty, doesn't dominate
            const population = cluster.count / maxPop;  // 0-1 normalized
            const cappedDist = Math.min(paletteDist, CAPPED_DIST);
            const score = population * chroma * 0.7 + cappedDist * 0.3;

            const pct = ((cluster.count / samples.length) * 100).toFixed(1);

            candidates.push({
                L: center.L,
                a: center.a,
                b: center.b,
                source: 'suggested',
                reason: `ΔE ${paletteDist.toFixed(0)} from palette, ${pct}% of image, C=${chroma.toFixed(0)}`,
                score
            });
        }

        // ─── Phase D: Dedup + sort + cap ──────────────────────
        const deduped = this._dedup(candidates, DEDUP_THRESHOLD);
        deduped.sort((a, b) => b.score - a.score);
        return deduped.slice(0, maxSuggestions);
    }

    // ─── Pixel Sampling ──────────────────────────────────────

    /**
     * Evenly sample N pixels from the 16-bit Lab buffer,
     * converting to perceptual Lab {L, a, b}.
     * Detects and skips substrate pixels based on substrateMode:
     *   'auto'  — auto-detect via L-threshold + 30% population trigger
     *   'white' — always skip L > 92 (forced white substrate)
     *   'black'/'dark' — always skip L < 8 (forced dark substrate)
     *   'none'  — no substrate skip (all pixels sampled)
     * @private
     */
    static _samplePixels(labBuffer, pixelCount, sampleCount, substrateMode = 'auto') {
        const step = Math.max(1, Math.floor(pixelCount / sampleCount));

        // Determine which L extremes to skip based on substrate mode
        let skipHigh = false;
        let skipLow = false;

        if (substrateMode === 'none') {
            // Archetype explicitly disables substrate — sample everything
        } else if (substrateMode === 'white') {
            // Forced white substrate — always skip high-L pixels
            skipHigh = true;
        } else if (substrateMode === 'black' || substrateMode === 'dark') {
            // Forced dark substrate — always skip low-L pixels
            skipLow = true;
        } else {
            // 'auto' — detect substrate via population threshold
            let highCount = 0, lowCount = 0, scanCount = 0;
            const scanStep = Math.max(1, Math.floor(pixelCount / 5000));
            for (let i = 0; i < pixelCount; i += scanStep) {
                const L = labBuffer[i * 3] / L_SCALE;
                if (L > SUBSTRATE_L_HIGH) highCount++;
                if (L < SUBSTRATE_L_LOW) lowCount++;
                scanCount++;
            }
            skipHigh = (highCount / scanCount) > SUBSTRATE_THRESHOLD;
            skipLow = (lowCount / scanCount) > SUBSTRATE_THRESHOLD;
        }

        // Sample, skipping substrate
        const samples = [];
        for (let i = 0; i < pixelCount; i += step) {
            const off = i * 3;
            const L = labBuffer[off] / L_SCALE;
            if (skipHigh && L > SUBSTRATE_L_HIGH) continue;
            if (skipLow && L < SUBSTRATE_L_LOW) continue;
            samples.push({
                L,
                a: (labBuffer[off + 1] - AB_NEUTRAL) / AB_SCALE,
                b: (labBuffer[off + 2] - AB_NEUTRAL) / AB_SCALE
            });
        }

        return samples;
    }

    // ─── K-Means Clustering ──────────────────────────────────

    /**
     * K-Means clustering in perceptual Lab space.
     * Uses k-means++ initialization with a seeded PRNG for reproducibility.
     *
     * @param {Array<{L,a,b}>} samples - Sampled pixels in perceptual Lab
     * @param {number} k - Number of clusters
     * @param {number} iterations - Number of refinement iterations
     * @returns {Array<{center: {L,a,b}, count: number}>} Cluster centers with population
     * @private
     */
    static _kMeansLab(samples, k, iterations) {
        const n = samples.length;
        if (n === 0) return [];
        if (n <= k) {
            return samples.map(s => ({ center: { ...s }, count: 1 }));
        }

        // k-means++ initialization (deterministic via seeded PRNG)
        let seed = 42;
        const rand = () => { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; };

        const centers = [];

        // First center: pick deterministically based on seed
        const firstIdx = Math.floor(rand() * n);
        centers.push({ L: samples[firstIdx].L, a: samples[firstIdx].a, b: samples[firstIdx].b });

        // Remaining centers: k-means++ — probability proportional to distance²
        for (let c = 1; c < k; c++) {
            const dists = new Float64Array(n);
            let totalDist = 0;

            for (let i = 0; i < n; i++) {
                let minD = Infinity;
                for (const ct of centers) {
                    const dL = samples[i].L - ct.L;
                    const da = samples[i].a - ct.a;
                    const db = samples[i].b - ct.b;
                    const d = dL * dL + da * da + db * db;
                    if (d < minD) minD = d;
                }
                dists[i] = minD;
                totalDist += minD;
            }

            // Weighted random selection
            let target = rand() * totalDist;
            let chosen = 0;
            for (let i = 0; i < n; i++) {
                target -= dists[i];
                if (target <= 0) { chosen = i; break; }
            }

            centers.push({ L: samples[chosen].L, a: samples[chosen].a, b: samples[chosen].b });
        }

        // ─── K-Means iterations ──────────────────────────────
        const assignments = new Uint16Array(n);

        for (let iter = 0; iter < iterations; iter++) {
            // Assign each sample to nearest center
            for (let i = 0; i < n; i++) {
                let minDist = Infinity;
                let minIdx = 0;
                for (let j = 0; j < k; j++) {
                    const dL = samples[i].L - centers[j].L;
                    const da = samples[i].a - centers[j].a;
                    const db = samples[i].b - centers[j].b;
                    const d = dL * dL + da * da + db * db;
                    if (d < minDist) { minDist = d; minIdx = j; }
                }
                assignments[i] = minIdx;
            }

            // Recompute centers
            const sums = new Array(k);
            for (let j = 0; j < k; j++) sums[j] = { L: 0, a: 0, b: 0, count: 0 };

            for (let i = 0; i < n; i++) {
                const j = assignments[i];
                sums[j].L += samples[i].L;
                sums[j].a += samples[i].a;
                sums[j].b += samples[i].b;
                sums[j].count++;
            }

            for (let j = 0; j < k; j++) {
                if (sums[j].count > 0) {
                    centers[j].L = sums[j].L / sums[j].count;
                    centers[j].a = sums[j].a / sums[j].count;
                    centers[j].b = sums[j].b / sums[j].count;
                }
            }
        }

        // Final assignment to get population counts
        const counts = new Uint32Array(k);
        for (let i = 0; i < n; i++) {
            let minDist = Infinity;
            let minIdx = 0;
            for (let j = 0; j < k; j++) {
                const dL = samples[i].L - centers[j].L;
                const da = samples[i].a - centers[j].a;
                const db = samples[i].b - centers[j].b;
                const d = dL * dL + da * da + db * db;
                if (d < minDist) { minDist = d; minIdx = j; }
            }
            counts[minIdx]++;
        }

        return centers.map((c, i) => ({
            center: { L: c.L, a: c.a, b: c.b },
            count: counts[i]
        }));
    }

    // ─── Dedup ────────────────────────────────────────────────

    /**
     * Merge candidates within dedupThreshold ΔE, keeping highest score.
     * @private
     */
    static _dedup(candidates, dedupThreshold) {
        if (candidates.length <= 1) return candidates;

        const sorted = [...candidates].sort((a, b) => b.score - a.score);
        const kept = [];
        const dedupSq = dedupThreshold * dedupThreshold;

        for (const c of sorted) {
            const tooClose = kept.some(k => {
                const dL = c.L - k.L;
                const da = c.a - k.a;
                const db = c.b - k.b;
                return (dL * dL + da * da + db * db) < dedupSq;
            });
            if (!tooClose) kept.push(c);
        }

        return kept;
    }

    // ─── Helpers ──────────────────────────────────────────────

    /** CIE76 ΔE between two perceptual Lab colors */
    static _deltaE(lab1, lab2) {
        const dL = lab1.L - lab2.L;
        const da = lab1.a - lab2.a;
        const db = lab1.b - lab2.b;
        return Math.sqrt(dL * dL + da * da + db * db);
    }

    /** Minimum ΔE from a Lab color to any palette entry */
    static _minDistToPalette(lab, palette) {
        let minDist = Infinity;
        for (const pal of palette) {
            const dist = this._deltaE(lab, pal);
            if (dist < minDist) minDist = dist;
        }
        return minDist;
    }
}

module.exports = SuggestedColorAnalyzer;
