/**
 * PixelAssignment - Unit Tests
 *
 * Tests for stride-based pixel-to-palette reassignment with multiple
 * distance metrics and weight configurations.
 */

import { describe, it, expect } from 'vitest';

const PixelAssignment = require('../../lib/engines/PixelAssignment');

// --- Helpers ---

/** Build a Uint16Array of 16-bit Lab pixels from perceptual values */
const createLab16Pixels = (values) => {
    const buf = new Uint16Array(values.length * 3);
    for (let i = 0; i < values.length; i++) {
        const { L, a, b } = values[i];
        // Perceptual → engine 16-bit: L:0-100→0-32768, a/b:-128..+127→0..32768
        buf[i * 3]     = Math.round((L / 100) * 32768);
        buf[i * 3 + 1] = Math.round((a + 128) * 128);
        buf[i * 3 + 2] = Math.round((b + 128) * 128);
    }
    return buf;
};

const BW_PALETTE = [
    { L: 0, a: 0, b: 0 },   // black
    { L: 100, a: 0, b: 0 }  // white
];

const RGB_PALETTE = [
    { L: 53,  a: 80,  b: 67 },   // red-ish
    { L: 88,  a: -86, b: 83 },   // green-ish
    { L: 32,  a: 79,  b: -108 }  // blue-ish
];

describe('PixelAssignment.reassignWithStride', () => {

    describe('basic assignment', () => {
        it('assigns each pixel to nearest palette color (stride=1)', () => {
            const px = createLab16Pixels([
                { L: 10, a: 0, b: 0 },  // → black
                { L: 90, a: 0, b: 0 }   // → white
            ]);
            const result = PixelAssignment.reassignWithStride(px, BW_PALETTE, 2, 1, 1);
            expect(result).toBeInstanceOf(Uint16Array);
            expect(result[0]).toBe(0); // black
            expect(result[1]).toBe(1); // white
        });

        it('returns array of correct length', () => {
            const px = createLab16Pixels(
                Array(25).fill({ L: 50, a: 0, b: 0 })
            );
            const result = PixelAssignment.reassignWithStride(px, BW_PALETTE, 5, 5, 1);
            expect(result.length).toBe(25);
        });
    });

    describe('stride behavior', () => {
        it('stride=2 stamps 2x2 blocks with same index', () => {
            // 4x4 image, top-left quadrant is black, bottom-right is white
            const pixels = [];
            for (let y = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++) {
                    pixels.push({ L: (y < 2 && x < 2) ? 10 : 90, a: 0, b: 0 });
                }
            }
            const px = createLab16Pixels(pixels);
            const result = PixelAssignment.reassignWithStride(px, BW_PALETTE, 4, 4, 2);

            // Top-left 2x2 should all be black (0)
            expect(result[0]).toBe(0);
            expect(result[1]).toBe(0);
            expect(result[4]).toBe(0);
            expect(result[5]).toBe(0);

            // Bottom-right 2x2 should all be white (1)
            expect(result[10]).toBe(1);
            expect(result[11]).toBe(1);
            expect(result[14]).toBe(1);
            expect(result[15]).toBe(1);
        });

        it('stride=4 processes fewer anchor pixels', () => {
            // 8x8 uniform image
            const px = createLab16Pixels(
                Array(64).fill({ L: 10, a: 0, b: 0 })
            );
            const result = PixelAssignment.reassignWithStride(px, BW_PALETTE, 8, 8, 4);
            // All should map to black
            for (let i = 0; i < 64; i++) {
                expect(result[i]).toBe(0);
            }
        });

        it('handles non-power-of-2 dimensions with stride', () => {
            // 5x5 with stride=2 — last row/col shouldn't overflow
            const px = createLab16Pixels(
                Array(25).fill({ L: 90, a: 0, b: 0 })
            );
            const result = PixelAssignment.reassignWithStride(px, BW_PALETTE, 5, 5, 2);
            expect(result.length).toBe(25);
            // All white
            for (let i = 0; i < 25; i++) {
                expect(result[i]).toBe(1);
            }
        });
    });

    describe('distance metrics', () => {
        it('default (squared) maps correctly', () => {
            const px = createLab16Pixels([
                { L: 50, a: 78, b: 65 }, // close to red
                { L: 85, a: -80, b: 80 } // close to green
            ]);
            const result = PixelAssignment.reassignWithStride(px, RGB_PALETTE, 2, 1, 1);
            expect(result[0]).toBe(0); // red
            expect(result[1]).toBe(1); // green
        });

        it('cie76 metric maps correctly', () => {
            const px = createLab16Pixels([
                { L: 50, a: 78, b: 65 }
            ]);
            const result = PixelAssignment.reassignWithStride(
                px, RGB_PALETTE, 1, 1, 1, 16, { distanceMetric: 'cie76' }
            );
            expect(result[0]).toBe(0); // red
        });

        it('cie94 metric maps correctly', () => {
            const px = createLab16Pixels([
                { L: 85, a: -80, b: 80 }
            ]);
            const result = PixelAssignment.reassignWithStride(
                px, RGB_PALETTE, 1, 1, 1, 16, { distanceMetric: 'cie94' }
            );
            expect(result[0]).toBe(1); // green
        });

        it('cie2000 metric maps correctly', () => {
            const px = createLab16Pixels([
                { L: 35, a: 75, b: -100 }
            ]);
            const result = PixelAssignment.reassignWithStride(
                px, RGB_PALETTE, 1, 1, 1, 16, { distanceMetric: 'cie2000' }
            );
            expect(result[0]).toBe(2); // blue
        });
    });

    describe('weight options', () => {
        it('lWeight emphasis changes assignment for borderline pixels', () => {
            // Pixel equidistant in chroma but different in L
            const px = createLab16Pixels([{ L: 70, a: 0, b: 0 }]);
            const palette = [
                { L: 30, a: 0, b: 0 },  // dark
                { L: 80, a: 0, b: 0 }   // light
            ];

            const resultHighL = PixelAssignment.reassignWithStride(
                px, palette, 1, 1, 1, 16, { lWeight: 10.0, cWeight: 1.0 }
            );
            // With high L weight, should prefer closest L match = light (index 1)
            expect(resultHighL[0]).toBe(1);
        });
    });
});
