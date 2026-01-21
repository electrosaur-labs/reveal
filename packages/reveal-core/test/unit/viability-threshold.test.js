/**
 * Unit Tests for Minimum Viability Threshold (Speckle Filtering)
 *
 * Tests the safety system filters that prevent "dust" from becoming screens:
 * 1. Preserved Color Viability: White/Black must have >= 0.1% coverage to be included
 * 2. Hue Gap Viability: Missing hue sectors must have >= 0.25% coverage to justify a screen
 *
 * These filters prevent the safety systems (Preserved Colors & Hue Gap Analysis) from
 * bypassing quality control (Density Floor). A 0.04% layer is a dirty rag, not a feature.
 */

import { describe, test, expect } from 'vitest';

// Import PosterizationEngine
const PosterizationEngine = require('../../lib/engines/PosterizationEngine');

describe('Minimum Viability Threshold (Speckle Filtering)', () => {

    describe('Preserved Color Viability (0.1% threshold)', () => {

        // Helper to create byte-encoded Lab value
        // Byte encoding: L: 0-100 → 0-255, a/b: -128 to +127 → 0-255
        const labToByte = (L, a, b) => ({
            L: (L / 100) * 255,       // L: 0-100 → 0-255
            a: a + 128,               // a: -128..127 → 0-255
            b: b + 128                // b: -128..127 → 0-255
        });

        test('should include white when coverage >= 0.1%', () => {
            // Create Lab pixels: 10000 pixels, 20 white (0.2% - above threshold)
            const totalPixels = 10000;
            const labPixels = new Float32Array(totalPixels * 3);

            // Mid-gray in byte encoding: L=50 (127), a=0 (128), b=0 (128)
            const gray = labToByte(50, 0, 0);
            for (let i = 0; i < totalPixels * 3; i += 3) {
                labPixels[i] = gray.L;
                labPixels[i + 1] = gray.a;
                labPixels[i + 2] = gray.b;
            }

            // White pixels: L=98 (250), a=0, b=0
            const white = labToByte(98, 0, 0);
            for (let i = 0; i < 20; i++) {
                const idx = i * 3;
                labPixels[idx] = white.L;
                labPixels[idx + 1] = white.a;
                labPixels[idx + 2] = white.b;
            }

            const result = PosterizationEngine.posterize(labPixels, 100, 100, 5, {
                format: 'lab',
                preserveWhite: true,
                preserveBlack: false,
                enableHueGapAnalysis: false,
                engine: 'reveal'
            });

            // White should be in the palette (coverage 0.2% >= 0.1% threshold)
            const hasWhite = result.palette.some(c => c.r > 250 && c.g > 250 && c.b > 250);
            expect(hasWhite).toBe(true);
        });

        test('should SKIP white when coverage < 0.1%', () => {
            // Create Lab pixels: 10000 pixels, only 5 white (0.05% - below threshold)
            const totalPixels = 10000;
            const labPixels = new Float32Array(totalPixels * 3);

            const gray = labToByte(50, 0, 0);
            for (let i = 0; i < totalPixels * 3; i += 3) {
                labPixels[i] = gray.L;
                labPixels[i + 1] = gray.a;
                labPixels[i + 2] = gray.b;
            }

            // Only 5 white pixels (0.05% - dust)
            const white = labToByte(98, 0, 0);
            for (let i = 0; i < 5; i++) {
                const idx = i * 3;
                labPixels[idx] = white.L;
                labPixels[idx + 1] = white.a;
                labPixels[idx + 2] = white.b;
            }

            const result = PosterizationEngine.posterize(labPixels, 100, 100, 5, {
                format: 'lab',
                preserveWhite: true,
                preserveBlack: false,
                enableHueGapAnalysis: false,
                engine: 'reveal'
            });

            // White should NOT be in the palette (coverage 0.05% < 0.1% threshold)
            const hasWhite = result.palette.some(c => c.r > 250 && c.g > 250 && c.b > 250);
            expect(hasWhite).toBe(false);
        });

        test('should include black when coverage >= 0.1%', () => {
            // Create Lab pixels: 10000 pixels, 15 black (0.15% - above threshold)
            const totalPixels = 10000;
            const labPixels = new Float32Array(totalPixels * 3);

            const gray = labToByte(50, 0, 0);
            for (let i = 0; i < totalPixels * 3; i += 3) {
                labPixels[i] = gray.L;
                labPixels[i + 1] = gray.a;
                labPixels[i + 2] = gray.b;
            }

            // 15 black pixels (0.15%): L=3
            const black = labToByte(3, 0, 0);
            for (let i = 0; i < 15; i++) {
                const idx = i * 3;
                labPixels[idx] = black.L;
                labPixels[idx + 1] = black.a;
                labPixels[idx + 2] = black.b;
            }

            const result = PosterizationEngine.posterize(labPixels, 100, 100, 5, {
                format: 'lab',
                preserveWhite: false,
                preserveBlack: true,
                enableHueGapAnalysis: false,
                engine: 'reveal'
            });

            // Black should be in the palette (coverage 0.15% >= 0.1% threshold)
            const hasBlack = result.palette.some(c => c.r < 5 && c.g < 5 && c.b < 5);
            expect(hasBlack).toBe(true);
        });

        test('should SKIP black when coverage < 0.1%', () => {
            // Create Lab pixels: 10000 pixels, only 3 black (0.03% - way below threshold)
            const totalPixels = 10000;
            const labPixels = new Float32Array(totalPixels * 3);

            const gray = labToByte(50, 0, 0);
            for (let i = 0; i < totalPixels * 3; i += 3) {
                labPixels[i] = gray.L;
                labPixels[i + 1] = gray.a;
                labPixels[i + 2] = gray.b;
            }

            // Only 3 black pixels (0.03% - dust)
            const black = labToByte(3, 0, 0);
            for (let i = 0; i < 3; i++) {
                const idx = i * 3;
                labPixels[idx] = black.L;
                labPixels[idx + 1] = black.a;
                labPixels[idx + 2] = black.b;
            }

            const result = PosterizationEngine.posterize(labPixels, 100, 100, 5, {
                format: 'lab',
                preserveWhite: false,
                preserveBlack: true,
                enableHueGapAnalysis: false,
                engine: 'reveal'
            });

            // Black should NOT be in the palette (coverage 0.03% < 0.1% threshold)
            const hasBlack = result.palette.some(c => c.r < 5 && c.g < 5 && c.b < 5);
            expect(hasBlack).toBe(false);
        });

        test('should handle boundary case: exactly 0.1% coverage', () => {
            // Create Lab pixels: 10000 pixels, exactly 10 white (0.1%)
            const totalPixels = 10000;
            const labPixels = new Float32Array(totalPixels * 3);

            const gray = labToByte(50, 0, 0);
            for (let i = 0; i < totalPixels * 3; i += 3) {
                labPixels[i] = gray.L;
                labPixels[i + 1] = gray.a;
                labPixels[i + 2] = gray.b;
            }

            // Exactly 10 white pixels (0.1%)
            const white = labToByte(98, 0, 0);
            for (let i = 0; i < 10; i++) {
                const idx = i * 3;
                labPixels[idx] = white.L;
                labPixels[idx + 1] = white.a;
                labPixels[idx + 2] = white.b;
            }

            const result = PosterizationEngine.posterize(labPixels, 100, 100, 5, {
                format: 'lab',
                preserveWhite: true,
                preserveBlack: false,
                enableHueGapAnalysis: false,
                engine: 'reveal'
            });

            // White should be included (exactly at threshold)
            const hasWhite = result.palette.some(c => c.r > 250 && c.g > 250 && c.b > 250);
            expect(hasWhite).toBe(true);
        });
    });

    describe('Hue Gap Viability (0.25% threshold)', () => {

        // Helper for byte encoding
        const labToByte = (L, a, b) => ({
            L: (L / 100) * 255,
            a: a + 128,
            b: b + 128
        });

        test('should include hue gap color when sector coverage >= 0.25%', () => {
            // Create image with dominant yellow and a significant red sector (5%)
            const totalPixels = 10000;
            const labPixels = new Float32Array(totalPixels * 3);

            // 95% Yellow (L=70, a=-10, b=60)
            const yellow = labToByte(70, -10, 60);
            for (let i = 0; i < 9500 * 3; i += 3) {
                labPixels[i] = yellow.L;
                labPixels[i + 1] = yellow.a;
                labPixels[i + 2] = yellow.b;
            }

            // 5% distinct Red (L=50, a=60, b=30) - well above 0.25% threshold
            const red = labToByte(50, 60, 30);
            for (let i = 9500 * 3; i < totalPixels * 3; i += 3) {
                labPixels[i] = red.L;
                labPixels[i + 1] = red.a;
                labPixels[i + 2] = red.b;
            }

            const result = PosterizationEngine.posterize(labPixels, 100, 100, 5, {
                format: 'lab',
                preserveWhite: false,
                preserveBlack: false,
                enableHueGapAnalysis: true,
                engine: 'reveal'
            });

            // Should have both yellow and red colors in palette
            // Red has high positive 'a' channel → high R, low G in RGB
            const hasReddish = result.palette.some(c => {
                return c.r > 150 && c.g < 120;
            });
            expect(hasReddish).toBe(true);
        });

        test('should SKIP hue gap color when sector coverage < 0.25%', () => {
            // Create image with dominant yellow and tiny red sector (0.1% - below threshold)
            const totalPixels = 10000;
            const labPixels = new Float32Array(totalPixels * 3);

            // 99.9% Yellow (L=70, a=-10, b=60)
            const yellow = labToByte(70, -10, 60);
            for (let i = 0; i < 9990 * 3; i += 3) {
                labPixels[i] = yellow.L;
                labPixels[i + 1] = yellow.a;
                labPixels[i + 2] = yellow.b;
            }

            // Only 0.1% Red (10 pixels - dust) - below 0.25% threshold
            const red = labToByte(50, 60, 30);
            for (let i = 9990 * 3; i < totalPixels * 3; i += 3) {
                labPixels[i] = red.L;
                labPixels[i + 1] = red.a;
                labPixels[i + 2] = red.b;
            }

            const result = PosterizationEngine.posterize(labPixels, 100, 100, 5, {
                format: 'lab',
                preserveWhite: false,
                preserveBlack: false,
                enableHueGapAnalysis: true,
                engine: 'reveal'
            });

            // Red sector should NOT be force-included (only 0.1% < 0.25% threshold)
            // The palette should be mostly yellow shades
            const hasStrongRed = result.palette.some(c => {
                return c.r > 200 && c.g < 80 && c.b < 80;
            });
            expect(hasStrongRed).toBe(false);
        });
    });

    describe('Combined Behavior', () => {

        const labToByte = (L, a, b) => ({
            L: (L / 100) * 255,
            a: a + 128,
            b: b + 128
        });

        test('should apply both thresholds independently', () => {
            // Image with:
            // - 95% mid-gray
            // - 0.05% white (below 0.1% - should skip)
            // - 0.05% black (below 0.1% - should skip)
            // - 4.9% light gray
            const totalPixels = 10000;
            const labPixels = new Float32Array(totalPixels * 3);

            const gray = labToByte(50, 0, 0);
            const white = labToByte(98, 0, 0);
            const black = labToByte(3, 0, 0);
            const lightGray = labToByte(70, 0, 0);

            // 95% mid-gray
            for (let i = 0; i < 9500 * 3; i += 3) {
                labPixels[i] = gray.L;
                labPixels[i + 1] = gray.a;
                labPixels[i + 2] = gray.b;
            }

            // 0.05% white (5 pixels)
            for (let i = 9500 * 3; i < 9505 * 3; i += 3) {
                labPixels[i] = white.L;
                labPixels[i + 1] = white.a;
                labPixels[i + 2] = white.b;
            }

            // 0.05% black (5 pixels)
            for (let i = 9505 * 3; i < 9510 * 3; i += 3) {
                labPixels[i] = black.L;
                labPixels[i + 1] = black.a;
                labPixels[i + 2] = black.b;
            }

            // Remaining is light gray
            for (let i = 9510 * 3; i < totalPixels * 3; i += 3) {
                labPixels[i] = lightGray.L;
                labPixels[i + 1] = lightGray.a;
                labPixels[i + 2] = lightGray.b;
            }

            const result = PosterizationEngine.posterize(labPixels, 100, 100, 10, {
                format: 'lab',
                preserveWhite: true,
                preserveBlack: true,
                enableHueGapAnalysis: true,
                engine: 'reveal'
            });

            // Neither white nor black should be in palette (both 0.05% < 0.1%)
            const hasWhite = result.palette.some(c => c.r > 250 && c.g > 250 && c.b > 250);
            const hasBlack = result.palette.some(c => c.r < 5 && c.g < 5 && c.b < 5);

            expect(hasWhite).toBe(false);
            expect(hasBlack).toBe(false);
        });

        test('should not protect skipped preserved colors from density floor', () => {
            // When preserved color is skipped due to viability threshold,
            // it shouldn't be protected from density floor either
            const totalPixels = 10000;
            const labPixels = new Float32Array(totalPixels * 3);

            const white = labToByte(98, 0, 0);

            // Fill with varied grays (L from 40-80 in byte encoding)
            for (let i = 0; i < totalPixels * 3; i += 3) {
                const L = 40 + ((i / 3) % 40);  // L from 40-80
                const gray = labToByte(L, 0, 0);
                labPixels[i] = gray.L;
                labPixels[i + 1] = gray.a;
                labPixels[i + 2] = gray.b;
            }

            // 3 white pixels (0.03% - below viability)
            for (let i = 0; i < 3; i++) {
                const idx = i * 3;
                labPixels[idx] = white.L;
                labPixels[idx + 1] = white.a;
                labPixels[idx + 2] = white.b;
            }

            const result = PosterizationEngine.posterize(labPixels, 100, 100, 5, {
                format: 'lab',
                preserveWhite: true,
                preserveBlack: false,
                enableHueGapAnalysis: false,
                engine: 'reveal'
            });

            // White should not appear (skipped by viability, not protected by density floor)
            const hasWhite = result.palette.some(c => c.r > 250 && c.g > 250 && c.b > 250);
            expect(hasWhite).toBe(false);
        });
    });

    describe('Screen Printing Rationale', () => {
        /**
         * These tests document the print production rationale:
         * - A 230 mesh screen cannot hold 0.04% detail reliably
         * - Burning a screen for dust costs $50 and produces artifacts
         * - Better to let speckles map to nearest viable color
         */

        // Helper for byte encoding
        const labToByte = (L, a, b) => ({
            L: (L / 100) * 255,
            a: a + 128,
            b: b + 128
        });

        test('should prevent 0.04% white from becoming a screen (LOC poster scenario)', () => {
            // Simulates the loc_works_98516923 case that had 0.04% white
            const totalPixels = 1000000; // 1MP image
            const labPixels = new Float32Array(totalPixels * 3);

            // Fill with colored content (warm brownish: L=55, a=20, b=35)
            const warm = labToByte(55, 20, 35);
            for (let i = 0; i < totalPixels * 3; i += 3) {
                labPixels[i] = warm.L;
                labPixels[i + 1] = warm.a;
                labPixels[i + 2] = warm.b;
            }

            // 0.04% white = 400 pixels (dust on a scan)
            const white = labToByte(98, 0, 0);
            for (let i = 0; i < 400; i++) {
                const idx = i * 3;
                labPixels[idx] = white.L;
                labPixels[idx + 1] = white.a;
                labPixels[idx + 2] = white.b;
            }

            const result = PosterizationEngine.posterize(labPixels, 1000, 1000, 10, {
                format: 'lab',
                preserveWhite: true,
                preserveBlack: true,
                enableHueGapAnalysis: false,
                engine: 'reveal'
            });

            // 0.04% < 0.1% threshold, so white should not be in palette
            const hasWhite = result.palette.some(c => c.r > 250 && c.g > 250 && c.b > 250);
            expect(hasWhite).toBe(false);
        });

        test('should prevent 0.2% hue-gap blue from becoming a screen in warm image', () => {
            // Warm image with tiny blue speckles (sensor noise, artifact)
            const totalPixels = 100000;
            const labPixels = new Float32Array(totalPixels * 3);

            // 99.8% warm colors (orange/yellow: L=65, a=25, b=50)
            const warm = labToByte(65, 25, 50);
            for (let i = 0; i < 99800 * 3; i += 3) {
                labPixels[i] = warm.L;
                labPixels[i + 1] = warm.a;
                labPixels[i + 2] = warm.b;
            }

            // 0.2% blue speckles - below 0.25% hue gap threshold (L=40, a=10, b=-50)
            const blue = labToByte(40, 10, -50);
            for (let i = 99800 * 3; i < totalPixels * 3; i += 3) {
                labPixels[i] = blue.L;
                labPixels[i + 1] = blue.a;
                labPixels[i + 2] = blue.b;
            }

            const result = PosterizationEngine.posterize(labPixels, 316, 316, 8, {
                format: 'lab',
                preserveWhite: false,
                preserveBlack: false,
                enableHueGapAnalysis: true,
                engine: 'reveal'
            });

            // Blue should not be force-included (0.2% < 0.25% threshold)
            const hasStrongBlue = result.palette.some(c => c.b > 200 && c.r < 100 && c.g < 150);
            expect(hasStrongBlue).toBe(false);
        });
    });
});
