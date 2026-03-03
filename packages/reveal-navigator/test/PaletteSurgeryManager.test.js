/**
 * PaletteSurgeryManager — Unit tests
 *
 * Tests palette override, merge, delete, revert, snapshot/restore,
 * index shifting, and overridden palette building.
 */

const PaletteSurgeryManager = require('../src/state/PaletteSurgeryManager');

const MOCK_PALETTE = [
    { L: 50, a: 0, b: 0 },
    { L: 80, a: 10, b: -20 },
    { L: 30, a: -15, b: 25 },
    { L: 90, a: 5, b: 5 }
];

function createManager() {
    const pm = new PaletteSurgeryManager();
    pm.initialize({
        _baselineState: {
            palette: MOCK_PALETTE.map(c => ({ ...c }))
        }
    });
    return pm;
}

// ─── Override ────────────────────────────────────────────

describe('setOverride / buildOverriddenPalette', () => {
    it('stores an override at the given index', () => {
        const pm = createManager();
        pm.setOverride(1, { L: 60, a: 0, b: 0 });

        expect(pm.paletteOverrides.size).toBe(1);
        expect(pm.paletteOverrides.get(1).L).toBe(60);
    });

    it('buildOverriddenPalette applies overrides to baseline', () => {
        const pm = createManager();
        pm.setOverride(0, { L: 99, a: 1, b: 2 });

        const result = pm.buildOverriddenPalette();
        expect(result[0]).toEqual({ L: 99, a: 1, b: 2 });
        expect(result[1]).toEqual(MOCK_PALETTE[1]); // unchanged
    });

    it('returns null when proxyEngine is not initialized', () => {
        const pm = new PaletteSurgeryManager();
        expect(pm.buildOverriddenPalette()).toBeNull();
    });

    it('deep-copies override values', () => {
        const pm = createManager();
        const color = { L: 60, a: 0, b: 0 };
        pm.setOverride(1, color);
        color.L = 99; // mutate original

        expect(pm.paletteOverrides.get(1).L).toBe(60); // unaffected
    });
});

// ─── Revert ──────────────────────────────────────────────

describe('revertOverride', () => {
    it('removes override and deletion', () => {
        const pm = createManager();
        pm.setOverride(1, { L: 60, a: 0, b: 0 });
        pm.markDeleted(1);

        expect(pm.revertOverride(1)).toBe(true);
        expect(pm.paletteOverrides.has(1)).toBe(false);
        expect(pm.deletedColors.has(1)).toBe(false);
    });

    it('cleans up merge history when source is reverted', () => {
        const pm = createManager();
        pm.recordMerge(1, 0);
        expect(pm.mergeHistory.get(0).has(1)).toBe(true);

        pm.revertOverride(1);
        expect(pm.mergeHistory.has(0)).toBe(false); // removed because empty
    });

    it('returns false when nothing to revert', () => {
        const pm = createManager();
        expect(pm.revertOverride(5)).toBe(false);
    });
});

// ─── Merge ───────────────────────────────────────────────

describe('recordMerge', () => {
    it('copies target color into source override', () => {
        const pm = createManager();
        pm.recordMerge(1, 0);

        const override = pm.paletteOverrides.get(1);
        expect(override.L).toBe(MOCK_PALETTE[0].L);
    });

    it('tracks source in mergeHistory', () => {
        const pm = createManager();
        pm.recordMerge(1, 0);
        pm.recordMerge(2, 0);

        const sources = pm.mergeHistory.get(0);
        expect(sources.has(1)).toBe(true);
        expect(sources.has(2)).toBe(true);
    });

    it('throws for invalid indices', () => {
        const pm = createManager();
        expect(() => pm.recordMerge(99, 0)).toThrow();
    });
});

// ─── Delete ──────────────────────────────────────────────

describe('markDeleted', () => {
    it('adds index to deletedColors set', () => {
        const pm = createManager();
        pm.markDeleted(2);
        expect(pm.deletedColors.has(2)).toBe(true);
    });
});

// ─── findMergeTarget ─────────────────────────────────────

describe('findMergeTarget', () => {
    it('finds nearest live color by CIE76', () => {
        const pm = createManager();
        const { targetIndex } = pm.findMergeTarget(0, 'cie76');

        expect(targetIndex).toBeGreaterThanOrEqual(0);
        expect(targetIndex).not.toBe(0);
    });

    it('skips already-deleted colors', () => {
        const pm = createManager();
        pm.markDeleted(1);
        const { targetIndex } = pm.findMergeTarget(0, 'cie76');

        expect(targetIndex).not.toBe(1);
    });

    it('throws when deleting the last remaining color', () => {
        const pm = createManager();
        pm.markDeleted(0);
        pm.markDeleted(1);
        pm.markDeleted(2);

        // Only index 3 is alive; deleting it should throw
        expect(() => pm.findMergeTarget(3, 'cie76')).toThrow('last remaining');
    });
});

// ─── Added Colors ────────────────────────────────────────

describe('trackAddedColor / removeTrackedColor', () => {
    it('tracks added color indices', () => {
        const pm = createManager();
        pm.trackAddedColor(4);
        pm.trackAddedColor(5);

        expect(pm.addedColors.has(4)).toBe(true);
        expect(pm.addedColors.has(5)).toBe(true);
    });

    it('removeTrackedColor shifts indices above removed', () => {
        const pm = createManager();
        pm.trackAddedColor(4);
        pm.trackAddedColor(5);
        pm.trackAddedColor(6);

        pm.removeTrackedColor(5);

        // 4 stays, 5 removed, 6 shifts down to 5
        expect(pm.addedColors.has(4)).toBe(true);
        expect(pm.addedColors.size).toBe(2);
        // The set now contains {4, 5} (where 5 was originally 6)
        const indices = [...pm.addedColors].sort();
        expect(indices).toEqual([4, 5]);
    });

    it('removeTrackedColor returns false for non-added colors', () => {
        const pm = createManager();
        expect(pm.removeTrackedColor(1)).toBe(false);
    });

    it('shifts palette overrides above removed index', () => {
        const pm = createManager();
        pm.trackAddedColor(4);
        pm.setOverride(4, { L: 70, a: 0, b: 0 });
        pm.setOverride(1, { L: 60, a: 0, b: 0 });
        pm.trackAddedColor(5);
        pm.setOverride(5, { L: 80, a: 0, b: 0 });

        pm.removeTrackedColor(4);

        expect(pm.paletteOverrides.has(4)).toBe(true); // was 5, shifted to 4
        expect(pm.paletteOverrides.get(4).L).toBe(80);
        expect(pm.paletteOverrides.get(1).L).toBe(60); // unchanged
    });
});

// ─── Snapshot / Restore ──────────────────────────────────

describe('snapshot / restore', () => {
    it('snapshot captures all state', () => {
        const pm = createManager();
        pm.setOverride(0, { L: 99, a: 1, b: 2 });
        pm.markDeleted(1);
        pm.trackAddedColor(4);

        const snap = pm.snapshot();
        expect(snap.paletteOverrides.get(0).L).toBe(99);
        expect(snap.deletedColors.has(1)).toBe(true);
        expect(snap.addedColors.has(4)).toBe(true);
    });

    it('restore deep-copies (no shared references)', () => {
        const pm = createManager();
        pm.setOverride(0, { L: 99, a: 1, b: 2 });
        const snap = pm.snapshot();

        pm.restore(snap);
        pm.setOverride(0, { L: 60, a: 0, b: 0 }); // mutate live state

        expect(snap.paletteOverrides.get(0).L).toBe(99); // snapshot unchanged
    });

    it('restore(null) resets to clean state', () => {
        const pm = createManager();
        pm.setOverride(0, { L: 99, a: 1, b: 2 });
        pm.restore(null);

        expect(pm.paletteOverrides.size).toBe(0);
        expect(pm.mergeHistory.size).toBe(0);
        expect(pm.deletedColors.size).toBe(0);
        expect(pm.addedColors.size).toBe(0);
    });
});

// ─── hasEdits ────────────────────────────────────────────

describe('hasEdits', () => {
    it('returns false with no edits', () => {
        const pm = createManager();
        expect(pm.hasEdits()).toBe(false);
    });

    it('returns true with palette overrides', () => {
        const pm = createManager();
        pm.setOverride(0, { L: 60, a: 0, b: 0 });
        expect(pm.hasEdits()).toBe(true);
    });

    it('returns true with deleted colors', () => {
        const pm = createManager();
        pm.markDeleted(0);
        expect(pm.hasEdits()).toBe(true);
    });

    it('returns true with added colors', () => {
        const pm = createManager();
        pm.trackAddedColor(4);
        expect(pm.hasEdits()).toBe(true);
    });
});

// ─── Lifecycle ───────────────────────────────────────────

describe('reset / clearEdits', () => {
    it('reset clears everything', () => {
        const pm = createManager();
        pm.setOverride(0, { L: 60, a: 0, b: 0 });
        pm.markDeleted(1);
        pm.trackAddedColor(4);

        pm.reset();

        expect(pm.paletteOverrides.size).toBe(0);
        expect(pm.mergeHistory.size).toBe(0);
        expect(pm.deletedColors.size).toBe(0);
        expect(pm.addedColors.size).toBe(0);
    });

    it('clearEdits preserves addedColors', () => {
        const pm = createManager();
        pm.setOverride(0, { L: 60, a: 0, b: 0 });
        pm.markDeleted(1);
        pm.trackAddedColor(4);

        pm.clearEdits();

        expect(pm.paletteOverrides.size).toBe(0);
        expect(pm.deletedColors.size).toBe(0);
        expect(pm.addedColors.has(4)).toBe(true); // preserved
    });
});
