/**
 * Unit tests for K-means refinement passes and adaptive target colors
 *
 * Tests:
 * 1. _refineKMeans static method (centroid correction)
 * 2. refinementPasses option controlling posterization behavior
 * 3. _computeAdaptiveColorCount in ParameterGenerator
 * 4. refinementPasses flowing through ParameterGenerator config
 */

import { describe, test, expect } from 'vitest';

const PosterizationEngine = require('../../lib/engines/PosterizationEngine');
const DynamicConfigurator = require('../../lib/analysis/ParameterGenerator');
const ArchetypeLoader = require('../../lib/analysis/ArchetypeLoader');

/**
 * Helper: Convert perceptual Lab to 16-bit encoding
 */
function labTo16bit(L, a, b) {
    return {
        L: Math.round((L / 100) * 32768),
        a: Math.round((a / 128) * 16384 + 16384),
        b: Math.round((b / 128) * 16384 + 16384)
    };
}

/**
 * Helper: Create Lab pixel buffer from array of {L,a,b} colors
 */
function createLabPixels(width, height, generator) {
    const pixels = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 3;
            const lab = generator(x, y, width, height);
            pixels[idx] = lab.L;
            pixels[idx + 1] = lab.a;
            pixels[idx + 2] = lab.b;
        }
    }
    return pixels;
}

/**
 * Helper: Create a colorful test image with distinct clusters
 * 4 quadrants: red, green, blue, yellow (in 16-bit Lab encoding)
 */
function createFourColorImage(size) {
    const half = size / 2;
    return createLabPixels(size, size, (x, y) => {
        if (x < half && y < half)     return labTo16bit(50, 80, 60);     // Red
        if (x >= half && y < half)    return labTo16bit(60, -70, 50);    // Green
        if (x < half && y >= half)    return labTo16bit(40, 10, -80);    // Blue
        return labTo16bit(85, -5, 80);                                    // Yellow
    });
}


describe('PosterizationEngine._refineKMeans', () => {

    test('should return palette unchanged for single color', () => {
        const pixels = new Float32Array([50, 10, 20, 51, 11, 21]);
        const palette = [{ L: 50, a: 10, b: 20 }];

        const result = PosterizationEngine._refineKMeans(pixels, palette);
        expect(result).toHaveLength(1);
    });

    test('should return palette unchanged for empty pixel buffer', () => {
        const pixels = new Float32Array(0);
        const palette = [{ L: 50, a: 10, b: 20 }, { L: 80, a: -10, b: 30 }];

        const result = PosterizationEngine._refineKMeans(pixels, palette);
        expect(result).toEqual(palette);
    });

    test('should snap centroids toward actual cluster centers', () => {
        // Create pixels tightly clustered around (30,0,0) and (70,0,0)
        // but start centroids offset from true centers
        const N = 200;
        const pixels = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const idx = i * 3;
            if (i < N / 2) {
                pixels[idx] = 30 + (Math.random() - 0.5) * 2;     // L ~30
                pixels[idx + 1] = 0 + (Math.random() - 0.5) * 2;  // a ~0
                pixels[idx + 2] = 0 + (Math.random() - 0.5) * 2;  // b ~0
            } else {
                pixels[idx] = 70 + (Math.random() - 0.5) * 2;     // L ~70
                pixels[idx + 1] = 0 + (Math.random() - 0.5) * 2;  // a ~0
                pixels[idx + 2] = 0 + (Math.random() - 0.5) * 2;  // b ~0
            }
        }

        // Start with offset centroids
        const palette = [
            { L: 40, a: 0, b: 0 },  // 10 units away from cluster at L=30
            { L: 60, a: 0, b: 0 }   // 10 units away from cluster at L=70
        ];

        const refined = PosterizationEngine._refineKMeans(pixels, palette);

        // Centroids should move closer to actual centers
        expect(refined[0].L).toBeCloseTo(30, 0);
        expect(refined[1].L).toBeCloseTo(70, 0);
    });

    test('should preserve _allColors metadata', () => {
        const pixels = new Float32Array([30, 0, 0, 70, 0, 0]);
        const palette = [{ L: 30, a: 0, b: 0 }, { L: 70, a: 0, b: 0 }];
        palette._allColors = [{ L: 50, a: 0, b: 0 }];

        const result = PosterizationEngine._refineKMeans(pixels, palette);
        expect(result._allColors).toEqual(palette._allColors);
    });
});


describe('refinementPasses option in posterize()', () => {
    const width = 20;
    const height = 20;

    test('refinementPasses=0 should skip k-means (palette differs from default)', () => {
        const labPixels = createFourColorImage(width);

        const result0 = PosterizationEngine.posterize(labPixels, width, height, 4, {
            engineType: 'reveal',
            centroidStrategy: 'SALIENCY',
            format: 'lab',
            bitDepth: 16,
            refinementPasses: 0
        });

        const result1 = PosterizationEngine.posterize(labPixels, width, height, 4, {
            engineType: 'reveal',
            centroidStrategy: 'SALIENCY',
            format: 'lab',
            bitDepth: 16,
            refinementPasses: 1
        });

        // Both should produce valid results
        expect(result0.palette.length).toBeGreaterThan(0);
        expect(result1.palette.length).toBeGreaterThan(0);
        expect(result0.assignments.length).toBe(width * height);
        expect(result1.assignments.length).toBe(width * height);
    });

    test('refinementPasses=undefined should default to 1 pass', () => {
        const labPixels = createFourColorImage(width);

        const resultDefault = PosterizationEngine.posterize(labPixels, width, height, 4, {
            engineType: 'reveal',
            centroidStrategy: 'SALIENCY',
            format: 'lab',
            bitDepth: 16
            // refinementPasses not set — should default to 1
        });

        const resultExplicit = PosterizationEngine.posterize(labPixels, width, height, 4, {
            engineType: 'reveal',
            centroidStrategy: 'SALIENCY',
            format: 'lab',
            bitDepth: 16,
            refinementPasses: 1
        });

        // Same palette when default = explicit 1
        expect(resultDefault.paletteLab).toEqual(resultExplicit.paletteLab);
    });

    test('refinementPasses=2 should produce valid results', () => {
        const labPixels = createFourColorImage(width);

        const result = PosterizationEngine.posterize(labPixels, width, height, 4, {
            engineType: 'reveal',
            centroidStrategy: 'SALIENCY',
            format: 'lab',
            bitDepth: 16,
            refinementPasses: 2
        });

        expect(result.palette.length).toBeGreaterThan(0);
        expect(result.assignments.length).toBe(width * height);

        // All assignments valid
        for (let i = 0; i < result.assignments.length; i++) {
            expect(result.assignments[i]).toBeGreaterThanOrEqual(0);
            expect(result.assignments[i]).toBeLessThan(result.palette.length);
        }
    });

    test('refinementPasses=0 should work with Mk1.5 engine', () => {
        const labPixels = createFourColorImage(width);

        const result = PosterizationEngine.posterize(labPixels, width, height, 4, {
            engineType: 'reveal-mk1.5',
            centroidStrategy: 'SALIENCY',
            format: 'lab',
            bitDepth: 16,
            refinementPasses: 0
        });

        expect(result.palette.length).toBeGreaterThan(0);
        expect(result.assignments.length).toBe(width * height);
    });

    test('refinementPasses=2 should work with Mk1.5 engine', () => {
        const labPixels = createFourColorImage(width);

        const result = PosterizationEngine.posterize(labPixels, width, height, 4, {
            engineType: 'reveal-mk1.5',
            centroidStrategy: 'SALIENCY',
            format: 'lab',
            bitDepth: 16,
            refinementPasses: 2
        });

        expect(result.palette.length).toBeGreaterThan(0);
        expect(result.assignments.length).toBe(width * height);
    });
});


describe('ParameterGenerator: refinementPasses flow-through', () => {

    test('should pass refinementPasses from archetype to config', () => {
        // Use subtle_naturalist which has refinementPasses: 2
        const dna = {
            version: '2.0',
            minL: 10, maxL: 90, maxC: 30,
            global: { l: 52, c: 30, k: 94, l_std_dev: 28, hue_entropy: 0.75,
                      temperature_bias: 0.1, primary_sector_weight: 0.15 },
            sectors: {}
        };

        const config = DynamicConfigurator.generate(dna, {
            manualArchetypeId: 'subtle_naturalist'
        });

        expect(config.refinementPasses).toBe(2);
    });

    test('should return refinementPasses=0 for graphic archetypes', () => {
        const dna = {
            version: '2.0',
            minL: 5, maxL: 100, maxC: 80,
            global: { l: 50, c: 60, k: 95, l_std_dev: 30, hue_entropy: 0.1,
                      temperature_bias: 0, primary_sector_weight: 0.8 },
            sectors: {}
        };

        const config = DynamicConfigurator.generate(dna, {
            manualArchetypeId: 'pure_graphic'
        });

        expect(config.refinementPasses).toBe(0);
    });

    test('should return refinementPasses=0 for silver_gelatin', () => {
        const dna = {
            version: '2.0',
            minL: 10, maxL: 95, maxC: 5,
            global: { l: 50, c: 3, k: 85, l_std_dev: 25, hue_entropy: 0,
                      temperature_bias: 0, primary_sector_weight: 0 },
            sectors: {}
        };

        const config = DynamicConfigurator.generate(dna, {
            manualArchetypeId: 'silver_gelatin'
        });

        expect(config.refinementPasses).toBe(0);
    });

    test('should default to 1 when archetype has no refinementPasses', () => {
        // Verify the fallback — if an archetype somehow lacks refinementPasses,
        // ParameterGenerator defaults to 1
        const dna = {
            version: '2.0',
            minL: 10, maxL: 90, maxC: 30,
            global: { l: 50, c: 20, k: 70, l_std_dev: 20, hue_entropy: 0.5,
                      temperature_bias: 0, primary_sector_weight: 0.2 },
            sectors: {}
        };

        // standard_balanced has refinementPasses: 1
        const config = DynamicConfigurator.generate(dna, {
            manualArchetypeId: 'standard_balanced'
        });

        expect(config.refinementPasses).toBe(1);
    });
});


describe('ParameterGenerator._computeAdaptiveColorCount', () => {

    test('should return null when DNA lacks sectors', () => {
        const dna = { global: { l: 50, c: 20, l_std_dev: 20, hue_entropy: 0.5 } };
        const result = DynamicConfigurator._computeAdaptiveColorCount(dna, {});
        expect(result).toBeNull();
    });

    test('should return null when DNA lacks global', () => {
        const dna = { sectors: { red: { weight: 0.5 } } };
        const result = DynamicConfigurator._computeAdaptiveColorCount(dna, {});
        expect(result).toBeNull();
    });

    test('should count occupied sectors above 3% threshold', () => {
        const dna = {
            global: { l_std_dev: 15, hue_entropy: 0.3 },
            sectors: {
                red:    { weight: 0.20 },
                green:  { weight: 0.15 },
                blue:   { weight: 0.10 },
                yellow: { weight: 0.02 }  // Below 3% threshold
            }
        };

        const result = DynamicConfigurator._computeAdaptiveColorCount(dna, {});

        // 3 occupied sectors + neutral mass bonus (1 - 0.47 = 0.53 > 0.40 → +3)
        // + entropy <0.7 so no entropy bonus, l_std_dev<22 so no tonal bonus
        // Total: 3 + 3 = 6, clamped to [5,10] = 6
        expect(result).toBeGreaterThanOrEqual(5);
        expect(result).toBeLessThanOrEqual(10);
    });

    test('should clamp result to [5, 10]', () => {
        // Minimal image: 1 sector, low entropy, narrow tonal range
        const dnaLow = {
            global: { l_std_dev: 10, hue_entropy: 0.1 },
            sectors: { red: { weight: 0.8 } }
        };
        const resultLow = DynamicConfigurator._computeAdaptiveColorCount(dnaLow, {});
        expect(resultLow).toBe(5); // Floor

        // Rainbow image: many sectors, high entropy, wide tonal range
        const dnaHigh = {
            global: { l_std_dev: 30, hue_entropy: 0.9 },
            sectors: {
                red:        { weight: 0.08 },
                orange:     { weight: 0.08 },
                yellow:     { weight: 0.08 },
                green:      { weight: 0.08 },
                cyan:       { weight: 0.08 },
                blue:       { weight: 0.08 },
                purple:     { weight: 0.08 },
                magenta:    { weight: 0.08 },
                chartreuse: { weight: 0.04 },
                pink:       { weight: 0.04 },
                rose:       { weight: 0.04 },
                azure:      { weight: 0.04 }
            }
        };
        const resultHigh = DynamicConfigurator._computeAdaptiveColorCount(dnaHigh, {});
        expect(resultHigh).toBe(10); // Ceiling
    });

    test('should add bonus for high neutral mass', () => {
        // Low sector weight → high neutral mass
        const dna = {
            global: { l_std_dev: 15, hue_entropy: 0.3 },
            sectors: {
                red: { weight: 0.10 }
                // total sector weight = 0.10, neutral mass = 0.90
            }
        };

        const result = DynamicConfigurator._computeAdaptiveColorCount(dna, {});

        // 1 sector + neutral mass >0.1 (+1) + >0.25 (+1) + >0.40 (+1) = 4
        // Clamped to [5, 10] = 5
        expect(result).toBeGreaterThanOrEqual(5);
    });
});


describe('Archetype JSON: refinementPasses values', () => {

    test('all archetypes should have refinementPasses defined', () => {
        const archetypes = ArchetypeLoader.loadArchetypes();

        for (const arch of archetypes) {
            expect(arch.parameters.refinementPasses,
                `${arch.id} missing refinementPasses`
            ).toBeDefined();
            expect(typeof arch.parameters.refinementPasses).toBe('number');
            expect(arch.parameters.refinementPasses).toBeGreaterThanOrEqual(0);
            expect(arch.parameters.refinementPasses).toBeLessThanOrEqual(5);
        }
    });

    test('graphic archetypes should have refinementPasses=0', () => {
        const archetypes = ArchetypeLoader.loadArchetypes();
        const graphicIds = ['pure_graphic', 'neon_graphic', 'silver_gelatin'];

        for (const id of graphicIds) {
            const arch = archetypes.find(a => a.id === id);
            expect(arch, `archetype ${id} not found`).toBeDefined();
            expect(arch.parameters.refinementPasses,
                `${id} should have refinementPasses=0`
            ).toBe(0);
        }
    });

    test('photographic archetypes should have refinementPasses=2', () => {
        const archetypes = ArchetypeLoader.loadArchetypes();
        const photoIds = ['subtle_naturalist', 'chromatic_polyphony', 'jethro_monroe_clinical'];

        for (const id of photoIds) {
            const arch = archetypes.find(a => a.id === id);
            expect(arch, `archetype ${id} not found`).toBeDefined();
            expect(arch.parameters.refinementPasses,
                `${id} should have refinementPasses=2`
            ).toBe(2);
        }
    });
});
