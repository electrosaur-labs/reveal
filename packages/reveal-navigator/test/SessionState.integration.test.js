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
        const session = await setupRealSession('bold_poster');
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

    it('proxy posterize matches direct posterize on same buffer with proxy-safe overrides', async () => {
        const session = await setupRealSession();
        const proxy = session.proxyEngine;
        const proxyBuf = proxy.proxyBuffer;
        const sep = proxy.separationState;

        // Direct posterize on same proxy buffer WITH proxy-safe overrides
        // (ProxyEngine zeros snapThreshold, densityFloor, disables paletteReduction)
        const directResult = PosterizationEngine.posterize(
            proxyBuf, sep.width, sep.height,
            session.currentConfig.targetColors,
            {
                ...session.currentConfig,
                format: 'lab',
                snapThreshold: 0,
                densityFloor: 0,
                enablePaletteReduction: false
            }
        );

        // Palette counts should match — same input, same config, same overrides
        expect(sep.palette.length).toBe(directResult.paletteLab.length);
    }, 30000);
});
