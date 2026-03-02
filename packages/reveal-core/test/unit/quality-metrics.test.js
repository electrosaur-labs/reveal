/**
 * QualityMetrics (MetricsCalculator) - Unit Tests
 *
 * Tests for global fidelity (DeltaE), feature preservation (saliency loss),
 * physical feasibility (ink stack, density breaches), and integrity scoring.
 */

import { describe, it, expect } from 'vitest';

const MetricsCalculator = require('../../lib/metrics/QualityMetrics');

// --- Helpers ---

/** Create 8-bit Lab pixel buffer (L:0-255, a/b:0-255, neutral=128) */
const makeLabPixels = (colors, count) => {
    const buf = new Uint8ClampedArray(count * 3);
    for (let i = 0; i < count; i++) {
        const c = colors[i % colors.length];
        buf[i * 3]     = c.L;
        buf[i * 3 + 1] = c.a;
        buf[i * 3 + 2] = c.b;
    }
    return buf;
};

/** Create a simple layer with a binary mask */
const makeLayer = (name, maskValues) => ({
    name,
    mask: new Uint8Array(maskValues)
});

describe('MetricsCalculator.compute', () => {

    describe('global fidelity', () => {
        it('returns avgDeltaE=0 when original and processed are identical', () => {
            const pixels = makeLabPixels([{ L: 127, a: 128, b: 128 }], 100);
            const layers = [makeLayer('Gray', new Array(100).fill(255))];
            const result = MetricsCalculator.compute(pixels, pixels, layers, 10, 10);
            expect(result.global_fidelity.avgDeltaE).toBe(0);
            expect(result.global_fidelity.maxDeltaE).toBe(0);
        });

        it('avgDeltaE > 0 when processed differs from original', () => {
            const original = makeLabPixels([{ L: 127, a: 128, b: 128 }], 100);
            const processed = makeLabPixels([{ L: 200, a: 128, b: 128 }], 100);
            const layers = [makeLayer('Layer', new Array(100).fill(255))];
            const result = MetricsCalculator.compute(original, processed, layers, 10, 10);
            expect(result.global_fidelity.avgDeltaE).toBeGreaterThan(0);
            expect(result.global_fidelity.maxDeltaE).toBeGreaterThan(0);
        });

        it('maxDeltaE >= avgDeltaE always', () => {
            // Mix: half identical, half shifted
            const original = makeLabPixels([
                { L: 127, a: 128, b: 128 },
                { L: 127, a: 128, b: 128 }
            ], 100);
            const processed = makeLabPixels([
                { L: 127, a: 128, b: 128 },
                { L: 200, a: 128, b: 128 }
            ], 100);
            const layers = [makeLayer('Layer', new Array(100).fill(255))];
            const result = MetricsCalculator.compute(original, processed, layers, 10, 10);
            expect(result.global_fidelity.maxDeltaE).toBeGreaterThanOrEqual(result.global_fidelity.avgDeltaE);
        });
    });

    describe('feature preservation', () => {
        it('revelationScore is 100 when images are identical', () => {
            const pixels = makeLabPixels([{ L: 127, a: 128, b: 128 }], 100);
            const layers = [makeLayer('Gray', new Array(100).fill(255))];
            const result = MetricsCalculator.compute(pixels, pixels, layers, 10, 10);
            expect(result.feature_preservation.revelationScore).toBe(100);
            expect(result.feature_preservation.saliencyLoss).toBe(0);
        });

        it('revelationScore decreases with larger errors', () => {
            const original = makeLabPixels([{ L: 127, a: 128, b: 128 }], 100);
            const slight = makeLabPixels([{ L: 140, a: 128, b: 128 }], 100);
            const severe = makeLabPixels([{ L: 255, a: 200, b: 50 }], 100);
            const layers = [makeLayer('Layer', new Array(100).fill(255))];

            const rSlight = MetricsCalculator.compute(original, slight, layers, 10, 10);
            const rSevere = MetricsCalculator.compute(original, severe, layers, 10, 10);

            expect(rSlight.feature_preservation.revelationScore).toBeGreaterThan(
                rSevere.feature_preservation.revelationScore
            );
        });
    });

    describe('physical feasibility', () => {
        it('maxInkStack = number of overlapping layers', () => {
            // 2x2 image, 2 layers overlapping on pixel 0
            const original = makeLabPixels([{ L: 127, a: 128, b: 128 }], 4);
            const layers = [
                makeLayer('A', [255, 0, 0, 0]),
                makeLayer('B', [255, 255, 0, 0])
            ];
            const result = MetricsCalculator.compute(original, original, layers, 2, 2);
            expect(result.physical_feasibility.maxInkStack).toBe(2); // pixel 0 has both layers
        });

        it('avgInkStack accounts for all pixel coverage', () => {
            // 4 pixels, layer A covers all, layer B covers 2
            const original = makeLabPixels([{ L: 127, a: 128, b: 128 }], 4);
            const layers = [
                makeLayer('A', [255, 255, 255, 255]),
                makeLayer('B', [255, 255, 0, 0])
            ];
            const result = MetricsCalculator.compute(original, original, layers, 2, 2);
            // Total ink = 4 + 2 = 6, avgInkStack = 6/4 = 1.5
            expect(result.physical_feasibility.avgInkStack).toBe(1.5);
        });

        it('densityFloorBreaches reports small clusters', () => {
            // 10x10 image with a layer that has a single isolated pixel
            const original = makeLabPixels([{ L: 127, a: 128, b: 128 }], 100);
            const mask = new Array(100).fill(0);
            mask[55] = 255; // single pixel — below print threshold of 4
            const layers = [makeLayer('Speckle', mask)];
            const result = MetricsCalculator.compute(original, original, layers, 10, 10);
            expect(result.physical_feasibility.densityFloorBreaches).toBeGreaterThan(0);
        });
    });

    describe('return structure', () => {
        it('returns all three metric categories', () => {
            const pixels = makeLabPixels([{ L: 127, a: 128, b: 128 }], 4);
            const layers = [makeLayer('A', [255, 255, 255, 255])];
            const result = MetricsCalculator.compute(pixels, pixels, layers, 2, 2);

            expect(result).toHaveProperty('global_fidelity');
            expect(result).toHaveProperty('feature_preservation');
            expect(result).toHaveProperty('physical_feasibility');

            expect(result.global_fidelity).toHaveProperty('avgDeltaE');
            expect(result.global_fidelity).toHaveProperty('maxDeltaE');
            expect(result.feature_preservation).toHaveProperty('revelationScore');
            expect(result.feature_preservation).toHaveProperty('saliencyLoss');
            expect(result.physical_feasibility).toHaveProperty('maxInkStack');
            expect(result.physical_feasibility).toHaveProperty('avgInkStack');
            expect(result.physical_feasibility).toHaveProperty('densityFloorBreaches');
            expect(result.physical_feasibility).toHaveProperty('integrityScore');
        });
    });
});

describe('MetricsCalculator._calculateIntegrity', () => {
    it('returns 100 for zero breaches', () => {
        expect(MetricsCalculator._calculateIntegrity(0, 100, 100)).toBe(100);
    });

    it('returns 100 in safe zone (< 0.5% noise)', () => {
        // 10000 pixels, 40 breaches = 0.4%
        expect(MetricsCalculator._calculateIntegrity(40, 100, 100)).toBe(100);
    });

    it('returns 60-100 in good zone (0.5% to 8%)', () => {
        // 10000 pixels, 400 breaches = 4%
        const score = parseFloat(MetricsCalculator._calculateIntegrity(400, 100, 100));
        expect(score).toBeGreaterThanOrEqual(60);
        expect(score).toBeLessThanOrEqual(100);
    });

    it('returns 0-60 in fail zone (8% to 12%)', () => {
        // 10000 pixels, 1000 breaches = 10%
        const score = parseFloat(MetricsCalculator._calculateIntegrity(1000, 100, 100));
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThan(60);
    });

    it('returns 0 for critical noise (> 12%)', () => {
        // 10000 pixels, 1500 breaches = 15%
        expect(MetricsCalculator._calculateIntegrity(1500, 100, 100)).toBe(0);
    });
});
