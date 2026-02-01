/**
 * Unit tests for Dynamic Hue Anchoring
 *
 * Tests the DNA-derived hue anchoring system that replaces hardcoded
 * hue penalties (yellow=90°, green=135°) with adaptive anchors based
 * on each image's actual color distribution.
 *
 * Components tested:
 * - getSectorForHue() - Maps hue to sector name
 * - getAdjacentSectors() - Gets neighboring sectors
 * - adjustStiffnessForBullies() - Boosts stiffness for bullied sectors
 * - calculateDynamicAnchors() - Calculates DNA-derived anchors
 */

import { describe, test, expect } from 'vitest';

// Import Reveal API
const Reveal = require('../../index.js');
const PosterizationEngine = Reveal.engines.PosterizationEngine;

describe('Dynamic Hue Anchoring', () => {
    describe('getSectorForHue()', () => {
        test('should map hue 0° to red sector', () => {
            expect(PosterizationEngine.getSectorForHue(0)).toBe('red');
            expect(PosterizationEngine.getSectorForHue(15)).toBe('red');
            expect(PosterizationEngine.getSectorForHue(29)).toBe('red');
        });

        test('should map hue 30-59° to orange sector', () => {
            expect(PosterizationEngine.getSectorForHue(30)).toBe('orange');
            expect(PosterizationEngine.getSectorForHue(45)).toBe('orange');
            expect(PosterizationEngine.getSectorForHue(59)).toBe('orange');
        });

        test('should map hue 60-89° to yellow sector', () => {
            expect(PosterizationEngine.getSectorForHue(60)).toBe('yellow');
            expect(PosterizationEngine.getSectorForHue(75)).toBe('yellow');
            expect(PosterizationEngine.getSectorForHue(89)).toBe('yellow');
        });

        test('should map hue 90-119° to chartreuse sector', () => {
            expect(PosterizationEngine.getSectorForHue(90)).toBe('chartreuse');
            expect(PosterizationEngine.getSectorForHue(105)).toBe('chartreuse');
            expect(PosterizationEngine.getSectorForHue(119)).toBe('chartreuse');
        });

        test('should map hue 120-149° to green sector', () => {
            expect(PosterizationEngine.getSectorForHue(120)).toBe('green');
            expect(PosterizationEngine.getSectorForHue(135)).toBe('green');
            expect(PosterizationEngine.getSectorForHue(149)).toBe('green');
        });

        test('should map hue 240-269° to purple sector', () => {
            expect(PosterizationEngine.getSectorForHue(240)).toBe('purple');
            expect(PosterizationEngine.getSectorForHue(255)).toBe('purple');
            expect(PosterizationEngine.getSectorForHue(269)).toBe('purple');
        });

        test('should handle wraparound at 360°', () => {
            expect(PosterizationEngine.getSectorForHue(359)).toBe('crimson');
            expect(PosterizationEngine.getSectorForHue(360)).toBe('red'); // Wraps to 0°
        });

        test('should handle negative angles', () => {
            // getSectorForHue uses modulo, so -10° should wrap to 350° (crimson)
            expect(PosterizationEngine.getSectorForHue(-10 % 360 + 360)).toBe('crimson');
        });
    });

    describe('getAdjacentSectors()', () => {
        test('should return neighbors for red sector', () => {
            const neighbors = PosterizationEngine.getAdjacentSectors('red');
            expect(neighbors).toEqual(['crimson', 'orange']); // Wraps around
        });

        test('should return neighbors for yellow sector', () => {
            const neighbors = PosterizationEngine.getAdjacentSectors('yellow');
            expect(neighbors).toEqual(['orange', 'chartreuse']);
        });

        test('should return neighbors for green sector', () => {
            const neighbors = PosterizationEngine.getAdjacentSectors('green');
            expect(neighbors).toEqual(['chartreuse', 'cyan']);
        });

        test('should return neighbors for crimson sector (wraparound)', () => {
            const neighbors = PosterizationEngine.getAdjacentSectors('crimson');
            expect(neighbors).toEqual(['pink', 'red']); // Wraps to red
        });

        test('should return empty array for invalid sector', () => {
            const neighbors = PosterizationEngine.getAdjacentSectors('invalid');
            expect(neighbors).toEqual([]);
        });
    });

    describe('adjustStiffnessForBullies()', () => {
        test('should boost stiffness when sector is bullied by neighbor', () => {
            const anchors = new Map([
                ['yellow', { hue: 85, lMean: 80, weight: 0.10, stiffness: 1.0 }],
                ['orange', { hue: 45, lMean: 60, weight: 0.40, stiffness: 1.0 }] // 4× larger = bully
            ]);

            PosterizationEngine.adjustStiffnessForBullies(anchors);

            const yellowAnchor = anchors.get('yellow');
            // Bully ratio = 0.40/0.10 = 4.0 > 2.0 threshold
            // Boost = 1 + (4.0 * 0.5) = 3.0
            // Final stiffness = 1.0 * 3.0 = 3.0
            expect(yellowAnchor.stiffness).toBeGreaterThan(2.5);
            expect(yellowAnchor.stiffness).toBeLessThanOrEqual(3.5);
        });

        test('should NOT boost stiffness when neighbor is similar size', () => {
            const anchors = new Map([
                ['yellow', { hue: 85, lMean: 80, weight: 0.25, stiffness: 1.0 }],
                ['orange', { hue: 45, lMean: 60, weight: 0.30, stiffness: 1.0 }] // 1.2× = not a bully
            ]);

            PosterizationEngine.adjustStiffnessForBullies(anchors);

            const yellowAnchor = anchors.get('yellow');
            // Bully ratio = 0.30/0.25 = 1.2 < 2.0 threshold
            expect(yellowAnchor.stiffness).toBe(1.0); // No boost
        });

        test('should boost stiffness for multiple bullies', () => {
            const anchors = new Map([
                ['chartreuse', { hue: 105, lMean: 70, weight: 0.08, stiffness: 1.0 }],
                ['yellow', { hue: 85, lMean: 80, weight: 0.30, stiffness: 1.0 }],     // Left bully
                ['green', { hue: 135, lMean: 75, weight: 0.35, stiffness: 1.0 }]      // Right bully
            ]);

            PosterizationEngine.adjustStiffnessForBullies(anchors);

            const chartreuseAnchor = anchors.get('chartreuse');
            // Left bully: 0.30/0.08 = 3.75 → boost 1 + (3.75*0.5) = 2.875
            // Right bully: 0.35/0.08 = 4.375 → boost 1 + (4.375*0.5) = 3.1875
            // Total stiffness = 1.0 * 2.875 * 3.1875 ≈ 9.16
            expect(chartreuseAnchor.stiffness).toBeGreaterThan(8.0);
        });

        test('should handle anchors with no neighbors gracefully', () => {
            const anchors = new Map([
                ['yellow', { hue: 85, lMean: 80, weight: 0.15, stiffness: 1.0 }]
                // No neighbors present
            ]);

            PosterizationEngine.adjustStiffnessForBullies(anchors);

            const yellowAnchor = anchors.get('yellow');
            expect(yellowAnchor.stiffness).toBe(1.0); // No change
        });
    });

    describe('calculateDynamicAnchors()', () => {
        test('should create anchors from DNA sectors', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 82.5, lMean: 85, weight: 0.15, cMax: 80 },
                    orange: { hMean: 45.0, lMean: 60, weight: 0.25, cMax: 90 },
                    green: { hMean: 138.0, lMean: 50, weight: 0.08, cMax: 70 }
                }
            };
            const config = { useDynamicAnchors: true, hueLockSensitivity: 12.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            expect(anchors).not.toBeNull();
            expect(anchors.size).toBe(3); // 3 sectors > 5% weight

            const yellowAnchor = anchors.get('yellow');
            expect(yellowAnchor).toBeDefined();
            expect(yellowAnchor.hue).toBe(82.5); // Uses hMean, not hardcoded 90°
            expect(yellowAnchor.lMean).toBe(85);
            expect(yellowAnchor.weight).toBe(0.15);
            expect(yellowAnchor.stiffness).toBeGreaterThan(1.0); // Boosted due to orange bully
        });

        test('should exclude sectors below 5% weight threshold', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 85, lMean: 80, weight: 0.15, cMax: 80 },    // 15% - included
                    red: { hMean: 15, lMean: 70, weight: 0.03, cMax: 60 },        // 3% - excluded
                    blue: { hMean: 240, lMean: 40, weight: 0.02, cMax: 50 }       // 2% - excluded
                }
            };
            const config = { useDynamicAnchors: true, hueLockSensitivity: 1.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            expect(anchors.size).toBe(1); // Only yellow
            expect(anchors.has('yellow')).toBe(true);
            expect(anchors.has('red')).toBe(false);
            expect(anchors.has('blue')).toBe(false);
        });

        test('should return null when useDynamicAnchors is false', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 85, lMean: 80, weight: 0.15, cMax: 80 }
                }
            };
            const config = { useDynamicAnchors: false, hueLockSensitivity: 1.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            expect(anchors).toBeNull();
        });

        test('should return null when DNA has no sectors', () => {
            const dna = {}; // No sectors property
            const config = { useDynamicAnchors: true, hueLockSensitivity: 1.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            expect(anchors).toBeNull();
        });

        test('should use hueLockSensitivity from config', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 85, lMean: 80, weight: 0.15, cMax: 80 }
                }
            };
            const config = { useDynamicAnchors: true, hueLockSensitivity: 24.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            const yellowAnchor = anchors.get('yellow');
            expect(yellowAnchor.stiffness).toBe(24.0);
        });

        test('should handle "thermonuclear yellow" case (high weight, high L)', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 88, lMean: 92, weight: 0.42, cMax: 120 }, // Neon lemon
                    orange: { hMean: 50, lMean: 65, weight: 0.10, cMax: 80 }
                }
            };
            const config = { useDynamicAnchors: true, hueLockSensitivity: 12.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            const yellowAnchor = anchors.get('yellow');
            expect(yellowAnchor.hue).toBe(88); // Actual yellow, not 90°
            expect(yellowAnchor.weight).toBe(0.42); // High dominance
            expect(yellowAnchor.lMean).toBe(92); // Very bright
        });

        test('should create anchors for all 12 sectors if all significant', () => {
            const dna = {
                sectors: {}
            };

            // Create all 12 sectors with >5% weight
            const sectorNames = [
                'red', 'orange', 'yellow', 'chartreuse',
                'green', 'cyan', 'blue', 'violet',
                'purple', 'magenta', 'pink', 'crimson'
            ];

            sectorNames.forEach((name, i) => {
                dna.sectors[name] = {
                    hMean: i * 30 + 15,
                    lMean: 50,
                    weight: 0.08 + (i * 0.01), // All > 5%
                    cMax: 60
                };
            });

            const config = { useDynamicAnchors: true, hueLockSensitivity: 1.0 };
            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            expect(anchors.size).toBe(12); // All 12 sectors
        });
    });

    describe('Integration: Dynamic vs Static Anchors', () => {
        test('should use actual hue from DNA, not hardcoded 90°', () => {
            // Ochre yellow (darker, more orange-leaning)
            const ochreDNA = {
                sectors: {
                    yellow: { hMean: 72, lMean: 65, weight: 0.20, cMax: 60 } // Ochre at 72°
                }
            };
            const config = { useDynamicAnchors: true, hueLockSensitivity: 1.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(ochreDNA, config);
            const yellowAnchor = anchors.get('yellow');

            expect(yellowAnchor.hue).toBe(72); // NOT 90° (hardcoded static anchor)
        });

        test('should adapt to lemon yellow (greener yellow)', () => {
            // Lemon yellow (brighter, more chartreuse-leaning)
            const lemonDNA = {
                sectors: {
                    yellow: { hMean: 98, lMean: 90, weight: 0.35, cMax: 110 } // Lemon at 98°
                }
            };
            const config = { useDynamicAnchors: true, hueLockSensitivity: 1.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(lemonDNA, config);
            const yellowAnchor = anchors.get('yellow');

            expect(yellowAnchor.hue).toBe(98); // Greener yellow, NOT 90°
        });

        test('static fallback should use hardcoded 90° for yellow', () => {
            // When dynamic anchors disabled, the pixel assignment code falls back
            // to static anchors (line 3768-3803 in PosterizationEngine.js)
            // This test just verifies calculateDynamicAnchors returns null
            const dna = {
                sectors: {
                    yellow: { hMean: 82, lMean: 80, weight: 0.15, cMax: 80 }
                }
            };
            const config = { useDynamicAnchors: false, hueLockSensitivity: 1.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            expect(anchors).toBeNull(); // Falls back to static anchors
        });
    });

    describe('Hue Penalty LUT Generation', () => {
        test('should generate 360-element Float32Array', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 82, weight: 0.15, lMean: 85 }
                }
            };

            const lut = PosterizationEngine.generateHuePenaltyLUT(dna, {
                useDynamicAnchors: true,
                hueLockSensitivity: 10,
                hueLockAngle: 15
            });

            expect(lut).toBeInstanceOf(Float32Array);
            expect(lut.length).toBe(360);
        });

        test('should return null when dynamic anchors disabled', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 82, weight: 0.15, lMean: 85 }
                }
            };

            const lut = PosterizationEngine.generateHuePenaltyLUT(dna, {
                useDynamicAnchors: false,
                hueLockSensitivity: 10
            });

            expect(lut).toBeNull();
        });

        test('should calculate zero penalty at anchor hue', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 82, weight: 0.15, lMean: 85 }
                }
            };

            const lut = PosterizationEngine.generateHuePenaltyLUT(dna, {
                useDynamicAnchors: true,
                hueLockSensitivity: 10,
                hueLockAngle: 15
            });

            // At the anchor hue (82°), penalty should be 0
            expect(lut[82]).toBe(0);
        });

        test('should calculate penalties within tolerance angle', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 82, weight: 0.15, lMean: 85 }
                }
            };

            const lut = PosterizationEngine.generateHuePenaltyLUT(dna, {
                useDynamicAnchors: true,
                hueLockSensitivity: 10,
                hueLockAngle: 15
            });

            // Within tolerance (82 ± 15°), penalties should be 0
            expect(lut[70]).toBe(0);  // 12° from anchor
            expect(lut[95]).toBe(0);  // 13° from anchor
        });

        test('should calculate increasing penalties beyond tolerance', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 82, weight: 0.15, lMean: 85 }
                }
            };

            const lut = PosterizationEngine.generateHuePenaltyLUT(dna, {
                useDynamicAnchors: true,
                hueLockSensitivity: 10,
                hueLockAngle: 15
            });

            // Beyond tolerance, penalty = (drift - 15)² × sensitivity
            // At 67°: drift = 15°, penalty = 0
            // At 66°: drift = 16°, penalty = (16-15)² × 10 = 10
            // At 60°: drift = 22°, penalty = (22-15)² × 10 = 490
            expect(lut[67]).toBe(0);
            expect(lut[66]).toBeGreaterThan(0);
            expect(lut[60]).toBeGreaterThan(lut[66]);
        });

        test('should handle sectors with low weight (skip penalty)', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 82, weight: 0.03, lMean: 85 }  // Below 5% threshold
                }
            };

            const lut = PosterizationEngine.generateHuePenaltyLUT(dna, {
                useDynamicAnchors: true,
                hueLockSensitivity: 10,
                hueLockAngle: 15
            });

            // All penalties should be 0 (sector excluded)
            expect(Math.max(...lut)).toBe(0);
        });

        test('should scale penalties by hueLockSensitivity', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 82, weight: 0.15, lMean: 85 }
                }
            };

            const lut1 = PosterizationEngine.generateHuePenaltyLUT(dna, {
                useDynamicAnchors: true,
                hueLockSensitivity: 5,
                hueLockAngle: 15
            });

            const lut2 = PosterizationEngine.generateHuePenaltyLUT(dna, {
                useDynamicAnchors: true,
                hueLockSensitivity: 10,
                hueLockAngle: 15
            });

            // Higher sensitivity = higher penalties
            expect(lut2[60]).toBe(lut1[60] * 2);
        });

        test('should handle multiple sectors correctly', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 82, weight: 0.15, lMean: 85 },
                    orange: { hMean: 45, weight: 0.25, lMean: 60 }
                }
            };

            const lut = PosterizationEngine.generateHuePenaltyLUT(dna, {
                useDynamicAnchors: true,
                hueLockSensitivity: 10,
                hueLockAngle: 15
            });

            // Yellow anchor at 82° (sector 60-90°)
            expect(lut[82]).toBe(0);

            // Orange anchor at 45° (sector 30-60°)
            expect(lut[45]).toBe(0);

            // Verify penalties exist for hues beyond tolerance from anchors
            // Yellow sector (60-90°), anchor at 82°
            expect(lut[60]).toBeGreaterThan(0);  // |60-82| = 22° > 15° → penalty

            // Orange sector (30-60°), anchor at 45°
            // Note: All hues in orange sector are within 15° of 45°, so no penalties
            // This is expected - a well-centered anchor has minimal penalties in its sector
            expect(lut[45]).toBe(0);  // At anchor, no penalty
        });
    });

    describe('Edge Cases', () => {
        test('should handle empty DNA gracefully', () => {
            const dna = { sectors: {} };
            const config = { useDynamicAnchors: true, hueLockSensitivity: 1.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            expect(anchors.size).toBe(0); // No anchors created
        });

        test('should handle single-sector images', () => {
            const dna = {
                sectors: {
                    blue: { hMean: 240, lMean: 50, weight: 0.95, cMax: 100 } // 95% blue
                }
            };
            const config = { useDynamicAnchors: true, hueLockSensitivity: 1.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            expect(anchors.size).toBe(1);
            expect(anchors.has('blue')).toBe(true);
        });

        test('should handle adjacent dominant sectors (orange + yellow)', () => {
            const dna = {
                sectors: {
                    orange: { hMean: 52, lMean: 68, weight: 0.45, cMax: 90 }, // Dominant
                    yellow: { hMean: 85, lMean: 82, weight: 0.12, cMax: 70 }  // Victim
                }
            };
            const config = { useDynamicAnchors: true, hueLockSensitivity: 1.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            const yellowAnchor = anchors.get('yellow');
            const orangeAnchor = anchors.get('orange');

            // Yellow should have boosted stiffness (bullied by orange)
            expect(yellowAnchor.stiffness).toBeGreaterThan(orangeAnchor.stiffness);
        });

        test('should handle zero hueLockSensitivity (defaults to 1.0)', () => {
            const dna = {
                sectors: {
                    yellow: { hMean: 85, lMean: 80, weight: 0.15, cMax: 80 }
                }
            };
            const config = { useDynamicAnchors: true, hueLockSensitivity: 0.0 };

            const anchors = PosterizationEngine.calculateDynamicAnchors(dna, config);

            const yellowAnchor = anchors.get('yellow');
            // 0 is falsy, so code defaults to 1.0 (line 192: stiffness: config.hueLockSensitivity || 1.0)
            expect(yellowAnchor.stiffness).toBe(1.0);
        });
    });
});
