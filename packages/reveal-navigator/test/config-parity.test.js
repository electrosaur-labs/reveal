/**
 * Config Parity — Navigator ↔ Core Wiring Contract
 *
 * Guards against divergence between reveal-core's ParameterGenerator
 * and Navigator's SessionState → exportProductionConfig() → ProductionWorker
 * pipeline. Catches:
 *   - New params added to ParameterGenerator but not to CONFIG_CATEGORIES
 *   - Fields ProductionWorker reads that SessionState doesn't export
 *   - _applyConfigToState() dropping or mangling config values
 */

const SessionState = require('../src/state/SessionState');
const Reveal = require('@reveal/core');

const { CONFIG_CATEGORIES, KNOB_DEFAULTS } = Reveal.engines.ParameterGenerator;

const ARCHETYPE_ID = 'standard-balanced';

// Minimal DNA — same pattern as SessionState.test.js
const DUMMY_DNA = new Reveal.DNAGenerator().generate(
    new Uint16Array(3 * 4 * 4), 4, 4, { bitDepth: 16 }
);

/**
 * Set up a SessionState with real ParameterGenerator config + mock proxyEngine.
 */
function setupSession(archetypeId = ARCHETYPE_ID) {
    const session = new SessionState();

    session.imageDNA = DUMMY_DNA;
    session.currentConfig = Reveal.generateConfiguration(session.imageDNA, {
        manualArchetypeId: archetypeId
    });
    session._applyConfigToState(session.currentConfig);
    session.state.activeArchetypeId = archetypeId;

    // Mock proxyEngine (exportProductionConfig reads separationState + _baselineState)
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
    };

    return session;
}

// ─── Test 1: ProductionWorker field coverage ─────────────────

describe('exportProductionConfig() includes every field ProductionWorker reads', () => {
    // These are the fields ProductionWorker.execute() reads from prodConfig.
    // Extracted by grepping `prodConfig.` in ProductionWorker.js.
    const PRODUCTION_WORKER_FIELDS = [
        'distanceMetric',
        'preprocessingIntensity',
        'ditherType',
        'meshSize',
        'minVolume',
        'speckleRescue',
        'shadowClamp',
        'trapSize',
        'palette',
        'separationPalette',
        'activeArchetypeId',
        'targetColors',
    ];

    it('all required fields are present and defined', () => {
        const session = setupSession();
        const prodConfig = session.exportProductionConfig();

        for (const field of PRODUCTION_WORKER_FIELDS) {
            expect(prodConfig).toHaveProperty(field);
            expect(prodConfig[field]).not.toBeUndefined();
        }
    });

    it('palette and separationPalette are non-empty arrays', () => {
        const session = setupSession();
        const prodConfig = session.exportProductionConfig();

        expect(Array.isArray(prodConfig.palette)).toBe(true);
        expect(prodConfig.palette.length).toBeGreaterThan(0);
        expect(Array.isArray(prodConfig.separationPalette)).toBe(true);
        expect(prodConfig.separationPalette.length).toBeGreaterThan(0);
    });

    it('mergeRemap and paletteOverrides are present (may be null/empty)', () => {
        const session = setupSession();
        const prodConfig = session.exportProductionConfig();

        // These fields exist in the export but may be null/empty when no surgery
        expect('mergeRemap' in prodConfig).toBe(true);
        expect('paletteOverrides' in prodConfig).toBe(true);
    });
});

// ─── Test 2: Config round-trip fidelity ──────────────────────

describe('config round-trip preserves production-relevant fields', () => {
    const ALL_STRUCTURAL = CONFIG_CATEGORIES.STRUCTURAL;
    const ALL_MECHANICAL = CONFIG_CATEGORIES.MECHANICAL;
    const ALL_PRODUCTION = CONFIG_CATEGORIES.PRODUCTION;

    it('STRUCTURAL fields survive ParameterGenerator → SessionState → export', () => {
        const generatedConfig = Reveal.generateConfiguration(DUMMY_DNA, {
            manualArchetypeId: ARCHETYPE_ID
        });

        const session = setupSession();
        const prodConfig = session.exportProductionConfig();

        for (const key of ALL_STRUCTURAL) {
            if (generatedConfig[key] === undefined) continue; // field not set by this archetype

            expect(prodConfig[key]).toEqual(generatedConfig[key]);
        }
    });

    it('MECHANICAL fields have correct defaults', () => {
        const session = setupSession();
        const prodConfig = session.exportProductionConfig();

        // Mechanical knobs default to 0 unless the archetype overrides them
        const generatedConfig = Reveal.generateConfiguration(DUMMY_DNA, {
            manualArchetypeId: ARCHETYPE_ID
        });

        for (const key of ALL_MECHANICAL) {
            const expected = generatedConfig[key] !== undefined
                ? generatedConfig[key]
                : KNOB_DEFAULTS.MECHANICAL[key];
            expect(prodConfig[key]).toEqual(expected);
        }
    });

    it('PRODUCTION fields have SessionState defaults', () => {
        const session = setupSession();
        const prodConfig = session.exportProductionConfig();

        // trapSize and meshSize come from SessionState defaults, not ParameterGenerator
        expect(prodConfig.trapSize).toBe(0);
        expect(prodConfig.meshSize).toBe(230);
    });
});

// ─── Test 3: ParameterGenerator field categorization ─────────

describe('every ParameterGenerator production field is categorized', () => {
    // Non-parameter metadata fields that don't need to be in CONFIG_CATEGORIES.
    // These are identity/metadata, not tunable parameters.
    const METADATA_WHITELIST = new Set([
        'id', 'name', 'engineType',  // archetype identity
        'meta',                        // metadata object
        'preprocessing',               // preprocessing config object (not a scalar)
        'rangeClamp',                  // derived from DNA, not a knob
        'targetColorsSlider',          // alias for targetColors
    ]);

    // Internal engine fields set by archetypes but not exposed as user-facing
    // knobs. They flow through the ...config spread in exportProductionConfig(),
    // but they're not in CONFIG_CATEGORIES because they don't trigger
    // re-posterization/mask-rebuild independently.
    const ENGINE_INTERNAL_WHITELIST = new Set([
        'bWeight',                          // b-axis weight (archetype-driven)
        'chromaAxisWeight',                 // median cut chroma axis tuning
        'neutralIsolationThreshold',        // neutral isolation in median cut
        'warmABoost',                       // warm a-axis boost
        'peakFinderMaxPeaks',               // Mk 1.5 peak detection
        'peakFinderBlacklistedSectors',     // Mk 1.5 sector blacklist
        'shadowChromaGateL',               // dark pixel chroma gate
        'neutralCentroidClampThreshold',    // hardcoded 0.5, not user-tunable
    ]);

    it('all config fields are either categorized or explicitly whitelisted', () => {
        const config = Reveal.generateConfiguration(DUMMY_DNA, {
            manualArchetypeId: ARCHETYPE_ID
        });

        const allCategorized = new Set([
            ...CONFIG_CATEGORIES.STRUCTURAL,
            ...CONFIG_CATEGORIES.MECHANICAL,
            ...CONFIG_CATEGORIES.PRODUCTION,
        ]);

        const uncategorized = [];
        for (const key of Object.keys(config)) {
            if (allCategorized.has(key)) continue;
            if (METADATA_WHITELIST.has(key)) continue;
            if (ENGINE_INTERNAL_WHITELIST.has(key)) continue;
            uncategorized.push(key);
        }

        if (uncategorized.length > 0) {
            throw new Error(
                `ParameterGenerator.generate() produces fields not in CONFIG_CATEGORIES ` +
                `and not whitelisted: [${uncategorized.join(', ')}]. ` +
                `Add them to CONFIG_CATEGORIES (if they're user-facing knobs) or to ` +
                `ENGINE_INTERNAL_WHITELIST in this test (if they're internal engine params).`
            );
        }
    });

    it('CONFIG_CATEGORIES fields all appear in generated config', () => {
        const config = Reveal.generateConfiguration(DUMMY_DNA, {
            manualArchetypeId: ARCHETYPE_ID
        });

        const allCategorized = [
            ...CONFIG_CATEGORIES.STRUCTURAL,
            ...CONFIG_CATEGORIES.MECHANICAL,
            ...CONFIG_CATEGORIES.PRODUCTION,
        ];

        const missing = [];
        for (const key of allCategorized) {
            if (!(key in config)) {
                missing.push(key);
            }
        }

        // PRODUCTION fields (trapSize, meshSize) are set by SessionState, not ParameterGenerator.
        // ditherType IS set by ParameterGenerator.
        const expectedMissing = new Set(['trapSize', 'meshSize']);
        const reallyMissing = missing.filter(k => !expectedMissing.has(k));

        if (reallyMissing.length > 0) {
            throw new Error(
                `CONFIG_CATEGORIES contains fields not produced by ParameterGenerator.generate(): ` +
                `[${reallyMissing.join(', ')}]. Either add them to generate() or remove from CONFIG_CATEGORIES.`
            );
        }
    });
});
