/**
 * Engine Builder
 * The "Physics" Factory. Constructs dynamic PipelineEngine recipes from
 * DNA chromosomes or declarative EngineSpec objects.
 *
 * Hydration model:
 *   Value_final = Clamp(default + Σ(DNA_signal × Sensitivity), min, max)
 *
 * For Step 1 the sensitivity term is zero — DNA is accepted and forwarded
 * but does not yet bias parameters. Hydration reduces to
 * canonical defaults → engine.default → clamp, producing a complete flat
 * config that downstream operations can rely on.
 */

// Canonical defaults mirror reveal-core/lib/engines/PosterizationEngine.TUNING
// and ParameterGenerator output. Engine defs override these; missing keys
// fall back here so every parameter has a defined value at runtime.
const CANONICAL_DEFAULTS = {
    targetColors: 8,
    distanceMetric: 'cie76',
    splitMode: 'median',
    centroidStrategy: 'SALIENCY',
    quantizer: 'median-cut',
    vibrancyMode: 'aggressive',
    vibrancyBoost: 1.6,
    lWeight: 1.1,
    cWeight: 2.0,
    bWeight: 1.0,
    blackBias: 5.0,
    highlightThreshold: 92,
    highlightBoost: 3.0,
    warmABoost: 1.0,
    chromaAxisWeight: 0,
    neutralIsolationThreshold: 0,
    paletteReduction: 9.0,
    hueLockAngle: 18,
    shadowPoint: 15,
    snapThreshold: 8.0,
    enablePaletteReduction: true,
    enableHueGapAnalysis: false,
    substrateTolerance: 3.5,
    ditherType: 'none'
};

// Keys that EngineBuilder considers "structural metadata" — skipped during
// the flat-parameter hydration pass.
const META_KEYS = new Set([
    'id', 'name', 'description', 'group', 'version', 'type', 'engine',
    'perception', 'logic', 'refinement', 'steps', 'parameters'
]);

class EngineBuilder {
    /**
     * Build a runnable engine recipe from a declarative engine definition.
     *
     * @param {Object} definition - Engine definition (parameters + optional steps).
     * @param {Object} [DNA] - 12-element image DNA. Currently accepted but unused
     *                         (Step 1: defaults+clamp only; modulation lands in Step 3).
     * @returns {Object} Hydrated recipe { id, name, steps:[...], config:{flat} }.
     */
    static build(definition, DNA = null) {
        if (!definition) return this._getDefaultPipeline();

        // Hydrate every numeric parameter: default + (DNA-bias, currently 0), clamped.
        const flatConfig = this._hydrateConfig(definition, DNA);

        // Engines that ship explicit ordered steps run them verbatim (still get
        // the hydrated flat config attached so PipelineEngine can route it).
        if (Array.isArray(definition.steps)) {
            return {
                id: definition.id || 'unnamed',
                name: definition.name || `Engine ${definition.id}`,
                config: flatConfig,
                steps: this._flattenStepParams(definition.steps, flatConfig)
            };
        }

        // Otherwise build the generative step list, injecting flatConfig into it.
        return this.fromSpec({ ...definition, ...flatConfig, config: flatConfig });
    }

    /**
     * Flatten {value, default, min, max} engine parameters to a complete flat
     * config object. Canonical defaults underpin every key; engine values
     * override; result is clamped to engine-declared bounds.
     */
    static _hydrateConfig(definition, DNA) {
        const config = { ...CANONICAL_DEFAULTS };

        // Helper to extract param from {value, default, min, max, bounds}
        const resolveParam = (raw) => {
            if (raw && typeof raw === 'object' && (raw.default !== undefined || raw.value !== undefined)) {
                let v = raw.default !== undefined ? raw.default : raw.value;
                if (raw.modulateBy && raw.sensitivity !== undefined && DNA && typeof DNA[raw.modulateBy] === 'number') {
                    v += DNA[raw.modulateBy] * raw.sensitivity;
                }
                const min = raw.min !== undefined ? raw.min : (raw.bounds ? raw.bounds[0] : -Infinity);
                const max = raw.max !== undefined ? raw.max : (raw.bounds ? raw.bounds[1] : Infinity);
                return Math.max(min, Math.min(max, v));
            }
            return raw;
        };

        // 1. Scan top-level
        for (const [key, raw] of Object.entries(definition)) {
            if (META_KEYS.has(key)) continue;
            config[key] = resolveParam(raw);
        }

        // 2. Scan steps for nested parameter definitions (hoist engine-specific defaults)
        if (Array.isArray(definition.steps)) {
            for (const step of definition.steps) {
                const params = step.params || {};
                for (const [key, raw] of Object.entries(params)) {
                    if (raw && typeof raw === 'object' && (raw.default !== undefined || raw.value !== undefined)) {
                        // Only override if we haven't found a top-level override yet (or if top-level is just canonical default)
                        if (definition[key] === undefined) {
                            config[key] = resolveParam(raw);
                        }
                    }
                }
            }
        }

        return config;
    }

    /**
     * For engines that ship explicit `steps`, replace any {value,default,min,max}
     * parameter shapes — both at the top level of a step and under `step.params`
     * — with their flat numeric/scalar values. The engine's top-level hydrated
     * config is also merged into each step's params so downstream ops can read
     * engine-wide settings (lWeight, cWeight, etc.) without re-deriving them.
     */
    static _flattenStepParams(steps, flatConfig) {
        const K_SCALES = { 'none': 1.0, 'low': 1.5, 'standard': 2.0, 'high': 3.0, 'extreme': 4.0 };

        const flattenObj = (obj, step = null) => {
            const out = {};
            for (const [k, v] of Object.entries(obj)) {
                let resolvedValue;
                let found = false;

                if (v && typeof v === 'object' && v.modulateBy) {
                    // {modulateBy: "key", sensitivity: 1.0} shape → resolve from flatConfig.
                    const baseValue = flatConfig[v.modulateBy];
                    const sensitivity = v.sensitivity !== undefined ? v.sensitivity : 1.0;
                    
                    const resolvedBase = (typeof baseValue === 'number' && !isNaN(baseValue))
                        ? baseValue
                        : (CANONICAL_DEFAULTS[v.modulateBy] || 0);

                    resolvedValue = resolvedBase * sensitivity;
                    found = true;
                } else if (v && typeof v === 'object'
                    && !Array.isArray(v)
                    && (v.default !== undefined || v.value !== undefined)
                    && !('L' in v && 'a' in v && 'b' in v)) {
                    resolvedValue = v.default !== undefined ? v.default : v.value;
                    found = true;
                }

                if (found) {
                    if (typeof resolvedValue === 'number') {
                        const min = v.min !== undefined ? v.min : (v.bounds ? v.bounds[0] : -Infinity);
                        const max = v.max !== undefined ? v.max : (v.bounds ? v.bounds[1] : Infinity);
                        resolvedValue = Math.max(min, Math.min(max, resolvedValue));
                    }

                    if (k === 'targetColors' && step && step.kScale) {
                        const scale = typeof step.kScale === 'number' 
                            ? step.kScale 
                            : (K_SCALES[step.kScale] || 1.0);
                        resolvedValue = Math.round(resolvedValue * scale);
                    }
                    out[k] = resolvedValue;
                } else {
                    out[k] = v;
                }
            }
            return out;
        };

        return steps.map(step => {
            const { op, params, ...rest } = step;
            const flatTop = flattenObj(rest, step);
            const flatParams = params && typeof params === 'object'
                ? { ...flatConfig, ...flattenObj(params, step) }
                : { ...flatConfig };
            return { op, ...flatTop, params: flatParams };
        });
    }

    /**
     * Synthesize an engine with archetype parameters.
     * Fuses base engine specs with image-matched archetype personality.
     * Archetype values take precedence but are clamped by engine-defined bounds.
     */
    static synthesize(engineSource, archetype) {
        if (!engineSource) return null;

        const sourceClone = JSON.parse(JSON.stringify(engineSource));
        const archetypeParams = (archetype && archetype.parameters) || {};

        const paramKeys = ['lWeight', 'cWeight', 'blackBias', 'targetColors', 'vibrancyBoost', 'highlightBoost', 'warmABoost', 'shadowThreshold', 'spatialWeight', 'smoothnessBias', 'edgePreservation', 'minVolume', 'speckleRescue'];
        
        for (const key of paramKeys) {
            const engineProp = sourceClone[key];
            const archetypeProp = archetypeParams[key];

            let archeValue = undefined;
            if (archetypeProp !== undefined) {
                archeValue = (typeof archetypeProp === 'object' && archetypeProp.value !== undefined)
                    ? archetypeProp.value
                    : archetypeProp;
            }

            if (archeValue !== undefined) {
                let finalValue = archeValue;
                if (engineProp && typeof engineProp === 'object') {
                    const min = engineProp.min !== undefined ? engineProp.min : (engineProp.bounds ? engineProp.bounds[0] : -Infinity);
                    const max = engineProp.max !== undefined ? engineProp.max : (engineProp.bounds ? engineProp.bounds[1] : Infinity);
                    if (typeof finalValue === 'number') {
                        finalValue = Math.max(min, Math.min(max, finalValue));
                    }
                }
                sourceClone[key] = finalValue;
            } else if (engineProp && typeof engineProp === 'object') {
                sourceClone[key] = engineProp.default !== undefined ? engineProp.default : engineProp.value;
            }
        }

        return this.build(sourceClone);
    }

    /**
     * Build an engine pipeline from a chromosome string.
     */
    static fromChromosome(source) {
        if (!source || typeof source !== 'string') return this._getDefaultPipeline();

        const chromosome = source;
        const segments = source.split('-');
        
        const spec = {
            id: chromosome,
            name: `Dynamic Engine (${chromosome})`,
            type: segments.includes('CL') ? 'classical' : 'generative',
            perception: { distance_model: 'cie76' },
            logic: { algorithm: 'median-cut' },
            refinement: {}
        };

        if (segments.includes('DE76')) spec.perception.distance_model = 'cie76';
        if (segments.includes('DE94')) spec.perception.distance_model = 'cie94';
        if (segments.includes('DE2K') || segments.includes('DE00')) spec.perception.distance_model = 'cie2000';

        if (segments.includes('W_L')) spec.perception.weighting = { L: 1.5, a: 0.75, b: 0.75 };
        if (segments.includes('W_C')) spec.perception.weighting = { L: 0.75, a: 1.75, b: 1.75 };

        if (segments.includes('KMP')) spec.logic.algorithm = 'k-means';
        if (segments.includes('SKM')) spec.logic.algorithm = 'spatial-k-means';

        if (segments.includes('S1')) spec.refinement.smoothing_type = 'median';
        if (segments.includes('S2')) spec.refinement.smoothing_type = 'bilateral';

        const mSeg = segments.find(s => /^M\d+$/.test(s));
        if (mSeg) spec.refinement.min_region_px = parseInt(mSeg.substring(1), 10);

        return this.fromSpec(spec);
    }

    static fromSpec(spec) {
        const type = spec.type || 'generative';
        if (type === 'classical') return this._buildClassicalPipeline(spec);
        return this._buildGenerativePipeline(spec);
    }

    static _buildGenerativePipeline(spec) {
        const recipe = {
            id: spec.id || spec.engine_id || 'unnamed',
            name: spec.name || `Engine ${spec.id}`,
            config: spec.config || null,
            steps: []
        };

        const logic = spec.logic || {};
        const refinement = spec.refinement || {};
        const algorithm = logic.algorithm || 'median-cut';

        recipe.steps.push({ op: 'substrate_detection' });
        recipe.steps.push({ op: 'cull', color: { L: 100, a: 0, b: 0 }, tolerance: 6.0, preserve: true });

        const quantizeParams = { ...(spec.config || spec) };
        const perception = spec.perception;
        if (perception) {
            if (perception.distance_model) quantizeParams.distanceMetric = perception.distance_model;
            if (perception.chroma_boost !== undefined) quantizeParams.vibrancyBoost = perception.chroma_boost;
            if (perception.weighting) {
                quantizeParams.lWeight = perception.weighting.L;
                quantizeParams.cWeight = perception.weighting.a;
            }
        }

        if (algorithm === 'spatial-k-means') {
            recipe.steps.push({ op: 'quantize', algorithm: 'spatial-k-means', params: quantizeParams });
            recipe.steps.push({ op: 'map', dither: 'none' });
        } else if (algorithm === 'k-means') {
            recipe.steps.push({ op: 'quantize', algorithm: 'k-means', kScale: 'dynamic', params: quantizeParams });
            recipe.steps.push({ op: 'map', dither: 'none' });
            recipe.steps.push({ op: 'distill', algorithm: 'fps' });
        } else {
            recipe.steps.push({ op: 'quantize', algorithm: 'median-cut', params: quantizeParams });
            recipe.steps.push({
                op: 'prune',
                params: {
                    threshold: quantizeParams.paletteReduction,
                    whitePoint: quantizeParams.highlightThreshold,
                    targetColors: quantizeParams.targetColors
                }
            });
            recipe.steps.push({ op: 'map', dither: 'none' });
        }

        recipe.steps.push({ op: 'rescue', params: { chromaThreshold: 10, distinctnessThreshold: 12 } });
        recipe.steps.push({ op: 'inject', color: 'substrate' });
        recipe.steps.push({ op: 'map', dither: 'auto' });

        const refineParams = {};
        if (refinement.smoothing_type === 'median') {
            refineParams.smoothingType = 'median';
            refineParams.radius = 1.5;
        } else if (refinement.smoothing_type === 'bilateral') {
            refineParams.smoothingType = 'bilateral';
            refineParams.sigmaColor = 5;
            refineParams.sigmaSpace = 5;
        }
        if (refinement.min_region_px) refineParams.minVolume = refinement.min_region_px / 2000;
        if (Object.keys(refineParams).length > 0) recipe.steps.push({ op: 'refine', params: refineParams });

        return recipe;
    }

    static _buildClassicalPipeline(spec) {
        const id = spec.id || '';
        const isMk15 = id.includes('REV2') || id.includes('reveal-mk1.5');
        
        const recipe = {
            id: spec.id || 'classical',
            name: spec.name || (isMk15 ? 'Reveal Mk 1.5' : 'Reveal Mk 1.0'),
            steps: []
        };

        const perception = spec.perception || {};

        recipe.steps.push({ op: 'substrate_detection' });
        recipe.steps.push({ op: 'snap_lab', shadowThreshold: 6.0, highlightThreshold: 98.0 });
        if (isMk15) recipe.steps.push({ op: 'peak_finder' });

        const quantizeParams = {
            distanceMetric: perception.distance_model || 'cie76',
            vibrancyBoost: perception.chroma_boost || 1.6,
            centroidStrategy: isMk15 ? 'ROBUST_SALIENCY' : 'SALIENCY',
            whitePoint: 85,
            vibrancyMode: isMk15 ? 'exponential' : 'aggressive'
        };

        if (perception.weighting) {
            quantizeParams.lWeight = perception.weighting.L;
            quantizeParams.cWeight = perception.weighting.a;
        }

        recipe.steps.push({
            op: 'quantize',
            algorithm: 'median-cut',
            budgetOffset: isMk15 ? 0 : 1,
            subtractExisting: isMk15 ? false : true,
            subtractSubstrate: false,
            params: quantizeParams
        });

        if (isMk15) {
            recipe.steps.push({ op: 'refine', algorithm: 'k-means', iterations: 1, params: { useWeightedKMeans: false } });
            recipe.steps.push({ op: 'inject_neutral' });
            recipe.steps.push({ op: 'highlight_rescue', threshold: 85 });
        } else {
            recipe.steps.push({ op: 'hijack_substrate' });
            recipe.steps.push({ op: 'refine', algorithm: 'k-means', iterations: 1, params: { useWeightedKMeans: false } });
        }

        recipe.steps.push({ op: 'snap', threshold: 8.0 });
        if (!isMk15) {
            recipe.steps.push({ op: 'prune', threshold: 8.0 });
            recipe.steps.push({ op: 'density_floor', floor: 0.005 });
        }
        recipe.steps.push({ op: 'map', dither: 'auto' });

        return recipe;
    }

    static _getDefaultPipeline() {
        return {
            id: 'default',
            name: 'Default Engine',
            steps: [
                { op: 'quantize', algorithm: 'median-cut' },
                { op: 'map', dither: 'auto' }
            ]
        };
    }
}

module.exports = EngineBuilder;
