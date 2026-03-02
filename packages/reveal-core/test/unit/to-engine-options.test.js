/**
 * Tests for ParameterGenerator.toEngineOptions()
 */
const ParameterGenerator = require('../../lib/analysis/ParameterGenerator');

describe('ParameterGenerator.toEngineOptions', () => {
    // Minimal config that resembles ParameterGenerator.generate() output
    const mockConfig = {
        targetColors: 8,
        ditherType: 'blue-noise',
        distanceMetric: 'cie94',
        engineType: 'reveal-mk1.5',
        centroidStrategy: 'SALIENCY',
        lWeight: 1.2,
        cWeight: 2.0,
        bWeight: 1.0,
        blackBias: 3.0,
        vibrancyMode: 'moderate',
        vibrancyBoost: 1.4,
        saturationBoost: 1.4,  // Legacy alias — should NOT appear in output
        vibrancyThreshold: 10,
        highlightThreshold: 90,
        highlightBoost: 1.5,
        enablePaletteReduction: true,
        paletteReduction: 6.0,
        substrateMode: 'auto',
        substrateTolerance: 2.0,
        enableHueGapAnalysis: true,
        hueLockAngle: 20,
        shadowPoint: 15,
        colorMode: 'color',
        preserveWhite: true,
        preserveBlack: true,
        ignoreTransparent: true,
        maskProfile: 'Gray Gamma 2.2',
        shadowClamp: 0,
        chromaGate: 1.0,
        detailRescue: 0,
        speckleRescue: 4,
        medianPass: false,
        minVolume: 1.5,
        shadowChromaGateL: 0,
        neutralCentroidClampThreshold: 0.5,
        neutralSovereigntyThreshold: 0,
        refinementPasses: 1,
        meshSize: 0
    };

    it('emits both targetColors and targetColorsSlider', () => {
        const opts = ParameterGenerator.toEngineOptions(mockConfig);
        expect(opts.targetColorsSlider).toBe(8);
        expect(opts.targetColors).toBe(8);
    });

    it('uses vibrancyBoost directly (not saturationBoost)', () => {
        const opts = ParameterGenerator.toEngineOptions(mockConfig);
        expect(opts.vibrancyBoost).toBe(1.4);
        expect(opts.saturationBoost).toBeUndefined();
    });

    it('passes through all engine parameters', () => {
        const opts = ParameterGenerator.toEngineOptions(mockConfig);

        expect(opts.distanceMetric).toBe('cie94');
        expect(opts.ditherType).toBe('blue-noise');
        expect(opts.lWeight).toBe(1.2);
        expect(opts.cWeight).toBe(2.0);
        expect(opts.blackBias).toBe(3.0);
        expect(opts.speckleRescue).toBe(4);
        expect(opts.minVolume).toBe(1.5);
        expect(opts.engineType).toBe('reveal-mk1.5');
    });

    it('overrides win over config values', () => {
        const opts = ParameterGenerator.toEngineOptions(mockConfig, {
            bitDepth: 16,
            targetColorsSlider: 10,
            format: 'lab'
        });

        expect(opts.bitDepth).toBe(16);
        expect(opts.targetColorsSlider).toBe(10);
        expect(opts.format).toBe('lab');
    });

    it('defaults format to lab', () => {
        const opts = ParameterGenerator.toEngineOptions(mockConfig);
        expect(opts.format).toBe('lab');
    });

    it('defaults engineType to reveal when config has none', () => {
        const configNoEngine = { ...mockConfig, engineType: undefined };
        const opts = ParameterGenerator.toEngineOptions(configNoEngine);
        expect(opts.engineType).toBe('reveal');
    });
});
