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
});
