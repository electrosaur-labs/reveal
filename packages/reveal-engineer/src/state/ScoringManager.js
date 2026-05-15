/**
 * ScoringManager — Engine scoring for Engineer
 *
 * Handles background ΔE/edge-survival computation for the 5 goddess engines.
 * Each engine is fused with the image-matched archetype before scoring.
 */

const EventEmitter = require('./EventEmitter');
const Reveal = require('@electrosaur-labs/core');

const PipelineEngine = Reveal.engines.PipelineEngine;
const EngineBuilder = Reveal.engines.EngineBuilder;
const EngineRegistry = Reveal.engines.EngineRegistry;

const logger = Reveal.logger;

class ScoringManager extends EventEmitter {

    constructor() {
        super();
        this._proxyEngine = null;
        this._imageDNA = null;
        this._activeArchetype = null;

        // Generation counter for background scoring cancellation
        this._scoringGeneration = 0;

        // Single source of truth: ΔE per engine
        this._engineDeltaE = new Map();
        this._allScores = null;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    /**
     * Initialize for a new image.
     * @param {Reveal.ProxyEngine} proxyEngine
     * @param {Object} imageDNA - DNA object: v2.0 nested fields (used for legacy archetype
     *        matching) plus top-level normalized 12-vector fields (used by EngineBuilder
     *        modulation). Augmented in SessionState via DNA12.augment().
     */
    initialize(proxyEngine, imageDNA) {
        this._proxyEngine = proxyEngine;
        this._imageDNA = imageDNA;

        // Find best archetype once per image
        const archetypes = Reveal.ArchetypeLoader.loadArchetypes();
        const mapper = new Reveal.ArchetypeMapper(archetypes);
        this._activeArchetype = mapper.getBestMatch(imageDNA);

        this._engineDeltaE.clear();
        this._allScores = null;
    }

    reset() {
        this._proxyEngine = null;
        this._imageDNA = null;
        this._activeArchetype = null;
        this._scoringGeneration = 0;
        this._engineDeltaE.clear();
        this._allScores = null;
    }

    cancelScoring() {
        this._scoringGeneration++;
    }

    get scoringGeneration() { return this._scoringGeneration; }
    get allScores() { return this._allScores; }

    getArchetypeDeltaE(engineId) {
        return this._engineDeltaE.get(engineId);
    }

    setArchetypeDeltaE(engineId, value) {
        this._engineDeltaE.set(engineId, value);
    }

    /**
     * Get the 5 goddess engines for the carousel.
     */
    getAllArchetypeScores() {
        const goddessIds = ['aine', 'anu', 'brigid', 'cailleach', 'rhiannon', 'mk15'];
        return goddessIds.map(id => ({ id, score: 0 }));
    }

    // ─── Sort Score ──────────────────────────────────────────

    computeSortScore(meanDeltaE, targetColors, edgeSurvival) {
        const structuralLoss = edgeSurvival != null
            ? (1 - edgeSurvival) * 50
            : meanDeltaE;

        const excess = Math.max(0, (targetColors || 0) - 8);
        const screenPenalty = excess > 0 ? 0.5 * Math.pow(1.6, excess - 1) : 0;

        return structuralLoss + screenPenalty;
    }

    // ─── Background Scoring ──────────────────────────────────

    /**
     * Background ΔE scoring loop for engines.
     * @param {Array} allScores - List of engine match objects to score
     * @param {string} topId - Top match ID
     * @param {number} generation - Current scoring generation (for cancellation)
     * @param {Map<string, Object>} eagerResults - Optional pre-computed results: engineId -> {palette, assignments, meanDeltaE, rgbPalette}
     * @param {Object} knobs - Current mechanical knobs to apply before scoring
     */
    async scoreArchetypes(allScores, topId, generation, eagerResults = new Map(), knobs) {
        this._allScores = allScores;
        const total = allScores.length;
        let computed = 0;

        for (const match of allScores) {
            if (this._scoringGeneration !== generation) break;

            try {
                // EAGER PATH: Use pre-computed results if available (e.g. for the active engine)
                if (eagerResults && eagerResults.has(match.id)) {
                    const eager = eagerResults.get(match.id);
                    match.meanDeltaE = eager.meanDeltaE;
                    match.edgeSurvival = eager.edgeSurvival || 0;
                    match.targetColors = eager.palette.length;
                    match.sortScore = this.computeSortScore(match.meanDeltaE, match.targetColors, match.edgeSurvival);
                    this._engineDeltaE.set(match.id, match.meanDeltaE);
                    
                    computed++;
                    this.emit('archetypeScored', {
                        id: match.id,
                        meanDeltaE: match.meanDeltaE,
                        edgeSurvival: match.edgeSurvival,
                        targetColors: match.targetColors,
                        sortScore: match.sortScore,
                        rgbPalette: eager.rgbPalette,
                        computed,
                        total
                    });
                    continue;
                }

                const engineDef = EngineRegistry.get(match.id);

                // Build engine instance from def + image DNA (no archetype merge).
                const hydratedEngine = EngineBuilder.build(engineDef, this._imageDNA);

                // Use the isolated PipelineEngine to compute quality
                // This ensures authoritative core normalization is used.
                const proxyBuffer = this._proxyEngine.proxyBuffer; // Raw 16-bit Engine Lab
                const config = {
                    width: this._proxyEngine.separationState.width,
                    height: this._proxyEngine.separationState.height,
                    targetColors: 8,
                    ...knobs
                };

                const result = await PipelineEngine.executeAsync(proxyBuffer, hydratedEngine, config);
                
                if (this._scoringGeneration !== generation) break;

                // Map palette to RGB for UI
                const rgbPalette = result.palette.map(lab => Reveal.LabEncoding.labToRgbD50(lab));

                // Compute ΔE error using core metrics
                const meanDeltaE = Reveal.RevelationError.meanDeltaE16(
                    proxyBuffer, 
                    result.assignments, 
                    result.palette, 
                    config.width * config.height
                );

                match.meanDeltaE = meanDeltaE;
                match.edgeSurvival = 0; // Edge survival omitted for simplicity in background loop
                match.targetColors = rgbPalette.length;
                match.sortScore = this.computeSortScore(match.meanDeltaE, match.targetColors, match.edgeSurvival);
                this._engineDeltaE.set(match.id, match.meanDeltaE);
                computed++;

                this.emit('archetypeScored', {
                    id: match.id,
                    meanDeltaE: match.meanDeltaE,
                    edgeSurvival: match.edgeSurvival,
                    targetColors: match.targetColors,
                    sortScore: match.sortScore,
                    rgbPalette: rgbPalette,
                    computed,
                    total
                });

                await new Promise(r => setTimeout(r, 5));
            } catch (err) {
                computed++;
                logger.log(`[ScoringManager] Background scoring failed for ${match.id}: ${err.message}`);
            }
        }

        this.emit('scoringComplete', { scores: allScores, topMatchId: topId });
    }
}

module.exports = ScoringManager;
