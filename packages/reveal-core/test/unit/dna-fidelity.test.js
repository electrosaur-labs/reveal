/**
 * DNAFidelity - Unit tests
 */

import { describe, it, expect } from 'vitest';
const DNAFidelity = require('../../lib/metrics/DNAFidelity');
const DNAGenerator = require('../../lib/analysis/DNAGenerator');

// ── Helpers ──

/** Build a minimal DNA v2.0 object with given global overrides */
function makeDNA(globalOverrides = {}, sectorOverrides = {}) {
    const sectors = {};
    const sectorNames = [
        'red', 'orange', 'yellow', 'chartreuse', 'green', 'cyan',
        'azure', 'blue', 'purple', 'magenta', 'pink', 'rose'
    ];
    for (const name of sectorNames) {
        sectors[name] = { weight: 0, lMean: 0, cMean: 0, cMax: 0 };
    }
    // Apply sector overrides
    for (const [name, props] of Object.entries(sectorOverrides)) {
        if (sectors[name]) Object.assign(sectors[name], props);
    }

    return {
        version: '2.0',
        global: {
            l: 50, c: 15, k: 70, l_std_dev: 20,
            hue_entropy: 0.5, temperature_bias: 0, primary_sector_weight: 0.3,
            ...globalOverrides
        },
        dominant_sector: 'red',
        sectors,
        metadata: { width: 100, height: 100, totalPixels: 10000, bitDepth: 16 }
    };
}

describe('DNAFidelity', () => {

    describe('compare()', () => {

        it('should return fidelity 100 for identical DNAs', () => {
            const dna = makeDNA();
            const result = DNAFidelity.compare(dna, dna);

            expect(result.fidelity).toBe(100);
            expect(result.alerts).toHaveLength(0);
            expect(result.sectorDrift).toBe(0);
        });

        it('should return per-dimension deltas', () => {
            const input = makeDNA({ l: 50, c: 10 });
            const output = makeDNA({ l: 55, c: 18 });
            const result = DNAFidelity.compare(input, output);

            expect(result.global.l.input).toBe(50);
            expect(result.global.l.output).toBe(55);
            expect(result.global.l.delta).toBe(5);
            expect(result.global.c.delta).toBe(8);
        });

        it('should reduce fidelity for significant drift', () => {
            const input = makeDNA({ l: 50, c: 10, l_std_dev: 25 });
            const output = makeDNA({ l: 70, c: 30, l_std_dev: 10 });
            const result = DNAFidelity.compare(input, output);

            expect(result.fidelity).toBeLessThan(80);
            expect(result.fidelity).toBeGreaterThan(0);
        });

        it('should trigger chroma drift alert when |Δc| > 5', () => {
            const input = makeDNA({ c: 5 });
            const output = makeDNA({ c: 15 });
            const result = DNAFidelity.compare(input, output);

            expect(result.alerts.some(a => a.includes('Chroma drift'))).toBe(true);
        });

        it('should not trigger chroma drift alert for small Δc', () => {
            const input = makeDNA({ c: 10 });
            const output = makeDNA({ c: 13 });
            const result = DNAFidelity.compare(input, output);

            expect(result.alerts.some(a => a.includes('Chroma drift'))).toBe(false);
        });

        it('should trigger entropy collapse alert', () => {
            const input = makeDNA({ hue_entropy: 0.8 });
            const output = makeDNA({ hue_entropy: 0.3 });  // Δ = -0.5, threshold = -0.40
            const result = DNAFidelity.compare(input, output);

            expect(result.alerts.some(a => a.includes('Entropy collapse'))).toBe(true);
        });

        it('should trigger temperature shift alert', () => {
            const input = makeDNA({ temperature_bias: 0.1 });
            const output = makeDNA({ temperature_bias: -0.8 });  // |Δ| = 0.9, threshold = 0.8
            const result = DNAFidelity.compare(input, output);

            expect(result.alerts.some(a => a.includes('Temperature shift'))).toBe(true);
        });

        it('should trigger contrast loss alert', () => {
            const input = makeDNA({ l_std_dev: 25 });
            const output = makeDNA({ l_std_dev: 18 });
            const result = DNAFidelity.compare(input, output);

            expect(result.alerts.some(a => a.includes('Contrast loss'))).toBe(true);
        });

        it('should trigger ink imbalance alert', () => {
            const input = makeDNA({ primary_sector_weight: 0.3 });
            const output = makeDNA({ primary_sector_weight: 0.55 });  // Δ = +0.25, threshold = 0.20
            const result = DNAFidelity.compare(input, output);

            expect(result.alerts.some(a => a.includes('Ink imbalance'))).toBe(true);
        });

        it('should compute sector drift', () => {
            const input = makeDNA({}, {
                red: { weight: 0.2 },
                blue: { weight: 0.3 }
            });
            const output = makeDNA({}, {
                red: { weight: 0.05 },
                blue: { weight: 0.45 }
            });
            const result = DNAFidelity.compare(input, output);

            // |0.05-0.2| + |0.45-0.3| = 0.15 + 0.15 = 0.30
            expect(result.sectorDrift).toBeGreaterThan(0.29);
        });

        it('should trigger sector redistribution alert for high drift', () => {
            const input = makeDNA({}, {
                red: { weight: 0.5 },
                blue: { weight: 0.3 },
                green: { weight: 0.1 },
                yellow: { weight: 0.1 }
            });
            const output = makeDNA({}, {
                red: { weight: 0.05 },
                blue: { weight: 0.65 },
                green: { weight: 0.3 },
                yellow: { weight: 0.0 }
            });
            // drift = |0.05-0.5| + |0.65-0.3| + |0.3-0.1| + |0-0.1| = 0.45+0.35+0.2+0.1 = 1.1
            // threshold = 1.0
            const result = DNAFidelity.compare(input, output);

            expect(result.alerts.some(a => a.includes('Sector redistribution'))).toBe(true);
        });

        it('should handle null/undefined DNA gracefully', () => {
            const result1 = DNAFidelity.compare(null, makeDNA());
            expect(result1.fidelity).toBe(100);
            expect(result1.alerts).toHaveLength(0);

            const result2 = DNAFidelity.compare(makeDNA(), null);
            expect(result2.fidelity).toBe(100);
        });
    });

    describe('fromIndices()', () => {

        it('should produce fidelity 100 for a perfect posterization', () => {
            // Create a small image where all pixels are the same color
            const width = 4, height = 4;
            const palette = [
                { L: 50, a: 20, b: -10 },
                { L: 80, a: -5, b: 30 }
            ];

            // Build perceptual Lab pixels matching palette[0] exactly
            const pixelCount = width * height;
            const labPixels = new Float32Array(pixelCount * 3);
            const colorIndices = new Uint8Array(pixelCount);

            for (let i = 0; i < pixelCount; i++) {
                const ci = i < pixelCount / 2 ? 0 : 1;
                colorIndices[i] = ci;
                const off = i * 3;
                labPixels[off]     = palette[ci].L;
                labPixels[off + 1] = palette[ci].a;
                labPixels[off + 2] = palette[ci].b;
            }

            // Generate "input" DNA from the same buffer (already posterized)
            const gen = new DNAGenerator();
            const inputDNA = gen.generate(labPixels, width, height, { bitDepth: 'perceptual' });

            const result = DNAFidelity.fromIndices(inputDNA, colorIndices, palette, width, height);

            expect(result.fidelity).toBe(100);
            expect(result.alerts).toHaveLength(0);
        });

        it('should detect chroma drift when neutral pixels map to chromatic palette', () => {
            // Input: all neutral pixels (L=50, a=0, b=0)
            const width = 10, height = 10;
            const pixelCount = width * height;
            const labPixels = new Float32Array(pixelCount * 3);
            for (let i = 0; i < pixelCount; i++) {
                labPixels[i * 3]     = 50;
                labPixels[i * 3 + 1] = 0;   // neutral a
                labPixels[i * 3 + 2] = 0;   // neutral b
            }

            const gen = new DNAGenerator();
            const inputDNA = gen.generate(labPixels, width, height, { bitDepth: 'perceptual' });

            // Posterization maps all pixels to a chromatic color
            const colorIndices = new Uint8Array(pixelCount).fill(0);
            const palette = [{ L: 50, a: 30, b: 20 }]; // chromatic

            const result = DNAFidelity.fromIndices(inputDNA, colorIndices, palette, width, height);

            // Output DNA should have higher chroma than input → chroma drift
            expect(result.global.c.delta).toBeGreaterThan(5);
            expect(result.alerts.some(a => a.includes('Chroma drift'))).toBe(true);
            expect(result.fidelity).toBeLessThan(90);
        });

        it('should detect entropy collapse when multiple hues merge to one', () => {
            // Input: diverse hues spread across sectors
            const width = 12, height = 1;
            const labPixels = new Float32Array(12 * 3);
            // 12 pixels, each in a different hue sector (chroma = 30)
            const hueAngles = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
            for (let i = 0; i < 12; i++) {
                const rad = hueAngles[i] * Math.PI / 180;
                labPixels[i * 3]     = 50;
                labPixels[i * 3 + 1] = 30 * Math.cos(rad); // a
                labPixels[i * 3 + 2] = 30 * Math.sin(rad); // b
            }

            const gen = new DNAGenerator();
            const inputDNA = gen.generate(labPixels, width, height, { bitDepth: 'perceptual' });

            // Posterization collapses all to single red
            const colorIndices = new Uint8Array(12).fill(0);
            const palette = [{ L: 50, a: 30, b: 0 }]; // all red

            const result = DNAFidelity.fromIndices(inputDNA, colorIndices, palette, width, height);

            // Entropy should drop dramatically
            expect(result.global.hue_entropy.delta).toBeLessThan(0);
            expect(result.fidelity).toBeLessThan(80);
        });
    });

    describe('DNAGenerator.fromIndices()', () => {

        it('should generate valid DNA v2.0 structure', () => {
            const colorIndices = new Uint8Array([0, 1, 0, 1]);
            const palette = [
                { L: 30, a: 10, b: -20 },
                { L: 70, a: -15, b: 25 }
            ];

            const dna = DNAGenerator.fromIndices(colorIndices, palette, 2, 2);

            expect(dna.version).toBe('2.0');
            expect(dna.global).toBeDefined();
            expect(dna.global.l).toBeGreaterThan(0);
            expect(dna.global.c).toBeGreaterThan(0);
            expect(dna.sectors).toBeDefined();
            expect(dna.metadata.width).toBe(2);
            expect(dna.metadata.height).toBe(2);
        });

        it('should produce correct global L for uniform palette', () => {
            const colorIndices = new Uint8Array([0, 0, 0, 0]);
            const palette = [{ L: 60, a: 0, b: 0 }];

            const dna = DNAGenerator.fromIndices(colorIndices, palette, 2, 2);

            expect(dna.global.l).toBeCloseTo(60, 0);
        });
    });
});
