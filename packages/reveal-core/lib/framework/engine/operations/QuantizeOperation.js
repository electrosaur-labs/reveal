const PipelineOperation = require('../PipelineOperation');
const Quantizer = require('../Quantizer');

/**
 * Quantize: Performs color quantization using the configured dispatcher.
 * Routes to Median Cut, Wu, or other algorithms based on config.
 */
class QuantizeOperation extends PipelineOperation {
    execute(state, config) {
        const requestedColors = this.params.targetColors || config.targetColors || 8;
        // Reserve slots for any colors already in state.palette. numForced is set
        // by peak_finder when it runs BEFORE quantize (non-Mk1.5 pipelines). In the
        // Mk1.5 reference pipeline peak_finder runs AFTER prune, so numForced=0 here.
        const numForced = (state.metadata && state.metadata.numForced) || 0;
        const targetColors = Math.max(1, requestedColors - numForced);

        const quantizeConfig = {
            ...config,
            ...this.params,
            targetColors
        };

        // Quantizer.quantize returns an array of {L, a, b} (palette)
        const res = Quantizer.quantize(state.pixels, quantizeConfig);

        state.palette = [...state.palette, ...res];
        
        return state;
    }
}

module.exports = QuantizeOperation;
