const PipelineOperation = require('../PipelineOperation');
const PaletteOps = require('../../../engines/PaletteOps');

/**
 * DensityFloor: prunes palette entries whose pixel coverage falls below
 * `floor` (default 0.5%). Palette entries flagged with _minVolumeExempt
 * (substrate, hue-gap injections, peak-found colors) are kept regardless
 * of coverage as long as they have ≥ 1 assigned pixel.
 *
 * Requires assignments — must run after a `map` step. Updates both
 * state.palette and state.assignments (the latter is remapped to the
 * compacted palette indices).
 *
 * Wraps reveal-core PaletteOps._applyDensityFloor.
 *
 * Params:
 *   floor: minimum coverage fraction (0..1). Defaults to 0.005 (0.5%).
 */
class DensityFloorOperation extends PipelineOperation {
    execute(state, config) {
        if (!state.assignments || !state.palette || state.palette.length === 0) {
            return state;
        }

        const floor = this.params.floor !== undefined ? this.params.floor : 0.005;

        const protectedIndices = new Set();
        for (let i = 0; i < state.palette.length; i++) {
            if (state.palette[i] && state.palette[i]._minVolumeExempt) {
                protectedIndices.add(i);
            }
        }

        const result = PaletteOps._applyDensityFloor(
            state.assignments,
            state.palette,
            floor,
            protectedIndices
        );

        state.palette = result.palette;
        state.assignments = result.assignments;
        return state;
    }
}

module.exports = DensityFloorOperation;
