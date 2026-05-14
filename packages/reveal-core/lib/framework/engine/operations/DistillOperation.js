const PipelineOperation = require('../PipelineOperation');
const PaletteOps = require('../../../engines/PaletteOps');

class DistillOperation extends PipelineOperation {
    execute(state, config) {
        const targetK = this.params.targetColors || config.targetColors || 8;
        if (state.palette.length <= targetK) return state;

        const { PaletteDistiller } = RevealCore.engines;
        if (!PaletteDistiller) return state;

        const result = PaletteDistiller.distill(
            state.palette, 
            state.assignments, 
            state.assignments.length, 
            targetK
        );

        state.palette = result.palette;
        state.assignments = result.remap;
        return state;
    }
}

module.exports = DistillOperation;
