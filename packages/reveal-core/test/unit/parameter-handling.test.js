/**
 * Unit tests for Parameter Handling
 *
 * Tests that setting target colors to 0 triggers auto-detection correctly.
 */

import { describe, test, expect } from 'vitest';

// Import Reveal API
const Reveal = require('../../index.js');
const PosterizationEngine = Reveal.engines.PosterizationEngine;

describe('Parameter Handling: Target Colors = 0', () => {
    describe('Auto-detection trigger', () => {
        test('targetColors = 0 should use auto-detection', () => {
            // Simulate parameter entry with targetColors = 0
            const params = { targetColors: 0 };

            // Create test image
            const pixels = new Uint8ClampedArray([
                255, 0, 0, 255,      // Red
                0, 255, 0, 255,      // Green
                0, 0, 255, 255,      // Blue
                255, 255, 0, 255     // Yellow
            ]);

            // Simulate workflow logic
            let colorCount;
            if (params.targetColors > 0) {
                colorCount = params.targetColors;
            } else {
                // Auto-detect
                colorCount = PosterizationEngine.analyzeOptimalColorCount(pixels, 2, 2);
            }

            // Should have auto-detected (not used 0)
            expect(colorCount).toBeGreaterThan(0);
            expect(colorCount).toBeGreaterThanOrEqual(3); // Minimum
            expect(colorCount).toBeLessThanOrEqual(10);   // Maximum
        });

        test('targetColors = -1 should use auto-detection', () => {
            // Edge case: negative value should also trigger auto-detection
            const params = { targetColors: -1 };

            const pixels = new Uint8ClampedArray([
                255, 0, 0, 255,
                0, 255, 0, 255
            ]);

            let colorCount;
            if (params.targetColors > 0) {
                colorCount = params.targetColors;
            } else {
                colorCount = PosterizationEngine.analyzeOptimalColorCount(pixels, 1, 2);
            }

            expect(colorCount).toBeGreaterThan(0);
            expect(colorCount).toBeGreaterThanOrEqual(3);
        });

        test('targetColors = undefined should use auto-detection', () => {
            // Edge case: undefined parameter
            const params = {};

            const pixels = new Uint8ClampedArray([
                255, 0, 0, 255,
                0, 255, 0, 255
            ]);

            let colorCount;
            if (params.targetColors > 0) {
                colorCount = params.targetColors;
            } else {
                colorCount = PosterizationEngine.analyzeOptimalColorCount(pixels, 1, 2);
            }

            expect(colorCount).toBeGreaterThan(0);
        });

        test('targetColors = null should use auto-detection', () => {
            // Edge case: null parameter
            const params = { targetColors: null };

            const pixels = new Uint8ClampedArray([
                255, 0, 0, 255,
                0, 255, 0, 255
            ]);

            let colorCount;
            if (params.targetColors > 0) {
                colorCount = params.targetColors;
            } else {
                colorCount = PosterizationEngine.analyzeOptimalColorCount(pixels, 1, 2);
            }

            expect(colorCount).toBeGreaterThan(0);
        });

        test('targetColors = 5 should use manual count', () => {
            // Verify manual override works
            const params = { targetColors: 5 };

            const pixels = new Uint8ClampedArray([
                255, 0, 0, 255,
                0, 255, 0, 255
            ]);

            let colorCount;
            if (params.targetColors > 0) {
                colorCount = params.targetColors;
            } else {
                colorCount = PosterizationEngine.analyzeOptimalColorCount(pixels, 1, 2);
            }

            // Should use the manual value, not auto-detect
            expect(colorCount).toBe(5);
        });
    });

    describe('Auto-detection with different image complexities', () => {
        test('simple 2-color image with targetColors=0 should auto-detect correctly', () => {
            const pixels = new Uint8ClampedArray([
                255, 255, 255, 255,  // White
                255, 255, 255, 255,  // White
                0, 0, 0, 255,        // Black
                0, 0, 0, 255         // Black
            ]);

            const params = { targetColors: 0 };

            let colorCount;
            if (params.targetColors > 0) {
                colorCount = params.targetColors;
            } else {
                colorCount = PosterizationEngine.analyzeOptimalColorCount(pixels, 2, 2);
            }

            // Should recommend minimum 3 colors for simple image
            expect(colorCount).toBe(3);
        });

        test('complex gradient with targetColors=0 should recommend higher count', () => {
            // Create gradient image
            const pixels = new Uint8ClampedArray(20 * 20 * 4);
            for (let i = 0; i < 400; i++) {
                const offset = i * 4;
                const value = Math.floor((i / 400) * 255);
                pixels[offset] = value;     // R gradient
                pixels[offset + 1] = value; // G gradient
                pixels[offset + 2] = value; // B gradient
                pixels[offset + 3] = 255;   // Opaque
            }

            const params = { targetColors: 0 };

            let colorCount;
            if (params.targetColors > 0) {
                colorCount = params.targetColors;
            } else {
                colorCount = PosterizationEngine.analyzeOptimalColorCount(pixels, 20, 20);
            }

            // Complex gradient should recommend more colors
            expect(colorCount).toBeGreaterThan(3);
            expect(colorCount).toBeLessThanOrEqual(10); // Still capped at max
        });

        test('high-complexity image with targetColors=0 should cap at 10', () => {
            // Create highly complex image
            const pixels = new Uint8ClampedArray(50 * 50 * 4);
            for (let i = 0; i < 2500; i++) {
                const offset = i * 4;
                pixels[offset] = (i * 17) % 256;
                pixels[offset + 1] = (i * 31) % 256;
                pixels[offset + 2] = (i * 47) % 256;
                pixels[offset + 3] = 255;
            }

            const params = { targetColors: 0 };

            let colorCount;
            if (params.targetColors > 0) {
                colorCount = params.targetColors;
            } else {
                colorCount = PosterizationEngine.analyzeOptimalColorCount(pixels, 50, 50);
            }

            // Should cap at screen printing maximum
            expect(colorCount).toBe(10);
        });
    });

    describe('Workflow validation with targetColors=0', () => {
        test('auto-detected count should be valid for posterization', () => {
            const pixels = new Uint8ClampedArray([
                255, 0, 0, 255,      // Red
                0, 255, 0, 255,      // Green
                0, 0, 255, 255,      // Blue
                255, 255, 0, 255     // Yellow
            ]);

            const params = { targetColors: 0 };

            // Step 1: Auto-detect
            let colorCount;
            if (params.targetColors > 0) {
                colorCount = params.targetColors;
            } else {
                colorCount = PosterizationEngine.analyzeOptimalColorCount(pixels, 2, 2);
            }

            // Step 2: Verify count is valid for posterization
            expect(colorCount).toBeGreaterThanOrEqual(3);  // MIN_COLORS
            expect(colorCount).toBeLessThanOrEqual(10);    // MAX_COLORS

            // Step 3: Verify posterization works with auto-detected count
            expect(() => {
                PosterizationEngine.posterize(pixels, 2, 2, colorCount, 'cielab');
            }).not.toThrow();
        });

        test('posterization with auto-detected count should produce valid results', () => {
            const pixels = new Uint8ClampedArray([
                255, 0, 0, 255,      // Red
                0, 255, 0, 255,      // Green
                0, 0, 255, 255,      // Blue
                255, 255, 0, 255,    // Yellow
                255, 0, 255, 255,    // Magenta
                0, 255, 255, 255     // Cyan
            ]);

            const params = { targetColors: 0 };

            // Auto-detect
            const colorCount = params.targetColors > 0
                ? params.targetColors
                : PosterizationEngine.analyzeOptimalColorCount(pixels, 2, 3);

            // Posterize with auto-detected count
            const result = PosterizationEngine.posterize(pixels, 2, 3, colorCount, 'cielab');

            // Verify result structure
            expect(result).toHaveProperty('palette');
            expect(result.palette.length).toBeGreaterThan(0);
            expect(result.palette.length).toBeLessThanOrEqual(colorCount);

            // Result may have either 'pixels' (optimized path) or 'assignments' (quantization path)
            const hasPixels = result.hasOwnProperty('pixels');
            const hasAssignments = result.hasOwnProperty('assignments');
            expect(hasPixels || hasAssignments).toBe(true);

            if (hasAssignments) {
                expect(result.assignments.length).toBe(6); // 2x3 pixels
            }
        });
    });

    describe('Edge cases with targetColors=0', () => {
        test('empty image (all transparent) with targetColors=0 should handle gracefully', () => {
            const pixels = new Uint8ClampedArray([
                0, 0, 0, 0,  // Transparent
                0, 0, 0, 0,  // Transparent
                0, 0, 0, 0,  // Transparent
                0, 0, 0, 0   // Transparent
            ]);

            const params = { targetColors: 0 };

            // Should not throw, even with no opaque pixels
            expect(() => {
                const colorCount = params.targetColors > 0
                    ? params.targetColors
                    : PosterizationEngine.analyzeOptimalColorCount(pixels, 2, 2);

                expect(colorCount).toBe(3); // Returns minimum for empty images
            }).not.toThrow();
        });

        test('single-pixel image with targetColors=0 should auto-detect', () => {
            const pixels = new Uint8ClampedArray([
                128, 64, 200, 255  // Single pixel
            ]);

            const params = { targetColors: 0 };

            const colorCount = params.targetColors > 0
                ? params.targetColors
                : PosterizationEngine.analyzeOptimalColorCount(pixels, 1, 1);

            expect(colorCount).toBe(3); // Minimum for single color
        });

        test('large image with targetColors=0 should complete in reasonable time', () => {
            // Create 200x200 image
            const pixels = new Uint8ClampedArray(200 * 200 * 4);
            for (let i = 0; i < 40000; i++) {
                const offset = i * 4;
                pixels[offset] = (i % 200);
                pixels[offset + 1] = Math.floor(i / 200);
                pixels[offset + 2] = ((i * 7) % 256);
                pixels[offset + 3] = 255;
            }

            const params = { targetColors: 0 };

            const startTime = Date.now();
            const colorCount = params.targetColors > 0
                ? params.targetColors
                : PosterizationEngine.analyzeOptimalColorCount(pixels, 200, 200);
            const duration = Date.now() - startTime;

            // Should complete within 5 seconds (allows for CI/CD variability)
            expect(duration).toBeLessThan(5000);
            expect(colorCount).toBeGreaterThanOrEqual(3);
            expect(colorCount).toBeLessThanOrEqual(10);
        });
    });

    describe('Comparison: manual vs auto-detection', () => {
        test('manual count should override auto-detection', () => {
            const pixels = new Uint8ClampedArray([
                255, 0, 0, 255,      // Red
                0, 255, 0, 255,      // Green
                0, 0, 255, 255       // Blue
            ]);

            // Auto-detect
            const autoCount = PosterizationEngine.analyzeOptimalColorCount(pixels, 1, 3);

            // Manual override
            const manualParams = { targetColors: 7 };
            const manualCount = manualParams.targetColors > 0
                ? manualParams.targetColors
                : PosterizationEngine.analyzeOptimalColorCount(pixels, 1, 3);

            // Should be different
            expect(manualCount).toBe(7);
            expect(manualCount).not.toBe(autoCount);
        });

        test('targetColors=0 should produce same result as analyzeOptimalColorCount', () => {
            const pixels = new Uint8ClampedArray([
                255, 0, 0, 255,
                0, 255, 0, 255,
                0, 0, 255, 255,
                255, 255, 0, 255
            ]);

            // Direct call to auto-detect
            const directCount = PosterizationEngine.analyzeOptimalColorCount(pixels, 2, 2);

            // Via params workflow
            const params = { targetColors: 0 };
            const workflowCount = params.targetColors > 0
                ? params.targetColors
                : PosterizationEngine.analyzeOptimalColorCount(pixels, 2, 2);

            // Should be identical
            expect(workflowCount).toBe(directCount);
        });
    });
});
