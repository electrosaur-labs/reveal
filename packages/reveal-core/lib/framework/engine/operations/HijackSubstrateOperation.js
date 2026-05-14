const PipelineOperation = require('../PipelineOperation');

/**
 * HijackSubstrate: replaces the palette entry closest to state.substrate
 * with the canonical substrate Lab (and the _minVolumeExempt protection
 * flag), staying within the engine's target color budget.
 *
 * Distinct from InjectOperation({color:'substrate'}), which APPENDS the
 * substrate as a new palette slot (exceeding budget by 1). Mk1.5's
 * "hijack_substrate" semantics: assume the median-cut produced a near-
 * substrate box; promote that box's centroid to the canonical substrate
 * so the resulting plate is paper-white-pure rather than slightly tinted.
 *
 * If no palette entry is within `tolerance` of state.substrate, the
 * substrate is pushed as a new entry (degenerates to inject semantics).
 *
 * Params:
 *   tolerance: ΔE (squared Euclidean Lab) cutoff for "close enough to
 *              hijack." Defaults to 12.0 (matches Mk1.0's preservedUnifyThreshold).
 */
class HijackSubstrateOperation extends PipelineOperation {
    execute(state, config) {
        if (!state.substrate) return state;

        const sub = state.substrate;
        const tolerance = this.params.tolerance !== undefined ? this.params.tolerance : 12.0;
        const tolSq = tolerance * tolerance;

        let bestIdx = -1;
        let bestDist = Infinity;
        for (let i = 0; i < state.palette.length; i++) {
            const c = state.palette[i];
            const dL = c.L - sub.L;
            const da = c.a - sub.a;
            const db = c.b - sub.b;
            const d = dL * dL + da * da + db * db;
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }

        if (bestIdx >= 0 && bestDist <= tolSq) {
            // Hijack: replace closest entry. Preserve any existing flags.
            state.palette[bestIdx] = {
                ...state.palette[bestIdx],
                L: sub.L,
                a: sub.a,
                b: sub.b,
                _minVolumeExempt: true
            };
        } else {
            // No close match — fall back to append-as-new (same as inject(substrate)).
            state.palette.push({ ...sub, _minVolumeExempt: true });
        }

        return state;
    }
}

module.exports = HijackSubstrateOperation;
