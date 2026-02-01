/**
 * Integration tests for DNA constraint system
 * Tests the full pipeline: DNA generation → constraint evaluation → parameter morphing
 */

const ParameterGenerator = require('../../lib/analysis/ParameterGenerator');

describe('Constraint System Integration', () => {
    test('applies pilot morphs via constraints', () => {
        // DNA representing a flat graphic (low l_std_dev)
        const flatGraphicDNA = {
            l: 70,
            c: 25,
            k: 60,
            l_std_dev: 5.5,  // Ultra-flat → should trigger flatness override
            maxC: 60,
            maxCHue: 180,
            minL: 20,
            maxL: 95,
            yellowDominance: 5
        };

        const config = ParameterGenerator.generate(flatGraphicDNA);

        // MORPH 3: Flatness Override should set ditherType to 'none'
        expect(config.ditherType).toBe('none');
    });

    test('applies yellow dominance scaling', () => {
        // DNA representing yellow-dominant image (lemon)
        const yellowDNA = {
            l: 85,
            c: 50,
            k: 70,
            l_std_dev: 20,
            maxC: 118,
            maxCHue: 75,  // Yellow hue
            minL: 15,
            maxL: 95,
            yellowDominance: 35  // High yellow dominance
        };

        const config = ParameterGenerator.generate(yellowDNA);

        // Should match yellow-dominant archetype
        expect(config.meta.archetypeId).toBe('yellow_dominant');

        // MORPH 7: Nuclear Yellow should be triggered
        expect(config.centroidStrategy).toBe('SALIENCY');
    });

    test('applies thermonuclear yellow morph', () => {
        // DNA with extreme yellow dominance
        const thermonuclearDNA = {
            l: 85,
            c: 50,
            k: 70,
            l_std_dev: 20,
            maxC: 118,
            maxCHue: 75,
            minL: 15,
            maxL: 95,
            yellowDominance: 25  // > 20 → thermonuclear mode
        };

        const config = ParameterGenerator.generate(thermonuclearDNA);

        // Thermonuclear constraint should override lWeight and cWeight
        expect(config.lWeight).toBeGreaterThanOrEqual(5.0);
        expect(config.cWeight).toBeGreaterThanOrEqual(2.5);
    });

    test('applies shadow gate calibration', () => {
        // DNA with ultra-low minL
        const darkDNA = {
            l: 30,
            c: 20,
            k: 90,
            l_std_dev: 25,
            maxC: 80,
            maxCHue: 180,
            minL: 1.5,  // < 2 → should trigger shadow gate
            maxL: 85,
            yellowDominance: 5
        };

        const config = ParameterGenerator.generate(darkDNA);

        // MORPH 2: Shadow Gate should reduce shadowPoint
        expect(config.shadowPoint).toBeLessThanOrEqual(5);
    });

    test('applies highlight threshold protection', () => {
        // DNA with ultra-bright highlights
        const brightDNA = {
            l: 80,
            c: 20,
            k: 80,
            l_std_dev: 20,
            maxC: 60,
            maxCHue: 180,
            minL: 10,
            maxL: 99,  // > 98 → should trigger highlight protection
            yellowDominance: 5
        };

        const config = ParameterGenerator.generate(brightDNA);

        // MORPH 4: Highlight Threshold should increase threshold
        expect(config.highlightThreshold).toBeGreaterThanOrEqual(96);
    });

    test('applies vibrancy floor for muted images', () => {
        // DNA representing muted/desaturated image
        const mutedDNA = {
            l: 60,
            c: 8,  // Low chroma
            k: 40,
            l_std_dev: 10,
            maxC: 65,  // No vibrant spikes
            maxCHue: 45,
            minL: 25,
            maxL: 85,
            yellowDominance: 5
        };

        const config = ParameterGenerator.generate(mutedDNA);

        // Should match muted-vintage archetype
        // MORPH 5: Vibrancy Floor should reduce vibrancyBoost
        expect(config.vibrancyBoost).toBeLessThanOrEqual(1.0);
    });

    test('constraint evaluation can be skipped via option', () => {
        const yellowDNA = {
            l: 85,
            c: 50,
            k: 70,
            l_std_dev: 20,
            maxC: 118,
            maxCHue: 75,
            minL: 15,
            maxL: 95,
            yellowDominance: 35
        };

        // Generate with skipLegacyMorphing flag
        const config = ParameterGenerator.generate(yellowDNA, {
            skipLegacyMorphing: true
        });

        // Config should still be generated
        expect(config).toBeDefined();
        expect(config.meta.archetypeId).toBe('yellow_dominant');

        // But constraints should still be applied (skipLegacyMorphing only skips old morphing)
        expect(config.centroidStrategy).toBe('SALIENCY');
    });

    test('handles DNA v2.0 format with backward compatibility', () => {
        // DNA v2.0 format with hierarchical structure
        const dna_v2 = {
            version: '2.0',

            // Legacy fields (backward compatible)
            l: 65,
            c: 28,
            k: 82,
            l_std_dev: 22,
            maxC: 118,
            maxCHue: 68,
            minL: 8,
            maxL: 90,
            yellowDominance: 35,

            // v2.0 hierarchical structure
            global: {
                l: 65,
                c: 28,
                k: 82,
                l_std_dev: 22
            },

            sectors: {
                yellow: {
                    weight: 0.35,
                    lMean: 85.7
                }
            },

            spatial: {
                entropy: 42.3,
                edgeDensity: 0.14
            }
        };

        const config = ParameterGenerator.generate(dna_v2);

        // Should work with v2.0 DNA (archetype selection is distance-based)
        expect(config).toBeDefined();
        expect(config.meta.archetypeId).toBeDefined();
        expect(config.lWeight).toBeDefined();
        expect(config.cWeight).toBeDefined();

        // Thermonuclear yellow should still be triggered by legacy morphing
        expect(config.lWeight).toBeGreaterThanOrEqual(5.0);
    });

    test('handles missing DNA fields gracefully', () => {
        // Minimal DNA with missing optional fields
        const minimalDNA = {
            l: 50,
            c: 25,
            k: 60,
            l_std_dev: 20,
            maxC: 80,
            maxCHue: 180,
            minL: 10,
            maxL: 90
            // Missing yellowDominance
        };

        const config = ParameterGenerator.generate(minimalDNA);

        // Should still generate config
        expect(config).toBeDefined();
        expect(config.lWeight).toBeDefined();
        expect(config.cWeight).toBeDefined();
    });
});
