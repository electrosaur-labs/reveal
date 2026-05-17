import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import PipelineEngine from '../../lib/framework/engine/PipelineEngine';
import EngineRegistry from '../../lib/framework/engine/EngineRegistry';
import Quantizer from '../../lib/framework/engine/Quantizer';
import EngineBuilder from '../../lib/framework/engine/EngineBuilder';

// Minimal inline fixture — tests the bounding mechanism only, not a production engine.
// kScale:3.0 and targetColors bounds [5,15] / default:10 are chosen to give integer
// expected values that make the assertions easy to read.
const BOUNDING_FIXTURE = {
    id: 'test-bounding-fixture',
    name: 'Bounding Test Fixture',
    steps: [
        {
            op: 'quantize',
            algorithm: 'median-cut',
            kScale: 3.0,
            params: {
                targetColors: {
                    modulateBy: 'targetColors',
                    sensitivity: 1.0,
                    default: 10,
                    bounds: [5, 15]
                }
            }
        }
    ]
};

describe('Declarative Engine Bounding', () => {
    const pixels = new Uint16Array([0, 0, 0, 32768, 32768, 32768]);
    const quantizerSpy = vi.fn(() => [{ L: 0, a: 0, b: 0 }]);

    beforeEach(() => {
        Quantizer.registerEngines({
            'median-cut': { quantize: quantizerSpy },
            'wu': { quantize: vi.fn() }
        });
        vi.clearAllMocks();
    });

    test('clamps an out-of-bounds parameter (upper)', async () => {
        const engineDef = BOUNDING_FIXTURE;
        // targetColors bounds [5,15] — value 20 clamps to 15. kScale 3.0 → 45.
        const archetype = { parameters: { targetColors: { value: 20 } } };

        const recipe = EngineBuilder.synthesize(engineDef, archetype);
        await PipelineEngine.executeAsync(pixels, recipe, {});

        expect(quantizerSpy).toHaveBeenCalled();
        const calledConfig = quantizerSpy.mock.calls[0][1];
        expect(calledConfig.targetColors).toBe(45);
    });

    test('clamps an out-of-bounds parameter (lower)', async () => {
        const engineDef = BOUNDING_FIXTURE;
        // targetColors bounds [5,15] — value 2 clamps to 5. kScale 3.0 → 15.
        const archetype = { parameters: { targetColors: { value: 2 } } };

        const recipe = EngineBuilder.synthesize(engineDef, archetype);
        await PipelineEngine.executeAsync(pixels, recipe, {});

        expect(quantizerSpy).toHaveBeenCalled();
        const calledConfig = quantizerSpy.mock.calls[0][1];
        expect(calledConfig.targetColors).toBe(15);
    });

    test('uses the incoming value when it is within bounds', async () => {
        const engineDef = BOUNDING_FIXTURE;
        // targetColors bounds [5,15] — value 12 is in range. kScale 3.0 → 36.
        const archetype = { parameters: { targetColors: { value: 12 } } };

        const recipe = EngineBuilder.synthesize(engineDef, archetype);
        await PipelineEngine.executeAsync(pixels, recipe, {});

        expect(quantizerSpy).toHaveBeenCalled();
        const calledConfig = quantizerSpy.mock.calls[0][1];
        expect(calledConfig.targetColors).toBe(36);
    });

    test('uses default when parameter is missing from dynamic config', async () => {
        const engineDef = BOUNDING_FIXTURE;
        // No archetype → default 10. kScale 3.0 → 30.
        const recipe = EngineBuilder.synthesize(engineDef, null);
        await PipelineEngine.executeAsync(pixels, recipe, {});

        expect(quantizerSpy).toHaveBeenCalled();
        const calledConfig = quantizerSpy.mock.calls[0][1];
        expect(calledConfig.targetColors).toBe(30);
    });
});
