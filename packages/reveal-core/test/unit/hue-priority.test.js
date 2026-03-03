/**
 * Unit tests for Hue-Aware Priority Multiplier (v0.2.0)
 *
 * Tests the three helper functions:
 * - _getHueSector() - Maps Lab a/b to 12 hue sectors
 * - _calculateBoxMetadata() - Calculates mean, sector, variance for a box
 * - _calculateSplitPriority() - Applies hue hunger multiplier
 */

import { describe, test, expect } from 'vitest';

// Import modules directly
const HueGapRecovery = require('../../lib/engines/HueGapRecovery');
const LabMedianCut = require('../../lib/engines/LabMedianCut');

describe('Hue-Aware Priority Multiplier (v0.2.0)', () => {
    describe('_getHueSector()', () => {
        test('should map red (a=50, b=0) to sector 0', () => {
            const sector = HueGapRecovery._getHueSector(50, 0);
            expect(sector).toBe(0); // Red: 0-30°
        });

        test('should map orange (a=50, b=25) to sector 0 or 1', () => {
            const sector = HueGapRecovery._getHueSector(50, 25);
            expect(sector).toBeGreaterThanOrEqual(0);
            expect(sector).toBeLessThanOrEqual(1);
        });

        test('should map yellow (a=30, b=50) to sector 1 (30-60°)', () => {
            // atan2(50, 30) = 59° → sector 1
            const sector = HueGapRecovery._getHueSector(30, 50);
            expect(sector).toBe(1);
        });

        test('should map green (a=-40, b=20) to sector 5 (150-180°)', () => {
            // atan2(20, -40) = 153° → sector 5
            const sector = HueGapRecovery._getHueSector(-40, 20);
            expect(sector).toBe(5);
        });

        test('should map cyan (a=-50, b=-10) to sector 5 or 6', () => {
            const sector = HueGapRecovery._getHueSector(-50, -10);
            expect(sector).toBeGreaterThanOrEqual(5);
            expect(sector).toBeLessThanOrEqual(6);
        });

        test('should map blue (a=-30, b=-50) to sector 6 or 7', () => {
            const sector = HueGapRecovery._getHueSector(-30, -50);
            expect(sector).toBeGreaterThanOrEqual(6);
            expect(sector).toBeLessThanOrEqual(7);
        });

        test('should map purple (a=20, b=-50) to sector 8 or 9', () => {
            const sector = HueGapRecovery._getHueSector(20, -50);
            expect(sector).toBeGreaterThanOrEqual(8);
            expect(sector).toBeLessThanOrEqual(9);
        });

        test('should return -1 for grayscale (low chroma)', () => {
            expect(HueGapRecovery._getHueSector(2, 1)).toBe(-1);
            expect(HueGapRecovery._getHueSector(0, 0)).toBe(-1);
            expect(HueGapRecovery._getHueSector(3, 3)).toBe(-1);
        });

        test('should handle all 12 sectors (0-11)', () => {
            const sector = HueGapRecovery._getHueSector(50, 0);
            expect(sector).toBeGreaterThanOrEqual(0);
            expect(sector).toBeLessThanOrEqual(11);
        });

        test('should normalize negative angles to 0-360°', () => {
            // Negative angle (3rd quadrant) should normalize
            const sector = HueGapRecovery._getHueSector(-30, -50);
            expect(sector).toBeGreaterThanOrEqual(0);
            expect(sector).toBeLessThanOrEqual(11);
        });
    });

    describe('_calculateBoxMetadata()', () => {
        test('should calculate mean Lab values', () => {
            const box = {
                colors: [
                    { L: 50, a: 10, b: 20, count: 1 },
                    { L: 60, a: 20, b: 30, count: 1 },
                    { L: 70, a: 30, b: 40, count: 1 }
                ]
            };

            const metadata = LabMedianCut._calculateBoxMetadata(box, false);

            expect(metadata.meanL).toBe(60); // (50+60+70)/3
            expect(metadata.meanA).toBe(20); // (10+20+30)/3
            expect(metadata.meanB).toBe(30); // (20+30+40)/3
        });

        test('should calculate variance (sum of squared deviations)', () => {
            const box = {
                colors: [
                    { L: 50, a: 0, b: 0, count: 1 },
                    { L: 60, a: 0, b: 0, count: 1 }
                ]
            };

            const metadata = LabMedianCut._calculateBoxMetadata(box, false);

            // Mean L = 55, variance = (50-55)^2 + (60-55)^2 = 25 + 25 = 50
            expect(metadata.variance).toBe(50);
        });

        test('should identify hue sector from mean a/b', () => {
            const box = {
                colors: [
                    { L: 50, a: 50, b: 0, count: 1 },  // Red sector
                    { L: 60, a: 45, b: 5, count: 1 }   // Also red-ish
                ]
            };

            const metadata = LabMedianCut._calculateBoxMetadata(box, false);

            expect(metadata.sector).toBe(0); // Red sector
        });

        test('should return sector -1 for grayscale box', () => {
            const box = {
                colors: [
                    { L: 50, a: 0, b: 0, count: 1 },
                    { L: 60, a: 0, b: 0, count: 1 }
                ]
            };

            const metadata = LabMedianCut._calculateBoxMetadata(box, false);

            expect(metadata.sector).toBe(-1); // Grayscale
        });

        test('should ignore chroma in grayscaleOnly mode', () => {
            const box = {
                colors: [
                    { L: 50, a: 40, b: 30, count: 1 },
                    { L: 60, a: 50, b: 40, count: 1 }
                ]
            };

            const colorMetadata = LabMedianCut._calculateBoxMetadata(box, false);
            const grayMetadata = LabMedianCut._calculateBoxMetadata(box, true);

            // Grayscale mode should have lower variance (only L channel)
            expect(grayMetadata.variance).toBeLessThan(colorMetadata.variance);
            expect(grayMetadata.sector).toBe(-1);
        });

        test('should handle empty box gracefully', () => {
            const box = { colors: [] };
            const metadata = LabMedianCut._calculateBoxMetadata(box, false);

            expect(metadata.meanL).toBe(0);
            expect(metadata.meanA).toBe(0);
            expect(metadata.meanB).toBe(0);
            expect(metadata.sector).toBe(-1);
            expect(metadata.variance).toBe(0);
        });
    });

    describe('_calculateSplitPriority()', () => {
        test('should return base variance when sector is covered', () => {
            const box = {
                colors: [{ L: 50, a: 40, b: 10, count: 100 }]
            };
            const sectorEnergy = new Float32Array(12);
            sectorEnergy[0] = 10.0; // Red has 10% energy
            const coveredSectors = new Set([0]); // Red already covered

            const priority = LabMedianCut._calculateSplitPriority(
                box, sectorEnergy, coveredSectors, false, 5.0
            );

            const metadata = LabMedianCut._calculateBoxMetadata(box, false);
            expect(priority).toBe(metadata.variance); // No multiplier (1.0×)
        });

        test('should apply 5× multiplier to uncovered significant sector', () => {
            // Box with multiple colors to have non-zero variance
            // a=40, b=10 → atan2(10, 40) = 14° → sector 0 (Red)
            const box = {
                colors: [
                    { L: 50, a: 40, b: 10, count: 50 },
                    { L: 60, a: 45, b: 15, count: 50 }
                ]
            };
            const sectorEnergy = new Float32Array(12);
            sectorEnergy[0] = 10.0; // Red has 10% energy (>5% threshold)
            const coveredSectors = new Set(); // Red NOT covered

            const priority = LabMedianCut._calculateSplitPriority(
                box, sectorEnergy, coveredSectors, false, 5.0
            );

            const metadata = LabMedianCut._calculateBoxMetadata(box, false);
            // With variance > 0, priority should be boosted
            expect(metadata.variance).toBeGreaterThan(0);
            expect(priority).toBeGreaterThan(metadata.variance * 4.0); // ~5× multiplier
        });

        test('should NOT boost sector with <5% energy', () => {
            const box = {
                colors: [{ L: 50, a: 40, b: 10, count: 100 }]
            };
            const sectorEnergy = new Float32Array(12);
            sectorEnergy[0] = 3.0; // Red has only 3% energy (<5% threshold)
            const coveredSectors = new Set(); // Red NOT covered

            const priority = LabMedianCut._calculateSplitPriority(
                box, sectorEnergy, coveredSectors, false, 5.0
            );

            const metadata = LabMedianCut._calculateBoxMetadata(box, false);
            expect(priority).toBe(metadata.variance); // No multiplier
        });

        test('should ignore hue priority in grayscale mode', () => {
            const box = {
                colors: [{ L: 50, a: 0, b: 0, count: 100 }]
            };
            const sectorEnergy = new Float32Array(12).fill(10);
            const coveredSectors = new Set();

            const priority = LabMedianCut._calculateSplitPriority(
                box, sectorEnergy, coveredSectors, true, 5.0 // grayscaleOnly = true
            );

            const metadata = LabMedianCut._calculateBoxMetadata(box, true);
            expect(priority).toBe(metadata.variance); // No hue multiplier
        });

        test('should handle null sectorEnergy gracefully', () => {
            const box = {
                colors: [{ L: 50, a: 40, b: 10, count: 100 }]
            };

            const priority = LabMedianCut._calculateSplitPriority(
                box, null, new Set(), false, 5.0
            );

            const metadata = LabMedianCut._calculateBoxMetadata(box, false);
            expect(priority).toBe(metadata.variance); // Fallback to base variance
        });

        test('should use custom hueMultiplier parameter', () => {
            // Box with multiple colors to have non-zero variance
            // a=-30, b=30 → sector 4 (Green) - NOT Red sector which has 10× minimum due to Red Rescue
            const box = {
                colors: [
                    { L: 50, a: -30, b: 30, count: 50 },
                    { L: 60, a: -35, b: 35, count: 50 }
                ]
            };
            const sectorEnergy = new Float32Array(12);
            sectorEnergy[4] = 10.0; // Green sector
            const coveredSectors = new Set();

            const priority10x = LabMedianCut._calculateSplitPriority(
                box, sectorEnergy, coveredSectors, false, 10.0 // 10× multiplier
            );
            const priority2x = LabMedianCut._calculateSplitPriority(
                box, sectorEnergy, coveredSectors, false, 2.0 // 2× multiplier
            );

            expect(priority10x).toBeGreaterThan(priority2x);
        });

        test('should handle grayscale box (sector -1) gracefully', () => {
            const box = {
                colors: [{ L: 50, a: 2, b: 1, count: 100 }] // Near-gray (chroma ~2.2)
            };
            const sectorEnergy = new Float32Array(12).fill(10);
            const coveredSectors = new Set();

            const priority = LabMedianCut._calculateSplitPriority(
                box, sectorEnergy, coveredSectors, false, 5.0
            );

            // Grayscale box (sector -1) should not get multiplier
            const metadata = LabMedianCut._calculateBoxMetadata(box, false);
            expect(metadata.sector).toBe(-1);
            expect(priority).toBe(metadata.variance);
        });
    });
});
