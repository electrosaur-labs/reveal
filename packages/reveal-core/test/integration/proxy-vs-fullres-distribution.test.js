/**
 * Proxy vs Full-Res Distribution Divergence Test
 *
 * The Navigator preview is the user's decision surface. Production
 * separation at full resolution must reproduce the same color distribution.
 * If CIE94 shifts 22% of pixels to green at 3200px when the 512px proxy
 * showed 8%, the user made decisions on false data.
 *
 * Test design:
 *   1. Load 3200px fixture
 *   2. Downsample to 512px (simulating the proxy)
 *   3. Posterize at 512px → locked palette
 *   4. Map 512px pixels to palette → distribution A
 *   5. Map 3200px pixels to same locked palette → distribution B
 *   6. Assert: no color's pixel share shifts by more than threshold
 *
 * Covers all 3 pseudo-archetypes (Chameleon, Distilled, Salamander)
 * plus the winning archetype from DNA matching.
 */

import { describe, test, expect, beforeAll } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PosterizationEngine = require('../../lib/engines/PosterizationEngine');
const SeparationEngine = require('../../lib/engines/SeparationEngine');
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

// ─── Bilinear downsample ────────────────────────────────────────

function downsampleBilinear(labPixels, srcWidth, srcHeight, targetLongEdge) {
    const longEdge = Math.max(srcWidth, srcHeight);
    const scale = targetLongEdge / longEdge;
    const dstWidth = Math.round(srcWidth * scale);
    const dstHeight = Math.round(srcHeight * scale);
    const dstBuffer = new Uint16Array(dstWidth * dstHeight * 3);

    for (let y = 0; y < dstHeight; y++) {
        for (let x = 0; x < dstWidth; x++) {
            const srcX = x / scale;
            const srcY = y / scale;
            const x0 = Math.floor(srcX);
            const y0 = Math.floor(srcY);
            const x1 = Math.min(x0 + 1, srcWidth - 1);
            const y1 = Math.min(y0 + 1, srcHeight - 1);
            const fx = srcX - x0;
            const fy = srcY - y0;

            for (let c = 0; c < 3; c++) {
                const v00 = labPixels[(y0 * srcWidth + x0) * 3 + c];
                const v10 = labPixels[(y0 * srcWidth + x1) * 3 + c];
                const v01 = labPixels[(y1 * srcWidth + x0) * 3 + c];
                const v11 = labPixels[(y1 * srcWidth + x1) * 3 + c];
                const v0 = v00 * (1 - fx) + v10 * fx;
                const v1 = v01 * (1 - fx) + v11 * fx;
                dstBuffer[(y * dstWidth + x) * 3 + c] = Math.round(v0 * (1 - fy) + v1 * fy);
            }
        }
    }

    return { pixels: dstBuffer, width: dstWidth, height: dstHeight };
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Posterize pixels and return locked palette.
 * Uses the config's engineType and posterization settings.
 */
function posterize(pixels, width, height, config) {
    const result = PosterizationEngine.posterize(
        pixels, width, height, config.targetColors || 8, {
            engineType: config.engineType || 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: config.enablePaletteReduction !== undefined
                ? config.enablePaletteReduction : false,
            snapThreshold: config.snapThreshold || 0,
            densityFloor: config.densityFloor || 0,
            centroidStrategy: config.centroidStrategy,
            lWeight: config.lWeight,
            cWeight: config.cWeight,
            blackBias: config.blackBias,
            vibrancyBoost: config.vibrancyBoost,
            highlightThreshold: config.highlightThreshold,
            highlightBoost: config.highlightBoost,
            shadowPoint: config.shadowPoint,
            paletteReduction: config.paletteReduction,
            hueLockAngle: config.hueLockAngle,
            chromaGate: config.chromaGate,
            substrateTolerance: config.substrateTolerance,
            splitMode: config.splitMode,
            peakFinderMaxPeaks: config.peakFinderMaxPeaks,
        }
    );
    return result.paletteLab;
}

/**
 * Map pixels to a locked palette and return per-color pixel share (%).
 */
async function getDistribution(pixels, palette, width, height, config) {
    const pixelCount = width * height;
    const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
        pixels, palette, null, width, height,
        {
            ditherType: config.ditherType || 'none',
            distanceMetric: config.distanceMetric || 'cie76',
        }
    );

    // Count pixels per color
    const counts = new Array(palette.length).fill(0);
    for (let i = 0; i < pixelCount; i++) {
        counts[colorIndices[i]]++;
    }

    // Convert to percentages
    return counts.map(c => (c / pixelCount) * 100);
}

/**
 * Compute max absolute shift between two distributions.
 * Returns { maxShift, shiftDetails } where shiftDetails lists each color's shift.
 */
function computeMaxShift(proxyDist, fullResDist) {
    let maxShift = 0;
    const shiftDetails = [];
    for (let i = 0; i < proxyDist.length; i++) {
        const shift = Math.abs(proxyDist[i] - fullResDist[i]);
        if (shift > maxShift) maxShift = shift;
        shiftDetails.push({
            color: i,
            proxy: proxyDist[i].toFixed(2),
            fullRes: fullResDist[i].toFixed(2),
            shift: shift.toFixed(2),
        });
    }
    return { maxShift, shiftDetails };
}

/**
 * Run the full proxy vs full-res comparison pipeline.
 * Returns { maxShift, shiftDetails, paletteSize }.
 */
async function runProxyVsFullRes(fullResFixture, proxyLongEdge, configGenerator) {
    // Downsample to proxy resolution
    const proxy = downsampleBilinear(
        fullResFixture.pixels,
        fullResFixture.width,
        fullResFixture.height,
        proxyLongEdge
    );

    // Generate DNA from proxy (matches Navigator behavior)
    const dna = DNAGenerator.fromPixels(proxy.pixels, proxy.width, proxy.height);

    // Generate config from DNA using the specified generator
    const config = configGenerator(dna);

    // Posterize at proxy resolution → locked palette
    const palette = posterize(proxy.pixels, proxy.width, proxy.height, config);

    // Map proxy pixels to palette → proxy distribution
    const proxyDist = await getDistribution(
        proxy.pixels, palette, proxy.width, proxy.height, config
    );

    // Map full-res pixels to same locked palette → full-res distribution
    const fullResDist = await getDistribution(
        fullResFixture.pixels, palette,
        fullResFixture.width, fullResFixture.height, config
    );

    const { maxShift, shiftDetails } = computeMaxShift(proxyDist, fullResDist);

    return { maxShift, shiftDetails, paletteSize: palette.length, config };
}

// ─── Config generators for each pseudo-archetype ────────────────

const CONFIG_GENERATORS = {
    chameleon: (dna) => generateConfigurationMk2(dna),
    distilled: (dna) => generateConfigurationDistilled(dna),
    salamander: (dna) => generateConfigurationSalamander(dna),
    winning: (dna) => generateConfiguration(dna),
};

// Maximum allowed distribution shift (percentage points).
// With the dedup floor respecting targetColors, near-duplicate colors
// that were previously merged now survive, producing slightly different
// distributions at proxy vs full resolution. 10% accommodates this.
const MAX_SHIFT_THRESHOLD = 10.0;

// ─── Tests ──────────────────────────────────────────────────────

describe('Proxy vs full-res distribution — jethro 3200×2189', () => {
    let fixture;

    beforeAll(() => {
        fixture = loadFixture('jethro-3200-lab16.labbin.gz');
    });

    test('fixture loads correctly', () => {
        expect(fixture.width).toBe(3200);
        expect(fixture.height).toBe(2189);
        expect(fixture.pixels.length).toBe(3200 * 2189 * 3);
    });

    for (const [name, configGen] of Object.entries(CONFIG_GENERATORS)) {
        test(`${name}: proxy→fullres distribution shift < ${MAX_SHIFT_THRESHOLD}%`, async () => {
            const result = await runProxyVsFullRes(fixture, 512, configGen);

            // Log details for debugging
            const shifted = result.shiftDetails
                .filter(d => parseFloat(d.shift) > 1.0)
                .map(d => `  color ${d.color}: ${d.proxy}% → ${d.fullRes}% (Δ${d.shift}%)`)
                .join('\n');
            if (shifted) {
                console.log(`[${name}] palette=${result.paletteSize}, maxShift=${result.maxShift.toFixed(2)}%`);
                console.log(`[${name}] Colors shifting >1%:\n${shifted}`);
            }

            expect(result.maxShift).toBeLessThan(MAX_SHIFT_THRESHOLD);
        }, 120000);
    }
});

describe('Proxy vs full-res distribution — horse 2189×3200', () => {
    let fixture;

    beforeAll(() => {
        fixture = loadFixture('horse-3200-lab16.labbin.gz');
    });

    test('fixture loads correctly', () => {
        expect(fixture.width).toBe(2189);
        expect(fixture.height).toBe(3200);
        expect(fixture.pixels.length).toBe(2189 * 3200 * 3);
    });

    for (const [name, configGen] of Object.entries(CONFIG_GENERATORS)) {
        test(`${name}: proxy→fullres distribution shift < ${MAX_SHIFT_THRESHOLD}%`, async () => {
            const result = await runProxyVsFullRes(fixture, 512, configGen);

            const shifted = result.shiftDetails
                .filter(d => parseFloat(d.shift) > 1.0)
                .map(d => `  color ${d.color}: ${d.proxy}% → ${d.fullRes}% (Δ${d.shift}%)`)
                .join('\n');
            if (shifted) {
                console.log(`[${name}] palette=${result.paletteSize}, maxShift=${result.maxShift.toFixed(2)}%`);
                console.log(`[${name}] Colors shifting >1%:\n${shifted}`);
            }

            expect(result.maxShift).toBeLessThan(MAX_SHIFT_THRESHOLD);
        }, 120000);
    }
});
