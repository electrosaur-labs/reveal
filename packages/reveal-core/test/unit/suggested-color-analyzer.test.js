/**
 * Unit Tests for SuggestedColorAnalyzer — K-Means Clustering
 *
 * Tests the K-Means clustering + palette exclusion pipeline:
 *   A. Sample pixels from 16-bit Lab buffer
 *   B. K-Means clustering in Lab space (k=16, 10 iterations)
 *   C. Filter: ΔE > 10 from palette, chroma > 15
 *   D. Dedup (12 ΔE), cap at 6
 */

import { describe, it, expect } from 'vitest';
const SuggestedColorAnalyzer = require('../../lib/analysis/SuggestedColorAnalyzer');

// ─── Helpers ────────────────────────────────────────────────

function lab(L, a, b) {
    return { L, a, b };
}

const L_SCALE = 327.68;
const AB_NEUTRAL = 16384;
const AB_SCALE = 128;

function makeUniformBuffer(w, h, L, a, b) {
    const buf = new Uint16Array(w * h * 3);
    const L16 = Math.round(L * L_SCALE);
    const a16 = Math.round(AB_NEUTRAL + a * AB_SCALE);
    const b16 = Math.round(AB_NEUTRAL + b * AB_SCALE);
    for (let i = 0; i < w * h; i++) {
        buf[i * 3] = L16;
        buf[i * 3 + 1] = a16;
        buf[i * 3 + 2] = b16;
    }
    return buf;
}

function paintRect(buf, w, x0, y0, x1, y1, L, a, b) {
    const L16 = Math.round(L * L_SCALE);
    const a16 = Math.round(AB_NEUTRAL + a * AB_SCALE);
    const b16 = Math.round(AB_NEUTRAL + b * AB_SCALE);
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 3;
            buf[i] = L16;
            buf[i + 1] = a16;
            buf[i + 2] = b16;
        }
    }
}

describe('SuggestedColorAnalyzer', () => {

    describe('Empty / edge cases', () => {
        it('returns empty array for null proxy buffer', () => {
            const result = SuggestedColorAnalyzer.analyze(null, 0, 0, [lab(50, 0, 0)]);
            expect(result).toEqual([]);
        });

        it('returns empty array for empty palette', () => {
            const buf = makeUniformBuffer(10, 10, 50, 0, 0);
            const result = SuggestedColorAnalyzer.analyze(buf, 10, 10, []);
            expect(result).toEqual([]);
        });

        it('returns empty array for tiny image (1×1)', () => {
            const buf = makeUniformBuffer(1, 1, 50, 0, 0);
            const result = SuggestedColorAnalyzer.analyze(buf, 1, 1, [lab(50, 0, 0)]);
            expect(result).toEqual([]);
        });

        it('handles single-color image matching palette', () => {
            const buf = makeUniformBuffer(20, 20, 50, 0, 0);
            const result = SuggestedColorAnalyzer.analyze(buf, 20, 20, [lab(50, 0, 0)]);
            expect(Array.isArray(result)).toBe(true);
            // Uniform image close to palette — no chromatic suggestions
            expect(result.length).toBe(0);
        });
    });

    describe('Palette exclusion', () => {
        it('returns nothing when image colors are close to palette', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 20, 30);
            const palette = [lab(50, 20, 30)]; // exact match
            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(result.length).toBe(0);
        });

        it('finds color far from palette', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);
            // Paint vivid red block (ΔE ~72 from neutral palette)
            paintRect(buf, w, 0, 0, 20, 20, 50, 60, 40);
            const palette = [lab(50, 0, 0)];

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(result.length).toBeGreaterThan(0);
            const found = result.some(s => s.a > 20 && s.b > 10);
            expect(found).toBe(true);
        });

        it('respects custom paletteExclusionDE option', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);
            // Paint a moderate-distance color (ΔE ~20)
            paintRect(buf, w, 0, 0, 20, 20, 50, 16, 12);
            const palette = [lab(50, 0, 0)];

            // Low threshold — should include it
            const r1 = SuggestedColorAnalyzer.analyze(buf, w, h, palette, { paletteExclusionDE: 8 });
            const found1 = r1.some(s => s.a > 5);
            expect(found1).toBe(true);

            // High threshold — should exclude it
            const r2 = SuggestedColorAnalyzer.analyze(buf, w, h, palette, { paletteExclusionDE: 25 });
            const found2 = r2.some(s => s.a > 5);
            expect(found2).toBe(false);
        });
    });

    describe('K-Means finds dominant clusters', () => {
        it('finds two distinct color populations', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);
            // Left half: vivid red
            paintRect(buf, w, 0, 0, 20, 40, 50, 50, 30);
            // Right half: vivid blue
            paintRect(buf, w, 20, 0, 40, 40, 40, -10, -50);
            const palette = [lab(50, 0, 0)]; // neutral palette

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(result.length).toBeGreaterThanOrEqual(2);
        });

        it('larger population clusters survive over smaller ones', () => {
            const w = 80, h = 80;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);
            // Large red region (75% of image)
            paintRect(buf, w, 0, 0, 69, 80, 50, 50, 30);
            // Tiny blue region (1% of image)
            paintRect(buf, w, 70, 0, 73, 10, 40, -10, -50);
            const palette = [lab(50, 0, 0)];

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(result.length).toBeGreaterThan(0);
            // The red cluster should score highest
            expect(result[0].a).toBeGreaterThan(20);
        });
    });

    describe('Chroma filter', () => {
        it('skips near-neutral suggestions (C < 15)', () => {
            const w = 40, h = 40;
            // Near-neutral image, far from palette in lightness but low chroma
            const buf = makeUniformBuffer(w, h, 30, 3, 2); // C ≈ 3.6
            const palette = [lab(80, 0, 0)]; // far away in L

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(result.length).toBe(0);
        });
    });

    describe('Output format', () => {
        it('all suggestions have required fields', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);
            paintRect(buf, w, 0, 0, 20, 20, 50, 50, 30);
            const palette = [lab(50, 0, 0)];

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            for (const s of result) {
                expect(s).toHaveProperty('L');
                expect(s).toHaveProperty('a');
                expect(s).toHaveProperty('b');
                expect(s).toHaveProperty('source');
                expect(s).toHaveProperty('reason');
                expect(s).toHaveProperty('score');
                expect(typeof s.L).toBe('number');
                expect(typeof s.a).toBe('number');
                expect(typeof s.b).toBe('number');
                expect(typeof s.score).toBe('number');
                expect(s.score).toBeGreaterThan(0);
                expect(s.source).toBe('suggested');
            }
        });

        it('results are sorted by score descending', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);
            paintRect(buf, w, 0, 0, 20, 20, 50, 50, 30);
            paintRect(buf, w, 20, 0, 40, 20, 40, -10, -50);
            const palette = [lab(50, 0, 0)];

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            for (let i = 1; i < result.length; i++) {
                expect(result[i - 1].score).toBeGreaterThanOrEqual(result[i].score);
            }
        });
    });

    describe('Dedup', () => {
        it('deduplicates close candidates within 12 ΔE', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);
            // Two very similar red regions (ΔE ~3 apart)
            paintRect(buf, w, 0, 0, 20, 20, 50, 50, 30);
            paintRect(buf, w, 0, 20, 20, 40, 52, 51, 31);
            const palette = [lab(50, 0, 0)];

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            const reds = result.filter(s => s.a > 20 && s.b > 10);
            expect(reds.length).toBe(1);
        });

        it('keeps distinct colors that are far apart', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);
            paintRect(buf, w, 0, 0, 20, 20, 50, 50, 30);
            paintRect(buf, w, 20, 0, 40, 20, 40, -10, -50);
            const palette = [lab(50, 0, 0)];

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(result.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('Cap at max suggestions', () => {
        it('returns at most 6 suggestions by default', () => {
            const w = 80, h = 80;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);
            const colors = [
                [50, 60, 30], [40, -10, -50], [70, -40, 50], [30, 40, -30],
                [80, 10, 60], [35, -30, -20], [60, 50, -10], [45, -50, 30],
            ];
            const patchSize = 10;
            for (let ci = 0; ci < colors.length; ci++) {
                const x0 = (ci % 4) * 20;
                const y0 = Math.floor(ci / 4) * 20;
                paintRect(buf, w, x0, y0, x0 + patchSize, y0 + patchSize, ...colors[ci]);
            }
            const palette = [lab(50, 0, 0)];
            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(result.length).toBeLessThanOrEqual(6);
        });

        it('respects custom maxSuggestions', () => {
            const w = 80, h = 80;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);
            paintRect(buf, w, 0, 0, 40, 40, 50, 60, 30);
            paintRect(buf, w, 40, 0, 80, 40, 40, -10, -50);
            paintRect(buf, w, 0, 40, 40, 80, 70, -40, 50);
            const palette = [lab(50, 0, 0)];

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette, { maxSuggestions: 2 });
            expect(result.length).toBeLessThanOrEqual(2);
        });
    });

    describe('Deterministic results', () => {
        it('produces identical results on repeated calls', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);
            paintRect(buf, w, 0, 0, 20, 20, 50, 50, 30);
            paintRect(buf, w, 20, 0, 40, 20, 40, -10, -50);
            const palette = [lab(50, 0, 0)];

            const r1 = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            const r2 = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(r1.length).toBe(r2.length);
            for (let i = 0; i < r1.length; i++) {
                expect(r1[i].L).toBeCloseTo(r2[i].L, 5);
                expect(r1[i].a).toBeCloseTo(r2[i].a, 5);
                expect(r1[i].b).toBeCloseTo(r2[i].b, 5);
            }
        });
    });

    describe('Substrate skip', () => {
        it('skips white substrate when >30% of pixels are L>92', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 97, 0, 0); // All white (L=97)
            // Paint a vivid red block in top-left quarter (25%)
            paintRect(buf, w, 0, 0, 20, 20, 50, 50, 30);
            const palette = [lab(50, 0, 0)]; // neutral palette

            // 75% white > 30% threshold → substrate skip activates
            // Red block should surface as suggestion (not drowned by white clusters)
            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(result.length).toBeGreaterThan(0);
            const foundRed = result.some(s => s.a > 20 && s.b > 10);
            expect(foundRed).toBe(true);
        });

        it('does NOT skip substrate when <30% of pixels are extreme-L', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 30, 20); // Chromatic fill
            // Paint small white patch (10%) — below 30% threshold
            paintRect(buf, w, 0, 0, 13, 12, 97, 0, 0);
            const palette = [lab(80, 0, 0)]; // far-away palette

            // White patch is <30% → no substrate skip → white pixels sampled normally
            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(result.length).toBeGreaterThan(0);
        });

        it('skips dark substrate when >30% of pixels are L<8', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 3, 0, 0); // All near-black
            // Paint vivid green block (25%)
            paintRect(buf, w, 0, 0, 20, 20, 50, -40, 40);
            const palette = [lab(50, 0, 0)];

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(result.length).toBeGreaterThan(0);
            const foundGreen = result.some(s => s.a < -15 && s.b > 15);
            expect(foundGreen).toBe(true);
        });
    });

    describe('Substrate mode option', () => {
        it('substrateMode "none" disables substrate skip entirely', () => {
            const w = 40, h = 40;
            // 100% white — normally would trigger substrate skip and return []
            const buf = makeUniformBuffer(w, h, 97, 0, 0);
            const palette = [lab(30, 40, 20)]; // far from white

            // With 'auto', all pixels are skipped → no samples → empty
            const autoResult = SuggestedColorAnalyzer.analyze(buf, w, h, palette, { substrateMode: 'auto' });
            expect(autoResult.length).toBe(0);

            // With 'none', white pixels are sampled — but chroma filter kills them (C<15)
            const noneResult = SuggestedColorAnalyzer.analyze(buf, w, h, palette, { substrateMode: 'none' });
            // Near-neutral white has C≈0, so chroma filter removes it → still empty
            expect(noneResult.length).toBe(0);
        });

        it('substrateMode "white" always skips high-L even below 30% threshold', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 40, 30); // Chromatic base
            // 15% white patch — below auto threshold but forced by 'white' mode
            paintRect(buf, w, 0, 0, 10, 24, 97, 0, 0);
            const palette = [lab(80, 0, 0)];

            // With 'auto', 15% < 30% → no skip → white sampled
            // With 'white', white always skipped → only chromatic pixels sampled
            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette, { substrateMode: 'white' });
            // All suggestions should be chromatic (from the base fill), not white
            for (const s of result) {
                expect(s.L).toBeLessThan(90);
            }
        });

        it('substrateMode "black" always skips low-L even below 30% threshold', () => {
            const w = 40, h = 40;
            const buf = makeUniformBuffer(w, h, 50, 40, 30); // Chromatic base
            // 15% black patch — below auto threshold but forced by 'black' mode
            paintRect(buf, w, 0, 0, 10, 24, 3, 0, 0);
            const palette = [lab(80, 0, 0)];

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette, { substrateMode: 'black' });
            for (const s of result) {
                expect(s.L).toBeGreaterThan(10);
            }
        });
    });

    describe('Population-first scoring', () => {
        it('large population cluster outranks small but farther-from-palette cluster', () => {
            const w = 80, h = 80;
            const buf = makeUniformBuffer(w, h, 50, 0, 0); // neutral base

            // Large red region: 50% of image, ΔE ~20 from palette
            paintRect(buf, w, 0, 0, 57, 56, 55, 20, 16);
            // Small blue region: 5% of image, ΔE ~60 from palette (much farther)
            paintRect(buf, w, 60, 0, 72, 26, 40, -10, -50);
            const palette = [lab(50, 0, 0)];

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            expect(result.length).toBeGreaterThanOrEqual(1);
            // Population-first scoring: the large cluster should rank first
            // despite the small one being farther from palette
            if (result.length >= 2) {
                const first = result[0];
                // First result should be the warm/red cluster (positive a and b)
                expect(first.a).toBeGreaterThan(0);
            }
        });

        it('capped distance prevents outlier from dominating', () => {
            // Two clusters: one at ΔE 15, one at ΔE 40 from palette
            // With cap at 20, distance advantage is minimal (20 vs 15)
            // Population should dominate
            const w = 80, h = 80;
            const buf = makeUniformBuffer(w, h, 50, 0, 0);

            // Large cluster: ΔE ~18 from palette, 40% of image
            paintRect(buf, w, 0, 0, 51, 50, 55, 16, 16);
            // Small cluster: ΔE ~50 from palette, 5% of image
            paintRect(buf, w, 55, 0, 67, 26, 30, -30, -30);
            const palette = [lab(50, 0, 0)];

            const result = SuggestedColorAnalyzer.analyze(buf, w, h, palette);
            // Both should pass filters; large should rank higher
            if (result.length >= 2) {
                // First result should be the large warm cluster
                expect(result[0].a).toBeGreaterThan(0);
                expect(result[0].b).toBeGreaterThan(0);
            }
        });
    });

    describe('Helper methods', () => {
        it('_deltaE computes CIE76 correctly', () => {
            expect(SuggestedColorAnalyzer._deltaE(lab(50, 0, 0), lab(50, 0, 0))).toBe(0);
            expect(SuggestedColorAnalyzer._deltaE(lab(50, 0, 0), lab(53, 4, 0))).toBe(5);
            expect(SuggestedColorAnalyzer._deltaE(lab(0, 0, 0), lab(100, 0, 0))).toBe(100);
        });

        it('_minDistToPalette returns minimum distance', () => {
            const palette = [lab(50, 0, 0), lab(30, 40, 10)];
            const color = lab(50, 1, 0);
            expect(SuggestedColorAnalyzer._minDistToPalette(color, palette)).toBeCloseTo(1, 1);
        });

        it('_dedup merges close candidates, keeps highest score', () => {
            const candidates = [
                { L: 50, a: 40, b: 30, score: 10 },
                { L: 52, a: 41, b: 31, score: 15 },
                { L: 30, a: -40, b: -30, score: 12 },
            ];
            const result = SuggestedColorAnalyzer._dedup(candidates, 12);
            expect(result.length).toBe(2);
            expect(result.find(c => c.score === 15)).toBeDefined();
            expect(result.find(c => c.score === 12)).toBeDefined();
        });
    });
});
