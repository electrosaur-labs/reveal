const PipelineOperation = require('../PipelineOperation');
const PaletteOps = require('../../../engines/PaletteOps');

class MapOperation extends PipelineOperation {
    execute(state, config) {
        const w = state.metadata.width;
        const h = state.metadata.height;
        
        // Wraps the core pixel-to-palette mapping
        // Signature: mapPixelsToPalette(pixels, labPalette, width = null, height = null, options = {})
        // Using state.pixels (perceptual Float32Array) avoids per-pixel conversion costs.
        const colorIndices = require('../../../engines/SeparationEngine').mapPixelsToPalette(
            state.pixels,
            state.palette,
            w, h,
            { ...config, ...this.params }
        );
        
        state.assignments = colorIndices;
        return state;
    }
}

module.exports = MapOperation;
