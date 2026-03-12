/**
 * Recipe Image — Unit Tests
 */

import { describe, it, expect } from 'vitest';

const Image = require('../../lib/recipe/Image');
const { perceptualLabTo16bit } = require('../helpers/lab-conversion');

// Helper: create a minimal 4×4 test image with distinct regions
function makeTestPixels(width, height) {
    const pixels = [];
    for (let i = 0; i < width * height; i++) {
        pixels.push({ L: 50, a: 10, b: -20 });
    }
    return perceptualLabTo16bit(pixels);
}

describe('Recipe Image', () => {

    describe('construction', () => {
        it('creates a valid Image from Lab pixels', () => {
            const labPixels = makeTestPixels(4, 4);
            const img = new Image({ labPixels, width: 4, height: 4 });

            expect(img.width).toBe(4);
            expect(img.height).toBe(4);
            expect(img.bitDepth).toBe(16);
            expect(img.colorSpace).toBe('Lab');
            expect(img.labPixels).toBe(labPixels);
            expect(img.filename).toBeUndefined();
        });

        it('accepts optional filename', () => {
            const labPixels = makeTestPixels(4, 4);
            const img = new Image({ labPixels, width: 4, height: 4, filename: 'horse.psd' });

            expect(img.filename).toBe('horse.psd');
        });

        it('accepts 8-bit depth', () => {
            const pixels = [];
            for (let i = 0; i < 16; i++) pixels.push({ L: 50, a: 0, b: 0 });
            const labPixels = perceptualLabTo16bit(pixels);
            const img = new Image({ labPixels, width: 4, height: 4, bitDepth: 8 });

            expect(img.bitDepth).toBe(8);
        });

        it('computes DNA on construction', () => {
            const labPixels = makeTestPixels(8, 8);
            const img = new Image({ labPixels, width: 8, height: 8 });

            expect(img.dna).toBeDefined();
            expect(img.dna.global).toBeDefined();
            expect(img.dna.global.l).toBeGreaterThan(0);
            expect(img.sectors).toBeDefined();
        });
    });

    describe('immutability', () => {
        it('is frozen after construction', () => {
            const labPixels = makeTestPixels(4, 4);
            const img = new Image({ labPixels, width: 4, height: 4 });

            expect(() => { img.width = 999; }).toThrow();
            expect(() => { img.newProp = 'nope'; }).toThrow();
            expect(img.width).toBe(4);
        });
    });

    describe('validation — fail loud', () => {
        it('throws on missing labPixels', () => {
            expect(() => new Image({ width: 4, height: 4 }))
                .toThrow('labPixels is required');
        });

        it('throws on missing width', () => {
            const labPixels = makeTestPixels(4, 4);
            expect(() => new Image({ labPixels, height: 4 }))
                .toThrow('width must be a positive integer');
        });

        it('throws on missing height', () => {
            const labPixels = makeTestPixels(4, 4);
            expect(() => new Image({ labPixels, width: 4 }))
                .toThrow('height must be a positive integer');
        });

        it('throws on zero width', () => {
            expect(() => new Image({ labPixels: new Uint16Array(0), width: 0, height: 4 }))
                .toThrow('width must be a positive integer');
        });

        it('throws on non-integer width', () => {
            const labPixels = makeTestPixels(4, 4);
            expect(() => new Image({ labPixels, width: 4.5, height: 4 }))
                .toThrow('width must be a positive integer');
        });

        it('throws on pixel count mismatch', () => {
            const labPixels = makeTestPixels(4, 4);
            expect(() => new Image({ labPixels, width: 8, height: 8 }))
                .toThrow('does not match');
        });

        it('throws on invalid bitDepth', () => {
            const labPixels = makeTestPixels(4, 4);
            expect(() => new Image({ labPixels, width: 4, height: 4, bitDepth: 32 }))
                .toThrow('bitDepth must be 8 or 16');
        });

        it('throws on unrecognized option key', () => {
            const labPixels = makeTestPixels(4, 4);
            expect(() => new Image({ labPixels, width: 4, height: 4, colour: 'red' }))
                .toThrow('unrecognized option "colour"');
        });
    });
});
