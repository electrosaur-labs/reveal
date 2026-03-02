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
