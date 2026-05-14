const PipelineOperation = require('../PipelineOperation');
const PaletteOps = require('../../../engines/PaletteOps');

/**
 * Refine: K-means refinement of palette centroids against the working
 * pixel buffer. Each pass reassigns pixels to nearest centroid then
 * recomputes centroids — converges palette toward perceptual local minima.
 *
 * Wraps reveal-core PaletteOps._refineKMeans, which accepts Float32
 * perceptual Lab pixels — matches our state.pixels shape. Calling
 * PosterizationEngine.posterize from here would re-run the entire
 * pipeline and reject the Float32 buffer at its input gate.
 *
 * Params:
 *   iterations: number of k-means passes (default 1). Mk1.5 uses 1;
 *               Wu-variance engines use 3.
 */
class RefineOperation extends PipelineOperation {
    execute(state, config) {
        const iterations = this.params.iterations !== undefined
            ? this.params.iterations
            : (config.refinementPasses !== undefined ? config.refinementPasses : 1);
        if (iterations <= 0 || !state.palette || state.palette.length <= 1) {
            return state;
        }

        // Build the same nested tuning shape PaletteOps consumes (it reads
        // tuning.centroid for the strategy weights). Mirrors what
        // QuantizeOperation builds — kept inline to avoid an op→op import.
        const p = { ...config, ...this.params };
        const tuning = {
            centroid: {
                lWeight: p.lWeight !== undefined ? p.lWeight : 1.1,
                cWeight: p.cWeight !== undefined ? p.cWeight : 2.0,
                bWeight: p.bWeight !== undefined ? p.bWeight : 1.0,
                blackBias: p.blackBias !== undefined ? p.blackBias : 5.0,
                bitDepth: 16,
                vibrancyMode: p.vibrancyMode || 'aggressive',
                vibrancyBoost: p.vibrancyBoost !== undefined ? p.vibrancyBoost : 1.6
            }
        };

        let refined = state.palette;
        for (let i = 0; i < iterations; i++) {
            refined = PaletteOps._refineKMeans(
                state.pixels,
                refined,
                tuning
            );
        }

        state.palette = refined;
        return state;
    }
}

module.exports = RefineOperation;
