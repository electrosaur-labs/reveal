const PipelineOperation = require('../PipelineOperation');
const RevealCore = require('../../../../../reveal-core/index');

class SubstrateDetectionOperation extends PipelineOperation {
    execute(state, config) {
        const w = state.metadata.width;
        const h = state.metadata.height;
        
        // Use the core's autoDetectSubstrate method
        // Signature: autoDetectSubstrate(labBytes, width, height, bitDepth = 16)
        state.substrate = RevealCore.engines.PosterizationEngine.autoDetectSubstrate(
            state.originalPixels, 
            w, h, 
            16 // Pass bitDepth as number
        );
        
        return state;
    }
}

module.exports = SubstrateDetectionOperation;
