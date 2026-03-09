/**
 * ProxyEngine Lifecycle Integration Tests
 *
 * Tests the full ProxyEngine state machine on real images:
 *   - init → knobs → archetype swap → knobs
 *   - Preprocessing swap (auto ↔ off) preserves raw buffer
 *   - Baseline snapshot/restore cycle
 *   - Palette size stability across archetype swaps
 *   - Preview generation from masks (post-knob preview)
 *
 * Maps to SMOKE-TEST.md items:
 *   - "Preview loads" → initializeProxy returns valid state
 *   - "Swap to Distilled/Salamander, preview updates" → rePosterize
 *   - "Layer count matches preview palette" → palette size check
 *   - "No white spots" → mask coverage after knobs
 *   - Knob stress test → updateProxy with all knobs
 */

import { describe, test, expect, beforeAll } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ProxyEngine = require('../../lib/engines/ProxyEngine');
const {
    generateConfigurationMk2,
    generateConfigurationDistilled,
    generateConfigurationSalamander,
    generateConfiguration,
} = require('../../index');
const DNAGenerator = require('../../lib/analysis/DNAGenerator');

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
 * Count uncovered pixels in masks (no mask set).
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
 * Count distinct active colors in colorIndices.
 */
function countActiveColors(colorIndices, pixelCount) {
    const seen = new Set();
    for (let i = 0; i < pixelCount; i++) seen.add(colorIndices[i]);
    return seen.size;
}

/**
 * Check preview RGBA is valid (no all-black, reasonable pixel values).
 */
function validatePreview(buffer, width, height) {
    const pixelCount = width * height;
    expect(buffer.length).toBe(pixelCount * 4);

    // All alpha should be 255
    let opaqueCount = 0;
    for (let i = 3; i < buffer.length; i += 4) {
        if (buffer[i] === 255) opaqueCount++;
    }
    expect(opaqueCount).toBe(pixelCount);

    // Not all black (would indicate conversion failure)
    let nonBlack = 0;
    for (let i = 0; i < buffer.length; i += 4) {
        if (buffer[i] > 0 || buffer[i + 1] > 0 || buffer[i + 2] > 0) nonBlack++;
    }
    expect(nonBlack).toBeGreaterThan(pixelCount * 0.1); // at least 10% non-black
}

// ─── Tests ──────────────────────────────────────────────────────

describe('ProxyEngine lifecycle — jethro 800×547', () => {
    let fixture;
    let dna;

    beforeAll(() => {
        fixture = loadFixture('jethro-800-lab16.labbin.gz');
        dna = DNAGenerator.fromPixels(fixture.pixels, fixture.width, fixture.height);
    });

    // ─── Basic init ─────────────────────────────────────

    test('initializeProxy returns valid state with Chameleon config', async () => {
        const engine = new ProxyEngine();
        const config = generateConfigurationMk2(dna);
        const result = await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);

        expect(result.palette.length).toBeGreaterThan(2);
        expect(result.palette.length).toBeLessThanOrEqual(20);
        expect(result.dimensions.width).toBeGreaterThan(0);
        expect(result.dimensions.height).toBeGreaterThan(0);
        validatePreview(result.previewBuffer, result.dimensions.width, result.dimensions.height);
    }, 30000);

    // ─── Archetype swap ─────────────────────────────────

    test('rePosterize: Chameleon → Distilled → Salamander', async () => {
        const engine = new ProxyEngine();

        // Init with Chameleon
        const chameleonConfig = generateConfigurationMk2(dna);
        const r1 = await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, chameleonConfig);
        const chameleonPaletteSize = r1.palette.length;

        // Swap to Distilled
        const distilledConfig = generateConfigurationDistilled(dna);
        const r2 = await engine.rePosterize(distilledConfig);
        expect(r2.palette.length).toBeGreaterThan(2);
        validatePreview(r2.previewBuffer, r2.dimensions.width, r2.dimensions.height);

        // Swap to Salamander
        const salamanderConfig = generateConfigurationSalamander(dna);
        const r3 = await engine.rePosterize(salamanderConfig);
        expect(r3.palette.length).toBeGreaterThan(2);
        validatePreview(r3.previewBuffer, r3.dimensions.width, r3.dimensions.height);

        // Distilled should have ~8-12 colors (different from Chameleon's DNA-driven count)
        // Salamander should have similar count to Chameleon (DNA-driven, from Mk2)
        expect(r2.palette.length).toBeLessThanOrEqual(15);
    }, 60000);

    // ─── Preprocessing swap ─────────────────────────────

    test('preprocessing swap: auto → off preserves raw buffer', async () => {
        const engine = new ProxyEngine();

        // Init with auto preprocessing (Chameleon)
        const autoConfig = { ...generateConfigurationMk2(dna), preprocessingIntensity: 'auto' };
        await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, autoConfig);

        // Raw buffer should be stored
        expect(engine._rawProxyBuffer).not.toBeNull();
        const rawCopy = new Uint16Array(engine._rawProxyBuffer);

        // Swap to off preprocessing (Distilled-like)
        const offConfig = { ...generateConfigurationDistilled(dna), preprocessingIntensity: 'off' };
        await engine.rePosterize(offConfig);

        // Raw buffer should be unchanged
        expect(engine._rawProxyBuffer).toEqual(rawCopy);

        // proxyBuffer should now be the raw buffer (no filter applied)
        expect(engine._proxyPreprocessingIntensity).toBe('off');
    }, 30000);

    test('preprocessing swap: off → auto applies bilateral filter', async () => {
        const engine = new ProxyEngine();

        // Init with off preprocessing
        const offConfig = { ...generateConfigurationDistilled(dna), preprocessingIntensity: 'off' };
        await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, offConfig);

        const rawCopy = new Uint16Array(engine._rawProxyBuffer);

        // Swap to auto (applies bilateral filter)
        const autoConfig = { ...generateConfigurationMk2(dna), preprocessingIntensity: 'auto' };
        await engine.rePosterize(autoConfig);

        expect(engine._proxyPreprocessingIntensity).toBe('auto');

        // proxyBuffer should differ from raw (filter was applied)
        let diffCount = 0;
        for (let i = 0; i < rawCopy.length; i++) {
            if (engine.proxyBuffer[i] !== rawCopy[i]) diffCount++;
        }
        expect(diffCount).toBeGreaterThan(0);

        // But raw buffer stays clean
        expect(engine._rawProxyBuffer).toEqual(rawCopy);
    }, 30000);

    // ─── Knobs via updateProxy ──────────────────────────

    test('updateProxy: knobs produce valid preview with mask coverage', async () => {
        const engine = new ProxyEngine();
        const config = generateConfigurationMk2(dna);
        await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);

        const result = await engine.updateProxy({
            minVolume: 2,
            speckleRescue: 5,
            shadowClamp: 10,
        });

        validatePreview(result.previewBuffer, engine.separationState.width, engine.separationState.height);

        // Mask coverage
        const { masks, width, height } = engine.separationState;
        expect(countUncoveredPixels(masks, width * height)).toBe(0);
    }, 30000);

    // ─── Baseline snapshot/restore ──────────────────────

    test('baseline restore after knobs: identical to pre-knob state', async () => {
        const engine = new ProxyEngine();
        const config = generateConfigurationMk2(dna);
        await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);

        // Save baseline snapshot
        const snapshot = engine.getBaselineSnapshot();

        // Apply aggressive knobs
        await engine.updateProxy({ minVolume: 5, speckleRescue: 10, shadowClamp: 20 });

        // Verify knobs changed state
        const knobbed = engine.separationState;
        let masksDiff = 0;
        for (let c = 0; c < snapshot.masks.length; c++) {
            for (let i = 0; i < snapshot.colorIndices.length; i++) {
                if (snapshot.masks[c][i] !== knobbed.masks[c][i]) masksDiff++;
            }
        }
        expect(masksDiff).toBeGreaterThan(0);

        // Restore from snapshot
        engine.restoreBaselineSnapshot(snapshot, config);

        // Verify restored state matches original snapshot
        for (let i = 0; i < snapshot.colorIndices.length; i++) {
            expect(engine.separationState.colorIndices[i]).toBe(snapshot.colorIndices[i]);
        }
        for (let c = 0; c < snapshot.masks.length; c++) {
            for (let i = 0; i < snapshot.colorIndices.length; i++) {
                expect(engine.separationState.masks[c][i]).toBe(snapshot.masks[c][i]);
            }
        }
    }, 30000);

    test('updateProxy with zero knobs: equivalent to clean baseline', async () => {
        const engine = new ProxyEngine();
        const config = generateConfigurationMk2(dna);
        await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);

        // Save pre-knob state
        const baseline = engine.getBaselineSnapshot();

        // Apply zeroed knobs
        await engine.updateProxy({ minVolume: 0, speckleRescue: 0, shadowClamp: 0 });

        // Should be functionally equivalent (preview generated from masks now, not indices,
        // but underlying data should be clean)
        const { masks } = engine.separationState;
        const pixelCount = engine.separationState.width * engine.separationState.height;
        expect(countUncoveredPixels(masks, pixelCount)).toBe(0);

        for (let i = 0; i < pixelCount; i++) {
            expect(engine.separationState.colorIndices[i]).toBe(baseline.colorIndices[i]);
        }
    }, 30000);

    // ─── Archetype swap with knobs ──────────────────────

    test('archetype swap resets knob effects', async () => {
        const engine = new ProxyEngine();

        // Init Chameleon + apply heavy knobs
        const chameleonConfig = generateConfigurationMk2(dna);
        await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, chameleonConfig);
        await engine.updateProxy({ minVolume: 5, speckleRescue: 10, shadowClamp: 20 });

        // Swap to Distilled — rePosterize creates fresh baseline
        const distilledConfig = generateConfigurationDistilled(dna);
        const result = await engine.rePosterize(distilledConfig);

        // New baseline should be clean (knobs from Chameleon not carried over)
        const snapshot = engine.getBaselineSnapshot();
        const { width, height } = engine.separationState;
        const pixelCount = width * height;

        // Every pixel should have exactly one mask set in the fresh baseline
        for (let i = 0; i < pixelCount; i++) {
            let count = 0;
            for (let c = 0; c < snapshot.masks.length; c++) {
                if (snapshot.masks[c][i] > 0) count++;
            }
            expect(count).toBe(1);
        }
    }, 30000);

    // ─── Add/remove color ───────────────────────────────

    test('addColorAndReseparate: palette grows, coverage preserved', async () => {
        const engine = new ProxyEngine();
        const config = generateConfigurationDistilled(dna);
        await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);

        const paletteBefore = engine.separationState.palette.length;

        // Add a bright red color
        await engine.addColorAndReseparate({ L: 50, a: 80, b: 60 });

        expect(engine.separationState.palette.length).toBe(paletteBefore + 1);

        const { masks, width, height } = engine.separationState;
        expect(countUncoveredPixels(masks, width * height)).toBe(0);
    }, 30000);

    test('removeColorAndReseparate: palette shrinks, coverage preserved', async () => {
        const engine = new ProxyEngine();
        const config = generateConfigurationDistilled(dna);
        await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);

        const paletteBefore = engine.separationState.palette.length;

        // Remove the last color
        await engine.removeColorAndReseparate(paletteBefore - 1);

        expect(engine.separationState.palette.length).toBe(paletteBefore - 1);

        const { masks, width, height } = engine.separationState;
        expect(countUncoveredPixels(masks, width * height)).toBe(0);
    }, 30000);
});

describe('ProxyEngine lifecycle — horse 350×512', () => {
    let fixture;
    let dna;

    beforeAll(() => {
        fixture = loadFixture('horse-350x512-lab16.labbin.gz');
        dna = DNAGenerator.fromPixels(fixture.pixels, fixture.width, fixture.height);
    });

    test('all three pseudo-archetypes produce valid palettes', async () => {
        const engine = new ProxyEngine();

        // Chameleon
        const chameleonConfig = generateConfigurationMk2(dna);
        const r1 = await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, chameleonConfig);
        expect(r1.palette.length).toBeGreaterThan(2);
        validatePreview(r1.previewBuffer, r1.dimensions.width, r1.dimensions.height);

        // Distilled
        const distilledConfig = generateConfigurationDistilled(dna);
        const r2 = await engine.rePosterize(distilledConfig);
        expect(r2.palette.length).toBeGreaterThan(2);
        validatePreview(r2.previewBuffer, r2.dimensions.width, r2.dimensions.height);

        // Salamander
        const salamanderConfig = generateConfigurationSalamander(dna);
        const r3 = await engine.rePosterize(salamanderConfig);
        expect(r3.palette.length).toBeGreaterThan(2);
        validatePreview(r3.previewBuffer, r3.dimensions.width, r3.dimensions.height);
    }, 60000);

    test('knob stress: horse survives max speckleRescue + shadowClamp', async () => {
        const engine = new ProxyEngine();
        const config = generateConfigurationMk2(dna);
        await engine.initializeProxy(fixture.pixels, fixture.width, fixture.height, config);

        await engine.updateProxy({ speckleRescue: 10, shadowClamp: 15 });

        const { masks, width, height } = engine.separationState;
        expect(countUncoveredPixels(masks, width * height)).toBe(0);
    }, 30000);
});
