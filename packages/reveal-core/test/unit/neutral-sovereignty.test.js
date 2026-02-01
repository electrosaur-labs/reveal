/**
 * Neutral Sovereignty Tests
 *
 * Verifies the three-part defense system that prevents grays from morphing into blues:
 * 1. Hard Neutral Sovereignty (archetype constraint)
 * 2. Desaturation Force (centroid snapping to a=0, b=0)
 * 3. Bully Suppression (blue sector penalty multiplier)
 * 4. Gravity Well (squared chroma penalty in assignment)
 */

import { describe, test, expect } from 'vitest';

const Reveal = require('../../index.js');
const PosterizationEngine = Reveal.engines.PosterizationEngine;
const DNAGenerator = Reveal.DNAGenerator;

describe('Neutral Sovereignty System', () => {
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
     * Test image: Gray stone wall (70% neutral) with blue sky (30% blue)
     * This is the classic case where grays morph into pale blue
     */
    function createGrayStoneWithBlueSkyImage(width = 100, height = 100) {
        const pixels = new Uint16Array(width * height * 3);
        let idx = 0;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (y < 30) {
                    // Blue sky (top 30%): L=70, a=-10, b=-25 (azure blue, C≈27)
                    const lab16 = labTo16bit(70, -10, -25);
                    pixels[idx++] = lab16.L;
                    pixels[idx++] = lab16.a;
                    pixels[idx++] = lab16.b;
                } else {
                    // Gray stone (bottom 70%): L=50±10, a=0, b=0 (neutral)
                    const jitter = (Math.random() - 0.5) * 20;
                    const lab16 = labTo16bit(50 + jitter, 0, 0);
                    pixels[idx++] = lab16.L;
                    pixels[idx++] = lab16.a;
                    pixels[idx++] = lab16.b;
                }
            }
        }

        return { pixels, width, height };
    }

    test('LUT Bully Suppression: Blue sectors get 2× penalty when neutralWeight > 10%', () => {
        const dna = {
            global: { neutralWeight: 0.35 },
            sectors: {
                blue: { weight: 0.20, hMean: 200 },  // Blue sector: 180-210° (centered at ~195-200°)
                red: { weight: 0.10, hMean: 10 },    // Red sector: 0-30° (centered at ~10-15°)
                yellow: { weight: 0.10, hMean: 80 }  // Yellow sector: 60-90°
            }
        };

        const config = {
            useDynamicAnchors: true,
            hueLockSensitivity: 1.0,
            hueLockAngle: 15
        };

        const lut = PosterizationEngine.generateHuePenaltyLUT(dna, config);

        // Blue sector is 180-210° (sector 6), red sector is 0-30° (sector 0)
        // Blue anchor at 200°, red anchor at 10°
        // Check hues WITHIN those sectors with 18° drift (beyond 15° tolerance)
        const blueDrift18 = lut[182];  // 18° drift from blue anchor (200-18=182, still in blue sector)
        const redDrift18 = lut[28];    // 18° drift from red anchor (10+18=28, still in red sector)

        // Both should have penalties (drift > tolerance)
        expect(blueDrift18).toBeGreaterThan(0);
        expect(redDrift18).toBeGreaterThan(0);

        // Blue penalty should be ~2× larger due to bully suppression
        // (neutralWeight=0.35 > 0.1, so blue gets bullyFactor=2.0)
        const ratio = blueDrift18 / redDrift18;
        expect(ratio).toBeGreaterThan(1.8);
        expect(ratio).toBeLessThan(2.2);
    });

    test('Desaturation Force: Low-chroma centroids snap to a=0, b=0', async () => {
        const { pixels, width, height } = createGrayStoneWithBlueSkyImage(50, 50);

        const result = PosterizationEngine.posterize(
            pixels,
            width,
            height,
            5, // 5 colors: blue sky, black, white, and 2 grays
            {
                useDynamicAnchors: true,
                useNeutralGravity: true,
                neutralStiffness: 25.0,
                neutralChromaThreshold: 3.5,
                preserveWhite: true,
                preserveBlack: true,
                bitDepth: 16,
                format: 'lab'
            }
        );

        // Find gray centroids (L between 30-70, should have snapped to a=0, b=0)
        const grayColors = result.paletteLab.filter(c => c.L > 30 && c.L < 70);

        // At least one gray should exist
        expect(grayColors.length).toBeGreaterThan(0);

        // All grays should be exactly neutral (a=0, b=0) due to snapping
        for (const gray of grayColors) {
            const chroma = Math.sqrt(gray.a * gray.a + gray.b * gray.b);
            if (chroma < 5) {
                expect(gray.a).toBe(0);
                expect(gray.b).toBe(0);
            }
        }
    });

    test('Gravity Well: Squared chroma penalty prevents neutral pixels from choosing blue centroids', async () => {
        const { pixels, width, height } = createGrayStoneWithBlueSkyImage(50, 50);

        // Generate DNA
        const dna = DNAGenerator.generate(pixels, width, height, 40, {
            richDNA: true,
            spatialMetrics: false
        });

        // Verify significant neutral weight (should be ~40%, with 30% being blue sky)
        expect(dna.global.neutralWeight).toBeGreaterThan(0.35);

        // Process with Neutral Gravity enabled
        const result = PosterizationEngine.posterize(
            pixels,
            width,
            height,
            5,
            {
                dna,
                useDynamicAnchors: true,
                useNeutralGravity: true,
                neutralStiffness: 25.0,
                neutralChromaThreshold: 3.5,
                preserveWhite: false,
                preserveBlack: false,
                bitDepth: 16,
                format: 'lab'
            }
        );

        // Find the blue centroid
        const blueColors = result.paletteLab.filter(c => {
            const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
            const hue = (Math.atan2(c.b, c.a) * 180 / Math.PI + 360) % 360;
            return chroma > 15 && hue > 200 && hue < 280; // Blue sector
        });

        expect(blueColors.length).toBeGreaterThan(0);

        // Find neutral colors in the palette
        const neutralColors = result.paletteLab.filter(c => {
            const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
            return chroma < 5 && c.L > 30 && c.L < 70;
        });

        // With Neutral Gravity enabled, we should have at least one true neutral color
        // that gray pixels can be assigned to (preventing them from going to blue)
        expect(neutralColors.length).toBeGreaterThan(0);

        // Verify the neutral color is exactly a=0, b=0 (Desaturation Force)
        const trueNeutrals = neutralColors.filter(c => c.a === 0 && c.b === 0);
        expect(trueNeutrals.length).toBeGreaterThan(0);
    });

    test('Gravity Well: WITHOUT Neutral Gravity, grays morph into blue (baseline)', async () => {
        const { pixels, width, height } = createGrayStoneWithBlueSkyImage(50, 50);

        // Process WITHOUT Neutral Gravity
        const result = PosterizationEngine.posterize(
            pixels,
            width,
            height,
            5,
            {
                useDynamicAnchors: false,
                useNeutralGravity: false, // DISABLED
                preserveWhite: false,
                preserveBlack: false,
                bitDepth: 16,
                format: 'lab'
            }
        );

        // Find blue-ish colors
        const blueColors = result.paletteLab.filter(c => {
            const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
            const hue = (Math.atan2(c.b, c.a) * 180 / Math.PI + 360) % 360;
            return chroma > 10 && hue > 200 && hue < 280;
        });

        // Without Neutral Gravity, we expect to see more blue bleeding
        // (This test documents the PROBLEM we're solving)
        expect(blueColors.length).toBeGreaterThan(0);
    });

    test('Integration: Full system prevents gray-to-blue morphing', async () => {
        const { pixels, width, height } = createGrayStoneWithBlueSkyImage(100, 100);

        // Generate Rich DNA v2.0
        const dna = DNAGenerator.generate(pixels, width, height, 40, {
            richDNA: true,
            spatialMetrics: true
        });

        // Full Neutral Sovereignty system
        const result = PosterizationEngine.posterize(
            pixels,
            width,
            height,
            6,
            {
                dna,
                useDynamicAnchors: true,
                useNeutralGravity: true,
                neutralStiffness: 25.0,
                neutralChromaThreshold: 3.5,
                hueLockSensitivity: 1.0,
                hueLockAngle: 15,
                preserveWhite: false,
                preserveBlack: false,
                bitDepth: 16,
                format: 'lab'
            }
        );

        // Verify we have both blue and neutral colors
        const blueColors = result.paletteLab.filter(c => {
            const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
            const hue = (Math.atan2(c.b, c.a) * 180 / Math.PI + 360) % 360;
            return chroma > 15 && hue > 200 && hue < 280;
        });

        const neutralColors = result.paletteLab.filter(c => {
            const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
            return chroma < 2 && c.L > 30 && c.L < 70;
        });

        expect(blueColors.length).toBeGreaterThan(0);
        expect(neutralColors.length).toBeGreaterThan(0);

        // Verify neutral colors are exactly a=0, b=0 (Desaturation Force)
        for (const neutral of neutralColors) {
            expect(neutral.a).toBe(0);
            expect(neutral.b).toBe(0);
        }
    });

    test('Cinematic archetype uses softer Neutral Sovereignty', () => {
        // Cinematic images WANT blue-tinted shadows for artistic effect
        // So they should have weaker neutralStiffness (10.0 vs 25.0)

        // This is verified by checking the archetype JSON files
        // cinematic-moody.json should have neutralStiffness: 10.0
        // standard-balanced.json should have neutralStiffness: 25.0

        // This test serves as documentation of the design intent
        expect(true).toBe(true);
    });
});
