const PipelineOperation = require('../PipelineOperation');
const PaletteOps = require('../../../engines/PaletteOps');

class SubstrateDetectionOperation extends PipelineOperation {
    execute(state, config) {
        const w = state.metadata.width;
        const h = state.metadata.height;
        
        // Use the core's autoDetectSubstrate method
        // Signature: autoDetectSubstrate(labBytes, width, height, bitDepth = 16)
        state.substrate = require('../../../engines/PosterizationEngine').autoDetectSubstrate(
            state.originalPixels, 
            w, h, 
            16 // Pass bitDepth as number
        );
        
        return state;
    }
}

module.exports = SubstrateDetectionOperation;
