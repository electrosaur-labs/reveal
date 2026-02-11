/**
 * Unit Tests for DNA v2.0 Archetype Mapping System
 * Tests DNAGenerator and ArchetypeMapper with synthetic test cases
 */

const DNAGenerator = require('../../lib/analysis/DNAGenerator');
const ArchetypeMapper = require('../../lib/analysis/ArchetypeMapper');
const fs = require('fs');
const path = require('path');

describe('DNAGenerator v2.0', () => {
    let generator;

    beforeAll(() => {
        generator = new DNAGenerator();
    });

    describe('8-bit Lab pixel processing', () => {
        it('should calculate global statistics correctly', () => {
            // Create simple 8-bit Lab image: 100 pixels, all mid-gray (L=50, a=128, b=128)
            const labPixels = new Uint8Array(100 * 3);
            for (let i = 0; i < labPixels.length; i += 3) {
                labPixels[i] = 127;     // L = 50
                labPixels[i + 1] = 128; // a = 0 (neutral)
                labPixels[i + 2] = 128; // b = 0 (neutral)
            }

            const dna = generator.generate(labPixels, 10, 10, { bitDepth: 8 });

            expect(dna.version).toBe('2.0');
            expect(dna.global.l).toBeCloseTo(50, 0); // 8-bit: L=127/255*100 ≈ 49.8
            expect(dna.global.c).toBeCloseTo(0, 0);
            expect(dna.global.l_std_dev).toBeCloseTo(0, 0);
            expect(dna.global.hue_entropy).toBeCloseTo(0, 0); // Achromatic
        });

        it('should detect monochromatic blue image', () => {
            // 100 pixels: blue (L=50, a=-10, b=-40)
            // hue = atan2(-40, -10) ≈ 256° → blue sector (195-225°)?
            // Actually we need a=-10, b=-40 → hue ≈ 256° = purple (225-255°)
            // For true blue (195-225°): a=-30, b=-20 → hue ≈ 213° ✓
            const labPixels = new Uint8Array(100 * 3);
            for (let i = 0; i < labPixels.length; i += 3) {
                labPixels[i] = 127;     // L = 50
                labPixels[i + 1] = 98;  // a = -30
                labPixels[i + 2] = 108; // b = -20 → hue ≈ 213° (blue sector 195-225°)
            }

            const dna = generator.generate(labPixels, 10, 10, { bitDepth: 8 });

            expect(dna.global.c).toBeGreaterThan(20); // Chromatic
            expect(dna.global.hue_entropy).toBeLessThan(0.3); // Monochromatic
            expect(dna.global.temperature_bias).toBeLessThan(0); // Cool
            expect(dna.dominant_sector).toBe('blue');
        });

        it('should detect rainbow (high entropy) image', () => {
            // 12 pixels, one for each sector
            const labPixels = new Uint8Array(12 * 3);
            const hues = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

            hues.forEach((h, i) => {
                const rad = (h * Math.PI) / 180;
                const a = 40 * Math.cos(rad);
                const b = 40 * Math.sin(rad);

                labPixels[i * 3] = 127;           // L = 50
                labPixels[i * 3 + 1] = 128 + a;   // a
                labPixels[i * 3 + 2] = 128 + b;   // b
            });

            const dna = generator.generate(labPixels, 3, 4, { bitDepth: 8 });

            expect(dna.global.hue_entropy).toBeGreaterThan(0.85); // High diversity
            expect(dna.global.c).toBeGreaterThan(20);
        });

        it('should calculate temperature bias correctly', () => {
            // Warm image (high +b values)
            const labPixels = new Uint8Array(100 * 3);
            for (let i = 0; i < labPixels.length; i += 3) {
                labPixels[i] = 127;     // L = 50
                labPixels[i + 1] = 128; // a = 0
                labPixels[i + 2] = 178; // b = +50 (warm)
            }

            const dna = generator.generate(labPixels, 10, 10, { bitDepth: 8 });

            expect(dna.global.temperature_bias).toBeGreaterThan(0.5); // Warm
        });
    });

    describe('16-bit Lab pixel processing', () => {
        it('should normalize 16-bit values correctly', () => {
            // 100 pixels: mid-gray in 16-bit format
            const labPixels = new Uint16Array(100 * 3);
            for (let i = 0; i < labPixels.length; i += 3) {
                labPixels[i] = 16384;     // L = 50
                labPixels[i + 1] = 16384; // a = 0
                labPixels[i + 2] = 16384; // b = 0
            }

            const dna = generator.generate(labPixels, 10, 10, { bitDepth: 16 });

            expect(dna.global.l).toBeCloseTo(50, 1);
            expect(dna.global.c).toBeCloseTo(0, 1);
        });
    });
});

describe('ArchetypeMapper v2.2', () => {
    let mapper;
    let archetypes;

    beforeAll(() => {
        // Load real archetypes from JSON files
        const archetypeDir = path.join(__dirname, '../../archetypes');
        const files = fs.readdirSync(archetypeDir)
            .filter(f => f.endsWith('.json') && f !== 'schema.json');

        archetypes = files.map(f => {
            const content = fs.readFileSync(path.join(archetypeDir, f), 'utf8');
            return JSON.parse(content);
        });

        mapper = new ArchetypeMapper(archetypes);
    });

    describe('Structural scoring', () => {
        it('should score exact match as 100', () => {
            const archetype = archetypes.find(a => a.id === 'subtle_naturalist');
            const dna = {
                version: '2.0',
                global: {
                    l: archetype.centroid.l,
                    c: archetype.centroid.c,
                    k: archetype.centroid.k,
                    l_std_dev: archetype.centroid.l_std_dev,
                    hue_entropy: 0.75,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.15
                },
                sectors: {}
            };

            const score = mapper.calculateStructuralScore(dna, archetype);
            expect(score).toBeCloseTo(100, 0);
        });

        it('should penalize distant matches with weighted distance', () => {
            const archetype = archetypes.find(a => a.id === 'subtle_naturalist');
            const dna = {
                version: '2.0',
                global: {
                    l: archetype.centroid.l + 50, // Very different
                    c: archetype.centroid.c,
                    k: archetype.centroid.k,
                    l_std_dev: archetype.centroid.l_std_dev,
                    hue_entropy: 0.75,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.15
                },
                sectors: {}
            };

            const score = mapper.calculateStructuralScore(dna, archetype);
            expect(score).toBeLessThan(50); // Large distance = low score
        });
    });

    describe('Archetype matching patterns', () => {
        it('should match monochromatic low-chroma to Structural Rescue', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 60,
                    c: 11,
                    k: 100,
                    l_std_dev: 26,
                    hue_entropy: 0.25, // Low entropy (monochrome)
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.60
                },
                dominant_sector: 'rose',
                sectors: {
                    rose: { weight: 0.60, lMean: 60, cMean: 11, cMax: 18 }
                }
            };

            const result = mapper.getBestMatch(dna);
            expect(result.id).toBe('structural_outlier_rescue');
            expect(result.score).toBeGreaterThan(60);
        });

        it('should match achromatic to Silver Gelatin', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 50,
                    c: 2,
                    k: 100,
                    l_std_dev: 28,
                    hue_entropy: 0.05, // Near zero (B&W)
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.95
                },
                dominant_sector: null,
                sectors: {}
            };

            const result = mapper.getBestMatch(dna);
            expect(result.id).toBe('silver_gelatin');
            expect(result.score).toBeGreaterThan(70);
        });

        it('should match blue outlier to Blue Rescue', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 40,
                    c: 35,
                    k: 80,
                    l_std_dev: 22,
                    hue_entropy: 0.45,
                    temperature_bias: -0.6, // Cool
                    primary_sector_weight: 0.35
                },
                dominant_sector: 'blue',
                sectors: {
                    blue: { weight: 0.12, lMean: 35, cMean: 45, cMax: 55 }, // Outlier
                    orange: { weight: 0.70, lMean: 45, cMean: 30, cMax: 40 }
                }
            };

            const result = mapper.getBestMatch(dna);
            expect(result.id).toBe('blue_rescue');
            expect(result.breakdown.sectorAffinity).toBeGreaterThan(50);
        });

        it('should match yellow dominance to Warm Tonal Optimized', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 55,
                    c: 35,
                    k: 70,
                    l_std_dev: 22,
                    hue_entropy: 0.45,
                    temperature_bias: 0.65, // Warm
                    primary_sector_weight: 0.50
                },
                dominant_sector: 'yellow',
                sectors: {
                    yellow: { weight: 0.50, lMean: 60, cMean: 40, cMax: 55 },
                    orange: { weight: 0.30, lMean: 55, cMean: 35, cMax: 45 }
                }
            };

            const result = mapper.getBestMatch(dna);
            expect(['warm_tonal_optimized', 'thermonuclear_yellow']).toContain(result.id);
            expect(result.breakdown.pattern).toBeGreaterThan(50); // Warm bias bonus
        });

        it('should match extreme yellow to Thermonuclear Yellow', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 60,
                    c: 95,
                    k: 50,
                    l_std_dev: 15,
                    hue_entropy: 0.20, // Low (single dominant color)
                    temperature_bias: 0.90, // Very warm
                    primary_sector_weight: 0.60 // Single sector dominates
                },
                dominant_sector: 'yellow',
                sectors: {
                    yellow: { weight: 0.60, lMean: 62, cMean: 95, cMax: 100 }
                }
            };

            const result = mapper.getBestMatch(dna);
            expect(result.id).toBe('thermonuclear_yellow');
            expect(result.breakdown.sectorAffinity).toBeGreaterThan(60);
        });

        it('should match rainbow diversity to Subtle Naturalist', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 52,
                    c: 19,
                    k: 94,
                    l_std_dev: 28,
                    hue_entropy: 0.87, // High diversity
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.15
                },
                dominant_sector: 'green',
                sectors: {
                    red: { weight: 0.10, lMean: 50, cMean: 20, cMax: 35 },
                    green: { weight: 0.15, lMean: 52, cMean: 22, cMax: 40 },
                    blue: { weight: 0.12, lMean: 48, cMean: 18, cMax: 30 },
                    yellow: { weight: 0.11, lMean: 55, cMean: 25, cMax: 38 }
                }
            };

            const result = mapper.getBestMatch(dna);
            expect(result.id).toBe('subtle_naturalist');
            expect(result.breakdown.pattern).toBeGreaterThan(60); // Diversity bonus
        });

        it('should match extreme fluorescent to Neon Graphic', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 60,
                    c: 90,
                    k: 50,
                    l_std_dev: 4, // Flat
                    hue_entropy: 0.50,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.40
                },
                dominant_sector: 'magenta',
                sectors: {
                    magenta: { weight: 0.40, lMean: 62, cMean: 92, cMax: 98 },
                    yellow: { weight: 0.30, lMean: 58, cMean: 88, cMax: 95 }
                }
            };

            const result = mapper.getBestMatch(dna);
            expect(result.id).toBe('neon_graphic');
            expect(result.breakdown.sectorAffinity).toBeGreaterThan(60); // Extreme chroma
        });
    });

    describe('Score breakdown validation', () => {
        it('should provide detailed score breakdown', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 50,
                    c: 30,
                    k: 75,
                    l_std_dev: 20,
                    hue_entropy: 0.70,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.20
                },
                sectors: {}
            };

            const result = mapper.getBestMatch(dna);

            expect(result).toHaveProperty('id');
            expect(result).toHaveProperty('score');
            expect(result).toHaveProperty('breakdown');
            expect(result.breakdown).toHaveProperty('structural');
            expect(result.breakdown).toHaveProperty('sectorAffinity');
            expect(result.breakdown).toHaveProperty('pattern');

            // Scores should be 0-100
            expect(result.breakdown.structural).toBeGreaterThanOrEqual(0);
            expect(result.breakdown.structural).toBeLessThanOrEqual(100);
            expect(result.breakdown.sectorAffinity).toBeGreaterThanOrEqual(0);
            expect(result.breakdown.sectorAffinity).toBeLessThanOrEqual(100);
            expect(result.breakdown.pattern).toBeGreaterThanOrEqual(0);
            expect(result.breakdown.pattern).toBeLessThanOrEqual(100);
        });
    });
});
