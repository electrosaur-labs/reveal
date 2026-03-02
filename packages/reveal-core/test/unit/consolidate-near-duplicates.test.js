import { describe, test, expect } from 'vitest';

const PaletteOps = require('../../lib/engines/PaletteOps');

describe('PaletteOps.consolidateNearDuplicates', () => {
    const consolidate = PaletteOps.consolidateNearDuplicates.bind(PaletteOps);

    describe('guard clauses', () => {
        test('returns empty map for null palette', () => {
            expect(consolidate(null, new Set([0]))).toEqual({});
        });

        test('returns empty map for single-color palette', () => {
            expect(consolidate([{ L: 50, a: 0, b: 0 }], new Set([0]))).toEqual({});
        });

        test('returns empty map for empty editedIndices', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },
                { L: 50, a: 1, b: 0 },
            ];
            expect(consolidate(palette, new Set())).toEqual({});
        });

        test('returns empty map for null editedIndices', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },
                { L: 50, a: 1, b: 0 },
            ];
            expect(consolidate(palette, null)).toEqual({});
        });
    });

    describe('merging behaviour', () => {
        test('merges edited slot into near-duplicate neighbour', () => {
            const palette = [
                { L: 50, a: 10, b: 20 },   // 0: engine-produced
                { L: 50, a: 11, b: 20 },   // 1: user-edited, ΔE=1 from slot 0
                { L: 80, a: -30, b: 40 },  // 2: far away
            ];
            const result = consolidate(palette, new Set([1]));
            expect(result).toEqual({ 1: 0 });
        });

        test('does NOT merge non-edited close slots', () => {
            const palette = [
                { L: 50, a: 10, b: 20 },   // 0: engine-produced
                { L: 50, a: 11, b: 20 },   // 1: engine-produced (close to 0)
                { L: 80, a: -30, b: 40 },  // 2: user-edited (far from both)
            ];
            const result = consolidate(palette, new Set([2]));
            expect(result).toEqual({});
        });

        test('does not merge when distance exceeds threshold', () => {
            const palette = [
                { L: 50, a: 10, b: 20 },
                { L: 50, a: 20, b: 20 },  // ΔE=10, exceeds default threshold of 3
            ];
            const result = consolidate(palette, new Set([1]));
            expect(result).toEqual({});
        });

        test('respects custom threshold', () => {
            const palette = [
                { L: 50, a: 10, b: 20 },
                { L: 50, a: 15, b: 20 },  // ΔE=5
            ];
            // Default threshold 3 — no merge
            expect(consolidate(palette, new Set([1]), 3)).toEqual({});
            // Raised threshold 6 — should merge
            expect(consolidate(palette, new Set([1]), 6)).toEqual({ 1: 0 });
        });

        test('multiple edited slots can merge independently', () => {
            const palette = [
                { L: 50, a: 10, b: 20 },  // 0
                { L: 50, a: 11, b: 20 },  // 1: edited, close to 0
                { L: 80, a: -30, b: 40 }, // 2
                { L: 80, a: -31, b: 40 }, // 3: edited, close to 2
            ];
            const result = consolidate(palette, new Set([1, 3]));
            expect(result).toEqual({ 1: 0, 3: 2 });
        });

        test('skips out-of-bounds edited index', () => {
            const palette = [
                { L: 50, a: 10, b: 20 },
                { L: 50, a: 11, b: 20 },
            ];
            const result = consolidate(palette, new Set([5]));
            expect(result).toEqual({});
        });

        test('dead slot is not merged into by another edited slot', () => {
            // Slot 1 merges into 0 first, then slot 2 should NOT merge into dead slot 1
            const palette = [
                { L: 50, a: 10, b: 20 },   // 0
                { L: 50, a: 11, b: 20 },   // 1: ΔE=1 from 0
                { L: 50, a: 11.5, b: 20 }, // 2: ΔE~1.5 from 1, ΔE~1.5 from 0
            ];
            const result = consolidate(palette, new Set([1, 2]));
            // 1 merges into 0 (dead), 2 should merge into 0 (skipping dead 1)
            expect(result[1]).toBe(0);
            expect(result[2]).toBe(0);
        });
    });
});
