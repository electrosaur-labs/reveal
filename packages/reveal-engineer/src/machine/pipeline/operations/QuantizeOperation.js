const PipelineOperation = require('../PipelineOperation');
const RevealCore = require('../../../../../reveal-core/index');

// LabMedianCut is not exported in reveal-core index.js, so we require it directly.
const LabMedianCut = require('../../../../../reveal-core/lib/engines/LabMedianCut');
const { CentroidStrategies } = require('../../../../../reveal-core/lib/engines/CentroidStrategies');

/**
 * Quantize: Performs color quantization using Lab-space Median Cut.
 * Provides the nested tuning structure required by the core engine.
 */
class QuantizeOperation extends PipelineOperation {
    execute(state, config) {
        const requestedColors = this.params.targetColors || config.targetColors || 8;
        // Reserve slots for any colors already in state.palette. numForced is set
        // by peak_finder when it runs BEFORE quantize (non-Mk1.5 pipelines). In the
        // Mk1.5 reference pipeline peak_finder runs AFTER prune, so numForced=0 here.
        const numForced = (state.metadata && state.metadata.numForced) || 0;
        const targetColors = Math.max(1, requestedColors - numForced);
        const substrate = this.params.substrate || state.substrate || null;
        
        // --- Construct the nested tuning object expected by LabMedianCut ---
        // Mirrors reveal-core PosterizationEngine._buildTuningFromConfig() defaults.
        //
        // IMPORTANT: tuning.split.highlightBoost, tuning.prune.whitePoint, and
        // tuning.centroid.vibrancyBoost must match PosterizationEngine.TUNING values
        // (2.2, 85, 2.2 respectively), not the flat CANONICAL_DEFAULTS which serve
        // as LabMedianCut *function argument* defaults (3.0, 92, 1.6). To avoid
        // the flat params clobbering the tuning internals, these three fields use
        // dedicated override keys (tuningHighlightBoost, pruneWhitePoint,
        // centroidVibrancyBoost) that are absent from CANONICAL_DEFAULTS.
        const p = this.params;
        const tuning = {
            split: {
                highlightBoost: p.tuningHighlightBoost ?? 2.2,
                vibrancyBoost: p.vibrancyBoost !== undefined ? p.vibrancyBoost : 1.6,
                minVariance: p.minVariance !== undefined ? p.minVariance : 10,
                chromaAxisWeight: p.chromaAxisWeight !== undefined ? p.chromaAxisWeight : 0,
                neutralIsolationThreshold: p.neutralIsolationThreshold !== undefined ? p.neutralIsolationThreshold : 0,
                warmABoost: p.warmABoost !== undefined ? p.warmABoost : 1.0,
                splitMode: p.splitMode || 'median',
                quantizer: p.quantizer || p.algorithm || 'median-cut'
            },
            prune: {
                threshold: p.paletteReduction !== undefined ? p.paletteReduction : 9.0,
                hueLockAngle: p.hueLockAngle !== undefined ? p.hueLockAngle : 18,
                whitePoint: p.pruneWhitePoint ?? 85,
                shadowPoint: p.shadowPoint !== undefined ? p.shadowPoint : 15,
                isolationThreshold: p.isolationThreshold !== undefined ? p.isolationThreshold : 0.0
            },
            centroid: {
                lWeight: (p.lWeight !== undefined ? p.lWeight : 1.1) * (p.spatialWeight !== undefined ? p.spatialWeight : 1.0),
                cWeight: p.cWeight !== undefined ? p.cWeight : 2.0,
                bWeight: p.bWeight !== undefined ? p.bWeight : 1.0,
                blackBias: p.blackBias !== undefined ? p.blackBias : 5.0,
                bitDepth: p.bitDepth !== undefined ? (typeof p.bitDepth === 'number' ? p.bitDepth : 16) : 16,
                vibrancyMode: p.vibrancyMode || 'aggressive',
                vibrancyBoost: p.centroidVibrancyBoost ?? 2.2
            }
        };

        const strategyName = this.params.centroidStrategy || 'SALIENCY';
        const strategyFn = CentroidStrategies[strategyName] || CentroidStrategies.SALIENCY;

        // Substrate-cull tolerance — accept either `substrateTolerance` (engine
        // config) or `tolerance` (declared on the quantize step). Default 3.5
        // matches reveal-core PosterizationEngine's Mk1.0/Mk1.5 path.
        const substrateTolerance = this.params.substrateTolerance !== undefined
            ? this.params.substrateTolerance
            : (this.params.tolerance !== undefined ? this.params.tolerance : 3.5);

        const res = LabMedianCut.medianCutInLabSpace(
            state.pixels,
            targetColors,
            this.params.grayscaleOnly || false,
            null, // width (null tells it this is a flat list)
            null, // height
            substrate,
            substrateTolerance,
            this.params.vibrancyMode || 'aggressive',
            this.params.vibrancyBoost || 2.2,
            this.params.highlightThreshold || 85,
            this.params.highlightBoost || 2.2,
            strategyFn,
            tuning // Pass the nested tuning object
        );

        // medianCutInLabSpace returns an array of {L, a, b}
        state.palette = [...state.palette, ...res];
        
        return state;
    }
}

module.exports = QuantizeOperation;
