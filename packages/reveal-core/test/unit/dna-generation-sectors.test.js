/**
 * Unit tests for DNA Generation - Sector Analysis
 *
 * Tests that DNAGenerator correctly calculates hMean (ground truth hue)
 * for each sector with the chroma > 5 filter.
 */

import { describe, test, expect } from 'vitest';

// Import DNAGenerator from reveal-adobe (UXP-compatible version)
const DNAGenerator = require('../../../reveal-adobe/src/DNAGenerator.js');

describe('DNA Generation - Sector Analysis', () => {
    /**
     * Helper: Create Lab pixel data for testing
     * @param {Array<{L, a, b, count}>} colors - Array of Lab colors with counts
     * @returns {Uint8ClampedArray} - Flat Lab pixel array
     */
    function createLabPixels(colors) {
        const totalPixels = colors.reduce((sum, c) => sum + c.count, 0);
        const pixels = new Uint8ClampedArray(totalPixels * 3);

        let pixelIndex = 0;
        for (const color of colors) {
            for (let i = 0; i < color.count; i++) {
                // 8-bit Lab encoding: L: 0-255 → 0-100, a/b: 0-255 → -128 to +127
                pixels[pixelIndex++] = (color.L / 100) * 255;
                pixels[pixelIndex++] = color.a + 128;
                pixels[pixelIndex++] = color.b + 128;
            }
        }

        return pixels;
    }

    /**
     * Helper: Calculate expected hue from Lab a/b
     */
    function calculateHue(a, b) {
        return (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    }

    describe('hMean (Ground Truth Hue) Calculation', () => {
        test('should calculate hMean for pure yellow sector', () => {
            const pixels = createLabPixels([
                { L: 85, a: 10, b: 80, count: 100 },   // Yellow hue ~83°
                { L: 80, a: 15, b: 75, count: 100 }    // Yellow hue ~79°
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 2, 1, { richDNA: true });

            expect(dna.sectors).toBeDefined();
            expect(dna.sectors.yellow).toBeDefined();
            expect(dna.sectors.yellow.hMean).toBeGreaterThan(75);
            expect(dna.sectors.yellow.hMean).toBeLessThan(90);
            expect(dna.sectors.yellow.weight).toBeGreaterThan(0.9); // ~100% yellow
        });

        test('should calculate hMean for ochre yellow (orange-leaning)', () => {
            const pixels = createLabPixels([
                { L: 65, a: 30, b: 60, count: 100 }    // Ochre hue ~63° (close to orange)
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 1, 1, { richDNA: true });

            expect(dna.sectors.yellow).toBeDefined();
            expect(dna.sectors.yellow.hMean).toBeGreaterThan(60);
            expect(dna.sectors.yellow.hMean).toBeLessThan(70);
        });

        test('should calculate hMean for lemon yellow (chartreuse-leaning)', () => {
            const pixels = createLabPixels([
                { L: 90, a: 5, b: 80, count: 100 }     // Lemon hue ~86° (close to green)
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 1, 1, { richDNA: true });

            expect(dna.sectors.yellow).toBeDefined();
            expect(dna.sectors.yellow.hMean).toBeGreaterThan(85);
            expect(dna.sectors.yellow.hMean).toBeLessThan(90);
        });

        test('should filter out near-neutral colors (chroma < 5)', () => {
            const pixels = createLabPixels([
                { L: 50, a: 2, b: 2, count: 900 },     // Gray (chroma ~2.8) - should be ignored
                { L: 85, a: 10, b: 80, count: 100 }    // Yellow (chroma ~80) - should be counted
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 10, 1, { richDNA: true });

            expect(dna.sectors.yellow).toBeDefined();
            expect(dna.sectors.yellow.weight).toBeGreaterThan(0.9); // Yellow dominates chromatic pixels
            // Gray should not pollute the yellow hMean
            expect(dna.sectors.yellow.hMean).toBeGreaterThan(75);
        });

        test('should calculate hMean for multiple sectors', () => {
            const pixels = createLabPixels([
                { L: 85, a: 10, b: 80, count: 100 },   // Yellow ~83°
                { L: 60, a: 50, b: 30, count: 100 },   // Orange ~31°
                { L: 50, a: -60, b: 20, count: 100 }   // Green ~162°
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 3, 1, { richDNA: true });

            // Yellow sector
            expect(dna.sectors.yellow).toBeDefined();
            expect(dna.sectors.yellow.hMean).toBeGreaterThan(75);
            expect(dna.sectors.yellow.hMean).toBeLessThan(90);

            // Orange sector
            expect(dna.sectors.orange).toBeDefined();
            expect(dna.sectors.orange.hMean).toBeGreaterThan(25);
            expect(dna.sectors.orange.hMean).toBeLessThan(40);

            // Cyan sector (green at 162° falls into cyan sector 150-180°)
            expect(dna.sectors.cyan).toBeDefined();
            expect(dna.sectors.cyan.hMean).toBeGreaterThan(155);
            expect(dna.sectors.cyan.hMean).toBeLessThan(170);
        });

        test('should calculate different hMean for different yellow shades', () => {
            // Image 1: Ochre yellow (darker, orange-leaning)
            const ochrePixels = createLabPixels([
                { L: 65, a: 30, b: 60, count: 100 }    // ~63° (orange-leaning)
            ]);

            // Image 2: Lemon yellow (brighter, green-leaning)
            const lemonPixels = createLabPixels([
                { L: 90, a: 5, b: 85, count: 100 }     // ~87° (green-leaning)
            ]);

            const ochreDNA = DNAGenerator.generate(ochrePixels, 100, 1, 1, { richDNA: true });
            const lemonDNA = DNAGenerator.generate(lemonPixels, 100, 1, 1, { richDNA: true });

            const ochreHue = ochreDNA.sectors.yellow.hMean;
            const lemonHue = lemonDNA.sectors.yellow.hMean;

            // Ochre should be lower hue (more orange)
            expect(ochreHue).toBeLessThan(70);
            // Lemon should be higher hue (more green)
            expect(lemonHue).toBeGreaterThan(85);
            // They should be significantly different
            expect(lemonHue - ochreHue).toBeGreaterThan(15);
        });

        test('should handle mixed hues in same sector (calculates mean)', () => {
            const pixels = createLabPixels([
                { L: 85, a: 20, b: 60, count: 100 },   // ~72° (orange-leaning yellow)
                { L: 85, a: 5, b: 85, count: 100 }     // ~87° (green-leaning yellow)
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 2, 1, { richDNA: true });

            // hMean should be approximately the average: (72 + 87) / 2 ≈ 79.5°
            expect(dna.sectors.yellow.hMean).toBeGreaterThan(75);
            expect(dna.sectors.yellow.hMean).toBeLessThan(85);
        });
    });

    describe('Sector Coverage and Weight', () => {
        test('should calculate weight as proportion of chromatic pixels (chroma-weighted)', () => {
            const pixels = createLabPixels([
                { L: 85, a: 10, b: 80, count: 30 },    // Yellow (30 pixels, chroma ~80)
                { L: 60, a: 50, b: 30, count: 70 }     // Orange (70 pixels, chroma ~58)
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 1, 1, { richDNA: true });

            // Weight is chroma-weighted, not raw pixel count
            // Yellow: 30 pixels × chroma weight ~0.8 = ~24 weighted units
            // Orange: 70 pixels × chroma weight ~0.58 = ~40 weighted units
            // Total: ~64 weighted units
            // Yellow weight ≈ 24/64 ≈ 0.375 (37.5%)
            // Orange weight ≈ 40/64 ≈ 0.625 (62.5%)
            expect(dna.sectors.yellow.weight).toBeGreaterThan(0.30);
            expect(dna.sectors.yellow.weight).toBeLessThan(0.45);
            expect(dna.sectors.orange.weight).toBeGreaterThan(0.55);
            expect(dna.sectors.orange.weight).toBeLessThan(0.70);
        });

        test('should exclude grays from weight calculation', () => {
            const pixels = createLabPixels([
                { L: 50, a: 1, b: 1, count: 800 },     // Gray (chroma <5) - excluded
                { L: 85, a: 10, b: 80, count: 200 }    // Yellow - counted
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 10, 1, { richDNA: true });

            // Yellow should be 100% of chromatic pixels (grays excluded)
            expect(dna.sectors.yellow.weight).toBeGreaterThan(0.95);
        });

        test('should track multiple sector properties (lMean, lStdDev, cMax)', () => {
            const pixels = createLabPixels([
                { L: 80, a: 10, b: 80, count: 50 },
                { L: 90, a: 10, b: 80, count: 50 }
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 1, 1, { richDNA: true });

            expect(dna.sectors.yellow).toBeDefined();
            expect(dna.sectors.yellow.lMean).toBeCloseTo(85, 0); // Average L
            expect(dna.sectors.yellow.lStdDev).toBeGreaterThan(0); // Variance in L
            expect(dna.sectors.yellow.cMax).toBeGreaterThan(70); // Peak chroma
        });
    });

    describe('Edge Cases', () => {
        test('should handle grayscale image (no sectors)', () => {
            const pixels = createLabPixels([
                { L: 30, a: 0, b: 0, count: 100 },
                { L: 70, a: 0, b: 0, count: 100 }
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 2, 1, { richDNA: true });

            // No sectors should be created (all neutral)
            const sectorKeys = Object.keys(dna.sectors);
            expect(sectorKeys.length).toBe(0);
        });

        test('should handle single-color image', () => {
            const pixels = createLabPixels([
                { L: 85, a: 10, b: 80, count: 100 }
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 1, 1, { richDNA: true });

            expect(dna.sectors.yellow).toBeDefined();
            expect(dna.sectors.yellow.weight).toBeCloseTo(1.0, 1); // 100% yellow
            expect(dna.sectors.yellow.lStdDev).toBe(0); // No variance
        });

        test('should handle very small chroma values near threshold', () => {
            const pixels = createLabPixels([
                { L: 50, a: 4, b: 4, count: 100 },     // chroma ~5.66 (just above threshold)
                { L: 50, a: 3, b: 3, count: 100 }      // chroma ~4.24 (below threshold)
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 2, 1, { richDNA: true });

            // Only the first color (chroma > 5) should create a sector
            const sectorKeys = Object.keys(dna.sectors);
            expect(sectorKeys.length).toBeGreaterThan(0);
        });
    });

    describe('Backward Compatibility', () => {
        test('should return legacy DNA format when richDNA=false', () => {
            const pixels = createLabPixels([
                { L: 85, a: 10, b: 80, count: 100 }
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 1, 1, { richDNA: false });

            // Legacy format should NOT have sectors
            expect(dna.sectors).toBeUndefined();
            // But should have legacy fields
            expect(dna.l).toBeDefined();
            expect(dna.c).toBeDefined();
            expect(dna.k).toBeDefined();
        });

        test('should include both legacy and v2 fields when richDNA=true', () => {
            const pixels = createLabPixels([
                { L: 85, a: 10, b: 80, count: 100 }
            ]);

            const dna = DNAGenerator.generate(pixels, 100, 1, 1, { richDNA: true });

            // Legacy fields (backward compatible)
            expect(dna.l).toBeDefined();
            expect(dna.c).toBeDefined();
            expect(dna.k).toBeDefined();
            expect(dna.yellowDominance).toBeDefined();

            // v2.0 fields
            expect(dna.version).toBe('2.0');
            expect(dna.global).toBeDefined();
            expect(dna.sectors).toBeDefined();
        });
    });
});
