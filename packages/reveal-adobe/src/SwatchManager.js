/**
 * SwatchManager - Swatch click/delete/highlight UI
 *
 * Reads: window.previewState, window.selectedPreview
 * Imports: PreviewRenderer (for render calls after swatch changes)
 */

const Reveal = require("@electrosaur-labs/core");
const logger = Reveal.logger;

const { renderPreview, render1to1Preview } = require('./PreviewRenderer');

/**
 * Update visual highlighting on swatches to show which is active
 */
function updateSwatchHighlights() {
    const state = window.previewState;
    if (!state) return;

    const container = document.getElementById('editablePaletteContainer');
    if (!container) return;

    const selectedPreview = window.selectedPreview;
    const substrateIndex = selectedPreview?.substrateIndex;

    const swatches = container.querySelectorAll('.editable-swatch');
    swatches.forEach((swatch, swatchIndex) => {
        let paletteIndex = swatchIndex;
        if (substrateIndex !== null && swatchIndex >= substrateIndex) {
            paletteIndex = swatchIndex + 1;
        }

        if (state.activeSoloIndex === paletteIndex) {
            swatch.classList.add('active-solo');
            swatch.style.outline = '8px solid #1473e6';
            swatch.style.outlineOffset = '-8px';
            swatch.style.boxShadow = 'inset 0 0 0 8px rgba(20, 115, 230, 0.5)';
        } else {
            swatch.classList.remove('active-solo');
            swatch.style.outline = 'none';
            swatch.style.outlineOffset = '0';
            swatch.style.boxShadow = 'inset 0 1px 3px rgba(0, 0, 0, 0.1)';
        }
    });

    const previewContainer = document.getElementById('previewContainer');
    if (previewContainer) {
        if (state.activeSoloIndex !== null) {
            previewContainer.classList.add('solo-mode');
        } else {
            previewContainer.classList.remove('solo-mode');
        }
    }
}

/**
 * Clear swatch selection (solo mode) - called when clicking outside swatches
 */
function clearSwatchSelection() {
    const state = window.previewState;
    if (!state || state.activeSoloIndex === null) return;

    state.activeSoloIndex = null;
    updateSwatchHighlights();

    if (state.viewMode === 'fit') {
        renderPreview();
    } else if (state.viewMode === 'zoom' && state.zoomRenderer) {
        state.zoomRenderer.setSoloColor(null);
        state.zoomRenderer.fetchAndRender();
    } else if (state.viewMode === '1:1') {
        render1to1Preview();
    }
}

/**
 * Update visual feedback for deleted/restored swatches
 * Shows opacity, grayscale, and "DELETED" badge for deleted colors
 * Shows "SUBSTRATE" badge for protected substrate colors
 */
function updateSwatchVisuals() {
    const state = window.previewState;
    if (!state) return;

    const container = document.getElementById('editablePaletteContainer');
    if (!container) return;

    const selectedPreview = window.selectedPreview;
    const substrateIndex = selectedPreview?.substrateIndex;

    const swatches = container.querySelectorAll('.editable-swatch');
    swatches.forEach((swatch, swatchIndex) => {
        let paletteIndex = swatchIndex;
        if (substrateIndex !== null && swatchIndex >= substrateIndex) {
            paletteIndex = swatchIndex + 1;
        }

        const isDeleted = state.deletedIndices.has(paletteIndex);

        if (isDeleted) {
            swatch.style.opacity = '0.4';
            swatch.style.filter = 'grayscale(100%)';

            if (!swatch.querySelector('.deleted-badge')) {
                const badge = document.createElement('div');
                badge.className = 'deleted-badge';
                badge.textContent = 'DELETED';
                badge.style.cssText = `
                    position: absolute;
                    bottom: 2px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: rgba(255, 0, 0, 0.9);
                    color: white;
                    font-size: 9px;
                    font-weight: bold;
                    padding: 2px 4px;
                    border-radius: 3px;
                    pointer-events: none;
                `;
                swatch.appendChild(badge);
            }
        } else {
            swatch.style.opacity = '1';
            swatch.style.filter = 'none';

            const deletedBadge = swatch.querySelector('.deleted-badge');
            if (deletedBadge) {
                deletedBadge.remove();
            }
        }
    });

    updateSwatchHighlights();
}

/**
 * Handle swatch click - select this color and highlight in preview
 * Clicking the same swatch keeps it selected (click outside to deselect)
 * @param {number} featureIndex - Index of the color feature (0-based, swatch index)
 */
function handleSwatchClick(featureIndex) {
    const state = window.previewState;
    if (!state) {
        return;
    }

    const selectedPreview = window.selectedPreview;
    const substrateIndex = selectedPreview?.substrateIndex;

    let paletteIndex = featureIndex;
    if (substrateIndex !== null && featureIndex >= substrateIndex) {
        paletteIndex = featureIndex + 1;
    }

    state.activeSoloIndex = paletteIndex;

    updateSwatchHighlights();

    if (state.viewMode === 'fit') {
        renderPreview();
    } else if (state.viewMode === 'zoom' && state.zoomRenderer) {
        state.zoomRenderer.setSoloColor(paletteIndex);
        state.zoomRenderer.fetchAndRender();
    } else if (state.viewMode === '1:1') {
        render1to1Preview();
    }
}

/**
 * Handle Alt+Click on swatch to toggle soft delete state
 * @param {number} swatchIndex - Zero-based swatch index (INK colors only, excluding substrate)
 */
function handleSwatchDelete(swatchIndex) {
    const state = window.previewState;
    if (!state) {
        return;
    }

    const selectedPreview = window.selectedPreview;
    const substrateIndex = selectedPreview?.substrateIndex;

    let paletteIndex = swatchIndex;
    if (substrateIndex !== null && swatchIndex >= substrateIndex) {
        paletteIndex = swatchIndex + 1;
    }

    const deletedIndices = state.deletedIndices;
    const totalColors = state.palette.length;

    if (deletedIndices.has(paletteIndex)) {
        deletedIndices.delete(paletteIndex);
    } else {
        const survivorCount = totalColors - deletedIndices.size;

        if (survivorCount === 1) {
            alert('Cannot delete all colors. At least one color must remain.');
            return;
        }

        if (survivorCount === 2) {
            const confirmed = confirm('This will leave only 1 color. Continue?');
            if (!confirmed) return;
        }

        deletedIndices.add(paletteIndex);

        if (state.activeSoloIndex === paletteIndex) {
            state.activeSoloIndex = null;
        }
    }

    updateSwatchVisuals();

    renderPreview();
}

module.exports = {
    updateSwatchHighlights,
    clearSwatchSelection,
    updateSwatchVisuals,
    handleSwatchClick,
    handleSwatchDelete
};
