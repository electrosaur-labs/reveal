import { describe, test, expect } from 'vitest';

const Reveal = require('../../index');

describe('generateConfigurationMk2', () => {
    // Typical photographic DNA (flat format)
    const FLAT_DNA = {
        l: 45, c: 22, k: 96, l_std_dev: 18,
        hue_entropy: 0.55, temperature_bias: 0.65, primary_sector_weight: 0.45
    };

    // Nested format (as produced by DNAGenerator)
    const NESTED_DNA = {
        global: {
            l: 45, c: 22, k: 96, l_std_dev: 18,
            hue_entropy: 0.55, temperature_bias: 0.65, primary_sector_weight: 0.45
        }
    };

    describe('output structure', () => {
        test('returns a config object with engineType reveal-mk2', () => {
            const config = Reveal.generateConfigurationMk2(FLAT_DNA);
            expect(config.engineType).toBe('reveal-mk2');
        });

        test('returns meta with blendInfo and engine identifier', () => {
            const config = Reveal.generateConfigurationMk2(FLAT_DNA);
            expect(config.meta).toBeDefined();
            expect(config.meta.engine).toBe('mk2-interpolator');
            expect(config.meta.blendInfo).toBeDefined();
            expect(config.meta.blendInfo.neighbors).toBeInstanceOf(Array);
        });

        test('maps maxColors to targetColors', () => {
            const config = Reveal.generateConfigurationMk2(FLAT_DNA);
            expect(config.targetColors).toBeDefined();
            expect(config.targetColors).toBe(config.maxColors);
        });

        test('sets targetColorsSlider equal to targetColors', () => {
            const config = Reveal.generateConfigurationMk2(FLAT_DNA);
            expect(config.targetColorsSlider).toBe(config.targetColors);
        });
    });

    describe('flat vs nested DNA', () => {
        test('flat DNA produces valid config', () => {
            const config = Reveal.generateConfigurationMk2(FLAT_DNA);
            expect(config.lWeight).toBeDefined();
            expect(config.cWeight).toBeDefined();
            expect(config.maxColors).toBeGreaterThanOrEqual(4);
        });

        test('nested DNA (with global key) produces same config as flat', () => {
            const configFlat = Reveal.generateConfigurationMk2(FLAT_DNA);
            const configNested = Reveal.generateConfigurationMk2(NESTED_DNA);
            // Should produce identical results since the inner values are the same
            expect(configFlat.lWeight).toBeCloseTo(configNested.lWeight, 4);
            expect(configFlat.cWeight).toBeCloseTo(configNested.cWeight, 4);
            expect(configFlat.maxColors).toBe(configNested.maxColors);
            expect(configFlat.distanceMetric).toBe(configNested.distanceMetric);
        });
    });

    describe('parameter completeness', () => {
        test('includes all essential PosterizationEngine parameters', () => {
            const config = Reveal.generateConfigurationMk2(FLAT_DNA);

            // Core quantization
            expect(config.lWeight).toBeGreaterThan(0);
            expect(config.cWeight).toBeGreaterThan(0);
            expect(config.maxColors).toBeGreaterThanOrEqual(4);
            expect(config.maxColors).toBeLessThanOrEqual(12);

            // Distance metric
            expect(['cie76', 'cie94', 'cie2000']).toContain(config.distanceMetric);

            // Dithering
            expect(config.ditherType).toBeDefined();

            // Mechanical knobs
            expect(config.speckleRescue).toBeDefined();
            expect(config.shadowClamp).toBeDefined();
            expect(config.minVolume).toBeDefined();
        });

        test('includes palette reduction settings', () => {
            const config = Reveal.generateConfigurationMk2(FLAT_DNA);
            expect(typeof config.enablePaletteReduction).toBe('boolean');
            expect(typeof config.paletteReduction).toBe('number');
        });

        test('includes vibrancy settings', () => {
            const config = Reveal.generateConfigurationMk2(FLAT_DNA);
            expect(config.vibrancyBoost).toBeDefined();
            expect(['subtle', 'moderate', 'aggressive', 'exponential']).toContain(config.vibrancyMode);
        });
    });

    describe('lazy singleton initialization', () => {
        test('calling twice with same DNA produces identical results', () => {
            const config1 = Reveal.generateConfigurationMk2(FLAT_DNA);
            const config2 = Reveal.generateConfigurationMk2(FLAT_DNA);
            expect(config1.lWeight).toBe(config2.lWeight);
            expect(config1.maxColors).toBe(config2.maxColors);
            expect(config1.distanceMetric).toBe(config2.distanceMetric);
        });
    });

    describe('different DNA produces different configs', () => {
        test('dark DNA vs bright DNA produce different parameters', () => {
            const darkDna = {
                l: 10, c: 5, k: 99, l_std_dev: 5,
                hue_entropy: 0.2, temperature_bias: 0.9, primary_sector_weight: 0.7
            };
            const brightDna = {
                l: 70, c: 45, k: 80, l_std_dev: 25,
                hue_entropy: 0.8, temperature_bias: 0.3, primary_sector_weight: 0.3
            };

            const darkConfig = Reveal.generateConfigurationMk2(darkDna);
            const brightConfig = Reveal.generateConfigurationMk2(brightDna);

            // They should differ — not identical
            const sameParams = darkConfig.lWeight === brightConfig.lWeight
                && darkConfig.cWeight === brightConfig.cWeight
                && darkConfig.blackBias === brightConfig.blackBias;
            expect(sameParams).toBe(false);
        });
    });

    describe('config is compatible with PosterizationEngine', () => {
        test('engineType is reveal-mk2 for correct dispatch', () => {
            const config = Reveal.generateConfigurationMk2(FLAT_DNA);
            expect(config.engineType).toBe('reveal-mk2');
        });

        test('targetColors is a valid positive integer', () => {
            const config = Reveal.generateConfigurationMk2(FLAT_DNA);
            expect(Number.isInteger(config.targetColors)).toBe(true);
            expect(config.targetColors).toBeGreaterThan(0);
        });
    });

    describe('is exported correctly', () => {
        test('available as top-level export', () => {
            expect(typeof Reveal.generateConfigurationMk2).toBe('function');
        });

        test('InterpolatorEngine available via engines export', () => {
            expect(Reveal.engines.InterpolatorEngine).toBeDefined();
        });
    });
});
