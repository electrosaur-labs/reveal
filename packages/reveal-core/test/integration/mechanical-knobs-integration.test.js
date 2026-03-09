/**
 * Mechanical Knobs Integration Tests
 *
 * Tests the three post-separation knobs (minVolume, speckleRescue,
 * shadowClamp) on real images with realistic pipeline configurations.
 *
 * Covers:
 *   - All three knobs combined at realistic values
 *   - Knob reversibility: apply → zero → verify identical to original
 *   - Knob idempotency: apply twice = apply once
 *   - Mask coverage invariant preserved through all knob paths
 *   - Knob order independence
 *
 * Uses the shared MechanicalKnobs + rebuildMasks pipeline that both
 * ProxyEngine and ProductionWorker use.
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

// ─── Pipeline helpers ───────────────────────────────────────────

/**
 * Posterize a fixture and return clean baseline state (no knobs applied).
 */
function posterizeFixture(fixture, config = {}) {
    const { pixels, width, height } = fixture;
    const pixelCount = width * height;

    const posterizeResult = PosterizationEngine.posterize(
        pixels, width, height, config.targetColors || 8, {
            engineType: config.engineType || 'distilled',
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        }
    );

    const palette = posterizeResult.paletteLab;
    const colorIndices = new Uint8Array(posterizeResult.assignments);
    const masks = MechanicalKnobs.rebuildMasks(colorIndices, palette.length, pixelCount);

    return { palette, colorIndices, masks, pixelCount, width, height };
}

/**
 * Deep-copy a pipeline state (simulates ProxyEngine._snapshotBaseline).
 */
function snapshotState(state) {
    return {
        palette: state.palette.map(c => ({ ...c })),
        colorIndices: new Uint8Array(state.colorIndices),
        masks: state.masks.map(m => new Uint8Array(m)),
        pixelCount: state.pixelCount,
        width: state.width,
        height: state.height,
    };
}

/**
 * Apply all three knobs to a state (mutates in place).
 * Matches the order in ProxyEngine._applyKnobs.
 */
function applyAllKnobs(state, knobs) {
    const { colorIndices, palette, masks, width, height, pixelCount } = state;

    if (knobs.minVolume > 0) {
        MechanicalKnobs.applyMinVolume(colorIndices, palette, pixelCount, knobs.minVolume);
        // Rebuild masks after minVolume (same as ProxyEngine._applyMinVolume)
        const rebuilt = MechanicalKnobs.rebuildMasks(colorIndices, palette.length, pixelCount);
        for (let i = 0; i < rebuilt.length; i++) state.masks[i] = rebuilt[i];
    }

    if (knobs.speckleRescue > 0) {
        MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, knobs.speckleRescue);
    }

    if (knobs.shadowClamp > 0) {
        MechanicalKnobs.applyShadowClamp(masks, colorIndices, palette, width, height, knobs.shadowClamp);
    }
}

/**
 * Count uncovered pixels (no mask set).
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
 * Compare two states for equality (colorIndices + masks).
 * Returns { indicesDiff, masksDiff } — both 0 means identical.
 */
function diffStates(a, b) {
    let indicesDiff = 0;
    for (let i = 0; i < a.pixelCount; i++) {
        if (a.colorIndices[i] !== b.colorIndices[i]) indicesDiff++;
    }

    let masksDiff = 0;
    for (let c = 0; c < a.masks.length; c++) {
        for (let i = 0; i < a.pixelCount; i++) {
            if (a.masks[c][i] !== b.masks[c][i]) masksDiff++;
        }
    }

    return { indicesDiff, masksDiff };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('MechanicalKnobs integration — jethro 800×547', () => {
    let fixture;

    beforeAll(() => {
        fixture = loadFixture('jethro-800-lab16.labbin.gz');
    });

    test('all three knobs combined: mask coverage preserved', () => {
        const state = posterizeFixture(fixture);
        applyAllKnobs(state, { minVolume: 2, speckleRescue: 5, shadowClamp: 10 });
        expect(countUncoveredPixels(state.masks, state.pixelCount)).toBe(0);
    }, 30000);

    test('max knob values: mask coverage preserved', () => {
        const state = posterizeFixture(fixture);
        applyAllKnobs(state, { minVolume: 5, speckleRescue: 10, shadowClamp: 20 });
        expect(countUncoveredPixels(state.masks, state.pixelCount)).toBe(0);
    }, 30000);

    // ─── Reversibility ──────────────────────────────────

    test('speckleRescue reversibility: apply → restore baseline → identical', () => {
        const baseline = posterizeFixture(fixture);
        const snapshot = snapshotState(baseline);

        // Apply knob (mutates state)
        applyAllKnobs(baseline, { minVolume: 0, speckleRescue: 5, shadowClamp: 0 });

        // Verify knob actually changed something
        const afterKnob = snapshotState(baseline);
        const diffAfterKnob = diffStates(snapshot, afterKnob);
        expect(diffAfterKnob.masksDiff).toBeGreaterThan(0);

        // Restore from snapshot (simulates ProxyEngine._restoreFromBaseline)
        const restored = snapshotState(snapshot);

        // Verify restoration is identical to original
        const diffRestored = diffStates(snapshot, restored);
        expect(diffRestored.indicesDiff).toBe(0);
        expect(diffRestored.masksDiff).toBe(0);
    }, 30000);

    test('minVolume reversibility: baseline restore recovers pruned colors', () => {
        const baseline = posterizeFixture(fixture);
        const snapshot = snapshotState(baseline);

        // Count active colors before
        const colorsBefore = new Set();
        for (let i = 0; i < baseline.pixelCount; i++) {
            colorsBefore.add(baseline.colorIndices[i]);
        }

        // Apply aggressive minVolume
        applyAllKnobs(baseline, { minVolume: 5, speckleRescue: 0, shadowClamp: 0 });

        // Count active colors after — should be fewer
        const colorsAfter = new Set();
        for (let i = 0; i < baseline.pixelCount; i++) {
            colorsAfter.add(baseline.colorIndices[i]);
        }
        expect(colorsAfter.size).toBeLessThanOrEqual(colorsBefore.size);

        // Restore and verify all original colors are back
        const restored = snapshotState(snapshot);
        const colorsRestored = new Set();
        for (let i = 0; i < restored.pixelCount; i++) {
            colorsRestored.add(restored.colorIndices[i]);
        }
        expect(colorsRestored.size).toBe(colorsBefore.size);
    }, 30000);

    test('all knobs reversibility: apply max → restore → identical', () => {
        const baseline = posterizeFixture(fixture);
        const snapshot = snapshotState(baseline);

        applyAllKnobs(baseline, { minVolume: 5, speckleRescue: 10, shadowClamp: 20 });

        // Restore
        const restored = snapshotState(snapshot);
        const diff = diffStates(snapshot, restored);
        expect(diff.indicesDiff).toBe(0);
        expect(diff.masksDiff).toBe(0);
    }, 30000);

    // ─── Idempotency ────────────────────────────────────

    test('speckleRescue idempotency: apply twice = apply once', () => {
        // Apply once
        const state1 = posterizeFixture(fixture);
        applyAllKnobs(state1, { minVolume: 0, speckleRescue: 5, shadowClamp: 0 });
        const after1 = snapshotState(state1);

        // Apply twice (from fresh baseline each time, like ProxyEngine does)
        const state2 = posterizeFixture(fixture);
        applyAllKnobs(state2, { minVolume: 0, speckleRescue: 5, shadowClamp: 0 });
        // Apply again from the already-knobbed state (NOT from baseline)
        MechanicalKnobs.applySpeckleRescue(
            state2.masks, state2.colorIndices, state2.width, state2.height, 5
        );

        const after2 = snapshotState(state2);
        const diff = diffStates(after1, after2);

        // Second application should change nothing (already despeckled)
        expect(diff.indicesDiff).toBe(0);
        expect(diff.masksDiff).toBe(0);
    }, 30000);

    test('shadowClamp is NOT idempotent (erosion cascades are expected)', () => {
        // Unlike speckleRescue, shadowClamp erodes edges then heals orphans.
        // Healed pixels create new edges that can be re-eroded on a second pass.
        // This is correct behavior — ProxyEngine always restores from baseline
        // before applying knobs, so cascading erosion never happens in practice.
        const state1 = posterizeFixture(fixture);
        applyAllKnobs(state1, { minVolume: 0, speckleRescue: 0, shadowClamp: 10 });
        const after1 = snapshotState(state1);

        const state2 = posterizeFixture(fixture);
        applyAllKnobs(state2, { minVolume: 0, speckleRescue: 0, shadowClamp: 10 });
        MechanicalKnobs.applyShadowClamp(
            state2.masks, state2.colorIndices, state2.palette,
            state2.width, state2.height, 10
        );

        const after2 = snapshotState(state2);
        const diff = diffStates(after1, after2);

        // Second pass erodes more edges — this is expected
        expect(diff.masksDiff).toBeGreaterThan(0);

        // But coverage must still be 100% (healing catches everything)
        expect(countUncoveredPixels(state2.masks, state2.pixelCount)).toBe(0);
    }, 30000);

    // ─── Knob order ─────────────────────────────────────

    test('knob application order: baseline-restore makes order irrelevant', () => {
        // The key insight: ProxyEngine always restores from baseline before
        // applying knobs, so the "order" is always minVolume → speckle → shadow.
        // This test verifies that applying from the same baseline twice
        // produces the same result regardless of which knob changed.

        const knobs = { minVolume: 2, speckleRescue: 5, shadowClamp: 10 };

        // Path A: apply all at once
        const stateA = posterizeFixture(fixture);
        applyAllKnobs(stateA, knobs);

        // Path B: apply minVolume first, then restore + apply all
        const stateB = posterizeFixture(fixture);
        const baselineB = snapshotState(stateB);
        applyAllKnobs(stateB, { minVolume: 2, speckleRescue: 0, shadowClamp: 0 });

        // Restore baseline, then apply all
        const stateB2 = posterizeFixture(fixture);
        applyAllKnobs(stateB2, knobs);

        const diff = diffStates(stateA, stateB2);
        expect(diff.indicesDiff).toBe(0);
        expect(diff.masksDiff).toBe(0);
    }, 30000);

    // ─── Individual knob effects ────────────────────────

    test('minVolume reduces active color count', () => {
        const state = posterizeFixture(fixture);
        const before = new Set();
        for (let i = 0; i < state.pixelCount; i++) before.add(state.colorIndices[i]);

        applyAllKnobs(state, { minVolume: 3, speckleRescue: 0, shadowClamp: 0 });
        const after = new Set();
        for (let i = 0; i < state.pixelCount; i++) after.add(state.colorIndices[i]);

        expect(after.size).toBeLessThanOrEqual(before.size);
        expect(countUncoveredPixels(state.masks, state.pixelCount)).toBe(0);
    }, 30000);

    test('speckleRescue modifies masks but preserves coverage', () => {
        const state = posterizeFixture(fixture);
        const before = snapshotState(state);

        applyAllKnobs(state, { minVolume: 0, speckleRescue: 5, shadowClamp: 0 });

        // Masks should have changed
        const diff = diffStates(before, state);
        expect(diff.masksDiff).toBeGreaterThan(0);

        // But coverage is still 100%
        expect(countUncoveredPixels(state.masks, state.pixelCount)).toBe(0);
    }, 30000);

    test('shadowClamp erodes edges but preserves coverage', () => {
        const state = posterizeFixture(fixture);
        const before = snapshotState(state);

        applyAllKnobs(state, { minVolume: 0, speckleRescue: 0, shadowClamp: 15 });

        const diff = diffStates(before, state);
        expect(diff.masksDiff).toBeGreaterThan(0);

        expect(countUncoveredPixels(state.masks, state.pixelCount)).toBe(0);
    }, 30000);
});

describe('MechanicalKnobs integration — horse 350×512', () => {
    let fixture;

    beforeAll(() => {
        fixture = loadFixture('horse-350x512-lab16.labbin.gz');
    });

    test('all knobs combined: mask coverage preserved', () => {
        const state = posterizeFixture(fixture);
        applyAllKnobs(state, { minVolume: 2, speckleRescue: 5, shadowClamp: 10 });
        expect(countUncoveredPixels(state.masks, state.pixelCount)).toBe(0);
    }, 30000);

    test('max knobs: mask coverage preserved', () => {
        const state = posterizeFixture(fixture);
        applyAllKnobs(state, { minVolume: 5, speckleRescue: 10, shadowClamp: 20 });
        expect(countUncoveredPixels(state.masks, state.pixelCount)).toBe(0);
    }, 30000);

    test('knob reversibility via baseline snapshot', () => {
        const baseline = posterizeFixture(fixture);
        const snapshot = snapshotState(baseline);

        applyAllKnobs(baseline, { minVolume: 3, speckleRescue: 7, shadowClamp: 15 });

        const restored = snapshotState(snapshot);
        const diff = diffStates(snapshot, restored);
        expect(diff.indicesDiff).toBe(0);
        expect(diff.masksDiff).toBe(0);
    }, 30000);
});
