const PipelineOperation = require('../PipelineOperation');

/**
 * Hijack: Snapshot the current palette into a preserved pool.
 * Typically used before high-chroma rescue or substrate injection.
 */
class HijackOperation extends PipelineOperation {
    execute(state, config) {
        // We store the current palette as "preserved" in metadata
        // so that the 'inject' step can bring them back later.
        state.metadata.preservedPalette = [...state.palette];
        
        // Note: Some versions of hijack might also clear the palette
        // but typically it just snapshots.
        return state;
    }
}

module.exports = HijackOperation;
