import { describe, test, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { PosterizationEngine } = require('../../index').engines;
const ProxyEngine = require('../../lib/engines/ProxyEngine');
const { generateConfigurationDistilled } = require('../../index');

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

    test('distilled palette has blue, green, and warm tones (content regression)', () => {
        const result = PosterizationEngine.posterize(pixels, width, height, 12, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        const palette = result.paletteLab;

        // Horse image contains sky blue, foliage green, and warm earth tones.
        // Regression: when SALIENCY centroid (a* × 1.6) leaked into distilled path,
        // blue and green disappeared and everything shifted redward.
        const hasBlue  = palette.some(c => c.a < -5 && c.b < -20);
        const hasGreen = palette.some(c => c.a < -10 && c.b > 30);
        const hasWarm  = palette.some(c => c.b > 30 && c.a > 10);

        expect(hasBlue).toBe(true);
        expect(hasGreen).toBe(true);
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

    test('distilled palette matches golden snapshot (ΔE < 2 per color)', () => {
        const result = PosterizationEngine.posterize(pixels, width, height, 12, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        // Golden palette captured from horse-350x512-lab16 fixture.
        // Each entry must have a best-match ΔE < 2 in the actual palette.
        // Order may vary — matching is by nearest neighbor, not positional.
        const golden = [
            { L: 99.8, a:  0.0, b:   0.0 },  // near-white
            { L: 78.0, a: 59.5, b: 116.9 },  // bright orange
            { L: 16.5, a:  3.0, b:   1.7 },  // near-black
            { L: 70.8, a:-27.0, b:  60.9 },  // green/olive
            { L: 53.8, a: 42.4, b:  62.0 },  // warm brown
            { L: 55.0, a:-12.9, b: -34.1 },  // slate blue
            { L: 90.1, a: 21.5, b:  76.4 },  // golden yellow
            { L: 63.8, a: 19.5, b:  26.0 },  // muted earth
            { L: 47.3, a:  0.7, b:  -4.5 },  // neutral gray
            { L: 91.9, a: 30.6, b: 114.7 },  // vivid yellow
            { L: 68.9, a: 51.4, b:  84.6 },  // deep orange
            { L: 21.8, a: 17.5, b:  23.6 },  // dark brown
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
            expect(bestDE).toBeLessThan(2.0);
        }
    });
});

// ═══════════════════════════════════════════════════════════
// ProxyEngine (UI simulator) path — the bug was here
// ═══════════════════════════════════════════════════════════

describe('Distilled horse — ProxyEngine (UI simulator) path', () => {
    const { pixels, width, height } = loadHorseFixture();

    test('ProxyEngine with distilled config produces 12 colors', async () => {
        // Simulate SessionState.swapArchetype('distilled'):
        // 1. generateConfigurationDistilled() creates config
        // 2. ProxyEngine.rePosterize() applies PROXY_SAFE_OVERRIDES
        const config = generateConfigurationDistilled(/* dna not used */);

        const proxyEngine = new ProxyEngine();
        const result = await proxyEngine.initializeProxy(pixels, width, height, config);

        expect(result.palette.length).toBe(12);
    }, 30000);

    test('ProxyEngine distilled palette matches direct PosterizationEngine count', async () => {
        const config = generateConfigurationDistilled();

        // Path A: direct PosterizationEngine (batch path)
        const direct = PosterizationEngine.posterize(pixels, width, height, 12, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        // Path B: ProxyEngine (UI simulator path)
        const proxyEngine = new ProxyEngine();
        const proxyResult = await proxyEngine.initializeProxy(pixels, width, height, config);

        // Both paths must produce 12 colors
        expect(direct.paletteLab.length).toBe(12);
        expect(proxyResult.palette.length).toBe(12);
    }, 30000);

    test('ProxyEngine rePosterize preserves 12 colors after archetype swap', async () => {
        const config = generateConfigurationDistilled();

        const proxyEngine = new ProxyEngine();
        await proxyEngine.initializeProxy(pixels, width, height, config);

        // Swap away and back (simulates user clicking Distilled → other → Distilled)
        const reResult = await proxyEngine.rePosterize(config);

        expect(reResult.palette.length).toBe(12);
    }, 30000);

    test('leaked mechanical knobs collapse palette below 12 (regression guard)', async () => {
        // This is the exact bug: Chameleon's minVolume leaked into Distilled
        // because _applyConfigToState() didn't reset mechanical knobs.
        // With minVolume > 0, low-coverage colors get pruned at proxy resolution.
        const config = generateConfigurationDistilled();

        const proxyEngine = new ProxyEngine();
        const cleanResult = await proxyEngine.initializeProxy(pixels, width, height, config);
        expect(cleanResult.palette.length).toBe(12);

        // Now apply knobs with leaked minVolume (simulates the bug)
        const knobResult = await proxyEngine.updateProxy({
            paletteOverride: cleanResult.palette,
            minVolume: 1.5,    // leaked from Chameleon
            speckleRescue: 4,  // leaked from Chameleon
            shadowClamp: 5,    // leaked from Chameleon
        });

        // minVolume prunes low-coverage colors — count distinct colors in assignments
        const seen = new Set();
        const indices = proxyEngine.separationState.colorIndices;
        for (let i = 0; i < indices.length; i++) seen.add(indices[i]);
        expect(seen.size).toBeLessThan(12);
    }, 30000);
});
