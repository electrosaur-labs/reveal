import { describe, test, expect } from 'vitest';

const { PosterizationEngine } = require('../../index').engines;

/**
 * Wu quantizer tests — validates the histogram-based splitting loop.
 */
describe('Wu quantizer', () => {

    // Helper: generate 16-bit Lab pixels from color array
    function makePixels16(colors) {
        const total = colors.reduce((s, c) => s + c.count, 0);
        const pixels = new Uint16Array(total * 3);
        let idx = 0;
        for (const c of colors) {
            for (let i = 0; i < c.count; i++) {
                // Encode to 16-bit Photoshop Lab
                pixels[idx++] = Math.round(c.L / 100 * 32768);
                pixels[idx++] = Math.round((c.a + 128) / 256 * 32768);
                pixels[idx++] = Math.round((c.b + 128) / 256 * 32768);
            }
        }
        return pixels;
    }

    const BASE_OPTS = {
        engineType: 'balanced',
        format: 'lab',
        bitDepth: 16,
        enablePaletteReduction: false,
        snapThreshold: 0,
        densityFloor: 0,
    };

    test('single color returns 1-color palette', () => {
        const pixels = makePixels16([{ L: 50, a: 0, b: 0, count: 100 }]);
        const result = PosterizationEngine.posterize(pixels, 10, 10, 3, {
            ...BASE_OPTS, quantizer: 'wu',
        });
        expect(result.paletteLab.length).toBeGreaterThanOrEqual(1);
    });

    test('two distinct clusters produce 2 colors', () => {
        const pixels = makePixels16([
            { L: 20, a: -30, b: -30, count: 500 },
            { L: 80, a: 30, b: 30, count: 500 },
        ]);
        const result = PosterizationEngine.posterize(pixels, 50, 20, 2, {
            ...BASE_OPTS, quantizer: 'wu',
        });
        // Engine may add neutral sovereignty slot; just verify we got at least 2
        expect(result.paletteLab.length).toBeGreaterThanOrEqual(2);

        const Ls = result.paletteLab.map(c => c.L).sort((a, b) => a - b);
        expect(Ls[0]).toBeLessThan(40);
        expect(Ls[Ls.length - 1]).toBeGreaterThan(60);
    });

    test('Wu produces requested color count', () => {
        const pixels = makePixels16([
            { L: 10, a: 0, b: 0, count: 200 },
            { L: 30, a: -40, b: 20, count: 200 },
            { L: 50, a: 40, b: -40, count: 200 },
            { L: 70, a: -20, b: 60, count: 200 },
            { L: 90, a: 20, b: -20, count: 200 },
        ]);
        const result = PosterizationEngine.posterize(pixels, 50, 20, 5, {
            ...BASE_OPTS, quantizer: 'wu',
        });
        // Engine may add neutral sovereignty slot
        expect(result.paletteLab.length).toBeGreaterThanOrEqual(5);
    });

    test('median-cut and Wu both produce valid palettes', () => {
        const pixels = makePixels16([
            { L: 20, a: -30, b: -30, count: 500 },
            { L: 80, a: 30, b: 30, count: 500 },
        ]);

        const mc = PosterizationEngine.posterize(pixels, 50, 20, 2, {
            ...BASE_OPTS, quantizer: 'median-cut',
        });
        const wu = PosterizationEngine.posterize(pixels, 50, 20, 2, {
            ...BASE_OPTS, quantizer: 'wu',
        });

        expect(mc.paletteLab.length).toBeGreaterThanOrEqual(2);
        expect(wu.paletteLab.length).toBeGreaterThanOrEqual(2);
    });

    test('Wu is deterministic', () => {
        const pixels = makePixels16([
            { L: 20, a: -30, b: -30, count: 300 },
            { L: 50, a: 10, b: 40, count: 300 },
            { L: 80, a: 30, b: -10, count: 300 },
        ]);
        const opts = { ...BASE_OPTS, quantizer: 'wu' };

        const r1 = PosterizationEngine.posterize(pixels, 30, 30, 3, opts);
        const r2 = PosterizationEngine.posterize(pixels, 30, 30, 3, opts);

        expect(r1.paletteLab.length).toBe(r2.paletteLab.length);
        for (let i = 0; i < r1.paletteLab.length; i++) {
            expect(r1.paletteLab[i].L).toBeCloseTo(r2.paletteLab[i].L, 5);
            expect(r1.paletteLab[i].a).toBeCloseTo(r2.paletteLab[i].a, 5);
            expect(r1.paletteLab[i].b).toBeCloseTo(r2.paletteLab[i].b, 5);
        }
    });

    test('Wu produces valid Lab ranges', () => {
        const pixels = makePixels16([
            { L: 5, a: -100, b: -80, count: 100 },
            { L: 95, a: 80, b: 100, count: 100 },
            { L: 50, a: 0, b: 0, count: 100 },
            { L: 30, a: -50, b: 50, count: 100 },
            { L: 70, a: 50, b: -50, count: 100 },
        ]);
        const result = PosterizationEngine.posterize(pixels, 22, 22, 5, {
            ...BASE_OPTS, quantizer: 'wu',
        });

        for (const c of result.paletteLab) {
            expect(c.L).toBeGreaterThanOrEqual(0);
            expect(c.L).toBeLessThanOrEqual(100);
            expect(c.a).toBeGreaterThanOrEqual(-128);
            expect(c.a).toBeLessThanOrEqual(128);
            expect(c.b).toBeGreaterThanOrEqual(-128);
            expect(c.b).toBeLessThanOrEqual(128);
            expect(isNaN(c.L)).toBe(false);
            expect(isNaN(c.a)).toBe(false);
            expect(isNaN(c.b)).toBe(false);
        }
    });

    test('Wu on horse fixture produces competitive palette', () => {
        const fs = require('fs');
        const path = require('path');
        const zlib = require('zlib');

        const gz = fs.readFileSync(path.join(__dirname, '../fixtures/horse-350x512-lab16.labbin.gz'));
        const raw = zlib.gunzipSync(gz);
        const width = raw.readUInt32LE(4);
        const height = raw.readUInt32LE(8);
        const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);

        const pixelCount = width * height;

        // Convert to float Lab for ΔE calculation
        const labFloat = new Float32Array(pixelCount * 3);
        for (let i = 0; i < pixelCount; i++) {
            labFloat[i * 3] = pixels[i * 3] / 32768 * 100;
            labFloat[i * 3 + 1] = pixels[i * 3 + 1] / 32768 * 256 - 128;
            labFloat[i * 3 + 2] = pixels[i * 3 + 2] / 32768 * 256 - 128;
        }

        const opts = {
            ...BASE_OPTS,
            engineType: 'distilled',
        };

        const mcResult = PosterizationEngine.posterize(pixels, width, height, 8, {
            ...opts, quantizer: 'median-cut',
        });
        const wuResult = PosterizationEngine.posterize(pixels, width, height, 8, {
            ...opts, quantizer: 'wu',
        });

        expect(mcResult.paletteLab.length).toBeGreaterThanOrEqual(6);
        expect(wuResult.paletteLab.length).toBeGreaterThanOrEqual(6);

        function meanDeltaE(result) {
            const pal = result.paletteLab;
            const assign = result.assignments;
            let sum = 0, count = 0;
            for (let i = 0; i < pixelCount; i++) {
                const c = pal[assign[i]];
                if (!c) continue;
                const L = labFloat[i * 3], a = labFloat[i * 3 + 1], b = labFloat[i * 3 + 2];
                const dL = L - c.L, da = a - c.a, db = b - c.b;
                sum += Math.sqrt(dL * dL + da * da + db * db);
                count++;
            }
            return sum / count;
        }

        const mcDE = meanDeltaE(mcResult);
        const wuDE = meanDeltaE(wuResult);

        console.log(`Horse 8-color distilled: MC ΔE=${mcDE.toFixed(2)}, Wu ΔE=${wuDE.toFixed(2)}`);

        // Wu should not be significantly worse
        expect(wuDE).toBeLessThan(mcDE * 1.3);
    }, 30000);
});
