import { describe, test, expect } from 'vitest';

const PosterizationEngine = require('../../lib/engines/PosterizationEngine');
const LabDistance = require('../../lib/color/LabDistance');

/**
 * Isolated tests for _prunePalette cross-metric behavior.
 *
 * Validates that the metric-aware dispatch (CIE76 vs CIE94 vs CIE2000)
 * produces different merge decisions for the same palette, reflecting
 * the perceptual differences between metrics.
 */

// Lab colors used across tests — human-readable {L, a, b}
const YELLOW_A = { L: 89, a: -1, b: 84 };
const YELLOW_B = { L: 89, a: -1, b: 85 };  // Near-duplicate (ΔE76=1.0, ΔE00≈0.21)

const PINK_A = { L: 62, a: 76, b: -45 };
const PINK_B = { L: 66, a: 68, b: -40 };   // Distinct (ΔE76≈10.3, ΔE00≈3.88)

const RED = { L: 45, a: 60, b: 40 };
const GREEN = { L: 55, a: -50, b: 35 };
const BLUE = { L: 30, a: 20, b: -60 };
const BLACK = { L: 5, a: 0, b: 0 };
const WHITE = { L: 95, a: 0, b: 0 };
const NEUTRAL = { L: 50, a: 0, b: 0 };

// Two dark colors close in CIE76 but different perceptually
const DARK_A = { L: 8, a: 2, b: -3 };
const DARK_B = { L: 12, a: 1, b: -2 };  // ΔL=4, low chroma → CIE76 small, CIE2000 may differ

// Custom tuning that disables hue lock for clean metric tests
const TUNING_NO_HUELOCK = {
    prune: {
        threshold: 5,
        whitePoint: 92,
        shadowPoint: 10,
        hueLockAngle: 360  // Effectively disabled
    }
};

describe('_prunePalette — cross-metric behavior', () => {
    describe('near-duplicate yellows (ΔE76=1.0, ΔE2000≈0.21)', () => {
        test('CIE76 merges yellows at threshold 2.0', () => {
            const palette = [YELLOW_A, YELLOW_B, RED, BLUE];
            const result = PosterizationEngine._prunePalette(
                palette, 2.0, 92, 0, TUNING_NO_HUELOCK, 'cie76'
            );
            expect(result.length).toBe(3); // One yellow removed
        });

        test('CIE94 merges yellows at threshold 2.0', () => {
            const palette = [YELLOW_A, YELLOW_B, RED, BLUE];
            const result = PosterizationEngine._prunePalette(
                palette, 2.0, 92, 0, TUNING_NO_HUELOCK, 'cie94'
            );
            expect(result.length).toBe(3);
        });

        test('CIE2000 merges yellows at threshold 2.0', () => {
            const palette = [YELLOW_A, YELLOW_B, RED, BLUE];
            const result = PosterizationEngine._prunePalette(
                palette, 2.0, 92, 0, TUNING_NO_HUELOCK, 'cie2000'
            );
            expect(result.length).toBe(3);
        });

        test('confirms CIE2000 distance between yellows is < 1.0', () => {
            const dist = LabDistance.cie2000(YELLOW_A, YELLOW_B);
            expect(dist).toBeLessThan(1.0);
        });

        test('confirms CIE76 distance between yellows is ~1.0', () => {
            const dL = YELLOW_A.L - YELLOW_B.L;
            const da = YELLOW_A.a - YELLOW_B.a;
            const db = YELLOW_A.b - YELLOW_B.b;
            const dist = Math.sqrt(dL * dL + da * da + db * db);
            expect(dist).toBeCloseTo(1.0, 1);
        });
    });

    describe('two pinks (ΔE76≈10.3, ΔE2000≈3.88)', () => {
        test('CIE76 does NOT merge pinks at threshold 8.0', () => {
            const palette = [PINK_A, PINK_B, RED, BLUE];
            const result = PosterizationEngine._prunePalette(
                palette, 8.0, 92, 0, TUNING_NO_HUELOCK, 'cie76'
            );
            // CIE76 distance ~10.3 > threshold 8 → should NOT merge
            expect(result.length).toBe(4);
        });

        test('CIE2000 DOES merge pinks at threshold 8.0', () => {
            const palette = [PINK_A, PINK_B, RED, BLUE];
            const result = PosterizationEngine._prunePalette(
                palette, 8.0, 92, 0, TUNING_NO_HUELOCK, 'cie2000'
            );
            // CIE2000 distance ~3.88 < threshold 8 → should merge
            expect(result.length).toBe(3);
        });

        test('CIE2000 does NOT merge pinks at threshold 3.0', () => {
            const palette = [PINK_A, PINK_B, RED, BLUE];
            const result = PosterizationEngine._prunePalette(
                palette, 3.0, 92, 0, TUNING_NO_HUELOCK, 'cie2000'
            );
            // CIE2000 distance ~3.88 > threshold 3 → should NOT merge
            expect(result.length).toBe(4);
        });

        test('confirms CIE2000 distance between pinks is ~3.88', () => {
            const dist = LabDistance.cie2000(PINK_A, PINK_B);
            expect(dist).toBeCloseTo(3.88, 0);
        });
    });

    describe('metric dispatch correctness', () => {
        test('cie76 uses L-weighted distance for dark pairs (avgL < 40)', () => {
            // Two dark neutrals: avgL = 10, very close in Lab
            const darkA = { L: 8, a: 0, b: 0 };
            const darkB = { L: 12, a: 0, b: 0 };
            // CIE76 L-weighted for dark: dL=4, lWeight=2.0 → weighted dist = sqrt(4*4*4) = 8
            // Without L-weight: dist = sqrt(16) = 4
            // At threshold 5.0: L-weighted version should NOT merge (8 > 5)
            const palette = [darkA, darkB, RED];
            const result = PosterizationEngine._prunePalette(
                palette, 5.0, 92, 0, TUNING_NO_HUELOCK, 'cie76'
            );
            expect(result.length).toBe(3); // Should NOT merge due to L-weighting
        });

        test('cie2000 does not use L-weighting (handles dark perceptually)', () => {
            const darkA = { L: 8, a: 0, b: 0 };
            const darkB = { L: 12, a: 0, b: 0 };
            const dist = LabDistance.cie2000(darkA, darkB);
            // CIE2000 handles dark regions with its own SL term
            expect(dist).toBeGreaterThan(0);
            expect(typeof dist).toBe('number');
        });
    });

    describe('targetCount early termination', () => {
        test('stops merging when palette reaches targetCount', () => {
            // 5 somewhat similar colors
            const palette = [
                { L: 50, a: 10, b: 10 },
                { L: 51, a: 11, b: 11 },  // Close to first
                { L: 52, a: 12, b: 12 },  // Close to first two
                { L: 80, a: -30, b: 40 },
                { L: 20, a: 5, b: -50 },
            ];
            const result = PosterizationEngine._prunePalette(
                palette, 10.0, 92, 4, TUNING_NO_HUELOCK, 'cie2000'
            );
            // Should stop at 4 even though more merges are possible
            expect(result.length).toBe(4);
        });

        test('targetCount=0 means no early termination', () => {
            const palette = [
                { L: 50, a: 10, b: 10 },
                { L: 51, a: 11, b: 11 },
                { L: 80, a: -30, b: 40 },
            ];
            const resultWithTarget = PosterizationEngine._prunePalette(
                palette, 10.0, 92, 2, TUNING_NO_HUELOCK, 'cie2000'
            );
            const resultNoTarget = PosterizationEngine._prunePalette(
                palette, 10.0, 92, 0, TUNING_NO_HUELOCK, 'cie2000'
            );
            // With target=2, stops early; without target, merges all it can
            expect(resultWithTarget.length).toBeGreaterThanOrEqual(2);
            expect(resultNoTarget.length).toBeLessThanOrEqual(resultWithTarget.length);
        });
    });

    describe('hue lock protection', () => {
        test('colors with different hues survive even when close in ΔE', () => {
            // Red and green with moderate ΔE
            const warmRed = { L: 50, a: 40, b: 30 };   // Hue ~36°
            const warmOrange = { L: 52, a: 35, b: 45 }; // Hue ~52°
            // Close in Lab distance but different hues

            const tuningStrictHue = {
                prune: {
                    threshold: 20,
                    whitePoint: 92,
                    shadowPoint: 10,
                    hueLockAngle: 10  // Very strict hue lock
                }
            };
            const palette = [warmRed, warmOrange, BLUE];
            const result = PosterizationEngine._prunePalette(
                palette, 20.0, 92, 0, tuningStrictHue, 'cie76'
            );
            // Should keep both despite being close, due to hue lock
            expect(result.length).toBe(3);
        });

        test('achromatic colors (low chroma) bypass hue lock', () => {
            // Two near-neutral grays: chroma < 5, so hue lock is skipped
            const grayA = { L: 50, a: 1, b: 1 };
            const grayB = { L: 51, a: 2, b: 2 };

            const tuningStrictHue = {
                prune: {
                    threshold: 5,
                    whitePoint: 92,
                    shadowPoint: 10,
                    hueLockAngle: 5
                }
            };
            const palette = [grayA, grayB, RED];
            const result = PosterizationEngine._prunePalette(
                palette, 5.0, 92, 0, tuningStrictHue, 'cie76'
            );
            // Should merge grays (chroma < 5, hue lock bypassed)
            expect(result.length).toBe(2);
        });
    });

    describe('highlight protection', () => {
        test('does not merge bright highlight with darker color', () => {
            const highlight = { L: 95, a: 2, b: 5 };
            const midTone = { L: 80, a: 3, b: 6 };

            const palette = [highlight, midTone, RED];
            const result = PosterizationEngine._prunePalette(
                palette, 30.0, 92, 0, TUNING_NO_HUELOCK, 'cie76'
            );
            // L=95 > whitePoint(92) and L=80 <= 92 → highlight protection blocks merge
            expect(result.length).toBe(3);
        });

        test('merges two highlights (both above whitePoint)', () => {
            const highlightA = { L: 96, a: 1, b: 1 };
            const highlightB = { L: 97, a: 2, b: 2 };

            const palette = [highlightA, highlightB, RED];
            const result = PosterizationEngine._prunePalette(
                palette, 5.0, 92, 0, TUNING_NO_HUELOCK, 'cie76'
            );
            // Both above whitePoint → no protection → should merge
            expect(result.length).toBe(2);
        });
    });

    describe('saliency-based winner selection', () => {
        test('keeps higher-saliency color when merging', () => {
            // Color A: high chroma → high saliency score
            const highSaliency = { L: 50, a: 40, b: 40 };  // Saliency = 50*1.5 + 56.6*2.5 = 216.5
            // Color B: low chroma → low saliency score
            const lowSaliency = { L: 51, a: 1, b: 1 };     // Saliency = 51*1.5 + 1.4*2.5 = 80.0

            const palette = [lowSaliency, highSaliency];
            const result = PosterizationEngine._prunePalette(
                palette, 100.0, 92, 0, TUNING_NO_HUELOCK, 'cie76'
            );
            expect(result.length).toBe(1);
            // Should keep the high-saliency one (high chroma)
            expect(result[0].a).toBe(40);
        });
    });
});

describe('_prunePalette — unconditional similarity prune behavior', () => {
    // Tests for the behavior where palette dedup runs REGARDLESS of palette count
    // (targetCount=0 means "merge all within threshold, don't stop early")

    test('merges near-duplicates even when palette is at target count', () => {
        // Simulate palette with exactly 8 colors but two are near-duplicates
        const palette = [
            { L: 20, a: 5, b: -50 },   // Blue-ish
            { L: 45, a: 60, b: 40 },    // Red
            { L: 55, a: -50, b: 35 },   // Green
            { L: 89, a: -1, b: 84 },    // Yellow A
            { L: 89, a: -1, b: 85 },    // Yellow B (near-dup)
            { L: 5, a: 0, b: 0 },       // Black
            { L: 95, a: 0, b: 0 },      // White
            { L: 50, a: 0, b: 0 },      // Neutral gray
        ];

        // Budget prune with targetCount=8 would NOT merge (already at 8)
        const resultBudget = PosterizationEngine._prunePalette(
            [...palette], 2.0, 92, 8, TUNING_NO_HUELOCK, 'cie2000'
        );
        expect(resultBudget.length).toBe(8); // Budget stops at target

        // Unconditional prune with targetCount=0 DOES merge
        const resultUnconditional = PosterizationEngine._prunePalette(
            [...palette], 2.0, 92, 0, TUNING_NO_HUELOCK, 'cie2000'
        );
        expect(resultUnconditional.length).toBe(7); // Yellow pair merged
    });

    test('uses archetype paletteReduction as threshold (not hard-coded 2.0)', () => {
        // Two pinks: ΔE2000 ≈ 3.88
        const palette = [
            PINK_A,   // (62, 76, -45)
            PINK_B,   // (66, 68, -40)
            RED,
            GREEN,
            BLUE,
        ];

        // With threshold 2.0 (old hard-coded): pinks survive (3.88 > 2.0)
        const resultLowThreshold = PosterizationEngine._prunePalette(
            [...palette], 2.0, 92, 0, TUNING_NO_HUELOCK, 'cie2000'
        );
        expect(resultLowThreshold.length).toBe(5); // Pinks survive

        // With threshold 6.0 (archetype paletteReduction): pinks merge (3.88 < 6.0)
        const resultHighThreshold = PosterizationEngine._prunePalette(
            [...palette], 6.0, 92, 0, TUNING_NO_HUELOCK, 'cie2000'
        );
        expect(resultHighThreshold.length).toBe(4); // Pinks merged
    });

    test('max(paletteReduction, 2.0) ensures minimum threshold of 2.0', () => {
        // Even if archetype has paletteReduction=0, the floor is 2.0
        const palette = [YELLOW_A, YELLOW_B, RED];
        const threshold = Math.max(0, 2.0); // Simulates the floor logic

        const result = PosterizationEngine._prunePalette(
            [...palette], threshold, 92, 0, TUNING_NO_HUELOCK, 'cie2000'
        );
        // Yellows ΔE00≈0.21 < 2.0 → merge
        expect(result.length).toBe(2);
    });

    test('multiple near-duplicate pairs all get merged', () => {
        const palette = [
            { L: 89, a: -1, b: 84 },   // Yellow A
            { L: 89, a: -1, b: 85 },   // Yellow B (near-dup of A)
            { L: 50, a: 30, b: 20 },   // Pink A
            { L: 50, a: 31, b: 20 },   // Pink B (near-dup of A)
            { L: 20, a: 5, b: -50 },   // Blue (distinct)
        ];

        const result = PosterizationEngine._prunePalette(
            [...palette], 2.0, 92, 0, TUNING_NO_HUELOCK, 'cie2000'
        );
        // Both duplicate pairs should merge → 3 remaining
        expect(result.length).toBe(3);
    });
});
