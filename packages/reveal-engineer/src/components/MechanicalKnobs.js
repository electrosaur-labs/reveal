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

const logger = require('@electrosaur-labs/core').logger;

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

        this._resolveElements();
        this._bindEvents();
        this._bindStateEvents();
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
    }

    _bindEvents() {
        for (const [key, entry] of Object.entries(this._elements)) {
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
            const entry = this._elements[key];
            if (!entry) return;
            
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
        });
    }

    // ─── Display ──────────────────────────────────────────────

    _updateDisplay(entry, value) {
        if (entry.valEl) {
            entry.valEl.textContent = value.toFixed(entry.def.decimals) + entry.def.unit;
        }
    }

    // ─── Revert Icons ────────────────────────────────────────

    _updateRevertIcon(key, entry) {
        if (!entry.revertEl || !entry.el) return;
        try {
            const dflt = this._session.getKnobDefault(key);
            if (dflt === null || dflt === undefined) {
                entry.revertEl.style.display = 'none';
                return;
            }

            let current;
            if (entry.el.type === 'checkbox') {
                current = entry.el.checked;
            } else if (entry.el.tagName === 'SELECT') {
                current = isNaN(entry.el.value) ? entry.el.value : parseFloat(entry.el.value);
            } else {
                current = parseFloat(entry.el.value);
            }

            let isDirty = false;
            if (typeof dflt === 'number') {
                isDirty = (isNaN(current) || Math.abs(current - dflt) > 0.0001);
            } else {
                const sCurrent = (current === null || current === undefined) ? '' : current.toString();
                const sDflt = (dflt === null || dflt === undefined) ? '' : dflt.toString();
                isDirty = sCurrent !== sDflt;
            }

            entry.revertEl.style.display = isDirty ? 'inline-block' : 'none';
        } catch (err) {
            logger.log(`[MechanicalKnobs] Error in _updateRevertIcon for key "${key}": ${err.message}`);
        }
    }

    _updateAllRevertIcons() {
        logger.log('[MechanicalKnobs] Flow: _updateAllRevertIcons start');
        try {
            for (const [key, entry] of Object.entries(this._elements)) {
                this._updateRevertIcon(key, entry);
            }
            logger.log('[MechanicalKnobs] Flow: _updateAllRevertIcons done');
        } catch (err) {
            logger.log(`[MechanicalKnobs] Flow: _updateAllRevertIcons failed: ${err.message}`);
        }
    }

    // ─── Sync ─────────────────────────────────────────────────

    _syncFromConfig(config) {
        for (const [key, entry] of Object.entries(this._elements)) {
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

module.exports = MechanicalKnobs;
