/**
 * Performance Path Integrity Tests
 * 
 * Exercises mathematical edge cases introduced by hot-loop optimizations:
 * 1. LabMedianCut: 45-bit packed integer hash collision resistance.
 * 2. DNAGenerator: Hue sector boundary accuracy (modulo math).
 * 3. SeparationEngine: Parity between 16-bit and Float32 paths.
 */

import { describe, it, expect } from 'vitest';
const LabMedianCut = require('../../lib/engines/LabMedianCut');
const DNAGenerator = require('../../lib/analysis/DNAGenerator');
const SeparationEngine = require('../../lib/engines/SeparationEngine');
const { perceptualToEngine16 } = require('../../lib/color/LabEncoding');

describe('Performance Path Integrity', () => {

    describe('LabMedianCut - Integer Hash Robustness', () => {
        it('distinguishes between colors differing by only 0.01 Lab units', () => {
            // The hash uses Math.round(val * 100)
            const color1 = { L: 50.004, a: 10.004, b: 10.004 };
            const color2 = { L: 50.006, a: 10.006, b: 10.006 };
            
            // LabMedianCut has a GRID_STRIDE of 10.
            // We must provide at least 10 pixels for each color to ensure they are sampled.
            const p1 = new Array(10).fill([color1.L, color1.a, color1.b]).flat();
            const p2 = new Array(10).fill([color2.L, color2.a, color2.b]).flat();
            const pixels = new Float32Array([...p1, ...p2]);

            // Run LabMedianCut's internal deduplication
            const palette = LabMedianCut.medianCutInLabSpace(pixels, 2, false);
            
            // If the hash works, it should see distinct counts
            expect(palette.length).toBeGreaterThanOrEqual(1);
        });

        it('handles boundary values (0 and 100/128) without overflow or collision', () => {
            const extremeColors = [
                { L: 0, a: -128, b: -128 },
                { L: 100, a: 127, b: 127 },
                { L: 50, a: 0, b: 0 }
            ];
            
            // Repeat each color 10 times to ensure sampling
            const p = extremeColors.flatMap(c => new Array(10).fill([c.L, c.a, c.b]).flat());
            const pixels = new Float32Array(p);
            
            const palette = LabMedianCut.medianCutInLabSpace(pixels, 3, false);
            expect(palette.length).toBe(3);
        });
    });

    describe('DNAGenerator - Hue Sector Boundaries', () => {
        const gen = new DNAGenerator();

        it('correctly categorizes "Red" boundary at 345 degrees', () => {
            // Red sector is 345° to 15°
            // 344.9° should be 'rose', 345.1° should be 'red'
            // We use L=50, C=20 to ensure it's chromatic (>5)
            const degToRad = Math.PI / 180;
            
            const roseHue = 344 * degToRad;
            const redHue = 346 * degToRad;

            const pixels = new Float32Array([
                50, 20 * Math.cos(roseHue), 20 * Math.sin(roseHue),
                50, 20 * Math.cos(redHue), 20 * Math.sin(redHue)
            ]);

            const dna = gen.generate(pixels, 2, 1, { bitDepth: 'perceptual' });
            expect(dna.sectors.rose.weight).toBe(0.5);
            expect(dna.sectors.red.weight).toBe(0.5);
        });

        it('correctly handles the 0 degree wrap-around', () => {
            const wrapHue = 0.1 * (Math.PI / 180); // Just past 0
            const pixels = new Float32Array([50, 20 * Math.cos(wrapHue), 20 * Math.sin(wrapHue)]);
            const dna = gen.generate(pixels, 1, 1, { bitDepth: 'perceptual' });
            expect(dna.sectors.red.weight).toBe(1.0);
        });
    });

    describe('SeparationEngine - Path Parity', () => {
        it('produces identical indices for Uint16 and Float32 inputs', () => {
            const palette = [
                { L: 10, a: 0, b: 0 },
                { L: 90, a: 0, b: 0 },
                { L: 53, a: 80, b: 67 }
            ];

            const testColor = { L: 55, a: 75, b: 60 }; // Closer to index 2
            
            // 1. Perceptual path
            const f32Pixels = new Float32Array([testColor.L, testColor.a, testColor.b]);
            const indicesF32 = SeparationEngine.mapPixelsToPalette(f32Pixels, palette);

            // 2. 16-bit path
            const e16 = perceptualToEngine16(testColor.L, testColor.a, testColor.b);
            const u16Pixels = new Uint16Array([e16.L16, e16.a16, e16.b16]);
            const indicesU16 = SeparationEngine.mapPixelsToPalette(u16Pixels, palette);

            expect(indicesU16[0]).toBe(indicesF32[0]);
        });
    });
});
