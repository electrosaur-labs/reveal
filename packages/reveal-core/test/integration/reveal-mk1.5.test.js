/**
 * Reveal Mk 1.5 Integration Tests
 * Test complete pipeline: peak detection → slot reservation → median cut → anchor injection
 */

import { describe, it, expect } from 'vitest';
import PosterizationEngine from '../../lib/engines/PosterizationEngine.js';

describe('Reveal Mk 1.5 - Deterministic Auto-Quantizer', () => {
    describe('Basic functionality', () => {
        it('should process image with reveal-mk1.5 engine', () => {
            // Create simple test image in 16-bit Lab format
            // 100 pixels: 90 gray + 10 blue (10% coverage)
            const width = 10;
            const height = 10;
            const pixels = new Uint16Array(width * height * 3);

            const maxValue = 32768;
            const neutralAB = 16384;

            // Fill with gray (L=50, a=0, b=0)
            for (let i = 0; i < 90 * 3; i += 3) {
                pixels[i] = Math.floor((50 / 100) * maxValue);     // L = 50
                pixels[i + 1] = neutralAB;                          // a = 0
                pixels[i + 2] = neutralAB;                          // b = 0
            }

            // Add 10 high-chroma blue pixels at end (L=50, a=10, b=-48)
            for (let i = 90 * 3; i < 100 * 3; i += 3) {
                pixels[i] = Math.floor((50 / 100) * maxValue);
                pixels[i + 1] = neutralAB + Math.floor((10 / 128) * 16384);
                pixels[i + 2] = neutralAB + Math.floor((-48 / 128) * 16384);
            }

            const result = PosterizationEngine.posterize(pixels, width, height, 5, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal-mk1.5',
                preserveWhite: false,
                preserveBlack: false
            });

            // Verify result structure
            expect(result).toHaveProperty('palette');
            expect(result).toHaveProperty('paletteLab');
            expect(result).toHaveProperty('assignments');
            expect(result).toHaveProperty('metadata');

            // Verify metadata
            expect(result.metadata.engineType).toBe('reveal-mk1.5');
            expect(result.metadata).toHaveProperty('autoAnchors');
            expect(result.metadata).toHaveProperty('detectedPeaks');
            expect(result.metadata).toHaveProperty('finalColors');
        });
    });

    describe('Slot reservation', () => {
        it('should reserve slots for auto-detected peaks', () => {
            // Create Jethro Monroe scenario:
            // 320 gray + 20 blue + 660 white = 1000 pixels
            const width = 100;
            const height = 10;
            const pixels = new Uint16Array(width * height * 3);

            const maxValue = 32768;
            const neutralAB = 16384;

            let idx = 0;

            // 320 gray fur pixels (L=30, a=5, b=8) - low chroma
            for (let i = 0; i < 320; i++) {
                pixels[idx++] = Math.floor((30 / 100) * maxValue);
                pixels[idx++] = neutralAB + Math.floor((5 / 128) * 16384);
                pixels[idx++] = neutralAB + Math.floor((8 / 128) * 16384);
            }

            // 20 blue eye pixels (L=45, a=10, b=-48) - high chroma, low volume
            for (let i = 0; i < 20; i++) {
                pixels[idx++] = Math.floor((45 / 100) * maxValue);
                pixels[idx++] = neutralAB + Math.floor((10 / 128) * 16384);
                pixels[idx++] = neutralAB + Math.floor((-48 / 128) * 16384);
            }

            // 660 white background (L=100, a=0, b=0)
            for (let i = 0; i < 660; i++) {
                pixels[idx++] = Math.floor((100 / 100) * maxValue);
                pixels[idx++] = neutralAB;
                pixels[idx++] = neutralAB;
            }

            const result = PosterizationEngine.posterize(pixels, width, height, 8, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal-mk1.5',
                preserveWhite: false,
                preserveBlack: false
            });

            // Verify peak was detected
            expect(result.metadata.detectedPeaks.length).toBeGreaterThan(0);

            // Verify auto-anchors were added (or skipped if duplicate)
            expect(result.metadata).toHaveProperty('autoAnchors');
            expect(result.metadata).toHaveProperty('skippedAnchors');

            // Verify final palette includes peaks
            const totalAnchors = result.metadata.autoAnchors + result.metadata.skippedAnchors;
            expect(totalAnchors).toBe(result.metadata.detectedPeaks.length);
        });
    });

    describe('Duplicate filtering', () => {
        it('should skip peaks that duplicate quantized colors', () => {
            // Create image where peak is very close to a dominant color
            const width = 10;
            const height = 10;
            const pixels = new Uint16Array(width * height * 3);

            const maxValue = 32768;
            const neutralAB = 16384;

            // 95 pixels: blue (L=50, a=10, b=-48)
            for (let i = 0; i < 95 * 3; i += 3) {
                pixels[i] = Math.floor((50 / 100) * maxValue);
                pixels[i + 1] = neutralAB + Math.floor((10 / 128) * 16384);
                pixels[i + 2] = neutralAB + Math.floor((-48 / 128) * 16384);
            }

            // 5 pixels: very similar blue (L=51, a=11, b=-47) - should be filtered as duplicate
            for (let i = 95 * 3; i < 100 * 3; i += 3) {
                pixels[i] = Math.floor((51 / 100) * maxValue);
                pixels[i + 1] = neutralAB + Math.floor((11 / 128) * 16384);
                pixels[i + 2] = neutralAB + Math.floor((-47 / 128) * 16384);
            }

            const result = PosterizationEngine.posterize(pixels, width, height, 3, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal-mk1.5',
                preserveWhite: false,
                preserveBlack: false
            });

            // If a peak was detected, it should be skipped as duplicate
            if (result.metadata.detectedPeaks.length > 0) {
                expect(result.metadata.skippedAnchors).toBeGreaterThan(0);
            }
        });
    });

    describe('No peaks scenario', () => {
        it('should fall back to standard quantization if no peaks detected', () => {
            // Create monochrome image (no high-chroma outliers)
            const width = 10;
            const height = 10;
            const pixels = new Uint16Array(width * height * 3);

            const maxValue = 32768;
            const neutralAB = 16384;

            // All pixels: grayscale (varying L, a=0, b=0)
            for (let i = 0; i < 100; i++) {
                const L = 20 + (i % 5) * 10; // L ranges from 20 to 60
                pixels[i * 3] = Math.floor((L / 100) * maxValue);
                pixels[i * 3 + 1] = neutralAB;
                pixels[i * 3 + 2] = neutralAB;
            }

            const result = PosterizationEngine.posterize(pixels, width, height, 5, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal-mk1.5',
                preserveWhite: false,
                preserveBlack: false
            });

            // Should have no detected peaks
            expect(result.metadata.detectedPeaks.length).toBe(0);
            expect(result.metadata.autoAnchors).toBe(0);

            // Should still produce valid palette
            expect(result.paletteLab.length).toBeGreaterThan(0);
        });
    });

    describe('Preserved colors interaction', () => {
        it('should handle preserved colors + auto-anchors correctly', () => {
            const width = 10;
            const height = 10;
            const pixels = new Uint16Array(width * height * 3);

            const maxValue = 32768;
            const neutralAB = 16384;

            // 80 gray + 10 blue + 10 white
            let idx = 0;

            for (let i = 0; i < 80; i++) {
                pixels[idx++] = Math.floor((50 / 100) * maxValue);
                pixels[idx++] = neutralAB;
                pixels[idx++] = neutralAB;
            }

            for (let i = 0; i < 10; i++) {
                pixels[idx++] = Math.floor((50 / 100) * maxValue);
                pixels[idx++] = neutralAB + Math.floor((10 / 128) * 16384);
                pixels[idx++] = neutralAB + Math.floor((-48 / 128) * 16384);
            }

            for (let i = 0; i < 10; i++) {
                pixels[idx++] = Math.floor((100 / 100) * maxValue);
                pixels[idx++] = neutralAB;
                pixels[idx++] = neutralAB;
            }

            const result = PosterizationEngine.posterize(pixels, width, height, 8, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal-mk1.5',
                preserveWhite: true,
                preserveBlack: false
            });

            // Should produce valid result with preserved white + auto-anchors
            expect(result.metadata.finalColors).toBeGreaterThan(0);
            expect(result.metadata.finalColors).toBeLessThanOrEqual(8);
        });
    });
});
