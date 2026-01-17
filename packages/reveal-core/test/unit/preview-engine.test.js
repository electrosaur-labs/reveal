// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Electrosaur Labs

/**
 * PreviewEngine Unit Tests
 *
 * Tests the high-performance preview generator for UXP.
 */

import { describe, test, expect } from 'vitest';

// Import Reveal API
const Reveal = require('../../index.js');
const PreviewEngine = Reveal.engines.PreviewEngine;
const PosterizationEngine = Reveal.engines.PosterizationEngine;

describe('PreviewEngine', () => {
    describe('generatePreview', () => {
        test('generates correct RGBA buffer for simple 2x2 image', () => {
            // Create 2x2 Lab pixel data (black and white)
            const labBytes = new Uint8ClampedArray([
                0, 128, 128,     // Black (L=0, a=0, b=0)
                255, 128, 128,   // White (L=100, a=0, b=0)
                0, 128, 128,     // Black
                255, 128, 128    // White
            ]);

            // Lab palette
            const labPalette = [
                { L: 0, a: 0, b: 0 },     // Black
                { L: 100, a: 0, b: 0 }    // White
            ];

            // RGB palette
            const rgbPalette = [
                { r: 0, g: 0, b: 0 },       // Black
                { r: 255, g: 255, b: 255 }  // White
            ];

            // Generate preview
            const rgba = PreviewEngine.generatePreview(labBytes, labPalette, rgbPalette);

            // Verify buffer size (4 pixels × 4 bytes = 16 bytes)
            expect(rgba.length).toBe(16);

            // Verify pixel colors
            // Pixel 0: Black
            expect(rgba[0]).toBe(0);    // R
            expect(rgba[1]).toBe(0);    // G
            expect(rgba[2]).toBe(0);    // B
            expect(rgba[3]).toBe(255);  // A

            // Pixel 1: White
            expect(rgba[4]).toBe(255);  // R
            expect(rgba[5]).toBe(255);  // G
            expect(rgba[6]).toBe(255);  // B
            expect(rgba[7]).toBe(255);  // A

            // Pixel 2: Black
            expect(rgba[8]).toBe(0);
            expect(rgba[9]).toBe(0);
            expect(rgba[10]).toBe(0);
            expect(rgba[11]).toBe(255);

            // Pixel 3: White
            expect(rgba[12]).toBe(255);
            expect(rgba[13]).toBe(255);
            expect(rgba[14]).toBe(255);
            expect(rgba[15]).toBe(255);
        });

        test('maps pixels to nearest color using squared Euclidean distance', () => {
            // Create test data with near-colors
            const labBytes = new Uint8ClampedArray([
                Math.round((30 / 100) * 255), 128, 128,  // Near-black (L=30, closer to 0)
                Math.round((80 / 100) * 255), 128, 128   // Near-white (L=80, closer to 100)
            ]);

            const labPalette = [
                { L: 0, a: 0, b: 0 },     // Black
                { L: 100, a: 0, b: 0 }    // White
            ];

            const rgbPalette = [
                { r: 0, g: 0, b: 0 },
                { r: 255, g: 255, b: 255 }
            ];

            const rgba = PreviewEngine.generatePreview(labBytes, labPalette, rgbPalette);

            // L=30 should map to black (distance 30 vs 70)
            expect(rgba[0]).toBe(0);   // Black

            // L=80 should map to white (distance 80 vs 20)
            expect(rgba[4]).toBe(255); // White
        });

        test('handles colored palettes correctly', () => {
            // RGB input
            const rgbaInput = new Uint8ClampedArray([
                255, 0, 0, 255,  // Red
                0, 255, 0, 255   // Green
            ]);

            // Convert to Lab bytes
            const labBytes = new Uint8ClampedArray(4 * 3);
            for (let i = 0; i < 2; i++) {
                const rgb = {
                    r: rgbaInput[i * 4],
                    g: rgbaInput[i * 4 + 1],
                    b: rgbaInput[i * 4 + 2]
                };
                const lab = PosterizationEngine.rgbToLab(rgb);
                labBytes[i * 3] = Math.round((lab.L / 100) * 255);
                labBytes[i * 3 + 1] = Math.round(lab.a + 128);
                labBytes[i * 3 + 2] = Math.round(lab.b + 128);
            }

            const labPalette = [
                PosterizationEngine.rgbToLab({ r: 255, g: 0, b: 0 }),
                PosterizationEngine.rgbToLab({ r: 0, g: 255, b: 0 })
            ];

            const rgbPalette = [
                { r: 255, g: 0, b: 0 },
                { r: 0, g: 255, b: 0 }
            ];

            const rgba = PreviewEngine.generatePreview(labBytes, labPalette, rgbPalette);

            // First pixel should be red
            expect(rgba[0]).toBe(255);
            expect(rgba[1]).toBe(0);
            expect(rgba[2]).toBe(0);

            // Second pixel should be green
            expect(rgba[4]).toBe(0);
            expect(rgba[5]).toBe(255);
            expect(rgba[6]).toBe(0);
        });

        test('performance test: handles large images efficiently', () => {
            // Create 100×100 image (10,000 pixels)
            const width = 100;
            const height = 100;
            const pixelCount = width * height;

            const labBytes = new Uint8ClampedArray(pixelCount * 3);
            // Fill with alternating black/white
            for (let i = 0; i < pixelCount; i++) {
                const isWhite = i % 2 === 0;
                labBytes[i * 3] = isWhite ? 255 : 0;
                labBytes[i * 3 + 1] = 128;
                labBytes[i * 3 + 2] = 128;
            }

            const labPalette = [
                { L: 0, a: 0, b: 0 },
                { L: 100, a: 0, b: 0 }
            ];

            const rgbPalette = [
                { r: 0, g: 0, b: 0 },
                { r: 255, g: 255, b: 255 }
            ];

            const startTime = Date.now();
            const rgba = PreviewEngine.generatePreview(labBytes, labPalette, rgbPalette);
            const duration = Date.now() - startTime;

            expect(rgba.length).toBe(pixelCount * 4);
            expect(duration).toBeLessThan(50); // Should complete in < 50ms for 10K pixels
        });
    });
});
