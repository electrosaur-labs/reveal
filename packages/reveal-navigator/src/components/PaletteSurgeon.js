/**
 * PaletteSurgeon - Click-based swatch grid for color isolation and merge.
 *
 * State machine:
 *   IDLE → click swatch[i] → SELECTED(i)  (highlight color i in preview)
 *   SELECTED(i) → click swatch[i] → IDLE  (deselect, restore normal preview)
 *   SELECTED(i) → click swatch[j] → merge i→j, IDLE
 *
 * Vanilla+ pattern: subscribes to SessionState events.
 */

// States
const IDLE = 'IDLE';
const SELECTED = 'SELECTED';

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

        // DOM elements
        this._header = null;
        this._grid = null;

        this._buildDOM();
        this._bindEvents();
    }

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

        // If selected index was pruned (no longer in palette), reset
        if (this._state === SELECTED && this._selectedIndex >= rgbPalette.length) {
            this._reset();
        }
        // Also reset if selected color has zero pixels (pruned by minVolume)
        if (this._state === SELECTED && counts[this._selectedIndex] === 0) {
            this._reset();
        }

        this._grid.innerHTML = '';

        for (let i = 0; i < rgbPalette.length; i++) {
            const c = rgbPalette[i];
            const pct = ((counts[i] / pixelCount) * 100).toFixed(1);

            // Skip merged/zero-coverage swatches
            if (counts[i] === 0) continue;

            const swatch = document.createElement('div');
            swatch.className = 'surgeon-swatch';
            if (this._state === SELECTED && i === this._selectedIndex) {
                swatch.classList.add('surgeon-selected');
            }

            const colorBlock = document.createElement('span');
            colorBlock.className = 'surgeon-color';
            colorBlock.style.background = `rgb(${c.r},${c.g},${c.b})`;

            const label = document.createElement('span');
            label.className = 'surgeon-pct';
            label.textContent = `${pct}%`;

            swatch.appendChild(colorBlock);
            swatch.appendChild(label);

            swatch.addEventListener('click', () => this._onSwatchClick(i));
            this._grid.appendChild(swatch);
        }

        this._container.style.display = '';
    }

    /**
     * Handle swatch click — implements the IDLE/SELECTED/MERGE state machine.
     * @param {number} i - Palette index clicked
     */
    _onSwatchClick(i) {
        if (this._state === IDLE) {
            // Enter SELECTED — highlight color i
            this._state = SELECTED;
            this._selectedIndex = i;
            this._session.setHighlight(i);
            this._header.textContent = 'Click another to merge, or same to deselect';
            this._updateSelection();

        } else if (this._state === SELECTED) {
            if (i === this._selectedIndex) {
                // Click same → deselect
                this._state = IDLE;
                this._selectedIndex = -1;
                this._session.clearHighlight();
                this._header.textContent = 'Click a color to isolate';
                this._updateSelection();
            } else {
                // Click different → merge selected into clicked
                const source = this._selectedIndex;
                const target = i;
                this._state = IDLE;
                this._selectedIndex = -1;
                this._session.clearHighlight();
                this._header.textContent = 'Click a color to isolate';
                this._performMerge(source, target);
            }
        }
    }

    /**
     * Merge source color into target via SessionState.
     */
    _performMerge(source, target) {
        this._session.mergePaletteColors(source, target).catch(err => {
            console.error('[PaletteSurgeon] Merge failed:', err);
        });
        // _rebuild() will fire automatically via previewUpdated
    }

    /**
     * Update selected visual state on swatches without full rebuild.
     */
    _updateSelection() {
        const swatches = this._grid.querySelectorAll('.surgeon-swatch');
        swatches.forEach(swatch => {
            swatch.classList.remove('surgeon-selected');
        });
        if (this._state === SELECTED) {
            // Find the swatch corresponding to selectedIndex
            // Swatches skip zero-count colors, so we need to map
            const proxy = this._session.proxyEngine;
            if (!proxy || !proxy.separationState) return;
            const { rgbPalette, colorIndices, width, height } = proxy.separationState;
            if (!rgbPalette || !colorIndices) return;

            const pixelCount = width * height;
            const counts = new Uint32Array(rgbPalette.length);
            for (let i = 0; i < pixelCount; i++) {
                counts[colorIndices[i]]++;
            }

            let swatchIdx = 0;
            for (let i = 0; i < rgbPalette.length; i++) {
                if (counts[i] === 0) continue;
                if (i === this._selectedIndex) {
                    if (swatches[swatchIdx]) {
                        swatches[swatchIdx].classList.add('surgeon-selected');
                    }
                    break;
                }
                swatchIdx++;
            }
        }
    }

    /**
     * Reset to IDLE — clear selection and highlight.
     */
    _reset() {
        this._state = IDLE;
        this._selectedIndex = -1;
        this._session.clearHighlight();
        if (this._header) {
            this._header.textContent = 'Click a color to isolate';
        }
    }
}

module.exports = PaletteSurgeon;
