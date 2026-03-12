/**
 * Recipe Engine — Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';

const Engine = require('../../lib/recipe/Engine');
const Image = require('../../lib/recipe/Image');
const { Palette } = require('../../lib/recipe/Palette');
const Result = require('../../lib/recipe/Result');
const ArchetypeLoader = require('../../lib/analysis/ArchetypeLoader');
const { perceptualLabTo16bit } = require('../helpers/lab-conversion');

// Build a small multi-color test image (16×16 with 5 color regions)
function makeTestImage() {
    const WIDTH = 16;
    const HEIGHT = 16;
    const REGIONS = [
        { L: 45, a: 60, b: 30 },    // Red
        { L: 55, a: -50, b: 40 },   // Green
        { L: 30, a: 10, b: -55 },   // Blue
        { L: 85, a: -5, b: 70 },    // Yellow
        { L: 50, a: 0, b: 0 },      // Gray
    ];

    const pixels = [];
    const pixelCount = WIDTH * HEIGHT;
    for (let i = 0; i < pixelCount; i++) {
        const region = Math.min(Math.floor(i / (pixelCount / REGIONS.length)), REGIONS.length - 1);
        pixels.push(REGIONS[region]);
    }

    const labPixels = perceptualLabTo16bit(pixels);
    return new Image({ labPixels, width: WIDTH, height: HEIGHT });
}

// Always start with fresh archetype cache
beforeEach(() => {
    ArchetypeLoader.clearCache();
});

describe('Recipe Engine', () => {

    describe('construction', () => {
        it('creates an empty engine', () => {
            const engine = new Engine();
            expect(engine).toBeDefined();
        });
    });

    describe('applyArchetype', () => {
        it('accepts a valid archetype name', () => {
            const engine = new Engine();
            engine.applyArchetype('minkler');
            // No throw = success
        });

        it('accepts overrides', () => {
            const engine = new Engine();
            engine.applyArchetype('minkler', { targetColors: 10 });
        });

        it('throws on unknown archetype', () => {
            const engine = new Engine();
            expect(() => engine.applyArchetype('nonexistent'))
                .toThrow('unknown archetype');
        });

        it('throws on empty name', () => {
            const engine = new Engine();
            expect(() => engine.applyArchetype(''))
                .toThrow('non-empty string');
        });

        it('throws on unrecognized override key', () => {
            const engine = new Engine();
            expect(() => engine.applyArchetype('minkler', { brightness: 50 }))
                .toThrow('unrecognized parameter');
        });
    });

    describe('setParam / setParams', () => {
        it('sets a valid parameter', () => {
            const engine = new Engine();
            engine.setParam('targetColors', 8);
        });

        it('throws on unrecognized parameter', () => {
            const engine = new Engine();
            expect(() => engine.setParam('targetColrs', 8))
                .toThrow('unrecognized parameter "targetColrs"');
        });

        it('setParams accepts multiple valid params', () => {
            const engine = new Engine();
            engine.setParams({ targetColors: 8, quantizer: 'wu' });
        });

        it('setParams throws on any unrecognized key', () => {
            const engine = new Engine();
            expect(() => engine.setParams({ targetColors: 8, foo: 'bar' }))
                .toThrow('unrecognized parameter "foo"');
        });

        it('setParams throws on non-object', () => {
            const engine = new Engine();
            expect(() => engine.setParams(42))
                .toThrow('must be an object');
        });
    });

    describe('quantize', () => {
        it('produces a Palette from an image', () => {
            const engine = new Engine();
            engine.applyArchetype('minkler');
            const image = makeTestImage();

            const palette = engine.quantize(image, { targetColors: 5 });

            expect(palette).toBeInstanceOf(Palette);
            expect(palette.length).toBeGreaterThanOrEqual(2);
            expect(palette.length).toBeLessThanOrEqual(10);
        });

        it('works without an archetype (bare params)', () => {
            const engine = new Engine();
            engine.setParams({ targetColors: 4, engineType: 'balanced' });
            const image = makeTestImage();

            const palette = engine.quantize(image);
            expect(palette).toBeInstanceOf(Palette);
            expect(palette.length).toBeGreaterThanOrEqual(1);
        });

        it('does not mutate the engine', () => {
            const engine = new Engine();
            engine.applyArchetype('minkler');
            const image = makeTestImage();

            const p1 = engine.quantize(image, { targetColors: 5 });
            const p2 = engine.quantize(image, { targetColors: 5 });

            // Both should produce palettes (engine reusable)
            expect(p1.length).toBe(p2.length);
        });

        it('throws on invalid image', () => {
            const engine = new Engine();
            expect(() => engine.quantize({})).toThrow('must be a Recipe Image');
        });

        it('throws on unrecognized option', () => {
            const engine = new Engine();
            const image = makeTestImage();
            expect(() => engine.quantize(image, { brightnes: 5 }))
                .toThrow('unrecognized parameter');
        });
    });

    describe('separate', () => {
        it('produces a Result from image + palette', () => {
            const engine = new Engine();
            engine.applyArchetype('minkler');
            const image = makeTestImage();

            const palette = engine.quantize(image, { targetColors: 5 });
            const result = engine.separate(image, palette);

            expect(result).toBeInstanceOf(Result);
            expect(result.colorIndices).toBeInstanceOf(Uint8Array);
            expect(result.colorIndices.length).toBe(image.width * image.height);
            expect(result.width).toBe(image.width);
            expect(result.height).toBe(image.height);
            expect(result.metadata.archetype).toBe('minkler');
        });

        it('supports dither option', () => {
            const engine = new Engine();
            engine.applyArchetype('minkler');
            const image = makeTestImage();

            const palette = engine.quantize(image, { targetColors: 5 });
            const result = engine.separate(image, palette, { ditherType: 'floyd-steinberg' });

            expect(result.metadata.ditherType).toBe('floyd-steinberg');
        });

        it('throws on invalid palette', () => {
            const engine = new Engine();
            const image = makeTestImage();
            expect(() => engine.separate(image, null)).toThrow('must be a Palette');
        });

        it('throws on invalid image', () => {
            const engine = new Engine();
            const palette = new Palette([{ L: 50, a: 0, b: 0 }]);
            expect(() => engine.separate({}, palette)).toThrow('must be a Recipe Image');
        });
    });

    describe('full pipeline', () => {
        it('runs a complete recipe: configure → quantize → surgery → separate → knobs', () => {
            const engine = new Engine();
            engine.applyArchetype('minkler');

            const image = makeTestImage();
            const palette = engine.quantize(image, { targetColors: 5 });

            // Surgery: remove a color if we have enough
            if (palette.length > 3) {
                palette.remove(palette.length - 1);
            }

            const result = engine.separate(image, palette);
            result.applyKnobs({ speckleRescue: 1, minVolume: 0.5 });

            // Verify the full result
            expect(result.colorIndices.length).toBe(image.width * image.height);
            expect(result.palette.length).toBe(palette.length);

            // Masks should work
            const mask = result.getMask(0);
            expect(mask.length).toBe(image.width * image.height);
        });

        it('same engine, different images', () => {
            const engine = new Engine();
            engine.applyArchetype('minkler');
            engine.setParam('targetColors', 4);

            const image1 = makeTestImage();
            const image2 = makeTestImage(); // same data, but independent objects

            const p1 = engine.quantize(image1);
            const p2 = engine.quantize(image2);

            // Both should work
            expect(p1).toBeInstanceOf(Palette);
            expect(p2).toBeInstanceOf(Palette);
        });
    });
});
