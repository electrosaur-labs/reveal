const PipelineOperation = require('../PipelineOperation');
const RevealCore = require('../../../../../reveal-core/index');

class PruneOperation extends PipelineOperation {
    execute(state, config) {
        const threshold = this.params.threshold || this.params.paletteReduction || 9.0;
        const whitePoint = this.params.whitePoint || this.params.highlightThreshold || 85;
        const targetCount = this.params.targetColors || config.targetColors || 8;

        // Use core's internal pruning logic from PaletteOps
        // This is safer than reimplementing the saliency-based merge.
        state.palette = RevealCore.engines.PaletteOps._prunePalette(
            state.palette, 
            threshold, 
            whitePoint, 
            targetCount,
            null, // use default tuning
            config.distanceMetric || 'cie76'
        );
        
        return state;
    }
}

module.exports = PruneOperation;
