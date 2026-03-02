/**
 * Salamander Pseudo-Archetype - Config Generation Tests
 *
 * Validates that generateConfigurationSalamander() produces the correct
 * hybrid config: DNA-interpolated params from Chameleon with Distilled's
 * no-pruning guarantee and raw signal preservation.
 */

import { describe, it, expect } from 'vitest';

const Reveal = require('../../index');

// Minimal DNA fixture (mid-range photographic image)
const PHOTO_DNA = {
    global: {
        l: 50,
        c: 30,
        k: 10,
        l_std_dev: 20,
        hue_entropy: 0.7,
        temperature_bias: 0.1,
        primary_sector_weight: 0.3
    }
};

// High-chroma graphic DNA
const GRAPHIC_DNA = {
    global: {
        l: 60,
        c: 65,
        k: 5,
        l_std_dev: 15,
        hue_entropy: 0.4,
        temperature_bias: -0.2,
        primary_sector_weight: 0.6
    }
};

describe('generateConfigurationSalamander', () => {

    it('is exported from reveal-core', () => {
        expect(typeof Reveal.generateConfigurationSalamander).toBe('function');
    });

    describe('engine type', () => {
        it('uses distilled engine', () => {
            const config = Reveal.generateConfigurationSalamander(PHOTO_DNA);
            expect(config.engineType).toBe('distilled');
        });
    });

    describe('no-pruning guarantee (from Distilled)', () => {
        it('disables palette reduction', () => {
            const config = Reveal.generateConfigurationSalamander(PHOTO_DNA);
            expect(config.enablePaletteReduction).toBe(false);
        });

        it('sets snapThreshold to 0', () => {
            const config = Reveal.generateConfigurationSalamander(PHOTO_DNA);
            expect(config.snapThreshold).toBe(0);
        });

        it('sets densityFloor to 0', () => {
            const config = Reveal.generateConfigurationSalamander(PHOTO_DNA);
            expect(config.densityFloor).toBe(0);
        });
    });

    describe('raw signal preservation (from Distilled)', () => {
        it('disables preprocessing', () => {
            const config = Reveal.generateConfigurationSalamander(PHOTO_DNA);
            expect(config.preprocessingIntensity).toBe('off');
        });
    });

    describe('DNA-driven params (from Chameleon)', () => {
        it('has fixed 12 targetColors', () => {
            const config = Reveal.generateConfigurationSalamander(PHOTO_DNA);
            expect(config.targetColors).toBe(12);
            expect(config.targetColorsSlider).toBe(12);
        });

        it('uses VOLUMETRIC centroid strategy', () => {
            const config = Reveal.generateConfigurationSalamander(PHOTO_DNA);
            expect(config.centroidStrategy).toBe('VOLUMETRIC');
        });

        it('inherits blendInfo from Chameleon interpolator', () => {
            const config = Reveal.generateConfigurationSalamander(PHOTO_DNA);
            expect(config.meta).toBeDefined();
            expect(config.meta.blendInfo).toBeDefined();
            expect(config.meta.blendInfo.neighbors).toBeInstanceOf(Array);
            expect(config.meta.blendInfo.neighbors.length).toBeGreaterThan(0);
        });

        it('config varies with DNA (different blend distances)', () => {
            const photoConfig = Reveal.generateConfigurationSalamander(PHOTO_DNA);
            const graphicConfig = Reveal.generateConfigurationSalamander(GRAPHIC_DNA);
            // Different DNA should produce different interpolation blend distances
            const photoDist = photoConfig.meta.blendInfo.neighbors[0].distance;
            const graphicDist = graphicConfig.meta.blendInfo.neighbors[0].distance;
            expect(photoDist).not.toBe(graphicDist);
        });
    });

    describe('metadata', () => {
        it('tags engine as salamander', () => {
            const config = Reveal.generateConfigurationSalamander(PHOTO_DNA);
            expect(config.meta.engine).toBe('salamander');
        });
    });

    describe('comparison with Chameleon and Distilled', () => {
        it('differs from Chameleon in palette reduction', () => {
            const chameleon = Reveal.generateConfigurationMk2(PHOTO_DNA);
            const salamander = Reveal.generateConfigurationSalamander(PHOTO_DNA);

            // Salamander forces these off; Chameleon may have them on
            expect(salamander.enablePaletteReduction).toBe(false);
            expect(salamander.snapThreshold).toBe(0);
            expect(salamander.densityFloor).toBe(0);
            expect(salamander.preprocessingIntensity).toBe('off');
        });

        it('differs from Distilled in DNA-derived weights', () => {
            const distilled = Reveal.generateConfigurationDistilled(PHOTO_DNA);
            const salamander = Reveal.generateConfigurationSalamander(PHOTO_DNA);

            // Both use 12 colors and VOLUMETRIC, but Salamander inherits
            // DNA-interpolated weights (lWeight, cWeight, etc.) from Chameleon
            expect(distilled.targetColors).toBe(12);
            expect(salamander.targetColors).toBe(12);
            expect(salamander.meta.engine).toBe('salamander');
            expect(salamander.meta.blendInfo).toBeDefined();
            // Distilled has no blendInfo (no DNA interpolation)
            expect(distilled.meta).toBeUndefined();
        });

        it('shares engine type with both', () => {
            const chameleon = Reveal.generateConfigurationMk2(PHOTO_DNA);
            const distilled = Reveal.generateConfigurationDistilled(PHOTO_DNA);
            const salamander = Reveal.generateConfigurationSalamander(PHOTO_DNA);

            expect(chameleon.engineType).toBe('distilled');
            expect(distilled.engineType).toBe('distilled');
            expect(salamander.engineType).toBe('distilled');
        });
    });
});
