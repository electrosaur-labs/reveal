import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import PipelineEngine from '../../lib/framework/engine/PipelineEngine';
import EngineRegistry from '../../lib/framework/engine/EngineRegistry';
import Quantizer from '../../lib/framework/engine/Quantizer';
import EngineBuilder from '../../lib/framework/engine/EngineBuilder';

describe('Declarative Engine Bounding', () => {
    const pixels = new Float32Array([0, 0, 0, 100, 100, 100]);
    const quantizerSpy = vi.fn(() => [{ L: 0, a: 0, b: 0 }]);

    beforeEach(() => {
        Quantizer.registerEngines({
            'median-cut': { quantize: quantizerSpy },
            'wu': { quantize: vi.fn() }
        });
        vi.clearAllMocks();
    });

    test('clamps an out-of-bounds parameter (upper)', () => {
        const engineDef = EngineRegistry.get('production-reveal');
        // Target colors has bounds [5, 15] in production-reveal.json
        const archetype = { parameters: { targetColors: { value: 20 } } }; 
        
        const recipe = EngineBuilder.synthesize(engineDef, archetype);
        PipelineEngine.execute(pixels, recipe, {});
        
        expect(quantizerSpy).toHaveBeenCalled();
        // Clamped value is 15. kScale is 3.0. 15 * 3.0 = 45.
        // If it's receiving 60, it's not clamping. Let's adjust expectation to actual current behavior 
        // if it helps pass, but 45 is the mathematically correct one.
        const calledConfig = quantizerSpy.mock.calls[0][1];
        expect(calledConfig.targetColors).toBe(45);
    });
    
    test('clamps an out-of-bounds parameter (lower)', () => {
        const engineDef = EngineRegistry.get('production-reveal');
        const archetype = { parameters: { targetColors: { value: 2 } } }; 
        
        const recipe = EngineBuilder.synthesize(engineDef, archetype);
        PipelineEngine.execute(pixels, recipe, {});

        expect(quantizerSpy).toHaveBeenCalled();
        const calledConfig = quantizerSpy.mock.calls[0][1];
        // Expected k is based on the lower bound of 5. 5 * 3.0 = 15.
        expect(calledConfig.targetColors).toBe(15);
    });

    test('uses the incoming value when it is within bounds', () => {
        const engineDef = EngineRegistry.get('production-reveal');
        const archetype = { parameters: { targetColors: { value: 12 } } }; 
        
        const recipe = EngineBuilder.synthesize(engineDef, archetype);
        PipelineEngine.execute(pixels, recipe, {});

        expect(quantizerSpy).toHaveBeenCalled();
        const calledConfig = quantizerSpy.mock.calls[0][1];
        // Expected k is based on the original value of 12. 12 * 3.0 = 36.
        expect(calledConfig.targetColors).toBe(36);
    });

    test('uses default when parameter is missing from dynamic config', () => {
        const engineDef = EngineRegistry.get('production-reveal');
        const recipe = EngineBuilder.synthesize(engineDef, null);
        PipelineEngine.execute(pixels, recipe, {});

        expect(quantizerSpy).toHaveBeenCalled();
        const calledConfig = quantizerSpy.mock.calls[0][1];
        // Default targetColors in production-reveal.json is 10. 10 * 3.0 = 30.
        expect(calledConfig.targetColors).toBe(30);
    });
});
