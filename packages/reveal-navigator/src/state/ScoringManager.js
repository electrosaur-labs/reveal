/**
 * ScoringManager — Archetype scoring for Navigator
 *
 * Handles DNA-ranked archetype scoring, background ΔE/edge-survival
 * computation, tier-1 eager set selection, and pseudo-archetype injection.
 * SessionState delegates all scoring logic here.
 */

const EventEmitter = require('./EventEmitter');
const Reveal = require('@electrosaur-labs/core');
const logger = Reveal.logger;

class ScoringManager extends EventEmitter {

    constructor() {
        super();
        this._proxyEngine = null;
        this._imageDNA = null;
        this._chameleonConfig = null;
        this._salamanderConfig = null;

        // Generation counter for background scoring cancellation
        this._scoringGeneration = 0;

        // Single source of truth: ΔE per archetype
        this._archetypeDeltaE = new Map();

        // Tier-1 eager set and full score array
        this._eagerSet = null;
        this._allScores = null;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    /**
     * Initialize for a new image.
     * @param {Object} proxyEngine
     * @param {Object} imageDNA
     * @param {Object} [chameleonConfig] - Pre-computed Chameleon config
     * @param {Object} [salamanderConfig] - Pre-computed Salamander config
     */
    initialize(proxyEngine, imageDNA, chameleonConfig, salamanderConfig) {
        this._proxyEngine = proxyEngine;
        this._imageDNA = imageDNA;
        this._chameleonConfig = chameleonConfig || null;
        this._salamanderConfig = salamanderConfig || null;
        this._archetypeDeltaE.clear();
        this._eagerSet = null;
        this._allScores = null;
    }

    reset() {
        this._proxyEngine = null;
        this._imageDNA = null;
        this._chameleonConfig = null;
        this._salamanderConfig = null;
        this._scoringGeneration = 0;
        this._archetypeDeltaE.clear();
        this._eagerSet = null;
        this._allScores = null;
    }

    // ─── Generation / Cancellation ───────────────────────────

    /** Increment scoring generation to cancel in-flight scoring. */
    cancelScoring() {
        this._scoringGeneration++;
    }

    get scoringGeneration() { return this._scoringGeneration; }
    get eagerSet() { return this._eagerSet; }
    get allScores() { return this._allScores; }

    // ─── ΔE Cache ────────────────────────────────────────────

    getArchetypeDeltaE(archetypeId) {
        return this._archetypeDeltaE.get(archetypeId);
    }

    setArchetypeDeltaE(archetypeId, value) {
        this._archetypeDeltaE.set(archetypeId, value);
    }

    // ─── DNA Scoring ─────────────────────────────────────────

    /**
     * Get ranked archetype scores for the current image DNA.
     * Injects group field and pseudo-archetypes.
     *
     * @returns {Array<{id, score, breakdown, _group}>}
     */
    getAllArchetypeScores() {
        if (!this._imageDNA) return [];

        const archetypes = Reveal.ArchetypeLoader.loadArchetypes();
        const mapper = new Reveal.ArchetypeMapper(archetypes);
        const scores = mapper.getTopMatches(this._imageDNA, archetypes.length);

        // Inject group field from archetype metadata so carousel can tier/filter
        const archMap = new Map(archetypes.map(a => [a.id, a]));
        for (const s of scores) {
            const arch = archMap.get(s.id);
            s._group = arch ? (arch.group || 'all') : 'all';
        }

        this._injectChameleon(scores);
        this._injectDistilled(scores);
        this._injectSalamander(scores);
        return scores;
    }

    // ─── Tier Selection ──────────────────────────────────────

    /**
     * Select the carousel-visible set: 3 pseudo-archetypes + top 3 DNA-scored regular.
     * Scores array must already be DNA-ranked descending with _group injected.
     * Only these 6 archetypes appear in the carousel and get background-scored.
     *
     * @param {Array} scores - DNA-ranked score array
     * @returns {Set<string>} IDs to show in carousel and eager-score
     */
    selectEagerSet(scores) {
        const eager = new Set(['dynamic_interpolator', 'distilled', 'salamander']);
        this._eagerSet = eager;
        return eager;
    }

    // ─── Sort Score ──────────────────────────────────────────

    /**
     * Compute sort score: structural fidelity loss + screen count penalty.
     * Lower = better.
     *
     * @param {number} meanDeltaE
     * @param {number} targetColors
     * @param {number} [edgeSurvival] - 0-1
     * @returns {number}
     */
    computeSortScore(meanDeltaE, targetColors, edgeSurvival) {
        const structuralLoss = edgeSurvival != null
            ? (1 - edgeSurvival) * 50
            : meanDeltaE;

        const excess = Math.max(0, (targetColors || 0) - 8);
        const screenPenalty = excess > 0 ? 0.5 * Math.pow(1.6, excess - 1) : 0;

        return structuralLoss + screenPenalty;
    }

    /**
     * Sort scores by sortScore ascending (best adjusted quality first).
     * Entries without sortScore are appended in original order.
     *
     * @param {Array} scores
     * @returns {Array} Sorted copy
     */
    sortByScore(scores) {
        const copy = scores.slice();
        copy.sort((a, b) => {
            const aS = a.sortScore;
            const bS = b.sortScore;
            const aNull = aS == null || aS !== aS;
            const bNull = bS == null || bS !== bS;
            if (aNull && bNull) return 0;
            if (aNull) return 1;
            if (bNull) return -1;
            return aS - bS;
        });
        return copy;
    }

    // ─── Background Scoring ──────────────────────────────────

    /**
     * Background ΔE scoring loop. Scores archetypes one by one and emits
     * `archetypeScored` events so the carousel can update cards progressively.
     * Cancels if `_scoringGeneration` changes (new image or archetype swap).
     *
     * @param {Array} allScores - Score array (mutated in place with meanDeltaE)
     * @param {string} topId - Already-scored top match ID (skip it)
     * @param {number} generation - Generation counter at time of launch
     * @param {Set<string>} [eagerSet] - If provided, only score IDs in this set
     * @param {Object} knobs - {minVolume, speckleRescue, shadowClamp}
     */
    async scoreArchetypes(allScores, topId, generation, eagerSet, knobs) {
        this._allScores = allScores;

        // Skip pseudo-archetypes already scored during Phase 2.
        // If eagerSet provided, only score IDs in the eager set (tier-1).
        const PHASE2_IDS = new Set(['dynamic_interpolator', 'distilled', 'salamander']);
        const eagerSlice = allScores
            .filter(s => !PHASE2_IDS.has(s.id) && (!eagerSet || eagerSet.has(s.id)));
        const total = eagerSlice.length;
        let computed = 0;
        let cancelled = false;

        for (const match of eagerSlice) {
            if (this._scoringGeneration !== generation) {
                logger.log(`[ScoringManager] Background scoring cancelled (gen ${generation} → ${this._scoringGeneration})`);
                cancelled = true;
                break;
            }

            try {
                const config = match.id === 'distilled'
                    ? Reveal.generateConfigurationDistilled(this._imageDNA)
                    : match.id === 'salamander'
                    ? Reveal.generateConfigurationSalamander(this._imageDNA)
                    : Reveal.generateConfiguration(this._imageDNA, { manualArchetypeId: match.id });

                const quality = await this._proxyEngine.getPaletteWithQuality(config, knobs);
                const deltaE = quality.meanDeltaE;
                const colors = quality.rgbPalette ? quality.rgbPalette.length : 0;
                const edgeSurvival = quality.edgeSurvival;

                if (this._scoringGeneration !== generation) {
                    logger.log(`[ScoringManager] Background scoring cancelled after await (gen ${generation} → ${this._scoringGeneration})`);
                    cancelled = true;
                    break;
                }

                match.meanDeltaE = deltaE;
                match.edgeSurvival = edgeSurvival;
                match.targetColors = colors;
                match.sortScore = this.computeSortScore(deltaE, colors, edgeSurvival);
                this._archetypeDeltaE.set(match.id, deltaE);
                computed++;

                this.emit('archetypeScored', {
                    id: match.id,
                    meanDeltaE: deltaE,
                    edgeSurvival,
                    targetColors: colors,
                    sortScore: match.sortScore,
                    rgbPalette: quality.rgbPalette || null,
                    computed,
                    total
                });

                // Yield to let carousel update the card
                await new Promise(r => setTimeout(r, 5));
            } catch (err) {
                computed++;
                logger.log(`[ScoringManager] Background scoring failed for ${match.id}: ${err.message}`);
            }
        }

        // No restore needed — getPaletteWithQuality is read-only.

        const sorted = this.sortByScore(allScores);
        logger.log(`[ScoringManager] Background scoring ${cancelled ? 'cancelled' : 'complete'}: ${computed}/${total} archetypes scored`);
        this.emit('scoringComplete', { scores: sorted, topMatchId: topId, eagerOnly: !!eagerSet });
    }

    // ─── Pseudo-Archetype Injection ──────────────────────────

    /** @private */
    _injectChameleon(scores) {
        const config = this._chameleonConfig || Reveal.generateConfigurationMk2(this._imageDNA);
        const nearestDist = config.meta.blendInfo.neighbors[0].distance;
        const chameleonScore = Math.max(30, Math.min(85, 75 - 10 * nearestDist));

        const entry = {
            id: 'dynamic_interpolator',
            score: chameleonScore,
            _synthetic: {
                name: 'Chameleon',
                description: 'Adaptive interpolation from image DNA. Blends nearest archetype parameters weighted by distance.',
                preferred_sectors: [],
                parameters: {}
            }
        };

        let idx = scores.length;
        for (let i = 0; i < scores.length; i++) {
            if (chameleonScore >= scores[i].score) { idx = i; break; }
        }
        scores.splice(idx, 0, entry);
        return scores;
    }

    /** @private */
    _injectDistilled(scores) {
        const chameleon = scores.find(s => s.id === 'dynamic_interpolator');
        const distilledScore = chameleon ? Math.max(0, chameleon.score - 1) : 50;

        const entry = {
            id: 'distilled',
            score: distilledScore,
            _synthetic: {
                name: 'Distilled',
                description: 'Minimal batch-pipeline posterization. No archetype overrides — pure color extraction with 20→12 distillation.',
                preferred_sectors: [],
                parameters: {}
            }
        };

        const chameleonIdx = chameleon ? scores.indexOf(chameleon) : -1;
        scores.splice(chameleonIdx + 1, 0, entry);
        return scores;
    }

    /** @private */
    _injectSalamander(scores) {
        const chameleon = scores.find(s => s.id === 'dynamic_interpolator');
        const salamanderScore = chameleon ? Math.max(0, chameleon.score - 2) : 48;

        const entry = {
            id: 'salamander',
            score: salamanderScore,
            _synthetic: {
                name: 'Salamander',
                description: 'DNA-driven distillation. Adaptive color count and SALIENCY centroid from image DNA — no palette reduction, no preprocessing, every distilled color survives.',
                preferred_sectors: [],
                parameters: {}
            }
        };

        const distilled = scores.find(s => s.id === 'distilled');
        const distilledIdx = distilled ? scores.indexOf(distilled) : -1;
        scores.splice(distilledIdx + 1, 0, entry);
        return scores;
    }
}

module.exports = ScoringManager;
