/**
 * MechanicalKnobs - Real-time slider control for print quality parameters
 *
 * Three scrubbable knobs that drive the ProxyEngine fast path (~50-100ms):
 *   - minVolume:      Ghost plate removal (0-5%)
 *   - speckleRescue:  Halftone solidity (0-30px)
 *   - shadowClamp:    Ink body control (0-40%, tonal L-value modulated)
 *
 * Each slider has a revert arrow (↺) that appears only when its value
 * differs from the archetype default. Clicking it snaps that single
 * knob back to factory.
 *
 * Uses `input` event (not `change`) for smooth drag feel.
 * SessionState.updateParameter() handles 50ms debounce internally.
 *
 * Vanilla+ pattern: subscribes to SessionState events.
 */

const Reveal = require('@electrosaur-labs/core');
const logger = Reveal.logger;

const KNOB_DEFS = [
    // Primary knobs
    { key: 'targetColors',   sliderId: 'knob-targetColors',   valId: 'targetColors-val',   revertId: 'revert-targetColors',   decimals: 0, unit: ''   },
    { key: 'preserveWhite',  sliderId: 'chk-preserveWhite',    valId: null,                revertId: 'revert-preserveWhite',  decimals: 0, unit: ''   },
    { key: 'preserveBlack',  sliderId: 'chk-preserveBlack',    valId: null,                revertId: 'revert-preserveBlack',  decimals: 0, unit: ''   },
    { key: 'ditherType',     sliderId: 'picker-ditherType',    valId: null,                revertId: 'revert-ditherType',     decimals: 0, unit: ''   },
    { key: 'minVolume',      sliderId: 'knob-minVolume',      valId: 'minVolume-val',      revertId: 'revert-minVolume',      decimals: 1, unit: '%'  },
    { key: 'speckleRescue',  sliderId: 'knob-speckleRescue',  valId: 'speckleRescue-val',  revertId: 'revert-speckleRescue',  decimals: 0, unit: 'px' },
    { key: 'shadowClamp',    sliderId: 'knob-shadowClamp',    valId: 'shadowClamp-val',    revertId: 'revert-shadowClamp',    decimals: 1, unit: '%'  },
    { key: 'trapSize',       sliderId: 'knob-trapSize',       valId: 'trapSize-val',       revertId: 'revert-trapSize',       decimals: 0, unit: 'pt' },

    // Advanced: Chroma
    { key: 'vibrancyBoost',      sliderId: 'knob-vibrancyBoost',      valId: 'vibrancyBoost-val',      revertId: 'revert-vibrancyBoost',      decimals: 2, unit: '×' },
    { key: 'vibrancyMode',       sliderId: 'picker-vibrancyMode',    valId: null,                revertId: 'revert-vibrancyMode',       decimals: 0, unit: ''   },
    { key: 'chromaGate',         sliderId: 'knob-chromaGate',         valId: 'chromaGate-val',         revertId: 'revert-chromaGate',         decimals: 1, unit: '×' },

    // Advanced: Palette
    { key: 'paletteReduction',   sliderId: 'knob-paletteReduction',   valId: 'paletteReduction-val',   revertId: 'revert-paletteReduction',   decimals: 1, unit: ''  },
    { key: 'enablePaletteReduction', sliderId: 'chk-enablePaletteReduction', valId: null,          revertId: 'revert-enablePaletteReduction', decimals: 0, unit: '' },
    { key: 'enableHueGapAnalysis', sliderId: 'chk-enableHueGapAnalysis', valId: null,              revertId: 'revert-enableHueGapAnalysis', decimals: 0, unit: '' },
    { key: 'hueLockAngle',       sliderId: 'knob-hueLockAngle',       valId: 'hueLockAngle-val',       revertId: 'revert-hueLockAngle',       decimals: 0, unit: '°' },

    // Advanced: Weights
    { key: 'lWeight',            sliderId: 'knob-lWeight',            valId: 'lWeight-val',            revertId: 'revert-lWeight',            decimals: 1, unit: '×' },
    { key: 'cWeight',            sliderId: 'knob-cWeight',            valId: 'cWeight-val',            revertId: 'revert-cWeight',            decimals: 1, unit: '×' },
    { key: 'blackBias',          sliderId: 'knob-blackBias',          valId: 'blackBias-val',          revertId: 'revert-blackBias',          decimals: 1, unit: ''  },

    // Advanced: Tone
    { key: 'highlightThreshold', sliderId: 'knob-highlightThreshold', valId: 'highlightThreshold-val', revertId: 'revert-highlightThreshold', decimals: 0, unit: ' L' },
    { key: 'highlightBoost',     sliderId: 'knob-highlightBoost',     valId: 'highlightBoost-val',     revertId: 'revert-highlightBoost',     decimals: 1, unit: '×' },
    { key: 'shadowPoint',        sliderId: 'knob-shadowPoint',        valId: 'shadowPoint-val',        revertId: 'revert-shadowPoint',        decimals: 0, unit: ' L' },

    // Advanced: Substrate
    { key: 'substrateMode',      sliderId: 'picker-substrateMode',   valId: null,                     revertId: 'revert-substrateMode',      decimals: 0, unit: ''  },
    { key: 'substrateTolerance', sliderId: 'knob-substrateTolerance', valId: 'substrateTolerance-val', revertId: 'revert-substrateTolerance', decimals: 1, unit: ''  },
    { key: 'ignoreTransparent',  sliderId: 'chk-ignoreTransparent',  valId: null,                     revertId: 'revert-ignoreTransparent',  decimals: 0, unit: ''  },
    { key: 'meshSize',           sliderId: 'picker-meshSize',         valId: null,                     revertId: 'revert-meshSize',          decimals: 0, unit: ''  },
    { key: 'ruleOfN',            sliderId: 'knob-ruleOfN',            valId: 'ruleOfN-val',            revertId: 'revert-ruleOfN',           decimals: 1, unit: ''  },

    // Advanced: Noise
    { key: 'preprocessingIntensity', sliderId: 'picker-preprocessingIntensity', valId: null,          revertId: 'revert-preprocessingIntensity', decimals: 0, unit: '' },
    { key: 'detailRescue',       sliderId: 'knob-detailRescue',       valId: 'detailRescue-val',       revertId: 'revert-detailRescue',       decimals: 0, unit: ''  },
    { key: 'medianPass',         sliderId: 'chk-medianPass',          valId: null,                     revertId: 'revert-medianPass',         decimals: 0, unit: ''  },

    // Advanced: Engine
    { key: 'engineType',         sliderId: 'picker-engineType',      valId: null,                     revertId: 'revert-engineType',         decimals: 0, unit: ''  },
    { key: 'colorMode',          sliderId: 'picker-colorMode',       valId: null,                     revertId: 'revert-colorMode',          decimals: 0, unit: ''  },
    { key: 'splitMode',          sliderId: 'picker-splitMode',       valId: null,                     revertId: 'revert-splitMode',          decimals: 0, unit: ''  },
    { key: 'quantizer',          sliderId: 'picker-quantizer',       valId: null,                     revertId: 'revert-quantizer',          decimals: 0, unit: ''  },
    { key: 'distanceMetric',     sliderId: 'picker-distanceMetric',  valId: null,                     revertId: 'revert-distanceMetric',     decimals: 0, unit: ''  },
    { key: 'centroidStrategy',   sliderId: 'picker-centroidStrategy', valId: null,                    revertId: 'revert-centroidStrategy',   decimals: 0, unit: ''  },
    { key: 'neutralSovereigntyThreshold',   sliderId: 'knob-neutralSovereigntyThreshold',   valId: 'neutralSovereigntyThreshold-val',   revertId: 'revert-neutralSovereigntyThreshold',   decimals: 0, unit: '' }
];

class MechanicalKnobs {

    /**
     * @param {HTMLElement} container - The #knobs-panel element
     * @param {import('../state/SessionState')} sessionState
     */
    constructor(container, sessionState) {
        this._container = container;
        this._session = sessionState;
        this._elements = {};  // key → { el, valEl, revertEl, def }
        this._customMeshRow = null;
        this._inputMeshTpi = null;
        this._inputThreadUm = null;
        this._meshOptionValues = new Set();
        this._customMeshExpanded = false;
        this._inMeshSelectChange = false;
        this._inCustomInputEdit = false;

        this._resolveElements();
        this._bindEvents();
        this._bindStateEvents();
        this._syncMeshControl(this._session.state.meshSize, this._session.state.threadDiaUm);
        this._updateAllRevertIcons();
    }

    // ─── Setup ────────────────────────────────────────────────

    _resolveElements() {
        for (const def of KNOB_DEFS) {
            const el = document.getElementById(def.sliderId);
            const valEl = document.getElementById(def.valId);
            const revertEl = document.getElementById(def.revertId);

            if (!el) continue;

            this._elements[def.key] = { el, valEl, revertEl, def };
        }

        this._customMeshRow = document.getElementById('custom-mesh-row');
        this._inputMeshTpi = document.getElementById('input-mesh-tpi');
        this._inputThreadUm = document.getElementById('input-thread-um');

        // Populate valid option values directly from SAATI_MESH_PRESETS (never `el.options`,
        // which is undefined on HTMLSelectElement in UXP Torq DOM).
        this._meshOptionValues = new Set([
            '0-0',
            'custom',
            ...Reveal.MeshPhysics.SAATI_MESH_PRESETS.map(p => p.id)
        ]);
    }

    _syncMeshControl(meshSize, threadDiaUm) {
        const meshEntry = this._elements['meshSize'];
        if (!meshEntry) return;

        if (meshSize === 0) {
            this._customMeshExpanded = false;
            meshEntry.el.value = this._meshOptionValues.has('0-0') ? '0-0' : '0';
            if (this._customMeshRow) this._customMeshRow.style.display = 'none';
            return;
        }

        const tpi = Number(meshSize) || 355;
        const tdia = (threadDiaUm !== undefined && threadDiaUm > 0)
            ? Number(threadDiaUm)
            : Reveal.MeshPhysics.getDefaultThreadDiaUm(tpi);

        if (this._inputMeshTpi) this._inputMeshTpi.value = String(tpi);
        if (this._inputThreadUm) this._inputThreadUm.value = String(tdia);

        if (this._customMeshExpanded && meshSize > 0) {
            meshEntry.el.value = 'custom';
            if (this._customMeshRow) this._customMeshRow.style.display = 'flex';
            return;
        }

        const pairKey = `${tpi}-${tdia}`;
        if (this._meshOptionValues.has(pairKey)) {
            meshEntry.el.value = pairKey;
            if (this._customMeshRow) this._customMeshRow.style.display = 'none';
        } else if (this._meshOptionValues.has('custom')) {
            meshEntry.el.value = 'custom';
            if (this._customMeshRow) this._customMeshRow.style.display = 'flex';
        } else {
            meshEntry.el.value = String(tpi);
        }
    }

    _bindEvents() {
        for (const [key, entry] of Object.entries(this._elements)) {
            if (key === 'meshSize') {
                entry.el.addEventListener('change', () => {
                    const raw = entry.el.value;
                    this._customMeshExpanded = (raw === 'custom');
                    this._inMeshSelectChange = true;
                    try {
                        if (raw === '0-0' || raw === '0') {
                            if (this._customMeshRow) this._customMeshRow.style.display = 'none';
                            this._session.updateParameter('meshSize', 0);
                            this._session.updateParameter('threadDiaUm', 0);
                        } else if (raw === 'custom') {
                            if (this._customMeshRow) this._customMeshRow.style.display = 'flex';
                            const tpi = Math.max(40, Math.min(600, Math.round(parseFloat(this._inputMeshTpi && this._inputMeshTpi.value) || 355)));
                            const tdia = Math.max(20, Math.min(120, Math.round(parseFloat(this._inputThreadUm && this._inputThreadUm.value) || 31)));
                            this._session.updateParameter('meshSize', tpi);
                            this._session.updateParameter('threadDiaUm', tdia);
                        } else if (raw.includes('-')) {
                            if (this._customMeshRow) this._customMeshRow.style.display = 'none';
                            const [tpiStr, tdiaStr] = raw.split('-');
                            const tpi = parseInt(tpiStr, 10) || 0;
                            const tdia = parseInt(tdiaStr, 10) || 0;
                            if (this._inputMeshTpi && tpi > 0) this._inputMeshTpi.value = String(tpi);
                            if (this._inputThreadUm && tdia > 0) this._inputThreadUm.value = String(tdia);
                            this._session.updateParameter('meshSize', tpi);
                            this._session.updateParameter('threadDiaUm', tdia);
                        } else {
                            const tpi = parseInt(raw, 10) || 0;
                            const tdia = tpi > 0 ? Reveal.MeshPhysics.getDefaultThreadDiaUm(tpi) : 0;
                            this._session.updateParameter('meshSize', tpi);
                            this._session.updateParameter('threadDiaUm', tdia);
                        }
                    } finally {
                        this._inMeshSelectChange = false;
                    }
                    this._updateRevertIcon('meshSize', entry);
                });

                if (entry.revertEl) {
                    entry.revertEl.addEventListener('click', () => {
                        this._customMeshExpanded = false;
                        this._session.resetKnob('meshSize');
                        this._session.resetKnob('threadDiaUm');
                        const dfltMesh = this._session.getKnobDefault('meshSize');
                        const dfltThread = this._session.getKnobDefault('threadDiaUm');
                        this._syncMeshControl(
                            dfltMesh !== null ? dfltMesh : 355,
                            dfltThread !== null ? dfltThread : 31
                        );
                        this._updateRevertIcon('meshSize', entry);
                    });
                }
                continue;
            }

            const eventType = entry.el.tagName === 'SP-SLIDER' ? 'input' : 'change';

            entry.el.addEventListener(eventType, () => {
                let value;
                if (entry.el.type === 'checkbox') {
                    value = entry.el.checked;
                } else if (entry.el.tagName === 'SELECT') {
                    value = isNaN(entry.el.value) ? entry.el.value : parseFloat(entry.el.value);
                } else {
                    value = parseFloat(entry.el.value);
                }

                this._updateDisplay(entry, value);
                this._session.updateParameter(key, value);
                this._updateRevertIcon(key, entry);
            });

            // Make clicking the adjacent .knob-label toggle checkboxes cleanly in UXP Torq
            if (entry.el.type === 'checkbox' && entry.el.parentElement) {
                const labelEl = entry.el.parentElement.querySelector('.knob-label');
                if (labelEl) {
                    labelEl.style.cursor = 'pointer';
                    labelEl.addEventListener('click', (e) => {
                        e.preventDefault();
                        entry.el.checked = !entry.el.checked;
                        const value = entry.el.checked;
                        this._updateDisplay(entry, value);
                        this._session.updateParameter(key, value);
                        this._updateRevertIcon(key, entry);
                    });
                }
            }

            // Revert arrow click — snap this knob to archetype default
            if (entry.revertEl) {
                entry.revertEl.addEventListener('click', () => {
                    this._session.resetKnob(key);
                    const dflt = this._session.getKnobDefault(key);
                    if (dflt !== null) {
                        this._setValue(entry, dflt);
                        this._updateDisplay(entry, dflt);
                    }
                    this._updateRevertIcon(key, entry);
                });
            }
        }

        const onCustomMeshInput = () => {
            this._inCustomInputEdit = true;
            try {
                if (this._inputMeshTpi) {
                    const rawTpi = parseFloat(this._inputMeshTpi.value);
                    if (Number.isFinite(rawTpi) && rawTpi >= 40 && rawTpi <= 600) {
                        this._session.updateParameter('meshSize', Math.round(rawTpi));
                    }
                }
                if (this._inputThreadUm) {
                    const rawUm = parseFloat(this._inputThreadUm.value);
                    if (Number.isFinite(rawUm) && rawUm >= 20 && rawUm <= 120) {
                        this._session.updateParameter('threadDiaUm', Math.round(rawUm));
                    }
                }
                const meshEntry = this._elements['meshSize'];
                if (meshEntry) this._updateRevertIcon('meshSize', meshEntry);
            } finally {
                this._inCustomInputEdit = false;
            }
        };

        if (this._inputMeshTpi) {
            this._inputMeshTpi.addEventListener('input', onCustomMeshInput);
            this._inputMeshTpi.addEventListener('change', onCustomMeshInput);
        }
        if (this._inputThreadUm) {
            this._inputThreadUm.addEventListener('input', onCustomMeshInput);
            this._inputThreadUm.addEventListener('change', onCustomMeshInput);
        }
    }

    _setValue(entry, value) {
        if (entry.el.type === 'checkbox') {
            entry.el.checked = !!value;
        } else {
            entry.el.value = value;
        }
    }

    _bindStateEvents() {
        // Archetype swap resets knob defaults — sync sliders
        this._session.on('configChanged', (config) => {
            this._syncFromConfig(config);
            this._updateAllRevertIcons();
        });

        // Show panel when proxy is ready (image loaded)
        this._session.on('proxyReady', () => {
            this._container.style.display = '';
            this._syncFromState();
            this._updateAllRevertIcons();
        });

        // Knob customization state changed (e.g. master reset)
        this._session.on('knobsCustomizedChanged', () => {
            this._updateAllRevertIcons();
        });

        // External parameter change — keep sliders in sync
        this._session.on('parameterChanged', ({ key, value }) => {
            if (key === 'meshSize' || key === 'threadDiaUm') {
                const st = this._session.getState();
                if (!this._inCustomInputEdit && !this._inMeshSelectChange) {
                    this._syncMeshControl(st.meshSize, st.threadDiaUm);
                }
                const meshEntry = this._elements['meshSize'];
                if (meshEntry) this._updateRevertIcon('meshSize', meshEntry);
            } else {
                const entry = this._elements[key];
                if (entry) {
                    let current;
                    if (entry.el.type === 'checkbox') {
                        current = entry.el.checked;
                    } else if (entry.el.tagName === 'SELECT') {
                        current = isNaN(entry.el.value) ? entry.el.value : parseFloat(entry.el.value);
                    } else {
                        current = parseFloat(entry.el.value);
                    }

                    if (current !== value) {
                        this._setValue(entry, value);
                        this._updateDisplay(entry, value);
                        this._updateRevertIcon(key, entry);
                    }
                }
            }

            // Mesh TPI / thread µm / ruleOfN change affects the speckleRescue auto label and ruleOfN readout
            if (key === 'meshSize' || key === 'threadDiaUm' || key === 'imageDpi' || key === 'ruleOfN') {
                const speckleEntry = this._elements['speckleRescue'];
                if (speckleEntry) {
                    this._updateDisplay(speckleEntry, parseFloat(speckleEntry.el.value));
                }
                const ruleOfNEntry = this._elements['ruleOfN'];
                if (ruleOfNEntry) {
                    this._updateDisplay(ruleOfNEntry, parseFloat(ruleOfNEntry.el.value));
                }
            }
        });
    }

    // ─── Display ──────────────────────────────────────────────

    _updateDisplay(entry, value) {
        if (!entry.valEl) return;
        if (entry.def.key === 'speckleRescue') {
            if (value === 0) {
                const state = this._session.getState();
                const meshTPI = state.meshSize || 0;
                if (meshTPI > 0) {
                    entry.valEl.textContent = 'auto';
                    entry.el.style.opacity = '0.45';
                    return;
                }
            }
            entry.el.style.opacity = '';
        }
        if (entry.def.key === 'ruleOfN') {
            const state = this._session.getState();
            const meshTPI = state.meshSize !== undefined ? state.meshSize : 355;
            if (meshTPI === 0) {
                entry.valEl.textContent = `${value.toFixed(1)} (1 px)`;
                return;
            }
            const threadDiaUm = state.threadDiaUm || 0;
            const dpi = this._session.imageResolution || 300;
            const dotPx = Reveal.MeshPhysics.minDotPx(meshTPI, dpi, value, threadDiaUm);
            entry.valEl.textContent = `${value.toFixed(1)} (${dotPx} px)`;
            return;
        }
        entry.valEl.textContent = value.toFixed(entry.def.decimals) + entry.def.unit;
    }

    // ─── Revert Icons ────────────────────────────────────────

    _updateRevertIcon(key, entry) {
        if (!entry.revertEl) return;
        if (key === 'meshSize') {
            const dfltMesh = this._session.getKnobDefault('meshSize');
            const dfltThread = this._session.getKnobDefault('threadDiaUm');
            if (dfltMesh === null || dfltMesh === undefined) {
                entry.revertEl.style.display = 'none';
                return;
            }
            const state = this._session.getState();
            const curMesh = state.meshSize !== undefined ? state.meshSize : dfltMesh;
            const expectedThread = (dfltThread !== null && dfltThread !== undefined)
                ? dfltThread
                : (dfltMesh > 0 ? Reveal.MeshPhysics.getDefaultThreadDiaUm(dfltMesh) : 0);
            const curThread = state.threadDiaUm !== undefined
                ? state.threadDiaUm
                : (curMesh > 0 ? Reveal.MeshPhysics.getDefaultThreadDiaUm(curMesh) : 0);
            const isDirty = (curMesh !== dfltMesh) || (curThread !== expectedThread);
            entry.revertEl.style.display = isDirty ? 'inline-block' : 'none';
            return;
        }

        const dflt = this._session.getKnobDefault(key);
        if (dflt === null || dflt === undefined) {
            entry.revertEl.style.display = 'none';
            return;
        }

        let current;
        if (entry.el.type === 'checkbox') {
            current = entry.el.checked;
        } else if (entry.el.tagName === 'SELECT') {
            current = entry.el.value;
        } else {
            current = parseFloat(entry.el.value);
        }

        // current can be NaN (unparsed slider value) or, for not-yet-upgraded
        // custom elements, undefined — neither has a meaningful "is this
        // dirty" answer, so just hide the revert arrow rather than throw.
        if (current === undefined || current === null || (typeof current === 'number' && Number.isNaN(current))) {
            entry.revertEl.style.display = 'none';
            return;
        }

        // String(), not .toString() — can't throw even if a future KNOB_DEFS
        // entry ends up with a non-primitive default.
        const isDirty = (typeof dflt === 'number')
            ? Math.abs(current - dflt) > 0.0001
            : String(current) !== String(dflt);

        entry.revertEl.style.display = isDirty ? 'inline-block' : 'none';
    }

    _updateAllRevertIcons() {
        for (const [key, entry] of Object.entries(this._elements)) {
            this._updateRevertIcon(key, entry);
        }
    }

    // ─── Sync ─────────────────────────────────────────────────

    _syncFromConfig(config) {
        for (const [key, entry] of Object.entries(this._elements)) {
            if (key === 'meshSize') {
                if (config.meshSize !== undefined) {
                    this._customMeshExpanded = false;
                    this._syncMeshControl(config.meshSize, config.threadDiaUm);
                }
                continue;
            }
            if (config[key] !== undefined) {
                const value = config[key];
                this._setValue(entry, value);
                this._updateDisplay(entry, value);
            }
        }
    }

    _syncFromState() {
        const state = this._session.getState();
        for (const [key, entry] of Object.entries(this._elements)) {
            if (key === 'meshSize') {
                if (state.meshSize !== undefined) {
                    this._customMeshExpanded = false;
                    this._syncMeshControl(state.meshSize, state.threadDiaUm);
                }
                continue;
            }
            if (state[key] !== undefined) {
                const value = state[key];
                this._setValue(entry, value);
                this._updateDisplay(entry, value);
            }
        }
    }

    /** Public: snap sliders to current state (e.g. after cancelled structural change). */
    syncFromConfig(config) {
        this._syncFromConfig(config);
        this._updateAllRevertIcons();
    }
}

MechanicalKnobs.KNOB_DEFS = KNOB_DEFS;

module.exports = MechanicalKnobs;
