/**
 * Bit Depth Parity Test
 *
 * Verifies that 8-bit and 16-bit source documents produce consistent palettes
 * when processed through the posterization engine.
 *
 * Architecture:
 * - Both 8-bit and 16-bit sources are converted to 16-bit Lab for engine processing
 * - The engine tracks original bitDepth for decision-making (e.g., shadow/highlight gates)
 * - Palettes should be close/identical regardless of original source bit depth
 */

import { describe, it, expect } from 'vitest';
const PosterizationEngine = require('../../lib/engines/PosterizationEngine');
const { lab8to16 } = require('../helpers/lab-conversion');

describe('Bit Depth Parity', () => {
    /**
     * Helper: Create 8-bit Lab test image with specific colors
     */
    function create8bitLabImage(width, height, colors) {
        const pixels = new Uint8ClampedArray(width * height * 3);
        const pixelCount = width * height;
        const colorsPerSection = Math.floor(pixelCount / colors.length);

        for (let i = 0; i < pixelCount; i++) {
            const colorIndex = Math.min(Math.floor(i / colorsPerSection), colors.length - 1);
            const color = colors[colorIndex];
            const idx = i * 3;

            // 8-bit Lab encoding: L=0-255, a/b=0-255 (neutral=128)
            pixels[idx] = color.L8;
            pixels[idx + 1] = color.a8;
            pixels[idx + 2] = color.b8;
        }

        return pixels;
    }

    /**
     * Helper: Convert perceptual Lab to 8-bit encoding
     */
    function perceptualTo8bit(L, a, b) {
        return {
            L8: Math.round((L / 100) * 255),
            a8: Math.round(a + 128),
            b8: Math.round(b + 128)
        };
    }

    /**
     * Helper: Calculate Delta-E between two Lab colors (simplified CIE76)
     */
    function deltaE(lab1, lab2) {
        const dL = lab1.L - lab2.L;
        const da = lab1.a - lab2.a;
        const db = lab1.b - lab2.b;
        return Math.sqrt(dL * dL + da * da + db * db);
    }

    /**
     * Helper: Find best matching color in palette
     */
    function findClosestColor(target, palette) {
        let minDist = Infinity;
        let closest = null;

        for (const color of palette) {
            const dist = deltaE(target, color);
            if (dist < minDist) {
                minDist = dist;
                closest = color;
            }
        }

        return { color: closest, distance: minDist };
    }

    describe('8-bit vs 16-bit Source Parity', () => {
        it('should produce identical palettes from 8-bit and 16-bit sources', () => {
            const width = 100;
            const height = 100;

            // Define test colors in perceptual Lab
            // Using colors that are well within gamut and clearly distinguishable
            const testColors = [
                { L: 25, a: 0, b: 0 },    // Dark gray
                { L: 50, a: 0, b: 0 },    // Mid gray
                { L: 75, a: 0, b: 0 },    // Light gray
                { L: 50, a: 50, b: 0 },   // Red-ish
                { L: 50, a: -50, b: 0 },  // Green-ish
                { L: 50, a: 0, b: 50 },   // Yellow-ish
                { L: 50, a: 0, b: -50 },  // Blue-ish
            ];

            // Convert to 8-bit encoding
            const colors8bit = testColors.map(c => perceptualTo8bit(c.L, c.a, c.b));

            // Create 8-bit Lab image
            const lab8 = create8bitLabImage(width, height, colors8bit);

            // Convert to 16-bit (simulating what PhotoshopAPI.getDocumentPixels now does)
            const lab16 = lab8to16(lab8);

            // Run posterization with bitDepth=8 (original was 8-bit)
            const result8 = PosterizationEngine.posterize(
                lab16,  // Always 16-bit data now
                width,
                height,
                7,
                {
                    format: 'lab',
                    bitDepth: 8,  // Original source was 8-bit
                    engineType: 'reveal',
                    enableHueGapAnalysis: false,
                    enablePaletteReduction: false
                }
            );

            // Run posterization with bitDepth=16 (pretending source was 16-bit)
            const result16 = PosterizationEngine.posterize(
                lab16,  // Same 16-bit data
                width,
                height,
                7,
                {
                    format: 'lab',
                    bitDepth: 16,  // Source was 16-bit
                    engineType: 'reveal',
                    enableHueGapAnalysis: false,
                    enablePaletteReduction: false
                }
            );

            // Both should produce palettes
            expect(result8.paletteLab).toBeDefined();
            expect(result16.paletteLab).toBeDefined();

            // Palettes should have same number of colors
            expect(result8.paletteLab.length).toBe(result16.paletteLab.length);

            // Compare palettes - each color in palette8 should have a close match in palette16
            const maxAllowedDeltaE = 5.0; // Allow small differences due to gate threshold differences

            for (const color8 of result8.paletteLab) {
                const match = findClosestColor(color8, result16.paletteLab);
                expect(match.distance).toBeLessThan(maxAllowedDeltaE);
            }
        });

        it('should produce similar palettes for grayscale image', () => {
            const width = 50;
            const height = 50;

            // Pure grayscale ramp (no chroma)
            const grayColors = [
                { L: 10, a: 0, b: 0 },
                { L: 30, a: 0, b: 0 },
                { L: 50, a: 0, b: 0 },
                { L: 70, a: 0, b: 0 },
                { L: 90, a: 0, b: 0 },
            ];

            const colors8bit = grayColors.map(c => perceptualTo8bit(c.L, c.a, c.b));
            const lab8 = create8bitLabImage(width, height, colors8bit);
            const lab16 = lab8to16(lab8);

            const result8 = PosterizationEngine.posterize(
                lab16, width, height, 5,
                { format: 'lab', bitDepth: 8, engineType: 'reveal', enableHueGapAnalysis: false }
            );

            const result16 = PosterizationEngine.posterize(
                lab16, width, height, 5,
                { format: 'lab', bitDepth: 16, engineType: 'reveal', enableHueGapAnalysis: false }
            );

            expect(result8.paletteLab.length).toBe(result16.paletteLab.length);

            // For grayscale, palettes should be very close
            for (const color8 of result8.paletteLab) {
                const match = findClosestColor(color8, result16.paletteLab);
                expect(match.distance).toBeLessThan(3.0); // Tighter tolerance for grayscale
            }
        });

        it('should handle shadow gate differences correctly', () => {
            const width = 50;
            const height = 50;

            // Test colors near the shadow gate threshold
            // 8-bit uses L<7.5, 16-bit uses L<6.0
            const shadowTestColors = [
                { L: 5, a: 0, b: 0 },     // Below both gates - should become black
                { L: 6.5, a: 0, b: 0 },   // Between gates - different behavior expected
                { L: 8, a: 0, b: 0 },     // Above both gates - should be preserved
                { L: 50, a: 0, b: 0 },    // Mid gray - should be identical
            ];

            const colors8bit = shadowTestColors.map(c => perceptualTo8bit(c.L, c.a, c.b));
            const lab8 = create8bitLabImage(width, height, colors8bit);
            const lab16 = lab8to16(lab8);

            const result8 = PosterizationEngine.posterize(
                lab16, width, height, 4,
                { format: 'lab', bitDepth: 8, engineType: 'reveal', enableHueGapAnalysis: false }
            );

            const result16 = PosterizationEngine.posterize(
                lab16, width, height, 4,
                { format: 'lab', bitDepth: 16, engineType: 'reveal', enableHueGapAnalysis: false }
            );

            // Both should produce palettes (may differ slightly due to shadow gate)
            expect(result8.paletteLab).toBeDefined();
            expect(result16.paletteLab).toBeDefined();

            // Mid-gray should be present in both and match closely
            const midGray8 = result8.paletteLab.find(c => c.L > 40 && c.L < 60);
            const midGray16 = result16.paletteLab.find(c => c.L > 40 && c.L < 60);

            expect(midGray8).toBeDefined();
            expect(midGray16).toBeDefined();

            if (midGray8 && midGray16) {
                expect(deltaE(midGray8, midGray16)).toBeLessThan(2.0);
            }
        });

        it('should produce identical color count for chromatic image', () => {
            const width = 100;
            const height = 100;

            // Chromatic test with saturated colors
            const chromaticColors = [
                { L: 50, a: 80, b: 0 },    // Saturated magenta
                { L: 50, a: -80, b: 0 },   // Saturated green
                { L: 50, a: 0, b: 80 },    // Saturated yellow
                { L: 50, a: 0, b: -80 },   // Saturated blue
                { L: 50, a: 60, b: 60 },   // Orange
                { L: 50, a: -60, b: -60 }, // Cyan
            ];

            const colors8bit = chromaticColors.map(c => perceptualTo8bit(c.L, c.a, c.b));
            const lab8 = create8bitLabImage(width, height, colors8bit);
            const lab16 = lab8to16(lab8);

            const result8 = PosterizationEngine.posterize(
                lab16, width, height, 6,
                { format: 'lab', bitDepth: 8, engineType: 'reveal', enableHueGapAnalysis: false }
            );

            const result16 = PosterizationEngine.posterize(
                lab16, width, height, 6,
                { format: 'lab', bitDepth: 16, engineType: 'reveal', enableHueGapAnalysis: false }
            );

            // Color counts should match
            expect(result8.paletteLab.length).toBe(result16.paletteLab.length);

            // Each chromatic color should have a close match
            for (const color8 of result8.paletteLab) {
                const match = findClosestColor(color8, result16.paletteLab);
                expect(match.distance).toBeLessThan(5.0);
            }
        });
    });

    describe('16-bit Lab Conversion Accuracy', () => {
        it('should correctly convert 8-bit Lab to 16-bit Lab', () => {
            // Test specific values
            const testCases = [
                { L8: 0, a8: 128, b8: 128 },     // Black (neutral a/b)
                { L8: 255, a8: 128, b8: 128 },   // White (neutral a/b)
                { L8: 128, a8: 128, b8: 128 },   // Mid gray (neutral a/b)
                { L8: 128, a8: 0, b8: 128 },     // Green (a = -128)
                { L8: 128, a8: 255, b8: 128 },   // Magenta (a = +127)
                { L8: 128, a8: 128, b8: 0 },     // Blue (b = -128)
                { L8: 128, a8: 128, b8: 255 },   // Yellow (b = +127)
            ];

            for (const tc of testCases) {
                const lab8 = new Uint8ClampedArray([tc.L8, tc.a8, tc.b8]);
                const lab16 = lab8to16(lab8);

                // Convert both to perceptual Lab for comparison
                const perceptual8 = {
                    L: (tc.L8 / 255) * 100,
                    a: tc.a8 - 128,
                    b: tc.b8 - 128
                };

                const perceptual16 = {
                    L: (lab16[0] / 32768) * 100,
                    a: (lab16[1] - 16384) * (128 / 16384),
                    b: (lab16[2] - 16384) * (128 / 16384)
                };

                // Should be very close (within 8-bit quantization error)
                expect(Math.abs(perceptual8.L - perceptual16.L)).toBeLessThan(0.5);
                expect(Math.abs(perceptual8.a - perceptual16.a)).toBeLessThan(0.5);
                expect(Math.abs(perceptual8.b - perceptual16.b)).toBeLessThan(0.5);
            }
        });

        it('should preserve neutral gray in conversion', () => {
            // Neutral gray: L=128, a=128, b=128 in 8-bit
            const gray8 = new Uint8ClampedArray([128, 128, 128]);
            const gray16 = lab8to16(gray8);

            // In 16-bit, neutral a/b should be 16384
            expect(gray16[1]).toBe(16384); // a should be neutral
            expect(gray16[2]).toBe(16384); // b should be neutral

            // L should be approximately 50% of 32768
            const expectedL = Math.round((128 / 255) * 32768);
            expect(Math.abs(gray16[0] - expectedL)).toBeLessThan(2);
        });
    });
});
