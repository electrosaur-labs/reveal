/**
 * Consolidate per-pixel palette coverage through the merge graph.
 *
 * A raw colorIndices buffer still carries each pixel's ORIGINAL index even
 * after palette surgery merges two colors together (nothing re-separates
 * the proxy -- "plate assignments stay fixed, only the palette updates").
 * Counting coverage straight off colorIndices without resolving merges
 * means a color that absorbed another (or was itself absorbed) is counted
 * under two different indices instead of one combined total -- e.g. a
 * production manifest listing the same hex twice with its coverage split
 * between the entries (2026-11-12: "why is black appearing twice").
 *
 * @param {Uint8Array|Uint16Array} colorIndices - Per-pixel palette index
 * @param {number} paletteLength - Total number of palette slots
 * @param {Map<number, Set<number>>} mergeHistory - target index -> Set of source indices
 * @returns {{pixelCounts: Uint32Array, survivingIndices: number[]}}
 *   pixelCounts[i]: total pixels resolving to slot i (sources folded into their target).
 *   survivingIndices: slot indices that are NOT a merge source -- the ones
 *     that should actually be listed/rendered; a merged-away slot never
 *     gets its own entry.
 */
function consolidatePaletteCoverage(colorIndices, paletteLength, mergeHistory) {
    const sourceToTarget = new Map();
    for (const [target, sources] of mergeHistory) {
        for (const src of sources) sourceToTarget.set(src, target);
    }

    const pixelCounts = new Uint32Array(paletteLength);
    for (let i = 0; i < colorIndices.length; i++) {
        const ci = colorIndices[i];
        pixelCounts[sourceToTarget.has(ci) ? sourceToTarget.get(ci) : ci]++;
    }

    const survivingIndices = [];
    for (let i = 0; i < paletteLength; i++) {
        if (!sourceToTarget.has(i)) survivingIndices.push(i);
    }

    return { pixelCounts, survivingIndices };
}

module.exports = { consolidatePaletteCoverage };
