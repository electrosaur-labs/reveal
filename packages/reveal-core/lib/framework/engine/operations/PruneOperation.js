const PipelineOperation = require('../PipelineOperation');
const PaletteOps = require('../../../engines/PaletteOps');

class PruneOperation extends PipelineOperation {
    execute(state, config) {
        const threshold = this.params.threshold || 9.0;
        const whitePoint = this.params.whitePoint || 85;
        const targetCount = this.params.targetColors || config.targetColors || 8;

        // Use core's internal pruning logic from PaletteOps
        // This is safer than reimplementing the saliency-based merge.
        state.palette = PaletteOps._prunePalette(
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
