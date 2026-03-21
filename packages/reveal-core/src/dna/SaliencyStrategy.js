/**
 * @file SaliencyStrategy.js
 *
 * Canonical SALIENCY centroid algorithm — shared implementation for all
 * platforms (JS, Python, C). Designed for cross-platform determinism.
 *
 * Key design decisions:
 *
 * 1. PRECISION NORMALIZATION (toFixed(4)) — eliminates Float32 vs float64
 *    divergence. JS stores decoded Lab pixels in Float32Array; Python uses
 *    float64. After rounding to 4dp both environments agree on every value,
 *    ensuring identical deduplication keys and sorting order.
 *
 * 2. PURE SCORING — scores each unique color entry independently. Does not
 *    weight by pixel count (count is used only for the achromatic fallback).
 *
 * 3. TOP-5% SLICE — averages the top max(1, min(50, n*0.05)) colors by
 *    saliency score. Captures the perceptual soul of the region without
 *    being swamped by majority mid-tones.
 *
 * 4. CONDITIONAL a-BOOST — in aggressive vibrancy mode, a* values in the
 *    pink zone (0 < a < 50) are multiplied 1.6× during averaging to rescue
 *    reds from pink dilution. This is NOT applied in other vibrancy modes.
 */

/**
 * Round a Lab pixel's channels to a fixed number of decimal places.
 * Call this before deduplication and sorting to ensure deterministic
 * behavior across floating-point environments.
 *
 * @param {{L: number, a: number, b: number}} pixel
 * @param {number} [precision=4]
 * @returns {{L: number, a: number, b: number}}
 */
export const normalizePixelPrecision = (pixel, precision = 4) => ({
    L: parseFloat(pixel.L.toFixed(precision)),
    a: parseFloat(pixel.a.toFixed(precision)),
    b: parseFloat(pixel.b.toFixed(precision)),
});

/**
 * Canonical SALIENCY centroid.
 *
 * @param {Array<{L: number, a: number, b: number, count?: number}>} bucket
 *   Deduplicated color entries (one per unique Lab triplet, with count).
 * @param {object} [weights]
 *   Centroid weights from the archetype tuning:
 *     lWeight       {number}  Lightness priority  (default 1.0)
 *     cWeight       {number}  Chroma priority     (default 1.0)
 *     blackBias     {number}  Dark-pixel boost    (default 5.0)
 *     vibrancyMode  {string}  'aggressive'|'moderate'|'linear'|'exponential'
 *     vibrancyBoost {number}  Exponent for exponential mode (default 2.2)
 *     bitDepth      {number}  8 or 16 (affects neutrality gate + brown-dampener)
 *     isVibrant     {boolean} Use 2% slice instead of 5%
 * @returns {{L: number, a: number, b: number}}
 */
export function calculateSaliencyCentroid(bucket, weights = {}) {
    if (!bucket || bucket.length === 0) return { L: 50, a: 0, b: 0 };

    const {
        lWeight       = 1.0,
        cWeight       = 1.0,
        blackBias     = 5.0,
        vibrancyMode  = 'aggressive',
        vibrancyBoost = 2.2,
        bitDepth,
        isVibrant,
    } = weights;

    const is16Bit = bitDepth === 16;

    // ── Step 1: Normalize precision ──────────────────────────────────────────
    // Eliminates Float32 (JS) vs float64 (Python) divergence so every
    // downstream sort and comparison is deterministic across platforms.
    const normalized = bucket.map(p => ({
        ...normalizePixelPrecision(p),
        count: p.count || 1,
    }));

    // ── Step 2: Achromatic exclusion ─────────────────────────────────────────
    // When cWeight ≥ 2.5 (precision color work), filter out near-neutral
    // pixels so halftone grays can't compete with chromatic regions.
    const achromaticFloor = cWeight >= 2.5 ? 15.0 : 0.0;
    const eligible = achromaticFloor > 0
        ? normalized.filter(p => Math.sqrt(p.a * p.a + p.b * p.b) >= achromaticFloor)
        : normalized;

    // Fallback: volumetric average if all pixels are achromatic
    if (eligible.length === 0) {
        let sumL = 0, sumA = 0, sumB = 0, totalW = 0;
        for (const p of normalized) {
            const w = p.count;
            sumL += p.L * w; sumA += p.a * w; sumB += p.b * w; totalW += w;
        }
        return { L: sumL / totalW, a: sumA / totalW, b: sumB / totalW };
    }

    // ── Step 3: Score each color ─────────────────────────────────────────────
    const getHueSector = (a, b) => Math.floor(((Math.atan2(b, a) * 180 / Math.PI) + 360) % 360 / 30);

    const scored = eligible.map(p => {
        const chroma = Math.sqrt(p.a * p.a + p.b * p.b);
        const sector = getHueSector(p.a, p.b);

        // Exponential vibrancy: compress chroma range to rescue low-chroma colors
        const chromaValue = (vibrancyMode === 'exponential' && chroma > 0)
            ? Math.pow(chroma, 1 / vibrancyBoost)
            : chroma;

        // Brown-dampener: penalize low-chroma warm pixels on 8-bit sources
        // (8-bit quantization noise drifts neutral grays into orange/brown)
        const chromaWeight = (!is16Bit && chroma < 8 && (sector === 0 || sector === 1))
            ? cWeight * 0.5
            : cWeight;

        // Black protection: massive boost for very dark pixels
        const blackBoost = p.L < 10 ? (10 - p.L) * blackBias : 0;

        return { p, score: p.L * lWeight + chromaValue * chromaWeight + blackBoost };
    }).sort((a, b) => b.score - a.score);

    // ── Step 4: Sample top 5% (max 50) ───────────────────────────────────────
    const slicePct = isVibrant ? 0.02 : 0.05;
    const sampleSize = Math.max(1, Math.min(50, Math.floor(scored.length * slicePct)));
    const topSlice = scored.slice(0, sampleSize);

    // ── Step 5: Average with optional aggressive a-boost ─────────────────────
    // In aggressive mode: multiply a* by 1.6 for pink-zone values (0 < a < 50)
    // to rescue reds that are diluted by neighbouring pink pixels.
    const isAggressive = vibrancyMode === 'aggressive';
    let sumL = 0, sumA = 0, sumB = 0;

    for (const { p } of topSlice) {
        sumL += p.L;
        const rawA = p.a;
        sumA += (isAggressive && rawA > 0 && rawA < 50) ? rawA * 1.6 : rawA;
        sumB += p.b;
    }

    const result = {
        L: sumL / sampleSize,
        a: sumA / sampleSize,
        b: sumB / sampleSize,
    };

    // ── Step 6: Neutrality gate ───────────────────────────────────────────────
    // 8-bit: snap very-low-chroma centroids to perfect neutral (catches grays
    // with slight warm drift from 8-bit quantization noise).
    // 16-bit: threshold is 0.0 — 16-bit data is SIGNAL, not noise.
    const neutralityThr = is16Bit ? 0.0 : 5.0;
    if (Math.sqrt(result.a * result.a + result.b * result.b) < neutralityThr) {
        result.a = 0;
        result.b = 0;
    }

    return result;
}
