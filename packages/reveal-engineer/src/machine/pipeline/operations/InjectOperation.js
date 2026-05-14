const PipelineOperation = require('../PipelineOperation');

class InjectOperation extends PipelineOperation {
    execute(state, config) {
        if (this.params.color === 'preserved' && state.metadata.preservedPalette) {
            // Append preserved colors to palette
            state.palette = [...state.palette, ...state.metadata.preservedPalette];
        } else if (this.params.color === 'substrate' && state.substrate) {
            // Check if a perceptually near-identical color is already present.
            // A hard 0.1 per-channel check misses cases like (99,1,1) vs (99,0,1)
            // (ΔE≈1) and leaves a duplicate near-white in the palette.
            const s = state.substrate;
            const nearDuplicateThreshold = this.params.substrateMergeTolerance ?? 5.0;
            const exists = state.palette.some(c => {
                const dL = c.L - s.L, da = c.a - s.a, db = c.b - s.b;
                return Math.sqrt(dL*dL + da*da + db*db) < nearDuplicateThreshold;
            });
            if (!exists) {
                state.palette.push({ ...state.substrate, _minVolumeExempt: true });
            }
        }
        
        return state;
    }
}

module.exports = InjectOperation;
