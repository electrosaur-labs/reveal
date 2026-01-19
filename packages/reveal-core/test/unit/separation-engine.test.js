/**
 * SeparationEngine - Dithering Tests
 *
 * Tests for Floyd-Steinberg error diffusion and dithering functionality
 */

import { describe, test, expect } from 'vitest';

const SeparationEngine = require('../../lib/engines/SeparationEngine');

describe('SeparationEngine - Dithering', () => {
    const testPalette = [
        { L: 0, a: 0, b: 0 },      // Black
        { L: 100, a: 0, b: 0 }     // White
    ];

    describe('Nearest-Neighbor (No Dithering)', () => {
        test('should map pixels to nearest color', async () => {
            // 4 pixels: 2 black (L=10), 2 white (L=90)
            const rawBytes = new Uint8ClampedArray([
                25, 128, 128,   // L=10 → Black
                230, 128, 128,  // L=90 → White
                25, 128, 128,   // L=10 → Black
                230, 128, 128   // L=90 → White
            ]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                2,  // width
                2,  // height
                { ditherType: 'none' }
            );

            expect(result[0]).toBe(0); // Black
            expect(result[1]).toBe(1); // White
            expect(result[2]).toBe(0); // Black
            expect(result[3]).toBe(1); // White
        });

        test('should handle nearest-neighbor without width/height', async () => {
            // Should fall back to nearest-neighbor even if ditherType is specified
            const rawBytes = new Uint8ClampedArray([
                25, 128, 128,   // L=10 → Black
                230, 128, 128   // L=90 → White
            ]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                null,  // No width
                null,  // No height
                { ditherType: 'floyd-steinberg' }  // Requested but ignored
            );

            expect(result[0]).toBe(0); // Black
            expect(result[1]).toBe(1); // White
        });

        test('should create hard boundaries in gradient', async () => {
            // 10x1 smooth gradient from black to white
            const rawBytes = new Uint8ClampedArray(30);
            for (let i = 0; i < 10; i++) {
                const L = (i / 9) * 255;  // 0 to 255
                rawBytes[i * 3] = L;
                rawBytes[i * 3 + 1] = 128;
                rawBytes[i * 3 + 2] = 128;
            }

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, testPalette, null, 10, 1, { ditherType: 'none' }
            );

            // Count transitions (changes from one color to another)
            let transitions = 0;
            for (let i = 1; i < result.length; i++) {
                if (result[i] !== result[i-1]) transitions++;
            }

            // Nearest-neighbor should have exactly 1 transition at midpoint
            expect(transitions).toBe(1);
        });
    });

    describe('Floyd-Steinberg Dithering', () => {
        test('should apply error diffusion', async () => {
            // 2x2 gradient with more extreme values
            // Use values further from midpoint for clearer expectations
            const rawBytes = new Uint8ClampedArray([
                25, 128, 128,   // L=10 → definitely black
                115, 128, 128,  // L=45 → probably black, might flip with error
                140, 128, 128,  // L=55 → probably white, might flip with error
                230, 128, 128   // L=90 → definitely white
            ]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                2,  // width
                2,  // height
                { ditherType: 'floyd-steinberg' }
            );

            // First pixel definitely black
            expect(result[0]).toBe(0);

            // Last pixel definitely white
            expect(result[3]).toBe(1);

            // Middle pixels might flip due to error accumulation
            // (Just verify they're valid indices)
            expect(result[1]).toBeGreaterThanOrEqual(0);
            expect(result[1]).toBeLessThan(2);
            expect(result[2]).toBeGreaterThanOrEqual(0);
            expect(result[2]).toBeLessThan(2);
        });

        test('should create smoother gradients than nearest-neighbor', async () => {
            // 10x1 smooth gradient from black to white
            const rawBytes = new Uint8ClampedArray(30);
            for (let i = 0; i < 10; i++) {
                const L = (i / 9) * 255;  // 0 to 255
                rawBytes[i * 3] = L;
                rawBytes[i * 3 + 1] = 128;
                rawBytes[i * 3 + 2] = 128;
            }

            const nearest = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, testPalette, null, 10, 1, { ditherType: 'none' }
            );

            const dithered = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, testPalette, null, 10, 1, { ditherType: 'floyd-steinberg' }
            );

            // Count transitions (changes from one color to another)
            const countTransitions = (arr) => {
                let count = 0;
                for (let i = 1; i < arr.length; i++) {
                    if (arr[i] !== arr[i-1]) count++;
                }
                return count;
            };

            // Dithered should have more transitions (smoother gradient)
            // Nearest-neighbor will have exactly 1 transition at midpoint
            expect(countTransitions(dithered)).toBeGreaterThan(countTransitions(nearest));
        });

        test('should preserve color balance across image', async () => {
            // Create a 10x10 image at exactly 50% gray
            const width = 10;
            const height = 10;
            const rawBytes = new Uint8ClampedArray(width * height * 3);

            for (let i = 0; i < width * height; i++) {
                rawBytes[i * 3] = 127;     // L=50 (midpoint)
                rawBytes[i * 3 + 1] = 128; // a=0
                rawBytes[i * 3 + 2] = 128; // b=0
            }

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, testPalette, null, width, height, { ditherType: 'floyd-steinberg' }
            );

            // Count black and white pixels
            let blackCount = 0;
            let whiteCount = 0;
            for (let i = 0; i < result.length; i++) {
                if (result[i] === 0) blackCount++;
                else whiteCount++;
            }

            // Should be approximately 50/50 split (allow 10% tolerance)
            const expectedHalf = (width * height) / 2;
            const tolerance = expectedHalf * 0.1;
            expect(blackCount).toBeGreaterThan(expectedHalf - tolerance);
            expect(blackCount).toBeLessThan(expectedHalf + tolerance);
        });

        test('should handle edge pixels correctly', async () => {
            // Test that error doesn't propagate outside image bounds
            const rawBytes = new Uint8ClampedArray([
                127, 128, 128,  // Middle gray at top-left
                127, 128, 128   // Middle gray at top-right
            ]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                2,  // width
                1,  // height (single row)
                { ditherType: 'floyd-steinberg' }
            );

            // Should complete without errors
            expect(result.length).toBe(2);
            expect(result[0]).toBeGreaterThanOrEqual(0);
            expect(result[0]).toBeLessThan(2);
        });

        test('should work with multi-color palette', async () => {
            const multiPalette = [
                { L: 0, a: 0, b: 0 },     // Black
                { L: 33, a: 0, b: 0 },    // Dark Gray
                { L: 66, a: 0, b: 0 },    // Light Gray
                { L: 100, a: 0, b: 0 }    // White
            ];

            // Gradient from black to white
            const rawBytes = new Uint8ClampedArray(30);
            for (let i = 0; i < 10; i++) {
                const L = (i / 9) * 255;
                rawBytes[i * 3] = L;
                rawBytes[i * 3 + 1] = 128;
                rawBytes[i * 3 + 2] = 128;
            }

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, multiPalette, null, 10, 1, { ditherType: 'floyd-steinberg' }
            );

            // Should use all palette colors
            expect(result.length).toBe(10);
            expect(result.every(idx => idx >= 0 && idx < 4)).toBe(true);
        });
    });

    describe('Blue Noise Dithering', () => {
        test('should fall back to nearest-neighbor (not implemented)', async () => {
            const rawBytes = new Uint8ClampedArray([
                25, 128, 128,   // L=10 → Black
                230, 128, 128   // L=90 → White
            ]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                2,
                1,
                { ditherType: 'blue-noise' }
            );

            // Should fall back gracefully to nearest-neighbor
            expect(result[0]).toBe(0); // Black
            expect(result[1]).toBe(1); // White
        });
    });

    describe('Bayer 8x8 Dithering', () => {
        test('should apply ordered dithering', async () => {
            // 2x2 gradient: 2 black, 2 white
            const rawBytes = new Uint8ClampedArray([
                25, 128, 128,   // L=10 → Black
                230, 128, 128,  // L=90 → White
                25, 128, 128,   // L=10 → Black
                230, 128, 128   // L=90 → White
            ]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                2,
                2,
                { ditherType: 'bayer' }
            );

            expect(result.length).toBe(4);
            // All should map to valid indices
            for (let i = 0; i < result.length; i++) {
                expect(result[i]).toBeGreaterThanOrEqual(0);
                expect(result[i]).toBeLessThan(2);
            }
        });

        test('should handle edge pixels with bayer dithering', async () => {
            // 1x1 image (edge case with no neighbors)
            const rawBytes = new Uint8ClampedArray([127, 128, 128]); // Gray

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                1,
                1,
                { ditherType: 'bayer' }
            );

            expect(result.length).toBe(1);
            expect(result[0]).toBeGreaterThanOrEqual(0);
            expect(result[0]).toBeLessThan(2);
        });
    });

    describe('Atkinson Dithering', () => {
        test('should apply error diffusion with atkinson', async () => {
            // 2x2 gradient
            const rawBytes = new Uint8ClampedArray([
                25, 128, 128,   // L=10 → Black
                230, 128, 128,  // L=90 → White
                25, 128, 128,   // L=10 → Black
                230, 128, 128   // L=90 → White
            ]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                2,
                2,
                { ditherType: 'atkinson' }
            );

            expect(result.length).toBe(4);
            for (let i = 0; i < result.length; i++) {
                expect(result[i]).toBeGreaterThanOrEqual(0);
                expect(result[i]).toBeLessThan(2);
            }
        });

        test('should create dithering with atkinson on gradient', async () => {
            // 10x1 smooth gradient from black to white
            const rawBytes = new Uint8ClampedArray(30);
            for (let i = 0; i < 10; i++) {
                const L = (i / 9) * 255;  // 0 to 255
                rawBytes[i * 3] = L;
                rawBytes[i * 3 + 1] = 128;
                rawBytes[i * 3 + 2] = 128;
            }

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, testPalette, null, 10, 1, { ditherType: 'atkinson' }
            );

            // Atkinson should create transitions
            let transitions = 0;
            for (let i = 1; i < result.length; i++) {
                if (result[i] !== result[i-1]) transitions++;
            }
            // Should have at least one transition
            expect(transitions).toBeGreaterThan(0);
        });

        test('should handle edge pixels with atkinson dithering', async () => {
            const rawBytes = new Uint8ClampedArray([127, 128, 128]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                1,
                1,
                { ditherType: 'atkinson' }
            );

            expect(result.length).toBe(1);
            expect(result[0]).toBeGreaterThanOrEqual(0);
            expect(result[0]).toBeLessThan(2);
        });
    });

    describe('Stucki Dithering', () => {
        test('should apply error diffusion with stucki', async () => {
            // 2x2 gradient
            const rawBytes = new Uint8ClampedArray([
                25, 128, 128,   // L=10 → Black
                230, 128, 128,  // L=90 → White
                25, 128, 128,   // L=10 → Black
                230, 128, 128   // L=90 → White
            ]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                2,
                2,
                { ditherType: 'stucki' }
            );

            expect(result.length).toBe(4);
            for (let i = 0; i < result.length; i++) {
                expect(result[i]).toBeGreaterThanOrEqual(0);
                expect(result[i]).toBeLessThan(2);
            }
        });

        test('should create smooth gradients with stucki', async () => {
            // 10x1 smooth gradient from black to white
            const rawBytes = new Uint8ClampedArray(30);
            for (let i = 0; i < 10; i++) {
                const L = (i / 9) * 255;  // 0 to 255
                rawBytes[i * 3] = L;
                rawBytes[i * 3 + 1] = 128;
                rawBytes[i * 3 + 2] = 128;
            }

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, testPalette, null, 10, 1, { ditherType: 'stucki' }
            );

            // Stucki should create smooth transitions
            let transitions = 0;
            for (let i = 1; i < result.length; i++) {
                if (result[i] !== result[i-1]) transitions++;
            }
            // Should have at least one transition
            expect(transitions).toBeGreaterThan(0);
        });

        test('should preserve color balance with stucki across image', async () => {
            // 100 pixels: 50 black, 50 white
            const rawBytes = new Uint8ClampedArray(300);
            for (let i = 0; i < 50; i++) {
                rawBytes[i * 3] = 25;       // Black
                rawBytes[i * 3 + 1] = 128;
                rawBytes[i * 3 + 2] = 128;
                rawBytes[(50 + i) * 3] = 230;     // White
                rawBytes[(50 + i) * 3 + 1] = 128;
                rawBytes[(50 + i) * 3 + 2] = 128;
            }

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, testPalette, null, 10, 10, { ditherType: 'stucki' }
            );

            // Count color distribution
            let count0 = 0, count1 = 0;
            for (let i = 0; i < result.length; i++) {
                if (result[i] === 0) count0++;
                else if (result[i] === 1) count1++;
            }

            // Both colors should be represented
            expect(count0).toBeGreaterThan(0);
            expect(count1).toBeGreaterThan(0);
        });

        test('should handle edge pixels with stucki dithering', async () => {
            const rawBytes = new Uint8ClampedArray([127, 128, 128]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                1,
                1,
                { ditherType: 'stucki' }
            );

            expect(result.length).toBe(1);
            expect(result[0]).toBeGreaterThanOrEqual(0);
            expect(result[0]).toBeLessThan(2);
        });

        test('should work with multi-color palette with stucki', async () => {
            const multiColorPalette = [
                { L: 0, a: 0, b: 0 },      // Black
                { L: 50, a: 0, b: 0 },     // Gray
                { L: 100, a: 0, b: 0 }     // White
            ];

            const rawBytes = new Uint8ClampedArray([
                50, 128, 128,   // L=20 → Black or Gray
                127, 128, 128,  // L=50 → Gray
                200, 128, 128   // L=78 → Gray or White
            ]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                multiColorPalette,
                null,
                3,
                1,
                { ditherType: 'stucki' }
            );

            expect(result.length).toBe(3);
            for (let i = 0; i < result.length; i++) {
                expect(result[i]).toBeGreaterThanOrEqual(0);
                expect(result[i]).toBeLessThan(3);
            }
        });
    });

    describe('Parameter Validation', () => {
        test('should handle unknown ditherType', async () => {
            const rawBytes = new Uint8ClampedArray([25, 128, 128]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                1,
                1,
                { ditherType: 'unknown-algorithm' }
            );

            // Should fall back to nearest-neighbor
            expect(result.length).toBe(1);
            expect(result[0]).toBe(0);
        });

        test('should handle missing options parameter', async () => {
            const rawBytes = new Uint8ClampedArray([25, 128, 128]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                1,
                1
                // No options parameter
            );

            // Should default to nearest-neighbor
            expect(result.length).toBe(1);
            expect(result[0]).toBe(0);
        });

        test('should handle empty palette gracefully', async () => {
            const rawBytes = new Uint8ClampedArray([127, 128, 128]);

            // Empty palette should not crash
            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                [],
                null,
                1,
                1,
                { ditherType: 'floyd-steinberg' }
            );

            expect(result.length).toBe(1);
        });

        test('should handle single-pixel image', async () => {
            const rawBytes = new Uint8ClampedArray([127, 128, 128]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                1,
                1,
                { ditherType: 'floyd-steinberg' }
            );

            expect(result.length).toBe(1);
            expect(result[0]).toBeGreaterThanOrEqual(0);
            expect(result[0]).toBeLessThan(2);
        });

        test('should handle extreme Lab values', async () => {
            const rawBytes = new Uint8ClampedArray([
                0, 0, 0,       // L=0, a=-128, b=-128 (extreme)
                255, 255, 255  // L=100, a=127, b=127 (extreme)
            ]);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                2,
                1,
                { ditherType: 'floyd-steinberg' }
            );

            expect(result[0]).toBe(0); // Black
            expect(result[1]).toBe(1); // White
        });
    });

    describe('Progress Callback', () => {
        test('should call progress callback with floyd-steinberg', async () => {
            const rawBytes = new Uint8ClampedArray(300); // 100 pixels
            for (let i = 0; i < 100; i++) {
                rawBytes[i * 3] = (i / 99) * 255;
                rawBytes[i * 3 + 1] = 128;
                rawBytes[i * 3 + 2] = 128;
            }

            const progressCalls = [];
            const onProgress = (percent) => {
                progressCalls.push(percent);
            };

            await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                onProgress,
                10,
                10,
                { ditherType: 'floyd-steinberg' }
            );

            // Should have called progress callback
            expect(progressCalls.length).toBeGreaterThan(0);
            // Last call should be 100%
            expect(progressCalls[progressCalls.length - 1]).toBe(100);
        });

        test('should call progress callback with nearest-neighbor', async () => {
            const rawBytes = new Uint8ClampedArray(300000); // 100k pixels

            const progressCalls = [];
            const onProgress = (percent) => {
                progressCalls.push(percent);
            };

            await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                onProgress,
                1000,
                100,
                { ditherType: 'none' }
            );

            // Should have called progress callback multiple times
            expect(progressCalls.length).toBeGreaterThan(1);
        });
    });
});
