/**
 * Unit tests for ConstraintEvaluator
 */

const ConstraintEvaluator = require('../../lib/analysis/ConstraintEvaluator');

describe('ConstraintEvaluator', () => {
    let evaluator;
    let sampleDNA;

    beforeEach(() => {
        evaluator = new ConstraintEvaluator();
        sampleDNA = {
            l: 65.3,
            c: 28.7,
            k: 82.1,
            l_std_dev: 22.4,
            maxC: 118.5,
            maxCHue: 68.3,
            minL: 8.2,
            maxL: 90.3,
            yellowDominance: 35.2,
            sectors: {
                yellow: {
                    weight: 0.35,
                    coverage: 0.24,
                    lMean: 85.7,
                    lStdDev: 12.3,
                    cMean: 95.3,
                    cMax: 118.5,
                    hMean: 68.3
                },
                orange: {
                    weight: 0.12,
                    coverage: 0.08,
                    lMean: 55.2,
                    lStdDev: 8.1,
                    cMean: 85.2,
                    cMax: 98.3,
                    hMean: 45.2
                }
            },
            spatial: {
                entropy: 42.3,
                edgeDensity: 0.14,
                complexityScore: 42.3
            }
        };
    });

    describe('Basic Comparisons', () => {
        test('evaluates simple greater than', () => {
            expect(evaluator.evaluate('yellowDominance > 20', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('yellowDominance > 40', sampleDNA)).toBe(false);
        });

        test('evaluates greater than or equal', () => {
            expect(evaluator.evaluate('yellowDominance >= 35.2', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('yellowDominance >= 40', sampleDNA)).toBe(false);
        });

        test('evaluates less than', () => {
            expect(evaluator.evaluate('minL < 10', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('minL < 5', sampleDNA)).toBe(false);
        });

        test('evaluates less than or equal', () => {
            expect(evaluator.evaluate('minL <= 8.2', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('minL <= 8', sampleDNA)).toBe(false);
        });

        test('evaluates equality', () => {
            expect(evaluator.evaluate('maxL === 90.3', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('maxL === 90', sampleDNA)).toBe(false);
        });

        test('evaluates inequality', () => {
            expect(evaluator.evaluate('maxL !== 100', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('maxL !== 90.3', sampleDNA)).toBe(false);
        });
    });

    describe('Logical Operators', () => {
        test('evaluates logical AND', () => {
            expect(evaluator.evaluate('yellowDominance > 20 && maxC > 80', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('yellowDominance > 40 && maxC > 80', sampleDNA)).toBe(false);
            expect(evaluator.evaluate('yellowDominance > 20 && maxC > 200', sampleDNA)).toBe(false);
        });

        test('evaluates logical OR', () => {
            expect(evaluator.evaluate('yellowDominance > 40 || maxC > 80', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('yellowDominance > 20 || maxC > 200', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('yellowDominance > 40 || maxC > 200', sampleDNA)).toBe(false);
        });

        test('evaluates logical NOT', () => {
            expect(evaluator.evaluate('!(yellowDominance > 40)', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('!(yellowDominance > 20)', sampleDNA)).toBe(false);
        });

        test('evaluates complex logical expressions', () => {
            const expr = '(maxC > 80 && maxCHue >= 70 && maxCHue <= 95) || yellowDominance > 15';
            expect(evaluator.evaluate(expr, sampleDNA)).toBe(true);
        });
    });

    describe('Nested Property Access', () => {
        test('accesses sector properties', () => {
            expect(evaluator.evaluate('sectors.yellow.weight > 0.20', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('sectors.yellow.lMean > 90', sampleDNA)).toBe(false);
            expect(evaluator.evaluate('sectors.yellow.lMean > 80', sampleDNA)).toBe(true);
        });

        test('accesses spatial properties', () => {
            expect(evaluator.evaluate('spatial.entropy < 20', sampleDNA)).toBe(false);
            expect(evaluator.evaluate('spatial.entropy > 40', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('spatial.edgeDensity < 0.05', sampleDNA)).toBe(false);
        });

        test('combines nested property access with logical operators', () => {
            const expr = 'sectors.yellow.weight > 0.20 && sectors.yellow.lMean > 90';
            expect(evaluator.evaluate(expr, sampleDNA)).toBe(false);

            const expr2 = 'spatial.entropy < 20 && sectors.yellow.weight > 0.10';
            expect(evaluator.evaluate(expr2, sampleDNA)).toBe(false);
        });

        test('accesses sectors.any for maximum across all sectors', () => {
            // sectors.any.cMax should return the max cMax across all sectors
            // Yellow has cMax: 118.5, Orange has cMax: 98.3
            // So sectors.any.cMax should be 118.5
            expect(evaluator.evaluate('sectors.any.cMax > 110', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('sectors.any.cMax > 120', sampleDNA)).toBe(false);

            // sectors.any.weight should return max weight
            // Yellow has weight: 0.35, Orange has weight: 0.12
            expect(evaluator.evaluate('sectors.any.weight > 0.30', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('sectors.any.weight > 0.40', sampleDNA)).toBe(false);
        });
    });

    describe('Arithmetic Operations', () => {
        test('evaluates addition', () => {
            expect(evaluator.evaluate('minL + 10 > 15', sampleDNA)).toBe(true);
        });

        test('evaluates subtraction', () => {
            expect(evaluator.evaluate('maxL - minL > 80', sampleDNA)).toBe(true);
        });

        test('evaluates multiplication', () => {
            expect(evaluator.evaluate('sectors.yellow.weight * 100 > 30', sampleDNA)).toBe(true);
        });

        test('evaluates division', () => {
            expect(evaluator.evaluate('maxC / 2 > 50', sampleDNA)).toBe(true);
        });
    });

    describe('Parentheses', () => {
        test('respects parentheses grouping', () => {
            expect(evaluator.evaluate('(yellowDominance > 20) && (maxC > 80)', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('(yellowDominance > 40 || maxC > 80) && minL < 10', sampleDNA)).toBe(true);
        });
    });

    describe('Error Handling', () => {
        test('throws on invalid property', () => {
            expect(() => {
                evaluator.evaluate('invalidProperty > 20', sampleDNA);
            }).toThrow();
        });

        test('throws on invalid nested property', () => {
            expect(() => {
                evaluator.evaluate('sectors.invalidSector.lMean > 20', sampleDNA);
            }).toThrow();
        });

        test('throws on missing property in path', () => {
            expect(() => {
                evaluator.evaluate('sectors.blue.lMean > 20', sampleDNA);
            }).toThrow();
        });

        test('throws on empty expression', () => {
            expect(() => {
                evaluator.evaluate('', sampleDNA);
            }).toThrow();
        });

        test('throws on malformed expression', () => {
            expect(() => {
                evaluator.evaluate('yellowDominance >', sampleDNA);
            }).toThrow();
        });

        test('prevents division by zero', () => {
            expect(() => {
                evaluator.evaluate('maxC / 0 > 1', sampleDNA);
            }).toThrow();
        });
    });

    describe('Security', () => {
        test('prevents code injection attempts', () => {
            expect(() => {
                evaluator.evaluate('eval("console.log(1)")', sampleDNA);
            }).toThrow();
        });

        test('prevents function constructor', () => {
            expect(() => {
                evaluator.evaluate('Function("return 1")()', sampleDNA);
            }).toThrow();
        });

        test('prevents property access outside whitelist', () => {
            expect(() => {
                evaluator.evaluate('__proto__.constructor', sampleDNA);
            }).toThrow();
        });
    });

    describe('Edge Cases', () => {
        test('handles zero values', () => {
            const zeroDNA = { ...sampleDNA, minL: 0 };
            expect(evaluator.evaluate('minL === 0', zeroDNA)).toBe(true);
        });

        test('handles subtraction comparisons', () => {
            // Note: Negative literals (-1) are not supported, but subtraction works
            expect(evaluator.evaluate('minL - 10 < 0', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('maxL - minL > 80', sampleDNA)).toBe(true);
        });

        test('handles floating point numbers', () => {
            expect(evaluator.evaluate('yellowDominance > 35.15', sampleDNA)).toBe(true);
            expect(evaluator.evaluate('yellowDominance < 35.25', sampleDNA)).toBe(true);
        });

        test('handles whitespace in expressions', () => {
            expect(evaluator.evaluate('  yellowDominance   >   20  ', sampleDNA)).toBe(true);
        });
    });

    describe('Real-World Constraint Examples', () => {
        test('Thermonuclear Yellow constraint', () => {
            const expr = 'yellowDominance > 20';
            expect(evaluator.evaluate(expr, sampleDNA)).toBe(true);
        });

        test('Nuclear Yellow constraint', () => {
            const expr = '(maxC > 80 && maxCHue >= 70 && maxCHue <= 95) || yellowDominance > 15';
            expect(evaluator.evaluate(expr, sampleDNA)).toBe(true);
        });

        test('Flatness Override constraint', () => {
            const flatDNA = { ...sampleDNA, l_std_dev: 5.2 };
            expect(evaluator.evaluate('l_std_dev < 8', flatDNA)).toBe(true);
        });

        test('Shadow Gate constraint', () => {
            const darkDNA = { ...sampleDNA, minL: 1.5 };
            expect(evaluator.evaluate('minL < 2', darkDNA)).toBe(true);
        });

        test('Highlight Threshold constraint', () => {
            const brightDNA = { ...sampleDNA, maxL: 99.2 };
            expect(evaluator.evaluate('maxL > 98', brightDNA)).toBe(true);
        });

        test('Minkler Flatten constraint (v2.0 spatial)', () => {
            const flatGraphicDNA = {
                ...sampleDNA,
                spatial: { entropy: 15.3, edgeDensity: 0.03 }
            };
            const expr = 'spatial.entropy < 20 && spatial.edgeDensity < 0.05';
            expect(evaluator.evaluate(expr, flatGraphicDNA)).toBe(true);
        });

        test('Vibrancy Floor constraint', () => {
            const mutedDNA = { ...sampleDNA, c: 10.5, maxC: 65.3 };
            expect(evaluator.evaluate('c < 12 && maxC < 80', mutedDNA)).toBe(true);
        });
    });
});
