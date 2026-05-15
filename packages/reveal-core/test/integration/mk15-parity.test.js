import { describe, test, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { PosterizationEngine, PipelineEngine, EngineBuilder, EngineRegistry } = require('../../index').engines;

/**
 * MVP parity bar: the declaratively-defined Mk1.5 engine
 * (engines/reveal-mk1.5-reference.json executed by the Engineer's PipelineEngine)
 * should produce a palette within ΔE76 < 3.0 of the in-code Mk1.5 engine
 * (PosterizationEngine.posterize with engineType:'reveal-mk1.5').

 *
 * Project parity criterion per dev/MATHEMATICAL_PARITY.md: ΔE76 < 3.0.
 * Bit-identical is not the target — reveal-core has internal optimizations
 * (snap-threshold cache, spatial locality cache) that the declarative pipeline
 * doesn't replicate.
 */

function loadHorseFixture() {
    const gz = fs.readFileSync(path.join(__dirname, '../fixtures/horse-350x512-lab16.labbin.gz'));
    const raw = zlib.gunzipSync(gz);
    const width = raw.readUInt32LE(4);
    const height = raw.readUInt32LE(8);
    const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);
    return { pixels, width, height };
}

function deltaE76(c1, c2) {
    const dL = c1.L - c2.L;
    const da = c1.a - c2.a;
    const db = c1.b - c2.b;
    return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Greedy nearest-neighbor pairing. For each color in `a`, find its closest match
 * in `b` (without consuming). Returns array of per-color min ΔE76 distances.
 * This is the loose matcher recommended by MATHEMATICAL_PARITY.md.
 */
function matchPalettes(a, b) {
    return a.map(ca => Math.min(...b.map(cb => deltaE76(ca, cb))));
}

describe('Mk1.5 declarative vs in-code parity', () => {
    const { pixels, width, height } = loadHorseFixture();
    const targetColors = 8;

    test('declarative engine def loads and hydrates', () => {
        const def = EngineRegistry.get('reveal-mk1.5-reference');
        expect(def).toBeTruthy();
        expect(def.id).toBe('reveal-mk1.5-reference');
        expect(Array.isArray(def.steps)).toBe(true);

        const hydrated = EngineBuilder.build(def, null);
        expect(hydrated.steps.length).toBeGreaterThan(0);
    });

    test('in-code Mk1.5 produces a non-trivial palette', () => {
        const result = PosterizationEngine.posterize(pixels, width, height, targetColors, {
            engineType: 'reveal-mk1.5',
            format: 'lab',
            bitDepth: 16
        });
        expect(result.paletteLab.length).toBeGreaterThan(0);
        expect(result.paletteLab.length).toBeLessThanOrEqual(targetColors + 2);
    });

    test('declarative Mk1.5 produces a non-trivial palette', async () => {
        const def = EngineRegistry.get('reveal-mk1.5-reference');
        const hydrated = EngineBuilder.build(def, null);
        const result = await PipelineEngine.executeAsync(pixels, hydrated, {
            width,
            height,
            targetColors
        });
        expect(Array.isArray(result.palette)).toBe(true);
        expect(result.palette.length).toBeGreaterThan(0);
    });

    test('palettes match within ΔE76 < 3.0 (mean) — MVP parity bar', async () => {
        // In-code
        const incode = PosterizationEngine.posterize(pixels, width, height, targetColors, {
            engineType: 'reveal-mk1.5',
            format: 'lab',
            bitDepth: 16
        });
        const incodePalette = incode.paletteLab;

        // Declarative
        const def = EngineRegistry.get('reveal-mk1.5-reference');
        const hydrated = EngineBuilder.build(def, null);
        const declRes = await PipelineEngine.executeAsync(pixels, hydrated, {
            width,
            height,
            targetColors
        });
        const declPalette = declRes.palette;

        // Greedy match each way and take the worse direction (symmetric).
        const distsA = matchPalettes(incodePalette, declPalette);
        const distsB = matchPalettes(declPalette, incodePalette);
        const meanA = distsA.reduce((s, x) => s + x, 0) / distsA.length;
        const meanB = distsB.reduce((s, x) => s + x, 0) / distsB.length;
        const meanDeltaE = Math.max(meanA, meanB);
        const maxDeltaE = Math.max(...distsA, ...distsB);

        console.log(`[Mk1.5 parity] in-code palette (${incodePalette.length}):`,
            incodePalette.map(c => `(${c.L.toFixed(1)},${c.a.toFixed(1)},${c.b.toFixed(1)})`).join(' '));
        console.log(`[Mk1.5 parity] declarative palette (${declPalette.length}):`,
            declPalette.map(c => `(${c.L.toFixed(1)},${c.a.toFixed(1)},${c.b.toFixed(1)})`).join(' '));
        console.log(`[Mk1.5 parity] mean ΔE76 = ${meanDeltaE.toFixed(2)}, max ΔE76 = ${maxDeltaE.toFixed(2)}`);

        expect(meanDeltaE).toBeLessThan(3.0);
    });
});
