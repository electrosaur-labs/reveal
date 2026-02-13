/**
 * PaletteSurgeon - Full surgery mode for per-swatch color editing.
 *
 * State machine:
 *   IDLE:
 *     mouseenter[i]  → HOVERING(i)     show shimmer (debounced 120ms)
 *     click[i]       → SELECTED(i)     lock highlight
 *     dblclick[i]    → color picker    override color
 *
 *   HOVERING(i):
 *     mouseleave     → IDLE            restore normal preview
 *     click[i]       → SELECTED(i)     lock this highlight
 *     dblclick[i]    → color picker
 *
 *   SELECTED(i):
 *     click[i]       → IDLE            deselect (toggle off)
 *     click[j≠i]     → merge(i→j)     merge source into target, → IDLE
 *     dblclick[i]    → color picker    override selected color
 *     mouseenter[j]  → show merge-target CSS hint on swatch j
 *     mouseleave[j]  → remove merge-target hint
 *     Escape key     → IDLE
 *
 * Vanilla+ pattern: subscribes to SessionState events.
 */

const Reveal = require('@reveal/core');
const logger = Reveal.logger;

// States
const IDLE = 'IDLE';
const HOVERING = 'HOVERING';
const SELECTED = 'SELECTED';

const HOVER_DEBOUNCE_MS = 120;
const DBLCLICK_THRESHOLD_MS = 350;

class PaletteSurgeon {

    /**
     * @param {HTMLElement} container - The #palette-surgeon element
     * @param {import('../state/SessionState')} sessionState
     */
    constructor(container, sessionState) {
        this._container = container;
        this._session = sessionState;

        this._state = IDLE;
        this._selectedIndex = -1;
        this._hoverIndex = -1;

        // Double-click detection (manual — UXP's native dblclick is unreliable)
        this._lastClickTime = 0;
        this._lastClickIndex = -1;

        // Hover debounce timer
        this._hoverTimer = null;

        // Guard: prevent state changes while Photoshop color picker modal is open
        this._isColorPickerOpen = false;

        // DOM elements
        this._header = null;
        this._grid = null;

        // Swatch DOM references keyed by palette index (for fast updates)
        this._swatchElements = new Map();

        this._buildDOM();
        this._bindEvents();
    }

    // ─── Public API ────────────────────────────────────────

    /** Deselect current selection and return to IDLE. Called by Escape key handler. */
    deselect() {
        if (this._state === SELECTED || this._state === HOVERING) {
            this._clearHoverTimer();
            this._state = IDLE;
            this._selectedIndex = -1;
            this._hoverIndex = -1;
            this._session.clearHighlight();
            this._header.textContent = 'Click a color to isolate';
            this._clearAllHints();
            this._updateSelection();
        }
    }

    // ─── DOM Construction ──────────────────────────────────

    _buildDOM() {
        this._header = document.createElement('div');
        this._header.className = 'surgeon-header';
        this._header.textContent = 'Click a color to isolate';
        this._container.appendChild(this._header);

        this._grid = document.createElement('div');
        this._grid.className = 'surgeon-grid';
        this._container.appendChild(this._grid);
    }

    _bindEvents() {
        this._session.on('previewUpdated', () => this._rebuild());
        this._session.on('archetypeChanged', () => this._reset());
    }

    // ─── Grid Rebuild ──────────────────────────────────────

    /**
     * Rebuild the swatch grid from the current proxy separation state.
     */
    _rebuild() {
        const proxy = this._session.proxyEngine;
        if (!proxy || !proxy.separationState) return;

        const { rgbPalette, colorIndices, width, height } = proxy.separationState;
        if (!rgbPalette || !colorIndices) return;

        // Count pixels per color
        const pixelCount = width * height;
        const counts = new Uint32Array(rgbPalette.length);
        for (let i = 0; i < pixelCount; i++) {
            counts[colorIndices[i]]++;
        }

        // If selected index was pruned, reset
        if (this._state === SELECTED && this._selectedIndex >= rgbPalette.length) {
            this._reset();
        }
        if (this._state === SELECTED && counts[this._selectedIndex] === 0) {
            this._reset();
        }

        this._grid.innerHTML = '';
        this._swatchElements.clear();

        for (let i = 0; i < rgbPalette.length; i++) {
            const c = rgbPalette[i];
            const pct = ((counts[i] / pixelCount) * 100).toFixed(1);

            // Skip merged/zero-coverage swatches
            if (counts[i] === 0) continue;

            const isOverridden = this._session.paletteOverrides.has(i);

            // ── Swatch container ──
            const swatch = document.createElement('div');
            swatch.className = 'surgeon-swatch';
            if (this._state === SELECTED && i === this._selectedIndex) {
                swatch.classList.add('surgeon-selected');
            }

            // ── Color block ──
            const colorBlock = document.createElement('span');
            colorBlock.className = 'surgeon-color';
            if (isOverridden) colorBlock.classList.add('surgeon-overridden');
            colorBlock.style.background = `rgb(${c.r},${c.g},${c.b})`;

            // ── Override dot (top-right) ──
            const dot = document.createElement('span');
            dot.className = 'surgeon-override-dot';
            if (isOverridden) dot.classList.add('visible');

            // ── Percentage label ──
            const label = document.createElement('span');
            label.className = 'surgeon-pct';
            label.textContent = `${pct}%`;

            // ── Revert button ──
            const revertBtn = document.createElement('button');
            revertBtn.className = 'surgeon-revert';
            if (isOverridden) revertBtn.classList.add('visible');
            revertBtn.textContent = '\u21BA';
            revertBtn.title = 'Revert to original color';
            revertBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._onRevert(i);
            });

            swatch.appendChild(colorBlock);
            swatch.appendChild(dot);
            swatch.appendChild(label);
            swatch.appendChild(revertBtn);

            // ── Event listeners ──
            swatch.addEventListener('click', () => this._onSwatchClick(i));
            swatch.addEventListener('mouseenter', () => this._onSwatchEnter(i));
            swatch.addEventListener('mouseleave', () => this._onSwatchLeave(i));

            this._grid.appendChild(swatch);
            this._swatchElements.set(i, { swatch, colorBlock, dot, revertBtn });
        }

        this._container.style.display = 'block';
    }

    // ─── Hover ─────────────────────────────────────────────

    _onSwatchEnter(i) {
        if (this._isColorPickerOpen) return;

        if (this._state === SELECTED) {
            // In SELECTED state, hovering a different swatch shows merge-target hint
            if (i !== this._selectedIndex) {
                this._setMergeTargetHint(i);
            }
            return;
        }

        // IDLE or HOVERING — debounced shimmer
        this._clearHoverTimer();
        this._hoverTimer = setTimeout(() => {
            this._hoverTimer = null;
            this._state = HOVERING;
            this._hoverIndex = i;
            this._session.setHighlight(i);
            this._setHoverHint(i);
        }, HOVER_DEBOUNCE_MS);
    }

    _onSwatchLeave(i) {
        if (this._isColorPickerOpen) return;

        if (this._state === SELECTED) {
            // Remove merge-target hint
            this._clearMergeTargetHint(i);
            return;
        }

        // Cancel pending hover debounce
        this._clearHoverTimer();

        if (this._state === HOVERING && this._hoverIndex === i) {
            this._state = IDLE;
            this._hoverIndex = -1;
            this._session.clearHighlight();
            this._clearHoverHint(i);
        }
    }

    _clearHoverTimer() {
        if (this._hoverTimer !== null) {
            clearTimeout(this._hoverTimer);
            this._hoverTimer = null;
        }
    }

    // ─── Click / Double-Click ──────────────────────────────

    /**
     * Handle swatch click — implements state machine with manual double-click detection.
     * @param {number} i - Palette index clicked
     */
    _onSwatchClick(i) {
        if (this._isColorPickerOpen) return;

        const now = Date.now();

        // Double-click detection: same swatch within threshold
        if (i === this._lastClickIndex && (now - this._lastClickTime) < DBLCLICK_THRESHOLD_MS) {
            this._lastClickTime = 0;
            this._lastClickIndex = -1;
            this._onSwatchDblClick(i);
            return;
        }

        this._lastClickTime = now;
        this._lastClickIndex = i;

        // Single-click behavior depends on state
        if (this._state === IDLE || this._state === HOVERING) {
            // Enter SELECTED
            this._clearHoverTimer();
            this._state = SELECTED;
            this._selectedIndex = i;
            this._hoverIndex = -1;
            this._session.setHighlight(i);
            this._header.textContent = 'Click another to merge, or same to deselect';
            this._clearAllHints();
            this._updateSelection();

        } else if (this._state === SELECTED) {
            if (i === this._selectedIndex) {
                // Click same → deselect
                this._state = IDLE;
                this._selectedIndex = -1;
                this._session.clearHighlight();
                this._header.textContent = 'Click a color to isolate';
                this._clearAllHints();
                this._updateSelection();
            } else {
                // Click different → merge selected into clicked
                const source = this._selectedIndex;
                const target = i;
                this._state = IDLE;
                this._selectedIndex = -1;
                this._session.clearHighlight();
                this._header.textContent = 'Click a color to isolate';
                this._clearAllHints();
                this._performMerge(source, target);
            }
        }
    }

    /**
     * Handle double-click — open Photoshop color picker to override swatch color.
     * @param {number} i - Palette index double-clicked
     */
    _onSwatchDblClick(i) {
        if (this._isColorPickerOpen) return;

        // If we were in SELECTED state on this swatch, keep it; otherwise select it
        if (this._state !== SELECTED || this._selectedIndex !== i) {
            this._state = SELECTED;
            this._selectedIndex = i;
            this._session.setHighlight(i);
            this._header.textContent = 'Opening color picker...';
            this._updateSelection();
        } else {
            this._header.textContent = 'Opening color picker...';
        }

        this._openColorPicker(i);
    }

    // ─── Color Picker ──────────────────────────────────────

    /**
     * Open the Photoshop native color picker for swatch i.
     * @param {number} i - Palette index
     */
    async _openColorPicker(i) {
        const proxy = this._session.proxyEngine;
        if (!proxy || !proxy.separationState) return;

        const rgb = proxy.separationState.rgbPalette[i];
        if (!rgb) return;

        this._isColorPickerOpen = true;

        try {
            const { core, action, app } = require("photoshop");
            let result = null;

            await core.executeAsModal(async () => {
                // Set foreground color to current swatch color
                await action.batchPlay([{
                    _obj: "set",
                    _target: [{ _ref: "color", _property: "foregroundColor" }],
                    to: {
                        _obj: "RGBColor",
                        red: rgb.r,
                        grain: rgb.g,
                        blue: rgb.b
                    }
                }], {});

                // Show native color picker
                const response = await action.batchPlay([{
                    _obj: "showColorPicker"
                }], {});

                if (response && response.length > 0 && response[0]._obj !== "cancel") {
                    const newColor = app.foregroundColor;
                    result = {
                        r: Math.round(newColor.rgb.red),
                        g: Math.round(newColor.rgb.green),
                        b: Math.round(newColor.rgb.blue)
                    };
                }
            }, { commandName: "Pick Swatch Color" });

            if (result) {
                // Convert RGB → Lab and apply override
                const lab = Reveal.rgbToLab(result.r, result.g, result.b);
                await this._session.overridePaletteColor(i, lab);
                logger.log(`[PaletteSurgeon] Color ${i} overridden: rgb(${result.r},${result.g},${result.b})`);
            }

            // Restore header text based on state
            if (this._state === SELECTED) {
                this._header.textContent = 'Click another to merge, or same to deselect';
            } else {
                this._header.textContent = 'Click a color to isolate';
            }

        } catch (err) {
            logger.log(`[PaletteSurgeon] Color picker error: ${err.message}`);
            this._header.textContent = 'Click a color to isolate';
        } finally {
            this._isColorPickerOpen = false;
        }
    }

    // ─── Revert ────────────────────────────────────────────

    _onRevert(i) {
        if (this._isColorPickerOpen) return;

        this._session.revertPaletteColor(i).catch(err => {
            logger.log(`[PaletteSurgeon] Revert failed: ${err.message}`);
        });
        // _rebuild() fires automatically via previewUpdated
    }

    // ─── Merge ─────────────────────────────────────────────

    _performMerge(source, target) {
        this._session.mergePaletteColors(source, target).catch(err => {
            logger.log(`[PaletteSurgeon] Merge failed: ${err.message}`);
        });
        // _rebuild() fires automatically via previewUpdated
    }

    // ─── Visual Hints ──────────────────────────────────────

    _setHoverHint(i) {
        const entry = this._swatchElements.get(i);
        if (entry) entry.swatch.classList.add('surgeon-hover');
    }

    _clearHoverHint(i) {
        const entry = this._swatchElements.get(i);
        if (entry) entry.swatch.classList.remove('surgeon-hover');
    }

    _setMergeTargetHint(i) {
        const entry = this._swatchElements.get(i);
        if (entry) entry.swatch.classList.add('surgeon-merge-target');
    }

    _clearMergeTargetHint(i) {
        const entry = this._swatchElements.get(i);
        if (entry) entry.swatch.classList.remove('surgeon-merge-target');
    }

    _clearAllHints() {
        for (const [, entry] of this._swatchElements) {
            entry.swatch.classList.remove('surgeon-hover', 'surgeon-merge-target');
        }
    }

    // ─── Selection Visual Update ───────────────────────────

    /**
     * Update selected visual state on swatches without full rebuild.
     */
    _updateSelection() {
        for (const [idx, entry] of this._swatchElements) {
            if (this._state === SELECTED && idx === this._selectedIndex) {
                entry.swatch.classList.add('surgeon-selected');
            } else {
                entry.swatch.classList.remove('surgeon-selected');
            }
        }
    }

    // ─── Reset ─────────────────────────────────────────────

    /**
     * Reset to IDLE — clear selection and highlight.
     */
    _reset() {
        this._clearHoverTimer();
        this._state = IDLE;
        this._selectedIndex = -1;
        this._hoverIndex = -1;
        this._session.clearHighlight();
        if (this._header) {
            this._header.textContent = 'Click a color to isolate';
        }
    }
}

module.exports = PaletteSurgeon;
