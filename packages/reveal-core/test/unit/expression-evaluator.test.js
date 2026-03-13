/**
 * ExpressionEvaluator — Unit Tests
 */

import { describe, it, expect } from 'vitest';

const ExpressionEvaluator = require('../../lib/analysis/ExpressionEvaluator');

const IMAGE_CONTEXT = {
    width: 4000,
    height: 3000,
    bitDepth: 16,
    dna: {
        global: { l: 52, c: 28, k: 71 },
        hue_entropy: 0.75,
        c: 28,
        temperature_bias: 0.3
    },
    sectors: {}
};

describe('ExpressionEvaluator', () => {

    describe('passthrough', () => {
        it('passes through numeric values unchanged', () => {
            const result = ExpressionEvaluator.evaluate(
                { targetColors: 8, lWeight: 1.1 },
                { image: IMAGE_CONTEXT }
            );
            expect(result.targetColors).toBe(8);
            expect(result.lWeight).toBe(1.1);
        });

        it('passes through boolean values unchanged', () => {
            const result = ExpressionEvaluator.evaluate(
                { enableHueGapAnalysis: true },
                { image: IMAGE_CONTEXT }
            );
            expect(result.enableHueGapAnalysis).toBe(true);
        });

        it('passes through plain string enums unchanged', () => {
            const result = ExpressionEvaluator.evaluate({
                ditherType: 'floyd-steinberg',
                centroidStrategy: 'SALIENCY',
                distanceMetric: 'cie76',
                vibrancyMode: 'aggressive',
                engineType: 'reveal-mk1.5',
                preprocessingIntensity: 'auto',
                splitMode: 'median'
            }, { image: IMAGE_CONTEXT });

            expect(result.ditherType).toBe('floyd-steinberg');
            expect(result.centroidStrategy).toBe('SALIENCY');
            expect(result.distanceMetric).toBe('cie76');
            expect(result.vibrancyMode).toBe('aggressive');
            expect(result.engineType).toBe('reveal-mk1.5');
            expect(result.preprocessingIntensity).toBe('auto');
            expect(result.splitMode).toBe('median');
        });

        it('passes through "none" unchanged', () => {
            const result = ExpressionEvaluator.evaluate(
                { ditherType: 'none' },
                { image: IMAGE_CONTEXT }
            );
            expect(result.ditherType).toBe('none');
        });
    });

    describe('arithmetic expressions', () => {
        it('evaluates simple arithmetic', () => {
            const result = ExpressionEvaluator.evaluate(
                { targetColors: 'channels + 2' },
                { image: IMAGE_CONTEXT, channels: 6 }
            );
            expect(result.targetColors).toBe(8);
        });

        it('evaluates multiplication', () => {
            const result = ExpressionEvaluator.evaluate(
                { lWeight: 'channels * 0.2' },
                { image: IMAGE_CONTEXT, channels: 8 }
            );
            expect(result.lWeight).toBeCloseTo(1.6);
        });
    });

    describe('conditional expressions', () => {
        it('evaluates ternary based on DNA', () => {
            const result = ExpressionEvaluator.evaluate(
                { targetColors: 'image.dna.hue_entropy > 0.7 ? 10 : 7' },
                { image: IMAGE_CONTEXT }
            );
            expect(result.targetColors).toBe(10); // hue_entropy is 0.75
        });

        it('evaluates false branch of ternary', () => {
            const lowEntropy = { ...IMAGE_CONTEXT, dna: { ...IMAGE_CONTEXT.dna, hue_entropy: 0.3 } };
            const result = ExpressionEvaluator.evaluate(
                { targetColors: 'image.dna.hue_entropy > 0.7 ? 10 : 7' },
                { image: lowEntropy }
            );
            expect(result.targetColors).toBe(7);
        });
    });

    describe('image context access', () => {
        it('accesses image dimensions', () => {
            const result = ExpressionEvaluator.evaluate(
                { speckleRescue: 'image.width > 3000 ? 3 : 1' },
                { image: IMAGE_CONTEXT }
            );
            expect(result.speckleRescue).toBe(3);
        });

        it('accesses image.dna properties', () => {
            const result = ExpressionEvaluator.evaluate(
                { cWeight: 'image.dna.c > 40 ? 2.5 : 2.0' },
                { image: IMAGE_CONTEXT }
            );
            expect(result.cWeight).toBe(2.0); // c is 28
        });

        it('accesses bitDepth', () => {
            const result = ExpressionEvaluator.evaluate(
                { lWeight: 'image.bitDepth === 16 ? 1.1 : 1.5' },
                { image: IMAGE_CONTEXT }
            );
            expect(result.lWeight).toBe(1.1);
        });
    });

    describe('Math functions', () => {
        it('evaluates Math.min', () => {
            const result = ExpressionEvaluator.evaluate(
                { targetColors: 'Math.min(10, channels + 5)' },
                { image: IMAGE_CONTEXT, channels: 8 }
            );
            expect(result.targetColors).toBe(10);
        });

        it('evaluates Math.max', () => {
            const result = ExpressionEvaluator.evaluate(
                { targetColors: 'Math.max(3, channels - 5)' },
                { image: IMAGE_CONTEXT, channels: 4 }
            );
            expect(result.targetColors).toBe(3);
        });

        it('evaluates Math.round', () => {
            const result = ExpressionEvaluator.evaluate(
                { targetColors: 'Math.round(image.dna.hue_entropy * 12)' },
                { image: IMAGE_CONTEXT }
            );
            expect(result.targetColors).toBe(9); // 0.75 * 12 = 9
        });
    });

    describe('channels default', () => {
        it('falls back to params.targetColors when channels not in context', () => {
            const result = ExpressionEvaluator.evaluate(
                { targetColors: 8, speckleRescue: 'channels > 6 ? 3 : 1' },
                { image: IMAGE_CONTEXT }
            );
            expect(result.speckleRescue).toBe(3); // channels defaults to targetColors=8
        });

        it('falls back to 8 when no targetColors and no channels', () => {
            const result = ExpressionEvaluator.evaluate(
                { speckleRescue: 'channels > 6 ? 3 : 1' },
                { image: IMAGE_CONTEXT }
            );
            expect(result.speckleRescue).toBe(3); // channels defaults to 8
        });
    });

    describe('mixed params', () => {
        it('evaluates expressions while passing through static values', () => {
            const result = ExpressionEvaluator.evaluate({
                targetColors: 'Math.min(image.dna.hue_entropy > 0.7 ? 10 : 7, channels + 2)',
                lWeight: 1.1,
                cWeight: 'image.dna.c > 40 ? 2.5 : 2.0',
                ditherType: 'floyd-steinberg',
                speckleRescue: 'image.width > 3000 ? 3 : 1'
            }, { image: IMAGE_CONTEXT, channels: 6 });

            expect(result.targetColors).toBe(8); // min(10, 6+2) = 8
            expect(result.lWeight).toBe(1.1);
            expect(result.cWeight).toBe(2.0);
            expect(result.ditherType).toBe('floyd-steinberg');
            expect(result.speckleRescue).toBe(3);
        });
    });

    describe('fail loud', () => {
        it('throws on syntax error', () => {
            expect(() => ExpressionEvaluator.evaluate(
                { targetColors: 'channels +' },
                { image: IMAGE_CONTEXT }
            )).toThrow('failed to evaluate "targetColors"');
        });

        it('throws on undefined variable access', () => {
            expect(() => ExpressionEvaluator.evaluate(
                { targetColors: 'foo + 1' },
                { image: IMAGE_CONTEXT }
            )).toThrow('failed to evaluate "targetColors"');
        });

        it('throws when expression returns undefined', () => {
            expect(() => ExpressionEvaluator.evaluate(
                { targetColors: 'image.nonexistent' },
                { image: IMAGE_CONTEXT }
            )).toThrow('expression returned undefined');
        });

        it('throws when expression returns NaN', () => {
            expect(() => ExpressionEvaluator.evaluate(
                { targetColors: 'image.width * undefined' },
                { image: IMAGE_CONTEXT }
            )).toThrow('expression returned NaN');
        });
    });

    describe('press context', () => {
        it('accesses press.mesh', () => {
            const result = ExpressionEvaluator.evaluate(
                { speckleRescue: 'press.mesh > 300 ? 6 : 4' },
                { image: IMAGE_CONTEXT, press: { mesh: 305 } }
            );
            expect(result.speckleRescue).toBe(6);
        });

        it('uses press.mesh in arithmetic', () => {
            const result = ExpressionEvaluator.evaluate(
                { shadowClamp: 'Math.max(4.0, (press.mesh / 100) * 1.5)' },
                { image: IMAGE_CONTEXT, press: { mesh: 305 } }
            );
            expect(result.shadowClamp).toBeCloseTo(4.575);
        });

        it('defaults press.mesh to 230 when no press context', () => {
            const result = ExpressionEvaluator.evaluate(
                { speckleRescue: 'press.mesh > 300 ? 6 : 4' },
                { image: IMAGE_CONTEXT }
            );
            expect(result.speckleRescue).toBe(4); // 230 < 300
        });
    });

    describe('_isExpression', () => {
        it('identifies expressions', () => {
            expect(ExpressionEvaluator._isExpression('channels + 2')).toBe(true);
            expect(ExpressionEvaluator._isExpression('image.dna.c > 40 ? 2.5 : 2.0')).toBe(true);
            expect(ExpressionEvaluator._isExpression('Math.min(10, 5)')).toBe(true);
            expect(ExpressionEvaluator._isExpression('press.mesh > 300 ? 6 : 4')).toBe(true);
            expect(ExpressionEvaluator._isExpression('1 + 1')).toBe(true);
        });

        it('identifies plain enum strings', () => {
            expect(ExpressionEvaluator._isExpression('none')).toBe(false);
            expect(ExpressionEvaluator._isExpression('floyd-steinberg')).toBe(false);
            expect(ExpressionEvaluator._isExpression('SALIENCY')).toBe(false);
            expect(ExpressionEvaluator._isExpression('cie76')).toBe(false);
            expect(ExpressionEvaluator._isExpression('reveal-mk1.5')).toBe(false);
            expect(ExpressionEvaluator._isExpression('auto')).toBe(false);
            expect(ExpressionEvaluator._isExpression('aggressive')).toBe(false);
        });
    });
});
