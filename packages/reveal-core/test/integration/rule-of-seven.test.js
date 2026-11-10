/**
 * Rule of 7 — end-to-end guarantee test.
 *
 * "No isolated element in the separation can be smaller than 7 mesh
 * openings" is a hard physical requirement, not an implementation detail.
 * This test verifies it holds on real fixture images, across every
 * dither type, after MechanicalKnobs.enforceMeshRuleOfSeven runs — using
 * a verifier that is DELIBERATELY independent of the fix's own
 * distance-transform implementation (prefix-sum window scan + flood fill,
 * not the Felzenszwalb erosion test SeparationEngine uses internally).
 */

import { describe, test, expect, beforeAll } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PosterizationEngine = require('../../lib/engines/PosterizationEngine');
const SeparationEngine = require('../../lib/engines/SeparationEngine');
const MechanicalKnobs = require('../../lib/engines/MechanicalKnobs');
const MeshPhysics = require('../../lib/utils/MeshPhysics');

function loadFixture(filename) {
    const gz = fs.readFileSync(path.join(__dirname, '../fixtures', filename));
    const raw = zlib.gunzipSync(gz);
    const width = raw.readUInt32LE(4);
    const height = raw.readUInt32LE(8);
    const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);
    return { pixels, width, height };
}

/**
 * Independent Rule-of-7 verifier: returns the sizes of connected
 * components that do NOT contain an inscribed disk of diameter
 * `requiredSpan` anywhere. An empty return means every isolated element
 * in the mask spans at least `requiredSpan` px somewhere.
 *
 * This checks the same geometric property the fix relies on (a disk —
 * not a stricter axis-aligned square — fits inside the component
 * somewhere, which is the physically correct test for a round printed
 * dot), but via a brute-force per-pixel radius scan rather than the
 * Felzenszwalb two-pass distance transform SeparationEngine uses
 * internally — a different algorithm, so this test can't share a bug
 * with the implementation it's checking.
 */
function hasInscribedDisk(mask, width, height, cx, cy, radius) {
    const r2 = radius * radius;
    const rCeil = Math.ceil(radius);
    for (let dy = -rCeil; dy <= rCeil; dy++) {
        for (let dx = -rCeil; dx <= rCeil; dx++) {
            if (dx * dx + dy * dy > r2) continue;
            const x = cx + dx, y = cy + dy;
            if (x < 0 || x >= width || y < 0 || y >= height) return false;
            if (mask[y * width + x] === 0) return false;
        }
    }
    return true;
}

function findRuleOfSevenViolations(mask, width, height, requiredSpan) {
    const pixelCount = width * height;
    const componentId = new Int32Array(pixelCount).fill(-1);
    let numComponents = 0;
    const stack = new Int32Array(pixelCount);

    for (let i = 0; i < pixelCount; i++) {
        if (mask[i] === 0 || componentId[i] !== -1) continue;
        const id = numComponents++;
        let sp = 0;
        stack[sp++] = i;
        componentId[i] = id;
        while (sp > 0) {
            const idx = stack[--sp];
            const x = idx % width, y = (idx / width) | 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    const nIdx = ny * width + nx;
                    if (mask[nIdx] !== 0 && componentId[nIdx] === -1) {
                        componentId[nIdx] = id;
                        stack[sp++] = nIdx;
                    }
                }
            }
        }
    }

    if (numComponents === 0) return [];

    const radius = requiredSpan / 2;
    const satisfied = new Uint8Array(numComponents);
    const sizes = new Int32Array(numComponents);
    for (let i = 0; i < pixelCount; i++) {
        const id = componentId[i];
        if (id < 0) continue;
        sizes[id]++;
        if (satisfied[id]) continue;
        const x = i % width, y = (i / width) | 0;
        if (hasInscribedDisk(mask, width, height, x, y, radius)) satisfied[id] = 1;
    }

    const violations = [];
    for (let id = 0; id < numComponents; id++) {
        if (!satisfied[id]) violations.push(sizes[id]);
    }
    return violations;
}

/**
 * Posterize + separate a fixture with the given dither type, returning
 * per-color masks BEFORE any mechanical knobs are applied.
 */
async function separateFixture(fixture, ditherType) {
    const { pixels, width, height } = fixture;
    const pixelCount = width * height;

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

    const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
        pixels, labPalette, null, width, height, { ditherType }
    );

    const masks = MechanicalKnobs.rebuildMasks(colorIndices, labPalette.length, pixelCount);
    return { masks, colorIndices, width, height, pixelCount };
}

describe('Rule of 7 — jethro 800×547', () => {
    let fixture;
    const MESH_TPI = 230, DPI = 300;
    const REQUIRED_SPAN = MeshPhysics.minDotPx(MESH_TPI, DPI); // 10

    beforeAll(() => {
        fixture = loadFixture('jethro-800-lab16.labbin.gz');
    });

    const DITHER_TYPES = ['none', 'floyd-steinberg', 'atkinson', 'stucki', 'bayer'];

    for (const ditherType of DITHER_TYPES) {
        test(`${ditherType}: zero violations after enforceMeshRuleOfSeven`, async () => {
            const { masks, colorIndices, width, height } = await separateFixture(fixture, ditherType);

            MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, width, height, {
                meshTPI: MESH_TPI, imageDpi: DPI
            });

            const allViolations = [];
            for (const mask of masks) {
                allViolations.push(...findRuleOfSevenViolations(mask, width, height, REQUIRED_SPAN));
            }

            expect(allViolations).toEqual([]);
        }, 30000);
    }

    test('sanity: the verifier actually finds violations on RAW (unenforced) separation for at least one dither type', async () => {
        // This proves the test is discriminating, not vacuously true —
        // raw separations (before enforceMeshRuleOfSeven) are expected to
        // contain sub-mesh isolated elements.
        const { masks, width, height } = await separateFixture(fixture, 'floyd-steinberg');

        let totalViolations = 0;
        for (const mask of masks) {
            totalViolations += findRuleOfSevenViolations(mask, width, height, REQUIRED_SPAN).length;
        }

        expect(totalViolations).toBeGreaterThan(0);
    }, 30000);

    test('default options (no meshTPI/imageDpi passed) still enforce the 230 TPI / 300 DPI floor', async () => {
        const { masks, colorIndices, width, height } = await separateFixture(fixture, 'atkinson');

        MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, width, height);

        const allViolations = [];
        for (const mask of masks) {
            allViolations.push(...findRuleOfSevenViolations(mask, width, height, REQUIRED_SPAN));
        }
        expect(allViolations).toEqual([]);
    }, 30000);
});

describe('Rule of 7 — horse 350×512', () => {
    let fixture;
    const MESH_TPI = 305, DPI = 300; // a finer mesh -> smaller (but still enforced) floor
    const REQUIRED_SPAN = MeshPhysics.minDotPx(MESH_TPI, DPI);

    beforeAll(() => {
        fixture = loadFixture('horse-350x512-lab16.labbin.gz');
    });

    for (const ditherType of ['none', 'bayer', 'stucki']) {
        test(`${ditherType} @ 305 TPI: zero violations after enforceMeshRuleOfSeven`, async () => {
            const { masks, colorIndices, width, height } = await separateFixture(fixture, ditherType);

            MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, width, height, {
                meshTPI: MESH_TPI, imageDpi: DPI
            });

            const allViolations = [];
            for (const mask of masks) {
                allViolations.push(...findRuleOfSevenViolations(mask, width, height, REQUIRED_SPAN));
            }
            expect(allViolations).toEqual([]);
        }, 30000);
    }
});
