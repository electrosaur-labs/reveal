/**
 * Salamander pseudo-archetype — horse regression tests
 *
 * Validates that generateConfigurationSalamander() produces a working
 * posterization on the horse fixture: DNA-driven color count, no palette
 * collapse from pruning, and ProxyEngine compatibility.
 */

import { describe, test, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const Reveal = require('../../index');
const { PosterizationEngine } = Reveal.engines;
const ProxyEngine = require('../../lib/engines/ProxyEngine');
const DNAGenerator = require('../../lib/analysis/DNAGenerator');

/**
 * Load the 350x512 16-bit Lab horse fixture.
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

describe('Salamander posterization — horse regression', () => {
    const { pixels, width, height } = loadHorseFixture();

    // Generate DNA once for all tests
    const dnaGen = new DNAGenerator();
    const dna = dnaGen.generate(pixels, width, height, { bitDepth: 16 });

    test('fixture loads correctly', () => {
        expect(width).toBe(350);
        expect(height).toBe(512);
        expect(pixels.length).toBe(350 * 512 * 3);
    });

    test('Salamander config has fixed 12 colors with VOLUMETRIC centroid', () => {
        const config = Reveal.generateConfigurationSalamander(dna);
        expect(config.targetColors).toBe(12);
        expect(config.centroidStrategy).toBe('VOLUMETRIC');
        expect(config.engineType).toBe('distilled');
        expect(config.enablePaletteReduction).toBe(false);
    });

    test('posterize() produces expected color count from Salamander config', () => {
        const config = Reveal.generateConfigurationSalamander(dna);
        const result = PosterizationEngine.posterize(pixels, width, height, config.targetColors, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        expect(result).toBeDefined();
        expect(result.paletteLab).toBeDefined();
        // All colors survive (no pruning) — palette length equals target
        expect(result.paletteLab.length).toBe(config.targetColors);
        expect(result.assignments.length).toBe(width * height);
    });

    test('Salamander palette has diverse hues (blue, green, warm)', () => {
        const config = Reveal.generateConfigurationSalamander(dna);
        const result = PosterizationEngine.posterize(pixels, width, height, config.targetColors, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        const palette = result.paletteLab;

        // Horse image has sky blue, green foliage, and warm earth tones
        const hasBlue  = palette.some(c => c.a < -5 && c.b < -20);
        const hasGreen = palette.some(c => c.a < -10 && c.b > 30);
        const hasWarm  = palette.some(c => c.b > 30 && c.a > 10);

        expect(hasBlue).toBe(true);
        expect(hasGreen).toBe(true);
        expect(hasWarm).toBe(true);
    });

    test('ProxyEngine handles Salamander config correctly', async () => {
        const config = Reveal.generateConfigurationSalamander(dna);
        const proxy = new ProxyEngine();
        const result = await proxy.initializeProxy(pixels, width, height, config);

        expect(result).toBeDefined();
        expect(result.palette).toBeDefined();
        expect(result.palette.length).toBeGreaterThanOrEqual(3);
        // Proxy dimensions should be downsampled
        expect(result.dimensions.width).toBeLessThanOrEqual(800);
        expect(result.dimensions.height).toBeLessThanOrEqual(800);
    });

    test('Salamander inherits DNA weights but uses fixed 12 colors', () => {
        const salamanderConfig = Reveal.generateConfigurationSalamander(dna);
        const distilledConfig = Reveal.generateConfigurationDistilled(dna);

        // Both use 12 colors, but Salamander has DNA-interpolated weights
        expect(salamanderConfig.targetColors).toBe(12);
        expect(distilledConfig.targetColors).toBe(12);
        expect(salamanderConfig.meta.engine).toBe('salamander');
        expect(salamanderConfig.meta.blendInfo).toBeDefined();
    });
});
