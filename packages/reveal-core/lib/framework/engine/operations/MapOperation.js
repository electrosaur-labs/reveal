const PipelineOperation = require('../PipelineOperation');
const PaletteOps = require('../../../engines/PaletteOps');

class MapOperation extends PipelineOperation {
    async execute(state, config) {
        const w = state.metadata.width;
        const h = state.metadata.height;
        
        // Pass the scaled progress callback to mapPixelsToPaletteAsync
        const onProgress = config._stepProgress || null;
        
        // Wraps the core pixel-to-palette mapping asynchronously
        // Signature: mapPixelsToPaletteAsync(rawBytes, labPalette, onProgress, width, height, options)
        const colorIndices = await require('../../../engines/SeparationEngine').mapPixelsToPaletteAsync(
            state.originalPixels,
            state.palette,
            onProgress,
            w, h,
            { ...config, ...this.params }
        );
        
        state.assignments = colorIndices;
        return state;
    }
}

module.exports = MapOperation;
