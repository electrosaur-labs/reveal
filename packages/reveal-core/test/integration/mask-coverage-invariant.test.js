/**
 * Mask Coverage Invariant Tests
 *
 * After rebuildMasks + all mechanical knobs (speckleRescue, shadowClamp),
 * every pixel MUST have exactly one mask = 255. Violations mean the
 * substrate shows through (white spots) or multiple inks overprint.
 *
 * Root cause: commit 066a6cd added speckleRescue=5 to pseudo-archetypes.
 * At full resolution, despeckle creates orphan islands that BFS healing
 * can't reach — every neighbor is also an orphan. The fallback in
 * healOrphanedPixels restores these pixels to their original color.
 *
 * Uses real images (jethro 800×547, horse 350×512) because the bug
 * only manifests at scale — the trivial 10×10 test never triggered it.
 */

import { describe, test, expect, beforeAll } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PosterizationEngine = require('../../lib/engines/PosterizationEngine');
const SeparationEngine = require('../../lib/engines/SeparationEngine');
const MechanicalKnobs = require('../../lib/engines/MechanicalKnobs');

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

/**
 * Count pixels where no mask is set (all masks[c][i] === 0).
 * These are "white spots" — substrate showing through.
 */
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

/**
 * Count pixels covered by more than one mask.
 */
function countMultiCoveredPixels(masks, pixelCount) {
    let multi = 0;
    for (let i = 0; i < pixelCount; i++) {
        let count = 0;
        for (let c = 0; c < masks.length; c++) {
            if (masks[c][i] > 0) count++;
        }
        if (count > 1) multi++;
    }
    return multi;
}

/**
 * Run posterize → separate → rebuildMasks → knobs pipeline on a fixture.
 * Returns { masks, colorIndices, palette, pixelCount }.
 */
async function runPipelineWithKnobs(fixture, knobOptions = {}) {
    const { pixels, width, height } = fixture;
    const pixelCount = width * height;

    const ditherType = knobOptions.ditherType || 'none';
    const distanceMetric = knobOptions.distanceMetric || 'cie76';

    // Posterize with distilled engine (matches pseudo-archetype config)
    const posterizeResult = PosterizationEngine.posterize(
        pixels, width, height, 8, {
            engineType: 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        }
    );
    const labPalette = posterizeResult.paletteLab;

    // Separate — nearest-neighbor assignment with configurable dither + metric
    const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
        pixels, labPalette, null, width, height,
        { ditherType, distanceMetric }
    );

    // Apply minVolume
    const minVolumePercent = knobOptions.minVolume || 0;
    MechanicalKnobs.applyMinVolume(colorIndices, labPalette, pixelCount, minVolumePercent);

    // Rebuild masks from (possibly remapped) colorIndices
    const masks = MechanicalKnobs.rebuildMasks(colorIndices, labPalette.length, pixelCount);

    // Apply speckleRescue
    const speckleRescue = knobOptions.speckleRescue || 0;
    MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, speckleRescue);

    // Apply shadowClamp
    const shadowClamp = knobOptions.shadowClamp || 0;
    MechanicalKnobs.applyShadowClamp(masks, colorIndices, labPalette, width, height, shadowClamp);

    return { masks, colorIndices, palette: labPalette, pixelCount, width, height };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('Mask coverage invariant — jethro 800×547', () => {
    let fixture;

    beforeAll(() => {
        fixture = loadFixture('jethro-800-lab16.labbin.gz');
    });

    test('fixture loads correctly', () => {
        expect(fixture.width).toBe(800);
        expect(fixture.height).toBe(547);
        expect(fixture.pixels.length).toBe(800 * 547 * 3);
    });

    test('speckleRescue=5: every pixel covered by exactly one mask', async () => {
        const { masks, pixelCount } = await runPipelineWithKnobs(fixture, {
            speckleRescue: 5,
        });

        const uncovered = countUncoveredPixels(masks, pixelCount);
        const multiCovered = countMultiCoveredPixels(masks, pixelCount);

        expect(uncovered).toBe(0);
        expect(multiCovered).toBe(0);
    }, 30000);

    test('speckleRescue=10: every pixel covered (max threshold)', async () => {
        const { masks, pixelCount } = await runPipelineWithKnobs(fixture, {
            speckleRescue: 10,
        });

        expect(countUncoveredPixels(masks, pixelCount)).toBe(0);
    }, 30000);

    test('shadowClamp=10: every pixel covered after edge erosion', async () => {
        const { masks, pixelCount } = await runPipelineWithKnobs(fixture, {
            shadowClamp: 10,
        });

        expect(countUncoveredPixels(masks, pixelCount)).toBe(0);
    }, 30000);

    test('all knobs combined: every pixel covered', async () => {
        const { masks, pixelCount } = await runPipelineWithKnobs(fixture, {
            minVolume: 2,
            speckleRescue: 5,
            shadowClamp: 10,
        });

        expect(countUncoveredPixels(masks, pixelCount)).toBe(0);
    }, 30000);
});

// ─── Dither + Despeckle adversarial tests ────────────────────────
// The architect's invariant: if dither grain < speckleRescue radius,
// despeckle creates orphan islands with zeroed masks. Every dither type
// must survive speckleRescue without uncovered pixels.

describe('Mask coverage invariant — dither types + speckleRescue (jethro)', () => {
    let fixture;

    beforeAll(() => {
        fixture = loadFixture('jethro-800-lab16.labbin.gz');
    });

    const DITHER_TYPES = ['none', 'atkinson', 'floyd-steinberg', 'stucki', 'bayer'];

    for (const dither of DITHER_TYPES) {
        test(`${dither} + speckleRescue=5: every pixel covered`, async () => {
            const { masks, pixelCount } = await runPipelineWithKnobs(fixture, {
                ditherType: dither,
                speckleRescue: 5,
            });

            const uncovered = countUncoveredPixels(masks, pixelCount);
            expect(uncovered).toBe(0);
        }, 30000);
    }

    test('atkinson + cie94 + speckleRescue=5: every pixel covered', async () => {
        const { masks, pixelCount } = await runPipelineWithKnobs(fixture, {
            ditherType: 'atkinson',
            distanceMetric: 'cie94',
            speckleRescue: 5,
        });

        expect(countUncoveredPixels(masks, pixelCount)).toBe(0);
    }, 30000);

    test('atkinson + cie94 + speckleRescue=5 + all knobs: every pixel covered', async () => {
        const { masks, pixelCount } = await runPipelineWithKnobs(fixture, {
            ditherType: 'atkinson',
            distanceMetric: 'cie94',
            minVolume: 2,
            speckleRescue: 5,
            shadowClamp: 10,
        });

        expect(countUncoveredPixels(masks, pixelCount)).toBe(0);
    }, 30000);
});

describe('Mask coverage invariant — horse 350×512', () => {
    let fixture;

    beforeAll(() => {
        fixture = loadFixture('horse-350x512-lab16.labbin.gz');
    });

    test('fixture loads correctly', () => {
        expect(fixture.width).toBe(350);
        expect(fixture.height).toBe(512);
        expect(fixture.pixels.length).toBe(350 * 512 * 3);
    });

    test('speckleRescue=5: every pixel covered by exactly one mask', async () => {
        const { masks, pixelCount } = await runPipelineWithKnobs(fixture, {
            speckleRescue: 5,
        });

        const uncovered = countUncoveredPixels(masks, pixelCount);
        const multiCovered = countMultiCoveredPixels(masks, pixelCount);

        expect(uncovered).toBe(0);
        expect(multiCovered).toBe(0);
    }, 30000);

    test('all knobs combined: every pixel covered', async () => {
        const { masks, pixelCount } = await runPipelineWithKnobs(fixture, {
            minVolume: 2,
            speckleRescue: 5,
            shadowClamp: 10,
        });

        expect(countUncoveredPixels(masks, pixelCount)).toBe(0);
    }, 30000);
});
