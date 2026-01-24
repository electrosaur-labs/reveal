/**
 * Unit tests for LabDistance module
 *
 * Tests both CIE76 and CIE94 distance calculations with known values
 * and edge cases.
 */

import { describe, it, expect } from 'vitest';
const {
    DistanceMetric,
    DEFAULT_CIE94_PARAMS,
    cie76,
    cie76Weighted,
    cie76SquaredInline,
    cie76WeightedSquaredInline,
    cie94,
    cie94SquaredInline,
    createDistanceCalculator,
    preparePaletteChroma,
    normalizeDistanceConfig
} = require('../../lib/color/LabDistance');

describe('LabDistance', () => {
    // Test colors for known-value calculations
    const white = { L: 100, a: 0, b: 0 };
    const black = { L: 0, a: 0, b: 0 };
    const gray50 = { L: 50, a: 0, b: 0 };
    const red = { L: 53.23, a: 80.11, b: 67.22 };  // Approximate Lab for pure red
    const green = { L: 87.74, a: -86.18, b: 83.18 }; // Approximate Lab for pure green
    const blue = { L: 32.30, a: 79.20, b: -107.86 }; // Approximate Lab for pure blue

    describe('CIE76', () => {
        it('returns 0 for identical colors', () => {
            expect(cie76(white, white)).toBe(0);
            expect(cie76(red, red)).toBe(0);
        });

        it('calculates correct distance for black-white', () => {
            // Black to white: sqrt(100^2) = 100
            expect(cie76(black, white)).toBe(100);
        });

        it('calculates correct distance for simple cases', () => {
            const color1 = { L: 50, a: 0, b: 0 };
            const color2 = { L: 50, a: 3, b: 4 };
            // sqrt(0 + 9 + 16) = sqrt(25) = 5
            expect(cie76(color1, color2)).toBe(5);
        });

        it('returns squared distance when requested', () => {
            const color1 = { L: 50, a: 0, b: 0 };
            const color2 = { L: 50, a: 3, b: 4 };
            expect(cie76(color1, color2, true)).toBe(25);
        });

        it('is symmetric', () => {
            expect(cie76(red, blue)).toBe(cie76(blue, red));
        });
    });

    describe('CIE76 Weighted', () => {
        it('applies increased weight for dark colors', () => {
            const dark1 = { L: 20, a: 10, b: 10 };
            const dark2 = { L: 25, a: 10, b: 10 };

            const unweighted = cie76(dark1, dark2);
            const weighted = cie76Weighted(dark1, dark2);

            // With L weight of 2.0, dark colors should have larger distance
            expect(weighted).toBeGreaterThan(unweighted);
            // dL=5, with weight 2.0: sqrt((5*2)^2) = 10 vs sqrt(5^2) = 5
            expect(weighted).toBeCloseTo(10, 5);
        });

        it('uses default weight for light colors', () => {
            const light1 = { L: 70, a: 10, b: 10 };
            const light2 = { L: 75, a: 10, b: 10 };

            const unweighted = cie76(light1, light2);
            const weighted = cie76Weighted(light1, light2);

            // Above threshold (40), weight should be 1.0
            expect(weighted).toBeCloseTo(unweighted, 5);
        });

        it('respects custom threshold and weight', () => {
            const color1 = { L: 55, a: 0, b: 0 };
            const color2 = { L: 60, a: 0, b: 0 };

            // With threshold 60, avgL=57.5 < 60, so weight applies
            const weighted = cie76Weighted(color1, color2, false, 60, 3.0);
            // dL=5, with weight 3.0: sqrt((5*3)^2) = 15
            expect(weighted).toBeCloseTo(15, 5);
        });
    });

    describe('CIE76 Inline', () => {
        it('matches object-based function', () => {
            const lab1 = { L: 53, a: 80, b: 67 };
            const lab2 = { L: 32, a: 79, b: -108 };

            const objectDist = cie76(lab1, lab2, true);
            const inlineDist = cie76SquaredInline(
                lab1.L, lab1.a, lab1.b,
                lab2.L, lab2.a, lab2.b
            );

            expect(inlineDist).toBeCloseTo(objectDist, 10);
        });

        it('weighted inline matches object-based', () => {
            const lab1 = { L: 20, a: 10, b: 10 };
            const lab2 = { L: 25, a: 15, b: 15 };
            const lWeight = 2.0;

            const objectDist = cie76Weighted(lab1, lab2, true);
            const inlineDist = cie76WeightedSquaredInline(
                lab1.L, lab1.a, lab1.b,
                lab2.L, lab2.a, lab2.b,
                lWeight
            );

            expect(inlineDist).toBeCloseTo(objectDist, 10);
        });
    });

    describe('CIE94', () => {
        it('returns 0 for identical colors', () => {
            expect(cie94(white, white)).toBe(0);
            expect(cie94(red, red)).toBe(0);
        });

        it('calculates non-zero distance for different colors', () => {
            expect(cie94(red, green)).toBeGreaterThan(0);
            expect(cie94(red, blue)).toBeGreaterThan(0);
        });

        it('is smaller than CIE76 for high-chroma colors', () => {
            // CIE94 typically gives smaller distances for saturated colors
            // because it accounts for chroma-dependent perception
            const cie76Dist = cie76(red, green);
            const cie94Dist = cie94(red, green);

            // CIE94 should be smaller due to SC/SH weighting
            expect(cie94Dist).toBeLessThan(cie76Dist);
        });

        it('is similar to CIE76 for achromatic colors', () => {
            // For grays (no chroma), SC=SH=1, so CIE94 ~ CIE76
            const cie76Dist = cie76(black, gray50);
            const cie94Dist = cie94(black, gray50);

            // Should be very close since chroma is 0
            expect(cie94Dist).toBeCloseTo(cie76Dist, 1);
        });

        it('returns squared distance when requested', () => {
            const distSq = cie94(red, blue, true);
            const dist = cie94(red, blue, false);

            expect(Math.sqrt(distSq)).toBeCloseTo(dist, 10);
        });

        it('respects custom CIE94 parameters', () => {
            // Different k1, k2 should produce different results
            const dist1 = cie94(red, green, false, { kL: 1, k1: 0.045, k2: 0.015 });
            const dist2 = cie94(red, green, false, { kL: 1, k1: 0.1, k2: 0.1 });

            expect(dist1).not.toBe(dist2);
        });

        it('is approximately symmetric for similar chroma colors', () => {
            // Note: CIE94 is NOT strictly symmetric because it uses C1 (first color's chroma)
            // as the reference. For colors with similar chroma, results should be close.
            const gray1 = { L: 40, a: 5, b: 5 };
            const gray2 = { L: 60, a: 8, b: 8 };
            const dist1 = cie94(gray1, gray2);
            const dist2 = cie94(gray2, gray1);
            // For low-chroma colors, the difference should be small
            expect(Math.abs(dist1 - dist2)).toBeLessThan(dist1 * 0.1);
        });
    });

    describe('CIE94 Inline', () => {
        it('matches object-based function', () => {
            const lab1 = red;
            const lab2 = blue;

            const objectDist = cie94(lab1, lab2, true);
            const inlineDist = cie94SquaredInline(
                lab1.L, lab1.a, lab1.b,
                lab2.L, lab2.a, lab2.b
            );

            expect(inlineDist).toBeCloseTo(objectDist, 5);
        });

        it('uses pre-computed chroma when provided', () => {
            const lab1 = red;
            const lab2 = green;
            const C1 = Math.sqrt(lab1.a * lab1.a + lab1.b * lab1.b);

            const withChroma = cie94SquaredInline(
                lab1.L, lab1.a, lab1.b,
                lab2.L, lab2.a, lab2.b,
                C1
            );
            const withoutChroma = cie94SquaredInline(
                lab1.L, lab1.a, lab1.b,
                lab2.L, lab2.a, lab2.b,
                0
            );

            expect(withChroma).toBeCloseTo(withoutChroma, 10);
        });
    });

    describe('createDistanceCalculator', () => {
        it('creates CIE76 calculator by default', () => {
            const calc = createDistanceCalculator();
            const result = calc(red, blue);

            expect(result).toBeCloseTo(cie76(red, blue), 10);
        });

        it('creates CIE94 calculator when specified', () => {
            const calc = createDistanceCalculator({ metric: DistanceMetric.CIE94 });
            const result = calc(red, blue);

            expect(result).toBeCloseTo(cie94(red, blue), 10);
        });

        it('returns squared distance when configured', () => {
            const calc = createDistanceCalculator({ squared: true });
            const result = calc(red, blue);

            expect(result).toBeCloseTo(cie76(red, blue, true), 10);
        });

        it('creates weighted CIE76 calculator', () => {
            const calc = createDistanceCalculator({
                weighted: true,
                shadowThreshold: 40,
                shadowWeight: 2.0
            });

            const dark1 = { L: 20, a: 10, b: 10 };
            const dark2 = { L: 25, a: 10, b: 10 };
            const result = calc(dark1, dark2);

            expect(result).toBeCloseTo(cie76Weighted(dark1, dark2), 10);
        });

        it('passes custom CIE94 params', () => {
            const customParams = { kL: 2, k1: 0.1, k2: 0.1 };
            const calc = createDistanceCalculator({
                metric: DistanceMetric.CIE94,
                cie94Params: customParams
            });

            const result = calc(red, blue);
            expect(result).toBeCloseTo(cie94(red, blue, false, customParams), 10);
        });
    });

    describe('preparePaletteChroma', () => {
        it('computes chroma for each palette color', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // C = 0
                { L: 50, a: 30, b: 40 },    // C = 50
                { L: 50, a: -60, b: 80 }    // C = 100
            ];

            const chroma = preparePaletteChroma(palette);

            expect(chroma).toBeInstanceOf(Float32Array);
            expect(chroma.length).toBe(3);
            expect(chroma[0]).toBeCloseTo(0, 5);
            expect(chroma[1]).toBeCloseTo(50, 5);
            expect(chroma[2]).toBeCloseTo(100, 5);
        });

        it('handles empty palette', () => {
            const chroma = preparePaletteChroma([]);
            expect(chroma.length).toBe(0);
        });
    });

    describe('normalizeDistanceConfig', () => {
        it('returns CIE76 by default', () => {
            const config = normalizeDistanceConfig({});

            expect(config.metric).toBe(DistanceMetric.CIE76);
            expect(config.isCIE94).toBe(false);
        });

        it('normalizes CIE94 config', () => {
            const config = normalizeDistanceConfig({
                distanceMetric: 'cie94',
                cie94Params: { k1: 0.1 }
            });

            expect(config.metric).toBe(DistanceMetric.CIE94);
            expect(config.isCIE94).toBe(true);
            expect(config.cie94Params.k1).toBe(0.1);
            expect(config.cie94Params.k2).toBe(DEFAULT_CIE94_PARAMS.k2);
        });

        it('provides default CIE94 params', () => {
            const config = normalizeDistanceConfig({ distanceMetric: 'cie94' });

            expect(config.cie94Params).toEqual(DEFAULT_CIE94_PARAMS);
        });
    });

    describe('Edge Cases', () => {
        it('handles extreme Lab values', () => {
            const extreme1 = { L: 0, a: -128, b: -128 };
            const extreme2 = { L: 100, a: 127, b: 127 };

            expect(() => cie76(extreme1, extreme2)).not.toThrow();
            expect(() => cie94(extreme1, extreme2)).not.toThrow();

            const dist76 = cie76(extreme1, extreme2);
            const dist94 = cie94(extreme1, extreme2);

            expect(dist76).toBeGreaterThan(0);
            expect(dist94).toBeGreaterThan(0);
        });

        it('handles negative chroma components', () => {
            const color1 = { L: 50, a: -50, b: -50 };
            const color2 = { L: 50, a: 50, b: 50 };

            const dist = cie94(color1, color2);
            expect(dist).toBeGreaterThan(0);
            expect(isNaN(dist)).toBe(false);
        });

        it('handles very small differences', () => {
            const color1 = { L: 50, a: 0.001, b: 0.001 };
            const color2 = { L: 50, a: 0.002, b: 0.002 };

            const dist76 = cie76(color1, color2);
            const dist94 = cie94(color1, color2);

            // Very small but not zero
            expect(dist76).toBeLessThan(0.01);
            expect(dist94).toBeLessThan(0.01);
            expect(isNaN(dist76)).toBe(false);
            expect(isNaN(dist94)).toBe(false);
        });
    });

    describe('Performance Characteristics', () => {
        it('inline functions avoid object overhead', () => {
            // This is more of a documentation test - we verify the inline
            // functions produce the same results as object-based ones
            const lab1 = { L: 53, a: 80, b: 67 };
            const lab2 = { L: 32, a: 79, b: -108 };

            const objResult = cie76(lab1, lab2, true);
            const inlineResult = cie76SquaredInline(
                lab1.L, lab1.a, lab1.b,
                lab2.L, lab2.a, lab2.b
            );

            expect(inlineResult).toBe(objResult);
        });
    });
});
