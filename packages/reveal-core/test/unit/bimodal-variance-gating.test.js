/**
 * Bimodal Variance Gating (BVG) — Macro-Cell edge color correctness
 *
 * Regression suite for a real reported defect: a 6x6 macro-cell block
 * straddling a hard edge (e.g. cream lettering against a dark background)
 * gets averaged into a "phantom centroid" Lab value that can land closer
 * to an UNRELATED palette color (e.g. green, present nowhere near the
 * edge) than to either true neighbor -- producing stray fringing along
 * every letter/brick edge in the image. Full derivation and the worked
 * numeric example this test's fixture values come from: collab/debate.md,
 * 2026-11-12, "Macro-Cell NN Edge Color Selection" thread.
 *
 * Fix: track each block's perceptual variance for free during the
 * existing accumulation pass. Unimodal (gradient) blocks are untouched.
 * Bimodal (edge) blocks get a targeted re-read of their own raw pixels,
 * restrict nearest-neighbor matching to locally-represented colors only
 * (population floor, not a fixed top-2 -- handles T-junctions), and
 * suppress their own outgoing diffused error so a mis-sized boundary
 * step can't bleed into neighboring blocks.
 */

const SeparationEngine = require('../../lib/engines/SeparationEngine');

const labTo16bit = (L, a, b) => ({
    L: Math.round((L / 100) * 32768),
    a: Math.round((a / 128) * 16384 + 16384),
    b: Math.round((b / 128) * 16384 + 16384)
});

const setPixel = (rawBytes, width, x, y, L, a, b) => {
    const i = (y * width + x) * 3;
    const lab16 = labTo16bit(L, a, b);
    rawBytes[i] = lab16.L;
    rawBytes[i + 1] = lab16.a;
    rawBytes[i + 2] = lab16.b;
};

// Palette matching the Architect's worked example exactly: averaging
// DARK and CREAM produces a phantom centroid at ~(50, 1, 7.5), which is
// ~7x closer (by squared ΔE) to GREEN than to either real color.
const DARK = { L: 15, a: 0, b: 0 };
const CREAM = { L: 85, a: 2, b: 15 };
const GREEN = { L: 50, a: -10, b: 15 };
const PALETTE = [DARK, CREAM, GREEN];
const GREEN_IDX = 2;

// meshCount=355, dpi=300 -> scale=6 (the production default, and the
// exact cell size from the original bug report).
const MESH_COUNT = 355;
const DPI = 300;
const SCALE = 6;

describe('Bimodal Variance Gating', () => {
    for (const ditherType of ['floyd-steinberg', 'atkinson', 'stucki']) {
        describe(ditherType, () => {
            it('never selects a color absent from both sides of a hard edge, even though it is the phantom-centroid nearest match', async () => {
                // One 6x6 block: left half dark, right half cream -- a
                // clean 50/50 vertical split straight down the middle of
                // the block, guaranteeing the averaged mean is the exact
                // phantom-centroid case from the worked example.
                const width = SCALE, height = SCALE;
                const rawBytes = new Uint16Array(width * height * 3);
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const c = x < width / 2 ? DARK : CREAM;
                        setPixel(rawBytes, width, x, y, c.L, c.a, c.b);
                    }
                }

                const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
                    rawBytes, PALETTE, null, width, height,
                    { ditherType, meshCount: MESH_COUNT, dpi: DPI }
                );

                expect(Array.from(colorIndices)).not.toContain(GREEN_IDX);
            });

            it('does not let a mis-colored edge block\'s error bleed into an adjacent flat background block', async () => {
                // 12x6: block 0 (cols 0-5) straddles dark/cream as above;
                // block 1 (cols 6-11) is pure, uniform dark -- nowhere
                // near an edge. Without error decoupling, a boundary
                // block's large quantization error (diffused via
                // Floyd-Steinberg/Atkinson/Stucki) would pull this
                // adjacent flat region toward cream or green.
                const width = SCALE * 2, height = SCALE;
                const rawBytes = new Uint16Array(width * height * 3);
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        let c;
                        if (x < SCALE) {
                            c = x < SCALE / 2 ? DARK : CREAM; // block 0: straddling
                        } else {
                            c = DARK; // block 1: flat background
                        }
                        setPixel(rawBytes, width, x, y, c.L, c.a, c.b);
                    }
                }

                const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
                    rawBytes, PALETTE, null, width, height,
                    { ditherType, meshCount: MESH_COUNT, dpi: DPI }
                );

                // Every pixel in block 1 (cols 6-11) must still be DARK.
                for (let y = 0; y < height; y++) {
                    for (let x = SCALE; x < width; x++) {
                        expect(colorIndices[y * width + x]).toBe(0); // DARK's palette index
                    }
                }
            });

            it('leaves a genuine smooth gradient untouched (BVG does not fire on unimodal blocks)', async () => {
                // A gradient spanning the full palette's L range over many
                // pixels keeps any single 6px block's internal spread
                // small (~1-2 ΔE std-dev per the derivation) -- well under
                // the bimodal threshold. Confirms BVG's gating is
                // selective, not a blanket restriction.
                const width = 48, height = 6;
                const gradientPalette = [
                    { L: 10, a: 0, b: 0 }, { L: 30, a: 0, b: 0 }, { L: 50, a: 0, b: 0 },
                    { L: 70, a: 0, b: 0 }, { L: 90, a: 0, b: 0 }
                ];
                const rawBytes = new Uint16Array(width * height * 3);
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const t = x / width;
                        setPixel(rawBytes, width, x, y, 10 + t * 80, 0, 0);
                    }
                }

                const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
                    rawBytes, gradientPalette, null, width, height,
                    { ditherType, meshCount: MESH_COUNT, dpi: DPI }
                );

                // The gradient should still traverse multiple palette
                // steps (not collapse to 2 candidates the way a flagged
                // edge block would) -- a regression here would mean BVG
                // is incorrectly firing on tonal gradients.
                const distinctValues = new Set(colorIndices);
                expect(distinctValues.size).toBeGreaterThan(2);
            });

            it('T-junction: a block where 3 real colors meet keeps all 3 as candidates, not just the top 2', async () => {
                // 6x6 block split into three roughly-equal vertical bands
                // (2 columns each = 12px per color, well over the 10%
                // population floor for 36px). A fixed top-2 cap would
                // arbitrarily exclude one of three legitimate colors;
                // the population-floor approach should not.
                const third = { L: 45, a: 20, b: -30 }; // distinct from DARK/CREAM/GREEN
                const palette = [DARK, CREAM, GREEN, third];
                const width = SCALE, height = SCALE;
                const rawBytes = new Uint16Array(width * height * 3);
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const c = x < 2 ? DARK : (x < 4 ? CREAM : third);
                        setPixel(rawBytes, width, x, y, c.L, c.a, c.b);
                    }
                }

                const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
                    rawBytes, palette, null, width, height,
                    { ditherType, meshCount: MESH_COUNT, dpi: DPI }
                );

                // Under Dual-Scale Edge-Adaptive resolution, a bimodal/multimodal
                // structural edge block resolves each pixel at native 1px precision
                // to its closest local candidate. For this T-junction where DARK,
                // CREAM, and third meet:
                // 1. Green (index 2) is strictly barred from all pixels.
                // 2. All 3 legitimate local colors are preserved at 1px contour precision.
                const distinctValues = new Set(colorIndices);
                expect(distinctValues).not.toContain(GREEN_IDX);
                for (const v of distinctValues) {
                    expect([0, 1, 3]).toContain(v); // DARK, CREAM, or third
                }
                expect(distinctValues.size).toBe(3); // All 3 legitimate regions preserved at 1px precision
            });
        });
    }

    it('without meshCount (scale=1), behaves exactly as before -- BVG only applies to macro-celled dithering', async () => {
        const width = SCALE, height = SCALE;
        const rawBytes = new Uint16Array(width * height * 3);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const c = x < width / 2 ? DARK : CREAM;
                setPixel(rawBytes, width, x, y, c.L, c.a, c.b);
            }
        }

        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            rawBytes, PALETTE, null, width, height,
            { ditherType: 'floyd-steinberg' } // no meshCount -> scale=1, per-pixel, no BVG
        );

        // Per-pixel (unwrapped) dithering has no concept of a "block" to
        // flag bimodal in the first place -- confirms this path is
        // simply never touched by BVG rather than relying on it to
        // coincidentally also avoid green.
        expect(Array.from(colorIndices)).not.toContain(GREEN_IDX);
    });
});
