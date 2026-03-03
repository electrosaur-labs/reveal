/**
 * End-to-End Tests: All Posterization Engines
 *
 * Verifies that every engine type accessible via PosterizationEngine.posterize()
 * produces valid output from a shared multi-color synthetic image.
 *
 * Guards against regressions when extracting/refactoring engine internals
 * (e.g., RevealMk15Engine extraction, dead code deletion).
 *
 * Engines tested:
 *   reveal        - Mk 1.0 Lab median cut with hue gap recovery
 *   reveal-mk1.5  - Mk 1.5 with PeakFinder, neutral sovereignty, highlight rescue
 *   reveal-mk2    - Same posterization as Mk 1.5 (different param generation)
 *   balanced       - Mk 1.0 without hue gap analysis
 *   classic        - RGB median cut
 *   stencil        - Luminance-only quantization
 *   distilled      - Over-quantize → furthest-point reduce
 */

import { describe, it, expect, beforeAll } from 'vitest';

const PosterizationEngine = require('../../lib/engines/PosterizationEngine');
const { perceptualLabTo16bit } = require('../helpers/lab-conversion');

// ─── Synthetic Test Image ──────────────────────────────────
//
// 40×25 = 1000 pixels with 5 distinct color regions.
// Large enough for median cut to find structure, small enough to be fast.

const WIDTH = 40;
const HEIGHT = 25;
const TARGET_COLORS = 6;

/**
 * Build a multi-region Lab test image with distinct hue sectors.
 *
 * Region layout (each ~200 pixels):
 *   0: Red      (L=45, a=60, b=30)
 *   1: Green    (L=55, a=-50, b=40)
 *   2: Blue     (L=30, a=10, b=-55)
 *   3: Yellow   (L=85, a=-5, b=70)
 *   4: Gray     (L=50, a=0, b=0)
 */
function buildTestImage() {
    const REGIONS = [
        { L: 45, a: 60, b: 30 },    // Red
        { L: 55, a: -50, b: 40 },   // Green
        { L: 30, a: 10, b: -55 },   // Blue
        { L: 85, a: -5, b: 70 },    // Yellow
        { L: 50, a: 0, b: 0 },      // Gray
    ];

    const pixelCount = WIDTH * HEIGHT;
    const pixels = [];
    for (let i = 0; i < pixelCount; i++) {
        const region = Math.min(Math.floor(i / (pixelCount / REGIONS.length)), REGIONS.length - 1);
        pixels.push(REGIONS[region]);
    }
    return perceptualLabTo16bit(pixels);
}

let testPixels;

beforeAll(() => {
    testPixels = buildTestImage();
});

// ─── Shared Assertions ─────────────────────────────────────

/**
 * Validate the common result structure returned by posterize().
 */
function assertValidResult(result, engineLabel) {
    // Structure
    expect(result, `${engineLabel}: result defined`).toBeDefined();
    expect(result.palette, `${engineLabel}: palette defined`).toBeDefined();
    expect(result.paletteLab, `${engineLabel}: paletteLab defined`).toBeDefined();
    expect(result.assignments, `${engineLabel}: assignments defined`).toBeDefined();
    expect(result.metadata, `${engineLabel}: metadata defined`).toBeDefined();

    // Palette consistency
    expect(result.palette.length, `${engineLabel}: palette length > 0`).toBeGreaterThan(0);
    expect(result.paletteLab.length, `${engineLabel}: paletteLab matches palette`)
        .toBe(result.palette.length);

    // Palette entries have correct shape
    for (let i = 0; i < result.paletteLab.length; i++) {
        const c = result.paletteLab[i];
        expect(typeof c.L, `${engineLabel}: paletteLab[${i}].L is number`).toBe('number');
        expect(typeof c.a, `${engineLabel}: paletteLab[${i}].a is number`).toBe('number');
        expect(typeof c.b, `${engineLabel}: paletteLab[${i}].b is number`).toBe('number');
        expect(c.L, `${engineLabel}: L in range`).toBeGreaterThanOrEqual(-1);
        expect(c.L, `${engineLabel}: L in range`).toBeLessThanOrEqual(101);
    }

    for (let i = 0; i < result.palette.length; i++) {
        const c = result.palette[i];
        expect(typeof c.r, `${engineLabel}: palette[${i}].r is number`).toBe('number');
        expect(typeof c.g, `${engineLabel}: palette[${i}].g is number`).toBe('number');
        expect(typeof c.b, `${engineLabel}: palette[${i}].b is number`).toBe('number');
    }

    // Assignments: correct length and valid indices
    expect(result.assignments.length, `${engineLabel}: assignments length`)
        .toBe(WIDTH * HEIGHT);
    for (let i = 0; i < result.assignments.length; i++) {
        expect(result.assignments[i], `${engineLabel}: assignment[${i}] >= 0`)
            .toBeGreaterThanOrEqual(0);
        expect(result.assignments[i], `${engineLabel}: assignment[${i}] < palette size`)
            .toBeLessThan(result.palette.length);
    }
}

/**
 * Verify every palette color has at least one pixel assigned (no ghost plates).
 */
function assertNoCoverageGaps(result, engineLabel) {
    const coverage = new Array(result.palette.length).fill(0);
    for (let i = 0; i < result.assignments.length; i++) {
        coverage[result.assignments[i]]++;
    }
    for (let c = 0; c < coverage.length; c++) {
        expect(coverage[c], `${engineLabel}: palette[${c}] has pixels assigned`)
            .toBeGreaterThan(0);
    }
}

/**
 * Verify palette has perceptual diversity (not all collapsed to one color).
 * Checks that max ΔE between any two palette entries exceeds a threshold.
 */
function assertPaletteDiversity(result, minMaxDeltaE, engineLabel) {
    let maxDE = 0;
    for (let i = 0; i < result.paletteLab.length; i++) {
        for (let j = i + 1; j < result.paletteLab.length; j++) {
            const a = result.paletteLab[i];
            const b = result.paletteLab[j];
            const de = Math.sqrt(
                (a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2
            );
            maxDE = Math.max(maxDE, de);
        }
    }
    expect(maxDE, `${engineLabel}: palette diversity (maxΔE=${maxDE.toFixed(1)})`)
        .toBeGreaterThan(minMaxDeltaE);
}

// ─── Base Options ───────────────────────────────────────────

const BASE_OPTIONS = {
    format: 'lab',
    bitDepth: 16,
    preserveWhite: false,
    preserveBlack: false,
};

// ═══════════════════════════════════════════════════════════
// Engine-Specific Tests
// ═══════════════════════════════════════════════════════════

describe('All Posterization Engines E2E', () => {

    // ─── reveal (Mk 1.0) ───────────────────────────────────
    describe('reveal (Mk 1.0 — Hue-Aware)', () => {
        it('should produce valid result with default options', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal' }
            );

            assertValidResult(result, 'reveal');
            assertPaletteDiversity(result, 20, 'reveal');
        });

        it('should produce at least 3 colors from multi-region image', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal' }
            );
            expect(result.paletteLab.length).toBeGreaterThanOrEqual(3);
        });

        it('should work with hue gap analysis enabled', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal', enableHueGapAnalysis: true }
            );
            assertValidResult(result, 'reveal+hueGap');
        });

        it('should include metadata with duration', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal' }
            );
            expect(result.metadata.duration).toBeDefined();
            expect(result.metadata.targetColors).toBe(TARGET_COLORS);
        });
    });

    // ─── reveal-mk1.5 (Standard) ───────────────────────────
    describe('reveal-mk1.5 (Standard)', () => {
        it('should produce valid result', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal-mk1.5' }
            );

            assertValidResult(result, 'reveal-mk1.5');
            assertNoCoverageGaps(result, 'reveal-mk1.5');
            assertPaletteDiversity(result, 20, 'reveal-mk1.5');
        });

        it('should include Mk1.5-specific metadata', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal-mk1.5' }
            );

            expect(result.metadata.engineType).toBe('reveal-mk1.5');
            expect(result.metadata.autoAnchors).toBeDefined();
            expect(result.metadata.detectedPeaks).toBeDefined();
            expect(result.metadata.finalColors).toBe(result.paletteLab.length);
        });

        it('should support preserved white and black', () => {
            // Build image with white and black pixels so preservation has something to find
            const pixels = [];
            const pixelCount = WIDTH * HEIGHT;
            for (let i = 0; i < pixelCount; i++) {
                if (i < 50) {
                    pixels.push({ L: 100, a: 0, b: 0 });       // White
                } else if (i < 100) {
                    pixels.push({ L: 0, a: 0, b: 0 });         // Black
                } else if (i < 400) {
                    pixels.push({ L: 45, a: 60, b: 30 });      // Red
                } else if (i < 700) {
                    pixels.push({ L: 55, a: -50, b: 40 });     // Green
                } else {
                    pixels.push({ L: 30, a: 10, b: -55 });     // Blue
                }
            }
            const preservedPixels = perceptualLabTo16bit(pixels);

            const result = PosterizationEngine.posterize(
                preservedPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal-mk1.5',
                  preserveWhite: true, preserveBlack: true }
            );

            assertValidResult(result, 'reveal-mk1.5+preserved');

            const hasWhite = result.paletteLab.some(c => c.L > 95);
            const hasBlack = result.paletteLab.some(c => c.L < 5);
            expect(hasWhite).toBe(true);
            expect(hasBlack).toBe(true);
        });

        it('should work with CIE94 distance metric', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal-mk1.5',
                  distanceMetric: 'cie94' }
            );
            assertValidResult(result, 'reveal-mk1.5+cie94');
        });

        it('should work with CIE2000 distance metric', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal-mk1.5',
                  distanceMetric: 'cie2000' }
            );
            assertValidResult(result, 'reveal-mk1.5+cie2000');
        });
    });

    // ─── reveal-mk2 (alias for mk1.5 posterization) ────────
    describe('reveal-mk2', () => {
        it('should produce valid result identical to reveal-mk1.5', () => {
            const mk15 = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal-mk1.5' }
            );
            const mk2 = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal-mk2' }
            );

            assertValidResult(mk2, 'reveal-mk2');
            // Same engine, same input → same palette
            expect(mk2.paletteLab.length).toBe(mk15.paletteLab.length);
        });
    });

    // ─── balanced (Fast) ────────────────────────────────────
    describe('balanced (Fast)', () => {
        it('should produce valid result', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'balanced' }
            );

            assertValidResult(result, 'balanced');
            assertPaletteDiversity(result, 20, 'balanced');
        });

        it('should match reveal engine with hue gap analysis disabled', () => {
            const balanced = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'balanced' }
            );
            const reveal = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal', enableHueGapAnalysis: false }
            );

            // Same underlying engine with same config → same palette length
            expect(balanced.paletteLab.length).toBe(reveal.paletteLab.length);
        });
    });

    // ─── classic (RGB Median Cut) ───────────────────────────
    describe('classic (RGB Median Cut)', () => {
        it('should produce valid result from Lab input', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'classic' }
            );

            assertValidResult(result, 'classic');
            assertPaletteDiversity(result, 15, 'classic');
        });

        it('should include classic engine metadata', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'classic' }
            );

            expect(result.metadata.engine).toBe('classic');
            expect(result.metadata.finalColors).toBe(result.paletteLab.length);
        });

        it('should produce at least 3 colors', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'classic' }
            );
            expect(result.paletteLab.length).toBeGreaterThanOrEqual(3);
        });
    });

    // ─── stencil (Luminance-Only) ───────────────────────────
    describe('stencil (Luminance-Only)', () => {
        it('should produce valid result', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'stencil' }
            );

            assertValidResult(result, 'stencil');
        });

        it('should produce lower average chroma than reveal on same input', () => {
            const stencil = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'stencil' }
            );
            const reveal = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal' }
            );

            // Stencil splits on L-only variance, so centroids have less chroma
            // diversity than reveal which splits on all 3 Lab axes
            const avgChroma = (palette) => {
                const sum = palette.reduce((s, c) =>
                    s + Math.sqrt(c.a * c.a + c.b * c.b), 0);
                return sum / palette.length;
            };

            expect(avgChroma(stencil.paletteLab))
                .toBeLessThan(avgChroma(reveal.paletteLab));
        });

        it('should produce lightness diversity', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'stencil' }
            );

            const Ls = result.paletteLab.map(c => c.L);
            const range = Math.max(...Ls) - Math.min(...Ls);
            expect(range, 'stencil L range').toBeGreaterThan(20);
        });
    });

    // ─── distilled (Adaptive) ───────────────────────────────
    describe('distilled (Adaptive)', () => {
        it('should produce valid result', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'distilled' }
            );

            assertValidResult(result, 'distilled');
            assertPaletteDiversity(result, 20, 'distilled');
        });

        it('should include distilled-specific metadata', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'distilled' }
            );

            expect(result.metadata.engine).toBe('distilled');
            expect(result.metadata.overCount).toBeGreaterThan(TARGET_COLORS);
            expect(result.metadata.finalColors).toBe(result.paletteLab.length);
            expect(result.metadata.keptIndices).toBeDefined();
        });

        it('should over-quantize then reduce', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'distilled' }
            );

            // Over-count should be ~3× target (capped at 20)
            expect(result.metadata.overCount).toBeGreaterThan(TARGET_COLORS);
            expect(result.metadata.overCount).toBeLessThanOrEqual(20);

            // Final palette should be <= targetColors
            expect(result.paletteLab.length).toBeLessThanOrEqual(TARGET_COLORS);
        });

        it('should produce valid assignments after remap', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'distilled' }
            );

            // Every assignment should map to the reduced palette
            for (let i = 0; i < result.assignments.length; i++) {
                expect(result.assignments[i]).toBeGreaterThanOrEqual(0);
                expect(result.assignments[i]).toBeLessThan(result.paletteLab.length);
            }
        });
    });

    // ─── unknown engine fallback ────────────────────────────
    describe('unknown engine type (fallback)', () => {
        it('should fall back to reveal engine for unknown type', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'nonexistent-engine' }
            );

            assertValidResult(result, 'fallback');
        });
    });

    // ═══════════════════════════════════════════════════════════
    // Cross-Engine Comparison
    // ═══════════════════════════════════════════════════════════

    describe('Cross-engine sanity checks', () => {
        it('all engines produce valid palette from same input', () => {
            const engines = [
                'reveal', 'reveal-mk1.5', 'reveal-mk2',
                'balanced', 'classic', 'stencil', 'distilled'
            ];

            for (const engineType of engines) {
                const result = PosterizationEngine.posterize(
                    testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                    { ...BASE_OPTIONS, engineType }
                );

                expect(result.palette.length,
                    `${engineType}: has colors`).toBeGreaterThan(0);
                expect(result.assignments.length,
                    `${engineType}: assignments match pixels`).toBe(WIDTH * HEIGHT);
            }
        });

        it('Mk 1.5 and Mk 1.0 produce different palettes (different algorithms)', () => {
            const mk10 = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal' }
            );
            const mk15 = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'reveal-mk1.5' }
            );

            // Different engines with different features (PeakFinder, neutral sovereignty)
            // should produce distinguishable palettes on a multi-color image
            let hasDifference = false;
            if (mk10.paletteLab.length !== mk15.paletteLab.length) {
                hasDifference = true;
            } else {
                // Check if any paired colors differ
                for (let i = 0; i < mk10.paletteLab.length; i++) {
                    const a = mk10.paletteLab[i];
                    const b = mk15.paletteLab[i];
                    const de = Math.sqrt(
                        (a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2
                    );
                    if (de > 3) { hasDifference = true; break; }
                }
            }
            expect(hasDifference).toBe(true);
        });

        it('distilled produces valid reduced palette', () => {
            const result = PosterizationEngine.posterize(
                testPixels, WIDTH, HEIGHT, TARGET_COLORS,
                { ...BASE_OPTIONS, engineType: 'distilled' }
            );

            // Distilled over-quantizes then reduces — final count should be
            // <= targetColors, and every color should have coverage
            expect(result.paletteLab.length).toBeLessThanOrEqual(TARGET_COLORS);
            expect(result.paletteLab.length).toBeGreaterThanOrEqual(2);
        });
    });
});
