/**
 * Mesh-aware (Macro-Cell) dithering — Rule of 7 for error-diffusion dither
 * types.
 *
 * Previously, `meshCount`'s derived `scale` only reached the Bayer
 * strategy; floyd-steinberg/atkinson/stucki ignored it entirely and
 * routinely produced 1px dots regardless of mesh TPI. This verifies the
 * fix: with a mesh count supplied, every dot these strategies produce is
 * structurally >= `scale` px wide in both dimensions.
 */

const SeparationEngine = require('../../lib/engines/SeparationEngine');
const DitheringStrategies = require('../../lib/engines/DitheringStrategies');

const labTo16bit = (L, a, b) => ({
    L: Math.round((L / 100) * 32768),
    a: Math.round((a / 128) * 16384 + 16384),
    b: Math.round((b / 128) * 16384 + 16384)
});

// A smooth gradient gives dithering strategies real work to do (a flat
// image dithers trivially to one color everywhere).
function makeGradientLab16(width, height) {
    const rawBytes = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const t = (x + y) / (width + height); // 0..1
            const lab16 = labTo16bit(10 + t * 80, 0, 0);
            const i = (y * width + x) * 3;
            rawBytes[i] = lab16.L;
            rawBytes[i + 1] = lab16.a;
            rawBytes[i + 2] = lab16.b;
        }
    }
    return rawBytes;
}

const PALETTE = [{ L: 0, a: 0, b: 0 }, { L: 100, a: 0, b: 0 }];

// meshCount=525, dpi=300 -> maxLPI = 525/7 = 75 -> scale = round(300/75) = 4
const MESH_COUNT = 525;
const DPI = 300;
const EXPECTED_SCALE = 4;

function assertBlockUniform(colorIndices, width, height, scale) {
    for (let by = 0; by * scale < height; by++) {
        for (let bx = 0; bx * scale < width; bx++) {
            let first = null;
            for (let dy = 0; dy < scale && by * scale + dy < height; dy++) {
                for (let dx = 0; dx < scale && bx * scale + dx < width; dx++) {
                    const x = bx * scale + dx, y = by * scale + dy;
                    const v = colorIndices[y * width + x];
                    if (first === null) first = v;
                    else if (v !== first) {
                        throw new Error(`Block (${bx},${by}) not uniform: expected ${first}, got ${v} at (${x},${y})`);
                    }
                }
            }
        }
    }
}

describe('Mesh-aware Macro-Cell dithering (Rule of 7) — error diffusion', () => {
    const width = 48, height = 48;

    for (const ditherType of ['floyd-steinberg', 'atkinson', 'stucki']) {
        test(`${ditherType}: every Macro-Cell is uniform (dot width >= scale) when meshCount is set`, async () => {
            const rawBytes = makeGradientLab16(width, height);
            const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, PALETTE, null, width, height,
                { ditherType, meshCount: MESH_COUNT, dpi: DPI }
            );

            expect(colorIndices.length).toBe(width * height);
            // Sanity: dithering actually produced both colors (not degenerate).
            const distinctValues = new Set(colorIndices);
            expect(distinctValues.size).toBeGreaterThan(1);

            assertBlockUniform(colorIndices, width, height, EXPECTED_SCALE);
        });

        test(`${ditherType}: without meshCount, behaves exactly as the unwrapped per-pixel strategy (no regression)`, async () => {
            const rawBytes = makeGradientLab16(width, height);
            const wrapped = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, PALETTE, null, width, height, { ditherType }
            );
            const direct = await DitheringStrategies.DitheringStrategies[ditherType](
                rawBytes, PALETTE, width, height, null
            );

            expect(Array.from(wrapped)).toEqual(Array.from(direct));
        });
    }

    test('bayer macro-cell sampling is untouched by this change (still routed with scale, not block-wrapped)', async () => {
        const rawBytes = makeGradientLab16(width, height);
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            rawBytes, PALETTE, null, width, height,
            { ditherType: 'bayer', meshCount: MESH_COUNT, dpi: DPI }
        );
        expect(colorIndices.length).toBe(width * height);
    });
});
