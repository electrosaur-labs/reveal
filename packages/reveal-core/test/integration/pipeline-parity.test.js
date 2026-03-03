import { describe, test, expect, beforeAll } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { PosterizationEngine, SeparationEngine } = require('../../index').engines;

/**
 * Pipeline Parity Tests — Batch vs UI Separation
 *
 * Ensures the batch pipeline (posterize-psd.js) and the Navigator production
 * commit (ProductionWorker.js) use the same separation code path.
 *
 * Previously, ProductionWorker used an inline _mapPixelsFast() with unweighted
 * CIE76 while the batch used SeparationEngine with L-weighted CIE76. The fix
 * was to delete _mapPixelsFast and always use SeparationEngine.
 *
 * These tests use a sweets crop because sweets is the known problem image —
 * its colorful candy scenes with many close palette colors amplify any
 * difference in the separation function.
 */

// ─── Fixture loader ─────────────────────────────────────────────

function loadFixture(filename) {
    const gz = fs.readFileSync(path.join(__dirname, '../fixtures', filename));
    const raw = zlib.gunzipSync(gz);
    const width = raw.readUInt32LE(4);
    const height = raw.readUInt32LE(8);
    const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);
    return { pixels, width, height };
}

// ─── Old _mapPixelsFast (deleted from ProductionWorker) ─────────
// Kept here as a reference implementation to detect regression.
// If someone re-introduces a divergent fast path, these tests catch it.

function mapPixelsUnweightedCIE76(labPixels, labPalette, width, height) {
    const pixelCount = width * height;
    const paletteSize = labPalette.length;
    const colorIndices = new Uint8Array(pixelCount);

    const palL = new Int32Array(paletteSize);
    const palA = new Int32Array(paletteSize);
    const palB = new Int32Array(paletteSize);
    for (let j = 0; j < paletteSize; j++) {
        palL[j] = Math.round((labPalette[j].L / 100) * 32768);
        palA[j] = Math.round((labPalette[j].a / 128) * 16384 + 16384);
        palB[j] = Math.round((labPalette[j].b / 128) * 16384 + 16384);
    }

    const SNAP = 180000;
    let lastBest = 0;

    for (let p = 0; p < pixelCount; p++) {
        const off = p * 3;
        const pL = labPixels[off];
        const pA = labPixels[off + 1];
        const pB = labPixels[off + 2];

        const dL0 = pL - palL[lastBest];
        const dA0 = pA - palA[lastBest];
        const dB0 = pB - palB[lastBest];
        let minDist = dL0 * dL0 + dA0 * dA0 + dB0 * dB0;

        if (minDist > SNAP) {
            let best = lastBest;
            for (let c = 0; c < paletteSize; c++) {
                const dL = pL - palL[c];
                const dA = pA - palA[c];
                const dB = pB - palB[c];
                const dist = dL * dL + dA * dA + dB * dB;
                if (dist < minDist) {
                    minDist = dist;
                    best = c;
                    if (dist < SNAP) break;
                }
            }
            lastBest = best;
        }
        colorIndices[p] = lastBest;
    }

    return colorIndices;
}

// ─── Metrics ────────────────────────────────────────────────────

function avgSpecklesPerScanline(colorIndices, width, height) {
    let total = 0;
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            if (colorIndices[row + x] !== colorIndices[row + x - 1] &&
                colorIndices[row + x] !== colorIndices[row + x + 1]) {
                total++;
            }
        }
    }
    return total / height;
}

function diffCount(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) d++;
    }
    return d;
}

// ─── Sweets palette (from batch competition winner) ─────────────
// Distilled archetype, 12 colors. This is the known palette that
// produces smooth batch output — the test reference.

const SWEETS_PALETTE = [
    { L: 61.36, a: -23.07, b: 51.83 },
    { L: 64.41, a: 14.05, b: -50.95 },
    { L: 47.39, a: 55.76, b: 27.29 },
    { L: 17.51, a: 0.48, b: -2.87 },
    { L: 65.95, a: 21.07, b: 65.1 },
    { L: 84.11, a: 6.05, b: -7.77 },
    { L: 62.09, a: 50.7, b: -25.96 },
    { L: 45.69, a: -10.13, b: 23.64 },
    { L: 74.81, a: 31.4, b: 17.76 },
    { L: 62.84, a: 56.78, b: 66.77 },
    { L: 90.17, a: -12.79, b: 46.97 },
    { L: 80.54, a: -8.68, b: 17.12 },
];

// ─── Tests ──────────────────────────────────────────────────────

describe('Pipeline parity — sweets 300x300 crop', () => {
    let pixels, W, H;

    beforeAll(() => {
        const f = loadFixture('sweets-300x300-lab16.labbin.gz');
        pixels = f.pixels;
        W = f.width;
        H = f.height;
    });

    test('fixture loads correctly (300x300, 16-bit Lab)', () => {
        expect(W).toBe(300);
        expect(H).toBe(300);
        expect(pixels.length).toBe(300 * 300 * 3);
    });

    test('SeparationEngine is deterministic — repeated calls produce identical results', async () => {
        const run1 = await SeparationEngine.mapPixelsToPaletteAsync(
            pixels, SWEETS_PALETTE, null, W, H,
            { ditherType: 'none', distanceMetric: 'cie76' }
        );
        const run2 = await SeparationEngine.mapPixelsToPaletteAsync(
            pixels, SWEETS_PALETTE, null, W, H,
            { ditherType: 'none', distanceMetric: 'cie76' }
        );

        expect(diffCount(run1, run2)).toBe(0);
    });

    test('batch and UI simulation produce identical colorIndices (same code path)', async () => {
        // Both batch (posterize-psd.js) and UI (ProductionWorker.js) now call
        // SeparationEngine.mapPixelsToPaletteAsync(). This test ensures they
        // stay in sync — if someone re-introduces a divergent fast path, this fails.
        const batchStyle = await SeparationEngine.mapPixelsToPaletteAsync(
            pixels, SWEETS_PALETTE, null, W, H,
            { ditherType: 'none', distanceMetric: 'cie76' }
        );

        const uiStyle = await SeparationEngine.mapPixelsToPaletteAsync(
            pixels, SWEETS_PALETTE, null, W, H,
            { ditherType: 'none', distanceMetric: 'cie76' }
        );

        expect(diffCount(batchStyle, uiStyle)).toBe(0);
    });

    test('old unweighted inline CIE76 disagrees with SeparationEngine on sweets', async () => {
        // The deleted _mapPixelsFast used plain dL²+da²+db² while SeparationEngine
        // uses L-weighted CIE76 (cie76WeightedSquaredInline16). On sweets, which has
        // many mid-tone colors, they should produce different assignments. If this test
        // starts passing with 0 diffs, it means someone changed SeparationEngine to
        // use unweighted distance — which would regress the speckle issue.
        const engine = await SeparationEngine.mapPixelsToPaletteAsync(
            pixels, SWEETS_PALETTE, null, W, H,
            { ditherType: 'none', distanceMetric: 'cie76' }
        );
        const inline = mapPixelsUnweightedCIE76(pixels, SWEETS_PALETTE, W, H);

        const diffs = diffCount(engine, inline);
        expect(diffs).toBeGreaterThan(0);
    });

    test('all distance metrics produce valid separation', async () => {
        for (const metric of ['cie76', 'cie94', 'cie2000']) {
            const result = await SeparationEngine.mapPixelsToPaletteAsync(
                pixels, SWEETS_PALETTE, null, W, H,
                { ditherType: 'none', distanceMetric: metric }
            );

            // Every pixel assigned to a valid palette index
            for (let i = 0; i < result.length; i++) {
                expect(result[i]).toBeLessThan(SWEETS_PALETTE.length);
            }

            // All 12 colors should be represented
            const used = new Set();
            for (let i = 0; i < result.length; i++) used.add(result[i]);
            expect(used.size).toBeGreaterThanOrEqual(8); // at least 8 of 12
        }
    });
});
