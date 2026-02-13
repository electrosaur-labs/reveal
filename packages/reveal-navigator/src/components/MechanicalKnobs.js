/**
 * MechanicalKnobs - Real-time slider control for print quality parameters
 *
 * Three scrubbable knobs that drive the ProxyEngine fast path (~50-100ms):
 *   - minVolume:      Ghost plate removal (0-5%)
 *   - speckleRescue:  Halftone solidity (0-10px)
 *   - shadowClamp:    Ink body control (0-20%)
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

const KNOB_DEFS = [
    { key: 'minVolume',      sliderId: 'knob-minVolume',      valId: 'minVolume-val',      revertId: 'revert-minVolume',      decimals: 1, unit: '%'  },
    { key: 'speckleRescue',  sliderId: 'knob-speckleRescue',  valId: 'speckleRescue-val',  revertId: 'revert-speckleRescue',  decimals: 0, unit: 'px' },
    { key: 'shadowClamp',    sliderId: 'knob-shadowClamp',    valId: 'shadowClamp-val',    revertId: 'revert-shadowClamp',    decimals: 1, unit: '%'  }
];

class MechanicalKnobs {

    /**
     * @param {HTMLElement} container - The #knobs-panel element
     * @param {import('../state/SessionState')} sessionState
     */
    constructor(container, sessionState) {
        this._container = container;
        this._session = sessionState;
        this._sliders = {};  // key → { slider, valEl, revertEl, def }

        this._resolveElements();
        this._bindSliderEvents();
        this._bindStateEvents();
    }

    // ─── Setup ────────────────────────────────────────────────

    _resolveElements() {
        for (const def of KNOB_DEFS) {
            const slider = document.getElementById(def.sliderId);
            const valEl = document.getElementById(def.valId);
            const revertEl = document.getElementById(def.revertId);

            if (!slider) continue;

            this._sliders[def.key] = { slider, valEl, revertEl, def };
        }
    }

    _bindSliderEvents() {
        for (const [key, entry] of Object.entries(this._sliders)) {
            entry.slider.addEventListener('input', () => {
                const value = parseFloat(entry.slider.value);
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
                        entry.slider.value = dflt;
                        this._updateDisplay(entry, dflt);
                    }
                    this._updateRevertIcon(key, entry);
                });
            }
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
    }

    // ─── Display ──────────────────────────────────────────────

    _updateDisplay(entry, value) {
        if (entry.valEl) {
            entry.valEl.textContent = value.toFixed(entry.def.decimals) + entry.def.unit;
        }
    }

    // ─── Revert Icons ────────────────────────────────────────

    _updateRevertIcon(key, entry) {
        if (!entry.revertEl) return;
        const dflt = this._session.getKnobDefault(key);
        if (dflt === null) {
            entry.revertEl.style.display = 'none';
            return;
        }
        const current = parseFloat(entry.slider.value);
        entry.revertEl.style.display = (current !== dflt) ? 'inline-block' : 'none';
    }

    _updateAllRevertIcons() {
        for (const [key, entry] of Object.entries(this._sliders)) {
            this._updateRevertIcon(key, entry);
        }
    }

    // ─── Sync ─────────────────────────────────────────────────

    _syncFromConfig(config) {
        for (const [key, entry] of Object.entries(this._sliders)) {
            if (config[key] !== undefined) {
                const value = config[key];
                entry.slider.value = value;
                this._updateDisplay(entry, value);
            }
        }
    }

    _syncFromState() {
        const state = this._session.getState();
        for (const [key, entry] of Object.entries(this._sliders)) {
            if (state[key] !== undefined) {
                const value = state[key];
                entry.slider.value = value;
                this._updateDisplay(entry, value);
            }
        }
    }
}

module.exports = MechanicalKnobs;
