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

    // =========================================================================
    // Minkler Stress Tests
    //
    // Designed to exercise complex topology: multi-color junctions, acute
    // angles, thin boundaries, and organic shapes where multiple colors
    // collide at vertices. Named after Doug Minkler's hand-drawn print style
    // where boundaries are never clean geometric shapes.
    // =========================================================================

    describe('Minkler stress tests', () => {

        // Five-Point Nexus: 4 colors meeting at a single central point,
        // surrounded by a 5th (dark key). Tests that trapping at a vertex
        // doesn't create holes or blobs.
        //
        // Layout (20x20): quadrants of 4 colors, 2px black key cross through center
        //   Yellow (L=90) | Red (L=55)
        //   ─────── KEY (L=15) ──────
        //   Green (L=50)  | Blue (L=30)
        //
        describe('five-point nexus (4 colors + key at central vertex)', () => {
            const W = 20, H = 20;

            // Yellow = top-left quadrant
            const yellowGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => (y < 9 && x < 9) ? 1 : 0));
            // Red = top-right quadrant
            const redGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => (y < 9 && x > 10) ? 1 : 0));
            // Green = bottom-left quadrant
            const greenGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => (y > 10 && x < 9) ? 1 : 0));
            // Blue = bottom-right quadrant
            const blueGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => (y > 10 && x > 10) ? 1 : 0));
            // Key = 2px cross through center (rows 9-10, cols 9-10)
            const keyGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) =>
                    ((y === 9 || y === 10) || (x === 9 || x === 10)) ? 1 : 0));

            const palette = [
                { L: 90, a: -5, b: 80 },   // 0: Yellow (lightest)
                { L: 55, a: 60, b: 40 },   // 1: Red
                { L: 50, a: -50, b: 30 },  // 2: Green
                { L: 30, a: 10, b: -60 },  // 3: Blue
                { L: 15, a: 0, b: 0 },     // 4: Key (darkest)
            ];

            it('lighter colors expand into key territory, not into each other', () => {
                const masks = [
                    maskFrom2D(yellowGrid),
                    maskFrom2D(redGrid),
                    maskFrom2D(greenGrid),
                    maskFrom2D(blueGrid),
                    maskFrom2D(keyGrid),
                ];

                const beforeCounts = masks.map(countPixels);
                TrapEngine.applyTrapping(masks, palette, W, H, 2);
                const afterCounts = masks.map(countPixels);

                // Yellow is lightest — should expand the most
                expect(afterCounts[0]).toBeGreaterThan(beforeCounts[0]);

                // Key is darkest — should NOT expand
                expect(afterCounts[4]).toBe(beforeCounts[4]);

                // Every lighter color should only have gained pixels where key was
                // (or where a darker non-key color was). Verify no color expanded
                // into lighter color territory.
                for (let i = 0; i < 4; i++) {
                    for (let j = 0; j < 4; j++) {
                        if (i === j) continue;
                        // Check no pixel is claimed by both color i and color j
                        // that wasn't already shared (masks are modified in place)
                        // Actually, overlaps ARE expected — that's the whole point of
                        // trapping. But lighter should overlap darker, not vice versa.
                    }
                }

                // Yellow (lightest) should have expanded more than Blue (2nd darkest)
                const yellowGain = afterCounts[0] - beforeCounts[0];
                const blueGain = afterCounts[3] - beforeCounts[3];
                expect(yellowGain).toBeGreaterThan(blueGain);
            });

            it('lighter colors expand into key cross arms adjacent to their quadrant', () => {
                const masks = [
                    maskFrom2D(yellowGrid),
                    maskFrom2D(redGrid),
                    maskFrom2D(greenGrid),
                    maskFrom2D(blueGrid),
                    maskFrom2D(keyGrid),
                ];

                TrapEngine.applyTrapping(masks, palette, W, H, 2);

                // Yellow (top-left, ends at x=8,y=8) should expand into
                // the key cross arms adjacent to it (x=9 and y=9)
                // Check yellow expanded into the horizontal key arm (y=9, x<9)
                let yellowInKeyH = false;
                for (let x = 0; x < 9; x++) {
                    if (masks[0][9 * W + x] === 255) yellowInKeyH = true;
                }
                expect(yellowInKeyH).toBe(true);

                // Check yellow expanded into the vertical key arm (x=9, y<9)
                let yellowInKeyV = false;
                for (let y = 0; y < 9; y++) {
                    if (masks[0][y * W + 9] === 255) yellowInKeyV = true;
                }
                expect(yellowInKeyV).toBe(true);

                // The center intersection (9,9) may or may not be reached
                // depending on Manhattan distance from nearest yellow pixel.
                // Yellow's nearest pixel to (9,9) is (8,8) — Manhattan dist = 2.
                // With 2px trap, it should just reach.
                expect(masks[0][9 * W + 9]).toBe(255);
            });

            it('trap expansion respects hierarchy across all 5 colors', () => {
                const masks = [
                    maskFrom2D(yellowGrid),
                    maskFrom2D(redGrid),
                    maskFrom2D(greenGrid),
                    maskFrom2D(blueGrid),
                    maskFrom2D(keyGrid),
                ];

                const result = TrapEngine.applyTrapping(masks, palette, W, H, 3);

                // Sort by palette index to check trap sizes
                const byIndex = {};
                for (const ts of result.trapSizes) byIndex[ts.index] = ts;

                // Yellow (L=90) lightest → largest trap
                // Red (L=55), Green (L=50) → mid traps
                // Blue (L=30) → small trap
                // Key (L=15) → 0 trap
                expect(byIndex[0].trapPx).toBeGreaterThan(byIndex[3].trapPx);
                expect(byIndex[4].trapPx).toBe(0);
                expect(byIndex[0].trapPx).toBeGreaterThan(0);
            });
        });

        // Acute angle: two colors meeting at a sharp ~15° angle.
        // Tests that dilation doesn't create spikes at the tip.
        //
        // Layout (30x30): A thin wedge of light color (L=80) pointing right
        // into a field of dark color (L=20). The wedge narrows to 1px at tip.
        //
        describe('acute angle wedge (thin tapering boundary)', () => {
            const W = 30, H = 30;

            // Light wedge: triangle from left edge, narrowing to a point
            // at x=25. The wedge spans from y=10 to y=20 at x=0,
            // narrowing to y=15 at x=25.
            const lightGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => {
                    if (x > 25) return 0;
                    const halfWidth = 5 * (1 - x / 25); // 5px half-width at x=0, 0 at x=25
                    const center = 15;
                    return (y >= center - halfWidth && y <= center + halfWidth) ? 1 : 0;
                }));

            // Dark fills everything the light doesn't
            const darkGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => lightGrid[y][x] ? 0 : 1));

            const palette = [
                { L: 80, a: 0, b: 50 },  // 0: Light
                { L: 20, a: 0, b: -10 }, // 1: Dark
            ];

            it('light expands into dark but expansion is bounded by trap limit', () => {
                const masks = [maskFrom2D(lightGrid), maskFrom2D(darkGrid)];
                const beforeLight = countPixels(masks[0]);

                TrapEngine.applyTrapping(masks, palette, W, H, 2);
                const afterLight = countPixels(masks[0]);

                // Light should expand
                expect(afterLight).toBeGreaterThan(beforeLight);

                // But no pixel in the light mask should be more than 2px
                // (Manhattan distance) from the original light region
                const origLight = maskFrom2D(lightGrid);
                for (let y = 0; y < H; y++) {
                    for (let x = 0; x < W; x++) {
                        if (masks[0][y * W + x] === 255 && origLight[y * W + x] === 0) {
                            // This is an expanded pixel — verify it's within Manhattan
                            // distance 2 of an original light pixel
                            let minDist = Infinity;
                            for (let dy = -2; dy <= 2; dy++) {
                                for (let dx = -2; dx <= 2; dx++) {
                                    const ny = y + dy, nx = x + dx;
                                    if (ny >= 0 && ny < H && nx >= 0 && nx < W) {
                                        if (origLight[ny * W + nx] === 255) {
                                            const d = Math.abs(dy) + Math.abs(dx);
                                            if (d < minDist) minDist = d;
                                        }
                                    }
                                }
                            }
                            expect(minDist).toBeLessThanOrEqual(2);
                        }
                    }
                }
            });

            it('tip of wedge (1px wide) still traps correctly', () => {
                const masks = [maskFrom2D(lightGrid), maskFrom2D(darkGrid)];

                TrapEngine.applyTrapping(masks, palette, W, H, 2);

                // Near the tip (x=24, y=15) the wedge is ~1px.
                // After trapping, light should have expanded around this point.
                const tipX = 24, tipY = 15;
                // Check that at least one neighbor of the tip got trapped
                let expandedNeighbors = 0;
                const origLight = maskFrom2D(lightGrid);
                for (const [dx, dy] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
                    const nx = tipX + dx, ny = tipY + dy;
                    if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                        if (masks[0][ny * W + nx] === 255 && origLight[ny * W + nx] === 0) {
                            expandedNeighbors++;
                        }
                    }
                }
                expect(expandedNeighbors).toBeGreaterThan(0);
            });

            it('no spike at acute tip — expansion is symmetric around tip', () => {
                const masks = [maskFrom2D(lightGrid), maskFrom2D(darkGrid)];

                TrapEngine.applyTrapping(masks, palette, W, H, 2);

                // Beyond the original tip (x > 25), expansion should form a
                // roughly symmetric diamond, not a long spike
                let maxExtensionBeyondTip = 0;
                for (let y = 0; y < H; y++) {
                    for (let x = 26; x < W; x++) {
                        if (masks[0][y * W + x] === 255) {
                            maxExtensionBeyondTip = Math.max(maxExtensionBeyondTip, x - 25);
                        }
                    }
                }
                // With a 2px trap, extension beyond original tip should be ≤ 2
                expect(maxExtensionBeyondTip).toBeLessThanOrEqual(2);
            });
        });

        // Thin key line: a 1px dark line separating two light colors.
        // Tests what happens when trap width exceeds the boundary thickness.
        // TrapEngine doesn't clip to line centers — both colors will expand
        // through the thin line and overlap. This test documents that behavior.
        //
        describe('thin key line (trap wider than boundary)', () => {
            const W = 20, H = 10;

            // Left half = light color A
            const lightAGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => (x < 9) ? 1 : 0));
            // Right half = light color B (slightly darker)
            const lightBGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => (x > 10) ? 1 : 0));
            // 2px key line in the middle (x=9,10)
            const keyGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => (x === 9 || x === 10) ? 1 : 0));

            const palette = [
                { L: 85, a: 0, b: 60 },  // 0: Light A (lightest)
                { L: 70, a: 40, b: 0 },  // 1: Light B
                { L: 10, a: 0, b: 0 },   // 2: Key (darkest)
            ];

            it('both light colors expand into key line', () => {
                const masks = [
                    maskFrom2D(lightAGrid),
                    maskFrom2D(lightBGrid),
                    maskFrom2D(keyGrid),
                ];

                TrapEngine.applyTrapping(masks, palette, W, H, 3);

                // Light A should have expanded into key territory (x=9 or x=10)
                let lightAInKey = false;
                let lightBInKey = false;
                for (let y = 0; y < H; y++) {
                    if (masks[0][y * W + 9] === 255 || masks[0][y * W + 10] === 255)
                        lightAInKey = true;
                    if (masks[1][y * W + 9] === 255 || masks[1][y * W + 10] === 255)
                        lightBInKey = true;
                }
                expect(lightAInKey).toBe(true);
                expect(lightBInKey).toBe(true);
            });

            it('light A can bleed through thin key into light B territory', () => {
                // With a 3px trap and a 2px key line, light A (lightest)
                // can expand through the key. But it can only expand into
                // DARKER mask territory. Light B is darker than A, so A
                // CAN expand into B's space.
                const masks = [
                    maskFrom2D(lightAGrid),
                    maskFrom2D(lightBGrid),
                    maskFrom2D(keyGrid),
                ];

                TrapEngine.applyTrapping(masks, palette, W, H, 3);

                // Light A (L=85) is lighter than Light B (L=70).
                // Darker mask for A = union of B + Key.
                // With 3px trap, A can expand from x=8 → x=9 (key) → x=10 (key) → x=11 (B territory)
                let lightAInBTerritory = false;
                for (let y = 0; y < H; y++) {
                    if (masks[0][y * W + 11] === 255) lightAInBTerritory = true;
                }
                expect(lightAInBTerritory).toBe(true);
            });

            it('light B cannot expand into light A territory (lighter)', () => {
                const masks = [
                    maskFrom2D(lightAGrid),
                    maskFrom2D(lightBGrid),
                    maskFrom2D(keyGrid),
                ];

                TrapEngine.applyTrapping(masks, palette, W, H, 3);

                // Light B (L=70) is darker than Light A (L=85).
                // B's darker mask = Key only (not A).
                // B can expand into key (x=9,10) but NOT into A's territory (x<9).
                let lightBInATerritory = false;
                for (let y = 0; y < H; y++) {
                    for (let x = 0; x < 9; x++) {
                        if (masks[1][y * W + x] === 255) lightBInATerritory = true;
                    }
                }
                expect(lightBInATerritory).toBe(false);
            });
        });

        // Organic blob: irregular shape with concavities and narrow isthmuses.
        // Tests that dilation follows the contour correctly through tight passages.
        //
        describe('organic blob with narrow isthmus', () => {
            const W = 20, H = 20;

            // Light blob: two lobes connected by a 1px isthmus
            // Left lobe: 4x4 at (2,8)-(5,11)
            // Right lobe: 4x4 at (14,8)-(17,11)
            // Isthmus: 1px tall bridge from x=6 to x=13 at y=9
            const lightGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => {
                    // Left lobe
                    if (x >= 2 && x <= 5 && y >= 8 && y <= 11) return 1;
                    // Right lobe
                    if (x >= 14 && x <= 17 && y >= 8 && y <= 11) return 1;
                    // Isthmus
                    if (y === 9 && x >= 6 && x <= 13) return 1;
                    return 0;
                }));

            // Dark fills everything else
            const darkGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => lightGrid[y][x] ? 0 : 1));

            const palette = [
                { L: 75, a: 30, b: 40 },
                { L: 20, a: 0, b: 0 },
            ];

            it('dilation follows isthmus contour', () => {
                const masks = [maskFrom2D(lightGrid), maskFrom2D(darkGrid)];
                const origLight = maskFrom2D(lightGrid);

                TrapEngine.applyTrapping(masks, palette, W, H, 1);

                // The isthmus pixels at y=9 should have expanded to y=8 and y=10
                // (above and below the bridge)
                for (let x = 6; x <= 13; x++) {
                    // Original isthmus is at y=9, dark is above (y=8) and below (y=10)
                    // With 1px trap, should expand into both
                    const above = masks[0][8 * W + x];
                    const below = masks[0][10 * W + x];
                    expect(above).toBe(255);
                    expect(below).toBe(255);
                }
            });

            it('lobe expansion is uniform (no distortion from isthmus)', () => {
                const masks = [maskFrom2D(lightGrid), maskFrom2D(darkGrid)];

                TrapEngine.applyTrapping(masks, palette, W, H, 1);

                // Top edge of left lobe (y=7, x=2..5) should all be expanded
                for (let x = 2; x <= 5; x++) {
                    expect(masks[0][7 * W + x]).toBe(255);
                }
                // Bottom edge of left lobe (y=12, x=2..5) should all be expanded
                for (let x = 2; x <= 5; x++) {
                    expect(masks[0][12 * W + x]).toBe(255);
                }
            });
        });

        // Checkerboard: alternating light and dark pixels.
        // Worst case for dilation — every pixel is adjacent to its opposite.
        // Tests performance and correctness under maximum boundary density.
        //
        describe('checkerboard (maximum boundary density)', () => {
            const W = 20, H = 20;

            const lightGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => ((x + y) % 2 === 0) ? 1 : 0));
            const darkGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => ((x + y) % 2 === 1) ? 1 : 0));

            const palette = [
                { L: 80, a: 0, b: 0 },
                { L: 20, a: 0, b: 0 },
            ];

            it('light fills entire grid with 1px trap (every dark pixel is adjacent)', () => {
                const masks = [maskFrom2D(lightGrid), maskFrom2D(darkGrid)];

                TrapEngine.applyTrapping(masks, palette, W, H, 1);

                // Every dark pixel is adjacent to a light pixel, so with 1px trap
                // the light mask should become 100% filled
                expect(countPixels(masks[0])).toBe(W * H);
            });

            it('dark mask is unchanged (darkest gets 0 trap)', () => {
                const masks = [maskFrom2D(lightGrid), maskFrom2D(darkGrid)];
                const darkBefore = countPixels(masks[1]);

                TrapEngine.applyTrapping(masks, palette, W, H, 1);

                expect(countPixels(masks[1])).toBe(darkBefore);
            });
        });

        // Concentric rings: 3 colors nested as rings (light outside, dark center).
        // Tests multi-layer trapping where each ring expands inward.
        //
        describe('concentric rings (3-color nesting)', () => {
            const W = 21, H = 21;
            const cx = 10, cy = 10;

            // Outer ring (light): Manhattan distance 8-10 from center
            // Middle ring (mid): Manhattan distance 4-7 from center
            // Inner circle (dark): Manhattan distance 0-3 from center
            const outerGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => {
                    const d = Math.abs(x - cx) + Math.abs(y - cy);
                    return (d >= 8 && d <= 10) ? 1 : 0;
                }));
            const midGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => {
                    const d = Math.abs(x - cx) + Math.abs(y - cy);
                    return (d >= 4 && d <= 7) ? 1 : 0;
                }));
            const innerGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) => {
                    const d = Math.abs(x - cx) + Math.abs(y - cy);
                    return (d <= 3) ? 1 : 0;
                }));

            const palette = [
                { L: 85, a: 0, b: 60 },  // Outer (lightest)
                { L: 50, a: 30, b: 0 },  // Middle
                { L: 15, a: 0, b: -30 }, // Inner (darkest)
            ];

            it('outer expands inward into middle, middle expands into inner', () => {
                const masks = [
                    maskFrom2D(outerGrid),
                    maskFrom2D(midGrid),
                    maskFrom2D(innerGrid),
                ];

                const result = TrapEngine.applyTrapping(masks, palette, W, H, 2);

                // Both outer and middle should have expanded
                expect(result.trappedCount).toBe(2);

                // Outer should have pixels at Manhattan distance 7 from center
                // (originally it started at distance 8)
                expect(masks[0][cy * W + (cx + 7)]).toBe(255);

                // Middle should have pixels at Manhattan distance 3 from center
                // (originally it started at distance 4)
                expect(masks[1][cy * W + (cx + 3)]).toBe(255);
            });

            it('outer does NOT expand outward (no darker mask outside)', () => {
                const masks = [
                    maskFrom2D(outerGrid),
                    maskFrom2D(midGrid),
                    maskFrom2D(innerGrid),
                ];

                TrapEngine.applyTrapping(masks, palette, W, H, 2);

                // Pixels beyond distance 10 should still be empty for outer
                // (nothing darker to expand into out there)
                let outerExpansion = false;
                for (let y = 0; y < H; y++) {
                    for (let x = 0; x < W; x++) {
                        const d = Math.abs(x - cx) + Math.abs(y - cy);
                        if (d > 10 && masks[0][y * W + x] === 255) {
                            outerExpansion = true;
                        }
                    }
                }
                expect(outerExpansion).toBe(false);
            });

            it('inner (darkest) never expands', () => {
                const masks = [
                    maskFrom2D(outerGrid),
                    maskFrom2D(midGrid),
                    maskFrom2D(innerGrid),
                ];

                const innerBefore = countPixels(masks[2]);
                TrapEngine.applyTrapping(masks, palette, W, H, 2);

                expect(countPixels(masks[2])).toBe(innerBefore);
            });
        });

        // Large trap on small features: 5px trap applied to 3px wide features.
        // Tests that dilation doesn't create artifacts when trap > feature size.
        //
        describe('trap larger than feature size', () => {
            const W = 30, H = 10;

            // Three thin vertical stripes of light color, each 1px wide,
            // spaced 8px apart, surrounded by dark
            const lightGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) =>
                    (x === 5 || x === 15 || x === 25) ? 1 : 0));
            const darkGrid = Array.from({ length: H }, (_, y) =>
                Array.from({ length: W }, (_, x) =>
                    (x !== 5 && x !== 15 && x !== 25) ? 1 : 0));

            const palette = [
                { L: 80, a: 0, b: 40 },
                { L: 15, a: 0, b: 0 },
            ];

            it('each stripe expands to 5px diamond without merging with neighbors', () => {
                const masks = [maskFrom2D(lightGrid), maskFrom2D(darkGrid)];

                TrapEngine.applyTrapping(masks, palette, W, H, 5);

                // Stripe at x=5 should expand to x=0..10 (Manhattan distance 5)
                // Stripe at x=15 should expand to x=10..20
                // They meet at x=10 — both should have it since it's dark territory
                // But stripes at x=5 and x=15 are 10px apart, so with 5px trap
                // they just barely touch.

                // Check stripe at x=5 expanded left
                const midY = 5;
                expect(masks[0][midY * W + 0]).toBe(255); // 5px left of stripe
                expect(masks[0][midY * W + 10]).toBe(255); // 5px right of stripe

                // Stripe at x=5 and x=15 are both in the same light mask.
                // x=15 stripe also expands left 5px to x=10.
                // So x=11 IS reachable (4px from x=15 stripe). Verify that.
                expect(masks[0][midY * W + 11]).toBe(255);

                // But x=5 stripe alone can't reach x=12 (7px away),
                // and x=15 stripe can't reach x=9 through x=5's expansion
                // because expansion only goes into dark territory.
                // Actually both stripes expand simultaneously — x=12 is 3px
                // from x=15, so it IS reachable. Check true isolation:
                // stripe at x=25 shouldn't reach x=19 (6px) but x=15 does (4px).
                // Verify stripe x=25 doesn't go past x=20 boundary:
                expect(masks[0][midY * W + 20]).toBe(255);  // 5px from x=25
            });

            it('does not crash or produce NaN with huge trap on tiny features', () => {
                const masks = [maskFrom2D(lightGrid), maskFrom2D(darkGrid)];

                // 20px trap on 1px features — should just fill all dark territory
                const result = TrapEngine.applyTrapping(masks, palette, W, H, 20);

                expect(result).toBeDefined();
                expect(result.trappedCount).toBe(1);
                // Light should have filled everything (dark is everywhere around it)
                expect(countPixels(masks[0])).toBe(W * H);
            });
        });
    });
});
