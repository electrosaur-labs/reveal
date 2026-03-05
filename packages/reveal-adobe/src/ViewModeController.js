/**
 * ViewModeController - View mode switching (fit/zoom/1:1) and zoom preview controls
 *
 * Imports: PluginState, PreviewRenderer, NavigatorHandlers, SwatchManager, DialogHelpers
 */

const Reveal = require("@electrosaur-labs/core");
const PosterizationEngine = Reveal.engines.PosterizationEngine;
const logger = Reveal.logger;

const pluginState = require('./PluginState');
const { renderPreview, renderNavigatorMap, render1to1Preview } = require('./PreviewRenderer');
const { attachArrowKeyNavigation, attachNavigatorClickHandler, attachPreviewClickHandler, attach1to1PreviewDragHandler } = require('./NavigatorHandlers');
const { replaceSelectOptions } = require('./DialogHelpers');

const ZoomPreviewRenderer = require("./api/ZoomPreviewRenderer");

/**
 * Rebuild the Preview Quality / Resolution dropdown from scratch for the given mode.
 * Called on ENTRY to Zoom or Fit mode. Creates fresh options and a fresh handler each time.
 * For 1:1 mode the dropdown is hidden, so nothing to do.
 */
function rebuildPreviewStrideForMode(mode) {
    const previewStrideSelect = document.getElementById('previewStride');
    const previewStrideLabel = document.getElementById('previewStrideLabel');

    if (!previewStrideSelect) {
        logger.error('[Dropdown] previewStride select not found');
        return;
    }

    // 1. Remove old handler
    if (window._previewStrideChangeHandler) {
        previewStrideSelect.removeEventListener('change', window._previewStrideChangeHandler);
        window._previewStrideChangeHandler = null;
    }

    // 2. Set options and label for mode
    if (mode === 'zoom') {
        if (previewStrideLabel) previewStrideLabel.textContent = 'Resolution:';
        replaceSelectOptions(previewStrideSelect, [
            { value: '1', text: '1:1 (Full Res)', selected: true },
            { value: '2', text: '1:2 (Half Res)' },
            { value: '4', text: '1:4 (Quarter Res)' },
            { value: '8', text: '1:8 (Eighth Res)' }
        ]);

        // 3. Create zoom-specific handler
        window._previewStrideChangeHandler = async () => {
            if (!window.previewState) return;
            const value = parseInt(previewStrideSelect.value, 10);
            const state = window.previewState;
            if (state.zoomRenderer) {
                const centerX = state.zoomRenderer.width / 2;
                const centerY = state.zoomRenderer.height / 2;
                await state.zoomRenderer.setResolutionAtPoint(value, centerX, centerY);
            }
        };

    } else {
        // fit mode (default)
        if (previewStrideLabel) previewStrideLabel.textContent = 'Preview Quality:';
        replaceSelectOptions(previewStrideSelect, [
            { value: '4', text: 'Standard (fast)', selected: true },
            { value: '2', text: 'Fine (slow)' },
            { value: '1', text: 'Finest (slower)' }
        ]);

        // 3. Create fit-specific handler
        window._previewStrideChangeHandler = async () => {
            if (!pluginState.posterizationData || !window.previewState) return;
            const stride = parseInt(previewStrideSelect.value, 10);
            const pixels = pluginState.posterizationData.originalPixels;
            const paletteLab = pluginState.posterizationData.selectedPreview.paletteLab;
            const width = pluginState.posterizationData.originalWidth;
            const height = pluginState.posterizationData.originalHeight;

            const labels = { 4: 'Standard', 2: 'Fine', 1: 'Finest' };
            document.body.style.cursor = 'wait';

            setTimeout(() => {
                try {
                    const bitDepth = pluginState.posterizationData.bitDepth || 8;
                    const assignments = PosterizationEngine.reassignWithStride(
                        pixels, paletteLab, width, height, stride, bitDepth
                    );
                    window.previewState.assignments = assignments;
                    renderPreview();
                } catch (err) {
                    logger.error('Stride change error:', err);
                }
                document.body.style.cursor = '';
            }, 50);
        };
    }

    // 4. Attach fresh handler
    previewStrideSelect.addEventListener('change', window._previewStrideChangeHandler);
}

/**
 * Switch preview panel between Fit and Zoom modes
 */
async function setPreviewMode(mode) {
    const state = window.previewState;
    if (!state) {
        logger.error('Preview state not initialized');
        return;
    }

    if (state.viewMode === mode) {
        return;
    }

    const container = document.getElementById('previewContainer');
    const imageEl = document.getElementById('previewImg');


    if (mode === 'zoom') {
        // ZOOM MODE: Initialize ZoomPreviewRenderer

        // Show quality group if coming from 1:1 mode
        if (state.viewMode === '1:1') {
            const qualityGroup = document.getElementById('previewQualityGroup');
            if (qualityGroup) {
                qualityGroup.style.display = 'flex';
            }
        }

        if (!pluginState.posterizationData || !pluginState.posterizationData.docInfo) {
            logger.error('Missing posterizationData for zoom mode');
            return;
        }

        const docInfo = pluginState.posterizationData.docInfo;
        const documentID = typeof docInfo.id === 'number' ? docInfo.id : parseInt(docInfo.id, 10);
        const originalLayerID = docInfo.activeLayerID;
        const docWidth = docInfo.width;
        const docHeight = docInfo.height;
        const bitDepth = pluginState.posterizationData.bitDepth || 8;

        const selectedPreview = pluginState.posterizationData.selectedPreview;

        const separationData = {
            palette: selectedPreview.paletteLab
        };

        container.classList.add('zoom-mode');

        const imageEl2 = document.getElementById('previewImgBuffer2');
        if (!imageEl2) {
            logger.error('Second buffer image not found');
            return;
        }

        imageEl.style.position = 'absolute';
        imageEl.style.willChange = 'transform';
        imageEl.style.top = '0';
        imageEl.style.left = '0';
        imageEl.style.opacity = '1';
        imageEl.style.pointerEvents = 'auto';
        imageEl2.style.position = 'absolute';
        imageEl2.style.willChange = 'transform';
        imageEl2.style.top = '0';
        imageEl2.style.left = '0';
        imageEl2.style.opacity = '0';
        imageEl2.style.pointerEvents = 'none';

        state.zoomRenderer = new ZoomPreviewRenderer(
            container,
            imageEl,
            imageEl2,
            documentID,
            originalLayerID,
            docWidth,
            docHeight,
            bitDepth,
            separationData
        );

        state.zoomRenderer.hqBadge = document.getElementById('previewHqBadge');

        if (state.activeSoloIndex !== null) {
            state.zoomRenderer.setSoloColor(state.activeSoloIndex);
        }

        try {
            await state.zoomRenderer.init();
        } catch (err) {
            logger.error('Failed to initialize renderer:', err);
            throw err;
        }

        rebuildPreviewStrideForMode('zoom');

        attachPreviewZoomHandlers();

        state._resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const newWidth = entry.contentRect.width;
                const newHeight = entry.contentRect.height;

                if (state.zoomRenderer &&
                    (Math.abs(newWidth - state.zoomRenderer.width) > 10 ||
                     Math.abs(newHeight - state.zoomRenderer.height) > 10)) {

                    state.zoomRenderer.width = newWidth;
                    state.zoomRenderer.height = newHeight;

                    state.zoomRenderer.rgbaBuffer = new Uint8Array(newWidth * newHeight * 4);

                    state.zoomRenderer.applyBounds();
                    state.zoomRenderer.fetchAndRender();
                }
            }
        });
        state._resizeObserver.observe(container);

        state.viewMode = 'zoom';

    } else if (mode === '1:1') {
        // 1:1 CLINICAL LOUPE MODE

        const navigatorMap = document.getElementById('navigatorMapContainer');
        const qualityGroup = document.getElementById('previewQualityGroup');

        if (navigatorMap) {
            navigatorMap.style.display = 'block';
        }
        if (qualityGroup) {
            qualityGroup.style.display = 'none';
        }

        state.viewMode = '1:1';

        renderNavigatorMap();

        attachNavigatorClickHandler();

        attachArrowKeyNavigation();

        attachPreviewClickHandler();

        attach1to1PreviewDragHandler();

        await render1to1Preview();


    } else if (mode === 'fit') {
        // FIT MODE: Cleanup ZoomPreviewRenderer or 1:1 mode, restore renderPreview

        if (state.viewMode === '1:1') {

            const navigatorMap = document.getElementById('navigatorMapContainer');
            const qualityGroup = document.getElementById('previewQualityGroup');

            if (navigatorMap) {
                navigatorMap.style.display = 'none';
            }
            if (qualityGroup) {
                qualityGroup.style.display = 'flex';
            }

            if (window._1to1DragHandlers) {
                const previewContainer = document.getElementById('previewContainer');
                if (previewContainer) {
                    const handlers = window._1to1DragHandlers;
                    previewContainer.removeEventListener('pointerdown', handlers.pointerdown);
                    previewContainer.removeEventListener('pointermove', handlers.pointermove);
                    previewContainer.removeEventListener('pointerup', handlers.pointerup);
                    previewContainer.removeEventListener('pointercancel', handlers.pointerup);
                    previewContainer.style.cursor = '';
                    window._1to1DragHandlers = null;
                }
            }

        }

        // Cleanup zoom renderer
        if (state.zoomRenderer) {
            if (state.zoomRenderer.qualityTimeout) {
                clearTimeout(state.zoomRenderer.qualityTimeout);
            }

            state.zoomRenderer.isRendering = false;

            const img1 = state.zoomRenderer.images[0];
            const img2 = state.zoomRenderer.images[1];
            if (img1) {
                img1.onload = null;
                img1.onerror = null;
            }
            if (img2) {
                img2.onload = null;
                img2.onerror = null;
            }

            if (state.zoomRenderer.activePixelData && state.zoomRenderer.activePixelData.imageData) {
                state.zoomRenderer.activePixelData.imageData.dispose();
                state.zoomRenderer.activePixelData = null;
            }

            state.zoomRenderer = null;
        }

        detachPreviewZoomHandlers();

        if (state._resizeObserver) {
            state._resizeObserver.disconnect();
            state._resizeObserver = null;
        }

        container.classList.remove('zoom-mode');

        imageEl.style.position = '';
        imageEl.style.top = '';
        imageEl.style.left = '';
        imageEl.style.transform = '';
        imageEl.style.width = '';
        imageEl.style.height = '';
        imageEl.style.willChange = '';
        imageEl.style.opacity = '1';
        imageEl.style.pointerEvents = 'auto';
        imageEl.style.maxWidth = '100%';
        imageEl.style.maxHeight = '100%';
        imageEl.style.objectFit = 'contain';

        const imageEl2 = document.getElementById('previewImgBuffer2');
        if (imageEl2) {
            imageEl2.onload = null;
            imageEl2.onerror = null;
            imageEl2.src = '';
            imageEl2.style.opacity = '0';
            imageEl2.style.pointerEvents = 'none';
            imageEl2.style.position = '';
            imageEl2.style.top = '';
            imageEl2.style.left = '';
            imageEl2.style.transform = '';
            imageEl2.style.width = '';
            imageEl2.style.height = '';
            imageEl2.style.willChange = '';
        }

        const hqBadge = document.getElementById('previewHqBadge');
        if (hqBadge) {
            hqBadge.style.display = 'none';
        }

        rebuildPreviewStrideForMode('fit');

        state.viewMode = 'fit';

        renderPreview();

    }
}

/**
 * Attach zoom event handlers for preview panel zoom mode
 */
function attachPreviewZoomHandlers() {
    const state = window.previewState;
    if (!state || !state.zoomRenderer) return;

    const container = document.getElementById('previewContainer');
    const renderer = state.zoomRenderer;

    state._previewZoomHandlers = {
        mousedown: null,
        mousemove: null,
        mouseup: null,
        wheel: null,
        keydown: null
    };

    let isDragging = false;
    let hasMoved = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let lastX = 0;
    let lastY = 0;
    let transformX = 0;
    let transformY = 0;
    let lastRenderTime = 0;
    const RENDER_INTERVAL = 80;
    const MIN_DRAG_DISTANCE = 3;

    state._previewZoomHandlers.mousedown = (e) => {
        isDragging = true;
        hasMoved = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        lastX = e.clientX;
        lastY = e.clientY;
        transformX = 0;
        transformY = 0;
        lastRenderTime = 0;
        clearTimeout(renderer.qualityTimeout);
        container.classList.add('panning');
        e.preventDefault();
    };

    state._previewZoomHandlers.mousemove = (e) => {
        if (!isDragging) return;

        const deltaX = lastX - e.clientX;
        const deltaY = lastY - e.clientY;

        const totalDragDistance = Math.sqrt(
            Math.pow(e.clientX - dragStartX, 2) +
            Math.pow(e.clientY - dragStartY, 2)
        );
        if (totalDragDistance > MIN_DRAG_DISTANCE) {
            hasMoved = true;
        }

        renderer.pan(deltaX, deltaY);

        transformX -= deltaX;
        transformY -= deltaY;

        const activeImg = renderer.getActiveImage();
        if (activeImg) {
            activeImg.style.transform = `translate3d(${transformX}px, ${transformY}px, 0)`;
        }

        const now = Date.now();
        if (now - lastRenderTime > RENDER_INTERVAL && !renderer.isRendering) {
            renderer.fetchAndRender(false).then(() => {
                transformX = 0;
                transformY = 0;
            }).catch(err => {
                logger.error('Background render failed:', err);
            });
            lastRenderTime = now;
        }

        lastX = e.clientX;
        lastY = e.clientY;
    };

    state._previewZoomHandlers.mouseup = () => {
        if (!isDragging) return;
        isDragging = false;
        container.classList.remove('panning');

        clearTimeout(renderer.qualityTimeout);

        const activeImg = renderer.getActiveImage();
        if (activeImg) {
            activeImg.style.transform = 'translate3d(0, 0, 0)';
        }
        transformX = 0;
        transformY = 0;

        renderer.fetchAndRender(false);

        if (hasMoved) {
            state._suppressNextClick = true;
            setTimeout(() => {
                state._suppressNextClick = false;
            }, 100);
        }
    };

    state._previewZoomHandlers.wheel = async (e) => {
        e.preventDefault();

        const resolutions = [1, 2, 4, 8];
        let currentIndex = resolutions.indexOf(renderer.resolution);
        const zoomDirection = e.deltaY > 0 ? 1 : -1;
        let nextIndex = currentIndex + zoomDirection;

        if (nextIndex < 0 || nextIndex >= resolutions.length) return;

        const nextRes = resolutions[nextIndex];

        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        await renderer.setResolutionAtPoint(nextRes, mouseX, mouseY);

        const previewStrideSelect = document.getElementById('previewStride');
        if (previewStrideSelect) {
            previewStrideSelect.value = nextRes;
        }
    };

    state._previewZoomHandlers.keydown = (e) => {
        const PAN_STEP = 50;
        let handled = false;

        switch(e.key) {
            case 'ArrowLeft':
                renderer.pan(-PAN_STEP, 0);
                handled = true;
                break;
            case 'ArrowRight':
                renderer.pan(PAN_STEP, 0);
                handled = true;
                break;
            case 'ArrowUp':
                renderer.pan(0, -PAN_STEP);
                handled = true;
                break;
            case 'ArrowDown':
                renderer.pan(0, PAN_STEP);
                handled = true;
                break;
        }

        if (handled) {
            e.preventDefault();
            renderer.fetchAndRender();
        }
    };

    container.addEventListener('mousedown', state._previewZoomHandlers.mousedown);
    document.addEventListener('mousemove', state._previewZoomHandlers.mousemove);
    document.addEventListener('mouseup', state._previewZoomHandlers.mouseup);
    container.addEventListener('wheel', state._previewZoomHandlers.wheel, { passive: false });
    document.addEventListener('keydown', state._previewZoomHandlers.keydown);

}

/**
 * Detach zoom event handlers
 */
function detachPreviewZoomHandlers() {
    const state = window.previewState;
    if (!state || !state._previewZoomHandlers) return;

    const container = document.getElementById('previewContainer');

    container.removeEventListener('mousedown', state._previewZoomHandlers.mousedown);
    document.removeEventListener('mousemove', state._previewZoomHandlers.mousemove);
    document.removeEventListener('mouseup', state._previewZoomHandlers.mouseup);
    container.removeEventListener('wheel', state._previewZoomHandlers.wheel);
    document.removeEventListener('keydown', state._previewZoomHandlers.keydown);

    delete state._previewZoomHandlers;
}

/**
 * Setup zoom preview dialog controls
 */
function setupZoomPreviewControls() {
    if (!pluginState.zoomPreviewState) {
        logger.error("Cannot setup zoom preview controls - state not initialized");
        return;
    }

    const { renderer, docWidth, docHeight } = pluginState.zoomPreviewState;

    const btnClose = document.getElementById('btnZoomClose');
    const zoomDialog = document.getElementById('zoomPreviewDialog');
    const zoomTileImg = document.getElementById('zoomTileImg');
    const zoomDownsampleFactor = document.getElementById('zoomDownsampleFactor');
    const viewportContainer = document.getElementById('zoomViewportContainer');

    const panStep = 100;

    if (zoomDownsampleFactor) {
        zoomDownsampleFactor.value = '1';

        zoomDownsampleFactor.addEventListener('change', async (e) => {
            const resolution = parseInt(e.target.value);

            if (viewportContainer) {
                viewportContainer.style.cursor = 'wait';
            }
            zoomDownsampleFactor.disabled = true;

            try {
                const centerX = renderer.width / 2;
                const centerY = renderer.height / 2;
                await renderer.setResolutionAtPoint(resolution, centerX, centerY);
            } finally {
                if (viewportContainer) {
                    viewportContainer.style.cursor = '';
                }
                zoomDownsampleFactor.disabled = false;
            }
        });

    }

    if (viewportContainer) {
        viewportContainer.addEventListener('wheel', async (e) => {
            e.preventDefault();

            const resolutions = [1, 2, 4, 8];
            let currentIndex = resolutions.indexOf(renderer.resolution);

            const zoomDirection = e.deltaY > 0 ? 1 : -1;
            let nextIndex = currentIndex + zoomDirection;

            if (nextIndex < 0 || nextIndex >= resolutions.length) return;

            const nextRes = resolutions[nextIndex];

            const rect = viewportContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            await renderer.setResolutionAtPoint(nextRes, mouseX, mouseY);

            if (zoomDownsampleFactor) {
                zoomDownsampleFactor.value = nextRes;
            }
        }, { passive: false });

    }

    if (viewportContainer) {
        let isDragging = false;
        let lastX = 0;
        let lastY = 0;

        viewportContainer.addEventListener('mousedown', (e) => {
            isDragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            viewportContainer.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const deltaX = lastX - e.clientX;
            const deltaY = lastY - e.clientY;

            if (Math.abs(deltaX) >= 5 || Math.abs(deltaY) >= 5) {
                renderer.pan(deltaX, deltaY);
                renderer.fetchAndRender();

                lastX = e.clientX;
                lastY = e.clientY;
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                viewportContainer.style.cursor = '';
            }
        });

    }

    document.addEventListener('keydown', (e) => {
        if (!zoomDialog || !zoomDialog.open) return;

        if (e.code === 'Home') {
            e.preventDefault();
            renderer.viewportX = (renderer.docWidth / renderer.resolution - renderer.width) / 2;
            renderer.viewportY = (renderer.docHeight / renderer.resolution - renderer.height) / 2;
            renderer.applyBounds();
            renderer.fetchAndRender();

        }
    });

    if (btnClose) {
        btnClose.addEventListener('click', () => {
            if (zoomDialog) {
                zoomDialog.close();
            }

            if (renderer) {
                renderer.clearCache();
            }
            pluginState.zoomPreviewState = null;

        });
    }

    document.addEventListener('keydown', async (e) => {
        if (!zoomDialog || !zoomDialog.open) return;

        if (e.code === 'ArrowRight' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            renderer.pan(panStep, 0);
            renderer.fetchAndRender();
        }

        if (e.code === 'ArrowLeft' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            renderer.pan(-panStep, 0);
            renderer.fetchAndRender();
        }

        if (e.code === 'ArrowDown' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            renderer.pan(0, panStep);
            renderer.fetchAndRender();
        }

        if (e.code === 'ArrowUp' && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            renderer.pan(0, -panStep);
            renderer.fetchAndRender();
        }

        if (e.code === 'Escape') {
            e.preventDefault();
            btnClose?.click();
        }
    });
}

module.exports = {
    rebuildPreviewStrideForMode,
    setPreviewMode,
    attachPreviewZoomHandlers,
    detachPreviewZoomHandlers,
    setupZoomPreviewControls
};
