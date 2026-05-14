const PipelineOperation = require('../PipelineOperation');
const RevealCore = require('../../../../../reveal-core/index');
const { CentroidStrategies } = require('../../../../../reveal-core/lib/engines/CentroidStrategies');

/**
 * Snap: Palette-level snapping. Collapses similar colors in the palette.
 *
 * Passes the centroid strategy and tuning to applyPerceptualSnap so that
 * merged (and unmerged) palette entries are re-centroided with the same
 * strategy used during quantization. Without this, applyPerceptualSnap falls
 * back to VOLUMETRIC, which omits the aggressive 1.6× a* boost that SALIENCY
 * applies — causing the declarative palette's 'a' values to diverge from
 * the in-code Mk1.5 path.
 */
class SnapOperation extends PipelineOperation {
    execute(state, config) {
        const threshold = this.params.threshold || 8.0;
        const p = this.params;

        const strategyName = p.centroidStrategy || 'SALIENCY';
        const strategyFn = CentroidStrategies[strategyName] || CentroidStrategies.SALIENCY;

        const tuning = {
            centroid: {
                lWeight: p.lWeight !== undefined ? p.lWeight : 1.1,
                cWeight: p.cWeight !== undefined ? p.cWeight : 2.0,
                bWeight: p.bWeight !== undefined ? p.bWeight : 1.0,
                blackBias: p.blackBias !== undefined ? p.blackBias : 5.0,
                bitDepth: 16,
                vibrancyMode: p.vibrancyMode || 'aggressive',
                vibrancyBoost: p.centroidVibrancyBoost ?? 2.2
            }
        };

        state.palette = RevealCore.engines.PaletteOps.applyPerceptualSnap(
            state.palette,
            threshold,
            config.grayscaleOnly || false,
            2.0,
            strategyFn,
            tuning
        );

        return state;
    }
}

module.exports = SnapOperation;
