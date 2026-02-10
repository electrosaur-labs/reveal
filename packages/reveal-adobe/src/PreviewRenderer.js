/**
 * PreviewRenderer - All preview rendering functions
 *
 * Reads: window.previewState, window.viewportManager, window.selectedPreview, window.cropEngine
 * Imports: PluginState, ColorUtils, MechanicalFilters
 */

const Reveal = require("@reveal/core");
const PosterizationEngine = Reveal.engines.PosterizationEngine;
const SeparationEngine = Reveal.engines.SeparationEngine;
const logger = Reveal.logger;
const jpeg = require("jpeg-js");

const pluginState = require('./PluginState');
const { bufferToBase64, buildRemapTable } = require('./ColorUtils');
const { applyShadowClamp, applyMinVolume, applySpeckleRescue } = require('./MechanicalFilters');
const PhotoshopAPI = require("./api/PhotoshopAPI");

/**
 * Convert pixel data to data URL for display
 * UXP canvas is limited - use optimized scanline drawing
 */
function pixelsToDataURL(pixels, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');

    for (let y = 0; y < height; y++) {
        let x = 0;
        while (x < width) {
            const idx = (y * width + x) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            const a = pixels[idx + 3] / 255;

            let runLength = 1;
            while (x + runLength < width) {
                const nextIdx = (y * width + (x + runLength)) * 4;
                if (pixels[nextIdx] === r &&
                    pixels[nextIdx + 1] === g &&
                    pixels[nextIdx + 2] === b &&
                    pixels[nextIdx + 3] === pixels[idx + 3]) {
                    runLength++;
                } else {
                    break;
                }
            }

            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
            ctx.fillRect(x, y, runLength, 1);

            x += runLength;
        }
    }

    const dataURL = canvas.toDataURL('image/png');
    return dataURL;
}

/**
 * Initialize preview state for PNG-encoded img display
 * @param {number} width - Image width (data dimensions)
 * @param {number} height - Image height (data dimensions)
 * @param {Array<string>} palette - Array of hex color strings
 * @param {Uint8Array} assignments - Pixel-to-color assignments
 * @returns {object|null} - Preview state object or null if failed
 */
function initializePreviewCanvas(width, height, palette, assignments) {
    const img = document.getElementById("previewImg");
    if (!img) {
        logger.error("Preview img element not found in DOM");
        return null;
    }

    window.previewState = {
        width: width,
        height: height,
        palette: palette,
        assignments: assignments,
        activeSoloIndex: null,
        deletedIndices: new Set(),

        viewMode: 'fit',
        zoomRenderer: null,
        _previewZoomHandlers: null,
        _suppressNextClick: false
    };

    const newImg = img.cloneNode(true);
    img.parentNode.replaceChild(newImg, img);

    newImg.addEventListener('click', () => {
        const state = window.previewState;
        if (!state) return;

        if (state._suppressNextClick) {
            state._suppressNextClick = false;
            return;
        }

        if (state.activeSoloIndex !== null) {
            state.activeSoloIndex = null;

            if (state.viewMode === 'fit') {
                renderPreview();
            } else if (state.viewMode === 'zoom' && state.zoomRenderer) {
                state.zoomRenderer.setSoloColor(null);
                state.zoomRenderer.fetchAndRender();
            }

            // Lazy require to avoid circular dependency
            const { updateSwatchHighlights } = require('./SwatchManager');
            updateSwatchHighlights();
        }
    });

    return window.previewState;
}

/**
 * Render preview to an img element using JPEG encoding.
 * UXP doesn't support canvas CSS scaling or toDataURL, so we:
 * 1. Build RGBA pixel data directly
 * 2. Encode to JPEG using pure-JS jpeg-js library
 * 3. Display in <img> which CSS CAN scale properly
 */
function renderPreview() {
    const state = window.previewState;
    if (!state) {
        logger.error('Preview state not initialized');
        return;
    }

    if (state.viewMode && state.viewMode !== 'fit') {
        logger.error(`renderPreview() called in ${state.viewMode} mode - BLOCKED! This would overwrite the viewport image.`);
        return;
    }

    const img = document.getElementById('previewImg');
    if (!img) {
        logger.error('Preview img element not found');
        return;
    }

    const assignments = state.assignments;
    const palette = state.palette;
    const activeSoloIndex = state.activeSoloIndex;
    const deletedIndices = state.deletedIndices;
    const width = state.width;
    const height = state.height;

    if (palette.length <= 3) {
        const counts = {};
        for (let i = 0; i < assignments.length; i++) {
            counts[assignments[i]] = (counts[assignments[i]] || 0) + 1;
        }
    }

    let remapTable = null;
    if (deletedIndices.size > 0) {
        remapTable = buildRemapTable(palette, deletedIndices);
    }

    const pixelData = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const colorIndex = assignments[idx];
            const pixelOffset = idx * 4;

            const isDeleted = deletedIndices.has(colorIndex);

            const isMatching = (activeSoloIndex === null || colorIndex === activeSoloIndex);

            let r, g, b;

            if (!isMatching) {
                const checkerSize = 8;
                const isLight = (Math.floor(x / checkerSize) + Math.floor(y / checkerSize)) % 2 === 0;
                r = g = b = isLight ? 128 : 96;
            } else {
                const effectiveColorIndex = (isDeleted && remapTable) ? remapTable[colorIndex] : colorIndex;
                let hexColor = palette[effectiveColorIndex];

                if (!hexColor || hexColor === 'undefined') {
                    hexColor = '#FF00FF';
                }

                r = parseInt(hexColor.substring(1, 3), 16);
                g = parseInt(hexColor.substring(3, 5), 16);
                b = parseInt(hexColor.substring(5, 7), 16);
            }

            pixelData[pixelOffset] = r;
            pixelData[pixelOffset + 1] = g;
            pixelData[pixelOffset + 2] = b;
            pixelData[pixelOffset + 3] = 255;
        }
    }

    const jpegData = jpeg.encode({
        data: pixelData,
        width: width,
        height: height
    }, 95);

    const base64 = bufferToBase64(jpegData.data);
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    img.src = dataUrl;

    img.dataset.naturalWidth = width;
    img.dataset.naturalHeight = height;

}

/**
 * Render Navigator Map thumbnail (Phase 2)
 * Shows compositional overview with red viewport rectangle
 */
function renderNavigatorMap() {

    if (!window.viewportManager) {
        logger.error('[Navigator] ViewportManager not initialized');
        return;
    }

    try {
        const navData = window.viewportManager.getNavigatorMap(160);

        if (!navData || !navData.thumbnailBuffer) {
            logger.error('[Navigator] No thumbnail data returned');
            return;
        }

        const img = document.getElementById('navigatorCanvas');
        if (!img) {
            logger.error('[Navigator] Image element not found');
            return;
        }

        const { thumbnailBuffer, thumbnailWidth, thumbnailHeight, viewportBounds } = navData;

        const jpegData = jpeg.encode({
            data: thumbnailBuffer,
            width: thumbnailWidth,
            height: thumbnailHeight
        }, 95);

        const base64 = bufferToBase64(jpegData.data);
        const dataUrl = `data:image/jpeg;base64,${base64}`;

        img.src = dataUrl;
        img.width = thumbnailWidth;
        img.height = thumbnailHeight;

        updateNavigatorViewport(viewportBounds);

    } catch (error) {
        logger.error('[Navigator] Failed to render:', error);
    }
}

/**
 * Update red viewport rectangle position on Navigator Map
 * @param {Object} bounds - Viewport bounds from CropEngine {x, y, width, height}
 */
function updateNavigatorViewport(bounds) {
    const viewportDiv = document.getElementById('navigatorViewport');
    const img = document.getElementById('navigatorCanvas');

    if (!viewportDiv) {
        logger.error('[Navigator] Viewport div not found');
        return;
    }

    if (!img) {
        logger.error('[Navigator] Canvas img not found');
        return;
    }

    if (!bounds) {
        logger.error('[Navigator] No bounds provided');
        return;
    }

    try {
        const container = img.parentElement;
        if (!container) {
            logger.error('[Navigator] Container not found');
            return;
        }

        const containerRect = container.getBoundingClientRect();
        const imgRect = img.getBoundingClientRect();

        const offsetX = imgRect.left - containerRect.left;
        const offsetY = imgRect.top - containerRect.top;

        viewportDiv.style.left = `${bounds.x + offsetX}px`;
        viewportDiv.style.top = `${bounds.y + offsetY}px`;
        viewportDiv.style.width = `${bounds.width}px`;
        viewportDiv.style.height = `${bounds.height}px`;

    } catch (error) {
        logger.error('[Navigator] Failed to update viewport rect:', error);
    }
}

/**
 * Render 1:1 pixel-perfect preview using on-demand high-res fetching (Option C: Smart Loading)
 * Fetches ONLY the viewport window at full resolution from Photoshop
 */
async function render1to1Preview() {
    if (!window.viewportManager || !window.cropEngine) {
        logger.error('[1:1] ViewportManager or CropEngine not initialized');
        return;
    }

    if (!pluginState.posterizationData) {
        logger.error('[1:1] No posterization data available');
        return;
    }

    try {
        const vmState = window.viewportManager.getState();
        const { center, viewportWidth, viewportHeight } = vmState;

        const docInfo = PhotoshopAPI.getDocumentInfo();
        const fullDocWidth = docInfo.width;
        const fullDocHeight = docInfo.height;

        const ceSourceW = window.cropEngine.sourceWidth;
        const ceSourceH = window.cropEngine.sourceHeight;
        const ceActualW = window.cropEngine.actualDocWidth;
        const ceActualH = window.cropEngine.actualDocHeight;

        const centerX = center.x * fullDocWidth;
        const centerY = center.y * fullDocHeight;
        const cropX = Math.max(0, Math.floor(centerX - viewportWidth / 2));
        const cropY = Math.max(0, Math.floor(centerY - viewportHeight / 2));

        const cropData = await PhotoshopAPI.getHighResCrop(cropX, cropY, viewportWidth, viewportHeight);

        if (!window.selectedPreview || !window.selectedPreview.paletteLab || !window.selectedPreview.palette) {
            logger.error('[1:1] No palette available in window.selectedPreview');
            return;
        }

        const labPalette = window.selectedPreview.paletteLab;
        const rgbPalette = window.selectedPreview.palette;

        const usedMetric = pluginState.posterizationData.params.distanceMetric || 'cie76';

        let colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            cropData.pixels,
            labPalette,
            null,
            cropData.width,
            cropData.height,
            {
                distanceMetric: usedMetric
            }
        );

        window._cachedCropData = {
            unfilteredIndices: new Uint8Array(colorIndices),
            width: cropData.width,
            height: cropData.height,
            labPalette: labPalette,
            rgbPalette: rgbPalette
        };

        const minVolume = parseFloat(document.getElementById('minVolume')?.value ?? 0);
        const speckleRescue = parseInt(document.getElementById('speckleRescue')?.value ?? 0);
        const shadowClamp = parseFloat(document.getElementById('shadowClamp')?.value ?? 0);

        if (shadowClamp > 0 || minVolume > 0 || speckleRescue > 0) {

            if (shadowClamp > 0) {
                colorIndices = applyShadowClamp(colorIndices, labPalette.length, shadowClamp);
            }
            if (minVolume > 0) {
                colorIndices = applyMinVolume(colorIndices, labPalette, minVolume);
            }
            if (speckleRescue > 0) {
                colorIndices = applySpeckleRescue(colorIndices, cropData.width, cropData.height, speckleRescue);
            }

        }

        const soloColorIndex = window.previewState?.activeSoloIndex;
        const hasSubstrate = window.selectedPreview?.substrateIndex !== null && window.selectedPreview?.substrateIndex !== undefined;
        const substrateIndex = window.selectedPreview?.substrateIndex;

        const previewBuffer = new Uint8ClampedArray(cropData.width * cropData.height * 4);
        for (let i = 0; i < colorIndices.length; i++) {
            const colorIdx = colorIndices[i];
            const idx = i * 4;

            if (colorIdx < 0 || colorIdx >= rgbPalette.length) {
                logger.error(`[1:1] Invalid color index ${colorIdx}, palette size ${rgbPalette.length}`);
                previewBuffer[idx] = 128;
                previewBuffer[idx + 1] = 128;
                previewBuffer[idx + 2] = 128;
                previewBuffer[idx + 3] = 255;
                continue;
            }

            if (soloColorIndex !== null && soloColorIndex !== undefined && colorIdx !== soloColorIndex) {
                if (hasSubstrate && substrateIndex >= 0 && substrateIndex < rgbPalette.length) {
                    const substrateColor = rgbPalette[substrateIndex];
                    if (substrateColor) {
                        previewBuffer[idx] = substrateColor.r;
                        previewBuffer[idx + 1] = substrateColor.g;
                        previewBuffer[idx + 2] = substrateColor.b;
                        previewBuffer[idx + 3] = 255;
                    } else {
                        previewBuffer[idx] = 200;
                        previewBuffer[idx + 1] = 200;
                        previewBuffer[idx + 2] = 200;
                        previewBuffer[idx + 3] = 128;
                    }
                } else {
                    previewBuffer[idx] = 200;
                    previewBuffer[idx + 1] = 200;
                    previewBuffer[idx + 2] = 200;
                    previewBuffer[idx + 3] = 128;
                }
            } else {
                const color = rgbPalette[colorIdx];
                if (color) {
                    previewBuffer[idx] = color.r;
                    previewBuffer[idx + 1] = color.g;
                    previewBuffer[idx + 2] = color.b;
                    previewBuffer[idx + 3] = 255;
                } else {
                    logger.error(`[1:1] RGB color undefined at index ${colorIdx}`);
                    previewBuffer[idx] = 255;
                    previewBuffer[idx + 1] = 0;
                    previewBuffer[idx + 2] = 255;
                    previewBuffer[idx + 3] = 255;
                }
            }
        }

        const img = document.getElementById('previewImg');
        if (!img) {
            logger.error('[1:1] Preview img element not found');
            return;
        }

        const jpegData = jpeg.encode({
            data: previewBuffer,
            width: cropData.width,
            height: cropData.height
        }, 95);

        const base64 = bufferToBase64(jpegData.data);
        const dataUrl = `data:image/jpeg;base64,${base64}`;

        img.src = dataUrl;
        img.width = cropData.width;
        img.height = cropData.height;

    } catch (error) {
        logger.error('[1:1] Failed to render:', error);
        logger.error('[1:1] Error stack:', error.stack);
    }
}

/**
 * Fast re-render of 1:1 crop with updated mechanical filters.
 * Uses cached unfiltered crop data - no PS fetch, no re-separation.
 * Target: <10ms for real-time slider scrubbing.
 */
function renderCropWithFilters() {
    const cached = window._cachedCropData;
    if (!cached) return;

    const { unfilteredIndices, width, height, labPalette, rgbPalette } = cached;

    const minVolume = parseFloat(document.getElementById('minVolume')?.value ?? 0);
    const speckleRescue = parseInt(document.getElementById('speckleRescue')?.value ?? 0);
    const shadowClamp = parseFloat(document.getElementById('shadowClamp')?.value ?? 0);

    let colorIndices = unfilteredIndices;

    if (shadowClamp > 0) {
        colorIndices = applyShadowClamp(colorIndices, labPalette.length, shadowClamp);
    }
    if (minVolume > 0) {
        colorIndices = applyMinVolume(colorIndices, labPalette, minVolume);
    }
    if (speckleRescue > 0) {
        colorIndices = applySpeckleRescue(colorIndices, width, height, speckleRescue);
    }

    const soloColorIndex = window.previewState?.activeSoloIndex;
    const hasSubstrate = window.selectedPreview?.substrateIndex !== null && window.selectedPreview?.substrateIndex !== undefined;
    const substrateIndex = window.selectedPreview?.substrateIndex;

    const previewBuffer = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < colorIndices.length; i++) {
        const colorIdx = colorIndices[i];
        const idx = i * 4;

        if (colorIdx < 0 || colorIdx >= rgbPalette.length) {
            previewBuffer[idx] = 128;
            previewBuffer[idx + 1] = 128;
            previewBuffer[idx + 2] = 128;
            previewBuffer[idx + 3] = 255;
            continue;
        }

        if (soloColorIndex !== null && soloColorIndex !== undefined && colorIdx !== soloColorIndex) {
            if (hasSubstrate && substrateIndex >= 0 && substrateIndex < rgbPalette.length) {
                const sc = rgbPalette[substrateIndex];
                previewBuffer[idx] = sc ? sc.r : 200;
                previewBuffer[idx + 1] = sc ? sc.g : 200;
                previewBuffer[idx + 2] = sc ? sc.b : 200;
                previewBuffer[idx + 3] = 255;
            } else {
                previewBuffer[idx] = 200;
                previewBuffer[idx + 1] = 200;
                previewBuffer[idx + 2] = 200;
                previewBuffer[idx + 3] = 128;
            }
        } else {
            const color = rgbPalette[colorIdx];
            if (color) {
                previewBuffer[idx] = color.r;
                previewBuffer[idx + 1] = color.g;
                previewBuffer[idx + 2] = color.b;
                previewBuffer[idx + 3] = 255;
            } else {
                previewBuffer[idx] = 255;
                previewBuffer[idx + 1] = 0;
                previewBuffer[idx + 2] = 255;
                previewBuffer[idx + 3] = 255;
            }
        }
    }

    const img = document.getElementById('previewImg');
    if (!img) return;

    const jpegData = jpeg.encode({ data: previewBuffer, width, height }, 95);
    const base64 = bufferToBase64(jpegData.data);
    img.src = `data:image/jpeg;base64,${base64}`;
}

module.exports = {
    pixelsToDataURL,
    initializePreviewCanvas,
    renderPreview,
    renderNavigatorMap,
    updateNavigatorViewport,
    render1to1Preview,
    renderCropWithFilters
};
