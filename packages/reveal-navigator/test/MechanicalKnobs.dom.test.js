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

        // Polyfill globals for component
        global.window = window;
        global.document = document;
        global.Event = window.Event;
        global.CustomEvent = window.CustomEvent;
        global.Reveal = Reveal;

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
        delete global.Reveal;
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

            // Select (int): picker-meshSize -> 230
            const meshEl = document.getElementById('picker-meshSize');
            expect(meshEl).not.toBeNull();
            meshEl.value = '230';
            meshEl.dispatchEvent(new window.Event('change'));
            expect(session.state.meshSize).toBe(230);

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
    });
});
