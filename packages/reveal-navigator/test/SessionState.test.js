/**
 * SessionState — Per-Archetype State Cache tests
 *
 * Tests the snapshot/restore lifecycle, isCustomized() helper,
 * resetToDefaults(), and the swapArchetype() auto-restore flow.
 */

const SessionState = require('../src/state/SessionState');
const Reveal = require('@electrosaur-labs/core');

// Use a real archetype ID so generateConfiguration returns deterministic values
const ARCHETYPE_A = 'standard-balanced';
const ARCHETYPE_B = 'photo-portrait';
const ARCHETYPE_C = 'graphic-vibrant';

// Dummy DNA for config generation
const DUMMY_DNA = new Reveal.DNAGenerator().generate(
    new Uint16Array(3 * 4 * 4), 4, 4, { bitDepth: 16 }
);

/**
 * Helper: set up a SessionState with minimal internal state.
 */
function setupSession(archetypeId = ARCHETYPE_A) {
    const session = new SessionState();

    session.imageDNA = DUMMY_DNA;
    session.currentConfig = Reveal.generateConfiguration(session.imageDNA, {
        manualArchetypeId: archetypeId
    });
    session._applyConfigToState(session.currentConfig);
    session.state.activeArchetypeId = archetypeId;

    // Mock proxyEngine
    session.proxyEngine = {
        proxyBuffer: new Uint16Array(10),
        separationState: {
            palette: [{ L: 50, a: 0, b: 0 }, { L: 80, a: 10, b: -20 }],
            rgbPalette: [{ r: 128, g: 128, b: 128 }, { r: 200, g: 180, b: 220 }],
            colorIndices: new Uint8Array([0, 1, 0, 1]),
            width: 2,
            height: 2
        },
        _baselineState: {
            palette: [{ L: 50, a: 0, b: 0 }, { L: 80, a: 10, b: -20 }]
        },
        rePosterize: vi.fn().mockResolvedValue({
            palette: [{ L: 50, a: 0, b: 0 }, { L: 80, a: 10, b: -20 }],
            dimensions: { width: 2, height: 2 },
            elapsedMs: 10
        }),
        updateProxy: vi.fn().mockResolvedValue({
            previewBuffer: new Uint8ClampedArray(16),
            palette: [{ L: 50, a: 0, b: 0 }, { L: 80, a: 10, b: -20 }],
            elapsedMs: 5
        }),
        getBaselineSnapshot: vi.fn().mockReturnValue({
            palette: [{ L: 50, a: 0, b: 0 }, { L: 80, a: 10, b: -20 }],
            rgbPalette: [{ r: 128, g: 128, b: 128 }, { r: 200, g: 180, b: 220 }],
            colorIndices: new Uint8Array([0, 1, 0, 1]),
            masks: [new Uint8Array([255, 0, 255, 0]), new Uint8Array([0, 255, 0, 255])],
            width: 2,
            height: 2,
            distanceMetric: 'cie76',
            metadata: {}
        }),
        restoreBaselineSnapshot: vi.fn().mockReturnValue({
            previewBuffer: new Uint8ClampedArray(16),
            palette: [{ L: 50, a: 0, b: 0 }, { L: 80, a: 10, b: -20 }],
            dimensions: { width: 2, height: 2 },
            metadata: {},
            elapsedMs: 1
        }),
        addColorAndReseparate: vi.fn().mockImplementation(async (labColor) => {
            session.proxyEngine._baselineState.palette.push({ ...labColor });
            return {
                palette: [...session.proxyEngine._baselineState.palette],
                dimensions: { width: 2, height: 2 },
                elapsedMs: 5
            };
        }),
        removeColorAndReseparate: vi.fn().mockImplementation(async (index) => {
            session.proxyEngine._baselineState.palette.splice(index, 1);
            return {
                palette: [...session.proxyEngine._baselineState.palette],
                dimensions: { width: 2, height: 2 },
                elapsedMs: 5
            };
        }),
    };

    return session;
}

// ─── _snapshotArchetypeState ──────────────────────────────

describe('_snapshotArchetypeState', () => {
    it('saves all knob values for the given archetype', () => {
        const s = setupSession();
        s.state.minVolume = 3.0;
        s.state.speckleRescue = 7;

        s._snapshotArchetypeState(ARCHETYPE_A);

        const cached = s._archetypeStateCache.get(ARCHETYPE_A);
        expect(cached).toBeDefined();
        expect(cached.knobs.minVolume).toBe(3.0);
        expect(cached.knobs.speckleRescue).toBe(7);
    });

    it('excludes session-level knobs (trapSize, meshSize) from per-archetype cache', () => {
        const s = setupSession();
        s.state.trapSize = 5;
        s.state.meshSize = 305;

        s._snapshotArchetypeState(ARCHETYPE_A);

        const cached = s._archetypeStateCache.get(ARCHETYPE_A);
        expect(cached.knobs.trapSize).toBeUndefined();
        expect(cached.knobs.meshSize).toBeUndefined();
    });

    it('deep-copies paletteOverrides (no shared references)', async () => {
        const s = setupSession();
        await s.overridePaletteColor(0, { L: 50, a: 10, b: -5 });

        s._snapshotArchetypeState(ARCHETYPE_A);

        // Mutate live map via another override
        await s.overridePaletteColor(0, { L: 99, a: 0, b: 0 });

        const cached = s._archetypeStateCache.get(ARCHETYPE_A);
        // The cache should have the first override
        expect(cached.graph.nodes.find(n => n[0] === 'palette-0')[1].overrideLab.L).toBe(50);
    });

    it('deep-copies mergeHistory and deletedColors', async () => {
        const s = setupSession();
        // Add a color so there are 3, allowing one deletion/merge without "last remaining" error
        await s.addPaletteColor({ L: 100, a: 0, b: 0 });
        await s.mergePaletteColors(1, 0);

        s._snapshotArchetypeState(ARCHETYPE_A);

        // Mutate live state
        await s.deletePaletteColor(0);

        const cached = s._archetypeStateCache.get(ARCHETYPE_A);
        const node1 = cached.graph.nodes.find(n => n[0] === 'palette-1')[1];
        expect(node1.mergeTargetId).toBe('palette-0');
        
        const node0 = cached.graph.nodes.find(n => n[0] === 'palette-0')[1];
        expect(node0.status).toBe('active'); // was active when snapshotted
    });

    it('does nothing when id is null', () => {
        const s = setupSession();
        s._snapshotArchetypeState(null);
        expect(s._archetypeStateCache.size).toBe(0);
    });
});

// ─── _restoreArchetypeState ───────────────────────────────

describe('_restoreArchetypeState', () => {
    it('restores knobs from cache', () => {
        const s = setupSession();
        s.state.minVolume = 4.0;
        s.state.speckleRescue = 9;
        s._snapshotArchetypeState(ARCHETYPE_A);

        s.state.minVolume = 0;
        s.state.speckleRescue = 0;

        const restored = s._restoreArchetypeState(ARCHETYPE_A);

        expect(restored).toBe(true);
        expect(s.state.minVolume).toBe(4.0);
        expect(s.state.speckleRescue).toBe(9);
    });

    it('does not restore session-level trapSize from cache', () => {
        const s = setupSession();
        s.state.trapSize = 5;
        s._snapshotArchetypeState(ARCHETYPE_A);

        s.state.trapSize = 0;

        s._restoreArchetypeState(ARCHETYPE_A);
        expect(s.state.trapSize).toBe(0);
    });

    it('restores palette surgery from cache', async () => {
        const s = setupSession();
        await s.overridePaletteColor(0, { L: 60, a: 5, b: -10 });
        await s.mergePaletteColors(1, 0);
        s._snapshotArchetypeState(ARCHETYPE_A);

        // Manually clear live state instead of resetToDefaults (which deletes cache)
        s._paletteSurgery.reset([{ L: 50, a: 0, b: 0 }, { L: 80, a: 10, b: -20 }]);

        s._restoreArchetypeState(ARCHETYPE_A);

        expect(s.paletteOverrides.size).toBe(2); // 0 is overridden, 1 is merged (reported as override)
        expect(s.paletteOverrides.get(0).L).toBe(60);
        expect(s.mergeHistory.get(0).has(1)).toBe(true);
    });

    it('deep-copies on restore (cache not mutated by later live changes)', async () => {
        const s = setupSession();
        await s.overridePaletteColor(0, { L: 60, a: 5, b: -10 });
        s._snapshotArchetypeState(ARCHETYPE_A);
        
        // Manually clear live state
        s._paletteSurgery.reset([{ L: 50, a: 0, b: 0 }, { L: 80, a: 10, b: -20 }]);

        s._restoreArchetypeState(ARCHETYPE_A);
        await s.overridePaletteColor(0, { L: 99, a: 0, b: 0 });

        const cached = s._archetypeStateCache.get(ARCHETYPE_A);
        expect(cached.graph.nodes.find(n => n[0] === 'palette-0')[1].overrideLab.L).toBe(60);
    });

    it('returns false when no cache entry exists', () => {
        const s = setupSession();
        expect(s._restoreArchetypeState('nonexistent')).toBe(false);
    });

    it('sets isKnobsCustomized=true when restored values differ from defaults', () => {
        const s = setupSession();
        s.state.minVolume = 99;
        s._snapshotArchetypeState(ARCHETYPE_A);

        s.state.minVolume = s._archetypeDefaults.minVolume;
        s.state.isKnobsCustomized = false;

        s._restoreArchetypeState(ARCHETYPE_A);
        expect(s.state.isKnobsCustomized).toBe(true);
    });

    it('sets isKnobsCustomized=false when restored values match defaults', () => {
        const s = setupSession();
        s._snapshotArchetypeState(ARCHETYPE_A);
        s._restoreArchetypeState(ARCHETYPE_A);
        expect(s.state.isKnobsCustomized).toBe(false);
    });
});

// ─── isCustomized ─────────────────────────────────────────

describe('isCustomized', () => {
    it('returns false when nothing is customized', () => {
        const s = setupSession();
        expect(s.isCustomized()).toBe(false);
    });

    it('returns true when knobs are customized', () => {
        const s = setupSession();
        s.state.isKnobsCustomized = true;
        expect(s.isCustomized()).toBe(true);
    });

    it('returns true when palette overrides exist', async () => {
        const s = setupSession();
        await s.overridePaletteColor(0, { L: 50, a: 0, b: 0 });
        expect(s.isCustomized()).toBe(true);
    });

    it('returns true when deleted colors exist', async () => {
        const s = setupSession();
        // Add color first so deletion works
        await s.addPaletteColor({ L: 100, a: 0, b: 0 });
        await s.deletePaletteColor(1);
        expect(s.isCustomized()).toBe(true);
    });

    it('returns true when a Suggested color is checked, even with no other edits', () => {
        // Checking a suggestion doesn't touch _paletteSurgery at all (it's
        // a separate commit-time-only mechanism, see SuggestionManager) --
        // isCustomized() used to only look at knobs + _paletteSurgery, so
        // this returned false and the Reset-to-Defaults button stayed
        // disabled even with a real, undiscardable customization pending.
        const s = setupSession();
        s.addCheckedSuggestion({ L: 42, a: 10, b: -10 });
        expect(s.isCustomized()).toBe(true);
    });
});

describe('addCheckedSuggestion / removeCheckedSuggestion emit paletteChanged', () => {
    it('addCheckedSuggestion emits paletteChanged', () => {
        const s = setupSession();
        const seen = [];
        s.on('paletteChanged', (data) => seen.push(data));

        s.addCheckedSuggestion({ L: 42, a: 10, b: -10 });

        expect(seen).toHaveLength(1);
    });

    it('removeCheckedSuggestion emits paletteChanged', () => {
        const s = setupSession();
        s.addCheckedSuggestion({ L: 42, a: 10, b: -10 });
        const seen = [];
        s.on('paletteChanged', (data) => seen.push(data));

        s.removeCheckedSuggestion({ L: 42, a: 10, b: -10 });

        expect(seen).toHaveLength(1);
        expect(s.checkedSuggestions).toEqual([]);
    });
});

// ─── addPaletteColor / removeAddedColor preserve existing edits ──

describe('addPaletteColor / removeAddedColor — preserve existing edits', () => {
    // 2026-11-12 regression: both methods called _paletteSurgery.initialize()
    // (= reset()) right after correctly appending/removing the node via
    // trackAddedColor()/removeTrackedColor() -- which rebuilt the whole
    // graph from scratch and silently discarded every prior merge, delete,
    // and override. "Palette loses all edits when I add a color."

    it('a prior override survives adding a new color', async () => {
        const s = setupSession();
        await s.overridePaletteColor(0, { L: 10, a: 1, b: 1 });
        expect(s.paletteOverrides.get(0)).toEqual({ L: 10, a: 1, b: 1 });

        await s.addPaletteColor({ L: 100, a: 0, b: 0 });

        expect(s.paletteOverrides.get(0)).toEqual({ L: 10, a: 1, b: 1 });
    });

    it('a prior merge survives adding a new color', async () => {
        const s = setupSession();
        await s.mergePaletteColors(1, 0);
        expect(s.mergeHistory.get(0).has(1)).toBe(true);

        await s.addPaletteColor({ L: 100, a: 0, b: 0 });

        expect(s.mergeHistory.get(0).has(1)).toBe(true);
    });

    it('a prior override survives removing an added color', async () => {
        const s = setupSession();
        await s.overridePaletteColor(0, { L: 10, a: 1, b: 1 });
        await s.addPaletteColor({ L: 100, a: 0, b: 0 }); // lands at index 2

        await s.removeAddedColor(2);

        expect(s.paletteOverrides.get(0)).toEqual({ L: 10, a: 1, b: 1 });
    });

    it('the added color keeps its removable "added" identity (not reset to a plain baseline node)', async () => {
        const s = setupSession();
        await s.addPaletteColor({ L: 100, a: 0, b: 0 }); // lands at index 2

        expect(s.addedColors.has(2)).toBe(true);
    });
});

// ─── generateHighlightPreview (solo view) ────────────────

describe('setHighlight / clearHighlight', () => {
    it('sets highlightColorIndex and emits highlightChanged', () => {
        const s = setupSession();
        const seen = [];
        s.on('highlightChanged', (data) => seen.push(data));

        s.setHighlight(3);

        expect(s.state.highlightColorIndex).toBe(3);
        expect(seen).toEqual([{ colorIndex: 3 }]);
    });

    it('clearHighlight resets to -1', () => {
        const s = setupSession();
        s.setHighlight(3);

        s.clearHighlight();

        expect(s.state.highlightColorIndex).toBe(-1);
    });
});

describe('generateHighlightPreview', () => {
    const DIM = 0x28;
    const isDimmed = (buf, pixelIdx) => {
        const off = pixelIdx * 4;
        return buf[off] === DIM && buf[off + 1] === DIM && buf[off + 2] === DIM;
    };

    it('includes pixels from a color that has been merged into the highlighted one', async () => {
        const s = setupSession();
        // mock colorIndices = [0, 1, 0, 1] -- pixels 1 and 3 are raw index 1.
        await s.mergePaletteColors(1, 0);

        const buf = s.generateHighlightPreview(0);
        expect(buf).not.toBeNull();

        // Previously only pixels 0/2 (raw index 0) lit up; pixels 1/3 (raw
        // index 1, now merged into 0) stayed dimmed because the check was
        // a raw equality against the unresolved colorIndices value, which
        // merges never touch. All four must be lit now.
        for (let i = 0; i < 4; i++) {
            expect(isDimmed(buf, i)).toBe(false);
        }
    });
});

// ─── exportSavedConfig / applySavedConfig ─────────────────

describe('exportSavedConfig', () => {
    it('captures archetype id, knobs, and overrides at full (unrounded) precision', async () => {
        const s = setupSession(ARCHETYPE_A);
        s.state.minVolume = 2.3456;
        await s.overridePaletteColor(0, { L: 51.2345, a: 1.8765, b: -2.1111 });

        const config = s.exportSavedConfig();

        expect(config.formatVersion).toBe(1);
        expect(config.archetypeId).toBe(ARCHETYPE_A);
        expect(config.knobs.minVolume).toBe(2.3456);
        expect(config.surgery.overrides['0']).toEqual({ L: 51.2345, a: 1.8765, b: -2.1111 });
        expect(typeof config.savedAt).toBe('string');
    });

    it('records merges and added colors', async () => {
        const s = setupSession(ARCHETYPE_A);
        await s.addPaletteColor({ L: 60, a: 5, b: -5 }); // lands at index 2
        await s.mergePaletteColors(1, 0);

        const config = s.exportSavedConfig();

        expect(config.surgery.merges['0']).toEqual([1]);
        expect(config.surgery.added['2']).toEqual({ L: 60, a: 5, b: -5 });
    });

    it('records a deletion as both a merge and a listed deletion', async () => {
        const s = setupSession(ARCHETYPE_A);
        await s.deletePaletteColor(1);

        const config = s.exportSavedConfig();

        expect(config.surgery.deletions).toContain(1);
    });
});

describe('applySavedConfig', () => {
    it('throws if no document is loaded', async () => {
        const s = new SessionState();
        await expect(s.applySavedConfig({ archetypeId: ARCHETYPE_A })).rejects.toThrow('No document loaded');
    });

    it('throws on an invalid config', async () => {
        const s = setupSession(ARCHETYPE_A);
        await expect(s.applySavedConfig(null)).rejects.toThrow('Invalid config');
    });

    it('round-trips archetype, knobs, overrides, merges, and added colors onto a fresh session', async () => {
        const source = setupSession(ARCHETYPE_A);
        source.state.minVolume = 3.5;
        await source.addPaletteColor({ L: 60, a: 5, b: -5 }); // lands at index 2
        await source.overridePaletteColor(0, { L: 70, a: 10, b: -10 });
        await source.mergePaletteColors(1, 0);

        const config = source.exportSavedConfig();

        // Target starts on a different archetype — applySavedConfig must swap to A.
        const target = setupSession(ARCHETYPE_B);
        await target.applySavedConfig(config);

        expect(target.state.activeArchetypeId).toBe(ARCHETYPE_A);
        expect(target.state.minVolume).toBe(3.5);
        expect(target.paletteOverrides.get(0)).toMatchObject({ L: 70, a: 10, b: -10 });
        expect(target.mergeHistory.get(0)).toEqual(new Set([1]));
        expect(target.addedColors.has(2)).toBe(true);
    });

    it('applies the saved archetype even when it is already active, discarding unrelated current edits', async () => {
        const source = setupSession(ARCHETYPE_A);
        await source.overridePaletteColor(0, { L: 70, a: 10, b: -10 });
        const config = source.exportSavedConfig();

        // Same session, same archetype, but with DIFFERENT current edits than the saved config.
        const target = setupSession(ARCHETYPE_A);
        await target.overridePaletteColor(1, { L: 20, a: -5, b: 5 });

        await target.applySavedConfig(config);

        expect(target.paletteOverrides.get(0)).toMatchObject({ L: 70, a: 10, b: -10 });
        expect(target.paletteOverrides.has(1)).toBe(false);
    });
});

// ─── resetToDefaults ──────────────────────────────────────

describe('resetToDefaults', () => {
    it('resets knobs to archetype defaults', () => {
        const s = setupSession();
        const defaultMinVol = s._archetypeDefaults.minVolume;
        const defaultSpeckle = s._archetypeDefaults.speckleRescue;

        s.state.minVolume = 4.5;
        s.state.speckleRescue = 10;
        s.state.isKnobsCustomized = true;

        s.resetToDefaults();

        expect(s.state.minVolume).toBe(defaultMinVol);
        expect(s.state.speckleRescue).toBe(defaultSpeckle);
        expect(s.state.isKnobsCustomized).toBe(false);
    });

    it('clears palette surgery', async () => {
        const s = setupSession();
        await s.overridePaletteColor(0, { L: 60, a: 5, b: -10 });
        await s.mergePaletteColors(1, 0);

        s.resetToDefaults();

        expect(s.paletteOverrides.size).toBe(0);
        expect(s.mergeHistory.size).toBe(0);
        expect(s.deletedColors.size).toBe(0);
    });

    it('clears suggested color selections', () => {
        const s = setupSession();
        s.addCheckedSuggestion({ L: 50, a: 10, b: -5 });
        s.resetToDefaults();
        expect(s.checkedSuggestions).toEqual([]);
    });

    it('deletes cache entry for current archetype', () => {
        const s = setupSession();
        s._snapshotArchetypeState(ARCHETYPE_A);
        expect(s._archetypeStateCache.has(ARCHETYPE_A)).toBe(true);

        s.resetToDefaults();

        expect(s._archetypeStateCache.has(ARCHETYPE_A)).toBe(false);
    });

    it('emits knobsCustomizedChanged, paletteChanged, configChanged, highlightChanged', () => {
        const s = setupSession();
        const events = [];
        s.on('knobsCustomizedChanged', (d) => events.push(['knobsCustomizedChanged', d]));
        s.on('paletteChanged', () => events.push(['paletteChanged']));
        s.on('configChanged', () => events.push(['configChanged']));
        s.on('highlightChanged', (d) => events.push(['highlightChanged', d]));

        s.resetToDefaults();

        const names = events.map(e => e[0]);
        expect(names).toContain('knobsCustomizedChanged');
        expect(names).toContain('paletteChanged');
        expect(names).toContain('configChanged');
        expect(names).toContain('highlightChanged');
    });

    it('does nothing when _archetypeDefaults is null', () => {
        const s = new SessionState();
        s.resetToDefaults(); // should not throw
        expect(s.state.isKnobsCustomized).toBe(false);
    });
});

// ─── swapArchetype (auto-restore integration) ─────────────

describe('swapArchetype auto-restore', () => {
    it('snapshots outgoing state and auto-restores on return', async () => {
        const s = setupSession(ARCHETYPE_A);

        // Customize A
        s.state.minVolume = 4.0;
        s.state.speckleRescue = 10;
        await s.overridePaletteColor(0, { L: 75, a: 20, b: -15 });

        // Swap to B
        await s.swapArchetype(ARCHETYPE_B);
        const bDefault = s._archetypeDefaults.minVolume;

        expect(s.state.activeArchetypeId).toBe(ARCHETYPE_B);
        expect(s.state.minVolume).toBe(bDefault);
        expect(s.paletteOverrides.size).toBe(0);

        // Swap back to A — should auto-restore
        await s.swapArchetype(ARCHETYPE_A);

        expect(s.state.activeArchetypeId).toBe(ARCHETYPE_A);
        expect(s.state.minVolume).toBe(4.0);
        expect(s.state.speckleRescue).toBe(10);
        expect(s.paletteOverrides.has(0)).toBe(true);
        expect(s.paletteOverrides.get(0).L).toBe(75);
    });

    it('passes paletteOverride to updateProxy when restoring cached surgery', async () => {
        const s = setupSession(ARCHETYPE_A);
        await s.overridePaletteColor(0, { L: 75, a: 20, b: -15 });

        await s.swapArchetype(ARCHETYPE_B);
        s.proxyEngine.updateProxy.mockClear();

        await s.swapArchetype(ARCHETYPE_A);

        const updateArgs = s.proxyEngine.updateProxy.mock.calls[0][0];
        expect(updateArgs.paletteOverride).toBeDefined();
    });

    it('omits paletteOverride when no cached palette surgery', async () => {
        const s = setupSession(ARCHETYPE_A);

        await s.swapArchetype(ARCHETYPE_B);
        s.proxyEngine.updateProxy.mockClear();

        await s.swapArchetype(ARCHETYPE_A);

        const updateArgs = s.proxyEngine.updateProxy.mock.calls[0][0];
        expect(updateArgs.paletteOverride).toBeUndefined();
    });

    it('resetToDefaults then swap-away-and-back arrives at fresh defaults', async () => {
        const s = setupSession(ARCHETYPE_A);
        const defaultMinVol = s._archetypeDefaults.minVolume;

        s.state.minVolume = 4.0;
        await s.overridePaletteColor(0, { L: 75, a: 20, b: -15 });
        s.resetToDefaults();

        await s.swapArchetype(ARCHETYPE_B);
        await s.swapArchetype(ARCHETYPE_A);

        expect(s.state.minVolume).toBe(defaultMinVol);
        expect(s.paletteOverrides.size).toBe(0);
        expect(s.state.isKnobsCustomized).toBe(false);
    });

    it('three-way swap preserves independent per-archetype state', async () => {
        const s = setupSession(ARCHETYPE_A);

        // Customize A
        s.state.minVolume = 4.0;
        await s.overridePaletteColor(0, { L: 75, a: 20, b: -15 });

        // Swap to B, customize differently
        await s.swapArchetype(ARCHETYPE_B);
        s.state.shadowClamp = 15;
        await s.overridePaletteColor(1, { L: 30, a: -5, b: 10 });

        // Swap to C (fresh)
        await s.swapArchetype(ARCHETYPE_C);
        expect(s.paletteOverrides.size).toBe(0);

        // Back to A
        await s.swapArchetype(ARCHETYPE_A);
        expect(s.state.minVolume).toBe(4.0);
        expect(s.paletteOverrides.get(0).L).toBe(75);
        expect(s.paletteOverrides.has(1)).toBe(false);

        // Back to B
        await s.swapArchetype(ARCHETYPE_B);
        expect(s.state.shadowClamp).toBe(15);
        expect(s.paletteOverrides.get(1).L).toBe(30);
        expect(s.paletteOverrides.has(0)).toBe(false);
    });

    // Every edit type the user can make on a palette, run through the same
    // swap-away-and-back cycle as the override tests above. Prior to this,
    // only override had this coverage -- which is exactly how the
    // checkedSuggestions regression below (archetype browsing silently and
    // permanently discarding checked "Suggested" colors, with no restore
    // on returning to the same archetype) went unnoticed.

    it('merge survives swap-away-and-back', async () => {
        const s = setupSession(ARCHETYPE_A);
        await s.mergePaletteColors(1, 0);
        expect(s.mergeHistory.get(0)).toEqual(new Set([1]));

        await s.swapArchetype(ARCHETYPE_B);
        expect(s.mergeHistory.size).toBe(0);

        await s.swapArchetype(ARCHETYPE_A);
        expect(s.mergeHistory.get(0)).toEqual(new Set([1]));
    });

    it('delete survives swap-away-and-back', async () => {
        const s = setupSession(ARCHETYPE_A);
        await s.deletePaletteColor(1);
        expect(s.deletedColors.has(1)).toBe(true);

        await s.swapArchetype(ARCHETYPE_B);
        expect(s.deletedColors.size).toBe(0);

        await s.swapArchetype(ARCHETYPE_A);
        expect(s.deletedColors.has(1)).toBe(true);
    });

    it('checked ("Suggested") colors survive swap-away-and-back', async () => {
        const s = setupSession(ARCHETYPE_A);
        s.addCheckedSuggestion({ L: 42, a: 10, b: -10 });
        expect(s.checkedSuggestions).toEqual([{ L: 42, a: 10, b: -10 }]);

        await s.swapArchetype(ARCHETYPE_B);
        // Cleared for the archetype actually being viewed now -- a
        // suggestion is specific to the archetype whose hue-gap analysis
        // produced it, same as palette overrides/merges aren't carried
        // over to a different archetype either.
        expect(s.checkedSuggestions).toEqual([]);

        await s.swapArchetype(ARCHETYPE_A);
        expect(s.checkedSuggestions).toEqual([{ L: 42, a: 10, b: -10 }]);
    });

    it('checked ("Suggested") colors survive a structural knob change (re-posterize WITHOUT a swap)', async () => {
        const s = setupSession(ARCHETYPE_A);
        s.addCheckedSuggestion({ L: 42, a: 10, b: -10 });

        // triggerProxyUpdate()'s isArchetypeDirty branch is a SEPARATE code
        // path from swapArchetype -- it runs on any structural knob change
        // (targetColors, quantizer, etc.) on the SAME archetype, and used
        // to call the same clearForSwap() that empties checkedSuggestions
        // with no restore anywhere in this path (unlike swapArchetype,
        // which at least caches-and-restores via _archetypeStateCache).
        s._structuralChangeConfirmed = true;
        s.updateParameter('targetColors', (s.state.targetColors || 6) + 1);
        expect(s.state.isArchetypeDirty).toBe(true);

        await s.triggerProxyUpdate();

        expect(s.checkedSuggestions).toEqual([{ L: 42, a: 10, b: -10 }]);
    });
});

// ─── _applyConfigToState: production knob injection ───────

describe('_applyConfigToState injects production knob defaults into config', () => {
    it('sets trapSize in config even though generateConfiguration omits it', () => {
        const session = new SessionState();
        session.imageDNA = DUMMY_DNA;
        const config = Reveal.generateConfiguration(DUMMY_DNA, { manualArchetypeId: ARCHETYPE_A });

        expect(config.trapSize).toBeUndefined();

        session._applyConfigToState(config);

        expect(config.trapSize).toBe(2);
        expect(session.state.trapSize).toBe(2);
    });

    it('swapArchetype emits configChanged with trapSize for fresh archetypes', async () => {
        const s = setupSession(ARCHETYPE_A);
        s.state.trapSize = 5;

        const configs = [];
        s.on('configChanged', (c) => configs.push({ ...c }));

        await s.swapArchetype(ARCHETYPE_B);

        expect(configs.length).toBeGreaterThan(0);
        expect(configs[configs.length - 1].trapSize).toBe(2);
    });

    it('swapArchetype emits configChanged with default trapSize (session-level, not cached)', async () => {
        const s = setupSession(ARCHETYPE_A);
        s.state.trapSize = 5;

        await s.swapArchetype(ARCHETYPE_B);

        const configs = [];
        s.on('configChanged', (c) => configs.push({ ...c }));

        await s.swapArchetype(ARCHETYPE_A);

        expect(configs.length).toBeGreaterThan(0);
        expect(configs[configs.length - 1].trapSize).toBe(2);
    });
});

// ─── reset() ──────────────────────────────────────────────

describe('reset()', () => {
    it('clears the archetype state cache', () => {
        const s = setupSession();
        s._snapshotArchetypeState(ARCHETYPE_A);
        expect(s._archetypeStateCache.size).toBe(1);

        s.reset();
        expect(s._archetypeStateCache.size).toBe(0);
    });
});
