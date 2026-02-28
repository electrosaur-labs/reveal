/**
 * InterpolatorEngine — Cluster-then-interpolate parameter generation
 *
 * Given a DNA vector, finds the K nearest cluster centroids and blends
 * their parameter sets weighted by inverse distance.
 *
 * Parameter blending strategy (validated against 287 images):
 *   - Continuous numeric: weighted average across K neighbors
 *   - Ordered enum: weighted average on ordinal scale, snap to nearest
 *   - Categorical/boolean: nearest cluster wins (71-74% accuracy,
 *     outperforms weighted voting and DNA-derived rules)
 */

// ---------------------------------------------------------------------------
// Parameter classification
// ---------------------------------------------------------------------------

const CONTINUOUS_PARAMS = [
    'lWeight', 'cWeight', 'bWeight', 'blackBias',
    'vibrancyBoost', 'vibrancyThreshold', 'saturationBoost',
    'highlightThreshold', 'highlightBoost',
    'paletteReduction', 'substrateTolerance', 'hueLockAngle', 'shadowPoint',
    'shadowClamp', 'minVolume', 'speckleRescue', 'detailRescue',
    'neutralCentroidClampThreshold', 'neutralSovereigntyThreshold',
    'chromaGate', 'refinementPasses',
    'minColors', 'maxColors',
    'shadowChromaGateL'
];

const ORDERED_ENUMS = {
    vibrancyMode: ['subtle', 'moderate', 'aggressive', 'exponential'],
    preprocessingIntensity: ['off', 'none', 'light', 'medium', 'heavy']
};

const PREP_ALIASES = { 'none': 'off' };

const CATEGORICAL_PARAMS = [
    'ditherType', 'distanceMetric', 'centroidStrategy',
    'substrateMode', 'colorMode', 'maskProfile',
    'preserveWhite', 'preserveBlack', 'ignoreTransparent',
    'enablePaletteReduction', 'enableHueGapAnalysis', 'medianPass'
];

const DIM_KEYS = ['l', 'c', 'k', 'l_std_dev', 'hue_entropy', 'temperature_bias', 'primary_sector_weight'];

// ---------------------------------------------------------------------------
// InterpolatorEngine
// ---------------------------------------------------------------------------

class InterpolatorEngine {
    /**
     * @param {Object} model - The cluster model (from build-interpolator.js)
     *   model.normalization.mean  - 7D array
     *   model.normalization.std   - 7D array
     *   model.blendNeighbors      - number of neighbors to blend (default 3)
     *   model.clusters[]          - { centroid: 7D array, parameters: {...} }
     */
    constructor(model) {
        this.norm = model.normalization;
        this.neighbors = model.blendNeighbors || 3;
        this.clusters = model.clusters;
    }

    /**
     * Generate blended parameters for a DNA vector.
     *
     * @param {Object} dna - { l, c, k, l_std_dev, hue_entropy, temperature_bias, primary_sector_weight }
     * @returns {{ parameters: Object, blendInfo: Object }}
     */
    interpolate(dna) {
        // Normalize input
        const vec = DIM_KEYS.map((key, i) => (dna[key] - this.norm.mean[i]) / this.norm.std[i]);

        // Compute distances to all cluster centroids
        const distances = this.clusters.map((cluster, idx) => ({
            idx,
            dist: euclidean(vec, cluster.centroid),
            cluster
        }));

        // Sort by distance, take top N
        distances.sort((a, b) => a.dist - b.dist);
        const nearest = distances.slice(0, this.neighbors);

        // Compute inverse-distance weights (with floor to avoid div/0)
        const FLOOR = 1e-6;
        const rawWeights = nearest.map(n => 1 / Math.max(n.dist, FLOOR));
        const weightSum = rawWeights.reduce((s, w) => s + w, 0);
        const weights = rawWeights.map(w => w / weightSum);

        // Blend parameters
        const blended = this._blendParameters(nearest, weights);

        // Blend info for diagnostics
        const blendInfo = {
            neighbors: nearest.map((n, i) => ({
                clusterId: n.cluster.id,
                sourceArchetype: n.cluster.sourceArchetype,
                distance: +n.dist.toFixed(4),
                weight: +weights[i].toFixed(4)
            }))
        };

        return { parameters: blended, blendInfo };
    }

    _blendParameters(nearest, weights) {
        const result = {};
        const nearestParams = nearest.map(n => n.cluster.parameters);

        // 1. Continuous: weighted average
        for (const key of CONTINUOUS_PARAMS) {
            const values = nearestParams.map(p => p[key]);
            if (values.every(v => v === undefined)) continue;
            const blended = values.reduce((sum, v, i) => sum + (v ?? 0) * weights[i], 0);
            result[key] = +blended.toFixed(4);
        }

        // Round integer params
        if (result.minColors !== undefined) result.minColors = Math.round(result.minColors);
        if (result.maxColors !== undefined) result.maxColors = Math.round(result.maxColors);
        if (result.refinementPasses !== undefined) result.refinementPasses = Math.round(result.refinementPasses);

        // 2. Ordered enums: weighted average on ordinal scale, snap to nearest
        for (const [key, scale] of Object.entries(ORDERED_ENUMS)) {
            const values = nearestParams.map(p => {
                let v = p[key];
                if (key === 'preprocessingIntensity' && PREP_ALIASES[v]) v = PREP_ALIASES[v];
                return v;
            });
            if (values.every(v => v === undefined)) continue;

            const indices = values.map(v => {
                const idx = scale.indexOf(v);
                return idx >= 0 ? idx : 0;
            });
            const blended = indices.reduce((sum, idx, i) => sum + idx * weights[i], 0);
            const snapped = Math.round(blended);
            result[key] = scale[Math.min(snapped, scale.length - 1)];
        }

        // 3. Categorical/boolean: nearest cluster wins
        for (const key of CATEGORICAL_PARAMS) {
            const val = nearestParams[0][key];
            if (val !== undefined) result[key] = val;
        }

        // 4. Defaults for parameters not stored in archetype JSONs
        //    (ParameterGenerator computes these dynamically; we provide safe defaults)
        if (result.centroidStrategy === undefined) result.centroidStrategy = 'SALIENCY';
        if (result.ditherType === undefined) result.ditherType = 'blue-noise';
        if (result.medianPass === undefined) result.medianPass = false;
        if (result.bWeight === undefined) result.bWeight = 1.0;
        if (result.saturationBoost === undefined) result.saturationBoost = result.vibrancyBoost || 1.4;
        if (result.detailRescue === undefined) result.detailRescue = 0;
        if (result.chromaGate === undefined) result.chromaGate = 1.0;
        if (result.shadowChromaGateL === undefined) result.shadowChromaGateL = 0;

        return result;
    }
}

function euclidean(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return Math.sqrt(sum);
}

module.exports = { InterpolatorEngine, DIM_KEYS, CONTINUOUS_PARAMS, ORDERED_ENUMS, CATEGORICAL_PARAMS };
