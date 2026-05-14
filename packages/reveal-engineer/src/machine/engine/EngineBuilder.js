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

        for (const [key, raw] of Object.entries(definition)) {
            if (META_KEYS.has(key)) continue;

            if (raw && typeof raw === 'object' && (raw.default !== undefined || raw.value !== undefined)) {
                // Anchor = default (fallback to value for pre-existing snapshots).
                let v = raw.default !== undefined ? raw.default : raw.value;

                // DNA modulation: value = clamp(default + DNA[signal] * sensitivity, min, max).
                // Active only when the param declares both `modulateBy` (a DNA12 field name)
                // and `sensitivity` (signed coefficient). Absent → defaults+clamp only.
                if (typeof v === 'number'
                    && raw.modulateBy
                    && raw.sensitivity !== undefined
                    && DNA
                    && typeof DNA[raw.modulateBy] === 'number') {
                    v += DNA[raw.modulateBy] * raw.sensitivity;
                }

                if (typeof v === 'number') {
                    if (raw.min !== undefined) v = Math.max(raw.min, v);
                    if (raw.max !== undefined) v = Math.min(raw.max, v);
                }
                config[key] = v;
            } else {
                // Plain scalar (e.g., centroidStrategy: "ROBUST_SALIENCY").
                config[key] = raw;
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
        const flattenObj = (obj) => {
            const out = {};
            for (const [k, v] of Object.entries(obj)) {
                if (v && typeof v === 'object'
                    && !Array.isArray(v)
                    && (v.default !== undefined || v.value !== undefined)
                    && !('L' in v && 'a' in v && 'b' in v)) {
                    // {value, default[, min, max]} shape → flatten to its value.
                    // Skip Lab-color objects ({L, a, b}) which also have a "value-like"
                    // structure but aren't bounded parameters.
                    out[k] = v.default !== undefined ? v.default : v.value;
                } else {
                    out[k] = v;
                }
            }
            return out;
        };

        return steps.map(step => {
            const { op, params, ...rest } = step;
            const flatTop = flattenObj(rest);
            const flatParams = params && typeof params === 'object'
                ? { ...flatConfig, ...flattenObj(params) }
                : { ...flatConfig };
            return { op, ...flatTop, params: flatParams };
        });
    }

    /**
     * Legacy alias retained for callers that still use the old name.
     * Drops the second argument (was matched-archetype) — the engineer
     * inversion does not use per-image archetype matching.
     *
     * @deprecated Prefer build(definition, DNA).
     */
    static synthesize(engineSource, _ignored = null) {
        return this.build(engineSource, null);
    }

    /**
     * Build an engine pipeline from a chromosome string. Used by the legacy
     * generative path that derives a spec from a dash-segmented string.
     *
     * @param {string|Object} source - Chromosome string.
     * @returns {Object} A pipeline definition for PipelineEngine.
     */
    static fromChromosome(source) {
        if (!source) {
            return this._getDefaultPipeline();
        }

        if (typeof source !== 'string') {
            return this._getDefaultPipeline();
        }

        const segments = source.split('-');
        // ... (rest of chromosome parsing remains same)
        
        // Map chromosome segments to a spec-like object
        const spec = {
            id: chromosome,
            name: `Dynamic Engine (${chromosome})`,
            type: segments.includes('CL') ? 'classical' : 'generative',
            perception: {
                distance_model: 'cie76'
            },
            logic: {
                algorithm: 'median-cut'
            },
            refinement: {}
        };

        // 1. Perception
        if (segments.includes('DE76')) spec.perception.distance_model = 'cie76';
        if (segments.includes('DE94')) spec.perception.distance_model = 'cie94';
        if (segments.includes('DE2K') || segments.includes('DE00')) spec.perception.distance_model = 'cie2000';

        if (segments.includes('W_L')) spec.perception.weighting = { L: 1.5, a: 0.75, b: 0.75 };
        if (segments.includes('W_C')) spec.perception.weighting = { L: 0.75, a: 1.75, b: 1.75 };

        // 2. Logic
        if (segments.includes('KMP')) spec.logic.algorithm = 'k-means';
        if (segments.includes('SKM')) spec.logic.algorithm = 'spatial-k-means';

        // 3. Refinement
        if (segments.includes('S1')) spec.refinement.smoothing_type = 'median';
        if (segments.includes('S2')) spec.refinement.smoothing_type = 'bilateral';

        const mSeg = segments.find(s => /^M\d+$/.test(s));
        if (mSeg) {
            spec.refinement.min_region_px = parseInt(mSeg.substring(1), 10);
        }

        return this.fromSpec(spec);
    }

    /**
     * Build a pipeline from an EngineSpec object (v2.0).
     * 
     * @param {Object} spec 
     * @returns {Object}
     */
    static fromSpec(spec) {
        const type = spec.type || 'generative';
        
        if (type === 'classical') {
            return this._buildClassicalPipeline(spec);
        }

        return this._buildGenerativePipeline(spec);
    }

    /**
     * Build the standard v3.0 generative pipeline (The "Standard Recipe").
     *
     * `spec` is expected to carry the fully-hydrated flat config (produced by
     * `_hydrateConfig`); we forward it wholesale into the quantize step so
     * downstream operations have every key reveal-core expects.
     */
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

        // Step 1: Detect the substrate (paper/background) color so the quantize
        // step can cull it from the pixel pool — otherwise engines with extreme
        // centroid weights (Aine's high cWeight, Brigid's high blackBias, etc.)
        // may not naturally reserve a slot for paper-white, and the real
        // background gets absorbed into a chromatic palette entry.
        recipe.steps.push({ op: 'substrate_detection' });

        // (Cull is currently a noop — substrate culling now happens inside
        // QuantizeOperation/LabMedianCut via state.substrate.)
        recipe.steps.push({
            op: 'cull',
            color: { L: 100, a: 0, b: 0 },
            tolerance: 6.0,
            preserve: true
        });

        // Step 2: Quantize — pass the full hydrated flat config. The quantize
        // operation builds its own nested tuning from these keys. With
        // state.substrate set, LabMedianCut will skip pixels within
        // substrateTolerance of the substrate color before splitting boxes.
        const quantizeParams = { ...(spec.config || spec) };
        // perception block (legacy chromosome path) can override the metric/weighting.
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
            // Merge near-duplicate centroids that median-cut sometimes produces.
            // Threshold = engine's paletteReduction (defaults to 9.0); target = engine's
            // targetColors. Runs BEFORE inject(substrate) so the substrate's
            // _minVolumeExempt flag isn't dissolved into a quantize color.
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

        // Removed: hijack + inject('preserved'). HijackOperation snapshots the
        // palette into metadata, InjectOperation('preserved') appends that snapshot
        // back — producing N exact duplicates. The subsequent map deterministically
        // picks the first occurrence of each pair, so the duplicate slots get zero
        // pixel assignments. The pair was effectively a no-op that misreported the
        // palette size as 2× the actual unique-color count. Substrate preservation,
        // which this pair was originally intended for, is handled by the explicit
        // substrate_detection + inject('substrate') steps instead.
        recipe.steps.push({ op: 'rescue', params: { chromaThreshold: 10, distinctnessThreshold: 12 } });

        // Step N-1: Inject the canonical substrate color as an extra palette slot.
        // No-op if state.substrate wasn't set or a near-match is already present.
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
        if (refinement.min_region_px) {
            refineParams.minVolume = refinement.min_region_px / 2000;
        }
        if (Object.keys(refineParams).length > 0) {
            recipe.steps.push({ op: 'refine', params: refineParams });
        }

        return recipe;
    }

    /**
     * Build a classical pipeline matching legacy Reveal Mk 1.5/1.0.
     */
    static _buildClassicalPipeline(spec) {
        const id = spec.id || '';
        const isMk15 = id.includes('REV2') || id.includes('reveal-mk1.5') || id === 'mk15';
        const isMk10 = id.includes('REV1') || id.includes('reveal-mk1.0');
        
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

    /**
     * Synthesize an engine with archetype parameters.
     * Fuses base engine specs with image-matched archetype personality.
     * Archetype values take precedence but are clamped by engine-defined bounds.
     * 
     * @param {Object} engineSource - Declarative engine spec OR built recipe
     * @param {Object} archetype - Archetype object with .parameters
     * @returns {Object} Hydrated recipe with flat numeric parameters
     */
    static synthesize(engineSource, archetype) {
        if (!engineSource) return null;

        // --- FIXED: Root-level parameters must be merged BEFORE building the recipe ---
        // This ensures the builder can inject the correct final values into the steps.
        const sourceClone = JSON.parse(JSON.stringify(engineSource));
        const archetypeParams = (archetype && archetype.parameters) || {};

        const paramKeys = ['lWeight', 'cWeight', 'blackBias', 'targetColors', 'vibrancyBoost', 'highlightBoost', 'warmABoost', 'shadowThreshold', 'spatialWeight', 'smoothnessBias', 'edgePreservation', 'minVolume', 'speckleRescue'];
        
        for (const key of paramKeys) {
            const engineProp = sourceClone[key];
            const archetypeProp = archetypeParams[key];

            if (archetypeProp && archetypeProp.value !== undefined) {
                let finalValue = archetypeProp.value;
                if (engineProp && typeof engineProp === 'object' && engineProp.value !== undefined) {
                    const min = engineProp.min !== undefined ? engineProp.min : -Infinity;
                    const max = engineProp.max !== undefined ? engineProp.max : Infinity;
                    finalValue = Math.max(min, Math.min(max, finalValue));
                }
                sourceClone[key] = finalValue;
            } else if (engineProp && typeof engineProp === 'object' && engineProp.value !== undefined) {
                sourceClone[key] = engineProp.value;
            }
        }

        // Now build the recipe with the merged flat parameters
        const recipe = this.build(sourceClone);

        // Finally, ensure all steps are flat numeric (post-build hydration)
        recipe.steps = recipe.steps.map(step => {
            if (!step.params) return step;
            const hydratedParams = { ...step.params };
            for (const key in hydratedParams) {
                if (typeof hydratedParams[key] === 'object' && hydratedParams[key].value !== undefined) {
                    hydratedParams[key] = hydratedParams[key].value;
                }
            }
            return { ...step, params: hydratedParams };
        });

        return recipe;
    }
}

module.exports = EngineBuilder;
