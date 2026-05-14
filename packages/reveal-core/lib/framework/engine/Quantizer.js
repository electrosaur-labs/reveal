/**
 * Quantizer Dispatcher - Isolated in Engineer package
 * Routes to the appropriate color quantization engine based on config.
 */

const { CentroidStrategies } = require('../../engines/CentroidStrategies');

const REGISTRY_KEY = Symbol.for('@electrosaur-labs/reveal-core/quantizer-engines');
if (!globalThis[REGISTRY_KEY]) {
    globalThis[REGISTRY_KEY] = {
        'median-cut': require('./quantizers/LabMedianCutEngine'),
        'wu': require('./quantizers/WuQuantizerEngine'),
        'perceptual-optimizer': require('./quantizers/PerceptualOptimizerEngine')
    };
}
const engines = globalThis[REGISTRY_KEY];

// Strategy Registry (Single Source of Truth)
const STRATEGY_KEY = Symbol.for('@electrosaur-labs/reveal-core/centroid-strategies');

class Quantizer {
    static registerEngines(engineMap) {
        for (const key in engineMap) {
            engines[key] = engineMap[key];
        }
    }

    static quantize(pixels, config) {
        const algorithm = config.quantizer || config.algorithm || 'median-cut';
        const engine = engines[algorithm];

        if (!engine) {
            throw new Error(`Quantizer engine not found: ${algorithm}`);
        }

        // Use global strategy registry or fallback to core
        const strategies = globalThis[STRATEGY_KEY] || CentroidStrategies || {};
        const strategyName = config.centroidStrategy || 'SALIENCY';
        const strategy = config.strategy || strategies[strategyName] || strategies.SALIENCY;

        const finalConfig = { 
            ...config, 
            strategy
        };

        return engine.quantize(pixels, finalConfig);
    }
}

module.exports = Quantizer;
