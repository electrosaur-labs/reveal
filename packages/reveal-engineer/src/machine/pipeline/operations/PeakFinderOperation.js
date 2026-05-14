const PipelineOperation = require('../PipelineOperation');
const RevealCore = require('../../../../../reveal-core/index');

class PeakFinderOperation extends PipelineOperation {
    execute(state, config) {
        const PeakFinder = RevealCore.engines.PeakFinder;
        if (!PeakFinder) return state;

        const peakFinder = new PeakFinder();
        const peaks = peakFinder.findIdentityPeaks(state.pixels, {
            bitDepth: 16, // Use 16 for high-quality detection — for adaptive thresholds
            maxPeaks: this.params.maxPeaks || 1
        });

        if (peaks && peaks.length > 0) {
            const DEDUP_THRESHOLD = 3.0;
            for (const p of peaks) {
                // Mirror in-code Mk1.5: inject peak only if no existing palette entry
                // is already within ΔE76 < 3.0 of this peak (anchorDuplicateThreshold).
                const isDuplicate = state.palette.some(c => {
                    const dL = c.L - p.L, da = c.a - p.a, db = c.b - p.b;
                    return Math.sqrt(dL * dL + da * da + db * db) < DEDUP_THRESHOLD;
                });
                if (!isDuplicate) {
                    state.palette.push({ L: p.L, a: p.a, b: p.b, _minVolumeExempt: true });
                }
            }
        }

        return state;
    }
}

module.exports = PeakFinderOperation;
