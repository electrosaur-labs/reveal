/**
 * Recipe Result — Unit Tests
 */

import { describe, it, expect } from 'vitest';

const Result = require('../../lib/recipe/Result');

// Simple 4×4 image with 3 colors
const WIDTH = 4;
const HEIGHT = 4;
const PALETTE = [
    { L: 10, a: 0, b: 0 },   // black
    { L: 50, a: 30, b: 20 },  // red-brown
    { L: 90, a: -5, b: 5 }    // near-white
];

function makeIndices() {
    // 4×4: top half = color 0, bottom-left = color 1, bottom-right = color 2
    return new Uint8Array([
        0, 0, 0, 0,
        0, 0, 0, 0,
        1, 1, 2, 2,
        1, 1, 2, 2
    ]);
}

function makeResult() {
    return new Result({
        colorIndices: makeIndices(),
        labPalette: PALETTE,
        width: WIDTH,
        height: HEIGHT,
        metadata: { archetype: 'test' }
    });
}

describe('Recipe Result', () => {

    describe('construction', () => {
        it('creates a valid Result', () => {
            const r = makeResult();
            expect(r.width).toBe(4);
            expect(r.height).toBe(4);
            expect(r.palette).toHaveLength(3);
            expect(r.colorIndices).toHaveLength(16);
            expect(r.metadata.archetype).toBe('test');
        });

        it('snapshots palette (no shared reference)', () => {
            const palette = [{ L: 50, a: 0, b: 0 }];
            const r = new Result({
                colorIndices: new Uint8Array([0, 0, 0, 0]),
                labPalette: palette,
                width: 2,
                height: 2
            });
            palette[0].L = 99;
            expect(r.palette[0].L).toBe(50);
        });

        it('throws on missing colorIndices', () => {
            expect(() => new Result({
                labPalette: PALETTE, width: 4, height: 4
            })).toThrow('colorIndices must be a Uint8Array');
        });

        it('throws on empty palette', () => {
            expect(() => new Result({
                colorIndices: makeIndices(),
                labPalette: [],
                width: 4,
                height: 4
            })).toThrow('non-empty array');
        });

        it('throws on size mismatch', () => {
            expect(() => new Result({
                colorIndices: new Uint8Array(10),
                labPalette: PALETTE,
                width: 4,
                height: 4
            })).toThrow('does not match');
        });
    });

    describe('getMask', () => {
        it('generates correct binary mask', () => {
            const r = makeResult();
            const mask0 = r.getMask(0);
            // Top 8 pixels should be 255 (color 0)
            expect(mask0[0]).toBe(255);
            expect(mask0[7]).toBe(255);
            // Bottom pixels should be 0
            expect(mask0[8]).toBe(0);
            expect(mask0[15]).toBe(0);
        });

        it('mask for color 2 has correct pixels', () => {
            const r = makeResult();
            const mask2 = r.getMask(2);
            // Only bottom-right 4 pixels
            expect(mask2.filter(v => v === 255).length).toBe(4);
            expect(mask2[10]).toBe(255);
            expect(mask2[11]).toBe(255);
            expect(mask2[14]).toBe(255);
            expect(mask2[15]).toBe(255);
        });

        it('throws on invalid index', () => {
            const r = makeResult();
            expect(() => r.getMask(-1)).toThrow('colorIndex must be');
            expect(() => r.getMask(3)).toThrow('colorIndex must be');
            expect(() => r.getMask(1.5)).toThrow('colorIndex must be');
        });
    });

    describe('applyKnobs', () => {
        it('accepts valid knob settings', () => {
            const r = makeResult();
            // Should not throw
            r.applyKnobs({ minVolume: 1, speckleRescue: 2, shadowClamp: 5 });
        });

        it('resets to baseline on each call', () => {
            const r = makeResult();
            const original = new Uint8Array(r.colorIndices);

            // Apply aggressive knobs
            r.applyKnobs({ minVolume: 5 });
            const afterKnobs = new Uint8Array(r.colorIndices);

            // Apply zero knobs — should reset to baseline
            r.applyKnobs({ minVolume: 0 });
            expect(Array.from(r.colorIndices)).toEqual(Array.from(original));
        });

        it('throws on unrecognized knob', () => {
            const r = makeResult();
            expect(() => r.applyKnobs({ brightness: 50 }))
                .toThrow('unrecognized knob "brightness"');
        });

        it('throws on out-of-range value', () => {
            const r = makeResult();
            expect(() => r.applyKnobs({ minVolume: 10 }))
                .toThrow('minVolume must be 0-5');
            expect(() => r.applyKnobs({ speckleRescue: -1 }))
                .toThrow('speckleRescue must be 0-10');
            expect(() => r.applyKnobs({ shadowClamp: 25 }))
                .toThrow('shadowClamp must be 0-20');
        });

        it('throws on non-number value', () => {
            const r = makeResult();
            expect(() => r.applyKnobs({ minVolume: 'high' }))
                .toThrow('must be a number');
        });

        it('throws on non-object', () => {
            const r = makeResult();
            expect(() => r.applyKnobs(42)).toThrow('must be an object');
        });
    });
});
