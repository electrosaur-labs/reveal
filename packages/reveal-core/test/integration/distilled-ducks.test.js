import { describe, test, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { PosterizationEngine } = require('../../index').engines;
const ProxyEngine = require('../../lib/engines/ProxyEngine');
const DNAGenerator = require('../../lib/analysis/DNAGenerator');
const { generateConfigurationMk2 } = require('../../index');

/**
 * Load the 350×233 16-bit Lab mandarin ducks fixture.
 * Low-chroma, warm-dominant, background-heavy — stresses minority color survival.
 */
function loadDucksFixture() {
    const gz = fs.readFileSync(path.join(__dirname, '../fixtures/ducks-350-lab16.labbin.gz'));
    const raw = zlib.gunzipSync(gz);
    const width = raw.readUInt32LE(4);
    const height = raw.readUInt32LE(8);
    const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);
    return { pixels, width, height };
}

describe('Distilled posterization — mandarin ducks regression', () => {
    const { pixels, width, height } = loadDucksFixture();

    test('fixture loads correctly', () => {
        expect(width).toBe(350);
        expect(height).toBe(233);
        expect(pixels.length).toBe(350 * 233 * 3);
    });

    test('Chameleon produces 10 colors for ducks', () => {
        const dna = DNAGenerator.fromPixels(pixels, width, height, { bitDepth: 16 });
        const config = generateConfigurationMk2(dna);

        expect(config.targetColors).toBe(10);
        expect(config.engineType).toBe('distilled');

        const result = PosterizationEngine.posterize(pixels, width, height, config.targetColors, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        expect(result.paletteLab.length).toBe(10);
    });

    test('palette has warm, cool, and achromatic tones (content regression)', () => {
        const result = PosterizationEngine.posterize(pixels, width, height, 10, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        const palette = result.paletteLab;

        // Ducks image requires: warm oranges (feathers), cool violet (water),
        // and low-chroma tones (dark olive background).
        const hasWarm   = palette.some(c => c.a > 10 && c.b > 20);   // orange/warm
        const hasCool   = palette.some(c => c.b < -20);               // violet water
        const hasDark   = palette.some(c => c.L < 30);                // dark background
        const hasLight  = palette.some(c => c.L > 80);                // highlights

        expect(hasWarm).toBe(true);
        expect(hasCool).toBe(true);
        expect(hasDark).toBe(true);
        expect(hasLight).toBe(true);
    });

    test('dominant color carries >40% coverage (background-heavy image)', () => {
        const result = PosterizationEngine.posterize(pixels, width, height, 10, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        const pixelCount = width * height;
        const counts = new Uint32Array(result.paletteLab.length);
        for (let i = 0; i < result.assignments.length; i++) {
            counts[result.assignments[i]]++;
        }

        const maxCoverage = Math.max(...counts) / pixelCount;
        expect(maxCoverage).toBeGreaterThan(0.40);
    });

    test('golden palette matches (ΔE < 3 per color)', () => {
        const result = PosterizationEngine.posterize(pixels, width, height, 10, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        // Golden palette captured from ducks-350-lab16 fixture.
        // Matching by nearest neighbor, not positional. ΔE < 3 tolerance
        // (wider than horse's < 2 because low-chroma images have more
        // quantization sensitivity in the dark olive region).
        const golden = [
            { L: 23.7, a:  2.7, b:  5.6 },   // dark olive background
            { L: 88.5, a:  1.5, b: -2.8 },   // near-white highlight
            { L: 54.9, a: 16.1, b:-35.6 },   // violet water
            { L: 63.2, a: 20.2, b: 34.3 },   // warm orange feathers
            { L: 52.4, a:  2.8, b: -5.6 },   // cool gray
            { L: 41.5, a: 32.8, b: 26.0 },   // deep red-orange
            { L: 68.4, a:  6.7, b: 15.7 },   // pale warm
            { L: 41.8, a:  9.1, b: 14.5 },   // muted brown
            { L: 23.7, a: 20.5, b: 16.0 },   // dark warm
            { L: 68.5, a:  2.2, b: -5.9 },   // light cool gray
        ];

        const palette = result.paletteLab;
        expect(palette.length).toBe(golden.length);

        for (const g of golden) {
            let bestDE = Infinity;
            for (const p of palette) {
                const dL = g.L - p.L, da = g.a - p.a, db = g.b - p.b;
                const de = Math.sqrt(dL * dL + da * da + db * db);
                if (de < bestDE) bestDE = de;
            }
            expect(bestDE).toBeLessThan(3.0);
        }
    });

    test('no color has zero coverage (all screens used)', () => {
        const result = PosterizationEngine.posterize(pixels, width, height, 10, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        const counts = new Uint32Array(result.paletteLab.length);
        for (let i = 0; i < result.assignments.length; i++) {
            counts[result.assignments[i]]++;
        }

        for (let i = 0; i < counts.length; i++) {
            expect(counts[i]).toBeGreaterThan(0);
        }
    });
});

describe('Mandarin ducks — ProxyEngine path', () => {
    const { pixels, width, height } = loadDucksFixture();

    test('ProxyEngine Chameleon produces 10 colors', async () => {
        const dna = DNAGenerator.fromPixels(pixels, width, height, { bitDepth: 16 });
        const config = generateConfigurationMk2(dna);

        const proxyEngine = new ProxyEngine();
        const result = await proxyEngine.initializeProxy(pixels, width, height, config);

        expect(result.palette.length).toBe(10);
    }, 30000);

    test('minVolume=1.5 prunes minority colors (knob behavior)', async () => {
        const dna = DNAGenerator.fromPixels(pixels, width, height, { bitDepth: 16 });
        const config = generateConfigurationMk2(dna);

        const proxyEngine = new ProxyEngine();
        await proxyEngine.initializeProxy(pixels, width, height, config);

        // Apply Chameleon's default knobs
        const result = await proxyEngine.updateProxy({
            minVolume: 1.5,
            speckleRescue: 5,
            shadowClamp: 6,
        });

        // Some minority colors should be pruned at this resolution
        const counts = new Uint32Array(result.palette.length);
        const ci = proxyEngine.separationState.colorIndices;
        for (let i = 0; i < ci.length; i++) counts[ci[i]]++;
        const active = Array.from(counts).filter(c => c > 0).length;

        expect(active).toBeLessThan(result.palette.length);
        expect(active).toBeGreaterThanOrEqual(7); // at 350px proxy, up to 3 minority colors pruned
    }, 30000);

    test('zeroed knobs restore all colors from baseline', async () => {
        const dna = DNAGenerator.fromPixels(pixels, width, height, { bitDepth: 16 });
        const config = generateConfigurationMk2(dna);

        const proxyEngine = new ProxyEngine();
        await proxyEngine.initializeProxy(pixels, width, height, config);

        // Zero all knobs — baseline restore should bring back all colors
        const result = await proxyEngine.updateProxy({
            minVolume: 0,
            speckleRescue: 0,
            shadowClamp: 0,
        });

        const counts = new Uint32Array(result.palette.length);
        const ci = proxyEngine.separationState.colorIndices;
        for (let i = 0; i < ci.length; i++) counts[ci[i]]++;
        const active = Array.from(counts).filter(c => c > 0).length;

        expect(active).toBe(result.palette.length);
    }, 30000);
});
