/**
 * PaletteDistiller — Over-quantize then reduce via furthest-point sampling
 *
 * Problem with direct K-color quantization on warm images:
 *   Median cut always splits on the highest-variance axis. For warm images
 *   (horses, portraits, autumn scenes), L* variance dominates — so requesting
 *   6 colors produces 6 shades of brown instead of separating orange from
 *   gold from olive. No archetype parameter fixes this; it is a property of
 *   the algorithm.
 *
 * Solution:
 *   1. Over-quantize to 3× the target (capped at 20).
 *      With 18–20 buckets the median cut exhausts the major L* splits and is
 *      forced into a-axis/b-axis hue splits. Golden yellow (H=88°) and orange
 *      (H=65°) become distinct buckets instead of being averaged together.
 *
 *   2. Distill back to K using coverage-seeded furthest-point sampling
 *      (greedy k-centers / maximin):
 *        - Seed with the highest-coverage color (dominant — usually correct).
 *        - Iteratively add the color maximally distant from the selected set,
 *          with a light coverage tiebreak.
 *      This naturally keeps distinctive hues (gold far from orange) while
 *      collapsing near-duplicates (three shades of brown → one).
 */

const OVER_FACTOR = 3;  // multiplier for over-quantize count
const OVER_MAX    = 20; // hard cap on over-quantize count

class PaletteDistiller {

    /**
     * Return the over-quantize target for a desired final color count.
     * @param {number} targetK
     * @returns {number}
     */
    static overQuantizeCount(targetK) {
        return Math.min(Math.max(targetK, 1) * OVER_FACTOR, OVER_MAX);
    }

    /**
     * Distill a large palette to K colors using coverage-seeded furthest-point
     * sampling.
     *
     * @param {Array<{L,a,b}>}          palette     - Input palette (N colors, N >= K)
     * @param {Uint8Array|Uint16Array}  assignments - Pixel→palette-index map (length = pixelCount)
     * @param {number}                  pixelCount
     * @param {number}                  targetK     - Desired output color count
     * @returns {{ palette: Array<{L,a,b}>, remap: Uint8Array, selected: number[] }}
     *   palette   – reduced K-color palette (copies of input colors)
     *   remap     – mapping from old index (0…N-1) to new index (0…K-1)
     *   selected  – which original indices were kept (for diagnostics)
     */
    static distill(palette, assignments, pixelCount, targetK) {
        const N = palette.length;
        const K = Math.min(targetK, N);

        // Nothing to reduce
        if (N <= K) {
            const remap = new Uint8Array(N);
            for (let i = 0; i < N; i++) remap[i] = i;
            return {
                palette: palette.map(c => ({ ...c })),
                remap,
                selected: Array.from({ length: N }, (_, i) => i)
            };
        }

        // ── 1. Count coverage per color ──────────────────────────────────────
        const counts = new Float64Array(N);
        for (let i = 0; i < pixelCount; i++) {
            const idx = assignments[i];
            if (idx < N) counts[idx]++;
        }

        // ── 2. Seed: highest-coverage color ──────────────────────────────────
        let seedIdx = 0;
        for (let i = 1; i < N; i++) {
            if (counts[i] > counts[seedIdx]) seedIdx = i;
        }

        // ── 3. Greedy furthest-point selection ───────────────────────────────
        // minDistSq[i] = squared ΔE from color i to its nearest selected color.
        // Set to 0 for colors that have been selected (excluded from future picks).
        const minDistSq = new Float64Array(N).fill(Infinity);
        const selected  = [seedIdx];
        PaletteDistiller._updateMinDist(minDistSq, palette, seedIdx, N);

        while (selected.length < K) {
            let bestScore = -1;
            let bestIdx   = -1;

            for (let i = 0; i < N; i++) {
                if (minDistSq[i] === 0) continue; // already selected
                // Primary: maximize distance to nearest selected (most distinctive).
                // Tiebreak: slight boost for higher-coverage colors so we don't
                // select a single noise pixel over a color used by 5% of the image.
                const score = Math.sqrt(minDistSq[i]) * (1 + counts[i] / (pixelCount || 1));
                if (score > bestScore) { bestScore = score; bestIdx = i; }
            }

            if (bestIdx === -1) break;
            selected.push(bestIdx);
            PaletteDistiller._updateMinDist(minDistSq, palette, bestIdx, N);
        }

        // ── 4. Build reduced palette ─────────────────────────────────────────
        const reducedPalette = selected.map(i => ({ ...palette[i] }));

        // ── 5. Build remap: old index → nearest selected index (ΔE²) ─────────
        const remap = new Uint8Array(N);
        for (let i = 0; i < N; i++) {
            let bestDist = Infinity;
            let bestSlot = 0;
            const c = palette[i];
            for (let j = 0; j < selected.length; j++) {
                const s = palette[selected[j]];
                const d = (c.L - s.L) ** 2 + (c.a - s.a) ** 2 + (c.b - s.b) ** 2;
                if (d < bestDist) { bestDist = d; bestSlot = j; }
            }
            remap[i] = bestSlot;
        }

        return { palette: reducedPalette, remap, selected };
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /**
     * Update minDistSq after adding newIdx to the selected set.
     * @private
     */
    static _updateMinDist(minDistSq, palette, newIdx, N) {
        const nc = palette[newIdx];
        for (let i = 0; i < N; i++) {
            const c = palette[i];
            const d = (c.L - nc.L) ** 2 + (c.a - nc.a) ** 2 + (c.b - nc.b) ** 2;
            if (d < minDistSq[i]) minDistSq[i] = d;
        }
        minDistSq[newIdx] = 0; // mark selected — excluded from future picks
    }
}

module.exports = { PaletteDistiller, OVER_FACTOR, OVER_MAX };
