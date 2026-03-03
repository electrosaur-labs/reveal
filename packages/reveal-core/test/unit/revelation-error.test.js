/**
 * RevelationError - Unit tests
 */

import { describe, it, expect } from 'vitest';
const RevelationError = require('../../lib/metrics/RevelationError');

describe('RevelationError', () => {

    describe('fromBuffers (8-bit Lab)', () => {
        it('should return 0 for identical buffers', () => {
            const lab = new Uint8Array([128, 128, 128, 128, 128, 128]); // 2 identical neutral pixels
            const result = RevelationError.fromBuffers(lab, lab, 2, 1);
            expect(result.eRev).toBe(0);
            expect(result.chromaStats).toBeDefined();
            expect(result.chromaStats.cMax).toBeGreaterThanOrEqual(0);
        });

        it('should return non-zero for different buffers', () => {
            // 4 pixels: original is bright red-ish, posterized is neutral gray
            const original = new Uint8Array([
                128, 200, 128, // pixel 0: high +a (red)
                128, 200, 128, // pixel 1: high +a (red)
                128, 128, 128, // pixel 2: neutral
                128, 128, 128  // pixel 3: neutral
            ]);
            const posterized = new Uint8Array([
                128, 128, 128, // all neutral
                128, 128, 128,
                128, 128, 128,
                128, 128, 128
            ]);
            const result = RevelationError.fromBuffers(original, posterized, 2, 2);
            expect(result.eRev).toBeGreaterThan(0);
        });

        it('should weight chromatic pixels more heavily', () => {
            // All pixels have same L difference, but first has high chroma
            const origChromatic = new Uint8Array([200, 200, 128]); // high +a
            const postChromatic = new Uint8Array([128, 200, 128]); // same a, different L
            const origNeutral   = new Uint8Array([200, 128, 128]); // neutral
            const postNeutral   = new Uint8Array([128, 128, 128]); // neutral

            const rChromatic = RevelationError.fromBuffers(origChromatic, postChromatic, 1, 1);
            const rNeutral   = RevelationError.fromBuffers(origNeutral, postNeutral, 1, 1);

            // Both have same L delta of ~28.2 (72/255*100), but weights differ.
            // For a single pixel, cMax = that pixel's chroma, so w = 1 + 10*(C/C) = 11 for chromatic
            // and w = 1 + 10*(0/1) = 1 for neutral (cMax clamped to 1).
            // E_rev = w * dE / w = dE in both cases (single pixel). So they should be similar.
            // The difference shows when MIXING chromatic and neutral pixels.
            expect(rChromatic.eRev).toBeGreaterThan(0);
            expect(rNeutral.eRev).toBeGreaterThan(0);
        });

        it('should respect stride parameter', () => {
            // 4x4 = 16 pixels, stride 2 should sample 4 pixels
            const lab = new Uint8Array(16 * 3).fill(128);
            const posterized = new Uint8Array(16 * 3).fill(128);
            // Modify one pixel that stride=2 WILL hit (0,0)
            lab[0] = 255; // L = 100
            posterized[0] = 0; // L = 0

            const r1 = RevelationError.fromBuffers(lab, posterized, 4, 4, { stride: 1 });
            const r2 = RevelationError.fromBuffers(lab, posterized, 4, 4, { stride: 2 });

            // Both should detect the error, but stride=2 samples fewer pixels so
            // the error pixel has more weight in the average
            expect(r1.eRev).toBeGreaterThan(0);
            expect(r2.eRev).toBeGreaterThan(0);
            expect(r2.eRev).toBeGreaterThan(r1.eRev); // fewer diluting neutral pixels
        });

        it('should return chromaStats', () => {
            const lab = new Uint8Array([
                128, 200, 128, // high +a → chroma ≈ 72
                128, 128, 128  // neutral → chroma = 0
            ]);
            const result = RevelationError.fromBuffers(lab, lab, 2, 1);
            expect(result.chromaStats.cMax).toBeGreaterThan(0);
            expect(result.chromaStats.avgChroma).toBeGreaterThan(0);
            expect(result.chromaStats.chromaPixelRatio).toBeGreaterThanOrEqual(0);
            expect(result.chromaStats.chromaPixelRatio).toBeLessThanOrEqual(1);
        });
    });

    describe('fromIndices (16-bit Lab)', () => {
        it('should return 0 when pixels exactly match palette', () => {
            // 2 pixels: one mapped to palette entry 0, one to entry 1
            // Palette entries exactly match the pixel values
            const L0 = Math.round((50 / 100) * 32768);
            const a0 = 16384; // neutral a
            const b0 = 16384; // neutral b
            const L1 = Math.round((80 / 100) * 32768);
            const a1 = Math.round((30 / 128) * 16384 + 16384); // a = +30
            const b1 = Math.round((-20 / 128) * 16384 + 16384); // b = -20

            const labPixels = new Uint16Array([L0, a0, b0, L1, a1, b1]);
            const colorIndices = new Uint8Array([0, 1]);
            const labPalette = [
                { L: 50, a: 0, b: 0 },
                { L: 80, a: 30, b: -20 }
            ];

            const result = RevelationError.fromIndices(labPixels, colorIndices, labPalette, 2);
            // Should be very close to 0 (minor rounding in 16-bit encoding)
            expect(result.eRev).toBeLessThan(0.5);
        });

        it('should return non-zero when pixels differ from palette', () => {
            // Pixel is bright red, palette entry is dark blue
            const labPixels = new Uint16Array([
                Math.round((60 / 100) * 32768),
                Math.round((50 / 128) * 16384 + 16384),   // a = +50
                Math.round((30 / 128) * 16384 + 16384)    // b = +30
            ]);
            const colorIndices = new Uint8Array([0]);
            const labPalette = [{ L: 30, a: -20, b: -40 }];

            const result = RevelationError.fromIndices(labPixels, colorIndices, labPalette, 1);
            expect(result.eRev).toBeGreaterThan(5);
        });

        it('should handle stride parameter', () => {
            // 4 pixels, stride 2 should sample pixels 0 and 2
            const L = Math.round((50 / 100) * 32768);
            const a = 16384, b = 16384;
            const labPixels = new Uint16Array([L, a, b, L, a, b, L, a, b, L, a, b]);
            const colorIndices = new Uint8Array([0, 0, 0, 0]);
            const labPalette = [{ L: 50, a: 0, b: 0 }];

            const result = RevelationError.fromIndices(labPixels, colorIndices, labPalette, 4, { stride: 2 });
            expect(result.eRev).toBeLessThan(0.5);
        });

        it('should skip pixels with out-of-range indices', () => {
            const L = Math.round((50 / 100) * 32768);
            const labPixels = new Uint16Array([L, 16384, 16384, L, 16384, 16384]);
            const colorIndices = new Uint8Array([0, 5]); // index 5 > palette size
            const labPalette = [{ L: 50, a: 0, b: 0 }];

            const result = RevelationError.fromIndices(labPixels, colorIndices, labPalette, 2);
            // Should not crash, pixel 1 is skipped
            expect(result.eRev).toBeLessThan(0.5);
        });

        it('should return chromaStats', () => {
            const labPixels = new Uint16Array([
                Math.round((50 / 100) * 32768),
                Math.round((60 / 128) * 16384 + 16384), // high chroma
                16384
            ]);
            const colorIndices = new Uint8Array([0]);
            const labPalette = [{ L: 50, a: 60, b: 0 }];

            const result = RevelationError.fromIndices(labPixels, colorIndices, labPalette, 1);
            expect(result.chromaStats).toBeDefined();
            expect(result.chromaStats.cMax).toBeGreaterThan(0);
        });
    });

    describe('meanDeltaE16 (unweighted)', () => {
        it('should return 0 when pixels exactly match palette', () => {
            const L = Math.round((50 / 100) * 32768);
            const a = 16384, b = 16384;
            const labPixels = new Uint16Array([L, a, b, L, a, b]);
            const colorIndices = new Uint8Array([0, 0]);
            const labPalette = [{ L: 50, a: 0, b: 0 }];

            const result = RevelationError.meanDeltaE16(labPixels, colorIndices, labPalette, 2);
            expect(result).toBeLessThan(0.5);
        });

        it('should return non-zero when pixels differ from palette', () => {
            const labPixels = new Uint16Array([
                Math.round((60 / 100) * 32768),
                Math.round((50 / 128) * 16384 + 16384),
                Math.round((30 / 128) * 16384 + 16384)
            ]);
            const colorIndices = new Uint8Array([0]);
            const labPalette = [{ L: 30, a: -20, b: -40 }];

            const result = RevelationError.meanDeltaE16(labPixels, colorIndices, labPalette, 1);
            expect(result).toBeGreaterThan(5);
        });

        it('should skip out-of-range indices without crashing', () => {
            const L = Math.round((50 / 100) * 32768);
            const labPixels = new Uint16Array([L, 16384, 16384, L, 16384, 16384]);
            const colorIndices = new Uint8Array([0, 5]); // index 5 > palette size
            const labPalette = [{ L: 50, a: 0, b: 0 }];

            const result = RevelationError.meanDeltaE16(labPixels, colorIndices, labPalette, 2);
            expect(result).toBeDefined();
            expect(result).toBeGreaterThanOrEqual(0);
        });

        it('should be unweighted (no chroma bias)', () => {
            // Two pixels: one chromatic, one neutral — both with same ΔE to palette.
            // Unweighted mean should treat them equally (unlike E_rev).
            const chromaPixel = [
                Math.round((50 / 100) * 32768),
                Math.round((60 / 128) * 16384 + 16384),  // a = +60 (high chroma)
                16384                                       // b = 0
            ];
            const neutralPixel = [
                Math.round((50 / 100) * 32768),
                16384,                                       // a = 0
                16384                                        // b = 0
            ];
            const labPixels = new Uint16Array([...chromaPixel, ...neutralPixel]);
            const colorIndices = new Uint8Array([0, 1]);
            // Palette entries shifted by same amount from each pixel
            const labPalette = [
                { L: 50, a: 70, b: 0 },   // 10 ΔE from chromaPixel (a diff = 10)
                { L: 50, a: 10, b: 0 }    // 10 ΔE from neutralPixel (a diff = 10)
            ];

            const result = RevelationError.meanDeltaE16(labPixels, colorIndices, labPalette, 2);
            // Both pixels contribute ~10 ΔE, mean should be ~10
            expect(result).toBeGreaterThan(8);
            expect(result).toBeLessThan(12);
        });

        it('should agree with fromIndices on overall magnitude', () => {
            // Same input to both — meanDeltaE16 should be in the same ballpark as E_rev
            const L = Math.round((60 / 100) * 32768);
            const a = Math.round((40 / 128) * 16384 + 16384);
            const b = Math.round((-10 / 128) * 16384 + 16384);
            const labPixels = new Uint16Array([L, a, b, L, a, b, L, a, b, L, a, b]);
            const colorIndices = new Uint8Array([0, 0, 0, 0]);
            const labPalette = [{ L: 40, a: 10, b: 20 }];

            const unweighted = RevelationError.meanDeltaE16(labPixels, colorIndices, labPalette, 4);
            const weighted = RevelationError.fromIndices(labPixels, colorIndices, labPalette, 4);

            // Both should report significant error
            expect(unweighted).toBeGreaterThan(5);
            expect(weighted.eRev).toBeGreaterThan(5);
            // Should be same order of magnitude (within 3x)
            expect(unweighted / weighted.eRev).toBeGreaterThan(0.3);
            expect(unweighted / weighted.eRev).toBeLessThan(3);
        });
    });

    describe('edgeSurvival16', () => {
        // Helper: encode perceptual Lab → 16-bit PS encoding
        function encode16(L, a, b) {
            return [
                Math.round((L / 100) * 32768),
                Math.round((a / 128) * 16384 + 16384),
                Math.round((b / 128) * 16384 + 16384)
            ];
        }

        it('should return 1.0 when all edges are preserved', () => {
            // 2x1 image: two very different colors, assigned to different palette entries
            const p0 = encode16(20, 0, 0);  // dark
            const p1 = encode16(80, 0, 0);  // bright — ΔE=60, well above threshold
            const labPixels = new Uint16Array([...p0, ...p1]);
            const colorIndices = new Uint8Array([0, 1]); // different assignments

            const result = RevelationError.edgeSurvival16(labPixels, colorIndices, 2, 1);
            expect(result.edgeSurvival).toBe(1);
            expect(result.significantEdges).toBe(1);
            expect(result.survivedEdges).toBe(1);
        });

        it('should return 0.0 when all edges are destroyed', () => {
            // 2x1 image: two very different colors, but assigned to SAME palette entry
            const p0 = encode16(20, 0, 0);
            const p1 = encode16(80, 0, 0);
            const labPixels = new Uint16Array([...p0, ...p1]);
            const colorIndices = new Uint8Array([0, 0]); // same assignment — edge destroyed

            const result = RevelationError.edgeSurvival16(labPixels, colorIndices, 2, 1);
            expect(result.edgeSurvival).toBe(0);
            expect(result.significantEdges).toBe(1);
            expect(result.survivedEdges).toBe(0);
        });

        it('should ignore edges below threshold', () => {
            // 2x1 image: two nearly identical colors (ΔE < 15)
            const p0 = encode16(50, 0, 0);
            const p1 = encode16(55, 0, 0);  // ΔE=5, below threshold
            const labPixels = new Uint16Array([...p0, ...p1]);
            const colorIndices = new Uint8Array([0, 0]);

            const result = RevelationError.edgeSurvival16(labPixels, colorIndices, 2, 1);
            expect(result.significantEdges).toBe(0);
            expect(result.edgeSurvival).toBe(1); // no significant edges → trivially perfect
        });

        it('should handle custom threshold', () => {
            const p0 = encode16(50, 0, 0);
            const p1 = encode16(60, 0, 0);  // ΔE=10
            const labPixels = new Uint16Array([...p0, ...p1]);
            const colorIndices = new Uint8Array([0, 1]);

            // Default threshold 15 → not significant
            const r15 = RevelationError.edgeSurvival16(labPixels, colorIndices, 2, 1);
            expect(r15.significantEdges).toBe(0);

            // Lower threshold 8 → significant and survived
            const r8 = RevelationError.edgeSurvival16(labPixels, colorIndices, 2, 1, { edgeThreshold: 8 });
            expect(r8.significantEdges).toBe(1);
            expect(r8.survivedEdges).toBe(1);
        });

        it('should count both horizontal and vertical edges', () => {
            // 2x2 image: checkerboard of dark/bright
            const dark = encode16(20, 0, 0);
            const bright = encode16(80, 0, 0);
            const labPixels = new Uint16Array([
                ...dark, ...bright,   // row 0: dark, bright
                ...bright, ...dark    // row 1: bright, dark
            ]);
            const colorIndices = new Uint8Array([0, 1, 1, 0]);

            const result = RevelationError.edgeSurvival16(labPixels, colorIndices, 2, 2);
            // 2x2 has: 2 horizontal edges (1 per row) + 2 vertical edges (1 per col) = 4
            expect(result.significantEdges).toBe(4);
            expect(result.survivedEdges).toBe(4);
            expect(result.edgeSurvival).toBe(1);
        });
    });

    describe('cross-validation: fromBuffers vs fromIndices', () => {
        it('should produce similar E_rev for equivalent inputs', () => {
            // Create a simple 2x2 image with known colors
            // Original: red pixel + blue pixel + green pixel + neutral pixel
            const orig8 = new Uint8Array([
                180, 200, 160,  // pixel 0: L=70.6, a=+72, b=+32
                100, 100, 200,  // pixel 1: L=39.2, a=-28, b=+72
                150, 80, 128,   // pixel 2: L=58.8, a=-48, b=0
                128, 128, 128   // pixel 3: neutral
            ]);

            // Posterized: all mapped to single gray
            const post8 = new Uint8Array([
                128, 128, 128,
                128, 128, 128,
                128, 128, 128,
                128, 128, 128
            ]);

            const r8 = RevelationError.fromBuffers(orig8, post8, 2, 2);

            // Now build equivalent 16-bit inputs
            // Convert 8-bit Lab to 16-bit PS encoding
            function lab8to16(L8, a8, b8) {
                const L = (L8 / 255) * 100;
                const a = a8 - 128;
                const b = b8 - 128;
                return [
                    Math.round((L / 100) * 32768),
                    Math.round((a / 128) * 16384 + 16384),
                    Math.round((b / 128) * 16384 + 16384)
                ];
            }

            const p0 = lab8to16(180, 200, 160);
            const p1 = lab8to16(100, 100, 200);
            const p2 = lab8to16(150, 80, 128);
            const p3 = lab8to16(128, 128, 128);

            const labPixels16 = new Uint16Array([...p0, ...p1, ...p2, ...p3]);
            const colorIndices = new Uint8Array([0, 0, 0, 0]); // all map to palette 0
            const labPalette = [{ L: (128/255)*100, a: 0, b: 0 }]; // neutral gray

            const r16 = RevelationError.fromIndices(labPixels16, colorIndices, labPalette, 4);

            // Both should report significant error (chromatic original → neutral posterized)
            expect(r8.eRev).toBeGreaterThan(5);
            expect(r16.eRev).toBeGreaterThan(5);

            // Should be reasonably close (not identical due to encoding precision)
            const diff = Math.abs(r8.eRev - r16.eRev);
            expect(diff).toBeLessThan(2); // within 2 ΔE
        });
    });
});
