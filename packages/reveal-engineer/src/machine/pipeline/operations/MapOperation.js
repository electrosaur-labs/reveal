const PipelineOperation = require('../PipelineOperation');
const RevealCore = require('../../../../../reveal-core/index');

class MapOperation extends PipelineOperation {
    execute(state, config) {
        const w = state.metadata.width;
        const h = state.metadata.height;
        
        // Wraps the core pixel-to-palette mapping
        // Signature: mapPixelsToPalette(rawBytes, labPalette, width = null, height = null, options = {})
        const colorIndices = RevealCore.engines.SeparationEngine.mapPixelsToPalette(
            state.originalPixels,
            state.palette,
            w, h,
            { ...config, ...this.params }
        );
        
        state.assignments = colorIndices;
        return state;
    }
}

module.exports = MapOperation;
