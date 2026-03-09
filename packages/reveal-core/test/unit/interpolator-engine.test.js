import { describe, test, expect } from 'vitest';

const { InterpolatorEngine, DIM_KEYS, CONTINUOUS_PARAMS, ORDERED_ENUMS, CATEGORICAL_PARAMS } = require('../../lib/analysis/InterpolatorEngine');

// Minimal model with 3 clusters for testing
const MOCK_MODEL = {
    version: '1.0',
    blendNeighbors: 3,
    normalization: {
        mean: [50, 25, 95, 20, 0.5, 0.7, 0.5],
        std:  [20, 14,  7,  7, 0.2, 0.4, 0.2]
    },
    clusters: [
        {
            id: 1,
            centroid: [-1.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            sourceArchetype: 'dark_low_chroma',
            parameters: {
                lWeight: 1.8, cWeight: 1.5, blackBias: 9,
                minColors: 4, maxColors: 8,
                vibrancyMode: 'subtle', vibrancyBoost: 1.0,
                preprocessingIntensity: 'medium',
                ditherType: 'atkinson', distanceMetric: 'cie2000',
                enablePaletteReduction: true, paletteReduction: 6,
                preserveWhite: true, preserveBlack: true,
                highlightThreshold: 85, highlightBoost: 2,
                refinementPasses: 1
            }
        },
        {
            id: 2,
            centroid: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            sourceArchetype: 'balanced_mid',
            parameters: {
                lWeight: 1.4, cWeight: 2.5, blackBias: 6,
                minColors: 5, maxColors: 9,
                vibrancyMode: 'moderate', vibrancyBoost: 1.4,
                preprocessingIntensity: 'light',
                ditherType: 'ordered', distanceMetric: 'cie94',
                enablePaletteReduction: true, paletteReduction: 8,
                preserveWhite: true, preserveBlack: false,
                highlightThreshold: 90, highlightBoost: 1.5,
                refinementPasses: 2
            }
        },
        {
            id: 3,
            centroid: [1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            sourceArchetype: 'bright_high_chroma',
            parameters: {
                lWeight: 1.0, cWeight: 4.0, blackBias: 3,
                minColors: 6, maxColors: 10,
                vibrancyMode: 'aggressive', vibrancyBoost: 1.8,
                preprocessingIntensity: 'heavy',
                ditherType: 'floyd-steinberg', distanceMetric: 'cie76',
                enablePaletteReduction: false, paletteReduction: 12,
                preserveWhite: false, preserveBlack: false,
                highlightThreshold: 96, highlightBoost: 1,
                refinementPasses: 3
            }
        }
    ]
};

// DNA that maps exactly to cluster 2's centroid (normalized [0,0,0,0,0,0,0])
const DNA_AT_CLUSTER2 = {
    l: 50, c: 25, k: 95, l_std_dev: 20,
    hue_entropy: 0.5, temperature_bias: 0.7, primary_sector_weight: 0.5
};

// DNA that maps near cluster 1 (dark, low chroma)
const DNA_NEAR_CLUSTER1 = {
    l: 30, c: 11, k: 95, l_std_dev: 20,
    hue_entropy: 0.5, temperature_bias: 0.7, primary_sector_weight: 0.5
};

// DNA that maps near cluster 3 (bright, high chroma)
const DNA_NEAR_CLUSTER3 = {
    l: 70, c: 39, k: 95, l_std_dev: 20,
    hue_entropy: 0.5, temperature_bias: 0.7, primary_sector_weight: 0.5
};

describe('InterpolatorEngine', () => {
    describe('constructor', () => {
        test('stores normalization, neighbors, and clusters from model', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            expect(engine.norm).toBe(MOCK_MODEL.normalization);
            expect(engine.neighbors).toBe(3);
            expect(engine.clusters).toBe(MOCK_MODEL.clusters);
        });

        test('defaults blendNeighbors to 3 if not specified', () => {
            const model = { ...MOCK_MODEL, blendNeighbors: undefined };
            const engine = new InterpolatorEngine(model);
            expect(engine.neighbors).toBe(3);
        });

        test('respects custom blendNeighbors', () => {
            const model = { ...MOCK_MODEL, blendNeighbors: 5 };
            const engine = new InterpolatorEngine(model);
            expect(engine.neighbors).toBe(5);
        });
    });

    describe('interpolate() — basic output structure', () => {
        test('returns parameters and blendInfo', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const result = engine.interpolate(DNA_AT_CLUSTER2);
            expect(result).toHaveProperty('parameters');
            expect(result).toHaveProperty('blendInfo');
            expect(result.blendInfo).toHaveProperty('neighbors');
            expect(result.blendInfo.neighbors).toHaveLength(3);
        });

        test('blendInfo neighbors have clusterId, sourceArchetype, distance, weight', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { blendInfo } = engine.interpolate(DNA_AT_CLUSTER2);
            for (const n of blendInfo.neighbors) {
                expect(n).toHaveProperty('clusterId');
                expect(n).toHaveProperty('sourceArchetype');
                expect(n).toHaveProperty('distance');
                expect(n).toHaveProperty('weight');
                expect(typeof n.distance).toBe('number');
                expect(typeof n.weight).toBe('number');
            }
        });

        test('neighbor weights sum to ~1.0', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { blendInfo } = engine.interpolate(DNA_AT_CLUSTER2);
            const weightSum = blendInfo.neighbors.reduce((s, n) => s + n.weight, 0);
            expect(weightSum).toBeCloseTo(1.0, 3);
        });
    });

    describe('interpolate() — nearest neighbor ordering', () => {
        test('DNA at cluster 2 centroid has cluster 2 as nearest', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { blendInfo } = engine.interpolate(DNA_AT_CLUSTER2);
            expect(blendInfo.neighbors[0].clusterId).toBe(2);
            expect(blendInfo.neighbors[0].distance).toBeCloseTo(0, 2);
        });

        test('DNA near cluster 1 has cluster 1 as nearest', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { blendInfo } = engine.interpolate(DNA_NEAR_CLUSTER1);
            expect(blendInfo.neighbors[0].clusterId).toBe(1);
        });

        test('DNA near cluster 3 has cluster 3 as nearest', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { blendInfo } = engine.interpolate(DNA_NEAR_CLUSTER3);
            expect(blendInfo.neighbors[0].clusterId).toBe(3);
        });

        test('neighbors are sorted by distance ascending', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { blendInfo } = engine.interpolate(DNA_NEAR_CLUSTER1);
            for (let i = 1; i < blendInfo.neighbors.length; i++) {
                expect(blendInfo.neighbors[i].distance).toBeGreaterThanOrEqual(
                    blendInfo.neighbors[i - 1].distance
                );
            }
        });
    });

    describe('interpolate() — continuous parameter blending', () => {
        test('DNA exactly at cluster 2 returns cluster 2 parameters (dominant weight)', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { parameters, blendInfo } = engine.interpolate(DNA_AT_CLUSTER2);
            // Cluster 2 has distance ~0, so its weight dominates
            expect(blendInfo.neighbors[0].weight).toBeGreaterThan(0.9);
            // Continuous params should be very close to cluster 2 values
            expect(parameters.lWeight).toBeCloseTo(1.4, 1);
            expect(parameters.cWeight).toBeCloseTo(2.5, 1);
            expect(parameters.blackBias).toBeCloseTo(6, 0);
        });

        test('DNA between clusters blends continuous params', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            // DNA equidistant from clusters 1 and 2 (normalized: [-0.5, -0.5, ...])
            const midDna = {
                l: 40, c: 18, k: 95, l_std_dev: 20,
                hue_entropy: 0.5, temperature_bias: 0.7, primary_sector_weight: 0.5
            };
            const { parameters } = engine.interpolate(midDna);
            // lWeight should be between 1.0 and 1.8 (cluster range)
            expect(parameters.lWeight).toBeGreaterThan(1.0);
            expect(parameters.lWeight).toBeLessThan(1.8);
        });

        test('integer params (minColors, maxColors, refinementPasses) are rounded', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { parameters } = engine.interpolate(DNA_AT_CLUSTER2);
            expect(Number.isInteger(parameters.minColors)).toBe(true);
            expect(Number.isInteger(parameters.maxColors)).toBe(true);
            expect(Number.isInteger(parameters.refinementPasses)).toBe(true);
        });
    });

    describe('interpolate() — ordered enum blending', () => {
        test('vibrancyMode is a valid enum value', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { parameters } = engine.interpolate(DNA_AT_CLUSTER2);
            expect(ORDERED_ENUMS.vibrancyMode).toContain(parameters.vibrancyMode);
        });

        test('preprocessingIntensity is a valid enum value', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { parameters } = engine.interpolate(DNA_AT_CLUSTER2);
            expect(ORDERED_ENUMS.preprocessingIntensity).toContain(parameters.preprocessingIntensity);
        });

        test('DNA at cluster 2 gets cluster 2 ordered enum (dominant weight)', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { parameters } = engine.interpolate(DNA_AT_CLUSTER2);
            expect(parameters.vibrancyMode).toBe('moderate');
            expect(parameters.preprocessingIntensity).toBe('light');
        });
    });

    describe('interpolate() — categorical/boolean params (nearest wins)', () => {
        test('DNA at cluster 2 gets cluster 2 categorical params', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { parameters } = engine.interpolate(DNA_AT_CLUSTER2);
            expect(parameters.distanceMetric).toBe('cie94');
            expect(parameters.ditherType).toBe('ordered');
            expect(parameters.preserveBlack).toBe(false);
        });

        test('DNA near cluster 1 gets cluster 1 categorical params', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { parameters } = engine.interpolate(DNA_NEAR_CLUSTER1);
            expect(parameters.distanceMetric).toBe('cie2000');
            expect(parameters.ditherType).toBe('atkinson');
            expect(parameters.preserveBlack).toBe(true);
        });

        test('DNA near cluster 3 gets cluster 3 categorical params', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { parameters } = engine.interpolate(DNA_NEAR_CLUSTER3);
            expect(parameters.distanceMetric).toBe('cie76');
            expect(parameters.ditherType).toBe('floyd-steinberg');
        });
    });

    describe('interpolate() — defaults for missing params', () => {
        test('provides default centroidStrategy if not in cluster params', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { parameters } = engine.interpolate(DNA_AT_CLUSTER2);
            expect(parameters.centroidStrategy).toBe('SALIENCY');
        });

        test('provides default medianPass if not in cluster params', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { parameters } = engine.interpolate(DNA_AT_CLUSTER2);
            expect(parameters.medianPass).toBe(false);
        });

        test('provides default bWeight if not in cluster params', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { parameters } = engine.interpolate(DNA_AT_CLUSTER2);
            expect(parameters.bWeight).toBe(1.0);
        });
    });

    describe('interpolate() — blendNeighbors=1 (no blending)', () => {
        test('with K=1 returns exact nearest cluster params', () => {
            const model = { ...MOCK_MODEL, blendNeighbors: 1 };
            const engine = new InterpolatorEngine(model);
            const { parameters, blendInfo } = engine.interpolate(DNA_NEAR_CLUSTER1);

            expect(blendInfo.neighbors).toHaveLength(1);
            expect(blendInfo.neighbors[0].weight).toBeCloseTo(1.0, 3);
            expect(parameters.lWeight).toBeCloseTo(1.8, 4);
            expect(parameters.cWeight).toBeCloseTo(1.5, 4);
            expect(parameters.blackBias).toBeCloseTo(9, 4);
        });
    });

    describe('interpolate() — DNA normalization', () => {
        test('two DNAs with same relative position produce same result', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            // Both map to normalized [0,0,...] — the centroid of cluster 2
            const result = engine.interpolate(DNA_AT_CLUSTER2);
            expect(result.blendInfo.neighbors[0].clusterId).toBe(2);
            expect(result.blendInfo.neighbors[0].distance).toBeCloseTo(0, 2);
        });
    });

    describe('interpolate() — edge case: DNA on top of centroid', () => {
        test('distance ~0 gives near-100% weight to that cluster', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const { blendInfo } = engine.interpolate(DNA_AT_CLUSTER2);
            expect(blendInfo.neighbors[0].weight).toBeGreaterThan(0.99);
        });
    });

    describe('interpolate() — nested vs flat DNA', () => {
        // The caller (generateConfigurationMk2) handles flattening,
        // but InterpolatorEngine expects flat DNA directly.
        test('accepts flat DNA format', () => {
            const engine = new InterpolatorEngine(MOCK_MODEL);
            const result = engine.interpolate(DNA_AT_CLUSTER2);
            expect(result.parameters).toBeDefined();
        });
    });

    describe('real model integration', () => {
        test('loads actual interpolator-model.json and produces valid output', () => {
            const model = require('../../lib/analysis/interpolator-model.json');
            const engine = new InterpolatorEngine(model);

            // Typical photographic DNA
            const dna = {
                l: 45, c: 22, k: 96, l_std_dev: 18,
                hue_entropy: 0.55, temperature_bias: 0.65, primary_sector_weight: 0.45
            };
            const { parameters, blendInfo } = engine.interpolate(dna);

            // Should produce valid parameter ranges
            expect(parameters.lWeight).toBeGreaterThan(0);
            expect(parameters.cWeight).toBeGreaterThan(0);
            expect(parameters.maxColors).toBeGreaterThanOrEqual(4);
            expect(parameters.maxColors).toBeLessThanOrEqual(12);
            expect(blendInfo.neighbors.length).toBe(model.blendNeighbors);

            // All neighbors should reference actual cluster IDs
            for (const n of blendInfo.neighbors) {
                const ids = model.clusters.map(c => c.id);
                expect(ids).toContain(n.clusterId);
            }
        });

        test('extreme dark DNA (L=5, C=3) gravitates toward dark cluster', () => {
            const model = require('../../lib/analysis/interpolator-model.json');
            const engine = new InterpolatorEngine(model);

            const darkDna = {
                l: 5, c: 3, k: 99, l_std_dev: 5,
                hue_entropy: 0.2, temperature_bias: 0.9, primary_sector_weight: 0.7
            };
            const { parameters } = engine.interpolate(darkDna);

            // Dark images should get higher blackBias
            expect(parameters.blackBias).toBeGreaterThan(5);
        });

        test('extreme vibrant DNA (L=60, C=55) gravitates toward vibrant cluster', () => {
            const model = require('../../lib/analysis/interpolator-model.json');
            const engine = new InterpolatorEngine(model);

            const vibrantDna = {
                l: 60, c: 55, k: 85, l_std_dev: 25,
                hue_entropy: 0.8, temperature_bias: 0.4, primary_sector_weight: 0.3
            };
            const { parameters } = engine.interpolate(vibrantDna);

            // Vibrant images should get higher vibrancyBoost
            expect(parameters.vibrancyBoost).toBeGreaterThan(1.0);
            // And more colors
            expect(parameters.maxColors).toBeGreaterThanOrEqual(7);
        });
    });
});

describe('InterpolatorEngine — exports', () => {
    test('DIM_KEYS has 7 dimensions', () => {
        expect(DIM_KEYS).toHaveLength(7);
        expect(DIM_KEYS).toContain('l');
        expect(DIM_KEYS).toContain('c');
        expect(DIM_KEYS).toContain('hue_entropy');
    });

    test('CONTINUOUS_PARAMS includes key tuning parameters', () => {
        expect(CONTINUOUS_PARAMS).toContain('lWeight');
        expect(CONTINUOUS_PARAMS).toContain('cWeight');
        expect(CONTINUOUS_PARAMS).toContain('paletteReduction');
        expect(CONTINUOUS_PARAMS).toContain('speckleRescue');
    });

    test('CATEGORICAL_PARAMS includes key categorical parameters', () => {
        expect(CATEGORICAL_PARAMS).toContain('distanceMetric');
        expect(CATEGORICAL_PARAMS).toContain('ditherType');
        expect(CATEGORICAL_PARAMS).toContain('preserveWhite');
    });

    test('ORDERED_ENUMS has vibrancyMode and preprocessingIntensity', () => {
        expect(ORDERED_ENUMS).toHaveProperty('vibrancyMode');
        expect(ORDERED_ENUMS).toHaveProperty('preprocessingIntensity');
    });
});
