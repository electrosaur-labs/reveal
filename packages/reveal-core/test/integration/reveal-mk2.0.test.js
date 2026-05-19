/**
 * RevealMk20Engine integration tests
 *
 * Tests call RevealMk20Engine.posterize() directly (no PosterizationEngine
 * dispatch needed) to validate the two Mk2.0-specific mechanisms:
 *
 * 1. DNA centroid replaces PeakFinder — no image rescan
 * 2. _rescueHighlightsSectors — generalised to all hues, not just warm yellow
 */

import { describe, it, expect } from 'vitest';
import RevealMk20Engine from '../../lib/engines/RevealMk20Engine.js';

// ─── Pixel helpers ────────────────────────────────────────────────────────────

const MAX_L = 32768;
const NEUTRAL_AB = 16384;
const AB_SCALE = 16384 / 128; // 128

function lab16(L, a, b) {
    return [
        Math.round((L / 100) * MAX_L),
        Math.round(NEUTRAL_AB + a * AB_SCALE),
        Math.round(NEUTRAL_AB + b * AB_SCALE)
    ];
}

function makePixels(specs) {
    // specs: [{L, a, b, count}]
    const total = specs.reduce((s, x) => s + x.count, 0);
    const pixels = new Uint16Array(total * 3);
    let idx = 0;
    for (const { L, a, b, count } of specs) {
        const [lv, av, bv] = lab16(L, a, b);
        for (let i = 0; i < count; i++) {
            pixels[idx++] = lv;
            pixels[idx++] = av;
            pixels[idx++] = bv;
        }
    }
    return pixels;
}

const BASE_OPTS = {
    format: 'lab',
    bitDepth: 16,
    preserveWhite: false,
    preserveBlack: false
};

// ─── Synthetic DNA sectors ────────────────────────────────────────────────────

function emptySectors() {
    const names = ['red','orange','yellow','chartreuse','green','cyan','azure','blue','purple','magenta','pink','rose'];
    return Object.fromEntries(names.map(n => [n, { weight: 0, lMean: 0, aMean: 0, bMean: 0, cMean: 0, cMax: 0 }]));
}

// ─── Basic functionality ──────────────────────────────────────────────────────

describe('RevealMk20Engine', () => {
    describe('basic functionality', () => {
        it('returns correct result shape', () => {
            const pixels = makePixels([
                { L: 30, a: 0,   b: 0,   count: 80 },
                { L: 60, a: -20, b: -40, count: 20 }
            ]);

            const result = RevealMk20Engine.posterize(pixels, 10, 10, 5, BASE_OPTS);

            expect(result).toHaveProperty('palette');
            expect(result).toHaveProperty('paletteLab');
            expect(result).toHaveProperty('assignments');
            expect(result).toHaveProperty('metadata');
            expect(result.metadata.engineType).toBe('reveal-mk2');
        });

        it('requires Lab format', () => {
            const pixels = new Uint16Array(30);
            expect(() => RevealMk20Engine.posterize(pixels, 10, 1, 3, { format: 'rgb' }))
                .toThrow('[Reveal Mk 2.0] Requires Lab input format');
        });

        it('produces valid assignments for every pixel', () => {
            const pixels = makePixels([
                { L: 50, a: 30, b: 0,   count: 60 },
                { L: 50, a: 0,  b: -40, count: 40 }
            ]);

            const result = RevealMk20Engine.posterize(pixels, 10, 10, 4, BASE_OPTS);
            const paletteSize = result.paletteLab.length;

            for (const assignment of result.assignments) {
                expect(assignment).toBeGreaterThanOrEqual(0);
                expect(assignment).toBeLessThan(paletteSize);
            }
        });
    });

    // ─── DNA centroid anchor ──────────────────────────────────────────────────

    describe('DNA centroid anchor (replaces PeakFinder)', () => {
        it('records dnaCentroidUsed=true when dnaCentroid is provided', () => {
            const pixels = makePixels([
                { L: 50, a: 0, b: 0, count: 90 },
                { L: 60, a: 40, b: 10, count: 10 }
            ]);

            const result = RevealMk20Engine.posterize(pixels, 10, 10, 4, {
                ...BASE_OPTS,
                dnaCentroid: { L: 60, a: 40, b: 10 }
            });

            expect(result.metadata.dnaCentroidUsed).toBe(true);
        });

        it('records dnaCentroidUsed=false when no dnaCentroid provided', () => {
            const pixels = makePixels([{ L: 50, a: 10, b: 10, count: 100 }]);

            const result = RevealMk20Engine.posterize(pixels, 10, 10, 3, BASE_OPTS);

            expect(result.metadata.dnaCentroidUsed).toBe(false);
        });

        it('injects the DNA centroid into the palette', () => {
            // 90 gray + 10 red pixels. Without forced centroid, red may be dropped.
            // With dnaCentroid pointing at red, it must appear.
            const pixels = makePixels([
                { L: 50, a: 0,  b: 0,  count: 90 },
                { L: 55, a: 45, b: 22, count: 10 }
            ]);

            const dnaCentroid = { L: 55, a: 45, b: 22 };
            const result = RevealMk20Engine.posterize(pixels, 10, 10, 4, {
                ...BASE_OPTS,
                dnaCentroid
            });

            // At least one palette entry should be close to the injected centroid
            const minDE = Math.min(...result.paletteLab.map(c => {
                const dL = c.L - dnaCentroid.L, da = c.a - dnaCentroid.a, db = c.b - dnaCentroid.b;
                return Math.sqrt(dL * dL + da * da + db * db);
            }));

            expect(minDE).toBeLessThan(5);
        });

        it('explicit forcedCentroids takes priority over dnaCentroid', () => {
            const pixels = makePixels([{ L: 50, a: 0, b: 0, count: 100 }]);

            const explicitCentroid = { L: 70, a: 30, b: -30 };
            const dnaCentroid = { L: 60, a: 40, b: 10 };

            const result = RevealMk20Engine.posterize(pixels, 10, 10, 4, {
                ...BASE_OPTS,
                forcedCentroids: [explicitCentroid],
                dnaCentroid
            });

            // dnaCentroidUsed should be false — explicit override took effect
            expect(result.metadata.dnaCentroidUsed).toBe(false);
        });

        it('does not inject anchor when dnaCentroid is null', () => {
            const pixels = makePixels([{ L: 50, a: 20, b: 20, count: 100 }]);

            const result = RevealMk20Engine.posterize(pixels, 10, 10, 3, {
                ...BASE_OPTS,
                dnaCentroid: null
            });

            expect(result.metadata.dnaCentroidUsed).toBe(false);
            expect(result.metadata.autoAnchors).toBe(0);
        });
    });

    // ─── Generalised highlight rescue ─────────────────────────────────────────

    describe('_rescueHighlightsSectors', () => {
        function makeBasePalette() {
            // A palette with no blue coverage
            return [
                { L: 30, a: 0,  b: 0  },
                { L: 50, a: 40, b: 20 },  // orange-red
                { L: 70, a: 20, b: 40 },  // warm yellow
                { L: 45, a: -30, b: -5 }  // green
            ];
        }

        it('rescues a bright blue sector absent from palette', () => {
            const palette = makeBasePalette();
            const sectors = emptySectors();
            sectors.blue = { weight: 0.12, lMean: 88, aMean: -5, bMean: -45, cMean: 45, cMax: 55 };

            // Pixel source: mostly orange, a few bright blue pixels
            const pixels = makePixels([
                { L: 50, a: 40, b: 20, count: 88 },
                { L: 88, a: -5, b: -45, count: 12 }
            ]);
            const pixelSource = new Float32Array(pixels.length);
            const AB_S = 16384 / 128;
            for (let i = 0; i < pixels.length; i += 3) {
                pixelSource[i]     = pixels[i] / (32768 / 100);
                pixelSource[i + 1] = (pixels[i + 1] - 16384) / AB_S;
                pixelSource[i + 2] = (pixels[i + 2] - 16384) / AB_S;
            }

            RevealMk20Engine._rescueHighlightsSectors(palette, pixelSource, sectors, 85);

            // Blue centroid should now be in the palette
            const minDE = Math.min(...palette.map(c => {
                const dL = c.L - 88, da = c.a - (-5), db = c.b - (-45);
                return Math.sqrt(dL * dL + da * da + db * db);
            }));
            expect(minDE).toBeLessThan(1);
        });

        it('does not rescue a sector already covered by the palette', () => {
            const palette = [
                { L: 30, a: 0,   b: 0   },
                { L: 88, a: -6,  b: -44 },  // already covers blue
                { L: 50, a: 40,  b: 20  },
                { L: 45, a: -30, b: -5  }
            ];
            const originalPalette = palette.map(c => ({ ...c }));

            const sectors = emptySectors();
            sectors.blue = { weight: 0.12, lMean: 88, aMean: -5, bMean: -45, cMean: 45, cMax: 55 };

            const pixelSource = new Float32Array([50, 0, 0, 88, -5, -45]); // 2 pixels

            RevealMk20Engine._rescueHighlightsSectors(palette, pixelSource, sectors, 85);

            // Palette should be unchanged
            for (let i = 0; i < palette.length; i++) {
                expect(palette[i].L).toBeCloseTo(originalPalette[i].L);
                expect(palette[i].a).toBeCloseTo(originalPalette[i].a);
                expect(palette[i].b).toBeCloseTo(originalPalette[i].b);
            }
        });

        it('does not rescue a sector below the luminance threshold', () => {
            const palette = makeBasePalette();
            const originalPalette = palette.map(c => ({ ...c }));

            const sectors = emptySectors();
            // lMean=60 is below threshold=85 → should not trigger rescue
            sectors.blue = { weight: 0.15, lMean: 60, aMean: -5, bMean: -45, cMean: 45, cMax: 55 };

            const pixelSource = new Float32Array([60, -5, -45]);

            RevealMk20Engine._rescueHighlightsSectors(palette, pixelSource, sectors, 85);

            for (let i = 0; i < palette.length; i++) {
                expect(palette[i].L).toBeCloseTo(originalPalette[i].L);
            }
        });

        it('does not rescue a sector with negligible pixel presence', () => {
            const palette = makeBasePalette();
            const originalPalette = palette.map(c => ({ ...c }));

            const sectors = emptySectors();
            // weight=0.003 < MIN_SECTOR_WEIGHT=0.005
            sectors.blue = { weight: 0.003, lMean: 90, aMean: -5, bMean: -45, cMean: 45, cMax: 55 };

            const pixelSource = new Float32Array([50, 40, 20, 50, 40, 20]);

            RevealMk20Engine._rescueHighlightsSectors(palette, pixelSource, sectors, 85);

            for (let i = 0; i < palette.length; i++) {
                expect(palette[i].L).toBeCloseTo(originalPalette[i].L);
            }
        });

        it('does not rescue a near-neutral bright sector', () => {
            const palette = makeBasePalette();
            const originalPalette = palette.map(c => ({ ...c }));

            const sectors = emptySectors();
            // cMean=8 < MIN_SECTOR_CHROMA=15 — too neutral to be a colour anchor
            sectors.yellow = { weight: 0.20, lMean: 92, aMean: 2, bMean: 7, cMean: 8, cMax: 12 };

            const pixelSource = new Float32Array([50, 40, 20, 50, 40, 20]);

            RevealMk20Engine._rescueHighlightsSectors(palette, pixelSource, sectors, 85);

            for (let i = 0; i < palette.length; i++) {
                expect(palette[i].L).toBeCloseTo(originalPalette[i].L);
            }
        });

        it('rescues multiple bright sectors with one coverage scan', () => {
            const palette = [
                { L: 30, a: 0, b: 0 },
                { L: 50, a: 40, b: 20 },
                { L: 45, a: -30, b: -5 },
                { L: 40, a: 5, b: 5 }
            ];

            const sectors = emptySectors();
            // Two bright uncovered sectors
            sectors.blue = { weight: 0.10, lMean: 88, aMean: -5, bMean: -45, cMean: 45, cMax: 55 };
            sectors.cyan = { weight: 0.08, lMean: 90, aMean: -30, bMean: -20, cMean: 36, cMax: 42 };

            const pixelSource = new Float32Array([
                50, 40, 20,  50, 40, 20,  45, -30, -5,  40, 5, 5
            ]);

            RevealMk20Engine._rescueHighlightsSectors(palette, pixelSource, sectors, 85);

            // Blue (higher weight) and cyan should both appear in palette
            const blueDE = Math.min(...palette.map(c => {
                const d = (c.L - 88) ** 2 + (c.a - (-5)) ** 2 + (c.b - (-45)) ** 2;
                return Math.sqrt(d);
            }));
            const cyanDE = Math.min(...palette.map(c => {
                const d = (c.L - 90) ** 2 + (c.a - (-30)) ** 2 + (c.b - (-20)) ** 2;
                return Math.sqrt(d);
            }));

            expect(blueDE).toBeLessThan(1);
            expect(cyanDE).toBeLessThan(1);
        });
    });
});
