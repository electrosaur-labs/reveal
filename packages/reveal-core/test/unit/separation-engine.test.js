/**
 * SeparationEngine - Dithering Tests
 *
 * Tests for Floyd-Steinberg error diffusion and dithering functionality
 */

import { describe, test, expect } from 'vitest';

const SeparationEngine = require('../../lib/engines/SeparationEngine');

// Helper to convert perceptual Lab to 16-bit encoding
// 16-bit encoding: L: 0-100 → 0-32768, a/b: -128 to +127 → 0-32768 (neutral=16384)
const labTo16bit = (L, a, b) => ({
    L: Math.round((L / 100) * 32768),
    a: Math.round((a / 128) * 16384 + 16384),
    b: Math.round((b / 128) * 16384 + 16384)
});

// Helper to create 16-bit Lab pixel array from perceptual values
const createLab16Pixels = (pixelValues) => {
    const result = new Uint16Array(pixelValues.length * 3);
    for (let i = 0; i < pixelValues.length; i++) {
        const { L, a, b } = pixelValues[i];
        const lab16 = labTo16bit(L, a, b);
        result[i * 3] = lab16.L;
        result[i * 3 + 1] = lab16.a;
        result[i * 3 + 2] = lab16.b;
    }
    return result;
};

describe('SeparationEngine - Dithering', () => {
    const testPalette = [
        { L: 0, a: 0, b: 0 },      // Black
        { L: 100, a: 0, b: 0 }     // White
    ];

    describe('Nearest-Neighbor (No Dithering)', () => {
        test('should map pixels to nearest color', async () => {
            // 4 pixels: 2 black (L=10), 2 white (L=90)
            const rawBytes = createLab16Pixels([
                { L: 10, a: 0, b: 0 },  // Black
                { L: 90, a: 0, b: 0 },  // White
                { L: 10, a: 0, b: 0 },  // Black
                { L: 90, a: 0, b: 0 }   // White
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
            const rawBytes = createLab16Pixels([
                { L: 10, a: 0, b: 0 },  // Black
                { L: 90, a: 0, b: 0 }   // White
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
            const pixels = [];
            for (let i = 0; i < 10; i++) {
                const L = (i / 9) * 100;  // 0 to 100 in perceptual range
                pixels.push({ L, a: 0, b: 0 });
            }
            const rawBytes = createLab16Pixels(pixels);

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
            const rawBytes = createLab16Pixels([
                { L: 10, a: 0, b: 0 },  // definitely black
                { L: 45, a: 0, b: 0 },  // probably black, might flip with error
                { L: 55, a: 0, b: 0 },  // probably white, might flip with error
                { L: 90, a: 0, b: 0 }   // definitely white
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
            const pixels = [];
            for (let i = 0; i < 10; i++) {
                const L = (i / 9) * 100;  // 0 to 100 perceptual
                pixels.push({ L, a: 0, b: 0 });
            }
            const rawBytes = createLab16Pixels(pixels);

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
            const pixels = [];

            for (let i = 0; i < width * height; i++) {
                pixels.push({ L: 50, a: 0, b: 0 }); // L=50 (midpoint)
            }
            const rawBytes = createLab16Pixels(pixels);

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
            const rawBytes = createLab16Pixels([
                { L: 50, a: 0, b: 0 },  // Middle gray at top-left
                { L: 50, a: 0, b: 0 }   // Middle gray at top-right
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
            const pixels = [];
            for (let i = 0; i < 10; i++) {
                const L = (i / 9) * 100;
                pixels.push({ L, a: 0, b: 0 });
            }
            const rawBytes = createLab16Pixels(pixels);

            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, multiPalette, null, 10, 1, { ditherType: 'floyd-steinberg' }
            );

            // Should use all palette colors
            expect(result.length).toBe(10);
            expect(result.every(idx => idx >= 0 && idx < 4)).toBe(true);
        });
    });

    describe('Bayer 8x8 Dithering', () => {
        test('should apply ordered dithering', async () => {
            // 2x2 gradient: 2 black, 2 white
            const rawBytes = createLab16Pixels([
                { L: 10, a: 0, b: 0 },  // Black
                { L: 90, a: 0, b: 0 },  // White
                { L: 10, a: 0, b: 0 },  // Black
                { L: 90, a: 0, b: 0 }   // White
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
            const rawBytes = createLab16Pixels([{ L: 50, a: 0, b: 0 }]); // Gray

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

        test('should accept LPI-aware scale parameter (Rule of 7)', async () => {
            // 4x4 gradient image
            const pixels = [];
            for (let i = 0; i < 16; i++) {
                const L = (i / 15) * 100;
                pixels.push({ L, a: 0, b: 0 });
            }
            const rawBytes = createLab16Pixels(pixels);

            // Test with 230 mesh (maxLPI = 32.8, scale = ~9 pixels)
            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                testPalette,
                null,
                4,
                4,
                { ditherType: 'bayer', meshCount: 230, dpi: 300 }
            );

            expect(result.length).toBe(16);
            // All should map to valid indices
            for (let i = 0; i < result.length; i++) {
                expect([0, 1]).toContain(result[i]);
            }
        });
    });

    describe('Atkinson Dithering', () => {
        test('should apply error diffusion with atkinson', async () => {
            // 2x2 gradient
            const rawBytes = createLab16Pixels([
                { L: 10, a: 0, b: 0 },  // Black
                { L: 90, a: 0, b: 0 },  // White
                { L: 10, a: 0, b: 0 },  // Black
                { L: 90, a: 0, b: 0 }   // White
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
            const pixels = [];
            for (let i = 0; i < 10; i++) {
                const L = (i / 9) * 100;  // 0 to 100 perceptual
                pixels.push({ L, a: 0, b: 0 });
            }
            const rawBytes = createLab16Pixels(pixels);

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
            const rawBytes = createLab16Pixels([{ L: 50, a: 0, b: 0 }]);

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
            const rawBytes = createLab16Pixels([
                { L: 10, a: 0, b: 0 },  // Black
                { L: 90, a: 0, b: 0 },  // White
                { L: 10, a: 0, b: 0 },  // Black
                { L: 90, a: 0, b: 0 }   // White
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
            const pixels = [];
            for (let i = 0; i < 10; i++) {
                const L = (i / 9) * 100;  // 0 to 100 perceptual
                pixels.push({ L, a: 0, b: 0 });
            }
            const rawBytes = createLab16Pixels(pixels);

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
            const pixels = [];
            for (let i = 0; i < 50; i++) {
                pixels.push({ L: 10, a: 0, b: 0 }); // Black
            }
            for (let i = 0; i < 50; i++) {
                pixels.push({ L: 90, a: 0, b: 0 }); // White
            }
            const rawBytes = createLab16Pixels(pixels);

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
            const rawBytes = createLab16Pixels([{ L: 50, a: 0, b: 0 }]);

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

            const rawBytes = createLab16Pixels([
                { L: 20, a: 0, b: 0 },  // Black or Gray
                { L: 50, a: 0, b: 0 },  // Gray
                { L: 78, a: 0, b: 0 }   // Gray or White
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
            const rawBytes = createLab16Pixels([{ L: 10, a: 0, b: 0 }]);

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
            const rawBytes = createLab16Pixels([{ L: 10, a: 0, b: 0 }]);

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

        test('should reject empty palette with descriptive error', async () => {
            const rawBytes = createLab16Pixels([{ L: 50, a: 0, b: 0 }]);

            await expect(SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes,
                [],
                null,
                1,
                1,
                { ditherType: 'floyd-steinberg' }
            )).rejects.toThrow('labPalette must be a non-empty array');
        });

        test('should handle single-pixel image', async () => {
            const rawBytes = createLab16Pixels([{ L: 50, a: 0, b: 0 }]);

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
            const rawBytes = createLab16Pixels([
                { L: 0, a: -128, b: -128 },  // Extreme dark
                { L: 100, a: 127, b: 127 }   // Extreme light
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
            const pixels = [];
            for (let i = 0; i < 100; i++) {
                const L = (i / 99) * 100;
                pixels.push({ L, a: 0, b: 0 });
            }
            const rawBytes = createLab16Pixels(pixels);

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
            // 100k pixels of gray
            const pixels = [];
            for (let i = 0; i < 100000; i++) {
                pixels.push({ L: 50, a: 0, b: 0 });
            }
            const rawBytes = createLab16Pixels(pixels);

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
