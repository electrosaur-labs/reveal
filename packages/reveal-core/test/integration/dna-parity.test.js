import { describe, test, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DNAGenerator = require('../../lib/analysis/DNAGenerator');

/**
 * DNA Parity Test
 *
 * Ensures batch processor and Navigator UI produce identical DNA
 * when given the same pixel data. Both paths now use DNAGenerator.fromPixels()
 * on 16-bit Lab data.
 *
 * This test exists because batch previously used a local calculateImageDNA()
 * that sampled every 40th pixel on 8-bit data, diverging from the canonical
 * DNAGenerator which processes every pixel on 16-bit data.
 */

function loadHorseFixture() {
    const gz = fs.readFileSync(path.join(__dirname, '../fixtures/horse-350x512-lab16.labbin.gz'));
    const raw = zlib.gunzipSync(gz);
    const width = raw.readUInt32LE(4);
    const height = raw.readUInt32LE(8);
    const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);
    return { pixels, width, height };
}

describe('DNA parity — batch vs Navigator', () => {
    const { pixels, width, height } = loadHorseFixture();

    test('DNAGenerator.fromPixels produces valid v2.0 structure', () => {
        const dna = DNAGenerator.fromPixels(pixels, width, height, { bitDepth: 16 });

        expect(dna.version).toBe('2.0');
        expect(dna.global).toBeDefined();
        expect(dna.global.l).toBeGreaterThan(0);
        expect(dna.global.c).toBeGreaterThan(0);
        expect(dna.global.k).toBeGreaterThan(0);
        expect(dna.global.l_std_dev).toBeGreaterThan(0);
        expect(dna.global.hue_entropy).toBeGreaterThanOrEqual(0);
        expect(dna.global.hue_entropy).toBeLessThanOrEqual(1);
        expect(dna.global.temperature_bias).toBeGreaterThanOrEqual(-1);
        expect(dna.global.temperature_bias).toBeLessThanOrEqual(1);
        expect(dna.global.primary_sector_weight).toBeGreaterThan(0);
        expect(dna.dominant_sector).toBeTruthy();
        expect(Object.keys(dna.sectors)).toHaveLength(12);
    });

    test('identical input produces identical DNA (deterministic)', () => {
        const dna1 = DNAGenerator.fromPixels(pixels, width, height, { bitDepth: 16 });
        const dna2 = DNAGenerator.fromPixels(pixels, width, height, { bitDepth: 16 });

        expect(dna1.global).toEqual(dna2.global);
        expect(dna1.dominant_sector).toBe(dna2.dominant_sector);
        expect(dna1.sectors).toEqual(dna2.sectors);
    });

    test('Navigator path (instance) matches batch path (static)', () => {
        // Navigator uses: new DNAGenerator().generate(labPixels, w, h, { bitDepth: 16 })
        const gen = new DNAGenerator();
        const navigatorDna = gen.generate(pixels, width, height, { bitDepth: 16 });

        // Batch uses: DNAGenerator.fromPixels(lab16bit, w, h, { bitDepth: 16 })
        const batchDna = DNAGenerator.fromPixels(pixels, width, height, { bitDepth: 16 });

        // Must be byte-identical
        expect(batchDna.global).toEqual(navigatorDna.global);
        expect(batchDna.dominant_sector).toBe(navigatorDna.dominant_sector);
        expect(batchDna.sectors).toEqual(navigatorDna.sectors);
    });

    test('8-bit round-trip produces similar DNA (quantization tolerance)', () => {
        // Simulate batch conversion: 16-bit Lab → 8-bit Lab → back to 16-bit
        const pixelCount = width * height;
        const lab8bit = new Uint8Array(pixelCount * 3);

        // 16-bit to 8-bit conversion (matches batch converter)
        for (let i = 0; i < pixelCount * 3; i += 3) {
            // L: 0-32768 → 0-255
            lab8bit[i] = Math.round((pixels[i] / 32768) * 255);
            // a/b: 0-32768 (16384=neutral) → 0-255 (128=neutral)
            lab8bit[i + 1] = Math.round(((pixels[i + 1] - 16384) / 128) + 128);
            lab8bit[i + 2] = Math.round(((pixels[i + 2] - 16384) / 128) + 128);
        }

        // 8-bit back to 16-bit (matches batch convert8bitTo16bitLab)
        const lab16rt = new Uint16Array(pixelCount * 3);
        for (let i = 0; i < pixelCount * 3; i += 3) {
            lab16rt[i] = Math.round((lab8bit[i] / 255) * 32768);
            lab16rt[i + 1] = Math.round((lab8bit[i + 1] - 128) * 128 + 16384);
            lab16rt[i + 2] = Math.round((lab8bit[i + 2] - 128) * 128 + 16384);
        }

        const dnaDirect = DNAGenerator.fromPixels(pixels, width, height, { bitDepth: 16 });
        const dnaRoundTrip = DNAGenerator.fromPixels(lab16rt, width, height, { bitDepth: 16 });

        // Round-trip quantization loses precision, but core metrics should be close
        expect(dnaRoundTrip.global.l).toBeCloseTo(dnaDirect.global.l, 0); // within 1
        expect(dnaRoundTrip.global.c).toBeCloseTo(dnaDirect.global.c, 0);
        expect(dnaRoundTrip.global.k).toBeCloseTo(dnaDirect.global.k, 0);
        expect(dnaRoundTrip.global.l_std_dev).toBeCloseTo(dnaDirect.global.l_std_dev, 0);
        expect(dnaRoundTrip.dominant_sector).toBe(dnaDirect.dominant_sector);
    });
});
