/**
 * ScoringManager — Unit tests
 *
 * Tests DNA scoring, pseudo-archetype injection, eager set selection,
 * sort score computation, and background scoring cancellation.
 */

const ScoringManager = require('../src/state/ScoringManager');
const Reveal = require('@reveal/core');

const DUMMY_DNA = new Reveal.DNAGenerator().generate(
    new Uint16Array(3 * 4 * 4), 4, 4, { bitDepth: 16 }
);

function createScoring(dna = DUMMY_DNA) {
    const sm = new ScoringManager();
    const chameleonConfig = Reveal.generateConfigurationMk2(dna);
    const salamanderConfig = Reveal.generateConfigurationSalamander(dna);
    sm.initialize(null, dna, chameleonConfig, salamanderConfig);
    return sm;
}

// ─── getAllArchetypeScores ────────────────────────────────

describe('getAllArchetypeScores', () => {
    it('returns empty array when imageDNA is null', () => {
        const sm = new ScoringManager();
        expect(sm.getAllArchetypeScores()).toEqual([]);
    });

    it('returns ranked scores with group field on real archetypes', () => {
        const sm = createScoring();
        const scores = sm.getAllArchetypeScores();
        const PSEUDO_IDS = new Set(['dynamic_interpolator', 'distilled', 'salamander']);

        expect(scores.length).toBeGreaterThan(0);
        for (const s of scores) {
            expect(s).toHaveProperty('id');
            expect(s).toHaveProperty('score');
            // Real archetypes have _group; pseudo-archetypes don't
            if (!PSEUDO_IDS.has(s.id)) {
                expect(s).toHaveProperty('_group');
            }
        }
    });

    it('injects Chameleon, Distilled, and Salamander pseudo-archetypes', () => {
        const sm = createScoring();
        const scores = sm.getAllArchetypeScores();

        const ids = scores.map(s => s.id);
        expect(ids).toContain('dynamic_interpolator');
        expect(ids).toContain('distilled');
        expect(ids).toContain('salamander');
    });

    it('Chameleon score is between 30 and 85', () => {
        const sm = createScoring();
        const scores = sm.getAllArchetypeScores();
        const chameleon = scores.find(s => s.id === 'dynamic_interpolator');

        expect(chameleon.score).toBeGreaterThanOrEqual(30);
        expect(chameleon.score).toBeLessThanOrEqual(85);
    });

    it('Distilled is placed right after Chameleon', () => {
        const sm = createScoring();
        const scores = sm.getAllArchetypeScores();
        const chameleonIdx = scores.findIndex(s => s.id === 'dynamic_interpolator');
        const distilledIdx = scores.findIndex(s => s.id === 'distilled');

        expect(distilledIdx).toBe(chameleonIdx + 1);
    });

    it('Salamander is placed right after Distilled', () => {
        const sm = createScoring();
        const scores = sm.getAllArchetypeScores();
        const distilledIdx = scores.findIndex(s => s.id === 'distilled');
        const salamanderIdx = scores.findIndex(s => s.id === 'salamander');

        expect(salamanderIdx).toBe(distilledIdx + 1);
    });

    it('pseudo-archetypes have _synthetic metadata', () => {
        const sm = createScoring();
        const scores = sm.getAllArchetypeScores();

        for (const id of ['dynamic_interpolator', 'distilled', 'salamander']) {
            const entry = scores.find(s => s.id === id);
            expect(entry._synthetic).toBeDefined();
            expect(entry._synthetic.name).toBeTruthy();
            expect(entry._synthetic.description).toBeTruthy();
        }
    });
});

// ─── selectEagerSet ──────────────────────────────────────

describe('selectEagerSet', () => {
    it('always includes pseudo-archetypes', () => {
        const sm = createScoring();
        const scores = sm.getAllArchetypeScores();
        const eager = sm.selectEagerSet(scores);

        expect(eager.has('dynamic_interpolator')).toBe(true);
        expect(eager.has('distilled')).toBe(true);
        expect(eager.has('salamander')).toBe(true);
    });

    it('includes top-1 per group', () => {
        const sm = createScoring();
        const scores = sm.getAllArchetypeScores();
        const eager = sm.selectEagerSet(scores);

        // Should have at least the 3 pseudos + at least 1 real archetype
        expect(eager.size).toBeGreaterThan(3);
    });

    it('stores eager set on the instance', () => {
        const sm = createScoring();
        const scores = sm.getAllArchetypeScores();
        const eager = sm.selectEagerSet(scores);

        expect(sm.eagerSet).toBe(eager);
    });
});

// ─── computeSortScore ────────────────────────────────────

describe('computeSortScore', () => {
    it('returns edge survival loss when edgeSurvival is provided', () => {
        const sm = new ScoringManager();
        // 70% survival → (1-0.7)*50 = 15, 0 excess screens
        expect(sm.computeSortScore(5.0, 7, 0.7)).toBeCloseTo(15.0);
    });

    it('falls back to meanDeltaE when edgeSurvival is null', () => {
        const sm = new ScoringManager();
        expect(sm.computeSortScore(8.5, 7, null)).toBeCloseTo(8.5);
    });

    it('adds screen penalty for colors above 8', () => {
        const sm = new ScoringManager();
        const scoreAt8 = sm.computeSortScore(5.0, 8, null);
        const scoreAt10 = sm.computeSortScore(5.0, 10, null);

        expect(scoreAt10).toBeGreaterThan(scoreAt8);
    });

    it('no screen penalty at 8 or below', () => {
        const sm = new ScoringManager();
        expect(sm.computeSortScore(5.0, 8, null)).toBeCloseTo(5.0);
        expect(sm.computeSortScore(5.0, 6, null)).toBeCloseTo(5.0);
    });
});

// ─── sortByScore ─────────────────────────────────────────

describe('sortByScore', () => {
    it('sorts by sortScore ascending', () => {
        const sm = new ScoringManager();
        const scores = [
            { id: 'c', sortScore: 15 },
            { id: 'a', sortScore: 5 },
            { id: 'b', sortScore: 10 }
        ];
        const sorted = sm.sortByScore(scores);

        expect(sorted[0].id).toBe('a');
        expect(sorted[1].id).toBe('b');
        expect(sorted[2].id).toBe('c');
    });

    it('puts null sortScore entries at end', () => {
        const sm = new ScoringManager();
        const scores = [
            { id: 'a', sortScore: null },
            { id: 'b', sortScore: 5 },
            { id: 'c', sortScore: undefined }
        ];
        const sorted = sm.sortByScore(scores);

        expect(sorted[0].id).toBe('b');
        expect(sorted[1].sortScore).toBeNull();
    });

    it('does not mutate the input array', () => {
        const sm = new ScoringManager();
        const scores = [{ id: 'b', sortScore: 10 }, { id: 'a', sortScore: 5 }];
        sm.sortByScore(scores);

        expect(scores[0].id).toBe('b'); // original unchanged
    });
});

// ─── ΔE Cache ────────────────────────────────────────────

describe('deltaE cache', () => {
    it('stores and retrieves ΔE values', () => {
        const sm = new ScoringManager();
        sm.setArchetypeDeltaE('test-arch', 12.5);

        expect(sm.getArchetypeDeltaE('test-arch')).toBe(12.5);
    });

    it('returns undefined for missing archetypes', () => {
        const sm = new ScoringManager();
        expect(sm.getArchetypeDeltaE('nonexistent')).toBeUndefined();
    });

    it('clears cache on reset', () => {
        const sm = new ScoringManager();
        sm.setArchetypeDeltaE('test-arch', 12.5);
        sm.reset();

        expect(sm.getArchetypeDeltaE('test-arch')).toBeUndefined();
    });
});

// ─── Cancellation ────────────────────────────────────────

describe('cancellation', () => {
    it('increments scoringGeneration on cancelScoring', () => {
        const sm = new ScoringManager();
        const gen0 = sm.scoringGeneration;
        sm.cancelScoring();

        expect(sm.scoringGeneration).toBe(gen0 + 1);
    });

    it('reset sets scoringGeneration to 0', () => {
        const sm = new ScoringManager();
        sm.cancelScoring();
        sm.cancelScoring();
        sm.reset();

        expect(sm.scoringGeneration).toBe(0);
    });
});

// ─── Lifecycle ───────────────────────────────────────────

describe('lifecycle', () => {
    it('initialize stores proxyEngine and imageDNA', () => {
        const sm = new ScoringManager();
        const mockProxy = { getPaletteWithQuality: vi.fn() };
        sm.initialize(mockProxy, DUMMY_DNA);

        // Verify getAllArchetypeScores works after initialization
        const scores = sm.getAllArchetypeScores();
        expect(scores.length).toBeGreaterThan(0);
    });

    it('reset clears all state', () => {
        const sm = createScoring();
        sm.setArchetypeDeltaE('test', 10);
        sm.cancelScoring();

        sm.reset();

        expect(sm.scoringGeneration).toBe(0);
        expect(sm.eagerSet).toBeNull();
        expect(sm.allScores).toBeNull();
        expect(sm.getAllArchetypeScores()).toEqual([]);
    });
});
