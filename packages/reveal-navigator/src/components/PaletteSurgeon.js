/**
 * PaletteSurgeon - Per-swatch color editing.
 *
 * Interactions:
 *   click          → select/isolate that color (or deselect if same)
 *   shift+click    → merge selected into clicked swatch
 *   ctrl+click     → open Photoshop color picker to override color
 *   double-click   → open Photoshop color picker (same, but unreliable in UXP)
 *   revert button  → undo override for that swatch
 *   Escape         → deselect
 *
 * dataset.index on each swatch DOM element is the HARD BINDING
 * to the stable palette index. Event handlers ALWAYS read from DOM.
 */

const Reveal = require('@reveal/core');
const logger = Reveal.logger;

const DBLCLICK_MS = 350;

class PaletteSurgeon {

    constructor(container, sessionState) {
        this._container = container;
        this._session = sessionState;

        this._state = 'IDLE';
        this._selectedIndex = -1;

        // Manual double-click detection (UXP dblclick is unreliable)
        this._lastClickTime = 0;
        this._lastClickIndex = -1;

        // Guard: block clicks while Photoshop color picker modal is open
        this._pickerOpen = false;

        this._swatchElements = new Map();

        // Build DOM
        this._header = document.createElement('div');
        this._header.className = 'surgeon-header';
        this._header.textContent = 'Click a color to isolate';
        this._container.appendChild(this._header);

        this._grid = document.createElement('div');
        this._grid.className = 'surgeon-grid';
        this._container.appendChild(this._grid);

        // Subscribe to state events
        this._session.on('previewUpdated', () => this._rebuild());
        this._session.on('archetypeChanged', () => {
            this._state = 'IDLE';
            this._selectedIndex = -1;
            this._session.clearHighlight();
            this._header.textContent = 'Click a color to isolate';
        });
    }

    /** Public: deselect (called by Escape key handler) */
    deselect() {
        this._state = 'IDLE';
        this._selectedIndex = -1;
        this._session.clearHighlight();
        this._header.textContent = 'Click a color to isolate';
        this._updateSelectionCSS();
    }

    // ─── Rebuild ─────────────────────────────────────────────

    _rebuild() {
        const proxy = this._session.proxyEngine;
        if (!proxy || !proxy.separationState) return;

        const { rgbPalette, colorIndices, width, height } = proxy.separationState;
        if (!rgbPalette || !colorIndices) return;

        logger.log(`[Surgeon] _rebuild: ${rgbPalette.length} palette entries, ${colorIndices.length} pixels`);

        const pixelCount = width * height;
        const counts = new Uint32Array(rgbPalette.length);
        for (let i = 0; i < pixelCount; i++) {
            counts[colorIndices[i]]++;
        }

        // If selected swatch was pruned away, deselect
        if (this._state === 'SELECTED') {
            if (this._selectedIndex >= rgbPalette.length || counts[this._selectedIndex] === 0) {
                this._state = 'IDLE';
                this._selectedIndex = -1;
                this._session.clearHighlight();
                this._header.textContent = 'Click a color to isolate';
            }
        }

        this._grid.innerHTML = '';
        this._swatchElements.clear();

        for (let i = 0; i < rgbPalette.length; i++) {
            const isDeleted = this._session.deletedColors.has(i);
            if (counts[i] === 0 && !isDeleted) continue;   // skip truly empty, keep deleted

            const c = rgbPalette[i];
            const pct = isDeleted ? '—' : ((counts[i] / pixelCount) * 100).toFixed(1) + '%';
            const isOverridden = this._session.paletteOverrides.has(i);

            // ── Swatch container with HARD-BOUND index ──
            const swatch = document.createElement('div');
            swatch.className = 'surgeon-swatch';
            swatch.dataset.index = i;
            if (this._state === 'SELECTED' && i === this._selectedIndex) {
                swatch.classList.add('surgeon-selected');
            }

            // ── Color block ──
            const colorBlock = document.createElement('span');
            colorBlock.className = 'surgeon-color';
            if (isOverridden) colorBlock.classList.add('surgeon-overridden');
            colorBlock.style.background = `rgb(${c.r},${c.g},${c.b})`;

            // ── Override dot ──
            const dot = document.createElement('span');
            dot.className = 'surgeon-override-dot';
            if (isOverridden) dot.classList.add('visible');

            // ── Deleted swatch styling (Alt+click delete) ──
            if (isDeleted) {
                swatch.classList.add('surgeon-deleted');
                const xBadge = document.createElement('span');
                xBadge.className = 'surgeon-delete-badge';
                xBadge.textContent = '\u2715';
                colorBlock.appendChild(xBadge);
            }

            // ── Merge badge ("+N" on target swatches that absorbed others) ──
            const mergedSources = this._session.mergeHistory.get(i);
            const mergeCount = mergedSources ? mergedSources.size : 0;
            if (mergeCount > 0) {
                const badge = document.createElement('span');
                badge.className = 'surgeon-merge-badge';
                badge.textContent = `+${mergeCount}`;
                badge.title = `Absorbed ${mergeCount} merged color${mergeCount > 1 ? 's' : ''}`;
                colorBlock.appendChild(badge);
            }

            // ── Percentage label ──
            const label = document.createElement('span');
            label.className = 'surgeon-pct';
            label.textContent = pct;

            // ── Revert button (only visible when selected + overridden) ──
            const revertBtn = document.createElement('button');
            revertBtn.className = 'surgeon-revert';
            const isSelected = (this._state === 'SELECTED' && i === this._selectedIndex);
            if ((isOverridden || isDeleted) && isSelected) revertBtn.classList.add('visible');
            revertBtn.textContent = '\u21BA';
            revertBtn.title = 'Revert to original color';
            revertBtn.onclick = (e) => {
                e.stopPropagation();
                const idx = parseInt(e.currentTarget.parentElement.dataset.index);
                logger.log(`[Surgeon] REVERT clicked for index ${idx}`);
                this._onRevert(idx);
            };

            swatch.appendChild(colorBlock);
            swatch.appendChild(dot);
            swatch.appendChild(label);
            swatch.appendChild(revertBtn);

            // ── Ctrl+click → color picker (pointerdown fires before OS/PS intercept) ──
            swatch.addEventListener('pointerdown', (e) => {
                if (e.ctrlKey && !this._pickerOpen) {
                    const idx = parseInt(e.currentTarget.dataset.index);
                    if (!this._session.deletedColors.has(idx)) {
                        e.preventDefault();
                        e.stopPropagation();
                        swatch._ctrlHandled = true;
                        this._openColorPicker(idx);
                    }
                }
            });

            // ── Click handler — reads index from DOM ──
            swatch.onclick = (e) => {
                if (swatch._ctrlHandled) { swatch._ctrlHandled = false; return; }
                const idx = parseInt(e.currentTarget.dataset.index);
                this._onSwatchClick(idx, e.shiftKey, e.altKey);
            };

            // ── Hover — lightweight highlight when IDLE ──
            swatch.onmouseenter = () => {
                if (this._state !== 'SELECTED' && !this._pickerOpen) {
                    this._session.setHighlight(i);
                }
            };
            swatch.onmouseleave = () => {
                if (this._state !== 'SELECTED' && !this._pickerOpen) {
                    this._session.clearHighlight();
                }
            };

            this._grid.appendChild(swatch);
            this._swatchElements.set(i, swatch);
        }

        this._container.style.display = 'block';
    }

    // ─── Click ───────────────────────────────────────────────

    _onSwatchClick(i, shiftKey, altKey) {
        if (this._pickerOpen) return;

        const isDeleted = this._session.deletedColors.has(i);

        // Alt+click → delete swatch (merge into nearest neighbor)
        // On already-deleted swatch, Alt+click reverts instead
        if (altKey) {
            if (isDeleted) {
                this._onRevert(i);
            } else {
                this._onDeleteSwatch(i);
            }
            return;
        }

        // Deleted swatches: single-click selects (to show revert), no double-click picker
        if (isDeleted) {
            this._state = 'SELECTED';
            this._selectedIndex = i;
            this._header.textContent = `Deleted — click \u21BA or Alt+click to restore`;
            this._session.setHighlight(i);
            this._updateSelectionCSS();
            this._rebuild();
            return;
        }

        const now = Date.now();

        // Double-click detection: same swatch within threshold
        if (i === this._lastClickIndex && (now - this._lastClickTime) < DBLCLICK_MS) {
            this._lastClickTime = 0;
            this._lastClickIndex = -1;
            this._openColorPicker(i);
            return;
        }
        this._lastClickTime = now;
        this._lastClickIndex = i;

        // SHIFT+click while selected → merge
        if (shiftKey && this._state === 'SELECTED' && this._selectedIndex !== i) {
            const source = this._selectedIndex;
            const target = i;
            logger.log(`[Surgeon] MERGE ${source}→${target} (shift+click)`);
            this._state = 'IDLE';
            this._selectedIndex = -1;
            this._session.clearHighlight();
            this._header.textContent = 'Click a color to isolate';
            this._updateSelectionCSS();
            this._session.mergePaletteColors(source, target).catch(err => {
                logger.log(`[PaletteSurgeon] Merge failed: ${err.message}`);
            });
            return;
        }

        // Plain click: select/deselect
        if (this._state === 'SELECTED' && this._selectedIndex === i) {
            // Same swatch → deselect
            this._state = 'IDLE';
            this._selectedIndex = -1;
            this._session.clearHighlight();
            this._header.textContent = 'Click a color to isolate';
        } else {
            // Different swatch or IDLE → select this one
            this._selectedIndex = i;
            this._state = 'SELECTED';
            this._session.setHighlight(i);
            this._header.textContent = 'Shift+click merge \u2022 Alt+click delete \u2022 Ctrl+click edit';
        }

        this._updateSelectionCSS();
    }

    // ─── Delete Swatch ─────────────────────────────────────────

    _onDeleteSwatch(i) {
        // Reset selection state
        this._state = 'IDLE';
        this._selectedIndex = -1;
        this._session.clearHighlight();
        this._header.textContent = 'Click a color to isolate';
        this._updateSelectionCSS();

        logger.log(`[Surgeon] DELETE swatch ${i} (alt+click)`);
        this._session.deletePaletteColor(i).catch(err => {
            logger.log(`[PaletteSurgeon] Delete failed: ${err.message}`);
        });
    }

    isPickerOpen() { return this._pickerOpen; }

    // ─── Color Picker ────────────────────────────────────────

    async _openColorPicker(i) {
        const proxy = this._session.proxyEngine;
        if (!proxy || !proxy.separationState) return;

        const rgb = proxy.separationState.rgbPalette[i];
        if (!rgb) return;

        this._pickerOpen = true;
        this._header.textContent = 'Opening color picker...';

        try {
            const { core, action, app } = require("photoshop");
            let result = null;

            await core.executeAsModal(async () => {
                await action.batchPlay([{
                    _obj: "set",
                    _target: [{ _ref: "color", _property: "foregroundColor" }],
                    to: {
                        _obj: "RGBColor",
                        red: rgb.r, grain: rgb.g, blue: rgb.b
                    }
                }], {});

                await action.batchPlay([{
                    _obj: "showColorPicker"
                }], {});

                const c = app.foregroundColor;
                const newR = Math.round(c.rgb.red);
                const newG = Math.round(c.rgb.green);
                const newB = Math.round(c.rgb.blue);

                // Only treat as confirmed if the color actually changed from the swatch.
                // Photoshop reverts foreground color on cancel, so this catches all
                // cancel scenarios regardless of the batchPlay response format.
                if (newR !== rgb.r || newG !== rgb.g || newB !== rgb.b) {
                    result = { r: newR, g: newG, b: newB };
                }
            }, { commandName: "Pick Swatch Color" });

            // Reset to IDLE before applying so the rebuild sees clean state
            this._state = 'IDLE';
            this._selectedIndex = -1;
            this._session.clearHighlight();
            this._header.textContent = 'Click a color to isolate';
            this._updateSelectionCSS();

            if (result) {
                const lab = Reveal.rgbToLab(result.r, result.g, result.b);
                await this._session.overridePaletteColor(i, lab);
                logger.log(`[PaletteSurgeon] Color ${i} overridden: rgb(${result.r},${result.g},${result.b})`);
            }
        } catch (err) {
            logger.log(`[PaletteSurgeon] Color picker error: ${err.message}`);
            this._state = 'IDLE';
            this._selectedIndex = -1;
            this._header.textContent = 'Click a color to isolate';
        } finally {
            this._pickerOpen = false;
        }
    }

    // ─── Revert ──────────────────────────────────────────────

    _onRevert(i) {
        if (this._pickerOpen) return;
        this._session.revertPaletteColor(i).catch(err => {
            logger.log(`[PaletteSurgeon] Revert failed: ${err.message}`);
        });
    }

    // ─── Selection CSS ───────────────────────────────────────

    _updateSelectionCSS() {
        const isOverriddenMap = this._session.paletteOverrides;
        for (const [idx, swatch] of this._swatchElements) {
            const selected = (this._state === 'SELECTED' && idx === this._selectedIndex);
            if (selected) {
                swatch.classList.add('surgeon-selected');
            } else {
                swatch.classList.remove('surgeon-selected');
            }
            // Show revert button only when selected AND overridden
            const revertBtn = swatch.querySelector('.surgeon-revert');
            if (revertBtn) {
                if (selected && isOverriddenMap.has(idx)) {
                    revertBtn.classList.add('visible');
                } else {
                    revertBtn.classList.remove('visible');
                }
            }
        }
    }
}

module.exports = PaletteSurgeon;
