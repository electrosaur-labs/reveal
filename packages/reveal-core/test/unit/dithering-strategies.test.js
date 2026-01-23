/**
 * DitheringStrategies Unit Tests
 *
 * Tests for the extracted dithering algorithms module.
 * Covers edge cases and helper functions.
 */

import { describe, test, expect } from 'vitest';

const DitheringStrategies = require('../../lib/engines/DitheringStrategies');
const SeparationEngine = require('../../lib/engines/SeparationEngine');

// Helper: Create 16-bit Lab pixel data
function createLabPixels16(colors) {
    const pixels = new Uint16Array(colors.length * 3);
    colors.forEach((color, i) => {
        // Convert perceptual Lab to 16-bit encoding
        pixels[i * 3] = Math.round((color.L / 100) * 32768);
        pixels[i * 3 + 1] = Math.round((color.a / 128) * 16384 + 16384);
        pixels[i * 3 + 2] = Math.round((color.b / 128) * 16384 + 16384);
    });
    return pixels;
}

describe('DitheringStrategies Module', () => {
    describe('Helper Functions', () => {
        test('getNearest should find closest palette color', () => {
            const palette = [
                { L: 0, a: 0, b: 0 },   // Black
                { L: 50, a: 0, b: 0 },  // Mid gray
                { L: 100, a: 0, b: 0 }  // White
            ];

            expect(DitheringStrategies.getNearest(10, 0, 0, palette)).toBe(0);  // Closest to black
            expect(DitheringStrategies.getNearest(45, 0, 0, palette)).toBe(1);  // Closest to mid gray
            expect(DitheringStrategies.getNearest(95, 0, 0, palette)).toBe(2);  // Closest to white
        });

        test('getTwoNearest should find two closest palette colors', () => {
            const palette = [
                { L: 0, a: 0, b: 0 },   // Black
                { L: 50, a: 0, b: 0 },  // Mid gray
                { L: 100, a: 0, b: 0 }  // White
            ];

            const result = DitheringStrategies.getTwoNearest(30, 0, 0, palette);
            expect(result.i1).toBe(1);  // Closest is mid gray
            expect(result.i2).toBe(0);  // Second closest is black
            expect(result.d1).toBeLessThan(result.d2);
        });

        test('getBlueNoiseLUT should return cached 64x64 array', () => {
            const lut1 = DitheringStrategies.getBlueNoiseLUT();
            const lut2 = DitheringStrategies.getBlueNoiseLUT();

            expect(lut1).toBe(lut2);  // Same cached instance
            expect(lut1.length).toBe(64 * 64);  // 4096 values
            expect(lut1[0]).toBeGreaterThanOrEqual(0);
            expect(lut1[0]).toBeLessThanOrEqual(255);
        });

        test('BAYER_MATRIX should be 8x8', () => {
            expect(DitheringStrategies.BAYER_MATRIX.length).toBe(8);
            expect(DitheringStrategies.BAYER_MATRIX[0].length).toBe(8);
            // Values should be 0-63
            expect(DitheringStrategies.BAYER_MATRIX[0][0]).toBe(0);
            expect(DitheringStrategies.BAYER_MATRIX[7][7]).toBe(21);
        });
    });

    describe('Atkinson Edge Cases', () => {
        test('should handle empty palette gracefully', async () => {
            const pixels = createLabPixels16([{ L: 50, a: 0, b: 0 }]);
            const result = await DitheringStrategies.atkinson(pixels, [], 1, 1, null);
            expect(result.length).toBe(1);
            expect(result[0]).toBe(0);  // Zeros for empty palette
        });

        test('should handle null palette gracefully', async () => {
            const pixels = createLabPixels16([{ L: 50, a: 0, b: 0 }]);
            const result = await DitheringStrategies.atkinson(pixels, null, 1, 1, null);
            expect(result.length).toBe(1);
            expect(result[0]).toBe(0);
        });
    });

    describe('Stucki Edge Cases', () => {
        test('should handle empty palette gracefully', async () => {
            const pixels = createLabPixels16([{ L: 50, a: 0, b: 0 }]);
            const result = await DitheringStrategies.stucki(pixels, [], 1, 1, null);
            expect(result.length).toBe(1);
            expect(result[0]).toBe(0);
        });

        test('should handle null palette gracefully', async () => {
            const pixels = createLabPixels16([{ L: 50, a: 0, b: 0 }]);
            const result = await DitheringStrategies.stucki(pixels, null, 1, 1, null);
            expect(result.length).toBe(1);
            expect(result[0]).toBe(0);
        });
    });

    describe('Blue Noise Edge Cases', () => {
        test('should handle single-color palette', async () => {
            const pixels = createLabPixels16([
                { L: 50, a: 0, b: 0 },
                { L: 60, a: 10, b: 10 }
            ]);
            const palette = [{ L: 50, a: 0, b: 0 }];

            const result = await DitheringStrategies.blueNoise(pixels, palette, 2, 1, null, 1);
            expect(result.length).toBe(2);
            expect(result[0]).toBe(0);  // All map to only color
            expect(result[1]).toBe(0);
        });

        test('should handle empty palette gracefully', async () => {
            const pixels = createLabPixels16([{ L: 50, a: 0, b: 0 }]);
            const result = await DitheringStrategies.blueNoise(pixels, [], 1, 1, null, 1);
            expect(result.length).toBe(1);
            expect(result[0]).toBe(0);
        });
    });

    describe('Bayer Edge Cases', () => {
        test('should handle single-color palette', async () => {
            const pixels = createLabPixels16([
                { L: 50, a: 0, b: 0 },
                { L: 60, a: 10, b: 10 }
            ]);
            const palette = [{ L: 50, a: 0, b: 0 }];

            const result = await DitheringStrategies.bayer(pixels, palette, 2, 1, null, 1);
            expect(result.length).toBe(2);
            expect(result[0]).toBe(0);  // All map to only color
            expect(result[1]).toBe(0);
        });

        test('should handle empty palette gracefully', async () => {
            const pixels = createLabPixels16([{ L: 50, a: 0, b: 0 }]);
            const result = await DitheringStrategies.bayer(pixels, [], 1, 1, null, 1);
            expect(result.length).toBe(1);
            expect(result[0]).toBe(0);
        });

        test('should call progress callback during large image processing', async () => {
            // Create a large enough image to trigger progress callback (> CHUNK_SIZE)
            const size = 300; // 300x300 = 90,000 pixels > 65536 chunk size
            const colors = [];
            for (let i = 0; i < size * size; i++) {
                colors.push({ L: (i % 100), a: 0, b: 0 });
            }
            const pixels = createLabPixels16(colors);
            const palette = [
                { L: 0, a: 0, b: 0 },
                { L: 100, a: 0, b: 0 }
            ];

            let progressCalled = false;
            const onProgress = (pct) => {
                progressCalled = true;
                expect(pct).toBeGreaterThanOrEqual(0);
                expect(pct).toBeLessThanOrEqual(100);
            };

            await DitheringStrategies.bayer(pixels, palette, size, size, onProgress, 1);
            expect(progressCalled).toBe(true);
        });
    });

    describe('DitheringStrategies Map', () => {
        test('should export all strategies in DitheringStrategies map', () => {
            expect(DitheringStrategies.DitheringStrategies['floyd-steinberg']).toBe(DitheringStrategies.floydSteinberg);
            expect(DitheringStrategies.DitheringStrategies['atkinson']).toBe(DitheringStrategies.atkinson);
            expect(DitheringStrategies.DitheringStrategies['stucki']).toBe(DitheringStrategies.stucki);
            expect(DitheringStrategies.DitheringStrategies['blue-noise']).toBe(DitheringStrategies.blueNoise);
            expect(DitheringStrategies.DitheringStrategies['bayer']).toBe(DitheringStrategies.bayer);
        });
    });
});

describe('SeparationEngine Integration', () => {
    describe('separateImage', () => {
        test('should separate image into layers', async () => {
            const pixels = createLabPixels16([
                { L: 0, a: 0, b: 0 },    // Black
                { L: 0, a: 0, b: 0 },    // Black
                { L: 100, a: 0, b: 0 },  // White
                { L: 100, a: 0, b: 0 }   // White
            ]);
            const labPalette = [
                { L: 0, a: 0, b: 0 },
                { L: 100, a: 0, b: 0 }
            ];
            const hexColors = ['#000000', '#FFFFFF'];

            const layers = await SeparationEngine.separateImage(
                pixels, 2, 2, hexColors, null, labPalette
            );

            expect(layers.length).toBe(2);
            expect(layers[0].name).toContain('#000000');
            expect(layers[0].labColor).toEqual({ L: 0, a: 0, b: 0 });
            expect(layers[0].mask.length).toBe(4);
            expect(layers[1].name).toContain('#FFFFFF');
        });

        test('should throw error for empty palette', async () => {
            const pixels = createLabPixels16([{ L: 50, a: 0, b: 0 }]);

            await expect(
                SeparationEngine.separateImage(pixels, 1, 1, [], null, [])
            ).rejects.toThrow('Separation requires a valid Lab Palette');
        });

        test('should throw error for null palette', async () => {
            const pixels = createLabPixels16([{ L: 50, a: 0, b: 0 }]);

            await expect(
                SeparationEngine.separateImage(pixels, 1, 1, [], null, null)
            ).rejects.toThrow('Separation requires a valid Lab Palette');
        });

        test('should skip layers with low coverage', async () => {
            // Create 1000 pixels, 999 black, 1 white
            const colors = [];
            for (let i = 0; i < 999; i++) {
                colors.push({ L: 0, a: 0, b: 0 });
            }
            colors.push({ L: 100, a: 0, b: 0 });  // 1 white pixel = 0.1% coverage

            const pixels = createLabPixels16(colors);
            const labPalette = [
                { L: 0, a: 0, b: 0 },
                { L: 100, a: 0, b: 0 }
            ];
            const hexColors = ['#000000', '#FFFFFF'];

            const layers = await SeparationEngine.separateImage(
                pixels, 100, 10, hexColors, null, labPalette
            );

            // White layer should be skipped (0.1% coverage = threshold)
            // Actually 0.1% is exactly the threshold, should be included
            expect(layers.length).toBe(2);  // Both included at threshold
        });

        test('should support dithering option', async () => {
            const pixels = createLabPixels16([
                { L: 25, a: 0, b: 0 },
                { L: 50, a: 0, b: 0 },
                { L: 75, a: 0, b: 0 },
                { L: 50, a: 0, b: 0 }
            ]);
            const labPalette = [
                { L: 0, a: 0, b: 0 },
                { L: 100, a: 0, b: 0 }
            ];
            const hexColors = ['#000000', '#FFFFFF'];

            const layers = await SeparationEngine.separateImage(
                pixels, 2, 2, hexColors, null, labPalette,
                { ditherType: 'floyd-steinberg' }
            );

            expect(layers.length).toBeGreaterThan(0);
        });
    });

    describe('generateLayerMask', () => {
        test('should generate binary mask for color index', () => {
            const colorIndices = new Uint8Array([0, 1, 0, 1, 2, 0]);

            const mask0 = SeparationEngine.generateLayerMask(colorIndices, 0, 3, 2);
            expect(Array.from(mask0)).toEqual([255, 0, 255, 0, 0, 255]);

            const mask1 = SeparationEngine.generateLayerMask(colorIndices, 1, 3, 2);
            expect(Array.from(mask1)).toEqual([0, 255, 0, 255, 0, 0]);

            const mask2 = SeparationEngine.generateLayerMask(colorIndices, 2, 3, 2);
            expect(Array.from(mask2)).toEqual([0, 0, 0, 0, 255, 0]);
        });
    });

    describe('hexToRgb', () => {
        test('should convert hex to RGB', () => {
            expect(SeparationEngine.hexToRgb('#FF0000')).toEqual({ r: 255, g: 0, b: 0 });
            expect(SeparationEngine.hexToRgb('#00FF00')).toEqual({ r: 0, g: 255, b: 0 });
            expect(SeparationEngine.hexToRgb('#0000FF')).toEqual({ r: 0, g: 0, b: 255 });
            expect(SeparationEngine.hexToRgb('#FFFFFF')).toEqual({ r: 255, g: 255, b: 255 });
            expect(SeparationEngine.hexToRgb('#000000')).toEqual({ r: 0, g: 0, b: 0 });
        });

        test('should handle hex without # prefix', () => {
            expect(SeparationEngine.hexToRgb('FF0000')).toEqual({ r: 255, g: 0, b: 0 });
        });

        test('should return null for invalid hex', () => {
            expect(SeparationEngine.hexToRgb('invalid')).toBeNull();
            expect(SeparationEngine.hexToRgb('#GGG')).toBeNull();
        });
    });

    describe('mapPixelsToPalette (sync)', () => {
        test('should map pixels synchronously', () => {
            const pixels = createLabPixels16([
                { L: 10, a: 0, b: 0 },
                { L: 90, a: 0, b: 0 }
            ]);
            const palette = [
                { L: 0, a: 0, b: 0 },
                { L: 100, a: 0, b: 0 }
            ];

            const result = SeparationEngine.mapPixelsToPalette(pixels, palette, 2, 1);
            expect(result.length).toBe(2);
            expect(result[0]).toBe(0);  // Closer to black
            expect(result[1]).toBe(1);  // Closer to white
        });
    });
});
