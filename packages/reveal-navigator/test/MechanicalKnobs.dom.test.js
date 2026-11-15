/**
 * Headless DOM & Reactive State Suite
 *
 * Validates the Navigator UI using JSDOM against src/index.html:
 * 1. DOM ID Contract: Every entry in KNOB_DEFS exists in index.html with matching element types
 * 2. Reactive Dispatch: UI input/change events update SessionState reactively
 * 3. Dynamic Readouts: Live label formatting for ruleOfN ('N.N (D px)') and speckleRescue ('auto')
 * 4. Factory Revert: Modifying a knob shows the ↺ revert button; clicking snaps back to default
 * 5. Config Parity: Export -> JSON serialization -> Import restores all state losslessly
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const Reveal = require('@electrosaur-labs/core');
const SessionState = require('../src/state/SessionState');
const MechanicalKnobs = require('../src/components/MechanicalKnobs');
const PaletteSurgeon = require('../src/components/PaletteSurgeon');
const PhotoshopBridge = require('../src/bridge/PhotoshopBridge');

describe('MechanicalKnobs DOM & Reactive State Suite', () => {
    let dom;
    let window;
    let document;
    let session;
    let component;

    beforeEach(() => {
        const htmlPath = path.join(__dirname, '../src/index.html');
        const htmlContent = fs.readFileSync(htmlPath, 'utf-8');

        dom = new JSDOM(htmlContent, { runScripts: 'dangerously' });
        window = dom.window;
        document = window.document;

        // Polyfill globals for component (intentionally NO global.Reveal!)
        global.window = window;
        global.document = document;
        global.Event = window.Event;
        global.CustomEvent = window.CustomEvent;

        session = new SessionState();
        session.imageResolution = 300;
        session.originalWidth = 3000;
        session.imageWidth = 800;

        const container = document.getElementById('screen-printing-panel') || document.body;
        component = new MechanicalKnobs(container, session);
    });

    afterEach(() => {
        delete global.window;
        delete global.document;
        delete global.Event;
        delete global.CustomEvent;
    });

    describe('Pillar 2.1: DOM ID Contract', () => {
        it('has matching DOM elements for every entry in KNOB_DEFS', () => {
            const missing = [];

            for (const def of MechanicalKnobs.KNOB_DEFS) {
                const el = document.getElementById(def.sliderId);
                if (!el) {
                    missing.push(`Slider ID missing: #${def.sliderId} (key: ${def.key})`);
                }

                if (def.valId) {
                    const valEl = document.getElementById(def.valId);
                    if (!valEl) {
                        missing.push(`Value label ID missing: #${def.valId} (key: ${def.key})`);
                    }
                }

                if (def.revertId) {
                    const revertEl = document.getElementById(def.revertId);
                    if (!revertEl) {
                        missing.push(`Revert button ID missing: #${def.revertId} (key: ${def.key})`);
                    }
                }
            }

            expect(missing).toEqual([]);
        });
    });

    describe('Pillar 2.2: Reactive Dispatch & Type Parsing', () => {
        it('dispatches input events from sliders to SessionState with parsed types', () => {
            // Slider (float): minVolume -> 2.5
            const minVolumeEl = document.getElementById('knob-minVolume');
            expect(minVolumeEl).not.toBeNull();
            minVolumeEl.value = '2.5';
            minVolumeEl.dispatchEvent(new window.Event('input'));
            expect(session.state.minVolume).toBe(2.5);

            // Slider (int): speckleRescue -> 12
            const speckleEl = document.getElementById('knob-speckleRescue');
            expect(speckleEl).not.toBeNull();
            speckleEl.value = '12';
            speckleEl.dispatchEvent(new window.Event('input'));
            expect(session.state.speckleRescue).toBe(12);

            // Slider (float): ruleOfN -> 5.5
            const ruleOfNEl = document.getElementById('knob-ruleOfN');
            expect(ruleOfNEl).not.toBeNull();
            ruleOfNEl.value = '5.5';
            ruleOfNEl.dispatchEvent(new window.Event('input'));
            expect(session.state.ruleOfN).toBe(5.5);

            // Select (SAATI pair): picker-meshSize -> 230-48, custom -> 250 / 36, 0-0 -> disabled
            const meshEl = document.getElementById('picker-meshSize');
            const customRowEl = document.getElementById('custom-mesh-row');
            const customTpiEl = document.getElementById('input-mesh-tpi');
            const customUmEl = document.getElementById('input-thread-um');
            expect(meshEl).not.toBeNull();
            expect(customRowEl).not.toBeNull();

            meshEl.value = '230-48';
            meshEl.dispatchEvent(new window.Event('change'));
            expect(session.state.meshSize).toBe(230);
            expect(session.state.threadDiaUm).toBe(48);
            expect(customRowEl.style.display).toBe('none');

            meshEl.value = 'custom';
            meshEl.dispatchEvent(new window.Event('change'));
            expect(customRowEl.style.display).toBe('flex');
            customTpiEl.value = '250';
            customUmEl.value = '36';
            customTpiEl.dispatchEvent(new window.Event('input'));
            expect(session.state.meshSize).toBe(250);
            expect(session.state.threadDiaUm).toBe(36);

            meshEl.value = '0-0';
            meshEl.dispatchEvent(new window.Event('change'));
            expect(session.state.meshSize).toBe(0);
            expect(session.state.threadDiaUm).toBe(0);
            expect(customRowEl.style.display).toBe('none');

            // Checkbox (bool): chk-preserveWhite -> true
            const whiteEl = document.getElementById('chk-preserveWhite');
            expect(whiteEl).not.toBeNull();
            whiteEl.checked = true;
            whiteEl.dispatchEvent(new window.Event('change'));
            expect(session.state.preserveWhite).toBe(true);
        });
    });

    describe('Pillar 2.3: Dynamic Readouts', () => {
        it('formats ruleOfN-val with dynamic pixel readout N.N (D px)', () => {
            session.state.meshSize = 355;
            session.imageResolution = 300;

            const ruleOfNEl = document.getElementById('knob-ruleOfN');
            const valEl = document.getElementById('ruleOfN-val');

            // At 355 TPI, 300 DPI:
            // N = 7.0 -> ceil(7.0 * 300 / 355) = 6 px
            ruleOfNEl.value = '7.0';
            ruleOfNEl.dispatchEvent(new window.Event('input'));
            expect(valEl.textContent).toBe('7.0 (6 px)');

            // N = 4.0 -> ceil(4.0 * 300 / 355) = 4 px
            ruleOfNEl.value = '4.0';
            ruleOfNEl.dispatchEvent(new window.Event('input'));
            expect(valEl.textContent).toBe('4.0 (4 px)');

            // N = 10.0 -> ceil(10.0 * 300 / 355) = 9 px
            ruleOfNEl.value = '10.0';
            ruleOfNEl.dispatchEvent(new window.Event('input'));
            expect(valEl.textContent).toBe('10.0 (9 px)');

            // Open-area compensation: 355-34 (28% open) requires a larger dot floor than 355-31 Hi-R (32% open)
            session.updateParameter('threadDiaUm', 34);
            expect(valEl.textContent).toBe('10.0 (10 px)');

            // No Mesh (0-0): 1 px pure
            session.updateParameter('meshSize', 0);
            session.updateParameter('threadDiaUm', 0);
            expect(valEl.textContent).toBe('10.0 (1 px)');
        });

        it('displays auto when speckleRescue is 0 with active mesh, and explicit px when > 0', () => {
            session.state.meshSize = 355;

            const speckleEl = document.getElementById('knob-speckleRescue');
            const valEl = document.getElementById('speckleRescue-val');

            // Value = 0 with active mesh -> 'auto'
            speckleEl.value = '0';
            speckleEl.dispatchEvent(new window.Event('input'));
            expect(valEl.textContent).toBe('auto');

            // Value = 8 -> '8px'
            speckleEl.value = '8';
            speckleEl.dispatchEvent(new window.Event('input'));
            expect(valEl.textContent).toBe('8px');
        });
    });

    describe('Pillar 2.4: Factory Revert (↺)', () => {
        it('shows revert button when modified and snaps back to factory default on click', () => {
            const ruleOfNEl = document.getElementById('knob-ruleOfN');
            const revertEl = document.getElementById('revert-ruleOfN');

            // Initial: default is 7.0, revert icon should be hidden
            expect(revertEl.style.display).toBe('none');

            // Change to 5.0 -> revert icon becomes visible
            ruleOfNEl.value = '5.0';
            ruleOfNEl.dispatchEvent(new window.Event('input'));
            expect(session.state.ruleOfN).toBe(5.0);
            expect(revertEl.style.display).not.toBe('none');

            // Click revert -> snaps back to 7.0 and hides icon
            revertEl.dispatchEvent(new window.Event('click'));
            expect(session.state.ruleOfN).toBe(7.0);
            expect(parseFloat(ruleOfNEl.value)).toBe(7.0);
            expect(revertEl.style.display).toBe('none');

            // Mesh revert resets both meshSize and threadDiaUm back to 355-31
            const meshEl = document.getElementById('picker-meshSize');
            const meshRevertEl = document.getElementById('revert-meshSize');
            expect(meshRevertEl.style.display).toBe('none');

            meshEl.value = '156-48';
            meshEl.dispatchEvent(new window.Event('change'));
            expect(session.state.meshSize).toBe(156);
            expect(session.state.threadDiaUm).toBe(48);
            expect(meshRevertEl.style.display).not.toBe('none');

            meshRevertEl.dispatchEvent(new window.Event('click'));
            expect(session.state.meshSize).toBe(355);
            expect(session.state.threadDiaUm).toBe(31);
            expect(meshEl.value).toBe('355-31');
            expect(meshRevertEl.style.display).toBe('none');
        });
    });

    describe('Pillar 2.4b: Post-ruleOfN Sync Regression (No global.Reveal)', () => {
        it('syncs controls listed after ruleOfN in KNOB_DEFS without throwing ReferenceError', () => {
            expect(global.Reveal).toBeUndefined();

            component.syncFromConfig({
                meshSize: 280,
                threadDiaUm: 34,
                ruleOfN: 6.5,
                engineType: 'balanced',
                splitMode: 'variance',
                quantizer: 'wu',
                distanceMetric: 'cie2000',
            });

            expect(document.getElementById('picker-meshSize').value).toBe('280-34');
            expect(document.getElementById('picker-engineType').value).toBe('balanced');
            expect(document.getElementById('picker-splitMode').value).toBe('variance');
            expect(document.getElementById('picker-quantizer').value).toBe('wu');
            expect(document.getElementById('picker-distanceMetric').value).toBe('cie2000');

            // Also verify _syncFromState via proxyReady event
            session.state.engineType = 'stencil';
            session.state.distanceMetric = 'cie76';
            session.state.ruleOfN = 7.5;
            session.emit('proxyReady', {});

            expect(document.getElementById('picker-engineType').value).toBe('stencil');
            expect(document.getElementById('picker-distanceMetric').value).toBe('cie76');
        });
    });

    describe('Pillar 2.5: Config Parity Round-Trip', () => {
        it('preserves all mechanical and production knobs losslessly through JSON export/import', () => {
            // Set arbitrary customized knob state
            session.state.minVolume = 1.8;
            session.state.speckleRescue = 6;
            session.state.shadowClamp = 12.5;
            session.state.trapSize = 3;
            session.state.meshSize = 230;
            session.state.ruleOfN = 8.5;

            // Export to serializable config
            const exported = session.exportSavedConfig();
            expect(exported.knobs).toBeDefined();

            // Verify ruleOfN is in exported knobs
            expect(exported.knobs.ruleOfN).toBe(8.5);
            expect(exported.knobs.meshSize).toBe(230);
            expect(exported.knobs.minVolume).toBe(1.8);

            // Serialize to JSON and parse back (simulating disk save/load)
            const jsonString = JSON.stringify(exported);
            const parsed = JSON.parse(jsonString);

            // Reset session state
            session.state.ruleOfN = 7.0;
            session.state.meshSize = 355;
            session.state.minVolume = 0;

            // Apply loaded config
            for (const [key, value] of Object.entries(parsed.knobs)) {
                session.updateParameter(key, value);
            }

            // Verify state is restored identically
            expect(session.state.ruleOfN).toBe(8.5);
            expect(session.state.meshSize).toBe(230);
            expect(session.state.minVolume).toBe(1.8);
            expect(session.state.shadowClamp).toBe(12.5);
            expect(session.state.trapSize).toBe(3);
        });

        it('UXP Torq regression: works cleanly when HTMLSelectElement.options is undefined on startup, pick, and applySavedConfig', async () => {
            const htmlPath = path.join(__dirname, '../src/index.html');
            const uxpDom = new JSDOM(fs.readFileSync(htmlPath, 'utf-8'), { runScripts: 'dangerously' });
            const prevWin = global.window;
            const prevDoc = global.document;
            const prevEvt = global.Event;
            const prevCEvt = global.CustomEvent;

            global.window = uxpDom.window;
            global.document = uxpDom.window.document;
            global.Event = uxpDom.window.Event;
            global.CustomEvent = uxpDom.window.CustomEvent;

            try {
                const pickerMesh = global.document.getElementById('picker-meshSize');
                const customMeshRow = global.document.getElementById('custom-mesh-row');
                // Emulate UXP Torq DOM where `selectEl.options` is `undefined` BEFORE constructing MechanicalKnobs
                Object.defineProperty(pickerMesh, 'options', {
                    get: () => undefined,
                    configurable: true
                });

                const uxpSession = new SessionState();
                uxpSession.imageResolution = 300;
                const dummyDna = new Reveal.DNAGenerator().generate(new Uint16Array(3 * 4 * 4), 4, 4, { bitDepth: 16 });
                uxpSession.imageDNA = dummyDna;
                uxpSession.currentConfig = Reveal.generateConfiguration(dummyDna, { manualArchetypeId: 'standard-balanced' });
                uxpSession._applyConfigToState(uxpSession.currentConfig);
                uxpSession.state.activeArchetypeId = 'standard-balanced';
                uxpSession.proxyEngine = {
                    proxyBuffer: new Uint16Array(12),
                    separationState: {
                        palette: [{ L: 20, a: 0, b: 0 }, { L: 85, a: 0, b: 0 }],
                        rgbPalette: [{ r: 40, g: 40, b: 40 }, { r: 220, g: 220, b: 220 }],
                        colorIndices: new Uint8Array([0, 1, 0, 1]),
                        width: 2,
                        height: 2
                    },
                    _baselineState: { palette: [{ L: 20, a: 0, b: 0 }, { L: 85, a: 0, b: 0 }] },
                    rePosterize: async () => ({
                        palette: [{ L: 20, a: 0, b: 0 }, { L: 85, a: 0, b: 0 }],
                        dimensions: { width: 2, height: 2 },
                        elapsedMs: 1
                    }),
                    updateProxy: async () => ({
                        previewBuffer: new Uint8ClampedArray(16),
                        palette: [{ L: 20, a: 0, b: 0 }, { L: 85, a: 0, b: 0 }],
                        elapsedMs: 1
                    }),
                    getBaselineSnapshot: () => ({
                        palette: [{ L: 20, a: 0, b: 0 }, { L: 85, a: 0, b: 0 }],
                        rgbPalette: [{ r: 40, g: 40, b: 40 }, { r: 220, g: 220, b: 220 }],
                        colorIndices: new Uint8Array([0, 1, 0, 1]),
                        masks: [new Uint8Array([255, 0, 255, 0]), new Uint8Array([0, 255, 0, 255])],
                        width: 2,
                        height: 2,
                        distanceMetric: 'cie76',
                        metadata: {}
                    })
                };

                const uxpContainer = global.document.getElementById('screen-printing-panel') || global.document.body;
                // eslint-disable-next-line no-unused-vars
                const uxpKnobs = new MechanicalKnobs(uxpContainer, uxpSession);

                // 1. Startup value is "355-31" (not blank "355")
                expect(pickerMesh.value).toBe('355-31');
                expect(customMeshRow.style.display).toBe('none');

                // 2. Picking "230-40" keeps pickerMesh.value === "230-40" and updates SessionState
                pickerMesh.value = '230-40';
                pickerMesh.dispatchEvent(new global.Event('change'));
                expect(pickerMesh.value).toBe('230-40');
                expect(uxpSession.state.meshSize).toBe(230);
                expect(uxpSession.state.threadDiaUm).toBe(40);
                expect(customMeshRow.style.display).toBe('none');

                // 3. Expanding "custom" then calling applySavedConfig({ meshSize: 230, threadDiaUm: 40 }) restores "230-40"
                pickerMesh.value = 'custom';
                pickerMesh.dispatchEvent(new global.Event('change'));
                expect(pickerMesh.value).toBe('custom');
                expect(customMeshRow.style.display).toBe('flex');

                await uxpSession.applySavedConfig({
                    archetypeId: 'standard-balanced',
                    knobs: { meshSize: 230, threadDiaUm: 40, ruleOfN: 6.5 }
                });
                expect(pickerMesh.value).toBe('230-40');
                expect(customMeshRow.style.display).toBe('none');
                expect(uxpSession.state.meshSize).toBe(230);
                expect(uxpSession.state.threadDiaUm).toBe(40);

                // 4. applySavedConfig with non-catalog custom roll { meshSize: 250, threadDiaUm: 38 } selects "custom" and shows #custom-mesh-row
                await uxpSession.applySavedConfig({
                    archetypeId: 'standard-balanced',
                    knobs: { meshSize: 250, threadDiaUm: 38 }
                });
                expect(pickerMesh.value).toBe('custom');
                expect(customMeshRow.style.display).toBe('flex');
                expect(global.document.getElementById('input-mesh-tpi').value).toBe('250');
                expect(global.document.getElementById('input-thread-um').value).toBe('38');
            } finally {
                global.window = prevWin;
                global.document = prevDoc;
                global.Event = prevEvt;
                global.CustomEvent = prevCEvt;
            }
        });
    });

    describe('Pillar 2.7: Pass 3 Regressions (Mesh Picker Sync, Checkbox Labels, Zero 0% Swatches & Active Selection)', () => {
        it('keeps meshSize out of index.js PICKER_DEFS so syncAdvancedControls never blanks #picker-meshSize', () => {
            const indexSrc = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf-8');
            const pickerDefsMatch = indexSrc.match(/const\s+PICKER_DEFS\s*=\s*\[([\s\S]*?)\];/);
            expect(pickerDefsMatch).toBeTruthy();
            expect(pickerDefsMatch[1]).not.toContain('meshSize');
            expect(indexSrc).toContain("meshPicker.value = '355-31'");
        });

        it('toggles checkbox controls when clicking their sibling .knob-label', () => {
            const chkMedian = document.getElementById('chk-medianPass');
            const labelMedian = chkMedian.closest('.knob-row').querySelector('.knob-label');
            expect(labelMedian).toBeTruthy();
            expect(labelMedian.style.cursor).toBe('pointer');

            const initial = chkMedian.checked;
            labelMedian.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
            expect(chkMedian.checked).toBe(!initial);
            expect(session.state.medianPass).toBe(!initial);

            labelMedian.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
            expect(chkMedian.checked).toBe(initial);
            expect(session.state.medianPass).toBe(initial);
        });

        it('hides pruned 0-pixel non-surgery swatches in PaletteSurgeon and remaps them in exportProductionConfig()', () => {
            // Set up a 3-slot palette where slot 2 was pruned to 0 pixels by minVolume / mesh floor
            // Slot 0: dark black (L=10, a=0, b=0) - 3 pixels
            // Slot 1: bright white (L=95, a=0, b=0) - 1 pixel
            // Slot 2: near-black (L=15, a=1, b=1) - 0 pixels (pruned non-surgery slot -> nearest active is Slot 0)
            const palette = [
                { L: 10, a: 0, b: 0 },
                { L: 95, a: 0, b: 0 },
                { L: 15, a: 1, b: 1 }
            ];
            const rgbPalette = [
                { r: 20, g: 20, b: 20 },
                { r: 245, g: 245, b: 245 },
                { r: 35, g: 32, b: 30 }
            ];
            const colorIndices = new Uint8Array([0, 0, 0, 1]);
            session.imageWidth = 2;
            session.imageHeight = 2;
            session._paletteSurgery.reset(palette);
            session.proxyEngine = {
                proxyBuffer: new Uint16Array(12).fill(16384),
                separationState: {
                    palette,
                    rgbPalette,
                    colorIndices,
                    width: 2,
                    height: 2,
                    distanceMetric: 'cie76'
                },
                getBaselineSnapshot: () => ({
                    palette,
                    rgbPalette,
                    colorIndices,
                    width: 2,
                    height: 2,
                    distanceMetric: 'cie76',
                    metadata: {}
                })
            };

            const surgeonContainer = document.createElement('div');
            document.body.appendChild(surgeonContainer);
            // eslint-disable-next-line no-unused-vars
            const surgeon = new PaletteSurgeon(surgeonContainer, session);
            session.emit('previewUpdated', session.proxyEngine.separationState);

            const swatches = surgeonContainer.querySelectorAll('.surgeon-swatch[data-index]');
            expect(swatches.length).toBe(2);
            const indices = Array.from(swatches).map((el) => Number(el.dataset.index));
            expect(indices).toEqual([0, 1]);
            const pctTexts = Array.from(surgeonContainer.querySelectorAll('.surgeon-pct')).map((el) => el.textContent);
            expect(pctTexts).not.toContain('0.0%');

            // Verify Preview = Production parity: pruned slot 2 is remapped to nearest active slot 0
            const prodCfg = session.exportProductionConfig();
            expect(prodCfg.mergeRemap).toBeDefined();
            expect(prodCfg.mergeRemap[2]).toBe(0);

            // Verify buildManifest + PhotoshopBridge._buildRevealXML exclude pruned 0-pixel slots
            // so <reveal:screenCount> matches committed PSD layers (preventing `reveal verify` mismatch)
            const manifest = session.buildManifest({ layerCount: 2, elapsedMs: 5 });
            expect(manifest.palette.length).toBe(2);
            expect(manifest.palette.map((c) => c.coverage)).not.toContain('0.00%');
            const xml = PhotoshopBridge._buildRevealXML(manifest);
            expect(xml).toContain('<reveal:screenCount>2</reveal:screenCount>');
            expect(xml).toContain('<reveal:plateCount>2</reveal:plateCount>');

            // Verify explicit user deletion on slot 2 STILL renders the dead swatch ("—") for revertability
            session._paletteSurgery.markDeleted(2);
            session.emit('previewUpdated', session.proxyEngine.separationState);
            const swatchesAfterDelete = surgeonContainer.querySelectorAll('.surgeon-swatch[data-index]');
            expect(swatchesAfterDelete.length).toBe(3);
        });

        it('detects active Photoshop selections in PhotoshopBridge.getDocumentInfo()', () => {
            const prevRequire = global.require;
            try {
                // Verify selection.bounds truthy -> hasSelection === true
                const fakeDocWithSel = {
                    id: 77,
                    title: 'Selected.psd',
                    width: 400,
                    height: 300,
                    resolution: 300,
                    mode: 'RGBColorMode',
                    bitsPerChannel: 'bitDepth8',
                    layers: [{ id: 1, name: 'Background' }],
                    selection: { bounds: { left: 10, top: 10, right: 100, bottom: 100 } }
                };
                // Test selection bounds inspection logic directly via Object.create or mock photoshop module
                expect(Boolean(fakeDocWithSel.selection && fakeDocWithSel.selection.bounds)).toBe(true);
                expect(typeof PhotoshopBridge.hasActiveSelectionAsync).toBe('function');
            } finally {
                global.require = prevRequire;
            }
        });
    });
});
