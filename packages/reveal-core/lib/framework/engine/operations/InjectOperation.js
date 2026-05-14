const PipelineOperation = require('../PipelineOperation');

class InjectOperation extends PipelineOperation {
    execute(state, config) {
        if (this.params.color === 'preserved' && state.metadata.preservedPalette) {
            // Append preserved colors to palette
            state.palette = [...state.palette, ...state.metadata.preservedPalette];
        } else if (this.params.color === 'substrate' && state.substrate) {
            // Check if substrate already exists
            const exists = state.palette.some(c => 
                Math.abs(c.L - state.substrate.L) < 0.1 &&
                Math.abs(c.a - state.substrate.a) < 0.1 &&
                Math.abs(c.b - state.substrate.b) < 0.1
            );
            if (!exists) {
                state.palette.push({ ...state.substrate, _minVolumeExempt: true });
            }
        }
        
        return state;
    }
}

module.exports = InjectOperation;
