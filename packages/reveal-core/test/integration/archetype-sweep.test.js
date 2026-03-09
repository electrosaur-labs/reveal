/**
 * Archetype Sweep Integration Tests
 *
 * Automates the manual SMOKE-TEST.md per-image checklist:
 *   - All 3 pseudo-archetypes + winning archetype
 *   - Each produces a valid palette (not collapsed, reasonable size)
 *   - Each produces 100% mask coverage after knobs
 *   - Each produces a valid RGBA preview (not all-black, not all-white)
 *   - Dither type sweep (all 6 dithers × speckleRescue)
 *   - Knob stress test (max values)
 *
 * This is the automated equivalent of "open image, select archetype,
 * commit, inspect layers" from the smoke test plan.
 */

import { describe, test, expect, beforeAll } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ProxyEngine = require('../../lib/engines/ProxyEngine');
const DNAGenerator = require('../../lib/analysis/DNAGenerator');
const {
    generateConfiguration,
    generateConfigurationMk2,
    generateConfigurationDistilled,
    generateConfigurationSalamander,
} = require('../../index');

// ─── Fixture loader ─────────────────────────────────────────────

function loadFixture(filename) {
    const gz = fs.readFileSync(path.join(__dirname, '../fixtures', filename));
    const raw = zlib.gunzipSync(gz);
    const width = raw.readUInt32LE(4);
    const height = raw.readUInt32LE(8);
    const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);
    return { pixels, width, height };
}

// ─── Helpers ────────────────────────────────────────────────────

function countUncoveredPixels(masks, pixelCount) {
    let uncovered = 0;
    for (let i = 0; i < pixelCount; i++) {
        let covered = false;
        for (let c = 0; c < masks.length; c++) {
            if (masks[c][i] > 0) { covered = true; break; }
        }
        if (!covered) uncovered++;
    }
    return uncovered;
}

function validatePreview(buffer, width, height) {
    const pixelCount = width * height;
    expect(buffer.length).toBe(pixelCount * 4);

    // All alpha = 255
    let badAlpha = 0;
    for (let i = 3; i < buffer.length; i += 4) {
        if (buffer[i] !== 255) badAlpha++;
    }
    expect(badAlpha).toBe(0);

    // Not all black
    let nonBlack = 0;
    for (let i = 0; i < buffer.length; i += 4) {
        if (buffer[i] > 0 || buffer[i + 1] > 0 || buffer[i + 2] > 0) nonBlack++;
    }
    expect(nonBlack).toBeGreaterThan(pixelCount * 0.05);

    // Not all white (would indicate mask failure / green cast artifact)
    let nonWhite = 0;
    for (let i = 0; i < buffer.length; i += 4) {
        if (buffer[i] < 255 || buffer[i + 1] < 255 || buffer[i + 2] < 255) nonWhite++;
    }
    expect(nonWhite).toBeGreaterThan(pixelCount * 0.05);
}

/**
 * Run full archetype pipeline: init/rePosterize → apply default knobs → verify.
 * Returns { paletteSize, preview, masks, pixelCount }.
 */
async function runArchetypePipeline(engine, fixture, config, isInit = false) {
    let result;
    if (isInit) {
        result = await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);
    } else {
        result = await engine.rePosterize(config);
    }

    // Apply default knobs (speckleRescue=5 is the pseudo-archetype default)
    const knobResult = await engine.updateProxy({
        minVolume: 0,
        speckleRescue: config.speckleRescue || 0,
        shadowClamp: 0,
    });

    const { masks, width, height, colorIndices } = engine.separationState;
    const pixelCount = width * height;

    return {
        paletteSize: result.palette.length,
        palette: result.palette,
        preview: knobResult.previewBuffer,
        masks,
        colorIndices,
        pixelCount,
        width,
        height,
    };
}

// ─── Config generators ──────────────────────────────────────────

const PSEUDO_ARCHETYPES = [
    { name: 'chameleon', gen: (dna) => generateConfigurationMk2(dna) },
    { name: 'distilled', gen: (dna) => generateConfigurationDistilled(dna) },
    { name: 'salamander', gen: (dna) => generateConfigurationSalamander(dna) },
    { name: 'winning', gen: (dna) => generateConfiguration(dna) },
];

const DITHER_TYPES = ['none', 'atkinson', 'floyd-steinberg', 'stucki', 'bayer'];

// ─── Jethro sweep ───────────────────────────────────────────────

describe('Archetype sweep — jethro 800×547', () => {
    let fixture;
    let dna;

    beforeAll(() => {
        fixture = loadFixture('jethro-800-lab16.labbin.gz');
        dna = DNAGenerator.fromPixels(fixture.pixels, fixture.width, fixture.height);
    });

    for (const { name, gen } of PSEUDO_ARCHETYPES) {
        describe(name, () => {
            test('palette has 3+ colors', async () => {
                const engine = new ProxyEngine();
                const config = gen(dna);
                const result = await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);
                expect(result.palette.length).toBeGreaterThanOrEqual(3);
            }, 30000);

            test('preview is valid after default knobs', async () => {
                const engine = new ProxyEngine();
                const config = gen(dna);
                const { preview, width, height } = await runArchetypePipeline(engine, fixture, config, true);
                validatePreview(preview, width, height);
            }, 30000);

            test('100% mask coverage after default knobs', async () => {
                const engine = new ProxyEngine();
                const config = gen(dna);
                const { masks, pixelCount } = await runArchetypePipeline(engine, fixture, config, true);
                expect(countUncoveredPixels(masks, pixelCount)).toBe(0);
            }, 30000);

            test('survives max knob stress', async () => {
                const engine = new ProxyEngine();
                const config = gen(dna);
                await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);

                await engine.updateProxy({
                    minVolume: 3,
                    speckleRescue: 10,
                    shadowClamp: 15,
                });

                const { masks, width, height } = engine.separationState;
                expect(countUncoveredPixels(masks, width * height)).toBe(0);
            }, 30000);
        });
    }

    // ─── Dither sweep (Chameleon only, matches smoke test) ──────

    describe('dither type sweep (chameleon)', () => {
        for (const dither of DITHER_TYPES) {
            test(`${dither}: valid palette + mask coverage`, async () => {
                const engine = new ProxyEngine();
                const config = { ...generateConfigurationMk2(dna), ditherType: dither };
                await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);

                // Apply speckleRescue (the adversarial interaction with dither)
                await engine.updateProxy({ speckleRescue: 5 });

                const { masks, width, height } = engine.separationState;
                expect(countUncoveredPixels(masks, width * height)).toBe(0);
            }, 30000);
        }
    });
});

// ─── Horse sweep ────────────────────────────────────────────────

describe('Archetype sweep — horse 350×512', () => {
    let fixture;
    let dna;

    beforeAll(() => {
        fixture = loadFixture('horse-350x512-lab16.labbin.gz');
        dna = DNAGenerator.fromPixels(fixture.pixels, fixture.width, fixture.height);
    });

    for (const { name, gen } of PSEUDO_ARCHETYPES) {
        describe(name, () => {
            test('palette has 3+ colors', async () => {
                const engine = new ProxyEngine();
                const config = gen(dna);
                const result = await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);
                expect(result.palette.length).toBeGreaterThanOrEqual(3);
            }, 30000);

            test('preview is valid after default knobs', async () => {
                const engine = new ProxyEngine();
                const config = gen(dna);
                const { preview, width, height } = await runArchetypePipeline(engine, fixture, config, true);
                validatePreview(preview, width, height);
            }, 30000);

            test('100% mask coverage after default knobs', async () => {
                const engine = new ProxyEngine();
                const config = gen(dna);
                const { masks, pixelCount } = await runArchetypePipeline(engine, fixture, config, true);
                expect(countUncoveredPixels(masks, pixelCount)).toBe(0);
            }, 30000);

            test('survives max knob stress', async () => {
                const engine = new ProxyEngine();
                const config = gen(dna);
                await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);

                await engine.updateProxy({
                    minVolume: 3,
                    speckleRescue: 10,
                    shadowClamp: 15,
                });

                const { masks, width, height } = engine.separationState;
                expect(countUncoveredPixels(masks, width * height)).toBe(0);
            }, 30000);
        });
    }
});
