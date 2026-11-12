/**
 * resolveMergeRemap — Unit tests
 *
 * Regression coverage for the 2026-11-12 duplicate-layer bug: deleting two
 * colors into the same merge target produced two separate layers with
 * identical ink instead of one, because consolidateNearDuplicates could
 * rewrite an already-correct direct target with an intermediate hop
 * through a sibling merge source, and the old single-lookup application
 * never followed that second hop.
 */

const { resolveMergeRemap } = require('../src/utils/resolveMergeRemap');

describe('resolveMergeRemap', () => {
    it('leaves a direct (single-hop) remap unchanged', () => {
        const result = resolveMergeRemap({ 7: 9, 8: 5 });
        expect(result).toEqual({ 7: 9, 8: 5 });
    });

    it('resolves the real-world reproduction: two sources, one via a sibling hop', () => {
        // Reproduces the exact scenario from the investigation: colors 2 and 3
        // both merged into target 11. consolidateNearDuplicates rewrote
        // mergeRemap[2] from the correct 11 to an intermediate hop through
        // sibling 3 (since 2 and 3 are themselves identical, having both
        // resolved to 11's color). Both must resolve to the same final
        // target, 11 — not split across 3 and 11.
        const result = resolveMergeRemap({ 2: 3, 3: 11, 7: 9, 8: 5 });
        expect(result).toEqual({ 2: 11, 3: 11, 7: 9, 8: 5 });
    });

    it('resolves a longer chain to its final target', () => {
        const result = resolveMergeRemap({ 0: 1, 1: 2, 2: 3 });
        expect(result).toEqual({ 0: 3, 1: 3, 2: 3 });
    });

    it('does not hang on a cycle and resolves to a stable value', () => {
        const result = resolveMergeRemap({ 0: 1, 1: 0 });
        expect(result[0]).toBeDefined();
        expect(result[1]).toBeDefined();
    });

    it('returns an empty object for an empty table', () => {
        expect(resolveMergeRemap({})).toEqual({});
    });

    it('a source whose target has no further entry resolves to that target', () => {
        const result = resolveMergeRemap({ 5: 2 });
        expect(result).toEqual({ 5: 2 });
    });
});
