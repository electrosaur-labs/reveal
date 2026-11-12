/**
 * Resolve a merge-remap table to its final targets.
 *
 * A production mergeRemap (SessionState.exportProductionConfig) maps a
 * deleted/merged color's index to where its pixels should go. Entries can
 * chain: consolidateNearDuplicates can rewrite an already-correct direct
 * target with an intermediate hop through a sibling merge source (e.g. two
 * colors that both merged into the same target are themselves identical,
 * so it "merges" one into the other instead of leaving it pointing at the
 * real target). Applying the table with a single lookup per pixel only
 * follows one hop and leaves the intermediate stop as its own separate
 * layer, with the exact same ink as the real target.
 *
 * Resolving once here — rather than chain-walking per pixel — is both
 * correct (every pixel reaches the true final target) and cheap (one pass
 * over the small remap table instead of millions of repeated walks).
 *
 * @param {Object<number, number>} mergeRemap - source index -> target index
 * @returns {Object<number, number>} source index -> FINAL target index
 */
function resolveMergeRemap(mergeRemap) {
    const resolved = {};
    for (const key of Object.keys(mergeRemap)) {
        const start = parseInt(key, 10);
        let cur = start;
        // Cycle guard: none should be constructible by the table-building
        // logic, but a guard costs nothing and a hang would be far worse
        // than resolving to a slightly-stale target.
        const seen = new Set([cur]);
        let next = mergeRemap[cur];
        while (next !== undefined && !seen.has(next)) {
            cur = next;
            seen.add(cur);
            next = mergeRemap[cur];
        }
        resolved[start] = cur;
    }
    return resolved;
}

module.exports = { resolveMergeRemap };
