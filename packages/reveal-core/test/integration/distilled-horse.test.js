import { describe, test, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { PosterizationEngine } = require('../../index').engines;

/**
 * Load the 350×512 16-bit Lab horse fixture.
 * Format: magic(4) + width(4) + height(4) + bitDepth(2) + Uint16Array pixels
 */
function loadHorseFixture() {
    const gz = fs.readFileSync(path.join(__dirname, '../fixtures/horse-350x512-lab16.labbin.gz'));
    const raw = zlib.gunzipSync(gz);
    const width = raw.readUInt32LE(4);
    const height = raw.readUInt32LE(8);
    const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);
    return { pixels, width, height };
}

describe('Distilled posterization — horse regression', () => {
    const { pixels, width, height } = loadHorseFixture();

    test('fixture loads correctly', () => {
        expect(width).toBe(350);
        expect(height).toBe(512);
        expect(pixels.length).toBe(350 * 512 * 3);
    });

    test('distilled engine produces 12 colors via posterize() switch', () => {
        const result = PosterizationEngine.posterize(pixels, width, height, 12, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        expect(result).toBeDefined();
        expect(result.paletteLab).toBeDefined();
        expect(result.paletteLab.length).toBe(12);
        expect(result.assignments).toBeDefined();
        expect(result.assignments.length).toBe(width * height);
    });

    test('distilled palette contains warm tones (positive b*)', () => {
        const result = PosterizationEngine.posterize(pixels, width, height, 12, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        // Horse image is warm — at least one colour should have b > 10
        const hasWarm = result.paletteLab.some(c => c.b > 10);
        expect(hasWarm).toBe(true);
    });

    test('distilledPosterize called directly matches posterize switch dispatch', () => {
        const opts = {
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        };

        // Direct call
        const direct = PosterizationEngine.distilledPosterize(pixels, width, height, 12, opts);
        // Via posterize() switch
        const switched = PosterizationEngine.posterize(pixels, width, height, 12, {
            ...opts,
            engineType: 'distilled',
        });

        expect(direct.paletteLab.length).toBe(switched.paletteLab.length);
    });
});
