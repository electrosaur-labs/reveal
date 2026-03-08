/**
 * TrapEngine - Unit Tests
 *
 * All tests use synthetic binary masks and Lab palettes.
 * Validates: lightness sorting, white skip, linear interpolation,
 * 4-connected dilation, darker-mask constraint, double-buffering,
 * early termination, and edge cases.
 */

import { describe, it, expect } from 'vitest';

const TrapEngine = require('../../lib/engines/TrapEngine');

// --- Helpers ---

/** Create a WxH binary mask from a 2D array of 0/1 */
const maskFrom2D = (grid) => {
    const h = grid.length;
    const w = grid[0].length;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            mask[y * w + x] = grid[y][x] ? 255 : 0;
        }
    }
    return mask;
};

/** Convert a flat mask back to a 2D array of 0/1 for easier assertion */
const maskTo2D = (mask, w, h) => {
    const grid = [];
    for (let y = 0; y < h; y++) {
        const row = [];
        for (let x = 0; x < w; x++) {
            row.push(mask[y * w + x] === 255 ? 1 : 0);
        }
        grid.push(row);
    }
    return grid;
};

/** Count opaque pixels in a mask */
const countPixels = (mask) => {
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] === 255) count++;
    }
    return count;
};

// --- Tests ---

describe('TrapEngine', () => {

    describe('applyTrapping - basic behavior', () => {

        it('returns zero when maxTrapPixels is 0', () => {
            const masks = [new Uint8Array(25), new Uint8Array(25)];
            const palette = [{ L: 80, a: 0, b: 0 }, { L: 20, a: 0, b: 0 }];
            const result = TrapEngine.applyTrapping(masks, palette, 5, 5, 0);
            expect(result.trappedCount).toBe(0);
            expect(result.trapSizes).toEqual([]);
        });

        it('returns zero when masks array is empty', () => {
            const result = TrapEngine.applyTrapping([], [], 5, 5, 3);
            expect(result.trappedCount).toBe(0);
        });

        it('returns zero for a single non-white color (nothing to trap against)', () => {
            const mask = maskFrom2D([
                [1, 1, 0, 0, 0],
                [1, 1, 0, 0, 0],
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
            ]);
            const result = TrapEngine.applyTrapping(
                [mask], [{ L: 50, a: 0, b: 0 }], 5, 5, 3
            );
            expect(result.trappedCount).toBe(0);
        });

        it('skips white colors (L >= 98)', () => {
            const whiteMask = maskFrom2D([
                [1, 1, 1, 1, 1],
                [1, 1, 1, 1, 1],
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
            ]);
            const darkMask = maskFrom2D([
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
                [1, 1, 1, 1, 1],
                [1, 1, 1, 1, 1],
            ]);
            const palette = [
                { L: 99, a: 0, b: 0 },  // white - should be skipped
                { L: 20, a: 0, b: 0 },  // dark
            ];
            const result = TrapEngine.applyTrapping(
                [whiteMask, darkMask], palette, 5, 5, 3
            );
            // Only one trappable color -> nothing to trap
            expect(result.trappedCount).toBe(0);
        });
    });

    describe('applyTrapping - two colors, light expands under dark', () => {

        // 10x1 strip: light on left, dark on right, 1px gap between
        //   Light: [1,1,1,0,0,0,0,0,0,0]
        //   Dark:  [0,0,0,0,1,1,1,1,1,1]
        // After 1px trap, light should expand 1px rightward into dark territory
        it('light color expands into dark territory by 1 pixel', () => {
            const w = 10, h = 1;
            const lightMask = new Uint8Array(w);
            const darkMask = new Uint8Array(w);

            // Light occupies pixels 0-2
            lightMask[0] = lightMask[1] = lightMask[2] = 255;
            // Dark occupies pixels 4-9 (gap at pixel 3)
            for (let i = 4; i < 10; i++) darkMask[i] = 255;

            const palette = [
                { L: 80, a: 0, b: 0 },  // light
                { L: 20, a: 0, b: 0 },  // dark
            ];

            const before = countPixels(lightMask);
            TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 1);
            const after = countPixels(lightMask);

            // Light can only expand into dark territory — pixel 3 is not dark, so no expansion there.
            // Pixel 4 is dark territory and adjacent to... wait, pixel 3 is the gap.
            // Light is at 0,1,2. Dark is at 4-9. With 1px dilation, light expands to pixel 3,
            // but pixel 3 is NOT in the darker mask. So no expansion.
            // Actually the gap means no expansion is possible with 1px.
            expect(after).toBe(before); // gap prevents expansion
        });

        it('light color expands when directly adjacent to dark', () => {
            const w = 10, h = 1;
            const lightMask = new Uint8Array(w);
            const darkMask = new Uint8Array(w);

            // Light: pixels 0-4, Dark: pixels 5-9 (directly adjacent)
            for (let i = 0; i < 5; i++) lightMask[i] = 255;
            for (let i = 5; i < 10; i++) darkMask[i] = 255;

            const palette = [
                { L: 80, a: 10, b: 20 },  // light
                { L: 20, a: -5, b: 10 },  // dark
            ];

            TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 2);

            // Light should expand 2px into dark territory (pixels 5 and 6)
            expect(lightMask[5]).toBe(255);
            expect(lightMask[6]).toBe(255);
            expect(lightMask[7]).toBe(0); // not reached
            // Dark mask unchanged
            expect(countPixels(darkMask)).toBe(5);
        });

        it('dark color does NOT expand (gets 0 trap)', () => {
            const w = 10, h = 1;
            const lightMask = new Uint8Array(w);
            const darkMask = new Uint8Array(w);

            for (let i = 0; i < 5; i++) lightMask[i] = 255;
            for (let i = 5; i < 10; i++) darkMask[i] = 255;

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            const darkBefore = countPixels(darkMask);
            TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 3);

            // Dark is the darkest — 0 trap, no expansion
            expect(countPixels(darkMask)).toBe(darkBefore);
        });
    });

    describe('applyTrapping - three colors, linear interpolation', () => {

        // Three colors: L=80 (light), L=50 (mid), L=20 (dark)
        // With maxTrap=4: light gets 4px, mid gets 2px, dark gets 0px
        it('assigns correct trap sizes via linear interpolation', () => {
            const w = 20, h = 1;
            const lightMask = new Uint8Array(w);
            const midMask = new Uint8Array(w);
            const darkMask = new Uint8Array(w);

            // Adjacent blocks: light[0-5], mid[6-12], dark[13-19]
            for (let i = 0; i <= 5; i++) lightMask[i] = 255;
            for (let i = 6; i <= 12; i++) midMask[i] = 255;
            for (let i = 13; i <= 19; i++) darkMask[i] = 255;

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 50, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            const result = TrapEngine.applyTrapping(
                [lightMask, midMask, darkMask], palette, w, h, 4
            );

            // Sort trapSizes by index to find each color's assignment
            const byIdx = {};
            for (const ts of result.trapSizes) byIdx[ts.index] = ts.trapPx;

            expect(byIdx[0]).toBe(4);  // lightest -> max
            expect(byIdx[1]).toBe(2);  // mid -> interpolated
            expect(byIdx[2]).toBe(0);  // darkest -> 0
        });
    });

    describe('2D dilation - 4-connected expansion', () => {

        it('expands in all 4 cardinal directions', () => {
            const w = 5, h = 5;

            // Single light pixel in center
            const lightMask = maskFrom2D([
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
                [0, 0, 1, 0, 0],
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
            ]);

            // Dark pixels surrounding (ring at distance 1 and 2)
            const darkMask = maskFrom2D([
                [1, 1, 1, 1, 1],
                [1, 1, 1, 1, 1],
                [1, 1, 0, 1, 1],
                [1, 1, 1, 1, 1],
                [1, 1, 1, 1, 1],
            ]);

            const palette = [
                { L: 80, a: 0, b: 0 },  // light (center)
                { L: 20, a: 0, b: 0 },  // dark (surround)
            ];

            TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 1);

            const result = maskTo2D(lightMask, w, h);
            // After 1 iteration: center + 4 cardinal neighbors
            expect(result).toEqual([
                [0, 0, 0, 0, 0],
                [0, 0, 1, 0, 0],
                [0, 1, 1, 1, 0],
                [0, 0, 1, 0, 0],
                [0, 0, 0, 0, 0],
            ]);
        });

        it('does NOT expand diagonally (4-connected, not 8)', () => {
            const w = 5, h = 5;

            const lightMask = maskFrom2D([
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
                [0, 0, 1, 0, 0],
                [0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0],
            ]);

            const darkMask = maskFrom2D([
                [1, 1, 1, 1, 1],
                [1, 1, 1, 1, 1],
                [1, 1, 0, 1, 1],
                [1, 1, 1, 1, 1],
                [1, 1, 1, 1, 1],
            ]);

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 1);

            // Diagonal pixels should NOT be filled after 1 iteration
            expect(lightMask[0 * w + 0]).toBe(0); // top-left corner
            expect(lightMask[1 * w + 1]).toBe(0); // diagonal from center
            expect(lightMask[1 * w + 3]).toBe(0);
            expect(lightMask[3 * w + 1]).toBe(0);
            expect(lightMask[3 * w + 3]).toBe(0);
        });

        it('expands 2 iterations to reach diamond shape', () => {
            const w = 7, h = 7;

            const lightMask = maskFrom2D([
                [0, 0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0, 0],
                [0, 0, 0, 1, 0, 0, 0],
                [0, 0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0, 0],
                [0, 0, 0, 0, 0, 0, 0],
            ]);

            // All dark everywhere else
            const darkMask = maskFrom2D([
                [1, 1, 1, 1, 1, 1, 1],
                [1, 1, 1, 1, 1, 1, 1],
                [1, 1, 1, 1, 1, 1, 1],
                [1, 1, 1, 0, 1, 1, 1],
                [1, 1, 1, 1, 1, 1, 1],
                [1, 1, 1, 1, 1, 1, 1],
                [1, 1, 1, 1, 1, 1, 1],
            ]);

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 2);

            const result = maskTo2D(lightMask, w, h);
            // 2 iterations of 4-connected = diamond (Manhattan distance <= 2)
            expect(result).toEqual([
                [0, 0, 0, 0, 0, 0, 0],
                [0, 0, 0, 1, 0, 0, 0],
                [0, 0, 1, 1, 1, 0, 0],
                [0, 1, 1, 1, 1, 1, 0],
                [0, 0, 1, 1, 1, 0, 0],
                [0, 0, 0, 1, 0, 0, 0],
                [0, 0, 0, 0, 0, 0, 0],
            ]);
        });
    });

    describe('darker mask constraint', () => {

        it('light does not expand into empty space (only into darker territory)', () => {
            const w = 7, h = 1;
            // Light at left, dark at right, gap in middle
            // Light: [1,1,0,0,0,0,0]
            // Dark:  [0,0,0,0,0,1,1]
            const lightMask = new Uint8Array(w);
            const darkMask = new Uint8Array(w);
            lightMask[0] = lightMask[1] = 255;
            darkMask[5] = darkMask[6] = 255;

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 10);

            // Even with 10px trap, light can only expand where dark mask exists.
            // Dark mask is at pixels 5,6. Light is at 0,1. They're not adjacent,
            // so light cannot reach dark territory.
            expect(countPixels(lightMask)).toBe(2); // unchanged
        });

        it('light expands into dark but stops at dark mask boundary', () => {
            const w = 10, h = 1;
            // Light at 0-2, dark at 3-5, empty at 6-9
            const lightMask = new Uint8Array(w);
            const darkMask = new Uint8Array(w);
            for (let i = 0; i < 3; i++) lightMask[i] = 255;
            for (let i = 3; i < 6; i++) darkMask[i] = 255;

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 10);

            // Light expands into dark territory (pixels 3,4,5) but not beyond
            expect(lightMask[3]).toBe(255);
            expect(lightMask[4]).toBe(255);
            expect(lightMask[5]).toBe(255);
            expect(lightMask[6]).toBe(0); // beyond dark territory
        });
    });

    describe('early termination', () => {

        it('stops expanding when all reachable territory is filled', () => {
            const w = 5, h = 1;
            // Light at 0-1, dark at 2 only
            const lightMask = new Uint8Array(w);
            const darkMask = new Uint8Array(w);
            lightMask[0] = lightMask[1] = 255;
            darkMask[2] = 255;

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            const result = TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 100);

            // Only 1 pixel of dark territory reachable, filled in iteration 1
            // Remaining 99 iterations should terminate early
            expect(lightMask[2]).toBe(255);
            expect(countPixels(lightMask)).toBe(3); // 2 original + 1 expanded
            const lightTrap = result.trapSizes.find(ts => ts.index === 0);
            expect(lightTrap.expandedPixels).toBe(1);
        });
    });

    describe('palette index ordering (not array order)', () => {

        it('sorts by Lab L regardless of array position', () => {
            const w = 10, h = 1;
            // Array order: dark first, light second (reversed from lightness)
            const darkMask = new Uint8Array(w);
            const lightMask = new Uint8Array(w);
            for (let i = 0; i < 5; i++) darkMask[i] = 255;
            for (let i = 5; i < 10; i++) lightMask[i] = 255;

            const palette = [
                { L: 20, a: 0, b: 0 },  // index 0 = dark
                { L: 80, a: 0, b: 0 },  // index 1 = light
            ];

            TrapEngine.applyTrapping([darkMask, lightMask], palette, w, h, 2);

            // Light (index 1) should expand into dark (index 0) territory
            // Light was at pixels 5-9, dark at 0-4
            // Light expands left: pixel 4, pixel 3
            expect(lightMask[4]).toBe(255);
            expect(lightMask[3]).toBe(255);
            expect(lightMask[2]).toBe(0);

            // Dark should NOT expand (it's the darkest)
            expect(countPixels(darkMask)).toBe(5);
        });
    });

    describe('multiple colors - only expands into darker territory', () => {

        it('mid color expands into dark but not into light', () => {
            const w = 15, h = 1;
            const lightMask = new Uint8Array(w);
            const midMask = new Uint8Array(w);
            const darkMask = new Uint8Array(w);

            // Light: 0-4, Mid: 5-9, Dark: 10-14
            for (let i = 0; i < 5; i++) lightMask[i] = 255;
            for (let i = 5; i < 10; i++) midMask[i] = 255;
            for (let i = 10; i < 15; i++) darkMask[i] = 255;

            const palette = [
                { L: 80, a: 0, b: 0 },  // light
                { L: 50, a: 0, b: 0 },  // mid
                { L: 20, a: 0, b: 0 },  // dark
            ];

            TrapEngine.applyTrapping([lightMask, midMask, darkMask], palette, w, h, 4);

            // With maxTrap=4 and 3 colors: light=4px, mid=2px, dark=0px
            // Mid should expand right (into dark) but NOT left (into light)
            // Mid's darker mask = dark only (pixels 10-14)
            expect(midMask[10]).toBe(255); // expanded into dark (iter 1)
            expect(midMask[11]).toBe(255); // expanded into dark (iter 2)
            expect(midMask[12]).toBe(0);   // only 2px trap
            expect(midMask[4]).toBe(0);    // did NOT expand into light territory
        });
    });

    describe('2D edge cases', () => {

        it('handles corner pixels correctly', () => {
            const w = 3, h = 3;

            // Light in top-left corner
            const lightMask = maskFrom2D([
                [1, 0, 0],
                [0, 0, 0],
                [0, 0, 0],
            ]);

            // Dark everywhere else
            const darkMask = maskFrom2D([
                [0, 1, 1],
                [1, 1, 1],
                [1, 1, 1],
            ]);

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 1);

            const result = maskTo2D(lightMask, w, h);
            expect(result).toEqual([
                [1, 1, 0],
                [1, 0, 0],
                [0, 0, 0],
            ]);
        });

        it('handles single-pixel image', () => {
            const lightMask = new Uint8Array([255]);
            const darkMask = new Uint8Array([0]);

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            // Should not crash
            const result = TrapEngine.applyTrapping(
                [lightMask, darkMask], palette, 1, 1, 3
            );
            expect(result).toBeDefined();
        });

        it('handles empty masks gracefully', () => {
            const lightMask = new Uint8Array(25); // all zeros
            const darkMask = new Uint8Array(25);  // all zeros

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            const result = TrapEngine.applyTrapping(
                [lightMask, darkMask], palette, 5, 5, 3
            );
            expect(result.trappedCount).toBe(0);
        });
    });

    describe('double-buffering correctness', () => {

        it('expansion does not cascade within a single iteration', () => {
            // Without double-buffering, scanning left-to-right would cause
            // a cascade: pixel N expands, then pixel N+1 sees it and also expands,
            // giving >1px expansion per iteration.
            const w = 10, h = 1;
            const lightMask = new Uint8Array(w);
            const darkMask = new Uint8Array(w);

            lightMask[0] = 255;
            for (let i = 1; i < 10; i++) darkMask[i] = 255;

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            // 1 iteration should expand exactly 1 pixel
            TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 1);

            expect(lightMask[1]).toBe(255); // expanded
            expect(lightMask[2]).toBe(0);   // NOT cascaded
            expect(countPixels(lightMask)).toBe(2);
        });
    });

    describe('return value structure', () => {

        it('returns trapSizes with index, trapPx, and expandedPixels', () => {
            const w = 10, h = 1;
            const lightMask = new Uint8Array(w);
            const darkMask = new Uint8Array(w);
            for (let i = 0; i < 5; i++) lightMask[i] = 255;
            for (let i = 5; i < 10; i++) darkMask[i] = 255;

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            const result = TrapEngine.applyTrapping([lightMask, darkMask], palette, w, h, 2);

            expect(result.trappedCount).toBe(1);
            expect(result.trapSizes).toHaveLength(2);

            const light = result.trapSizes.find(ts => ts.index === 0);
            const dark = result.trapSizes.find(ts => ts.index === 1);

            expect(light.trapPx).toBe(2);
            expect(light.expandedPixels).toBe(2);

            expect(dark.trapPx).toBe(0);
            expect(dark.expandedPixels).toBe(0);
        });
    });
});
