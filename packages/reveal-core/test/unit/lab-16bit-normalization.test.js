/**
 * Unit Tests for 16-bit Lab Normalization
 *
 * Tests the critical normalization logic that converts Photoshop's 16-bit Lab values
 * (0-32768) to standard 8-bit ranges (0-255) for the posterization engine.
 *
 * This normalization is ESSENTIAL for correct palette generation in 16-bit documents.
 * Without it, palettes are completely wrong (duplicate colors, wrong hues).
 */

import { describe, test, expect } from 'vitest';

/**
 * Mock 16-bit Lab normalization (same logic as PhotoshopAPI.js)
 *
 * In the real code, this happens in PhotoshopAPI.js getDocumentPixels() around line 267-280
 */
function normalize16BitLab(rgbaData16bit) {
    const normalized = new Uint8ClampedArray(rgbaData16bit.length);
    for (let i = 0; i < rgbaData16bit.length; i += 3) {
        // L: 0-32768 → 0-255 (linear scale)
        normalized[i] = Math.round((rgbaData16bit[i] / 32768) * 255);
        // a: 0-32768 (neutral=16384) → 0-255 (neutral=128)
        normalized[i + 1] = Math.round((rgbaData16bit[i + 1] / 32768) * 255);
        // b: 0-32768 (neutral=16384) → 0-255 (neutral=128)
        normalized[i + 2] = Math.round((rgbaData16bit[i + 2] / 32768) * 255);
    }
    return normalized;
}

describe('16-bit Lab Normalization - Unit Tests', () => {
    describe('Lightness (L) Channel Normalization', () => {
        test('should normalize black (L=0) correctly', () => {
            const input = new Uint16Array([0, 16384, 16384]); // Black with neutral a,b
            const result = normalize16BitLab(input);

            expect(result[0]).toBe(0); // L should be 0 (black)
        });

        test('should normalize white (L=32768) correctly', () => {
            const input = new Uint16Array([32768, 16384, 16384]); // White with neutral a,b
            const result = normalize16BitLab(input);

            expect(result[0]).toBe(255); // L should be 255 (white)
        });

        test('should normalize mid-gray (L=16384) correctly', () => {
            const input = new Uint16Array([16384, 16384, 16384]); // Mid-gray with neutral a,b
            const result = normalize16BitLab(input);

            expect(result[0]).toBe(128); // L should be 128 (mid-gray)
        });

        test('should handle L values across full range', () => {
            const testValues = [
                { input: 0, expected: 0 },
                { input: 8192, expected: 64 },
                { input: 16384, expected: 128 },
                { input: 24576, expected: 191 }, // 24576/32768*255 = 191.25 → 191
                { input: 32768, expected: 255 }
            ];

            testValues.forEach(({ input, expected }) => {
                const data = new Uint16Array([input, 16384, 16384]);
                const result = normalize16BitLab(data);
                expect(result[0]).toBe(expected);
            });
        });
    });

    describe('a Channel (Green-Red) Normalization', () => {
        test('should normalize neutral a (16384) to 128', () => {
            const input = new Uint16Array([16384, 16384, 16384]); // Neutral gray
            const result = normalize16BitLab(input);

            expect(result[1]).toBe(128); // a should be 128 (neutral)
        });

        test('should normalize maximum green (a=0) correctly', () => {
            const input = new Uint16Array([16384, 0, 16384]); // Max green
            const result = normalize16BitLab(input);

            expect(result[1]).toBe(0); // a should be 0 (max green)
        });

        test('should normalize maximum red (a=32768) correctly', () => {
            const input = new Uint16Array([16384, 32768, 16384]); // Max red
            const result = normalize16BitLab(input);

            expect(result[1]).toBe(255); // a should be 255 (max red)
        });

        test('should handle a values across full range', () => {
            const testValues = [
                { input: 0, expected: 0 },      // Max green
                { input: 8192, expected: 64 },  // Green-ish
                { input: 16384, expected: 128 }, // Neutral
                { input: 24576, expected: 191 }, // Red-ish (24576/32768*255 = 191.25 → 191)
                { input: 32768, expected: 255 }  // Max red
            ];

            testValues.forEach(({ input, expected }) => {
                const data = new Uint16Array([16384, input, 16384]);
                const result = normalize16BitLab(data);
                expect(result[1]).toBe(expected);
            });
        });
    });

    describe('b Channel (Blue-Yellow) Normalization', () => {
        test('should normalize neutral b (16384) to 128', () => {
            const input = new Uint16Array([16384, 16384, 16384]); // Neutral gray
            const result = normalize16BitLab(input);

            expect(result[2]).toBe(128); // b should be 128 (neutral)
        });

        test('should normalize maximum blue (b=0) correctly', () => {
            const input = new Uint16Array([16384, 16384, 0]); // Max blue
            const result = normalize16BitLab(input);

            expect(result[2]).toBe(0); // b should be 0 (max blue)
        });

        test('should normalize maximum yellow (b=32768) correctly', () => {
            const input = new Uint16Array([16384, 16384, 32768]); // Max yellow
            const result = normalize16BitLab(input);

            expect(result[2]).toBe(255); // b should be 255 (max yellow)
        });

        test('should handle b values across full range', () => {
            const testValues = [
                { input: 0, expected: 0 },      // Max blue
                { input: 8192, expected: 64 },  // Blue-ish
                { input: 16384, expected: 128 }, // Neutral
                { input: 24576, expected: 191 }, // Yellow-ish (24576/32768*255 = 191.25 → 191)
                { input: 32768, expected: 255 }  // Max yellow
            ];

            testValues.forEach(({ input, expected }) => {
                const data = new Uint16Array([16384, 16384, input]);
                const result = normalize16BitLab(data);
                expect(result[2]).toBe(expected);
            });
        });
    });

    describe('Real-World Color Examples', () => {
        test('should normalize pure red correctly', () => {
            // Pure red in 16-bit Lab: L=50%, a=max red, b=neutral
            const input = new Uint16Array([16384, 32768, 16384]);
            const result = normalize16BitLab(input);

            expect(result[0]).toBe(128); // L=128 (mid-brightness)
            expect(result[1]).toBe(255); // a=255 (max red)
            expect(result[2]).toBe(128); // b=128 (neutral)
        });

        test('should normalize pure blue correctly', () => {
            // Pure blue in 16-bit Lab: L=50%, a=neutral, b=max blue
            const input = new Uint16Array([16384, 16384, 0]);
            const result = normalize16BitLab(input);

            expect(result[0]).toBe(128); // L=128 (mid-brightness)
            expect(result[1]).toBe(128); // a=128 (neutral)
            expect(result[2]).toBe(0);   // b=0 (max blue)
        });

        test('should normalize yellow correctly', () => {
            // Yellow in 16-bit Lab: L=bright, a=slight red, b=max yellow
            const input = new Uint16Array([26214, 20480, 32768]);
            const result = normalize16BitLab(input);

            expect(result[0]).toBe(204); // L=204 (bright)
            expect(result[1]).toBe(159); // a=159 (slight red, 20480/32768*255=159.375→159)
            expect(result[2]).toBe(255); // b=255 (max yellow)
        });

        test('should normalize the problematic sparse color (81, -1, 64)', () => {
            // User reported this color at 0.03% of pixels
            // In 8-bit Lab: L=81, a=127 (almost neutral, -1 in signed), b=192 (yellow-ish)
            // In 16-bit this would be: L~10503, a~16320, b~24576
            const input16bit = new Uint16Array([10503, 16320, 24576]);
            const result = normalize16BitLab(input16bit);

            // Should normalize close to (81, 127, 191) in 8-bit
            // Actual: 10503/32768*255=81.73→82, 16320/32768*255=127.12→127, 24576/32768*255=191.25→191
            expect(result[0]).toBeGreaterThanOrEqual(81);  // L=82
            expect(result[0]).toBeLessThanOrEqual(82);
            expect(result[1]).toBe(127);                   // a=127
            expect(result[2]).toBe(191);                   // b=191
        });
    });

    describe('Multi-Pixel Processing', () => {
        test('should normalize multiple pixels correctly', () => {
            // 3 pixels: black, white, mid-gray (all with neutral a,b)
            const input = new Uint16Array([
                0, 16384, 16384,      // Black
                32768, 16384, 16384,  // White
                16384, 16384, 16384   // Mid-gray
            ]);
            const result = normalize16BitLab(input);

            // Black
            expect(result[0]).toBe(0);
            expect(result[1]).toBe(128);
            expect(result[2]).toBe(128);

            // White
            expect(result[3]).toBe(255);
            expect(result[4]).toBe(128);
            expect(result[5]).toBe(128);

            // Mid-gray
            expect(result[6]).toBe(128);
            expect(result[7]).toBe(128);
            expect(result[8]).toBe(128);
        });

        test('should handle large pixel arrays efficiently', () => {
            const pixelCount = 10000;
            const input = new Uint16Array(pixelCount * 3);

            // Fill with alternating colors
            for (let i = 0; i < pixelCount; i++) {
                const offset = i * 3;
                input[offset] = 16384;     // Mid L
                input[offset + 1] = i % 2 === 0 ? 0 : 32768; // Alternate green/red
                input[offset + 2] = 16384; // Neutral b
            }

            const result = normalize16BitLab(input);

            expect(result.length).toBe(input.length);
            expect(result[0]).toBe(128); // First pixel L
            expect(result[1]).toBe(0);   // First pixel a (green)
            expect(result[4]).toBe(255); // Second pixel a (red)
        });
    });

    describe('Edge Cases and Boundary Conditions', () => {
        test('should handle empty array', () => {
            const input = new Uint16Array([]);
            const result = normalize16BitLab(input);

            expect(result.length).toBe(0);
        });

        test('should handle single pixel', () => {
            const input = new Uint16Array([16384, 16384, 16384]);
            const result = normalize16BitLab(input);

            expect(result.length).toBe(3);
            expect(result[0]).toBe(128);
            expect(result[1]).toBe(128);
            expect(result[2]).toBe(128);
        });

        test('should round fractional values correctly', () => {
            // Test values that produce fractional results after division
            const input = new Uint16Array([16383, 16383, 16383]); // One less than half
            const result = normalize16BitLab(input);

            // 16383 / 32768 * 255 = 127.492... should round to 127
            expect(result[0]).toBe(127);
            expect(result[1]).toBe(127);
            expect(result[2]).toBe(127);
        });

        test('should round values at midpoint correctly', () => {
            // Test value at exactly 0.5 boundary
            const input = new Uint16Array([16384, 16384, 16384]); // Exactly half
            const result = normalize16BitLab(input);

            // 16384 / 32768 * 255 = 128.0 (exact)
            expect(result[0]).toBe(128);
            expect(result[1]).toBe(128);
            expect(result[2]).toBe(128);
        });

        test('should handle maximum values without overflow', () => {
            const input = new Uint16Array([32768, 32768, 32768]);
            const result = normalize16BitLab(input);

            expect(result[0]).toBe(255);
            expect(result[1]).toBe(255);
            expect(result[2]).toBe(255);
            expect(result[0]).toBeLessThanOrEqual(255);
        });
    });

    describe('Regression Tests', () => {
        test('should NOT create duplicate colors bug (3 yellows, 3 whites)', () => {
            // This bug occurred when normalization was missing after merge
            // Without normalization, values like 16384 (neutral) were interpreted as 16384 in 8-bit
            // This caused completely wrong color calculations

            // Create a gradient of yellows that should be distinct
            const input = new Uint16Array([
                26214, 20480, 32768,  // Bright yellow
                22937, 18724, 29491,  // Medium yellow
                19660, 16384, 26214   // Pale yellow
            ]);

            const result = normalize16BitLab(input);

            // After normalization, these should map to distinct 8-bit values
            // NOT to duplicate/similar values that median cut can't distinguish
            const yellow1 = [result[0], result[1], result[2]];
            const yellow2 = [result[3], result[4], result[5]];
            const yellow3 = [result[6], result[7], result[8]];

            // Colors should be different (not exact duplicates)
            expect(yellow1).not.toEqual(yellow2);
            expect(yellow2).not.toEqual(yellow3);
            expect(yellow1).not.toEqual(yellow3);
        });
    });
});
