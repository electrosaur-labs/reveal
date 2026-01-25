/**
 * BilateralFilter Unit Tests
 *
 * Tests for the preprocessing module including:
 * - Entropy calculation
 * - Bilateral filter application
 * - Preprocessing decision logic
 */
import { describe, test, expect } from 'vitest';

const BilateralFilter = require('../../lib/preprocessing/BilateralFilter');

describe('BilateralFilter', () => {
    describe('calculateEntropyScore', () => {
        test('should return low entropy for uniform image', () => {
            // Create a 10x10 uniform gray image (RGBA)
            const width = 10;
            const height = 10;
            const imageData = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < imageData.length; i += 4) {
                imageData[i] = 128;     // R
                imageData[i + 1] = 128; // G
                imageData[i + 2] = 128; // B
                imageData[i + 3] = 255; // A
            }

            const entropy = BilateralFilter.calculateEntropyScore(imageData, width, height, 1);
            expect(entropy).toBeLessThan(5); // Very low for uniform image
        });

        test('should return high entropy for noisy image', () => {
            // Create a 10x10 noisy image (random values)
            const width = 10;
            const height = 10;
            const imageData = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < imageData.length; i += 4) {
                imageData[i] = Math.floor(Math.random() * 256);     // R
                imageData[i + 1] = Math.floor(Math.random() * 256); // G
                imageData[i + 2] = Math.floor(Math.random() * 256); // B
                imageData[i + 3] = 255; // A
            }

            const entropy = BilateralFilter.calculateEntropyScore(imageData, width, height, 1);
            expect(entropy).toBeGreaterThan(30); // High for noisy image
        });

        test('should return moderate entropy for gradient image', () => {
            // Create a 20x20 gradient image
            const width = 20;
            const height = 20;
            const imageData = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 4;
                    const val = Math.floor((x / width) * 255);
                    imageData[idx] = val;
                    imageData[idx + 1] = val;
                    imageData[idx + 2] = val;
                    imageData[idx + 3] = 255;
                }
            }

            const entropy = BilateralFilter.calculateEntropyScore(imageData, width, height, 1);
            expect(entropy).toBeGreaterThan(5);
            expect(entropy).toBeLessThan(50);
        });
    });

    describe('applyBilateralFilter', () => {
        test('should not change uniform image', () => {
            const width = 5;
            const height = 5;
            const imageData = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < imageData.length; i += 4) {
                imageData[i] = 100;
                imageData[i + 1] = 100;
                imageData[i + 2] = 100;
                imageData[i + 3] = 255;
            }

            const original = new Uint8ClampedArray(imageData);
            BilateralFilter.applyBilateralFilter(imageData, width, height, 2, 30);

            // Should remain approximately the same
            for (let i = 0; i < imageData.length; i += 4) {
                expect(Math.abs(imageData[i] - original[i])).toBeLessThan(5);
            }
        });

        test('should smooth noisy areas while preserving edges', () => {
            // Create image with edge and noise
            const width = 10;
            const height = 10;
            const imageData = new Uint8ClampedArray(width * height * 4);

            // Left half: dark with noise
            // Right half: light with noise
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 4;
                    const base = x < 5 ? 50 : 200;
                    const noise = Math.floor(Math.random() * 20 - 10);
                    imageData[idx] = Math.max(0, Math.min(255, base + noise));
                    imageData[idx + 1] = Math.max(0, Math.min(255, base + noise));
                    imageData[idx + 2] = Math.max(0, Math.min(255, base + noise));
                    imageData[idx + 3] = 255;
                }
            }

            BilateralFilter.applyBilateralFilter(imageData, width, height, 2, 30);

            // Check that edge is preserved (left side should still be dark, right side light)
            const leftPixel = imageData[4 * 4]; // x=1
            const rightPixel = imageData[(5 * width + 8) * 4]; // x=8
            expect(rightPixel - leftPixel).toBeGreaterThan(100); // Edge preserved
        });
    });

    describe('shouldPreprocess', () => {
        test('should never filter Vector/Flat archetype', () => {
            const dna = { archetype: 'Vector/Flat', maxC: 50 };
            const result = BilateralFilter.shouldPreprocess(dna, 50);

            expect(result.shouldProcess).toBe(false);
            expect(result.reason).toContain('Vector/Flat');
        });

        test('should skip low entropy images', () => {
            const dna = { archetype: 'Photographic', maxC: 50 };
            const result = BilateralFilter.shouldPreprocess(dna, 10);

            expect(result.shouldProcess).toBe(false);
            expect(result.reason).toContain('entropy');
        });

        test('should filter Photographic with high entropy', () => {
            const dna = { archetype: 'Photographic', maxC: 50 };
            const result = BilateralFilter.shouldPreprocess(dna, 35);

            expect(result.shouldProcess).toBe(true);
            expect(result.reason).toContain('Photographic');
            expect(result.radius).toBeDefined();
            expect(result.sigmaR).toBeDefined();
        });

        test('should filter Noir/Mono with high entropy', () => {
            const dna = { archetype: 'Noir/Mono', maxC: 10 };
            const result = BilateralFilter.shouldPreprocess(dna, 30);

            expect(result.shouldProcess).toBe(true);
            expect(result.reason).toContain('Noir/Mono');
        });

        test('should require higher threshold for Neon/Vibrant', () => {
            const dna = { archetype: 'Neon/Vibrant', maxC: 80 };

            // entropy 28 should not trigger
            const result1 = BilateralFilter.shouldPreprocess(dna, 28);
            expect(result1.shouldProcess).toBe(false);

            // entropy 35 should trigger
            const result2 = BilateralFilter.shouldPreprocess(dna, 35);
            expect(result2.shouldProcess).toBe(true);
        });
    });

    describe('getFilterParams', () => {
        test('should return light params for moderate entropy', () => {
            const params = BilateralFilter.getFilterParams(30);
            expect(params.radius).toBe(3);
            expect(params.sigmaR).toBe(30);
        });

        test('should return heavy params for high entropy', () => {
            const params = BilateralFilter.getFilterParams(50);
            expect(params.radius).toBe(5);
            expect(params.sigmaR).toBe(45);
        });
    });

    describe('createPreprocessingConfig', () => {
        test('should return disabled config when intensity is off', () => {
            const dna = { archetype: 'Photographic', maxC: 50 };
            const config = BilateralFilter.createPreprocessingConfig(dna, null, 0, 0, 'off');

            expect(config.enabled).toBe(false);
            expect(config.intensity).toBe('off');
        });

        test('should return light config when intensity is light', () => {
            const dna = { archetype: 'Vector/Flat', maxC: 20 }; // Would normally be skipped
            const config = BilateralFilter.createPreprocessingConfig(dna, null, 0, 0, 'light');

            expect(config.enabled).toBe(true);
            expect(config.intensity).toBe('light');
            expect(config.radius).toBe(3);
            expect(config.sigmaR).toBe(30);
        });

        test('should return heavy config when intensity is heavy', () => {
            const dna = { archetype: 'Vector/Flat', maxC: 20 };
            const config = BilateralFilter.createPreprocessingConfig(dna, null, 0, 0, 'heavy');

            expect(config.enabled).toBe(true);
            expect(config.intensity).toBe('heavy');
            expect(config.radius).toBe(5);
            expect(config.sigmaR).toBe(45);
        });

        test('should auto-detect preprocessing need from image data', () => {
            const dna = { archetype: 'Photographic', maxC: 50 };

            // Create noisy image
            const width = 20;
            const height = 20;
            const imageData = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < imageData.length; i += 4) {
                imageData[i] = Math.floor(Math.random() * 256);
                imageData[i + 1] = Math.floor(Math.random() * 256);
                imageData[i + 2] = Math.floor(Math.random() * 256);
                imageData[i + 3] = 255;
            }

            const config = BilateralFilter.createPreprocessingConfig(dna, imageData, width, height, 'auto');

            expect(config.entropyScore).toBeGreaterThan(0);
            expect(config.enabled).toBe(true); // Noisy image should be preprocessed
        });
    });

    describe('RevealPreProcessor class', () => {
        test('should process image when preprocessing is enabled', () => {
            const preprocessor = new BilateralFilter.RevealPreProcessor({ intensity: 'light' });
            const dna = { archetype: 'Photographic', maxC: 50 };

            const width = 10;
            const height = 10;
            const imageData = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < imageData.length; i += 4) {
                imageData[i] = 128;
                imageData[i + 1] = 128;
                imageData[i + 2] = 128;
                imageData[i + 3] = 255;
            }

            const result = preprocessor.process(imageData, width, height, dna);

            expect(result.processed).toBe(true);
            expect(result.config.intensity).toBe('light');
        });

        test('should skip processing when intensity is off', () => {
            const preprocessor = new BilateralFilter.RevealPreProcessor({ intensity: 'off' });
            const dna = { archetype: 'Photographic', maxC: 50 };

            const width = 10;
            const height = 10;
            const imageData = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < imageData.length; i += 4) {
                imageData[i] = 128;
                imageData[i + 1] = 128;
                imageData[i + 2] = 128;
                imageData[i + 3] = 255;
            }

            const result = preprocessor.process(imageData, width, height, dna);

            expect(result.processed).toBe(false);
        });
    });

    describe('PreprocessingIntensity constants', () => {
        test('should have correct values', () => {
            expect(BilateralFilter.PreprocessingIntensity.OFF).toBe('off');
            expect(BilateralFilter.PreprocessingIntensity.AUTO).toBe('auto');
            expect(BilateralFilter.PreprocessingIntensity.LIGHT).toBe('light');
            expect(BilateralFilter.PreprocessingIntensity.HEAVY).toBe('heavy');
        });
    });

    // ========== 16-BIT LAB TESTS ==========

    describe('calculateEntropyScoreLab (16-bit)', () => {
        test('should return low entropy for uniform 16-bit Lab image', () => {
            // Create a 10x10 uniform gray image in 16-bit Lab
            // L=16384 (50%), a=16384 (neutral), b=16384 (neutral)
            const width = 10;
            const height = 10;
            const labData = new Uint16Array(width * height * 3);
            for (let i = 0; i < labData.length; i += 3) {
                labData[i] = 16384;     // L (50% of 32768)
                labData[i + 1] = 16384; // a (neutral)
                labData[i + 2] = 16384; // b (neutral)
            }

            const entropy = BilateralFilter.calculateEntropyScoreLab(labData, width, height, 1);
            expect(entropy).toBeLessThan(5); // Very low for uniform image
        });

        test('should return high entropy for noisy 16-bit Lab image', () => {
            // Create a 10x10 noisy image in 16-bit Lab
            const width = 10;
            const height = 10;
            const labData = new Uint16Array(width * height * 3);
            for (let i = 0; i < labData.length; i += 3) {
                // Random L values across full range
                labData[i] = Math.floor(Math.random() * 32768);
                labData[i + 1] = 16384; // neutral a
                labData[i + 2] = 16384; // neutral b
            }

            const entropy = BilateralFilter.calculateEntropyScoreLab(labData, width, height, 1);
            expect(entropy).toBeGreaterThan(30); // High for noisy image
        });

        test('should return moderate entropy for gradient 16-bit Lab image', () => {
            // Create a 20x20 gradient image in 16-bit Lab
            const width = 20;
            const height = 20;
            const labData = new Uint16Array(width * height * 3);
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 3;
                    const L = Math.floor((x / width) * 32768); // 0 to 32768 gradient
                    labData[idx] = L;
                    labData[idx + 1] = 16384; // neutral a
                    labData[idx + 2] = 16384; // neutral b
                }
            }

            const entropy = BilateralFilter.calculateEntropyScoreLab(labData, width, height, 1);
            expect(entropy).toBeGreaterThan(5);
            expect(entropy).toBeLessThan(50);
        });

        test('should produce similar scores to 8-bit version for equivalent images', () => {
            // Create uniform image in both formats
            const width = 10;
            const height = 10;

            // 8-bit RGBA uniform gray
            const rgba = new Uint8ClampedArray(width * height * 4);
            for (let i = 0; i < rgba.length; i += 4) {
                rgba[i] = 128;
                rgba[i + 1] = 128;
                rgba[i + 2] = 128;
                rgba[i + 3] = 255;
            }

            // 16-bit Lab equivalent (L=16384 ≈ 50%)
            const lab16 = new Uint16Array(width * height * 3);
            for (let i = 0; i < lab16.length; i += 3) {
                lab16[i] = 16384;
                lab16[i + 1] = 16384;
                lab16[i + 2] = 16384;
            }

            const entropy8 = BilateralFilter.calculateEntropyScore(rgba, width, height, 1);
            const entropy16 = BilateralFilter.calculateEntropyScoreLab(lab16, width, height, 1);

            // Both should be very low for uniform images
            expect(entropy8).toBeLessThan(5);
            expect(entropy16).toBeLessThan(5);
        });
    });

    describe('applyBilateralFilterLab (16-bit)', () => {
        test('should not change uniform 16-bit Lab image', () => {
            const width = 5;
            const height = 5;
            const labData = new Uint16Array(width * height * 3);
            for (let i = 0; i < labData.length; i += 3) {
                labData[i] = 16384;     // L
                labData[i + 1] = 16384; // a
                labData[i + 2] = 16384; // b
            }

            const original = new Uint16Array(labData);
            BilateralFilter.applyBilateralFilterLab(labData, width, height, 2, 30);

            // Should remain approximately the same
            for (let i = 0; i < labData.length; i += 3) {
                expect(Math.abs(labData[i] - original[i])).toBeLessThan(100); // Small tolerance for 16-bit
            }
        });

        test('should smooth noisy areas in 16-bit Lab image', () => {
            // Create image with uniform area + noise
            const width = 10;
            const height = 10;
            const labData = new Uint16Array(width * height * 3);

            const baseL = 16384; // Mid-gray
            for (let i = 0; i < labData.length; i += 3) {
                // Add noise to L channel (±2000 in 16-bit scale)
                const noise = Math.floor(Math.random() * 4000 - 2000);
                labData[i] = Math.max(0, Math.min(32768, baseL + noise));
                labData[i + 1] = 16384; // neutral a
                labData[i + 2] = 16384; // neutral b
            }

            // Calculate variance before filtering
            let varianceBefore = 0;
            for (let i = 0; i < labData.length; i += 3) {
                varianceBefore += Math.pow(labData[i] - baseL, 2);
            }
            varianceBefore /= (width * height);

            BilateralFilter.applyBilateralFilterLab(labData, width, height, 2, 30);

            // Calculate variance after filtering
            let varianceAfter = 0;
            for (let i = 0; i < labData.length; i += 3) {
                varianceAfter += Math.pow(labData[i] - baseL, 2);
            }
            varianceAfter /= (width * height);

            // Variance should be reduced (smoothing)
            expect(varianceAfter).toBeLessThan(varianceBefore);
        });

        test('should preserve edges while smoothing noise', () => {
            // Create image with edge and noise
            const width = 10;
            const height = 10;
            const labData = new Uint16Array(width * height * 3);

            // Left half: dark (L=8000) with noise
            // Right half: light (L=24000) with noise
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 3;
                    const baseL = x < 5 ? 8000 : 24000;
                    const noise = Math.floor(Math.random() * 1000 - 500);
                    labData[idx] = Math.max(0, Math.min(32768, baseL + noise));
                    labData[idx + 1] = 16384; // neutral a
                    labData[idx + 2] = 16384; // neutral b
                }
            }

            BilateralFilter.applyBilateralFilterLab(labData, width, height, 2, 30);

            // Check that edge is preserved (left side should still be dark, right side light)
            const leftPixelL = labData[(2 * width + 2) * 3]; // x=2
            const rightPixelL = labData[(5 * width + 7) * 3]; // x=7

            // Right side should still be significantly lighter than left
            expect(rightPixelL - leftPixelL).toBeGreaterThan(10000);
        });

        test('should modify data in place', () => {
            const width = 5;
            const height = 5;
            const labData = new Uint16Array(width * height * 3);

            // Add some noise
            for (let i = 0; i < labData.length; i += 3) {
                labData[i] = Math.floor(Math.random() * 32768);
                labData[i + 1] = 16384;
                labData[i + 2] = 16384;
            }

            const originalRef = labData; // Same reference
            BilateralFilter.applyBilateralFilterLab(labData, width, height, 2, 30);

            // Should be the same array (modified in place)
            expect(labData).toBe(originalRef);
        });
    });
});
