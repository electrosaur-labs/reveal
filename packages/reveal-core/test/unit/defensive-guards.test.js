import { describe, it, expect } from 'vitest';

const LabMedianCut = require('../../lib/engines/LabMedianCut');
const HueGapRecovery = require('../../lib/engines/HueGapRecovery');
const { SALIENCY } = require('../../lib/engines/CentroidStrategies');

/**
 * Tests for defensive validation guards added to internal helper functions.
 * These guards return safe defaults for null/missing inputs to aid debugging.
 */

describe('Defensive validation guards', () => {

    describe('LabMedianCut._calculateBoxMetadata', () => {
        it('returns zero metadata for null box', () => {
            const result = LabMedianCut._calculateBoxMetadata(null);
            expect(result).toEqual({ meanL: 0, meanA: 0, meanB: 0, sector: -1, variance: 0 });
        });

        it('returns zero metadata for box missing colors property', () => {
            const result = LabMedianCut._calculateBoxMetadata({});
            expect(result).toEqual({ meanL: 0, meanA: 0, meanB: 0, sector: -1, variance: 0 });
        });

        it('returns zero metadata for box with empty colors', () => {
            const result = LabMedianCut._calculateBoxMetadata({ colors: [] });
            expect(result).toEqual({ meanL: 0, meanA: 0, meanB: 0, sector: -1, variance: 0 });
        });

        it('computes valid metadata for a well-formed box', () => {
            const box = {
                colors: [
                    { L: 50, a: 20, b: -10, count: 5 },
                    { L: 60, a: 25, b: -15, count: 3 },
                ]
            };
            const result = LabMedianCut._calculateBoxMetadata(box);
            expect(result.meanL).toBeGreaterThan(0);
            expect(result.variance).toBeGreaterThanOrEqual(0);
        });
    });

    describe('HueGapRecovery._analyzeImageHueSectors', () => {
        it('returns 12 zeros for null labPixels', () => {
            const result = HueGapRecovery._analyzeImageHueSectors(null);
            expect(result).toEqual(new Array(12).fill(0));
        });

        it('returns 12 zeros for empty labPixels', () => {
            const result = HueGapRecovery._analyzeImageHueSectors(new Float32Array(0));
            expect(result).toEqual(new Array(12).fill(0));
        });

        it('returns valid sector percentages for chromatic pixels', () => {
            // Pure red pixel: a=80, b=0 → hue 0° → sector 0
            const labPixels = new Float32Array([50, 80, 0]);
            const result = HueGapRecovery._analyzeImageHueSectors(labPixels);
            expect(result[0]).toBe(100); // 100% in red sector
            expect(result.slice(1).every(v => v === 0)).toBe(true);
        });
    });

    describe('HueGapRecovery._analyzePaletteHueCoverage', () => {
        it('returns empty coverage for null palette', () => {
            const result = HueGapRecovery._analyzePaletteHueCoverage(null);
            expect(result.coveredSectors).toBeInstanceOf(Set);
            expect(result.coveredSectors.size).toBe(0);
            expect(result.colorCountsBySector).toEqual(new Array(12).fill(0));
        });

        it('returns empty coverage for empty palette', () => {
            const result = HueGapRecovery._analyzePaletteHueCoverage([]);
            expect(result.coveredSectors).toBeInstanceOf(Set);
            expect(result.coveredSectors.size).toBe(0);
            expect(result.colorCountsBySector).toEqual(new Array(12).fill(0));
        });

        it('returns correct coverage for a chromatic palette', () => {
            // Pure red (a=80, b=0 → sector 0) + pure green (a=-80, b=0 → sector 6)
            const palette = [
                { L: 50, a: 80, b: 0 },
                { L: 50, a: -80, b: 0 },
            ];
            const result = HueGapRecovery._analyzePaletteHueCoverage(palette);
            expect(result.coveredSectors.has(0)).toBe(true);   // red
            expect(result.coveredSectors.has(6)).toBe(true);   // blue-ish (atan2(0,-80) = 180° → sector 6)
            expect(result.coveredSectors.size).toBe(2);
        });
    });

    describe('CentroidStrategies.SALIENCY', () => {
        it('returns neutral gray for null weights', () => {
            const bucket = [{ L: 70, a: 20, b: 30, count: 10 }];
            const result = SALIENCY(bucket, null);
            expect(result).toHaveProperty('L');
            expect(result).toHaveProperty('a');
            expect(result).toHaveProperty('b');
        });

        it('returns neutral gray for undefined weights', () => {
            const bucket = [{ L: 70, a: 20, b: 30, count: 10 }];
            const result = SALIENCY(bucket, undefined);
            expect(result).toHaveProperty('L');
            expect(result).toHaveProperty('a');
            expect(result).toHaveProperty('b');
        });

        it('returns default for null bucket and null weights', () => {
            const result = SALIENCY(null, null);
            expect(result).toEqual({ L: 50, a: 0, b: 0 });
        });

        it('computes valid centroid with explicit weights', () => {
            const bucket = [
                { L: 50, a: 10, b: 20, count: 100 },
                { L: 55, a: 15, b: 25, count: 50 },
            ];
            const weights = { lWeight: 1.0, cWeight: 2.0, blackBias: 5.0 };
            const result = SALIENCY(bucket, weights);
            expect(result.L).toBeGreaterThan(0);
            expect(result.L).toBeLessThan(100);
        });
    });
});
