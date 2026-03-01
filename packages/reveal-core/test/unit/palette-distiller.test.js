/**
 * Unit Tests: PaletteDistiller — Over-quantize → Furthest-Point Reduce
 *
 * Key scenario validated: a warm image where direct K-color quantization
 * collapses orange and golden yellow into the same bucket because L* variance
 * dominates median cut splits. Distillation must capture both.
 */

import { describe, test, expect, beforeAll } from 'vitest';

const { PaletteDistiller, OVER_FACTOR, OVER_MAX, MIN_COVERAGE } = require('../../lib/engines/PaletteDistiller');
const PosterizationEngine = require('../../lib/engines/PosterizationEngine');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a 16-bit Lab pixel buffer from an array of {L,a,b,count} colors. */
function buildLabPixels(colors) {
    const total = colors.reduce((s, c) => s + c.count, 0);
    const buf   = new Uint16Array(total * 3);
    let off = 0;
    for (const { L, a, b, count } of colors) {
        const lv = Math.round((L / 100)  * 32768);
        const av = Math.round((a / 128)  * 16384 + 16384);
        const bv = Math.round((b / 128)  * 16384 + 16384);
        for (let i = 0; i < count; i++) {
            buf[off++] = lv;
            buf[off++] = av;
            buf[off++] = bv;
        }
    }
    return { pixels: buf, total };
}

/** ΔE (Euclidean Lab) between two {L,a,b} colors. */
function deltaE(c1, c2) {
    return Math.sqrt((c1.L - c2.L) ** 2 + (c1.a - c2.a) ** 2 + (c1.b - c2.b) ** 2);
}

/** True if any color in palette is within maxDeltaE of target. */
function paletteContains(palette, target, maxDeltaE = 8) {
    return palette.some(c => deltaE(c, target) <= maxDeltaE);
}

// ── Warm-Image Colors (horse-like) ───────────────────────────────────────────
// Direct 6-color quantization collapses ORANGE and GOLDEN_YELLOW because
// L* variance (~58 units) swamps b* hue variance (~32 units).
const WARM_COLORS = [
    { L: 55, a: 22, b: 44, count: 2000, name: 'orange-brown'  }, // dominant
    { L: 45, a: 18, b: 36, count: 1500, name: 'dark-orange'   },
    { L: 65, a: 25, b: 52, count: 1200, name: 'mid-orange'    },
    { L: 88, a: 10, b: 72, count:  600, name: 'golden-yellow' }, // ← must survive
    { L: 25, a:  8, b: 18, count:  500, name: 'deep-shadow'   },
    { L: 92, a:  2, b:  6, count:  400, name: 'highlight'     },
];
const TOTAL = WARM_COLORS.reduce((s, c) => s + c.count, 0); // 6200 pixels
const W = 62, H = 100; // 6200 pixels arranged in a grid

// ── PaletteDistiller unit tests ───────────────────────────────────────────────

describe('PaletteDistiller.overQuantizeCount', () => {
    test('returns 3× target, capped at 20', () => {
        expect(PaletteDistiller.overQuantizeCount(3)).toBe(9);
        expect(PaletteDistiller.overQuantizeCount(6)).toBe(18);
        expect(PaletteDistiller.overQuantizeCount(7)).toBe(20); // capped
        expect(PaletteDistiller.overQuantizeCount(10)).toBe(20); // capped
    });

    test('never returns less than 3', () => {
        expect(PaletteDistiller.overQuantizeCount(1)).toBeGreaterThanOrEqual(3);
    });
});

describe('PaletteDistiller.distill — pure algorithm', () => {
    test('returns exactly targetK colors', () => {
        // Build a simple 10-color palette spread in Lab space
        const palette = Array.from({ length: 10 }, (_, i) => ({
            L: 10 + i * 8, a: i * 3, b: i * 4
        }));
        const assignments = new Uint8Array(100);
        for (let i = 0; i < 100; i++) assignments[i] = i % 10;

        const { palette: out } = PaletteDistiller.distill(palette, assignments, 100, 4);
        expect(out.length).toBe(4);
    });

    test('K >= N returns all colors unchanged', () => {
        const palette = [
            { L: 50, a: 10, b: 20 },
            { L: 70, a: 5,  b: 40 },
        ];
        const assignments = new Uint8Array([0, 1, 0]);
        const { palette: out, remap } = PaletteDistiller.distill(palette, assignments, 3, 5);
        expect(out.length).toBe(2);
        expect(remap[0]).toBe(0);
        expect(remap[1]).toBe(1);
    });

    test('selected colors are maximally spread in Lab space', () => {
        // 5 equidistant colors along the L* axis — selecting 3 should pick
        // the extremes + middle, not three adjacent ones.
        const palette = [
            { L: 10, a: 0, b: 0 },
            { L: 30, a: 0, b: 0 },
            { L: 50, a: 0, b: 0 },
            { L: 70, a: 0, b: 0 },
            { L: 90, a: 0, b: 0 },
        ];
        const assignments = new Uint8Array(50);
        for (let i = 0; i < 50; i++) assignments[i] = i % 5;
        const { selected } = PaletteDistiller.distill(palette, assignments, 50, 3);
        // The 3 selected should not all be neighbours
        const Ls = selected.map(i => palette[i].L).sort((a, b) => a - b);
        const span = Ls[Ls.length - 1] - Ls[0];
        expect(span).toBeGreaterThan(40); // must span most of the L* range
    });

    test('remap maps every old index to a valid new index', () => {
        const palette = Array.from({ length: 8 }, (_, i) => ({
            L: 20 + i * 10, a: i * 2, b: i * 3
        }));
        const assignments = new Uint8Array(80);
        for (let i = 0; i < 80; i++) assignments[i] = i % 8;
        const { remap, palette: out } = PaletteDistiller.distill(palette, assignments, 80, 3);
        expect(remap.length).toBe(8);
        for (let i = 0; i < 8; i++) {
            expect(remap[i]).toBeGreaterThanOrEqual(0);
            expect(remap[i]).toBeLessThan(out.length);
        }
    });
});

// ── Integration: distilledPosterize on synthetic warm image ───────────────────

describe('PosterizationEngine.distilledPosterize — warm image', () => {
    const GOLDEN_YELLOW = { L: 88, a: 10, b: 72 };

    let directResult, distilledResult;
    const { pixels } = buildLabPixels(WARM_COLORS);
    const TARGET_K = 5;

    beforeAll(() => {
        const opts = { bitDepth: 16, engineType: 'reveal-mk2', format: 'lab' };
        directResult    = PosterizationEngine.posterize(pixels, W, H, TARGET_K, opts);
        distilledResult = PosterizationEngine.distilledPosterize(pixels, W, H, TARGET_K, opts);
    });

    test('distilledPosterize returns correct field shape', () => {
        expect(distilledResult).toHaveProperty('paletteLab');
        expect(distilledResult).toHaveProperty('palette');
        expect(distilledResult).toHaveProperty('assignments');
        expect(distilledResult).toHaveProperty('metadata');
        expect(distilledResult.metadata.engine).toBe('distilled');
    });

    test('distilledPosterize returns exactly targetK colors', () => {
        expect(distilledResult.paletteLab.length).toBe(TARGET_K);
    });

    test('assignments cover all pixels', () => {
        expect(distilledResult.assignments.length).toBe(W * H);
    });

    test('all assignment indices are valid palette indices', () => {
        const K = distilledResult.paletteLab.length;
        for (let i = 0; i < distilledResult.assignments.length; i++) {
            expect(distilledResult.assignments[i]).toBeLessThan(K);
        }
    });

    test('distilled palette captures golden yellow (ΔE < 8 from target)', () => {
        const hit = paletteContains(distilledResult.paletteLab, GOLDEN_YELLOW, 8);
        expect(hit).toBe(true);
    });

    test('distilled palette also captures deep shadow and highlight', () => {
        const SHADOW    = { L: 25, a: 8,  b: 18 };
        const HIGHLIGHT = { L: 92, a: 2,  b:  6 };
        expect(paletteContains(distilledResult.paletteLab, SHADOW,    10)).toBe(true);
        expect(paletteContains(distilledResult.paletteLab, HIGHLIGHT, 10)).toBe(true);
    });

    test('metadata includes overCount and keptIndices', () => {
        expect(distilledResult.metadata.overCount).toBeGreaterThan(TARGET_K);
        expect(distilledResult.metadata.keptIndices).toHaveLength(TARGET_K);
    });
});

// ── Ghost-color exclusion ─────────────────────────────────────────────────────
// Regression: the over-quantizer can produce near-zero-coverage buckets (stray
// pixel artifacts). Because they sit far in Lab space from the warm palette,
// the furthest-point algorithm would select them, wasting a color slot on a
// phantom. Colors below MIN_COVERAGE must be excluded from selection.

describe('PaletteDistiller.distill — ghost exclusion', () => {
    // 8 warm orange/brown colors representing a carrots-like image.
    // One stray blue color with just 2 pixels out of 10000 (0.02% — well below
    // the 0.1% MIN_COVERAGE threshold). It is maximally far in Lab space and
    // would normally be chosen first by furthest-point without the guard.
    const PIXEL_COUNT = 10_000;
    const GHOST_PIXELS = 2; // 0.02% — below MIN_COVERAGE threshold
    const palette = [
        { L: 55, a: 25, b: 50 }, // dominant orange
        { L: 65, a: 20, b: 55 }, // mid orange
        { L: 45, a: 30, b: 45 }, // dark orange
        { L: 75, a: 15, b: 60 }, // light orange
        { L: 35, a: 10, b: 30 }, // brown shadow
        { L: 85, a:  5, b: 25 }, // warm highlight
        { L: 50, a: 22, b: 40 }, // mid brown
        { L: 60, a: 18, b: 48 }, // warm mid
        { L: 65, a: 15, b: -42 }, // GHOST — stray blue, maximally distant
    ];
    const N = palette.length;
    const ghostIdx = 8;

    // Build assignments: GHOST_PIXELS → index 8, rest spread evenly over 0-7
    const assignments = new Uint8Array(PIXEL_COUNT);
    const warmPixels = PIXEL_COUNT - GHOST_PIXELS;
    for (let i = 0; i < warmPixels; i++) assignments[i] = i % 8;
    for (let i = warmPixels; i < PIXEL_COUNT; i++) assignments[i] = ghostIdx;

    test('ghost color (< MIN_COVERAGE) is excluded from selection', () => {
        const { selected } = PaletteDistiller.distill(palette, assignments, PIXEL_COUNT, 5);
        expect(selected).not.toContain(ghostIdx);
    });

    test('all selected colors are warm (non-ghost)', () => {
        const { palette: out } = PaletteDistiller.distill(palette, assignments, PIXEL_COUNT, 5);
        for (const c of out) {
            // No selected color should have negative b* (the ghost blue)
            expect(c.b).toBeGreaterThan(0);
        }
    });

    test('MIN_COVERAGE threshold is documented and exportable', () => {
        expect(typeof MIN_COVERAGE).toBe('number');
        expect(MIN_COVERAGE).toBeGreaterThan(0);
        expect(MIN_COVERAGE).toBeLessThan(0.01); // sanity: below 1%
    });
});
