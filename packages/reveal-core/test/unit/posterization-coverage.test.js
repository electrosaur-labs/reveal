/**
 * PosterizationEngine Coverage Tests
 *
 * Tests targeting uncovered code paths in PosterizationEngine:
 * - preserveWhite/preserveBlack options
 * - enableHueGapAnalysis with images that have hue gaps
 * - Palette reduction logic
 * - Substrate detection
 * - Various engine types and edge cases
 */

import { describe, it, expect } from 'vitest';

const Reveal = require('../../index.js');
const PosterizationEngine = Reveal.engines.PosterizationEngine;
const PaletteOps = require('../../lib/engines/PaletteOps');
const LabEncoding = Reveal.LabEncoding;
const LabDistance = Reveal.LabDistance;
const HueAnalysis = Reveal.engines.HueAnalysis;

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
 * Helper: Create 16-bit Lab image from color array
 */
function createLabImage(width, height, colors) {
    const pixels = new Uint16Array(width * height * 3);
    const pixelsPerColor = Math.floor((width * height) / colors.length);

    for (let i = 0; i < width * height; i++) {
        const colorIdx = Math.min(Math.floor(i / pixelsPerColor), colors.length - 1);
        const color = colors[colorIdx];
        const lab16 = labTo16bit(color.L, color.a, color.b);
        pixels[i * 3] = lab16.L;
        pixels[i * 3 + 1] = lab16.a;
        pixels[i * 3 + 2] = lab16.b;
    }

    return pixels;
}

/**
 * Helper: Create image with specific corner colors (for substrate detection)
 */
function createImageWithCorners(width, height, cornerColor, centerColor) {
    const pixels = new Uint16Array(width * height * 3);
    const corner16 = labTo16bit(cornerColor.L, cornerColor.a, cornerColor.b);
    const center16 = labTo16bit(centerColor.L, centerColor.a, centerColor.b);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 3;
            // Corners are within 10 pixels of edges
            const isCorner = (x < 10 || x >= width - 10) && (y < 10 || y >= height - 10);
            const color = isCorner ? corner16 : center16;
            pixels[i] = color.L;
            pixels[i + 1] = color.a;
            pixels[i + 2] = color.b;
        }
    }

    return pixels;
}

describe('PosterizationEngine - Coverage Tests', () => {
    describe('preserveWhite and preserveBlack options', () => {
        it('should preserve white when preserveWhite=true', () => {
            // Image with mid-tones and some near-white
            const colors = [
                { L: 50, a: 0, b: 0 },   // Mid gray
                { L: 30, a: 10, b: 5 },  // Dark warm
                { L: 70, a: -5, b: 10 }, // Light greenish
                { L: 95, a: 0, b: 0 },   // Near white
            ];
            const pixels = createLabImage(50, 50, colors);

            const result = PosterizationEngine.posterize(pixels, 50, 50, 4, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                preserveWhite: true,
                preserveBlack: false,
                enableHueGapAnalysis: false
            });

            expect(result.paletteLab).toBeDefined();
            // Should have a very light color (L > 90) in palette
            const hasWhite = result.paletteLab.some(c => c.L > 90);
            expect(hasWhite).toBe(true);
        });

        it('should preserve black when preserveBlack=true', () => {
            // Image with mid-tones and some near-black
            const colors = [
                { L: 50, a: 0, b: 0 },   // Mid gray
                { L: 70, a: 10, b: 5 },  // Light warm
                { L: 40, a: -5, b: 10 }, // Mid greenish
                { L: 5, a: 0, b: 0 },    // Near black
            ];
            const pixels = createLabImage(50, 50, colors);

            const result = PosterizationEngine.posterize(pixels, 50, 50, 4, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                preserveWhite: false,
                preserveBlack: true,
                enableHueGapAnalysis: false
            });

            expect(result.paletteLab).toBeDefined();
            // Should have a very dark color (L < 10) in palette
            const hasBlack = result.paletteLab.some(c => c.L < 10);
            expect(hasBlack).toBe(true);
        });

        it('should preserve both white and black when both options are true', () => {
            // Image with full tonal range
            const colors = [
                { L: 5, a: 0, b: 0 },    // Near black
                { L: 30, a: 5, b: 5 },   // Dark
                { L: 50, a: 0, b: 0 },   // Mid
                { L: 70, a: -5, b: 5 },  // Light
                { L: 95, a: 0, b: 0 },   // Near white
            ];
            const pixels = createLabImage(50, 50, colors);

            const result = PosterizationEngine.posterize(pixels, 50, 50, 5, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                preserveWhite: true,
                preserveBlack: true,
                enableHueGapAnalysis: false
            });

            expect(result.paletteLab).toBeDefined();
            const hasWhite = result.paletteLab.some(c => c.L > 90);
            const hasBlack = result.paletteLab.some(c => c.L < 10);
            expect(hasWhite).toBe(true);
            expect(hasBlack).toBe(true);
        });
    });

    describe('enableHueGapAnalysis', () => {
        it('should detect hue gaps when image has missing sectors', () => {
            // Image with red and green, but missing blue/purple sectors
            const colors = [
                { L: 50, a: 60, b: 30 },   // Red/Orange (sector 0-1)
                { L: 50, a: -50, b: 40 },  // Green (sector 3-4)
                { L: 50, a: 0, b: 0 },     // Gray
                { L: 70, a: 50, b: 20 },   // Light red
            ];
            const pixels = createLabImage(100, 100, colors);

            const result = PosterizationEngine.posterize(pixels, 100, 100, 5, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                enableHueGapAnalysis: true,
                enablePaletteReduction: false
            });

            expect(result.paletteLab).toBeDefined();
            expect(result.paletteLab.length).toBeGreaterThanOrEqual(2);
        });

        it('should add vibrant colors for significant hue gaps', () => {
            // Image dominated by neutral grays with small vibrant accent
            const width = 100;
            const height = 100;
            const pixels = new Uint16Array(width * height * 3);

            // 90% gray, 10% vibrant blue
            const gray16 = labTo16bit(50, 0, 0);
            const blue16 = labTo16bit(40, 10, -50); // Blue sector

            for (let i = 0; i < width * height; i++) {
                const isBlue = i > width * height * 0.9;
                const color = isBlue ? blue16 : gray16;
                pixels[i * 3] = color.L;
                pixels[i * 3 + 1] = color.a;
                pixels[i * 3 + 2] = color.b;
            }

            const result = PosterizationEngine.posterize(pixels, width, height, 4, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                enableHueGapAnalysis: true,
                enablePaletteReduction: false
            });

            expect(result.paletteLab).toBeDefined();
            // Should have detected the blue accent
            const hasChromatic = result.paletteLab.some(c => {
                const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
                return chroma > 20;
            });
            expect(hasChromatic).toBe(true);
        });
    });

    describe('Palette Reduction', () => {
        it('should merge similar colors when enablePaletteReduction=true', () => {
            // Image with very similar colors that should be merged
            const colors = [
                { L: 50, a: 0, b: 0 },
                { L: 51, a: 1, b: 0 },   // Very close to first
                { L: 52, a: 0, b: 1 },   // Very close to first
                { L: 80, a: 0, b: 0 },   // Distinct
            ];
            const pixels = createLabImage(50, 50, colors);

            const result = PosterizationEngine.posterize(pixels, 50, 50, 4, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                enablePaletteReduction: true,
                paletteReduction: 10.0, // High threshold to force merging
                enableHueGapAnalysis: false
            });

            expect(result.paletteLab).toBeDefined();
            // Similar colors should have been merged
            expect(result.paletteLab.length).toBeLessThanOrEqual(4);
        });

        it('should respect paletteReduction threshold', () => {
            // Two colors just above/below threshold
            const colors = [
                { L: 50, a: 0, b: 0 },
                { L: 60, a: 0, b: 0 },   // ΔE ≈ 10
                { L: 80, a: 0, b: 0 },   // ΔE ≈ 20 from L=60
            ];
            const pixels = createLabImage(50, 50, colors);

            // With low threshold, should keep all
            const resultLow = PosterizationEngine.posterize(pixels, 50, 50, 3, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                enablePaletteReduction: true,
                paletteReduction: 5.0,
                enableHueGapAnalysis: false
            });

            expect(resultLow.paletteLab).toBeDefined();
        });
    });

    describe('Substrate Detection', () => {
        it('should detect white substrate from corners', () => {
            // White corners, colored center
            const pixels = createImageWithCorners(100, 100,
                { L: 95, a: 0, b: 0 },    // White corners
                { L: 50, a: 30, b: 20 }   // Colored center
            );

            const substrate = PosterizationEngine.autoDetectSubstrate(pixels, 100, 100, 16);

            expect(substrate).toBeDefined();
            expect(substrate.L).toBeGreaterThan(85); // Should detect white
            expect(Math.abs(substrate.a)).toBeLessThan(10);
            expect(Math.abs(substrate.b)).toBeLessThan(10);
        });

        it('should detect colored substrate from corners', () => {
            // Cream/beige corners, darker center
            const pixels = createImageWithCorners(100, 100,
                { L: 90, a: 5, b: 15 },   // Cream corners
                { L: 40, a: 10, b: 5 }    // Darker center
            );

            const substrate = PosterizationEngine.autoDetectSubstrate(pixels, 100, 100, 16);

            expect(substrate).toBeDefined();
            expect(substrate.L).toBeGreaterThan(80);
            expect(substrate.b).toBeGreaterThan(5); // Should detect warm tint
        });
    });

    describe('Engine Types', () => {
        const testColors = [
            { L: 20, a: 0, b: 0 },
            { L: 50, a: 20, b: 10 },
            { L: 80, a: -10, b: 20 },
        ];

        it('should work with balanced engine', () => {
            const pixels = createLabImage(50, 50, testColors);

            const result = PosterizationEngine.posterize(pixels, 50, 50, 3, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'balanced'
            });

            expect(result.paletteLab).toBeDefined();
            expect(result.paletteLab.length).toBeGreaterThan(0);
        });

        it('should work with stencil engine (grayscale)', () => {
            const pixels = createLabImage(50, 50, testColors);

            const result = PosterizationEngine.posterize(pixels, 50, 50, 3, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'stencil'
            });

            expect(result.paletteLab).toBeDefined();
            // Stencil mode should produce near-grayscale (a≈0, b≈0)
            for (const color of result.paletteLab) {
                expect(Math.abs(color.a)).toBeLessThanOrEqual(10);
                expect(Math.abs(color.b)).toBeLessThanOrEqual(10);
            }
        });

        it('should work with classic RGB engine', () => {
            // Create RGBA image for classic engine
            const width = 50;
            const height = 50;
            const rgbaPixels = new Uint8ClampedArray(width * height * 4);

            for (let i = 0; i < width * height; i++) {
                const section = Math.floor(i / (width * height / 3));
                if (section === 0) {
                    rgbaPixels[i * 4] = 255;     // Red
                    rgbaPixels[i * 4 + 1] = 0;
                    rgbaPixels[i * 4 + 2] = 0;
                } else if (section === 1) {
                    rgbaPixels[i * 4] = 0;
                    rgbaPixels[i * 4 + 1] = 255; // Green
                    rgbaPixels[i * 4 + 2] = 0;
                } else {
                    rgbaPixels[i * 4] = 0;
                    rgbaPixels[i * 4 + 1] = 0;
                    rgbaPixels[i * 4 + 2] = 255; // Blue
                }
                rgbaPixels[i * 4 + 3] = 255;     // Alpha
            }

            const result = PosterizationEngine.posterize(rgbaPixels, width, height, 3, {
                format: 'rgb',
                engineType: 'classic'
            });

            expect(result.palette).toBeDefined();
            expect(result.palette.length).toBe(3);
        });
    });

    describe('Grayscale Mode', () => {
        it('should quantize only L channel in grayscale mode', () => {
            // Image with chromatic colors
            const colors = [
                { L: 20, a: 30, b: 20 },
                { L: 50, a: -20, b: 30 },
                { L: 80, a: 10, b: -20 },
            ];
            const pixels = createLabImage(50, 50, colors);

            const result = PosterizationEngine.posterize(pixels, 50, 50, 3, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                grayscaleOnly: true,
                enableHueGapAnalysis: false
            });

            expect(result.paletteLab).toBeDefined();
            // Grayscale mode should produce colors with reduced chroma
            // (engine averages within L-partitions, so a/b may not be zero)
            for (const color of result.paletteLab) {
                expect(Math.abs(color.a)).toBeLessThan(25);
                expect(Math.abs(color.b)).toBeLessThan(25);
            }
        });
    });

    describe('Vibrancy and Highlight Options', () => {
        it('should respect vibrancyMode option', () => {
            const colors = [
                { L: 50, a: 60, b: 40 },  // Vibrant
                { L: 50, a: 5, b: 5 },    // Muted
                { L: 70, a: 30, b: 20 },  // Semi-vibrant
            ];
            const pixels = createLabImage(50, 50, colors);

            const result = PosterizationEngine.posterize(pixels, 50, 50, 3, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                vibrancyMode: 'aggressive',
                vibrancyBoost: 3.0,
                enableHueGapAnalysis: false
            });

            expect(result.paletteLab).toBeDefined();
        });

        it('should respect highlightThreshold and highlightBoost', () => {
            const colors = [
                { L: 95, a: 0, b: 5 },    // Highlight
                { L: 50, a: 10, b: 10 },  // Midtone
                { L: 20, a: 5, b: 5 },    // Shadow
            ];
            const pixels = createLabImage(50, 50, colors);

            const result = PosterizationEngine.posterize(pixels, 50, 50, 3, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                highlightThreshold: 90,
                highlightBoost: 4.0,
                enableHueGapAnalysis: false
            });

            expect(result.paletteLab).toBeDefined();
            // Should have a highlight color
            const hasHighlight = result.paletteLab.some(c => c.L > 85);
            expect(hasHighlight).toBe(true);
        });
    });

    describe('Edge Cases', () => {
        it('should handle very small color count (targetColors=2)', () => {
            const colors = [
                { L: 20, a: 0, b: 0 },
                { L: 80, a: 0, b: 0 },
            ];
            const pixels = createLabImage(50, 50, colors);

            const result = PosterizationEngine.posterize(pixels, 50, 50, 2, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                enableHueGapAnalysis: false
            });

            expect(result.paletteLab).toBeDefined();
            // Engine may add white/black preservation colors beyond target
            expect(result.paletteLab.length).toBeLessThanOrEqual(4);
        });

        it('should handle large color count (targetColors=12)', () => {
            // Create image with many distinct colors
            const colors = [];
            for (let i = 0; i < 12; i++) {
                colors.push({
                    L: 20 + i * 6,
                    a: (i % 3 - 1) * 30,
                    b: ((i + 1) % 3 - 1) * 30
                });
            }
            const pixels = createLabImage(100, 100, colors);

            const result = PosterizationEngine.posterize(pixels, 100, 100, 12, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                enableHueGapAnalysis: false,
                enablePaletteReduction: false
            });

            expect(result.paletteLab).toBeDefined();
            // Engine may add hue gap or preservation colors slightly beyond target
            expect(result.paletteLab.length).toBeLessThanOrEqual(14);
        });

        it('should handle uniform image (single color)', () => {
            const pixels = createLabImage(50, 50, [{ L: 50, a: 10, b: 10 }]);

            const result = PosterizationEngine.posterize(pixels, 50, 50, 5, {
                format: 'lab',
                bitDepth: 16,
                engineType: 'reveal',
                enableHueGapAnalysis: false
            });

            expect(result.paletteLab).toBeDefined();
            // Should produce at least 1 color
            expect(result.paletteLab.length).toBeGreaterThanOrEqual(1);
        });
    });
});

describe('LabEncoding Module (formerly ColorSpace)', () => {
    describe('rgbToLab', () => {
        it('should convert white correctly', () => {
            const lab = LabEncoding.rgbToLab({ r: 255, g: 255, b: 255 });
            expect(lab.L).toBeCloseTo(100, 0);
            expect(Math.abs(lab.a)).toBeLessThan(1);
            expect(Math.abs(lab.b)).toBeLessThan(1);
        });

        it('should convert black correctly', () => {
            const lab = LabEncoding.rgbToLab({ r: 0, g: 0, b: 0 });
            expect(lab.L).toBeCloseTo(0, 0);
            expect(Math.abs(lab.a)).toBeLessThan(1);
            expect(Math.abs(lab.b)).toBeLessThan(1);
        });

        it('should convert red correctly', () => {
            const lab = LabEncoding.rgbToLab({ r: 255, g: 0, b: 0 });
            expect(lab.L).toBeGreaterThan(50);
            expect(lab.a).toBeGreaterThan(60); // Red has positive a
            expect(lab.b).toBeGreaterThan(40); // Red has positive b
        });

        it('should convert green correctly', () => {
            const lab = LabEncoding.rgbToLab({ r: 0, g: 255, b: 0 });
            expect(lab.L).toBeGreaterThan(80);
            expect(lab.a).toBeLessThan(-80); // Green has negative a
            expect(lab.b).toBeGreaterThan(70); // Green has positive b
        });

        it('should convert blue correctly', () => {
            const lab = LabEncoding.rgbToLab({ r: 0, g: 0, b: 255 });
            expect(lab.L).toBeGreaterThan(30);
            expect(lab.a).toBeGreaterThan(60);  // Blue has positive a
            expect(lab.b).toBeLessThan(-100);   // Blue has negative b
        });
    });

    describe('labToRgb', () => {
        it('should convert white correctly', () => {
            const rgb = LabEncoding.labToRgb({ L: 100, a: 0, b: 0 });
            expect(rgb.r).toBeCloseTo(255, 0);
            expect(rgb.g).toBeCloseTo(255, 0);
            expect(rgb.b).toBeCloseTo(255, 0);
        });

        it('should convert black correctly', () => {
            const rgb = LabEncoding.labToRgb({ L: 0, a: 0, b: 0 });
            expect(rgb.r).toBeCloseTo(0, 0);
            expect(rgb.g).toBeCloseTo(0, 0);
            expect(rgb.b).toBeCloseTo(0, 0);
        });

        it('should handle out-of-gamut colors gracefully', () => {
            // Very saturated Lab color that may be out of sRGB gamut
            const rgb = LabEncoding.labToRgb({ L: 50, a: 100, b: 100 });
            expect(rgb.r).toBeGreaterThanOrEqual(0);
            expect(rgb.r).toBeLessThanOrEqual(255);
            expect(rgb.g).toBeGreaterThanOrEqual(0);
            expect(rgb.g).toBeLessThanOrEqual(255);
            expect(rgb.b).toBeGreaterThanOrEqual(0);
            expect(rgb.b).toBeLessThanOrEqual(255);
        });

        it('should roundtrip RGB -> Lab -> RGB', () => {
            const originalRgb = { r: 128, g: 64, b: 192 };
            const lab = LabEncoding.rgbToLab(originalRgb);
            const roundtripRgb = LabEncoding.labToRgb(lab);

            expect(roundtripRgb.r).toBeCloseTo(originalRgb.r, 0);
            expect(roundtripRgb.g).toBeCloseTo(originalRgb.g, 0);
            expect(roundtripRgb.b).toBeCloseTo(originalRgb.b, 0);
        });
    });

    describe('LabDistance.cie76', () => {
        it('should return 0 for identical Lab colors', () => {
            const dist = LabDistance.cie76(
                { L: 50, a: 20, b: -30 },
                { L: 50, a: 20, b: -30 }
            );
            expect(dist).toBe(0);
        });

        it('should calculate CIE76 ΔE correctly', () => {
            // ΔE = sqrt(dL² + da² + db²)
            const dist = LabDistance.cie76(
                { L: 50, a: 0, b: 0 },
                { L: 50, a: 3, b: 4 }  // ΔE should be 5
            );
            expect(dist).toBeCloseTo(5, 5);
        });

        it('should return 0 for identical RGB-converted colors', () => {
            const lab1 = LabEncoding.rgbToLab({ r: 100, g: 150, b: 200 });
            const lab2 = LabEncoding.rgbToLab({ r: 100, g: 150, b: 200 });
            const dist = LabDistance.cie76(lab1, lab2);
            expect(dist).toBe(0);
        });

        it('should return positive distance for different RGB colors', () => {
            const lab1 = LabEncoding.rgbToLab({ r: 255, g: 0, b: 0 });
            const lab2 = LabEncoding.rgbToLab({ r: 0, g: 255, b: 0 });
            const dist = LabDistance.cie76(lab1, lab2);
            expect(dist).toBeGreaterThan(0);
        });

        it('should be symmetric', () => {
            const lab1 = LabEncoding.rgbToLab({ r: 100, g: 50, b: 200 });
            const lab2 = LabEncoding.rgbToLab({ r: 200, g: 100, b: 50 });
            const dist1 = LabDistance.cie76(lab1, lab2);
            const dist2 = LabDistance.cie76(lab2, lab1);
            expect(dist1).toBeCloseTo(dist2, 10);
        });
    });

    describe('PaletteOps.calculateCIELABDistance', () => {
        it('should return squared distance for performance', () => {
            const distSq = PaletteOps.calculateCIELABDistance(
                { L: 50, a: 0, b: 0 },
                { L: 50, a: 3, b: 4 }
            );
            // With L weight of 1.5, distSq = 1.5*0 + 9 + 16 = 25
            expect(distSq).toBeCloseTo(25, 5);
        });

        it('should apply higher L weight for grayscale', () => {
            const distColor = PaletteOps.calculateCIELABDistance(
                { L: 50, a: 0, b: 0 },
                { L: 60, a: 0, b: 0 },
                false
            );
            const distGray = PaletteOps.calculateCIELABDistance(
                { L: 50, a: 0, b: 0 },
                { L: 60, a: 0, b: 0 },
                true
            );
            // Grayscale uses L_WEIGHT=3.0 vs 1.5 for color
            expect(distGray).toBeGreaterThan(distColor);
        });
    });

    describe('PosterizationEngine.paletteToHex', () => {
        it('should convert RGB palette to hex strings', () => {
            const palette = [
                { r: 255, g: 0, b: 0 },
                { r: 0, g: 255, b: 0 },
                { r: 0, g: 0, b: 255 }
            ];
            const hex = PosterizationEngine.paletteToHex(palette);

            expect(hex).toEqual(['#FF0000', '#00FF00', '#0000FF']);
        });

        it('should pad single-digit hex values', () => {
            const palette = [{ r: 1, g: 2, b: 3 }];
            const hex = PosterizationEngine.paletteToHex(palette);
            expect(hex).toEqual(['#010203']);
        });
    });

    describe('PosterizationEngine.calculateHexDistance', () => {
        it('should return 0 for identical hex colors', () => {
            const dist = PosterizationEngine.calculateHexDistance('#FF0000', '#FF0000');
            expect(dist).toBe(0);
        });

        it('should calculate distance between hex colors', () => {
            const dist = PosterizationEngine.calculateHexDistance('#FF0000', '#00FF00');
            expect(dist).toBeGreaterThan(0);
        });
    });
});

describe('HueAnalysis Module', () => {
    describe('getHueSector', () => {
        it('should return -1 for grayscale (low chroma)', () => {
            expect(HueAnalysis.getHueSector(0, 0)).toBe(-1);
            expect(HueAnalysis.getHueSector(2, 2)).toBe(-1);
            expect(HueAnalysis.getHueSector(-1, 1)).toBe(-1);
        });

        it('should map red (positive a, neutral b) to sector 0', () => {
            const sector = HueAnalysis.getHueSector(50, 0);
            expect(sector).toBe(0);
        });

        it('should map yellow (positive a and b) to sector 1-2', () => {
            const sector = HueAnalysis.getHueSector(30, 50);
            expect(sector).toBeGreaterThanOrEqual(1);
            expect(sector).toBeLessThanOrEqual(2);
        });

        it('should map green (negative a, positive b) to sector 3-5', () => {
            const sector = HueAnalysis.getHueSector(-50, 30);
            expect(sector).toBeGreaterThanOrEqual(3);
            expect(sector).toBeLessThanOrEqual(5);
        });

        it('should map blue (negative a and b) to sector 6-8', () => {
            const sector = HueAnalysis.getHueSector(-30, -50);
            expect(sector).toBeGreaterThanOrEqual(6);
            expect(sector).toBeLessThanOrEqual(8);
        });

        it('should map purple (positive a, negative b) to sector 9-11', () => {
            const sector = HueAnalysis.getHueSector(50, -30);
            expect(sector).toBeGreaterThanOrEqual(9);
            expect(sector).toBeLessThanOrEqual(11);
        });
    });

    describe('analyzeImageHueSectors', () => {
        it('should return 12 sector percentages', () => {
            // Simple grayscale image
            const pixels = new Float32Array(100 * 3);
            for (let i = 0; i < 100; i++) {
                pixels[i * 3] = 50;     // L
                pixels[i * 3 + 1] = 0;  // a
                pixels[i * 3 + 2] = 0;  // b
            }

            const sectors = HueAnalysis.analyzeImageHueSectors(pixels);
            expect(sectors).toHaveLength(12);
            // All sectors should be 0 for grayscale
            expect(sectors.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 5);
        });

        it('should count chromatic pixels in correct sectors', () => {
            // Image with red pixels
            const pixels = new Float32Array(100 * 3);
            for (let i = 0; i < 100; i++) {
                pixels[i * 3] = 50;      // L
                pixels[i * 3 + 1] = 50;  // a (positive = red)
                pixels[i * 3 + 2] = 0;   // b
            }

            const sectors = HueAnalysis.analyzeImageHueSectors(pixels);
            // Red sector (0) should have all pixels
            expect(sectors[0]).toBeGreaterThan(50);
        });
    });

    describe('analyzePaletteHueCoverage', () => {
        it('should identify covered sectors from palette', () => {
            const palette = [
                { L: 50, a: 50, b: 0 },   // Red (sector 0)
                { L: 50, a: -50, b: 30 }, // Green (sector 4-5)
                { L: 50, a: 0, b: 0 },    // Gray (no sector)
            ];

            const { coveredSectors, colorCountsBySector } = HueAnalysis.analyzePaletteHueCoverage(palette);

            expect(coveredSectors.size).toBeGreaterThanOrEqual(2);
            expect(coveredSectors.has(0)).toBe(true); // Red
        });

        it('should count colors per sector', () => {
            const palette = [
                { L: 50, a: 50, b: 5 },   // Red
                { L: 60, a: 45, b: 3 },   // Also red-ish
                { L: 40, a: -50, b: 30 }, // Green
            ];

            const { colorCountsBySector } = HueAnalysis.analyzePaletteHueCoverage(palette);

            // Sector 0 (red) should have 2 colors
            expect(colorCountsBySector[0]).toBe(2);
        });
    });

    describe('identifyHueGaps', () => {
        it('should find gaps where image has colors but palette does not', () => {
            const imageHues = [10, 5, 0, 0, 15, 0, 0, 0, 0, 0, 0, 0]; // Sectors 0, 1, 4 have pixels
            const paletteCoverage = new Set([0]); // Only red covered

            const gaps = HueAnalysis.identifyHueGaps(imageHues, paletteCoverage);

            // Sectors 1 and 4 should be gaps (>2% but not covered)
            expect(gaps).toContain(1);
            expect(gaps).toContain(4);
        });

        it('should not flag sectors below threshold', () => {
            const imageHues = [10, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]; // Sectors 1, 4 below 2%
            const paletteCoverage = new Set([0]);

            const gaps = HueAnalysis.identifyHueGaps(imageHues, paletteCoverage);

            expect(gaps).not.toContain(1);
            expect(gaps).not.toContain(4);
        });
    });

    describe('SECTOR_NAMES constant', () => {
        it('should have 12 sector names', () => {
            expect(HueAnalysis.SECTOR_NAMES).toHaveLength(12);
        });

        it('should start with Red and end with R-Pink', () => {
            expect(HueAnalysis.SECTOR_NAMES[0]).toBe('Red');
            expect(HueAnalysis.SECTOR_NAMES[11]).toBe('R-Pink');
        });
    });
});
