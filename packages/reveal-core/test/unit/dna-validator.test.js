/**
 * Unit Tests for DNAValidator
 * Tests validation of DNA v1.0 and v2.0 objects
 */

const DNAValidator = require('../../lib/validation/DNAValidator');

describe('DNAValidator', () => {
    describe('DNA v1.0 validation', () => {
        it('should validate correct DNA v1.0', () => {
            const dna = {
                l: 52.3,
                c: 18.7,
                k: 94.2,
                l_std_dev: 28.6
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(true);
            expect(result.version).toBe('1.0');
            expect(result.errors).toHaveLength(0);
        });

        it('should reject DNA v1.0 with missing fields', () => {
            const dna = {
                l: 52.3,
                c: 18.7
                // Missing k and l_std_dev
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Missing required field: k');
            expect(result.errors).toContain('Missing required field: l_std_dev');
        });

        it('should reject DNA v1.0 with out-of-range values', () => {
            const dna = {
                l: 150,  // Invalid: > 100
                c: 18.7,
                k: 94.2,
                l_std_dev: 28.6
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0]).toContain('l must be 0-100');
        });

        it('should warn about unusual values', () => {
            const dna = {
                l: 52.3,
                c: 120,  // Unusually high
                k: 94.2,
                l_std_dev: 40  // Very high variance
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(true);
            expect(result.warnings.length).toBeGreaterThan(0);
        });
    });

    describe('DNA v2.0 validation', () => {
        it('should validate correct DNA v2.0', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 52.3,
                    c: 18.7,
                    k: 94.2,
                    l_std_dev: 28.6,
                    hue_entropy: 0.75,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.15
                },
                dominant_sector: 'green',
                sectors: {
                    red: { weight: 0.10, lMean: 50, cMean: 20, cMax: 35 },
                    green: { weight: 0.15, lMean: 52, cMean: 22, cMax: 40 },
                    blue: { weight: 0.12, lMean: 48, cMean: 18, cMax: 30 }
                },
                metadata: {
                    width: 800,
                    height: 600,
                    totalPixels: 480000,
                    bitDepth: 8
                }
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(true);
            expect(result.version).toBe('2.0');
            expect(result.errors).toHaveLength(0);
        });

        it('should reject DNA v2.0 with missing global fields', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 52.3,
                    c: 18.7
                    // Missing k, l_std_dev, hue_entropy, temperature_bias, primary_sector_weight
                },
                sectors: {}
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        it('should reject DNA v2.0 with out-of-range global values', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 52.3,
                    c: 18.7,
                    k: 94.2,
                    l_std_dev: 28.6,
                    hue_entropy: 1.5,  // Invalid: > 1.0
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.15
                },
                sectors: {}
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toContain('hue_entropy must be 0-1');
        });

        it('should validate sector data', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 52.3,
                    c: 18.7,
                    k: 94.2,
                    l_std_dev: 28.6,
                    hue_entropy: 0.75,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.15
                },
                sectors: {
                    blue: {
                        weight: 1.5,  // Invalid: > 1.0
                        lMean: 48,
                        cMean: 18,
                        cMax: 30
                    }
                },
                metadata: {
                    width: 800,
                    height: 600,
                    totalPixels: 480000
                }
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toContain('sectors.blue.weight must be 0-1');
        });

        it('should reject sectors with missing required fields', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 52.3,
                    c: 18.7,
                    k: 94.2,
                    l_std_dev: 28.6,
                    hue_entropy: 0.75,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.15
                },
                sectors: {
                    red: {
                        weight: 0.10,
                        lMean: 50
                        // Missing cMean, cMax
                    }
                },
                metadata: {
                    width: 800,
                    height: 600,
                    totalPixels: 480000
                }
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('sectors.red.cMean is required');
            expect(result.errors).toContain('sectors.red.cMax is required');
        });

        it('should warn about sector weights not summing to 1.0', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 52.3,
                    c: 18.7,
                    k: 94.2,
                    l_std_dev: 28.6,
                    hue_entropy: 0.75,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.15
                },
                sectors: {
                    red: { weight: 0.50, lMean: 50, cMean: 20, cMax: 35 },
                    blue: { weight: 0.30, lMean: 48, cMean: 18, cMax: 30 }
                    // Total: 0.80, missing 0.20
                },
                metadata: {
                    width: 800,
                    height: 600,
                    totalPixels: 480000
                }
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(true);
            expect(result.warnings.length).toBeGreaterThan(0);
            expect(result.warnings[0]).toContain('Sector weights should sum to ~1.0');
        });

        it('should validate dominant_sector', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 52.3,
                    c: 18.7,
                    k: 94.2,
                    l_std_dev: 28.6,
                    hue_entropy: 0.75,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.15
                },
                dominant_sector: 'invalid_sector',  // Invalid
                sectors: {},
                metadata: {
                    width: 800,
                    height: 600,
                    totalPixels: 480000
                }
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(false);
            expect(result.errors[0]).toContain('Invalid dominant_sector');
        });

        it('should allow null dominant_sector', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 52.3,
                    c: 18.7,
                    k: 94.2,
                    l_std_dev: 28.6,
                    hue_entropy: 0.05,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.95
                },
                dominant_sector: null,  // Valid for achromatic images
                sectors: {},
                metadata: {
                    width: 800,
                    height: 600,
                    totalPixels: 480000
                }
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(true);
        });

        it('should validate metadata fields', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 52.3,
                    c: 18.7,
                    k: 94.2,
                    l_std_dev: 28.6,
                    hue_entropy: 0.75,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.15
                },
                sectors: {},
                metadata: {
                    width: -100,  // Invalid
                    height: 600,
                    totalPixels: 480000,
                    bitDepth: 32  // Invalid: not 8 or 16
                }
            };

            const result = DNAValidator.validate(dna);
            expect(result.valid).toBe(false);
            expect(result.errors).toContain('metadata.width must be a positive integer');
            expect(result.errors).toContain('metadata.bitDepth must be 8 or 16');
        });
    });

    describe('Version detection', () => {
        it('should detect DNA v2.0 correctly', () => {
            const dna = {
                version: '2.0',
                global: {
                    l: 52.3,
                    c: 18.7,
                    k: 94.2,
                    l_std_dev: 28.6,
                    hue_entropy: 0.75,
                    temperature_bias: 0.0,
                    primary_sector_weight: 0.15
                },
                sectors: {},
                metadata: {
                    width: 800,
                    height: 600,
                    totalPixels: 480000
                }
            };

            const result = DNAValidator.validate(dna);
            expect(result.version).toBe('2.0');
        });

        it('should detect DNA v1.0 correctly', () => {
            const dna = {
                l: 52.3,
                c: 18.7,
                k: 94.2,
                l_std_dev: 28.6
            };

            const result = DNAValidator.validate(dna);
            expect(result.version).toBe('1.0');
        });
    });

    describe('Helper methods', () => {
        it('should provide isValid() shortcut', () => {
            const validDna = {
                l: 52.3,
                c: 18.7,
                k: 94.2,
                l_std_dev: 28.6
            };

            const invalidDna = {
                l: 150,  // Out of range
                c: 18.7
            };

            expect(DNAValidator.isValid(validDna)).toBe(true);
            expect(DNAValidator.isValid(invalidDna)).toBe(false);
        });

        it('should handle null/undefined input', () => {
            expect(DNAValidator.isValid(null)).toBe(false);
            expect(DNAValidator.isValid(undefined)).toBe(false);
            expect(DNAValidator.isValid({})).toBe(false);
        });
    });
});
