/**
 * consolidatePaletteCoverage — Unit tests
 *
 * Regression coverage for the 2026-11-12 manifest bug: a color that
 * absorbed another (or was itself absorbed by a merge) showed up twice
 * in the exported XMP palette, with its pixel count split between the
 * two entries instead of combined into the surviving one ("why is black
 * appearing twice").
 */

const { consolidatePaletteCoverage } = require('../src/utils/paletteCoverage');

describe('consolidatePaletteCoverage', () => {
    it('folds a merged source\'s pixels into its target\'s count', () => {
        // colorIndices: slot 0 has 3 px, slot 1 has 2 px. Slot 1 merged into 0.
        const colorIndices = new Uint8Array([0, 0, 0, 1, 1]);
        const mergeHistory = new Map([[0, new Set([1])]]);

        const { pixelCounts, survivingIndices } = consolidatePaletteCoverage(colorIndices, 2, mergeHistory);

        expect(pixelCounts[0]).toBe(5); // 3 original + 2 folded in from slot 1
        expect(pixelCounts[1]).toBe(0);
        expect(survivingIndices).toEqual([0]); // slot 1 is a merge source -- no entry of its own
    });

    it('reproduces the real scenario: two slots both resolving to the same color no longer double-counted', () => {
        // Mirrors the actual report: two palette slots (say index 0 and
        // index 7) both end up as black after a merge. Slot 7 merged into
        // slot 0. Before the fix, each kept its own un-consolidated count
        // and both appeared as separate manifest entries for the same hex.
        const colorIndices = new Uint8Array([
            ...Array(60).fill(0),  // 60 px originally slot 0
            ...Array(25).fill(7),  // 25 px originally slot 7 (merged into 0)
        ]);
        const mergeHistory = new Map([[0, new Set([7])]]);

        const { pixelCounts, survivingIndices } = consolidatePaletteCoverage(colorIndices, 8, mergeHistory);

        expect(pixelCounts[0]).toBe(85); // combined -- one entry, full total
        expect(pixelCounts[7]).toBe(0);
        expect(survivingIndices).not.toContain(7); // "black" doesn't appear twice
        expect(survivingIndices).toContain(0);
    });

    it('leaves unrelated, unmerged slots untouched', () => {
        const colorIndices = new Uint8Array([0, 1, 2, 1, 2, 2]);
        const mergeHistory = new Map(); // no merges at all

        const { pixelCounts, survivingIndices } = consolidatePaletteCoverage(colorIndices, 3, mergeHistory);

        expect(Array.from(pixelCounts)).toEqual([1, 2, 3]);
        expect(survivingIndices).toEqual([0, 1, 2]);
    });

    it('handles a chain of multiple sources into one target', () => {
        const colorIndices = new Uint8Array([2, 2, 5, 5, 5, 9]);
        // Both 5 and 9 merged into 2.
        const mergeHistory = new Map([[2, new Set([5, 9])]]);

        const { pixelCounts, survivingIndices } = consolidatePaletteCoverage(colorIndices, 10, mergeHistory);

        expect(pixelCounts[2]).toBe(6); // 2 + 3 + 1
        expect(pixelCounts[5]).toBe(0);
        expect(pixelCounts[9]).toBe(0);
        expect(survivingIndices).toContain(2);
        expect(survivingIndices).not.toContain(5);
        expect(survivingIndices).not.toContain(9);
    });
});
