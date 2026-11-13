/**
 * SessionState Integration Tests — Real ProxyEngine + Real Image Data
 *
 * Bridges the gap between:
 *   - SessionState.test.js (state machine only, mock ProxyEngine)
 *   - reveal-core integration tests (engines only, no SessionState)
 *
 * Exercises the full Navigator user flow:
 *   ingest → archetype swap → knob change → export production config
 *
 * Uses the 350×512 horse fixture (430KB gzipped, checked into reveal-core).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const SessionState = require('../src/state/SessionState');
const Reveal = require('@electrosaur-labs/core');

const PosterizationEngine = Reveal.engines.PosterizationEngine;

// ─── Fixture ──────────────────────────────────────────────

const FIXTURE_PATH = path.resolve(
    __dirname, '../../reveal-core/test/fixtures/horse-350x512-lab16.labbin.gz'
);

function loadHorseFixture() {
    const gz = fs.readFileSync(FIXTURE_PATH);
    const raw = zlib.gunzipSync(gz);
    const width = raw.readUInt32LE(4);
    const height = raw.readUInt32LE(8);
    const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);
    return { pixels, width, height };
}

// ─── Setup Helper ─────────────────────────────────────────

/**
 * Wire SessionState to a real ProxyEngine with real image data.
 * Replicates the core wiring from loadImage() without UI yields
 * or background scoring.
 */
async function setupRealSession(archetypeId = 'everyday_photo') {
    const session = new SessionState();
    const { pixels, width, height } = loadHorseFixture();

    // Phase 1: DNA analysis
    const dnaGen = new Reveal.DNAGenerator();
    session.imageDNA = dnaGen.generate(pixels, width, height, { bitDepth: 16 });
    session.imageWidth = width;
    session.imageHeight = height;

    // Phase 2: Config generation
    session.currentConfig = Reveal.generateConfiguration(session.imageDNA, {
        manualArchetypeId: archetypeId
    });
    session._applyConfigToState(session.currentConfig);
    session.state.activeArchetypeId = archetypeId;
    if (!session.currentConfig.engineType) {
        session.currentConfig.engineType = session.state.engineType;
    }

    // Phase 3: Real ProxyEngine initialization
    session.proxyEngine = new Reveal.ProxyEngine();
    await session.proxyEngine.initializeProxy(pixels, width, height, session.currentConfig);
    // Real loadImage() does this right after initializeProxy() resolves
    // (SessionState.js) -- the proxyEngine setter runs it too early (before
    // _baselineState exists), so without this, _paletteSurgery stays bound
    // to its default empty graph and any surgery call before the first
    // swapArchetype() silently operates on zero nodes.
    session._paletteSurgery.initialize(session.proxyEngine);

    // Phase 4: Apply initial knobs
    const knobResult = await session.proxyEngine.updateProxy({
        minVolume: session.state.minVolume,
        speckleRescue: session.state.speckleRescue,
        shadowClamp: session.state.shadowClamp
    });
    session.previewBuffer = knobResult.previewBuffer;
    session.state.proxyBufferReady = true;

    return session;
}

// ─── Tests ────────────────────────────────────────────────

describe('SessionState + real ProxyEngine integration', () => {

    it('ingest produces a valid palette and proxy state', async () => {
        const session = await setupRealSession();
        const sep = session.proxyEngine.separationState;

        // Palette should have meaningful color count
        expect(sep.palette.length).toBeGreaterThanOrEqual(5);

        // Each palette entry is a Lab color
        for (const c of sep.palette) {
            expect(c).toHaveProperty('L');
            expect(c).toHaveProperty('a');
            expect(c).toHaveProperty('b');
        }

        // Proxy dimensions within expected range
        expect(sep.width).toBeLessThanOrEqual(512);
        expect(sep.height).toBeLessThanOrEqual(512);
        expect(Math.max(sep.width, sep.height)).toBeGreaterThanOrEqual(256);

        // Separation state populated
        expect(sep.colorIndices).toBeInstanceOf(Uint8Array);
        expect(sep.colorIndices.length).toBe(sep.width * sep.height);
        expect(session.proxyEngine.proxyBuffer).toBeDefined();

        // Preview buffer ready
        expect(session.previewBuffer).toBeDefined();
        expect(session.state.proxyBufferReady).toBe(true);
    }, 30000);

    it('archetype swap changes palette through real re-posterization', async () => {
        const session = await setupRealSession('minkler');
        const paletteBefore = session.proxyEngine.separationState.palette.map(c => ({ ...c }));
        const countBefore = paletteBefore.length;

        await session.swapArchetype('fine_art_scan');

        const paletteAfter = session.proxyEngine.separationState.palette;
        expect(session.state.activeArchetypeId).toBe('fine_art_scan');

        // Palette should differ — check via best-match ΔE sum
        // (positional comparison fails when same colors appear in different order)
        let totalBestDE = 0;
        for (const before of paletteBefore) {
            let bestDE = Infinity;
            for (const after of paletteAfter) {
                const de = Reveal.LabDistance.cie76(before, after);
                if (de < bestDE) bestDE = de;
            }
            totalBestDE += bestDE;
        }
        const avgBestDE = totalBestDE / paletteBefore.length;

        // Different archetypes should produce at least slightly different palettes
        // (count differs OR average best-match ΔE > 0.5)
        const countChanged = paletteAfter.length !== countBefore;
        expect(countChanged || avgBestDE > 0.5).toBe(true);
    }, 30000);

    it('mechanical knob change flows through real ProxyEngine.updateProxy', async () => {
        const session = await setupRealSession();

        // Change minVolume to a non-zero value
        session.state.minVolume = 3.0;
        if (session.currentConfig) session.currentConfig.minVolume = 3.0;

        // Directly trigger update (bypass debounce)
        const result = await session.triggerProxyUpdate();

        expect(result).toBeDefined();
        // Preview buffer updated
        expect(session.previewBuffer).toBeDefined();
        expect(session.previewBuffer.length).toBeGreaterThan(0);
    }, 30000);

    it('exportProductionConfig includes all required fields', async () => {
        const session = await setupRealSession('everyday_photo');
        await session.swapArchetype('fine_art_scan');

        const prodConfig = session.exportProductionConfig();

        // Source metadata
        expect(prodConfig.width).toBe(350);
        expect(prodConfig.height).toBe(512);
        expect(prodConfig.dna).toBeDefined();
        expect(prodConfig.dna.global).toBeDefined();

        // Archetype
        expect(prodConfig.activeArchetypeId).toBe('fine_art_scan');

        // Palette: array of Lab colors
        expect(Array.isArray(prodConfig.palette)).toBe(true);
        expect(prodConfig.palette.length).toBeGreaterThanOrEqual(3);
        for (const c of prodConfig.palette) {
            expect(typeof c.L).toBe('number');
            expect(typeof c.a).toBe('number');
            expect(typeof c.b).toBe('number');
        }

        // Separation palette
        expect(Array.isArray(prodConfig.separationPalette)).toBe(true);
        expect(prodConfig.separationPalette.length).toBe(prodConfig.palette.length);

        // Structural params
        expect(typeof prodConfig.distanceMetric).toBe('string');
        expect(typeof prodConfig.targetColors).toBe('number');

        // Mechanical knobs present
        expect(typeof prodConfig.minVolume).toBe('number');
        expect(typeof prodConfig.speckleRescue).toBe('number');
        expect(typeof prodConfig.shadowClamp).toBe('number');

        // Generated config snapshot
        expect(prodConfig.generatedConfig).toBeDefined();
    }, 30000);

    // ─── exportSavedConfig / applySavedConfig (real engine) ───
    //
    // Mock-based SessionState.test.js can't catch this class of bug: its
    // mock proxyEngine doesn't model addColorAndReseparate growing the
    // real baseline palette, so the duplicate-color regression below was
    // invisible there.

    it('applySavedConfig onto the SAME already-active archetype does not duplicate an added color', async () => {
        const session = await setupRealSession('everyday_photo');
        const countBefore = session.proxyEngine.separationState.palette.length;

        await session.addPaletteColor({ L: 60, a: 5, b: -5 });
        expect(session.addedColors.has(countBefore)).toBe(true);

        const config = session.exportSavedConfig();
        await session.applySavedConfig(config);

        // Previously: swapArchetype's auto-restore picked up a cached
        // baseline that already included the added color (added colors
        // grow the proxy engine's OWN baseline, not just graph metadata),
        // and the surgery replay then added it again on top -- landing
        // one slot later than it started and leaving the palette one
        // color too long.
        expect(session.proxyEngine.separationState.palette.length).toBe(countBefore + 1);
        expect(session.addedColors.has(countBefore)).toBe(true);
    }, 30000);

    it('applySavedConfig preserves a merged-away swatch\'s OWN identity color, not the target\'s', async () => {
        const session = await setupRealSession('everyday_photo');
        const identityBefore = session._paletteSurgery.getIdentityPalette()[0];

        await session.mergePaletteColors(0, 7);

        const config = session.exportSavedConfig();
        // exportSavedConfig must not synthesize a frozen "override" for the
        // merge source equal to the target's color -- the merge relation
        // alone is enough for a correct replay.
        expect(config.surgery.overrides['0']).toBeUndefined();

        await session.applySavedConfig(config);

        // Previously: the synthesized override got replayed as a REAL
        // overrideLab on node 0, so getIdentityPalette() (which the UI uses
        // for the merged/"X" swatch's own color) returned the TARGET's
        // frozen color instead of node 0's actual original color.
        expect(session._paletteSurgery.getIdentityPalette()[0]).toMatchObject(identityBefore);
    }, 30000);

    it('applySavedConfig restores checked ("Suggested") colors', async () => {
        const session = await setupRealSession('everyday_photo');
        session.addCheckedSuggestion({ L: 42, a: 10, b: -10 });

        const config = session.exportSavedConfig();
        expect(config.checkedSuggestions).toEqual([{ L: 42, a: 10, b: -10 }]);

        await session.applySavedConfig(config);

        expect(session.checkedSuggestions).toEqual([{ L: 42, a: 10, b: -10 }]);
    }, 30000);

    it('restored checked suggestions are visible to the UI\'s redraw trigger, not just the final settled state', async () => {
        // Regression test for a real user report: the backend-data test
        // above (checkedSuggestions round-trips) always passed, yet the
        // Navigator UI never showed the restored suggestion as checked.
        // Root cause: applySavedConfig emitted 'previewUpdated' --
        // PaletteSurgeon's ONLY trigger for re-rendering the suggestions
        // tray -- BEFORE replaying checkedSuggestions, so the UI redrew
        // against a still-empty list and was never told to redraw again.
        // A test that only checks state after applySavedConfig resolves
        // can't catch an ordering bug like this -- it has to inspect
        // state at the moment the UI's actual redraw signal fires.
        const session = await setupRealSession('everyday_photo');

        // Use a REAL suggestion from the engine's own gap analysis, not an
        // arbitrary Lab value -- that's what the UI actually renders from
        // (PaletteSurgeon._renderSuggestedColors() iterates
        // session.getSuggestedColors(), not the checked list directly).
        const realSuggestion = session.getSuggestedColors()[0];
        expect(realSuggestion).toBeDefined();
        session.addCheckedSuggestion(realSuggestion);

        const config = session.exportSavedConfig();

        let checkedAtPreviewUpdated = null;
        session.on('previewUpdated', () => {
            // Snapshot synchronously -- this is exactly what
            // PaletteSurgeon's own 'previewUpdated' handler would see.
            checkedAtPreviewUpdated = [...session.checkedSuggestions];
        });

        await session.applySavedConfig(config);

        expect(checkedAtPreviewUpdated).toEqual([
            { L: realSuggestion.L, a: realSuggestion.a, b: realSuggestion.b }
        ]);
    }, 30000);

    it('PaletteSurgeon._renderSuggestedColors()\'s full decision logic shows the restored suggestion as checked', async () => {
        // Same regression as above, but replicates PaletteSurgeon's ACTUAL
        // rendering decision line-for-line (cachedSuggestions pool ->
        // filter by isSuggestionChecked/closeness), run inside the real
        // 'previewUpdated' handler, instead of just asserting on
        // session.checkedSuggestions directly. This is as close as a
        // DOM-less test can get to "would the checkbox actually render
        // as checked".
        const session = await setupRealSession('everyday_photo');
        const realSuggestion = session.getSuggestedColors()[0];
        session.addCheckedSuggestion(realSuggestion);

        const config = session.exportSavedConfig();

        const deltaE = (c1, c2) => Reveal.LabDistance.cie76(c1, c2);
        const isTooCloseToCurrentPalette = (suggestion) => {
            const sep = session.getSeparationState();
            if (!sep || !sep.palette) return false;
            return sep.palette.some(pal => deltaE(suggestion, pal) < 15);
        };

        let renderedAsChecked = null;
        session.on('previewUpdated', () => {
            const cachedSuggestions = session.getSuggestedColors();
            const visible = (cachedSuggestions || []).filter(s =>
                session.isSuggestionChecked(s) || !isTooCloseToCurrentPalette(s)
            );
            const match = visible.find(s => session.isSuggestionChecked(s));
            renderedAsChecked = match || null;
        });

        await session.applySavedConfig(config);

        expect(renderedAsChecked).not.toBeNull();
        expect(renderedAsChecked).toMatchObject({
            L: realSuggestion.L, a: realSuggestion.a, b: realSuggestion.b
        });
    }, 30000);

    it('proxy posterize matches direct posterize on same buffer with proxy-safe overrides', async () => {
        const session = await setupRealSession();
        const proxy = session.proxyEngine;
        const proxyBuf = proxy.proxyBuffer;
        const sep = proxy.separationState;

        // Direct posterize on same proxy buffer WITH exact proxy-safe overrides.
        // Must match ProxyEngine's PROXY_SAFE_OVERRIDES exactly:
        // format, bitDepth, snapThreshold, densityFloor, enablePaletteReduction, preservedUnifyThreshold
        const directResult = PosterizationEngine.posterize(
            proxyBuf, sep.width, sep.height,
            session.currentConfig.targetColors,
            {
                ...session.currentConfig,
                format: 'lab',
                bitDepth: 16,
                snapThreshold: 0,
                densityFloor: 0,
                enablePaletteReduction: false,
                preservedUnifyThreshold: 0.5
            }
        );

        // Compare against baseline palette (pre-knob application).
        // updateProxy() applies maxColors cap even with minVolume=0,
        // which can reduce the palette; baseline is the clean posterize output.
        const baselinePaletteCount = proxy._baselineState.palette.length;
        expect(baselinePaletteCount).toBe(directResult.paletteLab.length);
    }, 30000);
});

// ─── Palette Surgery (real engine) ─────────────────────────
//
// The exportSavedConfig/applySavedConfig bugs (duplicate added color,
// corrupted merge-source identity) were both invisible to
// SessionState.test.js's mocked proxyEngine -- the mock doesn't model
// real baseline growth or real per-pixel reassignment, so bugs specific
// to those mechanics only showed up here. This block exercises every
// PaletteSurgeryManager operation (override, merge, delete, add, remove,
// revert) against the real engine, not just the save/load path.

describe('Palette Surgery + real ProxyEngine', () => {

    it('deletePaletteColor merges the deleted color into its nearest neighbor and reassigns its pixels', async () => {
        const session = await setupRealSession('everyday_photo');
        const countBefore = session.proxyEngine.separationState.palette.length;
        const colorIndicesBefore = session.proxyEngine.separationState.colorIndices;
        const deletedPixelCount = colorIndicesBefore.filter(ci => ci === 1).length;
        expect(deletedPixelCount).toBeGreaterThan(0);

        await session.deletePaletteColor(1);

        expect(session.deletedColors.has(1)).toBe(true);
        const target = [...session.mergeHistory.entries()].find(([, srcs]) => srcs.has(1))?.[0];
        expect(target).toBeDefined();

        // Palette array itself is untouched by delete (only graph metadata +
        // reseparation change) -- same length, deleted slot still present.
        expect(session.proxyEngine.separationState.palette.length).toBe(countBefore);

        // The deleted color's pixels must have gone SOMEWHERE else; raw
        // index 1 should no longer appear in a fresh separation pass over
        // the resolved palette (reflected via the merge-aware consolidation
        // the manifest/XMP export uses).
        const colorIndicesAfter = session.proxyEngine.separationState.colorIndices;
        const { survivingIndices } = require('../src/utils/paletteCoverage').consolidatePaletteCoverage(
            colorIndicesAfter, session.proxyEngine.separationState.palette.length, session.mergeHistory
        );
        expect(survivingIndices).not.toContain(1);
    }, 30000);

    it('removeAddedColor undoes addPaletteColor, shrinking the baseline back', async () => {
        const session = await setupRealSession('everyday_photo');
        const countBefore = session.proxyEngine.separationState.palette.length;

        await session.addPaletteColor({ L: 60, a: 5, b: -5 });
        expect(session.proxyEngine.separationState.palette.length).toBe(countBefore + 1);
        expect(session.addedColors.has(countBefore)).toBe(true);

        await session.removeAddedColor(countBefore);

        expect(session.proxyEngine.separationState.palette.length).toBe(countBefore);
        expect(session.addedColors.size).toBe(0);
    }, 30000);

    it('addPaletteColor survives swap-away-and-back without duplicating (real baseline growth, not just graph metadata)', async () => {
        const session = await setupRealSession('everyday_photo');
        const countBefore = session.proxyEngine.separationState.palette.length;

        await session.addPaletteColor({ L: 60, a: 5, b: -5 });
        expect(session.proxyEngine.separationState.palette.length).toBe(countBefore + 1);
        expect(session.addedColors.has(countBefore)).toBe(true);

        await session.swapArchetype('fine_art_scan');
        expect(session.addedColors.size).toBe(0); // different archetype, no carryover

        await session.swapArchetype('everyday_photo');

        // This is the normal interactive swap-back path (restoreBaselineSnapshot
        // + full surgery restore), NOT applySavedConfig's forceFreshBaseline
        // replay path -- the added color should come back from the cached
        // baseline/graph as-is, with no re-add and so no duplicate.
        expect(session.proxyEngine.separationState.palette.length).toBe(countBefore + 1);
        expect(session.addedColors.has(countBefore)).toBe(true);
    }, 30000);

    it('revertPaletteColor undoes overridePaletteColor, restoring the original Lab value', async () => {
        const session = await setupRealSession('everyday_photo');
        const original = { ...session.proxyEngine.separationState.palette[0] };

        await session.overridePaletteColor(0, { L: 10, a: 2, b: 3 });
        expect(session.paletteOverrides.get(0)).toMatchObject({ L: 10, a: 2, b: 3 });

        await session.revertPaletteColor(0);

        expect(session.paletteOverrides.has(0)).toBe(false);
        expect(session._paletteSurgery.getIdentityPalette()[0]).toMatchObject({ L: original.L, a: original.a, b: original.b });
    }, 30000);

    it('two independent sources merged into the same target consolidate to one surviving entry with combined coverage', async () => {
        const session = await setupRealSession('everyday_photo');
        const { consolidatePaletteCoverage } = require('../src/utils/paletteCoverage');
        const paletteLength = session.proxyEngine.separationState.palette.length;

        await session.mergePaletteColors(0, 5);
        await session.mergePaletteColors(2, 5);

        expect(session.mergeHistory.get(5)).toEqual(new Set([0, 2]));

        const colorIndices = session.proxyEngine.separationState.colorIndices;
        const rawCount0 = colorIndices.filter(ci => ci === 0).length;
        const rawCount2 = colorIndices.filter(ci => ci === 2).length;
        const rawCount5 = colorIndices.filter(ci => ci === 5).length;

        const { pixelCounts, survivingIndices } = consolidatePaletteCoverage(colorIndices, paletteLength, session.mergeHistory);

        // This is the real-engine version of the "why is black appearing
        // twice" regression: without consolidation, a manifest would list
        // 0, 2, and 5 as three separate entries for what the user sees as
        // one swatch; raw colorIndices still carries each pixel's
        // PRE-merge index since merging never re-separates the proxy.
        expect(pixelCounts[5]).toBe(rawCount0 + rawCount2 + rawCount5);
        expect(pixelCounts[0]).toBe(0);
        expect(pixelCounts[2]).toBe(0);
        expect(survivingIndices).toContain(5);
        expect(survivingIndices).not.toContain(0);
        expect(survivingIndices).not.toContain(2);
    }, 30000);

    it('exportProductionConfig stays internally consistent with add + override + merge + delete combined', async () => {
        const session = await setupRealSession('everyday_photo');
        const countBefore = session.proxyEngine.separationState.palette.length;

        await session.addPaletteColor({ L: 55, a: 8, b: -12 });       // index countBefore
        await session.overridePaletteColor(1, { L: 30, a: 1, b: 1 }); // live override, unrelated to any merge
        await session.mergePaletteColors(3, 2);                       // plain merge
        await session.deletePaletteColor(4);                          // delete (= merge + deleted flag)

        const prodConfig = session.exportProductionConfig();

        // Fill palette (labPalette) includes the override and the added
        // color, at full, unreduced length -- production always creates a
        // layer per slot (merged/deleted ones get skipped downstream by
        // ProductionWorker based on zero mask coverage, not by shrinking
        // this array).
        expect(prodConfig.palette.length).toBe(countBefore + 1);
        expect(prodConfig.palette[1]).toMatchObject({ L: 30, a: 1, b: 1 });
        expect(prodConfig.palette[countBefore]).toMatchObject({ L: 55, a: 8, b: -12 });

        // separationPalette is the BASELINE (pre-override) palette used for
        // nearest-neighbor -- index 1 must NOT carry the override color,
        // or ProductionWorker's "sepPal vs fill: DIFFERS" diagnostic would
        // be lying about why.
        expect(prodConfig.separationPalette[1]).not.toMatchObject({ L: 30, a: 1, b: 1 });

        // mergeRemap resolves every dead slot to its final living target.
        expect(prodConfig.mergeRemap).not.toBeNull();
        expect(prodConfig.mergeRemap[3]).toBe(2);
    }, 30000);

    // ─── buildManifest (the XMP manifest embedded in exported PSDs) ───
    //
    // buildManifest() was completely unreachable from any test before this
    // (it lazily requires PhotoshopBridge -> the "photoshop" UXP module,
    // which doesn't exist outside Photoshop) -- see test/setup.js and
    // test/mocks/photoshop.js for how it's now stubbed. It shares the
    // exact rawOverrides/mergeSources construction that exportSavedConfig
    // does, so it carried the identical merge-identity bug with zero
    // coverage to catch it.

    it('buildManifest does not synthesize a frozen override for a merge source', async () => {
        const session = await setupRealSession('everyday_photo');
        await session.mergePaletteColors(0, 7);

        const manifest = session.buildManifest({ layerCount: 1, elapsedMs: 10 });

        expect(manifest.surgery.overrides['0']).toBeUndefined();
        expect(manifest.surgery.merges['7']).toEqual([0]);
    }, 30000);

    it('buildManifest consolidates a merged color into one palette entry with combined coverage', async () => {
        const { consolidatePaletteCoverage } = require('../src/utils/paletteCoverage');
        const session = await setupRealSession('everyday_photo');
        const paletteLength = session.proxyEngine.separationState.palette.length;

        await session.mergePaletteColors(0, 7);

        // mergePaletteColors -> triggerProxyUpdate re-runs the mechanical
        // knobs (minVolume etc.) against the new paletteOverride, which can
        // shift colorIndices beyond just the merge -- read the POST-merge
        // buffer, the same one buildManifest will read, rather than
        // assuming it matches a pre-merge snapshot.
        const colorIndices = session.proxyEngine.separationState.colorIndices;
        const { pixelCounts } = consolidatePaletteCoverage(colorIndices, paletteLength, session.mergeHistory);
        const totalPixels = colorIndices.length;
        const expectedPct = ((pixelCounts[7] / totalPixels) * 100).toFixed(2) + '%';

        const manifest = session.buildManifest({ layerCount: 1, elapsedMs: 10 });
        const combinedEntry = manifest.palette.find(c => c.coverage === expectedPct);

        expect(manifest.palette.length).toBe(8); // one fewer than the 9-color baseline -- merge source doesn't get its own entry
        expect(pixelCounts[7]).toBeGreaterThan(0);
        expect(combinedEntry).toBeDefined();
    }, 30000);

    it('buildManifest includes checked suggestions and deletions', async () => {
        const session = await setupRealSession('everyday_photo');
        session.addCheckedSuggestion({ L: 42, a: 10, b: -10 });
        await session.deletePaletteColor(1);

        const manifest = session.buildManifest({ layerCount: 1, elapsedMs: 10 });

        const suggestionRgb = Reveal.labToRgbD50({ L: 42, a: 10, b: -10 });
        const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
        const suggestionHex = `#${toHex(suggestionRgb.r)}${toHex(suggestionRgb.g)}${toHex(suggestionRgb.b)}`.toUpperCase();

        expect(manifest.surgery.deletions).toContain(1);
        expect(manifest.palette.some(c => c.hex === suggestionHex)).toBe(true);
    }, 30000);

    it('buildManifest reads the document name via the stubbed PhotoshopBridge', async () => {
        const session = await setupRealSession('everyday_photo');
        const manifest = session.buildManifest({ layerCount: 1, elapsedMs: 10 });
        expect(manifest.meta.filename).toBe('test-document.psd');
    }, 30000);
});
