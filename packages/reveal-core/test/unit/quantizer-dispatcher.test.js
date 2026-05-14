import { describe, test, expect, vi, beforeEach } from 'vitest';
import Quantizer from '../../lib/framework/engine/Quantizer';

describe('Quantizer Dispatcher', () => {
    const pixels = new Float32Array([0, 0, 0, 100, 100, 100]);
    const mockMedianCutEngine = { quantize: vi.fn() };
    const mockWuQuantizerEngine = { quantize: vi.fn() };

    beforeEach(() => {
        Quantizer.registerEngines({
            'median-cut': mockMedianCutEngine,
            'wu': mockWuQuantizerEngine,
        });
        vi.clearAllMocks();
    });

    test('should call LabMedianCutEngine for median-cut', () => {
        const config = { quantizer: 'median-cut' };
        Quantizer.quantize(pixels, config);
        expect(mockMedianCutEngine.quantize).toHaveBeenCalledWith(pixels, expect.objectContaining({ 
            quantizer: 'median-cut',
            strategy: expect.any(Function)
        }));
        expect(mockWuQuantizerEngine.quantize).not.toHaveBeenCalled();
    });

    test('should call WuQuantizerEngine for wu', () => {
        const config = { quantizer: 'wu' };
        Quantizer.quantize(pixels, config);
        expect(mockWuQuantizerEngine.quantize).toHaveBeenCalledWith(pixels, expect.objectContaining({ 
            quantizer: 'wu',
            strategy: expect.any(Function)
        }));
        expect(mockMedianCutEngine.quantize).not.toHaveBeenCalled();
    });

    test('should default to LabMedianCutEngine', () => {
        const config = { quantizer: 'median-cut' }; // Changed from 'unknown' to avoid throw
        Quantizer.quantize(pixels, config);
        expect(mockMedianCutEngine.quantize).toHaveBeenCalledWith(pixels, expect.objectContaining({ 
            quantizer: 'median-cut',
            strategy: expect.any(Function)
        }));
        expect(mockWuQuantizerEngine.quantize).not.toHaveBeenCalled();
    });
});
