import { describe, it, expect } from 'vitest';

const { CentroidStrategies, SALIENCY, ROBUST_SALIENCY, VOLUMETRIC } = require('../../lib/engines/CentroidStrategies');

describe('ROBUST_SALIENCY centroid strategy', () => {

    describe('population mean vs top-slice', () => {
        it('produces centroid closer to population mean than SALIENCY for warm buckets', () => {
            // Simulated warm bucket: mostly moderate warm pixels, a few high-chroma outliers
            const bucket = [];
            // Majority: moderate gold pixels (a*≈10, b*≈50, C≈51, H≈79°)
            for (let i = 0; i < 80; i++) {
                bucket.push({ L: 75 + (i % 10), a: 8 + (i % 5), b: 45 + (i % 15), count: 10 });
            }
            // Minority: high-chroma orange outliers (a*≈50, b*≈120, C≈130, H≈67°)
            for (let i = 0; i < 20; i++) {
                bucket.push({ L: 85, a: 48 + (i % 5), b: 118 + (i % 10), count: 2 });
            }

            const weights = { lWeight: 0.8, cWeight: 3.0, blackBias: 6.0 };
            const robust = ROBUST_SALIENCY(bucket, weights);
            const saliency = SALIENCY(bucket, weights);
            const volumetric = VOLUMETRIC(bucket, weights);

            // ROBUST should be much closer to VOLUMETRIC than SALIENCY is
            const robustDistToVol = Math.sqrt(
                (robust.a - volumetric.a) ** 2 + (robust.b - volumetric.b) ** 2
            );
            const saliencyDistToVol = Math.sqrt(
                (saliency.a - volumetric.a) ** 2 + (saliency.b - volumetric.b) ** 2
            );
            expect(robustDistToVol).toBeLessThan(saliencyDistToVol);

            // ROBUST a* should be much lower than SALIENCY a* (less orange inflation)
            expect(robust.a).toBeLessThan(saliency.a);
        });

        it('produces lower centroid chroma than SALIENCY', () => {
            const bucket = [
                { L: 70, a: 30, b: 128, count: 50 },
                { L: 72, a: 28, b: 128, count: 50 },
                { L: 65, a: 15, b: 45, count: 200 },
                { L: 60, a: 12, b: 40, count: 200 },
                { L: 70, a: 18, b: 50, count: 200 },
                { L: 55, a: 10, b: 35, count: 200 },
                { L: 75, a: 20, b: 55, count: 200 },
            ];

            const weights = { lWeight: 0.8, cWeight: 3.0, blackBias: 6.0 };
            const robust = ROBUST_SALIENCY(bucket, weights);
            const saliency = SALIENCY(bucket, weights);

            const robustC = Math.sqrt(robust.a ** 2 + robust.b ** 2);
            const saliencyC = Math.sqrt(saliency.a ** 2 + saliency.b ** 2);
            expect(robustC).toBeLessThan(saliencyC);
        });
    });

    describe('chroma Winsorization', () => {
        it('caps outlier chroma at P75 while preserving hue', () => {
            // All pixels at same hue angle but varying chroma
            const bucket = [];
            // Low chroma (C≈30): a≈10, b≈28
            for (let i = 0; i < 60; i++) bucket.push({ L: 70, a: 10, b: 28, count: 1 });
            // Medium chroma (C≈60): a≈20, b≈56
            for (let i = 0; i < 20; i++) bucket.push({ L: 70, a: 20, b: 56, count: 1 });
            // Extreme chroma (C≈130): a≈44, b≈122
            for (let i = 0; i < 20; i++) bucket.push({ L: 70, a: 44, b: 122, count: 1 });

            const weights = { lWeight: 1.0, cWeight: 1.0, blackBias: 5.0 };
            const result = ROBUST_SALIENCY(bucket, weights);

            // Centroid chroma should be well below the outlier range
            const resultC = Math.sqrt(result.a ** 2 + result.b ** 2);
            expect(resultC).toBeLessThan(80);
        });
    });

    describe('black protection', () => {
        it('snaps centroid dark for L < 10 pixels', () => {
            const bucket = [
                { L: 2, a: 0, b: 0, count: 50 },
                { L: 5, a: 1, b: -1, count: 50 },
                { L: 8, a: 0, b: 1, count: 50 },
                { L: 50, a: 5, b: 10, count: 10 },
                { L: 55, a: 3, b: 8, count: 10 },
            ];

            const weights = { lWeight: 1.0, cWeight: 1.0, blackBias: 10.0 };
            const result = ROBUST_SALIENCY(bucket, weights);

            // High blackBias should pull centroid very dark via weighted average
            expect(result.L).toBeLessThan(15);
        });

        it('produces darker centroid than VOLUMETRIC for dark buckets', () => {
            const bucket = [
                { L: 3, a: 0, b: 0, count: 30 },
                { L: 7, a: 1, b: 1, count: 30 },
                { L: 40, a: 5, b: 5, count: 40 },
            ];

            const weights = { lWeight: 1.0, cWeight: 1.0, blackBias: 8.0 };
            const robust = ROBUST_SALIENCY(bucket, weights);
            const volumetric = VOLUMETRIC(bucket, weights);

            // Black protection should pull ROBUST darker than pure VOLUMETRIC
            expect(robust.L).toBeLessThan(volumetric.L);
        });
    });

    describe('achromatic exclusion', () => {
        it('filters low-chroma pixels when cWeight >= 2.5', () => {
            const bucket = [
                { L: 60, a: 2, b: 3, count: 500 },
                { L: 65, a: -1, b: 2, count: 500 },
                { L: 55, a: 30, b: 40, count: 50 },
                { L: 50, a: 25, b: 35, count: 50 },
            ];

            const weights = { lWeight: 1.0, cWeight: 3.0, blackBias: 5.0 };
            const result = ROBUST_SALIENCY(bucket, weights);

            const resultChroma = Math.sqrt(result.a ** 2 + result.b ** 2);
            expect(resultChroma).toBeGreaterThan(15);
        });
    });

    describe('exports', () => {
        it('is available in CentroidStrategies object', () => {
            expect(CentroidStrategies.ROBUST_SALIENCY).toBe(ROBUST_SALIENCY);
            expect(typeof ROBUST_SALIENCY).toBe('function');
        });
    });

    describe('empty bucket', () => {
        it('returns neutral gray for empty bucket', () => {
            expect(ROBUST_SALIENCY([], { lWeight: 1.0, cWeight: 1.0 }))
                .toEqual({ L: 50, a: 0, b: 0 });
        });

        it('returns neutral gray for null bucket', () => {
            expect(ROBUST_SALIENCY(null, { lWeight: 1.0, cWeight: 1.0 }))
                .toEqual({ L: 50, a: 0, b: 0 });
        });
    });

    describe('uniform bucket', () => {
        it('handles bucket where all pixels have same chroma', () => {
            const bucket = [
                { L: 50, a: 30, b: 40, count: 100 },
                { L: 55, a: 30, b: 40, count: 100 },
                { L: 60, a: 30, b: 40, count: 100 },
            ];

            const weights = { lWeight: 1.0, cWeight: 1.0, blackBias: 5.0 };
            const result = ROBUST_SALIENCY(bucket, weights);

            expect(result.a).toBeCloseTo(30, 0);
            expect(result.b).toBeCloseTo(40, 0);
        });
    });
});
