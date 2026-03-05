/**
 * NavigatorHandlers - Event handler attachment for navigator/drag/keyboard
 *
 * Imports: PreviewRenderer, SwatchManager
 */

const Reveal = require("@electrosaur-labs/core");
const logger = Reveal.logger;

const { renderNavigatorMap, render1to1Preview, updateNavigatorViewport } = require('./PreviewRenderer');
const { updateSwatchHighlights } = require('./SwatchManager');

/**
 * Handle arrow key navigation for viewport panning (Phase 4+)
 * Arrow keys pan viewport by 10% of viewport size
 */
function attachArrowKeyNavigation() {
    document.removeEventListener('keydown', window._arrowKeyHandler);

    const handler = async (e) => {
        if (!window.previewState || window.previewState.viewMode !== '1:1') {
            return;
        }

        if (!window.viewportManager) {
            return;
        }

        const activeElement = document.activeElement;
        if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
            return;
        }

        const vmState = window.viewportManager.getState();
        const panAmount = 50;

        let handled = false;
        switch (e.key) {
            case 'ArrowUp':
                window.viewportManager.pan(0, -panAmount);
                handled = true;
                break;
            case 'ArrowDown':
                window.viewportManager.pan(0, panAmount);
                handled = true;
                break;
            case 'ArrowLeft':
                window.viewportManager.pan(-panAmount, 0);
                handled = true;
                break;
            case 'ArrowRight':
                window.viewportManager.pan(panAmount, 0);
                handled = true;
                break;
        }

        if (handled) {
            e.preventDefault();

            renderNavigatorMap();
            await render1to1Preview();
        }
    };

    window._arrowKeyHandler = handler;
    document.addEventListener('keydown', handler);

}

/**
 * Handle Navigator Map click to jump viewport (Phase 4)
 * Converts click coordinates to normalized position and updates viewport
 */
function attachNavigatorClickHandler() {

    const navigatorContainer = document.getElementById('navigatorMapContainer');
    const img = document.getElementById('navigatorCanvas');
    const viewportRect = document.getElementById('navigatorViewport');

    if (!navigatorContainer || !img || !viewportRect) {
        logger.error('[Navigator] Elements not found');
        return;
    }

    if (!window._navigatorDragState) {
        window._navigatorDragState = {
            isDragging: false,
            hasDragged: false,
            rafPending: false
        };
    }
    const dragState = window._navigatorDragState;

    if (window._navigatorHandlers) {
        const old = window._navigatorHandlers;
        navigatorContainer.removeEventListener('pointerdown', old.pointerdown);
        navigatorContainer.removeEventListener('pointermove', old.pointermove);
        navigatorContainer.removeEventListener('pointerup', old.pointerup);
        navigatorContainer.removeEventListener('pointercancel', old.pointercancel);
        navigatorContainer.removeEventListener('click', old.click);
    }

    const pointerdownHandler = (e) => {
        if (!window.viewportManager) return;

        if (e.target !== img) return;

        dragState.isDragging = true;
        dragState.hasDragged = false;

        navigatorContainer.style.cursor = 'grabbing';
        e.preventDefault();

    };

    const pointermoveHandler = (e) => {
        if (!dragState.isDragging || !window.viewportManager) return;

        dragState.hasDragged = true;

        const imgRect = img.getBoundingClientRect();

        const clickX = e.clientX - imgRect.left;
        const clickY = e.clientY - imgRect.top;

        const constrainedX = Math.max(0, Math.min(imgRect.width, clickX));
        const constrainedY = Math.max(0, Math.min(imgRect.height, clickY));

        const normX = constrainedX / imgRect.width;
        const normY = constrainedY / imgRect.height;

        window.viewportManager.jumpToNormalized(normX, normY);

        const navData = window.viewportManager.getNavigatorMap(160);
        if (navData && navData.viewportBounds) {
            updateNavigatorViewport(navData.viewportBounds);
        }

        if (!dragState.rafPending) {
            dragState.rafPending = true;
            requestAnimationFrame(async () => {
                await render1to1Preview();
                dragState.rafPending = false;
            });
        }
    };

    const pointerupHandler = async () => {
        if (dragState.isDragging) {
            dragState.isDragging = false;
            navigatorContainer.style.cursor = '';

            renderNavigatorMap();

            await render1to1Preview();

        }
    };

    const clickHandler = async (e) => {
        if (!window.viewportManager) return;

        if (dragState.hasDragged) {
            dragState.hasDragged = false;
            return;
        }

        if (e.target !== img) return;

        const imgRect = img.getBoundingClientRect();

        const clickX = e.clientX - imgRect.left;
        const clickY = e.clientY - imgRect.top;

        const constrainedX = Math.max(0, Math.min(imgRect.width, clickX));
        const constrainedY = Math.max(0, Math.min(imgRect.height, clickY));

        const normX = constrainedX / imgRect.width;
        const normY = constrainedY / imgRect.height;

        window.viewportManager.jumpToNormalized(normX, normY);

        renderNavigatorMap();
        await render1to1Preview();
    };

    img.addEventListener('pointerdown', pointerdownHandler);
    navigatorContainer.addEventListener('pointermove', pointermoveHandler);
    navigatorContainer.addEventListener('pointerup', pointerupHandler);
    navigatorContainer.addEventListener('pointercancel', pointerupHandler);
    navigatorContainer.addEventListener('click', clickHandler);

    window._navigatorHandlers = {
        pointerdown: pointerdownHandler,
        pointermove: pointermoveHandler,
        pointerup: pointerupHandler,
        pointercancel: pointerupHandler,
        click: clickHandler
    };

}

/**
 * Attach click handler to preview image to deselect swatches in 1:1 mode
 */
function attachPreviewClickHandler() {
    const previewImg = document.getElementById('previewImg');

    if (!previewImg) {
        logger.error('[Preview] Cannot attach click handler - preview image not found');
        return;
    }

    if (window._previewClickHandler) {
        previewImg.removeEventListener('click', window._previewClickHandler);
    }

    const clickHandler = async () => {
        const state = window.previewState;
        if (!state || state.viewMode !== '1:1') return;

        if (state.activeSoloIndex === null || state.activeSoloIndex === undefined) {
            return;
        }

        state.activeSoloIndex = null;
        updateSwatchHighlights();

        await render1to1Preview();
    };

    previewImg.addEventListener('click', clickHandler);
    window._previewClickHandler = clickHandler;

}

/**
 * Attach drag-to-pan handler for 1:1 preview mode
 * Allows user to drag the main preview image to pan around the document
 */
function attach1to1PreviewDragHandler() {
    const previewContainer = document.getElementById('previewContainer');
    const previewImg = document.getElementById('previewImg');

    if (!previewContainer || !previewImg) {
        logger.error('[1:1 Drag] Cannot attach drag handler - elements not found');
        return;
    }

    if (window._1to1DragHandlers) {
        const old = window._1to1DragHandlers;
        previewContainer.removeEventListener('pointerdown', old.pointerdown);
        previewContainer.removeEventListener('pointermove', old.pointermove);
        previewContainer.removeEventListener('pointerup', old.pointerup);
        previewContainer.removeEventListener('pointercancel', old.pointerup);
    }

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let hasDragged = false;

    const pointerdownHandler = (e) => {
        if (e.target !== previewImg) return;

        isDragging = true;
        hasDragged = false;
        startX = e.clientX;
        startY = e.clientY;
        previewContainer.style.cursor = 'grabbing';
        e.preventDefault();
    };

    const pointermoveHandler = async (e) => {
        if (!isDragging || !window.viewportManager) return;

        hasDragged = true;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        startX = e.clientX;
        startY = e.clientY;

        window.viewportManager.pan(-deltaX, -deltaY);

        const navData = window.viewportManager.getNavigatorMap(160);
        if (navData && navData.viewportBounds) {
            updateNavigatorViewport(navData.viewportBounds);
        }

        if (!window._1to1PanRafPending) {
            window._1to1PanRafPending = true;
            requestAnimationFrame(async () => {
                await render1to1Preview();
                window._1to1PanRafPending = false;
            });
        }
    };

    const pointerupHandler = async () => {
        if (isDragging) {
            isDragging = false;
            previewContainer.style.cursor = '';

            if (hasDragged) {
                renderNavigatorMap();
                await render1to1Preview();
            }
        }
    };

    previewContainer.addEventListener('pointerdown', pointerdownHandler);
    previewContainer.addEventListener('pointermove', pointermoveHandler);
    previewContainer.addEventListener('pointerup', pointerupHandler);
    previewContainer.addEventListener('pointercancel', pointerupHandler);

    window._1to1DragHandlers = {
        pointerdown: pointerdownHandler,
        pointermove: pointermoveHandler,
        pointerup: pointerupHandler
    };

}

module.exports = {
    attachArrowKeyNavigation,
    attachNavigatorClickHandler,
    attachPreviewClickHandler,
    attach1to1PreviewDragHandler
};
