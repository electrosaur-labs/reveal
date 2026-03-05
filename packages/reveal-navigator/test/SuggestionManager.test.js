/**
 * SuggestionManager — Unit tests
 *
 * Tests suggestion caching, checked suggestion management,
 * ghost preview generation, and lifecycle methods.
 */

const SuggestionManager = require('../src/state/SuggestionManager');

const MOCK_SUGGESTIONS = [
    { L: 50, a: 10, b: -5, source: 'kmeans', reason: 'underrepresented', impactScore: 0.8 },
    { L: 70, a: -20, b: 30, source: 'peak', reason: 'missing hue', impactScore: 0.6 }
];

function createManager() {
    const sm = new SuggestionManager();
    sm.initialize({
        getSuggestedColors: () => [...MOCK_SUGGESTIONS],
        separationState: null,
        proxyBuffer: null
    });
    return sm;
}

// ─── getSuggestedColors ──────────────────────────────────

describe('getSuggestedColors', () => {
    it('returns empty array when proxyEngine is null', () => {
        const sm = new SuggestionManager();
        expect(sm.getSuggestedColors()).toEqual([]);
    });

    it('returns suggestions from proxyEngine', () => {
        const sm = createManager();
        const suggestions = sm.getSuggestedColors();

        expect(suggestions).toHaveLength(2);
        expect(suggestions[0].L).toBe(50);
    });

    it('caches suggestions (only calls proxyEngine once)', () => {
        const getSuggested = vi.fn().mockReturnValue([...MOCK_SUGGESTIONS]);
        const sm = new SuggestionManager();
        sm.initialize({ getSuggestedColors: getSuggested, separationState: null, proxyBuffer: null });

        sm.getSuggestedColors();
        sm.getSuggestedColors();

        expect(getSuggested).toHaveBeenCalledTimes(1);
    });
});

// ─── Checked Suggestions ─────────────────────────────────

describe('addCheckedSuggestion / removeCheckedSuggestion / isSuggestionChecked', () => {
    it('adds a checked suggestion', () => {
        const sm = createManager();
        sm.addCheckedSuggestion({ L: 50, a: 10, b: -5 });

        expect(sm.checkedSuggestions).toHaveLength(1);
        expect(sm.checkedSuggestions[0].L).toBe(50);
    });

    it('deep-copies the Lab color on add', () => {
        const sm = createManager();
        const color = { L: 50, a: 10, b: -5 };
        sm.addCheckedSuggestion(color);
        color.L = 99; // mutate original

        expect(sm.checkedSuggestions[0].L).toBe(50); // unaffected
    });

    it('isSuggestionChecked returns true for matching color', () => {
        const sm = createManager();
        sm.addCheckedSuggestion({ L: 50, a: 10, b: -5 });

        expect(sm.isSuggestionChecked({ L: 50, a: 10, b: -5 })).toBe(true);
    });

    it('isSuggestionChecked uses ΔE < 4 proximity', () => {
        const sm = createManager();
        sm.addCheckedSuggestion({ L: 50, a: 10, b: -5 });

        // Very close — should match
        expect(sm.isSuggestionChecked({ L: 51, a: 10, b: -5 })).toBe(true);

        // Far away — should not match
        expect(sm.isSuggestionChecked({ L: 80, a: -30, b: 40 })).toBe(false);
    });

    it('removeCheckedSuggestion removes by proximity', () => {
        const sm = createManager();
        sm.addCheckedSuggestion({ L: 50, a: 10, b: -5 });
        sm.addCheckedSuggestion({ L: 70, a: -20, b: 30 });

        sm.removeCheckedSuggestion({ L: 50, a: 10, b: -5 });

        expect(sm.checkedSuggestions).toHaveLength(1);
        expect(sm.checkedSuggestions[0].L).toBe(70);
    });

    it('removeCheckedSuggestion is a no-op for non-matching color', () => {
        const sm = createManager();
        sm.addCheckedSuggestion({ L: 50, a: 10, b: -5 });
        sm.removeCheckedSuggestion({ L: 99, a: 99, b: 99 });

        expect(sm.checkedSuggestions).toHaveLength(1);
    });
});

// ─── Ghost State ─────────────────────────────────────────

describe('ghost state', () => {
    it('ghostLabColor and ghostMode are initially null', () => {
        const sm = new SuggestionManager();
        expect(sm.ghostLabColor).toBeNull();
        expect(sm.ghostMode).toBeNull();
    });

    it('clearGhost resets ghost state', () => {
        const sm = new SuggestionManager();
        // Manually set private fields to simulate a ghost being set
        sm._ghostLabColor = { L: 50, a: 10, b: -5 };
        sm._ghostMode = 'integrated';

        sm.clearGhost();

        expect(sm.ghostLabColor).toBeNull();
        expect(sm.ghostMode).toBeNull();
    });
});

// ─── Lifecycle ───────────────────────────────────────────

describe('lifecycle', () => {
    it('reset clears all state', () => {
        const sm = createManager();
        sm.addCheckedSuggestion({ L: 50, a: 10, b: -5 });
        sm.getSuggestedColors(); // populate cache

        sm.reset();

        expect(sm.checkedSuggestions).toEqual([]);
        expect(sm.cachedSuggestions).toBeNull();
        expect(sm.ghostLabColor).toBeNull();
        expect(sm.getSuggestedColors()).toEqual([]); // proxyEngine is null
    });

    it('clearForSwap clears suggestions but preserves proxyEngine', () => {
        const sm = createManager();
        sm.addCheckedSuggestion({ L: 50, a: 10, b: -5 });
        sm.getSuggestedColors(); // populate cache

        sm.clearForSwap();

        expect(sm.checkedSuggestions).toEqual([]);
        expect(sm.cachedSuggestions).toBeNull();
        // proxyEngine still bound — getSuggestedColors works
        const fresh = sm.getSuggestedColors();
        expect(fresh).toHaveLength(2);
    });
});

// ─── Snapshot / Restore ──────────────────────────────────

describe('snapshot / restore', () => {
    it('snapshot captures checked suggestions', () => {
        const sm = createManager();
        sm.addCheckedSuggestion({ L: 50, a: 10, b: -5 });
        sm.addCheckedSuggestion({ L: 70, a: -20, b: 30 });

        const snap = sm.snapshot();
        expect(snap.checkedSuggestions).toHaveLength(2);
    });

    it('restore deep-copies checked suggestions', () => {
        const sm = createManager();
        sm.addCheckedSuggestion({ L: 50, a: 10, b: -5 });
        const snap = sm.snapshot();

        sm.restore(snap);
        sm.checkedSuggestions[0].L = 99; // mutate live state

        expect(snap.checkedSuggestions[0].L).toBe(50); // snapshot unchanged
    });

    it('restore(null) clears to empty state', () => {
        const sm = createManager();
        sm.addCheckedSuggestion({ L: 50, a: 10, b: -5 });
        sm.restore(null);

        expect(sm.checkedSuggestions).toEqual([]);
        expect(sm.cachedSuggestions).toBeNull();
    });

    it('restore clears cached suggestions', () => {
        const sm = createManager();
        sm.getSuggestedColors(); // populate cache
        expect(sm.cachedSuggestions).not.toBeNull();

        sm.restore({ checkedSuggestions: [] });
        expect(sm.cachedSuggestions).toBeNull();
    });
});

// ─── generateSuggestionGhostPreview ──────────────────────

describe('generateSuggestionGhostPreview', () => {
    it('returns null when proxyEngine has no separation state', () => {
        const sm = new SuggestionManager();
        expect(sm.generateSuggestionGhostPreview({ L: 50, a: 0, b: 0 })).toBeNull();
    });

    it('returns null when proxyEngine is null', () => {
        const sm = new SuggestionManager();
        expect(sm.generateSuggestionGhostPreview({ L: 50, a: 0, b: 0 })).toBeNull();
    });
});

// ─── setSuggestionGhost ──────────────────────────────────

describe('setSuggestionGhost', () => {
    it('emits ghostChanged when ghost buffer is generated', () => {
        const Reveal = require('@electrosaur-labs/core');
        const sm = new SuggestionManager();

        // Set up a minimal proxyEngine with real separation state
        const palette = [{ L: 50, a: 0, b: 0 }, { L: 80, a: 10, b: -20 }];
        const rgbPalette = palette.map(c => Reveal.labToRgbD50(c));
        sm.initialize({
            separationState: {
                colorIndices: new Uint8Array([0, 1, 0, 1]),
                palette,
                rgbPalette,
                width: 2,
                height: 2
            },
            proxyBuffer: new Uint16Array(2 * 2 * 3), // 2x2 Lab pixels
            getSuggestedColors: () => []
        });

        const events = [];
        sm.on('ghostChanged', data => events.push(data));

        sm.setSuggestionGhost({ L: 60, a: 5, b: -10 });

        expect(events).toHaveLength(1);
        expect(events[0].colorIndex).toBe(-2);
        expect(events[0].ghostBuffer).toBeInstanceOf(Uint8ClampedArray);
        expect(sm.ghostLabColor.L).toBe(60);
        expect(sm.ghostMode).toBe('integrated');
    });
});
