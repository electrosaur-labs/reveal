/**
 * PaletteSurgeon - Per-swatch color editing.
 *
 * Interactions:
 *   click          → select/isolate that color (or deselect if same)
 *   drag A→B       → merge A into B (A takes B's color)
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

        // Drag-to-merge state
        this._dragSourceIndex = -1;
        this._dragStartX = 0;
        this._dragStartY = 0;
        this._isDragging = false;
        this._dragOverIndex = -1;
        this._dragShiftKey = false;
        this._dragAltKey = false;

        // Currently selected suggested swatch index (within filtered list), -1 = none
        this._selectedSuggestionIdx = -1;
        // View mode for selected suggestion: 'integrated' (what-if) or 'solo' (isolation)
        this._suggestionViewMode = null;

        this._swatchElements = new Map();

        // Build DOM
        this._header = document.createElement('div');
        this._header.className = 'surgeon-header';
        this._header.textContent = 'Click a color to isolate';
        this._container.appendChild(this._header);

        this._grid = document.createElement('div');
        this._grid.className = 'surgeon-grid';
        this._container.appendChild(this._grid);

        // Suggested colors tray (rendered below the palette grid)
        this._suggestedTray = document.createElement('div');
        this._suggestedTray.className = 'surgeon-suggested-tray';
        this._suggestedTray.style.display = 'none';
        this._container.appendChild(this._suggestedTray);

        // Subscribe to state events
        this._session.on('previewUpdated', () => this._rebuild());
        this._session.on('archetypeChanged', () => {
            this._state = 'IDLE';
            this._selectedIndex = -1;
            this._selectedSuggestionIdx = -1;
            this._suggestionViewMode = null;
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
        const sep = this._session.getSeparationState();
        if (!sep) return;

        const { rgbPalette, colorIndices, width, height } = sep;
        if (!rgbPalette || !colorIndices) return;

        logger.log(`[Surgeon] _rebuild: ${rgbPalette.length} palette entries, ${colorIndices.length} pixels`);

        const pixelCount = width * height;
        const counts = new Uint32Array(rgbPalette.length);
        for (let i = 0; i < pixelCount; i++) {
            counts[colorIndices[i]]++;
        }

        // If selected swatch was pruned away, deselect (but keep deleted swatches selected —
        // they always have zero counts because their pixels were merged into neighbors)
        if (this._state === 'SELECTED') {
            const selectedIsDeleted = this._session.deletedColors.has(this._selectedIndex);
            if (this._selectedIndex >= rgbPalette.length ||
                (counts[this._selectedIndex] === 0 && !selectedIsDeleted)) {
                this._state = 'IDLE';
                this._selectedIndex = -1;
                this._session.clearHighlight();
                this._header.textContent = 'Click a color to isolate';
            }
        }

        this._grid.innerHTML = '';
        this._swatchElements.clear();

        // Lab palette for D50 swatch rendering and gamut badges
        const labPalette = sep.palette;

        for (let i = 0; i < rgbPalette.length; i++) {
            const isDeleted = this._session.deletedColors.has(i);
            const isAdded = this._session.addedColors.has(i);
            if (counts[i] === 0 && !isDeleted && !isAdded) continue;   // skip truly empty, keep deleted + added

            const pct = isDeleted ? '—' : ((counts[i] / pixelCount) * 100).toFixed(1) + '%';
            const isOverridden = this._session.paletteOverrides.has(i);

            // ── Compute swatch color using D50 (matches Photoshop rendering) ──
            const c = (labPalette && labPalette[i])
                ? Reveal.labToRgbD50(labPalette[i])
                : rgbPalette[i];

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

            // ── Added color badge ("+" on user-added swatches) ──
            if (isAdded) {
                const addBadge = document.createElement('span');
                addBadge.className = 'surgeon-add-badge';
                addBadge.textContent = '+';
                colorBlock.appendChild(addBadge);
            }

            // ── Gamut clip badge — flags swatches where D50 rendering still lost chroma ──
            if (labPalette && labPalette[i]) {
                const gamut = Reveal.labGamutInfo(labPalette[i]);
                if (!gamut.inGamut) {
                    const clipBadge = document.createElement('span');
                    clipBadge.className = 'surgeon-clip-badge';
                    clipBadge.textContent = '\u26A0';  // ⚠
                    const lab = labPalette[i];
                    clipBadge.title = `Print-only color: exceeds monitor gamut\n${gamut.chromaLoss.toFixed(0)}% chroma lost (${gamut.iterations} iterations)\nTrue Lab: L=${lab.L.toFixed(1)} a=${lab.a.toFixed(1)} b=${lab.b.toFixed(1)}\nThe printed separation will be more vibrant than this swatch.`;
                    colorBlock.appendChild(clipBadge);
                }
            }

            // ── Merge badge ("+N" on target, "−" on source) ──
            const mergedSources = this._session.mergeHistory.get(i);
            const mergeCount = mergedSources ? mergedSources.size : 0;
            if (mergeCount > 0) {
                const badge = document.createElement('span');
                badge.className = 'surgeon-merge-badge';
                badge.textContent = `+${mergeCount}`;
                badge.title = `Absorbed ${mergeCount} merged color${mergeCount > 1 ? 's' : ''}`;
                colorBlock.appendChild(badge);
            }

            // "−" on merge sources (this swatch was merged into another)
            let isMergeSource = false;
            for (const [, sources] of this._session.mergeHistory) {
                if (sources.has(i)) { isMergeSource = true; break; }
            }
            if (isMergeSource) {
                const mBadge = document.createElement('span');
                mBadge.className = 'surgeon-merge-badge surgeon-merge-source';
                mBadge.textContent = '\u2212';  // −
                mBadge.title = 'Merged into another color — click \u21BA to revert';
                colorBlock.appendChild(mBadge);
            }

            // ── Percentage label ──
            const label = document.createElement('span');
            label.className = 'surgeon-pct';
            label.textContent = pct;

            // ── Revert button (visible when selected + overridden/deleted/added) ──
            const revertBtn = document.createElement('button');
            revertBtn.className = 'surgeon-revert';
            const isSelected = (this._state === 'SELECTED' && i === this._selectedIndex);
            if ((isOverridden || isDeleted || isAdded) && isSelected) revertBtn.classList.add('visible');
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

            // ── Pointer handlers: drag-to-merge + click + ctrl-click ──
            swatch.addEventListener('pointerdown', (e) => {
                if (this._pickerOpen) return;
                const idx = parseInt(e.currentTarget.dataset.index);

                // Ctrl+click → color picker (fires before OS/PS intercept)
                if (e.ctrlKey) {
                    if (!this._isDeadSwatch(idx)) {
                        e.preventDefault();
                        e.stopPropagation();
                        this._openColorPicker(idx);
                    }
                    return;
                }

                e.preventDefault();
                e.stopPropagation();

                // Deleted swatches: allow click (select → revert) but no drag
                if (!isDeleted) {
                    swatch.setPointerCapture(e.pointerId);
                    this._dragSourceIndex = idx;
                    this._dragStartX = e.clientX;
                    this._dragStartY = e.clientY;
                    this._isDragging = false;
                    this._dragOverIndex = -1;
                } else {
                    this._dragSourceIndex = idx;
                    this._isDragging = false;
                }
                this._dragShiftKey = e.shiftKey;
                this._dragAltKey = e.altKey;

                // One-shot pointerup on document (proven to fire in UXP)
                const onUp = (ev) => {
                    document.removeEventListener('pointerup', onUp);

                    const wasDragging = this._isDragging;
                    const source = this._dragSourceIndex;

                    // Clean up merge target highlight
                    if (this._dragOverIndex >= 0) {
                        const tgtEl = this._swatchElements.get(this._dragOverIndex);
                        if (tgtEl) tgtEl.classList.remove('surgeon-merge-target');
                    }

                    // Find target via ev.target (works in UXP; elementFromPoint doesn't)
                    let targetIdx = this._dragOverIndex;
                    if (targetIdx < 0) {
                        const hitSwatch = ev.target ? ev.target.closest('.surgeon-swatch[data-index]') : null;
                        targetIdx = hitSwatch ? parseInt(hitSwatch.dataset.index) : -1;
                    }

                    // Reset state
                    this._dragSourceIndex = -1;
                    this._dragOverIndex = -1;
                    this._isDragging = false;

                    if (wasDragging && targetIdx >= 0 && targetIdx !== source &&
                        !this._session.deletedColors.has(targetIdx)) {
                        logger.log(`[Surgeon] MERGE ${source}→${targetIdx} (drag)`);
                        this._session.mergePaletteColors(source, targetIdx).catch(err => {
                            logger.log(`[PaletteSurgeon] Merge failed: ${err.message}`);
                        });
                    } else if (!wasDragging) {
                        this._onSwatchClick(source, this._dragShiftKey, this._dragAltKey);
                    }
                };
                document.addEventListener('pointerup', onUp);
            });

            // ── pointermove: setPointerCapture routes events here during drag ──
            swatch.addEventListener('pointermove', (e) => {
                if (this._dragSourceIndex < 0) return;

                const dx = e.clientX - this._dragStartX;
                const dy = e.clientY - this._dragStartY;
                if (dx * dx + dy * dy >= 25) this._isDragging = true;

                // Hit-test via bounding rects (UXP lacks elementFromPoint)
                const overIdx = this._hitTestSwatch(e.clientX, e.clientY);

                if (overIdx !== this._dragOverIndex) {
                    const prevIdx = this._dragOverIndex;
                    this._dragOverIndex = overIdx;
                    // Defer class changes — UXP may skip repaints during pointer capture
                    setTimeout(() => {
                        if (prevIdx >= 0) {
                            const prev = this._swatchElements.get(prevIdx);
                            if (prev) prev.classList.remove('surgeon-merge-target');
                        }
                        if (overIdx >= 0 && overIdx !== this._dragSourceIndex &&
                            !this._session.deletedColors.has(overIdx)) {
                            const el = this._swatchElements.get(overIdx);
                            if (el) el.classList.add('surgeon-merge-target');
                        }
                    }, 0);
                }
            });

            this._grid.appendChild(swatch);
            this._swatchElements.set(i, swatch);
        }

        // "+" add button — always available unless at hard max (20 screens)
        if (rgbPalette.length < 20) {
            const addBtn = document.createElement('div');
            addBtn.className = 'surgeon-swatch surgeon-add';
            const addColor = document.createElement('span');
            addColor.className = 'surgeon-color surgeon-add-color';
            addColor.textContent = '+';
            addBtn.appendChild(addColor);
            addBtn.onclick = () => this._openAddColorPicker();
            this._grid.appendChild(addBtn);
        }

        this._container.style.display = 'block';

        // Render suggested colors below the palette
        this._renderSuggestedColors();
    }

    // ─── Click ───────────────────────────────────────────────

    _onSwatchClick(i, _shiftKey, altKey) {
        if (this._pickerOpen) return;

        // Clear any suggested swatch selection
        if (this._selectedSuggestionIdx >= 0) {
            this._selectedSuggestionIdx = -1;
            this._suggestionViewMode = null;
            this._renderSuggestedColors();
        }

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
            this._rebuild();  // rebuild reads _state/_selectedIndex to set selection + revert button
            return;
        }

        const now = Date.now();

        // Double-click detection: same swatch within threshold
        if (i === this._lastClickIndex && (now - this._lastClickTime) < DBLCLICK_MS) {
            this._lastClickTime = 0;
            this._lastClickIndex = -1;
            if (!this._isDeadSwatch(i)) {
                this._openColorPicker(i);
            }
            return;
        }
        this._lastClickTime = now;
        this._lastClickIndex = i;

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
        const prevState = this._state;
        const prevIndex = this._selectedIndex;
        this._state = 'IDLE';
        this._selectedIndex = -1;
        this._session.clearHighlight();
        this._header.textContent = 'Click a color to isolate';
        this._updateSelectionCSS();

        logger.log(`[Surgeon] DELETE swatch ${i} (alt+click)`);
        this._session.deletePaletteColor(i).catch(err => {
            logger.log(`[PaletteSurgeon] Delete failed: ${err.message}`);
            this._state = prevState;
            this._selectedIndex = prevIndex;
            this._header.textContent = 'Delete failed — try again';
            this._updateSelectionCSS();
        });
    }

    isPickerOpen() { return this._pickerOpen; }

    // ─── Color Picker ────────────────────────────────────────

    async _openColorPicker(i) {
        const sep = this._session.getSeparationState();
        if (!sep) return;

        const rgb = sep.rgbPalette[i];
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

            // Modal is done — release the picker lock immediately so the
            // dialog close handler stops re-showing.  The async processing
            // below (overridePaletteColor) must not hold this lock.
            this._pickerOpen = false;

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
            this._pickerOpen = false;  // belt-and-suspenders for error paths
        }
    }

    // ─── Add Color Picker ──────────────────────────────────────

    async _openAddColorPicker() {
        if (this._pickerOpen) return;

        this._pickerOpen = true;
        this._header.textContent = 'Pick a color to add...';

        try {
            const { core, action, app } = require("photoshop");
            let result = null;

            // Seed with mid-gray so any change counts as "confirmed"
            const seedR = 128, seedG = 128, seedB = 128;

            await core.executeAsModal(async () => {
                await action.batchPlay([{
                    _obj: "set",
                    _target: [{ _ref: "color", _property: "foregroundColor" }],
                    to: {
                        _obj: "RGBColor",
                        red: seedR, grain: seedG, blue: seedB
                    }
                }], {});

                await action.batchPlay([{
                    _obj: "showColorPicker"
                }], {});

                const c = app.foregroundColor;
                const newR = Math.round(c.rgb.red);
                const newG = Math.round(c.rgb.green);
                const newB = Math.round(c.rgb.blue);

                // Treat as confirmed if color changed from seed
                if (newR !== seedR || newG !== seedG || newB !== seedB) {
                    result = { r: newR, g: newG, b: newB };
                }
            }, { commandName: "Pick New Color" });

            // Modal is done — release the picker lock immediately so the
            // dialog close handler stops re-showing.  The async processing
            // below (addPaletteColor) must not hold this lock.
            this._pickerOpen = false;

            if (result) {
                const lab = Reveal.rgbToLab(result.r, result.g, result.b);
                logger.log(`[PaletteSurgeon] Adding color: rgb(${result.r},${result.g},${result.b}) → Lab(${lab.L.toFixed(1)},${lab.a.toFixed(1)},${lab.b.toFixed(1)})`);
                await this._session.addPaletteColor(lab);
            }

            this._header.textContent = 'Click a color to isolate';
        } catch (err) {
            logger.log(`[PaletteSurgeon] Add color picker error: ${err.message}`);
            this._header.textContent = 'Click a color to isolate';
        } finally {
            this._pickerOpen = false;  // belt-and-suspenders for error paths
        }
    }

    // ─── Revert ──────────────────────────────────────────────

    _onRevert(i) {
        if (this._pickerOpen) return;

        // Added colors get fully removed (palette shrinks) instead of reverted
        if (this._session.addedColors.has(i)) {
            this._state = 'IDLE';
            this._selectedIndex = -1;
            this._session.clearHighlight();
            this._header.textContent = 'Click a color to isolate';
            this._session.removeAddedColor(i).catch(err => {
                logger.log(`[PaletteSurgeon] Remove added color failed: ${err.message}`);
            });
            return;
        }

        this._session.revertPaletteColor(i).catch(err => {
            logger.log(`[PaletteSurgeon] Revert failed: ${err.message}`);
        });
    }

    // ─── Suggested Colors ─────────────────────────────────────

    /** Check if a suggestion was already checked (delegates to SessionState) */
    _isSuggestionAdded(suggestion) {
        return this._session.isSuggestionChecked(suggestion);
    }

    /** Remove a checked suggestion (delegates to SessionState) */
    _removeSuggestion(suggestion) {
        this._session.removeCheckedSuggestion(suggestion);
    }

    /** ΔE between two Lab colors */
    _deltaE(c1, c2) {
        return Reveal.LabDistance.cie76(c1, c2);
    }

    /** Check if a suggestion is too close to any current palette entry (linear ΔE < 15) */
    _isTooCloseToCurrentPalette(suggestion) {
        const sep = this._session.getSeparationState();
        if (!sep || !sep.palette) return false;
        // Linear ΔE threshold for "too similar to existing palette color" exclusion
        const PALETTE_EXCLUSION_DE = 15;
        for (const pal of sep.palette) {
            if (this._deltaE(suggestion, pal) < PALETTE_EXCLUSION_DE) return true;
        }
        return false;
    }

    _renderSuggestedColors() {
        const cachedSuggestions = this._session.getSuggestedColors();

        // Filter against CURRENT palette — but never filter out checked (added) suggestions
        const suggestions = (cachedSuggestions || []).filter(s =>
            this._isSuggestionAdded(s) || !this._isTooCloseToCurrentPalette(s)
        );

        if (suggestions.length === 0) {
            this._suggestedTray.style.display = 'none';
            return;
        }

        this._suggestedTray.innerHTML = '';
        this._suggestedTray.style.display = 'block';

        const label = document.createElement('div');
        label.className = 'surgeon-suggested-label';
        label.textContent = 'Suggested';
        this._suggestedTray.appendChild(label);

        const row = document.createElement('div');
        row.className = 'surgeon-suggested-row';

        for (let si = 0; si < suggestions.length; si++) {
            const suggestion = suggestions[si];
            const rgb = Reveal.labToRgbD50({ L: suggestion.L, a: suggestion.a, b: suggestion.b });
            const swatch = document.createElement('div');
            swatch.className = 'surgeon-suggested-swatch';
            swatch.style.background = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
            swatch.title = `${suggestion.source}: ${suggestion.reason}`;

            const isAdded = this._isSuggestionAdded(suggestion);
            if (isAdded) swatch.classList.add('added');

            const isSelected = (si === this._selectedSuggestionIdx);
            if (isSelected) swatch.classList.add('surgeon-selected');

            const idx = si;

            // Ctrl+click: toggle "must be in final palette" checkmark
            swatch.addEventListener('pointerdown', (e) => {
                if (!e.ctrlKey || this._pickerOpen) return;
                e.preventDefault();
                e.stopPropagation();
                swatch._ctrlHandled = true;

                if (isAdded) {
                    logger.log(`[Surgeon] Unmarked suggested color: L=${suggestion.L.toFixed(0)} a=${suggestion.a.toFixed(0)} b=${suggestion.b.toFixed(0)}`);
                    this._removeSuggestion(suggestion);
                } else {
                    logger.log(`[Surgeon] Marked suggested color: ${suggestion.reason}`);
                    this._session.addCheckedSuggestion(suggestion);
                }
                this._renderSuggestedColors();
            });

            // Plain click: select/deselect (solo view in preview)
            swatch.onclick = (e) => {
                if (swatch._ctrlHandled) { swatch._ctrlHandled = false; return; }
                if (this._pickerOpen) return;

                // Deselect any palette swatch
                if (this._state === 'SELECTED') {
                    this._state = 'IDLE';
                    this._selectedIndex = -1;
                    this._updateSelectionCSS();
                }

                if (this._selectedSuggestionIdx === idx) {
                    if (this._suggestionViewMode === 'solo') {
                        // Solo → show integrated "what if" preview
                        this._suggestionViewMode = 'integrated';
                        this._session.setSuggestionGhost(
                            { L: suggestion.L, a: suggestion.a, b: suggestion.b },
                            'integrated'
                        );
                        this._header.textContent = 'Showing "what if" \u2014 click to deselect';
                    } else {
                        // Integrated → deselect
                        this._selectedSuggestionIdx = -1;
                        this._suggestionViewMode = null;
                        this._session.clearHighlight();
                        this._header.textContent = 'Click a color to isolate';
                    }
                } else {
                    // Select this suggestion → show solo isolation
                    this._selectedSuggestionIdx = idx;
                    this._suggestionViewMode = 'solo';
                    this._session.setSuggestionGhost(
                        { L: suggestion.L, a: suggestion.a, b: suggestion.b },
                        'solo'
                    );
                    this._header.textContent = 'Ctrl+click to mark "must have"';
                }
                this._renderSuggestedColors();
            };


            row.appendChild(swatch);
        }

        this._suggestedTray.appendChild(row);
    }

    // ─── Selection CSS ───────────────────────────────────────

    _updateSelectionCSS() {
        const isOverriddenMap = this._session.paletteOverrides;
        const deletedColors = this._session.deletedColors;
        for (const [idx, swatch] of this._swatchElements) {
            const selected = (this._state === 'SELECTED' && idx === this._selectedIndex);
            if (selected) {
                swatch.classList.add('surgeon-selected');
            } else {
                swatch.classList.remove('surgeon-selected');
            }
            // Show revert button when selected AND (overridden OR deleted OR added)
            const revertBtn = swatch.querySelector('.surgeon-revert');
            if (revertBtn) {
                const addedColors = this._session.addedColors;
                if (selected && (isOverriddenMap.has(idx) || deletedColors.has(idx) || addedColors.has(idx))) {
                    revertBtn.classList.add('visible');
                } else {
                    revertBtn.classList.remove('visible');
                }
            }
        }
    }
    /** True if swatch is deleted or a merge source (not editable). */
    _isDeadSwatch(i) {
        if (this._session.deletedColors.has(i)) return true;
        for (const sources of this._session.mergeHistory.values()) {
            if (sources.has(i)) return true;
        }
        return false;
    }

    // ─── Drag Helpers ──────────────────────────────────────

    /**
     * Hit-test swatches by bounding rect (UXP lacks elementFromPoint).
     * @param {number} clientX
     * @param {number} clientY
     * @returns {number} palette index under pointer, or -1
     */
    _hitTestSwatch(clientX, clientY) {
        for (const [idx, el] of this._swatchElements) {
            const r = el.getBoundingClientRect();
            if (clientX >= r.left && clientX <= r.right &&
                clientY >= r.top && clientY <= r.bottom) {
                return idx;
            }
        }
        return -1;
    }
}

module.exports = PaletteSurgeon;
