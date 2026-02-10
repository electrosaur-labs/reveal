/**
 * Reveal - Screen Printing Color Separation Plugin
 *
 * Main entry point for the plugin.
 * Phase 2.5: Posterization engine & preview UI
 */

const { entrypoints } = require("uxp");
const { core, action, imaging, app } = require("photoshop");

// Import @reveal/core engines
const Reveal = require("@reveal/core");
const PosterizationEngine = Reveal.engines.PosterizationEngine;

// Pure JS JPEG encoder for preview
// (UXP doesn't support canvas.toDataURL, so we encode manually)
const jpeg = require("jpeg-js");
const SeparationEngine = Reveal.engines.SeparationEngine;
const ImageHeuristicAnalyzer = Reveal.engines.ImageHeuristicAnalyzer;
const ParameterGenerator = require("@reveal/core/lib/analysis/ParameterGenerator");
const BilateralFilter = require("@reveal/core/lib/preprocessing/BilateralFilter");
const logger = Reveal.logger;

// Photoshop-specific API (stays in reveal-adobe)
const PhotoshopAPI = require("./api/PhotoshopAPI");
const DNAGenerator = require("./DNAGenerator");

// 1:1 Viewport components for mechanical knobs
const CropEngine = require('../../reveal-core/lib/engines/CropEngine');
const { SessionState } = require('./SessionState');
const ViewportManager = require('./ViewportManager');

// Zoom preview components
const ZoomPreviewRenderer = require("./api/ZoomPreviewRenderer");

// Test utilities
const { testTransparencySelection } = require("./test-16bit-transparency-selection");

// GoldenStatsCapture is Photoshop-specific (if it exists)
let GoldenStatsCapture = null;
try {
    GoldenStatsCapture = require("./core/GoldenStatsCapture");
} catch (e) {
    // GoldenStatsCapture may not exist in this package
}

/**
 * Initialize the plugin
 */
function initPlugin() {
}

// Store posterization results for preview
let posterizationData = null;

/**
 * Last image DNA analysis result (used for "Smart Reveal" auto mode)
 * Stores { maxC, l_std_dev, c, k, minL, maxL, archetype } from analysis
 */
let lastImageDNA = null;
let lastGeneratedConfig = null;  // Complete config from ParameterGenerator (includes all parameters)
let lastSelectedArchetypeId = null;  // Manually selected archetype ID (bypasses DNA matching)

/**
 * Zoom preview state (tile managers, viewport tracker, renderer)
 * Initialized when zoom preview dialog is opened
 */
let zoomPreviewState = null;

/**
 * Resolve "auto" distance metric to actual metric using DNA-based rule
 * Rule: (peakChroma > 80 OR isPhotographic) → 'cie94', else 'cie76'
 * Note: CIE2000 is never auto-selected; it's a manual "Museum Grade" choice
 *
 * @param {string} metricSetting - 'auto', 'cie76', 'cie94', or 'cie2000'
 * @param {Object} dna - Image DNA with maxC and archetype (optional)
 * @returns {string} - Resolved metric: 'cie76', 'cie94', or 'cie2000'
 */
function resolveDistanceMetric(metricSetting, dna = null) {
    // If not auto, return as-is (including cie2000 which is manual-only)
    if (metricSetting !== 'auto') {
        return metricSetting;
    }

    // Use provided DNA or fall back to last analyzed DNA
    const useDNA = dna || lastImageDNA;

    if (useDNA) {
        const peakChroma = useDNA.maxC || 0;
        const isPhotographic = useDNA.archetype === 'Photographic';
        const resolved = (peakChroma > 80 || isPhotographic) ? 'cie94' : 'cie76';
        return resolved;
    }

    // No DNA available - default to cie94 (safer for unknown images)
    return 'cie94';
}

/**
 * Show custom error dialog (more readable than alert)
 */
function showError(title, message, errorList = null) {
    const errorDialog = document.getElementById('errorDialog');
    const errorTitle = document.getElementById('errorTitle');
    const errorMessage = document.getElementById('errorMessage');
    const errorDetails = document.getElementById('errorDetails');
    const errorListEl = document.getElementById('errorList');

    if (!errorDialog) {
        logger.error("Error dialog not found!");
        alert(`${title}: ${message}`);
        return;
    }

    if (errorTitle) errorTitle.textContent = title;
    if (errorMessage) errorMessage.textContent = message;

    // Show error list if provided
    if (errorList && errorList.length > 0 && errorListEl) {
        errorListEl.innerHTML = '';
        errorList.forEach(err => {
            const li = document.createElement('li');
            li.textContent = err;
            li.style.marginBottom = '8px';
            errorListEl.appendChild(li);
        });
        errorListEl.style.display = 'block';
        if (errorDetails) errorDetails.style.display = 'none';
    } else {
        if (errorListEl) errorListEl.style.display = 'none';
        if (errorDetails) errorDetails.style.display = 'none';
    }

    // Show error dialog as modal
    errorDialog.showModal();

    // Set up OK button to close
    const btnErrorOk = document.getElementById('btnErrorOk');
    if (btnErrorOk) {
        btnErrorOk.onclick = () => {
            errorDialog.close();
        };
    }
}

/**
 * Show error dialog with custom styling
 *
 * @param {string} title - Error title
 * @param {string} message - Error message
 * @param {string} details - Optional details (e.g., error code)
 */
function showErrorDialog(title, message, details = null) {
    const errorDialog = document.getElementById('errorDialog');
    const errorTitle = document.getElementById('errorTitle');
    const errorMessage = document.getElementById('errorMessage');
    const errorDetails = document.getElementById('errorDetails');
    const errorListEl = document.getElementById('errorList');

    if (!errorDialog) {
        logger.error('Error dialog element not found, falling back to alert');
        alert(`${title}\n\n${message}${details ? '\n\n' + details : ''}`);
        return;
    }

    // Set content
    errorTitle.textContent = title;
    errorMessage.textContent = message;

    // Hide error list
    if (errorListEl) errorListEl.style.display = 'none';

    // Show/hide details section
    if (details) {
        errorDetails.textContent = details;
        errorDetails.style.display = 'block';
    } else {
        errorDetails.style.display = 'none';
    }

    // Show dialog as modal
    errorDialog.showModal();

    // Set up OK button handler
    const btnOk = document.getElementById('btnErrorOk');
    const closeHandler = () => {
        errorDialog.close();
        btnOk.removeEventListener('click', closeHandler);
    };
    btnOk.addEventListener('click', closeHandler);
}

/**
 * Show success dialog after separation completes
 *
 * @param {number} layerCount - Number of layers created
 * @param {Object} palette - Palette used for separation {hexColors: [...]}
 * @param {number} separationStartTime - Timestamp when separation started
 */
function showSuccessDialog(layerCount, palette, separationStartTime) {
    try {
        const successDialog = document.getElementById('successDialog');

        if (!successDialog) {
            logger.error('Success dialog element not found!');
            alert(`Separation complete! Created ${layerCount} layers.\n\nSuccess dialog not available - check console for errors.`);
            return;
        }

        const layerCountEl = document.getElementById('layerCount');
        const btnDone = document.getElementById('btnSuccessDone');
        const btnCaptureStats = document.getElementById('btnCaptureGoldenStats');
        const captureStatus = document.getElementById('captureStatus');

        if (!layerCountEl || !btnDone || !btnCaptureStats || !captureStatus) {
            logger.error('Missing required elements!');
            alert(`Separation complete! Created ${layerCount} layers.`);
            return;
        }

        layerCountEl.textContent = layerCount;
        captureStatus.textContent = '';

        // Show dialog using UXP dialog.showModal()
        // Close first if already open to avoid "already open" error
        if (successDialog.open) {
            successDialog.close();
        }
        successDialog.showModal();

        // Done button - close dialog properly
        btnDone.onclick = () => {
            successDialog.close();
        };

        // Capture Golden Stats button
        btnCaptureStats.onclick = async () => {
        try {
            btnCaptureStats.disabled = true;
            btnCaptureStats.textContent = 'Capturing Statistics...';
            captureStatus.textContent = 'Analyzing separated layers...';

            // Calculate processing time
            const processingTimeMs = Date.now() - separationStartTime;

            // Get document name for fixture identification
            const doc = PhotoshopAPI.getActiveDocument();
            const fixtureName = doc ? doc.name : 'unknown.png';

            // Convert hex colors to palette format expected by GoldenStatsCapture
            // Layer names match the format used by SeparationEngine: "Color 1 - #RRGGBB"
            const paletteData = palette.hexColors.map((hex, index) => {
                // Convert hex to RGB
                const r = parseInt(hex.substring(1, 3), 16);
                const g = parseInt(hex.substring(3, 5), 16);
                const b = parseInt(hex.substring(5, 7), 16);

                // Use same naming convention as SeparationEngine
                const layerName = `Color ${index + 1} - ${hex.toUpperCase()}`;

                return {
                    name: layerName,
                    hex: hex,
                    rgb: [r, g, b]
                };
            });

            // Capture statistics
            const stats = await GoldenStatsCapture.captureStats({
                fixtureName: fixtureName,
                palette: paletteData,
                processingTimeMs: processingTimeMs
            });

            captureStatus.textContent = 'Writing to console...';

            // Write to console (simplest method - no permissions needed)
            const suggestedFilename = fixtureName.replace('.png', '-golden.json').replace('.psd', '-golden.json');
            const json = GoldenStatsCapture.exportToJSON(stats);

            captureStatus.innerHTML = `✓ JSON written to console!<br>Save as: ${suggestedFilename}`;
            captureStatus.style.color = '#2d9d78';
            captureStatus.style.fontWeight = '500';
            captureStatus.style.lineHeight = '1.4';

            btnCaptureStats.textContent = 'Capture Again';
            btnCaptureStats.disabled = false;

        } catch (error) {
            logger.error('Error capturing golden stats:', error);
            captureStatus.textContent = `Error: ${error.message}`;
            captureStatus.style.color = '#d7373f';

            btnCaptureStats.textContent = 'Retry Capture';
            btnCaptureStats.disabled = false;
        }
    };

    } catch (error) {
        logger.error('Error in showSuccessDialog:', error);
        alert(`Separation complete! Created ${layerCount} layers.\n\nError showing success dialog: ${error.message}`);
    }
}

/**
 * Convert pixel data to data URL for display
 * UXP canvas is limited - use optimized scanline drawing
 */
function pixelsToDataURL(pixels, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');

    // Optimized: Draw scanlines (horizontal runs of same color)
    for (let y = 0; y < height; y++) {
        let x = 0;
        while (x < width) {
            const idx = (y * width + x) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];
            const a = pixels[idx + 3] / 255;

            // Find run length of same color
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

            // Draw horizontal run
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
            ctx.fillRect(x, y, runLength, 1);

            x += runLength;
        }
    }

    const dataURL = canvas.toDataURL('image/png');
    return dataURL;
}

/**
 * Validate hex color string
 * @param {string} hex - Hex color string (with or without #)
 * @returns {boolean} - True if valid hex color
 */
function isValidHex(hex) {
    // Remove # if present
    hex = hex.replace('#', '');
    // Check if 6 valid hex characters
    return /^[0-9A-Fa-f]{6}$/.test(hex);
}

/**
 * Convert hex color to RGB (0-255)
 * @param {string} hex - Hex color string (#RRGGBB or RRGGBB)
 * @returns {Object} - {r, g, b} values 0-255
 */
function hexToRgb(hex) {
    hex = hex.replace('#', '');
    return {
        r: parseInt(hex.substring(0, 2), 16),
        g: parseInt(hex.substring(2, 4), 16),
        b: parseInt(hex.substring(4, 6), 16)
    };
}

/**
 * Build remap table for soft-deleted colors
 * Maps each deleted color index to nearest surviving color index
 * Uses perceptual Lab distance for nearest neighbor search
 * @param {Array<string>} hexColors - Hex color palette (#RRGGBB)
 * @param {Set<number>} deletedIndices - Indices of deleted colors
 * @returns {Uint8Array} - Lookup table: oldIndex → newIndex
 */
function buildRemapTable(hexColors, deletedIndices) {
    const remapTable = new Uint8Array(hexColors.length);

    // Build list of surviving colors with their Lab values
    const survivorIndices = [];
    const survivorLabColors = [];

    for (let i = 0; i < hexColors.length; i++) {
        if (!deletedIndices.has(i)) {
            survivorIndices.push(i);
            // Convert hex → RGB → Lab
            const rgb = hexToRgb(hexColors[i]);
            const lab = PosterizationEngine.rgbToLab(rgb);
            survivorLabColors.push(lab);
        }
    }

    // For each color (deleted or not), find nearest survivor
    for (let i = 0; i < hexColors.length; i++) {
        if (deletedIndices.has(i)) {
            // Deleted color: find nearest survivor
            const rgb = hexToRgb(hexColors[i]);
            const lab = PosterizationEngine.rgbToLab(rgb);

            let nearestIndex = survivorIndices[0];
            let minDistance = Infinity;

            for (let j = 0; j < survivorLabColors.length; j++) {
                const distance = PosterizationEngine._labDistance(
                    lab,
                    survivorLabColors[j]
                );
                if (distance < minDistance) {
                    minDistance = distance;
                    nearestIndex = survivorIndices[j];
                }
            }

            remapTable[i] = nearestIndex;
        } else {
            // Survivor: maps to itself
            remapTable[i] = i;
        }
    }

    return remapTable;
}

/**
 * Convert RGB float values (0-1) to hex string
 * Photoshop Color Picker returns RGB as floats 0-1
 * @param {Object} rgbFloat - {red, grain/green, blue} values 0-1
 * @returns {string} - Hex color string #RRGGBB
 */
function rgbFloatToHex(rgbFloat) {
    // Note: PS Color Picker returns "grain" instead of "green" in some versions
    const r = Math.round((rgbFloat.red || 0) * 255);
    const g = Math.round((rgbFloat.grain || rgbFloat.green || 0) * 255);
    const b = Math.round((rgbFloat.blue || 0) * 255);

    return '#' +
        r.toString(16).padStart(2, '0').toUpperCase() +
        g.toString(16).padStart(2, '0').toUpperCase() +
        b.toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Show Photoshop's native Color Picker dialog
 * Returns selected color or null if cancelled
 *
 * @param {Object} initialColor - {r, g, b} values 0-255
 * @returns {Promise<Object|null>} - RGB object {red, green, blue} 0-255, or null if cancelled
 */
async function showPhotoshopColorPicker(initialColor = { r: 255, g: 255, b: 255 }) {
    const { core, action, app } = require("photoshop");

    let result = null;

    try {
        await core.executeAsModal(async () => {
            // Step 1: Set foreground color to initial color
            await action.batchPlay([{
                _obj: "set",
                _target: [{ _ref: "color", _property: "foregroundColor" }],
                to: {
                    _obj: "RGBColor",
                    red: initialColor.r,
                    grain: initialColor.g,  // Note: "grain" not "green"
                    blue: initialColor.b
                }
            }], {});


            // Step 2: Show color picker (uses foreground color as initial color)
            const response = await action.batchPlay([{
                _obj: "showColorPicker"
            }], {});


            // Step 3: Read the new foreground color after picker closes
            // If user clicked OK, foreground color will be updated
            // If user cancelled, this will throw an error
            if (response && response.length > 0 && response[0]._obj !== "cancel") {
                const newColor = app.foregroundColor;
                result = {
                    red: Math.round(newColor.rgb.red),
                    green: Math.round(newColor.rgb.green),
                    blue: Math.round(newColor.rgb.blue)
                };
            }
        }, { commandName: "Show Color Picker" });
    } catch (error) {
        logger.error("Color picker error:", error);
        // User likely cancelled - return null
        return null;
    }

    return result;
}

/**
 * Convert RGB (0-255) to hex string
 * @param {number} r - Red 0-255
 * @param {number} g - Green 0-255
 * @param {number} b - Blue 0-255
 * @returns {string} - Hex color string #RRGGBB
 */
function rgbToHex(r, g, b) {
    return '#' +
        Math.round(r).toString(16).padStart(2, '0').toUpperCase() +
        Math.round(g).toString(16).padStart(2, '0').toUpperCase() +
        Math.round(b).toString(16).padStart(2, '0').toUpperCase();
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

    // Store preview state globally
    window.previewState = {
        width: width,
        height: height,
        palette: palette,
        assignments: assignments,
        activeSoloIndex: null,  // null = show all, number = solo that color
        deletedIndices: new Set(),  // Track soft-deleted color indices

        // View mode state (fit vs zoom)
        viewMode: 'fit',
        zoomRenderer: null,
        _previewZoomHandlers: null,
        _suppressNextClick: false  // Prevent click after drag
    };

    // Add click handler to preview image - clicking shows all colors
    // Remove any existing handler first to prevent duplicates
    const newImg = img.cloneNode(true);
    img.parentNode.replaceChild(newImg, img);

    newImg.addEventListener('click', () => {
        const state = window.previewState;
        if (!state) return;

        // Suppress click if it was actually a drag gesture
        if (state._suppressNextClick) {
            state._suppressNextClick = false;
            return;
        }

        if (state.activeSoloIndex !== null) {
            state.activeSoloIndex = null;

            // Re-render in both modes
            if (state.viewMode === 'fit') {
                renderPreview();
            } else if (state.viewMode === 'zoom' && state.zoomRenderer) {
                state.zoomRenderer.setSoloColor(null);
                state.zoomRenderer.fetchAndRender();
            }

            // Update visual highlighting
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

    // MODE GUARD: renderPreview() is for fit mode only!
    // Calling it in 1:1 or zoom mode overwrites the viewport-specific image
    if (state.viewMode && state.viewMode !== 'fit') {
        logger.error(`⚠️ renderPreview() called in ${state.viewMode} mode - BLOCKED! This would overwrite the viewport image.`);
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


    // Debug: Check assignment distribution for 2-color images
    if (palette.length <= 3) {
        const counts = {};
        for (let i = 0; i < assignments.length; i++) {
            counts[assignments[i]] = (counts[assignments[i]] || 0) + 1;
        }
    }

    // Build remap table for deleted colors (maps to nearest surviving color)
    let remapTable = null;
    if (deletedIndices.size > 0) {
        remapTable = buildRemapTable(palette, deletedIndices);
    }

    // Build RGBA pixel array
    const pixelData = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const colorIndex = assignments[idx];
            const pixelOffset = idx * 4;

            // Check if this color is deleted
            const isDeleted = deletedIndices.has(colorIndex);

            // In solo mode: show selected color normally, others get checkered background
            const isMatching = (activeSoloIndex === null || colorIndex === activeSoloIndex);

            let r, g, b;

            if (!isMatching) {
                // Solo mode: non-matching pixels get checkered background
                const checkerSize = 8;
                const isLight = (Math.floor(x / checkerSize) + Math.floor(y / checkerSize)) % 2 === 0;
                r = g = b = isLight ? 128 : 96; // Mid-gray checker
            } else {
                // Remap deleted colors to nearest surviving color
                const effectiveColorIndex = (isDeleted && remapTable) ? remapTable[colorIndex] : colorIndex;
                let hexColor = palette[effectiveColorIndex];

                // DEFENSIVE: Handle undefined palette entries
                if (!hexColor || hexColor === 'undefined') {
                    hexColor = '#FF00FF'; // Magenta to highlight the issue
                }

                // Convert hex to RGB
                r = parseInt(hexColor.substring(1, 3), 16);
                g = parseInt(hexColor.substring(3, 5), 16);
                b = parseInt(hexColor.substring(5, 7), 16);
            }

            pixelData[pixelOffset] = r;
            pixelData[pixelOffset + 1] = g;
            pixelData[pixelOffset + 2] = b;
            pixelData[pixelOffset + 3] = 255; // Alpha
        }
    }

    // Encode to JPEG using pure-JS encoder
    const jpegData = jpeg.encode({
        data: pixelData,
        width: width,
        height: height
    }, 95);

    // Convert to base64 data URL
    const base64 = bufferToBase64(jpegData.data);
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    // Set image source
    img.src = dataUrl;

    // Store dimensions for click coordinate mapping
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
        // Get thumbnail data from ViewportManager
        const navData = window.viewportManager.getNavigatorMap(160); // 160px thumbnail

        if (!navData || !navData.thumbnailBuffer) {
            logger.error('[Navigator] No thumbnail data returned');
            return;
        }

        // Get img element (now using img instead of canvas for UXP compatibility)
        const img = document.getElementById('navigatorCanvas');
        if (!img) {
            logger.error('[Navigator] Image element not found');
            return;
        }

        const { thumbnailBuffer, thumbnailWidth, thumbnailHeight, viewportBounds } = navData;

        // Encode to JPEG using jpeg-js (UXP doesn't support ImageData constructor)
        const jpegData = jpeg.encode({
            data: thumbnailBuffer,
            width: thumbnailWidth,
            height: thumbnailHeight
        }, 95);

        // Convert to base64 data URL
        const base64 = bufferToBase64(jpegData.data);
        const dataUrl = `data:image/jpeg;base64,${base64}`;

        // Set image source and actual dimensions
        img.src = dataUrl;
        img.width = thumbnailWidth;
        img.height = thumbnailHeight;


        // Update viewport rectangle using bounds from CropEngine
        updateNavigatorViewport(viewportBounds);

    } catch (error) {
        logger.error('[Navigator] Failed to render:', error);
    }
}

/**
 * Handle arrow key navigation for viewport panning (Phase 4+)
 * Arrow keys pan viewport by 10% of viewport size
 */
function attachArrowKeyNavigation() {
    // Remove existing listener if any
    document.removeEventListener('keydown', window._arrowKeyHandler);

    const handler = async (e) => {
        // Only handle arrow keys when in 1:1 mode
        if (!window.previewState || window.previewState.viewMode !== '1:1') {
            return;
        }

        if (!window.viewportManager) {
            return;
        }

        // Check if focused on an input/textarea
        const activeElement = document.activeElement;
        if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
            return;
        }

        const vmState = window.viewportManager.getState();
        const panAmount = 50; // pixels to pan

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

            // Re-render Navigator and preview
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
        logger.error('[Navigator] ❌ Elements not found');
        return;
    }

    // Drag state (stored globally)
    if (!window._navigatorDragState) {
        window._navigatorDragState = {
            isDragging: false,
            hasDragged: false,
            rafPending: false  // For debouncing 1:1 renders
        };
    }
    const dragState = window._navigatorDragState;

    // Remove old handlers if they exist
    if (window._navigatorHandlers) {
        const old = window._navigatorHandlers;
        navigatorContainer.removeEventListener('pointerdown', old.pointerdown);
        navigatorContainer.removeEventListener('pointermove', old.pointermove);
        navigatorContainer.removeEventListener('pointerup', old.pointerup);
        navigatorContainer.removeEventListener('pointercancel', old.pointercancel);
        navigatorContainer.removeEventListener('click', old.click);
    }

    // ARCHITECT'S FIX: Attach pointerdown to img (not red rect - it has pointer-events: none)
    const pointerdownHandler = (e) => {
        if (!window.viewportManager) return;

        // Only start drag if clicking on the img
        if (e.target !== img) return;

        dragState.isDragging = true;
        dragState.hasDragged = false;

        navigatorContainer.style.cursor = 'grabbing';
        e.preventDefault();

    };

    // ARCHITECT'S FIX: Center-Drag logic with accurate coordinate math
    const pointermoveHandler = (e) => {
        if (!dragState.isDragging || !window.viewportManager) return;

        dragState.hasDragged = true;

        // Calculate click relative to ACTUAL img element (flexbox centers it in container)
        const imgRect = img.getBoundingClientRect();

        // Get click position relative to img
        const clickX = e.clientX - imgRect.left;
        const clickY = e.clientY - imgRect.top;

        // BOUNDS CHECK: Constrain to visible image area
        const constrainedX = Math.max(0, Math.min(imgRect.width, clickX));
        const constrainedY = Math.max(0, Math.min(imgRect.height, clickY));

        // Map to normalized coordinates (0.0 - 1.0)
        const normX = constrainedX / imgRect.width;
        const normY = constrainedY / imgRect.height;

        // Update viewport center to follow mouse (this syncs CropEngine via _syncCropEngineViewport)
        window.viewportManager.jumpToNormalized(normX, normY);

        // PERFORMANCE FIX: During drag, only update red rect position (not entire thumbnail)
        // Get viewport bounds and update red rect directly - this is fast and synchronous
        const navData = window.viewportManager.getNavigatorMap(160);
        if (navData && navData.viewportBounds) {
            updateNavigatorViewport(navData.viewportBounds);
        }

        // ARCHITECT'S FIX: Debounce 1:1 render using requestAnimationFrame for smoothness
        // getLoupeBuffer is called INSIDE render1to1Preview, not here
        if (!dragState.rafPending) {
            dragState.rafPending = true;
            requestAnimationFrame(async () => {
                await render1to1Preview();
                dragState.rafPending = false;
            });
        }
    };

    // Pointer up - stop dragging
    const pointerupHandler = async () => {
        if (dragState.isDragging) {
            dragState.isDragging = false;
            navigatorContainer.style.cursor = '';

            // Full Navigator refresh after drag completes
            // jumpToNormalized already synced CropEngine coordinates via _syncCropEngineViewport
            renderNavigatorMap();

            // CRITICAL: Final render at latest center position
            await render1to1Preview();

        }
    };

    // ARCHITECT'S FIX: Click handler with accurate coordinate math
    const clickHandler = async (e) => {
        if (!window.viewportManager) return;

        // Don't handle click if we just dragged
        if (dragState.hasDragged) {
            dragState.hasDragged = false;
            return;
        }

        // Only handle clicks on the img
        if (e.target !== img) return;

        // Calculate click relative to ACTUAL img element (flexbox centers it in container)
        const imgRect = img.getBoundingClientRect();

        // Get click position relative to img
        const clickX = e.clientX - imgRect.left;
        const clickY = e.clientY - imgRect.top;

        // BOUNDS CHECK: Constrain to visible image area
        const constrainedX = Math.max(0, Math.min(imgRect.width, clickX));
        const constrainedY = Math.max(0, Math.min(imgRect.height, clickY));

        // Map to normalized coordinates (0.0 - 1.0)
        const normX = constrainedX / imgRect.width;
        const normY = constrainedY / imgRect.height;


        // Update viewport center (this syncs CropEngine via _syncCropEngineViewport)
        window.viewportManager.jumpToNormalized(normX, normY);

        // Sync UI - jumpToNormalized already synced coordinates
        renderNavigatorMap();
        await render1to1Preview();
    };

    // Attach handlers to container/img (NOT viewport rect - it has pointer-events: none)
    img.addEventListener('pointerdown', pointerdownHandler);
    navigatorContainer.addEventListener('pointermove', pointermoveHandler);
    navigatorContainer.addEventListener('pointerup', pointerupHandler);
    navigatorContainer.addEventListener('pointercancel', pointerupHandler);
    navigatorContainer.addEventListener('click', clickHandler);

    // Store handlers for cleanup
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

    // Remove old handler if it exists
    if (window._previewClickHandler) {
        previewImg.removeEventListener('click', window._previewClickHandler);
    }

    // Click handler to deselect swatches
    const clickHandler = async () => {
        const state = window.previewState;
        if (!state || state.viewMode !== '1:1') return;

        // Only deselect if something is currently selected
        if (state.activeSoloIndex === null || state.activeSoloIndex === undefined) {
            return;
        }


        // Clear selection
        state.activeSoloIndex = null;
        updateSwatchHighlights();

        // Re-render preview to show all colors
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

    // Remove old handlers if they exist
    if (window._1to1DragHandlers) {
        const old = window._1to1DragHandlers;
        previewContainer.removeEventListener('pointerdown', old.pointerdown);
        previewContainer.removeEventListener('pointermove', old.pointermove);
        previewContainer.removeEventListener('pointerup', old.pointerup);
        previewContainer.removeEventListener('pointercancel', old.pointerup);
    }

    // Drag state
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let hasDragged = false;

    const pointerdownHandler = (e) => {
        // Only drag if clicking on the preview image
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

        // Calculate delta in screen pixels
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        // Update start position for next move
        startX = e.clientX;
        startY = e.clientY;

        // Pan the viewport (negative delta because we're moving opposite to mouse)
        window.viewportManager.pan(-deltaX, -deltaY);

        // Update Navigator red rectangle immediately
        const navData = window.viewportManager.getNavigatorMap(160);
        if (navData && navData.viewportBounds) {
            updateNavigatorViewport(navData.viewportBounds);
        }

        // Debounce 1:1 preview render
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

            // Full Navigator refresh + final render at latest position after drag completes
            if (hasDragged) {
                renderNavigatorMap();
                // CRITICAL: Final render at the current center position
                // Without this, the preview stays at whatever intermediate position
                // the last RAF-debounced render happened to capture
                await render1to1Preview();
            }
        }
    };

    previewContainer.addEventListener('pointerdown', pointerdownHandler);
    previewContainer.addEventListener('pointermove', pointermoveHandler);
    previewContainer.addEventListener('pointerup', pointerupHandler);
    previewContainer.addEventListener('pointercancel', pointerupHandler);

    // Store handlers for cleanup
    window._1to1DragHandlers = {
        pointerdown: pointerdownHandler,
        pointermove: pointermoveHandler,
        pointerup: pointerupHandler
    };

}

/**
 * UXP-safe select option replacement.
 * innerHTML on <select> can corrupt the dropdown in UXP. Use DOM methods instead.
 * @param {HTMLSelectElement} selectEl
 * @param {Array<{value: string, text: string, selected?: boolean}>} options
 */
function replaceSelectOptions(selectEl, options) {
    // Remove all existing options
    while (selectEl.firstChild) {
        selectEl.removeChild(selectEl.firstChild);
    }
    // Add new options via DOM API
    options.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.text;
        if (opt.selected) option.selected = true;
        selectEl.appendChild(option);
    });
}

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
            if (!posterizationData || !window.previewState) return;
            const stride = parseInt(previewStrideSelect.value, 10);
            const pixels = posterizationData.originalPixels;
            const paletteLab = posterizationData.selectedPreview.paletteLab;
            const width = posterizationData.originalWidth;
            const height = posterizationData.originalHeight;

            const labels = { 4: 'Standard', 2: 'Fine', 1: 'Finest' };
            document.body.style.cursor = 'wait';

            setTimeout(() => {
                try {
                    const bitDepth = posterizationData.bitDepth || 8;
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

// 🏛️ POST-PROCESSING FILTER IMPLEMENTATIONS (top-level for access from both showPaletteEditor and render1to1Preview)

/**
 * shadowClamp: Enforce minimum ink density floor
 * Operates on per-color coverage, not individual pixels
 * Clamps thin/watery shadows to ensure printable density
 */
function applyShadowClamp(assignments, paletteSize, clampPercent) {
    if (clampPercent === 0) return assignments;


    const clampThreshold = clampPercent / 100;
    const colorCounts = new Array(paletteSize).fill(0);
    for (let i = 0; i < assignments.length; i++) {
        colorCounts[assignments[i]]++;
    }

    const totalPixels = assignments.length;
    const colorCoverages = colorCounts.map(count => count / totalPixels);

    // Identify thin colors (below density floor) and strong colors
    const thinColors = new Set();
    const strongColors = [];
    colorCoverages.forEach((coverage, colorIdx) => {
        if (coverage > 0 && coverage < clampThreshold) {
            thinColors.add(colorIdx);
        } else if (coverage > 0) {
            strongColors.push(colorIdx);
        }
    });

    if (thinColors.size === 0) {
        return assignments;
    }

    if (strongColors.length === 0) {
        return assignments;
    }

    // Remap thin colors to nearest strong color by pixel count proximity
    // (pick the strong color most frequently adjacent)
    const result = new Uint8Array(assignments.length);
    for (let i = 0; i < assignments.length; i++) {
        const colorIdx = assignments[i];
        if (thinColors.has(colorIdx)) {
            // Remap to the strong color with highest coverage (dominant neighbor)
            result[i] = strongColors[0]; // Default to most common strong color
        } else {
            result[i] = colorIdx;
        }
    }

    return result;
}

/**
 * minVolume: Remove "ghost plates" with insufficient coverage
 * Remaps weak colors to nearest strong color in frozen palette
 */
function applyMinVolume(assignments, labPalette, minVolumePercent) {
    if (minVolumePercent === 0) return assignments;


    const paletteSize = labPalette.length;
    const totalPixels = assignments.length;
    const minPixels = Math.round(totalPixels * (minVolumePercent / 100));

    const colorCounts = new Array(paletteSize).fill(0);
    for (let i = 0; i < assignments.length; i++) {
        colorCounts[assignments[i]]++;
    }

    const weakColors = new Set();
    const strongColors = [];
    colorCounts.forEach((count, colorIdx) => {
        if (count > 0 && count < minPixels) {
            weakColors.add(colorIdx);
        } else if (count >= minPixels) {
            strongColors.push(colorIdx);
        }
    });

    if (weakColors.size === 0) {
        return assignments;
    }

    const remapTable = new Array(paletteSize);
    weakColors.forEach(weakIdx => {
        let nearestStrongIdx = strongColors[0];
        let minDistance = Infinity;

        const weakLab = labPalette[weakIdx];
        strongColors.forEach(strongIdx => {
            const strongLab = labPalette[strongIdx];
            const dL = weakLab.L - strongLab.L;
            const da = weakLab.a - strongLab.a;
            const db = weakLab.b - strongLab.b;
            const distance = Math.sqrt(dL*dL + da*da + db*db);

            if (distance < minDistance) {
                minDistance = distance;
                nearestStrongIdx = strongIdx;
            }
        });

        remapTable[weakIdx] = nearestStrongIdx;
    });

    const result = new Uint8Array(assignments);
    for (let i = 0; i < result.length; i++) {
        const colorIdx = result[i];
        if (weakColors.has(colorIdx)) {
            result[i] = remapTable[colorIdx];
        }
    }

    return result;
}

/**
 * speckleRescue: Remove isolated pixel clusters smaller than threshold
 * Morphological opening operation (erosion + dilation)
 */
function applySpeckleRescue(assignments, width, height, radiusPixels) {
    if (radiusPixels === 0) return assignments;


    const result = new Uint8Array(assignments);
    let removedCount = 0;

    for (let y = radiusPixels; y < height - radiusPixels; y++) {
        for (let x = radiusPixels; x < width - radiusPixels; x++) {
            const idx = y * width + x;
            const color = result[idx];

            let sameColorCount = 0;
            for (let dy = -radiusPixels; dy <= radiusPixels; dy++) {
                for (let dx = -radiusPixels; dx <= radiusPixels; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nIdx = (y + dy) * width + (x + dx);
                    if (result[nIdx] === color) {
                        sameColorCount++;
                    }
                }
            }

            const totalNeighbors = (radiusPixels * 2 + 1) * (radiusPixels * 2 + 1) - 1;
            if (sameColorCount < totalNeighbors * 0.3) {
                const neighborColors = new Map();
                for (let dy = -radiusPixels; dy <= radiusPixels; dy++) {
                    for (let dx = -radiusPixels; dx <= radiusPixels; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nIdx = (y + dy) * width + (x + dx);
                        const nColor = result[nIdx];
                        neighborColors.set(nColor, (neighborColors.get(nColor) || 0) + 1);
                    }
                }

                let maxCount = 0;
                let majorityColor = color;
                neighborColors.forEach((count, nColor) => {
                    if (count > maxCount) {
                        maxCount = count;
                        majorityColor = nColor;
                    }
                });

                if (majorityColor !== color) {
                    result[idx] = majorityColor;
                    removedCount++;
                }
            }
        }
    }

    return result;
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

    if (!posterizationData) {
        logger.error('[1:1] No posterization data available');
        return;
    }

    try {
        // Get viewport state (normalized center point)
        const vmState = window.viewportManager.getState();
        const { center, viewportWidth, viewportHeight } = vmState;

        // Get actual document dimensions FRESH from Photoshop
        const docInfo = PhotoshopAPI.getDocumentInfo();
        const fullDocWidth = docInfo.width;
        const fullDocHeight = docInfo.height;

        // Also get CropEngine dimensions for comparison
        const ceSourceW = window.cropEngine.sourceWidth;
        const ceSourceH = window.cropEngine.sourceHeight;
        const ceActualW = window.cropEngine.actualDocWidth;
        const ceActualH = window.cropEngine.actualDocHeight;

        // Calculate absolute coordinates in full-resolution document
        const centerX = center.x * fullDocWidth;
        const centerY = center.y * fullDocHeight;
        const cropX = Math.max(0, Math.floor(centerX - viewportWidth / 2));
        const cropY = Math.max(0, Math.floor(centerY - viewportHeight / 2));

        // SMART LOADING: Fetch ONLY the viewport window at full resolution
        const cropData = await PhotoshopAPI.getHighResCrop(cropX, cropY, viewportWidth, viewportHeight);


        // Get the posterization palette from window.selectedPreview
        if (!window.selectedPreview || !window.selectedPreview.paletteLab || !window.selectedPreview.palette) {
            logger.error('[1:1] No palette available in window.selectedPreview');
            return;
        }

        const labPalette = window.selectedPreview.paletteLab;
        const rgbPalette = window.selectedPreview.palette;

        // Map high-res crop pixels to existing palette
        const usedMetric = posterizationData.params.distanceMetric || 'cie76';

        let colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            cropData.pixels,
            labPalette,
            null, // onProgress
            cropData.width,
            cropData.height,
            {
                distanceMetric: usedMetric
            }
        );


        // Cache unfiltered crop data for real-time slider scrubbing
        // This allows renderCropWithFilters() to re-apply filters instantly without re-fetching from PS
        window._cachedCropData = {
            unfilteredIndices: new Uint8Array(colorIndices),  // Pre-filter snapshot
            width: cropData.width,
            height: cropData.height,
            labPalette: labPalette,
            rgbPalette: rgbPalette
        };

        // Apply mechanical filters (Production Quality Controls) to crop separation
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

        // Check if color isolation mode is active (swatch clicked)
        const soloColorIndex = window.previewState?.activeSoloIndex;
        const hasSubstrate = window.selectedPreview?.substrateIndex !== null && window.selectedPreview?.substrateIndex !== undefined;
        const substrateIndex = window.selectedPreview?.substrateIndex;

        if (soloColorIndex !== null && soloColorIndex !== undefined) {
        } else {
        }

        // Generate preview from mapped indices
        const previewBuffer = new Uint8ClampedArray(cropData.width * cropData.height * 4);
        for (let i = 0; i < colorIndices.length; i++) {
            const colorIdx = colorIndices[i];
            const idx = i * 4;

            // Bounds check: ensure colorIdx is valid
            if (colorIdx < 0 || colorIdx >= rgbPalette.length) {
                logger.error(`[1:1] Invalid color index ${colorIdx}, palette size ${rgbPalette.length}`);
                // Default to gray
                previewBuffer[idx] = 128;
                previewBuffer[idx + 1] = 128;
                previewBuffer[idx + 2] = 128;
                previewBuffer[idx + 3] = 255;
                continue;
            }

            // Color isolation: only show pixels of the solo color
            if (soloColorIndex !== null && soloColorIndex !== undefined && colorIdx !== soloColorIndex) {
                // Show substrate if it exists, otherwise transparent
                if (hasSubstrate && substrateIndex >= 0 && substrateIndex < rgbPalette.length) {
                    const substrateColor = rgbPalette[substrateIndex];
                    if (substrateColor) {
                        previewBuffer[idx] = substrateColor.r;
                        previewBuffer[idx + 1] = substrateColor.g;
                        previewBuffer[idx + 2] = substrateColor.b;
                        previewBuffer[idx + 3] = 255;
                    } else {
                        // Substrate color invalid, show transparent
                        previewBuffer[idx] = 200;
                        previewBuffer[idx + 1] = 200;
                        previewBuffer[idx + 2] = 200;
                        previewBuffer[idx + 3] = 128;
                    }
                } else {
                    // Transparent (checkerboard will show through)
                    previewBuffer[idx] = 200;
                    previewBuffer[idx + 1] = 200;
                    previewBuffer[idx + 2] = 200;
                    previewBuffer[idx + 3] = 128; // Semi-transparent
                }
            } else {
                // Show actual color (all colors when no swatch selected, or solo color when selected)
                const color = rgbPalette[colorIdx];
                if (color) {
                    previewBuffer[idx] = color.r;
                    previewBuffer[idx + 1] = color.g;
                    previewBuffer[idx + 2] = color.b;
                    previewBuffer[idx + 3] = 255;
                } else {
                    logger.error(`[1:1] RGB color undefined at index ${colorIdx}`);
                    // Default to magenta to indicate error
                    previewBuffer[idx] = 255;
                    previewBuffer[idx + 1] = 0;
                    previewBuffer[idx + 2] = 255;
                    previewBuffer[idx + 3] = 255;
                }
            }
        }

        // Get main preview img element
        const img = document.getElementById('previewImg');
        if (!img) {
            logger.error('[1:1] Preview img element not found');
            return;
        }

        // Encode to JPEG using jpeg-js
        const jpegData = jpeg.encode({
            data: previewBuffer,
            width: cropData.width,
            height: cropData.height
        }, 95);

        // Convert to base64 data URL
        const base64 = bufferToBase64(jpegData.data);
        const dataUrl = `data:image/jpeg;base64,${base64}`;

        // Set image source - this displays TRUE 1:1 pixels from full-res document!
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

    // Read current slider values
    const minVolume = parseFloat(document.getElementById('minVolume')?.value ?? 0);
    const speckleRescue = parseInt(document.getElementById('speckleRescue')?.value ?? 0);
    const shadowClamp = parseFloat(document.getElementById('shadowClamp')?.value ?? 0);

    // Start from unfiltered snapshot each time
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

    // Solo mode
    const soloColorIndex = window.previewState?.activeSoloIndex;
    const hasSubstrate = window.selectedPreview?.substrateIndex !== null && window.selectedPreview?.substrateIndex !== undefined;
    const substrateIndex = window.selectedPreview?.substrateIndex;

    // Generate preview buffer
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

    // Encode and display
    const img = document.getElementById('previewImg');
    if (!img) return;

    const jpegData = jpeg.encode({ data: previewBuffer, width, height }, 95);
    const base64 = bufferToBase64(jpegData.data);
    img.src = `data:image/jpeg;base64,${base64}`;
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
        // CRITICAL FIX: Use CONTAINER rect (160x160), not img rect (107x160)
        // The container is the parent div with fixed 160x160 size and flexbox centering
        const container = img.parentElement;
        if (!container) {
            logger.error('[Navigator] Container not found');
            return;
        }

        const containerRect = container.getBoundingClientRect();
        const imgRect = img.getBoundingClientRect();

        // Calculate offset from container to actual img (flexbox centering)
        const offsetX = imgRect.left - containerRect.left;
        const offsetY = imgRect.top - containerRect.top;


        // Position the red rectangle using bounds from CropEngine PLUS centering offset
        viewportDiv.style.left = `${bounds.x + offsetX}px`;
        viewportDiv.style.top = `${bounds.y + offsetY}px`;
        viewportDiv.style.width = `${bounds.width}px`;
        viewportDiv.style.height = `${bounds.height}px`;

    } catch (error) {
        logger.error('[Navigator] Failed to update viewport rect:', error);
    }
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

        // Get metadata from posterizationData
        if (!posterizationData || !posterizationData.docInfo) {
            logger.error('Missing posterizationData for zoom mode');
            return;
        }

        const docInfo = posterizationData.docInfo;
        const documentID = typeof docInfo.id === 'number' ? docInfo.id : parseInt(docInfo.id, 10);
        const originalLayerID = docInfo.activeLayerID;
        // Use docInfo dimensions (full document), not posterization preview dimensions
        const docWidth = docInfo.width;
        const docHeight = docInfo.height;
        const bitDepth = posterizationData.bitDepth || 8;


        // Create separation data for ZoomPreviewRenderer
        const selectedPreview = posterizationData.selectedPreview;
        if (selectedPreview.paletteLab.length > 0) {
        }

        const separationData = {
            palette: selectedPreview.paletteLab
        };

        // Add zoom mode class (container stays responsive via flex layout)
        container.classList.add('zoom-mode');


        // Get both buffer images for double buffering
        const imageEl2 = document.getElementById('previewImgBuffer2');
        if (!imageEl2) {
            logger.error('Second buffer image not found');
            return;
        }

        // Set up images for zoom mode (absolute positioning)
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

        // Initialize ZoomPreviewRenderer on the preview panel with double buffering
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

        // Set HQ badge element
        state.zoomRenderer.hqBadge = document.getElementById('previewHqBadge');

        // Preserve solo mode if active
        if (state.activeSoloIndex !== null) {
            state.zoomRenderer.setSoloColor(state.activeSoloIndex);
        }


        // Initialize renderer (centers viewport, fetches first render)
        try {
            await state.zoomRenderer.init();
        } catch (err) {
            logger.error('Failed to initialize renderer:', err);
            throw err;
        }

        // Rebuild dropdown with zoom options + fresh handler
        rebuildPreviewStrideForMode('zoom');

        // Attach zoom event handlers
        attachPreviewZoomHandlers();

        // Set up resize observer to handle dialog resize
        state._resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const newWidth = entry.contentRect.width;
                const newHeight = entry.contentRect.height;

                // Update renderer dimensions if they changed significantly (> 10px)
                if (state.zoomRenderer &&
                    (Math.abs(newWidth - state.zoomRenderer.width) > 10 ||
                     Math.abs(newHeight - state.zoomRenderer.height) > 10)) {


                    // Update renderer dimensions
                    state.zoomRenderer.width = newWidth;
                    state.zoomRenderer.height = newHeight;

                    // Reallocate RGBA buffer for new size
                    state.zoomRenderer.rgbaBuffer = new Uint8Array(newWidth * newHeight * 4);

                    // Re-center viewport and re-render
                    state.zoomRenderer.applyBounds();
                    state.zoomRenderer.fetchAndRender();
                }
            }
        });
        state._resizeObserver.observe(container);

        state.viewMode = 'zoom';

    } else if (mode === '1:1') {
        // 1:1 CLINICAL LOUPE MODE (Phase 1: UI toggle only)

        // Show/hide appropriate UI elements
        const navigatorMap = document.getElementById('navigatorMapContainer');
        const qualityGroup = document.getElementById('previewQualityGroup');

        if (navigatorMap) {
            navigatorMap.style.display = 'block';
        }
        if (qualityGroup) {
            qualityGroup.style.display = 'none';
        }

        state.viewMode = '1:1';

        // Render Navigator Map thumbnail
        renderNavigatorMap();

        // Phase 4: Attach Navigator click handler for panning
        attachNavigatorClickHandler();

        // Phase 4+: Attach arrow key navigation
        attachArrowKeyNavigation();

        // Attach preview click handler to deselect swatches
        attachPreviewClickHandler();

        // Attach preview drag handler for panning
        attach1to1PreviewDragHandler();

        // Phase 3: Render 1:1 pixels to main preview
        await render1to1Preview();


    } else if (mode === 'fit') {
        // FIT MODE: Cleanup ZoomPreviewRenderer or 1:1 mode, restore renderPreview

        // Cleanup 1:1 mode if active
        if (state.viewMode === '1:1') {

            // Hide Navigator Map
            const navigatorMap = document.getElementById('navigatorMapContainer');
            const qualityGroup = document.getElementById('previewQualityGroup');

            if (navigatorMap) {
                navigatorMap.style.display = 'none';
            }
            if (qualityGroup) {
                qualityGroup.style.display = 'flex';
            }

            // (Dropdown is rebuilt on fit entry below, no need to restore here)

            // Remove 1:1 drag handlers
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
            // Clear quality timeout
            if (state.zoomRenderer.qualityTimeout) {
                clearTimeout(state.zoomRenderer.qualityTimeout);
            }

            // Force stop any in-progress rendering
            state.zoomRenderer.isRendering = false;

            // Remove onload/onerror handlers from both images to prevent delayed loads
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

            // Dispose pixel data
            if (state.zoomRenderer.activePixelData && state.zoomRenderer.activePixelData.imageData) {
                state.zoomRenderer.activePixelData.imageData.dispose();
                state.zoomRenderer.activePixelData = null;
            }

            state.zoomRenderer = null;
        }

        // Remove zoom event handlers
        detachPreviewZoomHandlers();

        // Disconnect resize observer
        if (state._resizeObserver) {
            state._resizeObserver.disconnect();
            state._resizeObserver = null;
        }

        // Remove zoom mode class
        container.classList.remove('zoom-mode');

        // Reset first image to normal (fit mode) styles
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

        // Hide and reset second buffer image
        const imageEl2 = document.getElementById('previewImgBuffer2');
        if (imageEl2) {
            imageEl2.onload = null;
            imageEl2.onerror = null;
            imageEl2.src = ''; // Clear any pending image loads
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

        // Hide HQ badge
        const hqBadge = document.getElementById('previewHqBadge');
        if (hqBadge) {
            hqBadge.style.display = 'none';
        }

        // Rebuild dropdown with fit options + fresh handler
        rebuildPreviewStrideForMode('fit');

        // Set viewMode BEFORE rendering (mode guard in renderPreview checks this)
        state.viewMode = 'fit';

        // Re-render preview in fit mode
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

    // Store handlers for cleanup
    state._previewZoomHandlers = {
        mousedown: null,
        mousemove: null,
        mouseup: null,
        wheel: null,
        keydown: null
    };

    // Mouse drag panning with frequent updates to minimize white space
    let isDragging = false;
    let hasMoved = false; // Track if actual dragging occurred
    let dragStartX = 0;
    let dragStartY = 0;
    let lastX = 0;
    let lastY = 0;
    let transformX = 0;
    let transformY = 0;
    let lastRenderTime = 0;
    const RENDER_INTERVAL = 80; // Fetch pixels every 80ms during drag
    const MIN_DRAG_DISTANCE = 3; // Minimum pixels to count as drag vs click

    state._previewZoomHandlers.mousedown = (e) => {
        isDragging = true;
        hasMoved = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        lastX = e.clientX;
        lastY = e.clientY;
        transformX = 0;
        transformY = 0;
        lastRenderTime = 0; // Allow immediate first render
        // Cancel any pending HQ timeout so it doesn't block drag renders
        clearTimeout(renderer.qualityTimeout);
        container.classList.add('panning');
        e.preventDefault();
    };

    state._previewZoomHandlers.mousemove = (e) => {
        if (!isDragging) return;

        const deltaX = lastX - e.clientX;
        const deltaY = lastY - e.clientY;

        // Check if we've moved enough to count as a drag
        const totalDragDistance = Math.sqrt(
            Math.pow(e.clientX - dragStartX, 2) +
            Math.pow(e.clientY - dragStartY, 2)
        );
        if (totalDragDistance > MIN_DRAG_DISTANCE) {
            hasMoved = true;
        }

        // 1. Update the renderer's logical position
        renderer.pan(deltaX, deltaY);

        // 2. Update visual offset for CSS transform
        transformX -= deltaX;
        transformY -= deltaY;

        // 3. Move the CURRENTLY VISIBLE image (smooth 60fps)
        const activeImg = renderer.getActiveImage();
        if (activeImg) {
            activeImg.style.transform = `translate3d(${transformX}px, ${transformY}px, 0)`;
        }

        // 4. Request background render into hidden buffer (throttled)
        // When ready, images will swap seamlessly
        const now = Date.now();
        if (now - lastRenderTime > RENDER_INTERVAL && !renderer.isRendering) {
            renderer.fetchAndRender(false).then(() => {
                // After swap, reset visual offset since we have fresh pixels
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

        // Cancel any pending HQ timeout that might block our final render
        clearTimeout(renderer.qualityTimeout);

        // Reset transform on the active image
        const activeImg = renderer.getActiveImage();
        if (activeImg) {
            activeImg.style.transform = 'translate3d(0, 0, 0)';
        }
        transformX = 0;
        transformY = 0;

        // Final render at current position - the dirty flag mechanism
        // ensures this will execute even if a previous render is in-flight
        renderer.fetchAndRender(false);

        // If we actually dragged (moved), suppress the next click event
        if (hasMoved) {
            state._suppressNextClick = true;
            // Clear the flag after a short delay (in case click event doesn't fire)
            setTimeout(() => {
                state._suppressNextClick = false;
            }, 100);
        }
    };

    // Wheel zoom to cursor
    state._previewZoomHandlers.wheel = async (e) => {
        e.preventDefault();

        const resolutions = [1, 2, 4, 8];
        let currentIndex = resolutions.indexOf(renderer.resolution);
        const zoomDirection = e.deltaY > 0 ? 1 : -1;
        let nextIndex = currentIndex + zoomDirection;

        if (nextIndex < 0 || nextIndex >= resolutions.length) return;

        const nextRes = resolutions[nextIndex];

        // Get mouse position relative to container
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Zoom to cursor position
        await renderer.setResolutionAtPoint(nextRes, mouseX, mouseY);

        // Update dropdown to match
        const previewStrideSelect = document.getElementById('previewStride');
        if (previewStrideSelect) {
            previewStrideSelect.value = nextRes;
        }
    };

    // Arrow key panning
    state._previewZoomHandlers.keydown = (e) => {
        const PAN_STEP = 50; // pixels to pan per key press
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

    // Attach handlers
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
 * Convert Uint8Array/Buffer to base64 string
 */
function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Update visual highlighting on swatches to show which is active
 */
function updateSwatchHighlights() {
    const state = window.previewState;
    if (!state) return;

    const container = document.getElementById('editablePaletteContainer');
    if (!container) return;

    // Get substrate info to convert swatch indices to palette indices
    const selectedPreview = window.selectedPreview;
    const substrateIndex = selectedPreview?.substrateIndex;

    const swatches = container.querySelectorAll('.editable-swatch');
    swatches.forEach((swatch, swatchIndex) => {
        // Convert swatch index to palette index (accounting for substrate offset)
        let paletteIndex = swatchIndex;
        if (substrateIndex !== null && swatchIndex >= substrateIndex) {
            paletteIndex = swatchIndex + 1;  // Skip the substrate index
        }

        if (state.activeSoloIndex === paletteIndex) {
            // Highlight swatch - USE INLINE STYLES for UXP compatibility
            swatch.classList.add('active-solo');
            swatch.style.outline = '8px solid #1473e6';
            swatch.style.outlineOffset = '-8px';
            swatch.style.boxShadow = 'inset 0 0 0 8px rgba(20, 115, 230, 0.5)';
        } else {
            // Remove highlight - restore default styles
            swatch.classList.remove('active-solo');
            swatch.style.outline = 'none';
            swatch.style.outlineOffset = '0';
            swatch.style.boxShadow = 'inset 0 1px 3px rgba(0, 0, 0, 0.1)';
        }
    });

    // Update preview container solo mode indicator
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

    // Re-render preview (works in all modes)
    if (state.viewMode === 'fit') {
        renderPreview();
    } else if (state.viewMode === 'zoom' && state.zoomRenderer) {
        // Clear solo mode in zoom renderer
        state.zoomRenderer.setSoloColor(null);
        state.zoomRenderer.fetchAndRender();
    } else if (state.viewMode === '1:1') {
        // Clear solo mode in 1:1 preview
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

    // Get substrate info to convert swatch indices to palette indices
    const selectedPreview = window.selectedPreview;
    const substrateIndex = selectedPreview?.substrateIndex;

    const swatches = container.querySelectorAll('.editable-swatch');
    swatches.forEach((swatch, swatchIndex) => {
        // Convert swatch index to palette index (accounting for substrate offset)
        let paletteIndex = swatchIndex;
        if (substrateIndex !== null && swatchIndex >= substrateIndex) {
            paletteIndex = swatchIndex + 1;  // Skip the substrate index
        }

        const isDeleted = state.deletedIndices.has(paletteIndex);

        if (isDeleted) {
            // Deleted state: low opacity + grayscale + badge
            swatch.style.opacity = '0.4';
            swatch.style.filter = 'grayscale(100%)';

            // Add "DELETED" badge if not already present
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
            // Normal state: full opacity + no filter
            swatch.style.opacity = '1';
            swatch.style.filter = 'none';

            // Remove deleted badge if present
            const deletedBadge = swatch.querySelector('.deleted-badge');
            if (deletedBadge) {
                deletedBadge.remove();
            }
        }
    });

    // Also update highlight state (preserves border styling)
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

    // Convert swatch index to palette index (accounting for substrate offset)
    const selectedPreview = window.selectedPreview;
    const substrateIndex = selectedPreview?.substrateIndex;

    let paletteIndex = featureIndex;
    if (substrateIndex !== null && featureIndex >= substrateIndex) {
        paletteIndex = featureIndex + 1;  // Skip the substrate index
    }

    // Select this color (clicking same swatch keeps it selected)
    // To deselect, click outside the swatches or click a different swatch
    state.activeSoloIndex = paletteIndex;

    // Update swatch highlighting
    updateSwatchHighlights();

    // Re-render preview (works in all modes now!)
    if (state.viewMode === 'fit') {
        renderPreview();
    } else if (state.viewMode === 'zoom' && state.zoomRenderer) {
        // In zoom mode: Update renderer's solo color and re-render
        state.zoomRenderer.setSoloColor(paletteIndex);
        state.zoomRenderer.fetchAndRender();
    } else if (state.viewMode === '1:1') {
        // In 1:1 mode: Re-render with color isolation
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

    // Convert swatch index to full palette index (accounting for substrate offset)
    const selectedPreview = window.selectedPreview;
    const substrateIndex = selectedPreview?.substrateIndex;

    // If there's a substrate and it's before this swatch, offset the palette index
    let paletteIndex = swatchIndex;
    if (substrateIndex !== null && swatchIndex >= substrateIndex) {
        paletteIndex = swatchIndex + 1;  // Skip the substrate index
    }

    const deletedIndices = state.deletedIndices;
    const totalColors = state.palette.length;

    // Toggle deleted state
    if (deletedIndices.has(paletteIndex)) {
        // Restore color
        deletedIndices.delete(paletteIndex);
    } else {
        // Delete color
        const survivorCount = totalColors - deletedIndices.size;

        // Edge case: Prevent deleting all colors
        if (survivorCount === 1) {
            alert('Cannot delete all colors. At least one color must remain.');
            return;
        }

        // Warning: Confirm if deleting to single color
        if (survivorCount === 2) {
            const confirmed = confirm('This will leave only 1 color. Continue?');
            if (!confirmed) return;
        }

        deletedIndices.add(paletteIndex);

        // Clear solo mode if deleted color was active
        if (state.activeSoloIndex === paletteIndex) {
            state.activeSoloIndex = null;
        }
    }

    // Update visual feedback
    updateSwatchVisuals();

    // Re-render preview with updated deletions
    renderPreview();
}

/**
 * Show palette editor section and hide preview section
 */
function showPaletteEditor(selectedPalette) {

    // Close the main dialog
    const mainDialog = document.getElementById('mainDialog');
    if (mainDialog) {
        mainDialog.close();
    }

    // Open the palette dialog
    const paletteDialog = document.getElementById('paletteDialog');
    if (!paletteDialog) {
        logger.error("⚠️ Palette dialog not found!");
        return;
    }

    // Open palette dialog with UXP options for size and resizing
    paletteDialog.showModal({
        resize: "both",
        size: {
            width: 1200,
            height: 800,
            minWidth: 800,
            minHeight: 600,
            maxWidth: 1600,
            maxHeight: 1000
        }
    });

    // UXP workaround: CSS flexbox doesn't properly fill dialog space on resize
    // Use ResizeObserver to manually set panel heights based on dialog size
    function updatePanelLayout() {
        const dialog = document.getElementById('paletteDialog');
        const content = dialog.querySelector('.reveal-content');
        const formSection = dialog.querySelector('.form-section');
        const mainFlex = formSection?.firstElementChild; // The flex row container

        if (!dialog || !content || !formSection || !mainFlex) return;

        // Get dialog dimensions (controlled by UXP showModal)
        const dialogRect = dialog.getBoundingClientRect();
        const titleEl = dialog.querySelector('.reveal-title');
        const buttonsEl = dialog.querySelector('.reveal-buttons');

        const titleHeight = titleEl ? titleEl.offsetHeight : 0;
        const buttonsHeight = buttonsEl ? buttonsEl.offsetHeight : 0;
        const padding = 48; // Content padding (24px top + bottom)

        // Calculate available height for content
        const availableHeight = dialogRect.height - titleHeight - buttonsHeight - padding;

        // Set explicit heights (UXP ignores flex: 1 for height)
        content.style.height = `${availableHeight}px`;
        formSection.style.height = `${availableHeight - 24}px`; // minus form-section margin
        mainFlex.style.height = `${availableHeight - 24}px`;

        // Note: No re-rendering needed - CSS handles scaling on the img element
    }

    // Initial layout
    setTimeout(updatePanelLayout, 100);

    // Update on resize using ResizeObserver (CSS handles image scaling automatically)
    if (typeof ResizeObserver !== 'undefined') {
        const resizeObserver = new ResizeObserver(() => {
            updatePanelLayout();
        });
        resizeObserver.observe(paletteDialog);
    }

    // Render palette swatches (extracted to function for re-rendering after color changes)
    function renderPaletteSwatches() {
        const container = document.getElementById('editablePaletteContainer');

        // Display palette in feature order (no sorting)
        // Build all swatches HTML at once with clickable color buttons + Lab coordinates
        // Display Lab coordinates (L, a, b) instead of hex - perceptual truth, not RGB lies
        const swatchesHTML = selectedPalette.hexColors.map((hex, featureIndex) => {
            const rgb = hexToRgb(hex);
            const lab = PosterizationEngine.rgbToLab(rgb);
            const lightnessPercent = Math.round(lab.L);
            const lightnessLabel = lightnessPercent < 33 ? 'Shadow' : lightnessPercent < 67 ? 'Midtone' : 'Highlight';

            // Format Lab coordinates: L (0-100), a (-128 to 127), b (-128 to 127)
            const labDisplay = `L${Math.round(lab.L)} a${Math.round(lab.a)} b${Math.round(lab.b)}`;

            return `
            <div class="editable-swatch-container">
                <div class="editable-swatch"
                     style="background-color: ${hex};"
                     data-feature-index="${featureIndex}"
                     data-hex="${hex}"
                     title="Click: Highlight in preview&#10;Alt+Click: Toggle delete">
                    <div class="lightness-badge">L${lightnessPercent}</div>
                </div>
                <div class="editable-swatch-label">${lightnessLabel}</div>
                <div class="editable-swatch-lab clickable-lab"
                     data-feature-index="${featureIndex}"
                     data-hex="${hex}"
                     title="Click to choose ink color"
                     style="cursor: pointer; padding: 2px; border-radius: 2px; transition: background 0.2s;">${labDisplay}</div>
            </div>
        `;
        }).join('');

        container.innerHTML = swatchesHTML;

        // Re-attach click handlers after re-render
        attachSwatchClickHandlers();
    }

    // Initial render
    renderPaletteSwatches();

    // Apply visual state (deleted colors, etc.)
    updateSwatchVisuals();

    // CRITICAL: Force UXP to recalculate flex layout after innerHTML injection
    // This fixes the "offsetWidth: 0, offsetHeight: 0" issue in UXP
    requestAnimationFrame(() => {
        // Get fresh reference to container (it's defined inside renderPaletteSwatches)
        const container = document.getElementById('editablePaletteContainer');

        // Force browser reflow by reading dimensions
        const height = container.offsetHeight;

        // Force visibility on all swatches by reading their offsetHeight
        const swatches = container.querySelectorAll('.editable-swatch-container');
        swatches.forEach(swatch => {
            // Reading offsetHeight forces UXP to calculate dimensions
            swatch.offsetHeight;
        });


        // Log first swatch dimensions to verify fix
        if (swatches.length > 0) {
            const firstSwatch = swatches[0];
        }
    });

    // Attach click handlers to swatches - extracted for re-rendering after color changes
    function attachSwatchClickHandlers() {
        const container = document.getElementById('editablePaletteContainer');

        // Handler: Lab text click → Color Picker
        const labTexts = container.querySelectorAll('.clickable-lab');

        labTexts.forEach(labText => {
            // Add hover effects via event listeners (UXP doesn't allow inline handlers)
            labText.addEventListener('mouseenter', () => {
                labText.style.background = '#e3f2fd';
            });
            labText.addEventListener('mouseleave', () => {
                labText.style.background = 'transparent';
            });

            labText.addEventListener('click', async (event) => {
                event.stopPropagation(); // Prevent triggering swatch click

                const featureIndex = parseInt(labText.dataset.featureIndex);
                const currentHex = labText.dataset.hex;
                const currentRgb = hexToRgb(currentHex);


                // Highlight this color in canvas preview (solo mode)
                if (window.previewState) {
                    window.previewState.activeSoloIndex = featureIndex;
                    renderPreview();
                }

                try {
                    // Show Photoshop's Color Picker with current color
                    const result = await showPhotoshopColorPicker(currentRgb);

                    // User cancelled?
                    if (!result) {
                        // Keep solo mode active (user may want to try again)
                        return;
                    }

                    // Convert RGB result to hex
                    const newHex = rgbToHex(result.red, result.green, result.blue);

                    // No change?
                    if (newHex === currentHex) {
                        return;
                    }

                    // Convert to Lab for perceptual distance check
                    const newLab = PosterizationEngine.rgbToLab({ r: result.red, g: result.green, b: result.blue });

                    // Check perceptual distance against other colors (Palette Sovereignty)
                    const MIN_DISTANCE = 12; // L-weighted ΔE threshold
                    let tooSimilar = false;
                    let similarTo = null;
                    let minDistance = Infinity;

                    for (let i = 0; i < selectedPalette.hexColors.length; i++) {
                        if (i === featureIndex) continue; // Skip self

                        const otherHex = selectedPalette.hexColors[i];
                        const distance = PosterizationEngine.calculateHexDistance(newHex, otherHex);

                        if (distance < MIN_DISTANCE) {
                            tooSimilar = true;
                            similarTo = i + 1;
                            minDistance = distance;
                            break;
                        }
                    }

                    // Show warning if too similar (but still allow)
                    if (tooSimilar) {
                        alert(`⚠️ Warning: This color is very similar to Feature ${similarTo} (ΔE=${minDistance.toFixed(1)}). Colors may not separate cleanly in final output.`);
                    }

                    // Update palette data using feature index (maintains alignment with originalHexColors)
                    selectedPalette.hexColors[featureIndex] = newHex;

                    // Convert featureIndex to full palette index (accounting for substrate)
                    const substrateIndex = selectedPalette.substrateIndex;
                    let paletteIndex = featureIndex;
                    if (substrateIndex !== null && featureIndex >= substrateIndex) {
                        paletteIndex = featureIndex + 1;  // Skip the substrate index
                    }

                    // Update full palette (used for preview rendering and layer creation)
                    selectedPalette.allHexColors[paletteIndex] = newHex;
                    selectedPalette.paletteLab[paletteIndex] = newLab;  // CRITICAL: Update Lab palette (used for layer creation)

                    // Re-render entire palette to show new color, re-sort by L, and update all Lab values
                    renderPaletteSwatches();
                    updateSwatchVisuals();

                    // Update canvas preview with new color (use FULL palette to match assignments)
                    if (window.previewState) {
                        window.previewState.palette = selectedPalette.allHexColors;
                        renderPreview();
                    }

                } catch (error) {
                    logger.error(`Failed to show color picker:`, error);
                    alert(`Error showing color picker: ${error.message}`);
                }
            });
        });

        // Handler: Swatch click → Highlight color in canvas preview
        const swatches = container.querySelectorAll('.editable-swatch');

        swatches.forEach(swatch => {
            swatch.addEventListener('click', (event) => {
                event.stopPropagation(); // Prevent bubbling to container

                const featureIndex = parseInt(swatch.dataset.featureIndex);

                // Alt+Click: Toggle delete state
                if (event.altKey) {
                    handleSwatchDelete(featureIndex);
                    return;
                }

                // Normal click: Select this swatch (not toggle - click again to keep selected)
                handleSwatchClick(featureIndex);
            });
        });

        // Handler: Click on preview container → Clear swatch selection (show all colors)
        const previewContainer = document.getElementById('previewContainer');
        if (previewContainer && !previewContainer._clickHandlerAttached) {
            previewContainer.addEventListener('click', () => {
                clearSwatchSelection();
            });
            previewContainer._clickHandlerAttached = true;
        }

    }

    // Attach event listeners to Production Quality Control sliders
    // These trigger re-posterization when values change
    let rerunInProgress = false;
    let rerunDebounceTimer = null;
    let lastRerunTime = 0;
    const MIN_RERUN_INTERVAL = 500; // Minimum 500ms between reruns (reduced for smoother updates)

    // Store handler references for proper cleanup (avoids cloneNode DOM corruption)
    if (!window._productionQualityHandlers) {
        window._productionQualityHandlers = {};
    }

    function attachProductionQualityListeners() {
        const sliders = [
            { id: 'minVolume', name: 'Min Volume', format: v => v.toFixed(1) },
            { id: 'speckleRescue', name: 'Speckle Rescue', format: v => v.toFixed(0) },
            { id: 'shadowClamp', name: 'Shadow Clamp', format: v => v.toFixed(1) }
        ];

        sliders.forEach(({ id, name, format }) => {
            const slider = document.getElementById(id);
            const valueDisplay = document.getElementById(`${id}Value`);

            if (!slider) {
                return;
            }

            // Remove previous listeners if they exist (avoids cloneNode DOM corruption)
            if (window._productionQualityHandlers[id]) {
                const prev = window._productionQualityHandlers[id];
                slider.removeEventListener('input', prev.input);
                slider.removeEventListener('change', prev.change);
            }

            // Add input listener for real-time updates during drag
            // Updates value display AND re-renders 1:1 preview with filters (no PS fetch)
            const inputHandler = () => {
                const value = parseFloat(slider.value);
                if (valueDisplay) {
                    valueDisplay.textContent = format(value);
                }
                // Real-time preview: re-apply filters to cached crop data
                if (window.previewState?.viewMode === '1:1' && window._cachedCropData) {
                    renderCropWithFilters();
                }
            };
            slider.addEventListener('input', inputHandler);

            // Add change listener with debounce (fires when user releases slider)
            const changeHandler = async () => {
                const value = parseFloat(slider.value);

                // Clear any pending rerun
                if (rerunDebounceTimer) {
                    clearTimeout(rerunDebounceTimer);
                }

                // Prevent overlapping reruns
                if (rerunInProgress) {
                    return;
                }

                // Throttle: prevent reruns faster than MIN_RERUN_INTERVAL
                const now = Date.now();
                const timeSinceLastRerun = now - lastRerunTime;
                if (timeSinceLastRerun < MIN_RERUN_INTERVAL && lastRerunTime > 0) {
                    // Still debounce, but will be checked again when timer fires
                }


                // Debounce to prevent rapid-fire reruns (increased to 1 second)
                rerunDebounceTimer = setTimeout(async () => {
                    // Check throttle again when timer fires
                    const timeSinceLastCheck = Date.now() - lastRerunTime;
                    if (timeSinceLastCheck < MIN_RERUN_INTERVAL && lastRerunTime > 0) {
                        return;
                    }

                    if (rerunInProgress) {
                        return;
                    }

                    rerunInProgress = true;
                    lastRerunTime = Date.now();
                    document.body.style.cursor = 'wait';

                    try {
                        const config = getFormValues();
                        await rerunPosterization(config);
                    } catch (error) {
                        logger.error(`❌ Failed to re-posterize with ${name}:`, error);
                        logger.error(`   Stack:`, error.stack);
                        alert(`Re-posterization failed: ${error.message}\n\nPlease run posterization again from Parameters dialog.`);
                    } finally {
                        document.body.style.cursor = '';
                        rerunInProgress = false;
                    }
                }, 500); // 500ms debounce (balanced for responsiveness)
            };
            slider.addEventListener('change', changeHandler);

            // Store references for cleanup on next call
            window._productionQualityHandlers[id] = { input: inputHandler, change: changeHandler };

        });
    }

    // 🏛️ FROZEN PALETTE PROTOCOL: Apply mechanical filters WITHOUT regenerating colors
    // This is "polishing the tire", not "re-inventing the wheel"
    async function rerunPosterization(config) {
        try {

            // 🏛️ FROZEN PALETTE PROTOCOL: Use immutable palette, never re-generate
            const frozenPalette = window._frozenPalette;
            if (!frozenPalette || !frozenPalette.labPalette) {
                throw new Error('Frozen palette not available - posterize first');
            }

            // Get the original image data (stored after preprocessing)
            const originalData = window._originalImageData;
            if (!originalData || !originalData.labPixels) {
                throw new Error('Original image data not available');
            }

            const labPixels = new Uint16Array(originalData.labPixels);
            const { width, height } = originalData;


            // Re-separate with FIXED palette using SeparationEngine only
            // Signature: (rawBytes, labPalette, onProgress, width, height, options)
            const assignments = await SeparationEngine.mapPixelsToPaletteAsync(
                labPixels,
                frozenPalette.labPalette,
                null,  // onProgress callback (not needed for real-time)
                width,
                height,
                {
                    distanceMetric: originalData.config?.distanceMetric || 'cie76',
                    ditherType: 'none'  // No dithering during real-time adjustments
                }
            );


            // Apply post-processing filters in strategic order (per Architect directive)
            let processedAssignments = assignments;

            // 1. shadowClamp: Simplest, immediate visual "weight"
            if (config.shadowClamp > 0) {
                processedAssignments = applyShadowClamp(
                    processedAssignments,
                    frozenPalette.labPalette.length,
                    config.shadowClamp
                );
            }

            // 2. minVolume: Fix "ghost plate" problem, remap weak→strong
            if (config.minVolume > 0) {
                processedAssignments = applyMinVolume(
                    processedAssignments,
                    frozenPalette.labPalette,
                    config.minVolume
                );
            }

            // 3. speckleRescue: Most expensive, morphological cleanup
            if (config.speckleRescue > 0) {
                processedAssignments = applySpeckleRescue(
                    processedAssignments,
                    width,
                    height,
                    config.speckleRescue
                );
            }

            // Build result object with FROZEN colors (colors never change!)
            const result = {
                palette: frozenPalette.rgbPalette,          // FROZEN RGB palette
                paletteLab: frozenPalette.labPalette,       // FROZEN Lab palette
                assignments: processedAssignments,
                width: width,
                height: height
            };

            // Use FROZEN hex colors (never recalculate)
            const hexColors = frozenPalette.hexColors;

            // Update window.selectedPreview.assignments only (palette stays frozen)
            window.selectedPreview.assignments = processedAssignments;

            // DON'T update selectedPalette - it stays frozen!

            // Update preview - check if we're in 1:1 mode
            if (window.previewState) {
                // Update previewState with new results
                window.previewState.palette = hexColors;
                window.previewState.assignments = result.assignments;

                try {
                    // Update preview based on current view mode
                    if (window.previewState.viewMode === '1:1') {
                        await render1to1Preview();

                        // Update Navigator Map thumbnail
                        renderNavigatorMap();
                    } else if (window.previewState.viewMode === 'zoom') {
                        // Zoom mode: trigger a re-render of current viewport
                        if (window.previewState.zoomRenderer) {
                            await window.previewState.zoomRenderer.fetchAndRender();
                        }
                    } else {
                        renderPreview();
                    }
                } catch (previewError) {
                    logger.error(`   ❌ Failed to update preview:`, previewError);
                    throw new Error(`Preview update failed: ${previewError.message}`);
                }
            }


        } catch (error) {
            logger.error(`❌ Re-posterization failed:`, error);
            logger.error(`   Stack:`, error.stack);
            throw error; // Re-throw so the caller can handle it
        }
    }

    // Attach listeners after palette is rendered
    attachProductionQualityListeners();

    // Hide "Posterize" button, show "Apply Separation" and "Back" buttons
    const btnPosterize = document.getElementById('btnPosterize');
    if (btnPosterize) btnPosterize.style.display = 'none';

    const btnApplySeparation = document.getElementById('btnApplySeparation');
    btnApplySeparation.style.display = 'block';
    btnApplySeparation.style.visibility = 'visible';

    // CRITICAL: Reset button state from any previous runs
    btnApplySeparation.disabled = false;
    btnApplySeparation.textContent = "Separate with this palette →";

    const btnBack = document.getElementById('btnBack');
    if (btnBack) {
        btnBack.style.display = 'block';
    }

    // Ensure buttons container is visible
    const buttonsContainer = document.querySelector('.reveal-buttons');
    if (buttonsContainer) {
        buttonsContainer.style.display = 'flex';
    }


    // Note: Debug dimension checks removed - palette editor is now in separate paletteDialog

    // CRITICAL: Clone and replace button to remove ALL old event listeners
    // This prevents event listener accumulation on repeated posterizations
    const btnApplySeparationClone = btnApplySeparation.cloneNode(true);
    btnApplySeparation.parentNode.replaceChild(btnApplySeparationClone, btnApplySeparation);
    const btnApply = btnApplySeparationClone; // Use new reference

    // Attach fresh event listener to cloned button (no duplicates)
    btnApply.addEventListener("click", async () => {

        // GUARD CLAUSE: Prevent concurrent executions
        if (btnApply.disabled) {
            logger.warn('⚠ Separation already in progress, ignoring duplicate click');
            return;
        }

        // LOCK: Disable button immediately
        btnApply.disabled = true;
        btnApply.textContent = "Applying Separation...";

        // Validation checks
        if (!posterizationData) {
            alert("Error: No posterization data found. Please restart the workflow.");
            btnApply.disabled = false;
            btnApply.textContent = "Separate with this palette →";
            return;
        }

        const selectedPreview = posterizationData.selectedPreview;

        if (!selectedPreview) {
            alert("Error: No color palette selected. Please go back and select a palette.");
            btnApply.disabled = false;
            btnApply.textContent = "Separate with this palette →";
            return;
        }

        // PALETTE SOVEREIGNTY: Use user-edited hex values as absolute truth

        // Filter out soft-deleted colors before separation
        let hexColors = selectedPreview.hexColors;
        let originalHexColors = selectedPreview.originalHexColors;
        let paletteLab = selectedPreview.paletteLab;

        if (window.previewState && window.previewState.deletedIndices.size > 0) {
            const deletedIndices = window.previewState.deletedIndices;

            // Filter all palette arrays to exclude deleted colors
            hexColors = selectedPreview.hexColors.filter((_, idx) => !deletedIndices.has(idx));
            originalHexColors = selectedPreview.originalHexColors.filter((_, idx) => !deletedIndices.has(idx));
            paletteLab = selectedPreview.paletteLab.filter((_, idx) => !deletedIndices.has(idx));

        }

        // Track separation start time for golden stats
        const separationStartTime = Date.now();

        // Declare variables in outer scope so cleanup code can access them
        let fullResPixels = null;
        let fullResLayers = null;

        try {
            // Wrap ALL work in executeAsModal so Photoshop's progress dialog appears immediately
            // FILL LAYER + MASK APPROACH: Native Photoshop layer injection
            // Creates solid color fill layers (no pixel pushing) then applies masks
            // This avoids Lab colorspace errors by treating layers as mathematical primitives

            await core.executeAsModal(async (executionContext) => {
                // Phase 4.1: Separate the image (ASYNC with progress)

                // Get dithering setting from UI
                const ditherTypeEl = document.getElementById('ditherType');
                const ditherType = ditherTypeEl ? ditherTypeEl.value : 'none';

                // Get distance metric setting from UI and resolve "auto" if needed
                const distanceMetricEl = document.getElementById('distanceMetric');
                const distanceMetricSetting = distanceMetricEl ? distanceMetricEl.value : 'auto';
                const distanceMetric = resolveDistanceMetric(distanceMetricSetting, lastImageDNA);
                const metricLabels = {
                    'cie76': 'Poster/Graphic (CIE76)',
                    'cie94': 'Photographic (CIE94)',
                    'cie2000': 'Museum Grade (CIE2000)'
                };
                const metricLabel = metricLabels[distanceMetric] || distanceMetric;

                // Get mesh setting from UI (for mesh-aware dithering)
                const meshSizeEl = document.getElementById('meshSize');
                let meshValue = meshSizeEl ? parseInt(meshSizeEl.value, 10) : 0;

                // Handle custom mesh input
                if (meshSizeEl && meshSizeEl.value === 'custom') {
                    const customMeshEl = document.getElementById('customMeshValue');
                    meshValue = customMeshEl ? parseInt(customMeshEl.value, 10) : 0;
                }

                // Get document PPI for mesh-aware dithering calculations
                const preDocInfo = PhotoshopAPI.getDocumentInfo();
                const documentPPI = preDocInfo ? preDocInfo.resolution : 72;

                if (meshValue > 0) {
                    const maxLPI = Math.floor(meshValue / 7);
                    const cellSize = Math.ceil(documentPPI / maxLPI);
                } else {
                }

                // Use original colors for assignment, edited colors for rendering
                // This ensures pixels stay assigned to the same features even if ink colors change
                // Use filtered palettes if colors were soft-deleted
                const layers = await SeparationEngine.separateImage(
                    posterizationData.originalPixels,
                    posterizationData.originalWidth,
                    posterizationData.originalHeight,
                    hexColors,          // Rendering palette (user-edited, filtered)
                    originalHexColors,  // Assignment palette (original discovery, filtered)
                    paletteLab,         // Lab palette (NO RGB→Lab conversion, filtered)
                    {
                        onProgress: (percent) => {
                            // Throttle logging to 25% intervals
                            if (percent % 25 === 0) {
                            }
                        },
                        ditherType: ditherType,
                        mesh: meshValue,
                        ppi: documentPPI,
                        distanceMetric: distanceMetric
                    }
                );


                // Phase 4.2: Create layers in Photoshop

                // Get full-resolution document pixels
                const docInfo = PhotoshopAPI.getDocumentInfo();

                // Re-separate at full resolution (ASYNC with progress)
                fullResPixels = await PhotoshopAPI.getDocumentPixels(docInfo.width, docInfo.height);

                fullResLayers = await SeparationEngine.separateImage(
                    fullResPixels.pixels,
                    fullResPixels.width,
                    fullResPixels.height,
                    hexColors,          // Rendering palette (user-edited, filtered)
                    originalHexColors,  // Assignment palette (original discovery, filtered)
                    paletteLab,         // Lab palette (NO RGB→Lab conversion, filtered)
                    {
                        onProgress: (percent) => {
                            // Throttle logging to 25% intervals
                            if (percent % 25 === 0) {
                            }
                        },
                        ditherType: ditherType,
                        mesh: meshValue,
                        ppi: docInfo.resolution,  // Use full-res document PPI
                        distanceMetric: distanceMetric
                    }
                );

                // Sort layers for screen printing: Light to Dark (Bottom to Top)
                // Substrate always goes at bottom regardless of lightness

                // Separate substrate layer from ink layers
                let substrateLayer = null;
                let inkLayers = [];

                // First pass: identify white and black layers if present
                let whiteLayer = null;
                let blackLayer = null;
                let detectedSubstrateLayer = null;

                // Calculate total pixels for coverage percentage
                const totalPixels = fullResPixels.width * fullResPixels.height;
                const SUBSTRATE_MIN_COVERAGE = 5.0; // Minimum 5% coverage to be considered substrate

                for (const layer of fullResLayers) {
                    // Calculate coverage percentage for this layer
                    // Count non-zero pixels in mask
                    let coveragePixels = 0;
                    for (let i = 0; i < layer.mask.length; i++) {
                        if (layer.mask[i] > 0) coveragePixels++;
                    }
                    const coveragePercent = (coveragePixels / totalPixels) * 100;


                    // Check for pure white (L=100, a=0, b=0)
                    // Tolerance: L > 99 (near white), a/b within 2 (allows for slight tinting)
                    // Requires > 5% coverage to avoid treating highlights as substrate
                    const whiteL = layer.labColor.L > 99;
                    const whiteA = Math.abs(layer.labColor.a - 0) < 2;
                    const whiteB = Math.abs(layer.labColor.b - 0) < 2;
                    const whiteCoverage = coveragePercent >= SUBSTRATE_MIN_COVERAGE;
                    const isWhite = whiteL && whiteA && whiteB && whiteCoverage;

                    if (layer.labColor.L > 95) {
                    }

                    // Check for pure black (L=0, a=0, b=0)
                    // More lenient tolerance: L < 5 (very dark), a/b within 5 (slight color cast ok)
                    // This catches near-black backgrounds that aren't perfectly L=0
                    // Requires > 5% coverage to be considered substrate
                    const blackL = layer.labColor.L < 5;
                    const blackA = Math.abs(layer.labColor.a - 0) < 5;
                    const blackB = Math.abs(layer.labColor.b - 0) < 5;
                    const blackCoverage = coveragePercent >= SUBSTRATE_MIN_COVERAGE;
                    const isBlack = blackL && blackA && blackB && blackCoverage;

                    if (layer.labColor.L < 10) {
                    }

                    // Check for detected substrate from posterization
                    const matchesDetectedSubstrate = selectedPreview.substrateLab &&
                                       Math.abs(layer.labColor.L - selectedPreview.substrateLab.L) < 0.1 &&
                                       Math.abs(layer.labColor.a - selectedPreview.substrateLab.a) < 0.1 &&
                                       Math.abs(layer.labColor.b - selectedPreview.substrateLab.b) < 0.1;

                    if (isWhite) {
                        whiteLayer = layer;
                    } else if (isBlack) {
                        blackLayer = layer;
                    } else if (matchesDetectedSubstrate) {
                        detectedSubstrateLayer = layer;
                    } else {
                        inkLayers.push(layer);
                    }
                }

                // Check if auto-detected substrate indicates white or black paper
                const autoDetectedWhite = selectedPreview.substrateLab && selectedPreview.substrateLab.L > 95;
                const autoDetectedBlack = selectedPreview.substrateLab && selectedPreview.substrateLab.L < 5;

                if (autoDetectedWhite) {
                } else if (autoDetectedBlack) {
                }

                // Determine substrate with priority:
                // 1. If auto-detected is WHITE → use white layer, OR brightest layer if no pure white
                // 2. If auto-detected is BLACK → use black layer
                // 3. Fallback: White Layer > Black Layer > Detected Substrate
                if (autoDetectedWhite) {
                    // White paper detected - use white layer if available, otherwise use brightest layer
                    if (whiteLayer) {
                        substrateLayer = whiteLayer;
                    } else {
                        // Find the brightest layer (highest L) to use as white substrate proxy
                        const allLayers = [...inkLayers];
                        if (blackLayer) allLayers.push(blackLayer);
                        if (detectedSubstrateLayer) allLayers.push(detectedSubstrateLayer);

                        let brightestLayer = null;
                        let brightestL = -1;
                        for (const layer of allLayers) {
                            if (layer.labColor.L > brightestL) {
                                brightestL = layer.labColor.L;
                                brightestLayer = layer;
                            }
                        }

                        if (brightestLayer && brightestL > 85) {
                            // Remove from inkLayers if present
                            const idx = inkLayers.indexOf(brightestLayer);
                            if (idx >= 0) inkLayers.splice(idx, 1);

                            substrateLayer = brightestLayer;
                        } else {
                        }
                    }
                    // Black becomes an ink layer if white is substrate
                    if (blackLayer && substrateLayer !== blackLayer) {
                        if (!inkLayers.includes(blackLayer)) {
                            inkLayers.push(blackLayer);
                        }
                    }
                } else if (whiteLayer) {
                    substrateLayer = whiteLayer;
                    // Black becomes an ink layer if white is substrate
                    if (blackLayer) {
                        inkLayers.push(blackLayer);
                    }
                    // Detected substrate also becomes an ink layer if white takes priority
                    if (detectedSubstrateLayer) {
                        inkLayers.push(detectedSubstrateLayer);
                    } else if (selectedPreview.substrateLab) {
                    }
                } else if (autoDetectedBlack && blackLayer) {
                    // Black paper explicitly detected
                    substrateLayer = blackLayer;
                    if (detectedSubstrateLayer && detectedSubstrateLayer !== blackLayer) {
                        inkLayers.push(detectedSubstrateLayer);
                    }
                } else if (blackLayer) {
                    substrateLayer = blackLayer;
                    // Detected substrate becomes an ink layer if black takes priority
                    if (detectedSubstrateLayer) {
                        inkLayers.push(detectedSubstrateLayer);
                    } else if (selectedPreview.substrateLab) {
                    }
                } else if (detectedSubstrateLayer) {
                    substrateLayer = detectedSubstrateLayer;
                }

                // Sort ink layers by L value: HIGH to LOW (light to dark)
                // In Photoshop stacking: First layer created = bottom, last layer created = top
                // Screen printing order: Light inks print first (bottom), dark inks print last (top)
                // So we create light layers first (high L), dark layers last (low L)
                inkLayers.sort((a, b) => b.labColor.L - a.labColor.L);

                const orderedLayers = [];
                let layerIndex = 0;

                // Substrate ALWAYS at bottom (if it exists)
                if (substrateLayer) {
                    orderedLayers.push(substrateLayer);
                    layerIndex++;
                }

                // Then ink layers sorted by L value (light to dark)
                inkLayers.forEach((layer) => {
                    orderedLayers.push(layer);
                    layerIndex++;
                });
                const doc = PhotoshopAPI.getActiveDocument();
                if (!doc) {
                    throw new Error("No active document");
                }

                // Suspend history to group all layer creation into one undo step
                // Use flag to track if we actually suspended (might already be suspended)
                let suspensionID = null;
                let historySuspendedByUs = false;

                try {
                    suspensionID = await executionContext.hostControl.suspendHistory({
                        documentID: doc.id,
                        name: "Reveal"
                    });
                    historySuspendedByUs = true;
                } catch (err) {
                    // History might already be suspended - log but continue
                }

                try {
                    // CRITICAL: Show all layers before cleanup (might be hidden from previous run)
                    try {
                        for (const layer of doc.layers) {
                            if (!layer.visible) {
                                layer.visible = true;
                            }
                        }
                    } catch (err) {
                        logger.warn(`⚠ Could not show hidden layers: ${err.message}`);
                    }

                    // CRITICAL: Delete all existing separation layers before creating new ones
                    // This prevents duplicates/conflicts when running the plugin multiple times
                    await PhotoshopAPI.deleteAllLayersExceptBackground();

                    // Store reference to the original source layer (what remains after cleanup)
                    // This is the layer we'll hide after creating separation layers
                    // Note: Can't rely on isBackgroundLayer since user might have a regular layer
                    const originalLayer = doc.layers.length > 0 ? doc.layers[doc.layers.length - 1] : null;
                    if (originalLayer) {
                    } else {
                        logger.warn(`⚠ No original layer found after cleanup - this shouldn't happen!`);
                    }

                    // Detect document bit depth to route to appropriate layer creation method
                    const docBitDepth = String(doc.bitsPerChannel).toLowerCase();
                    const is16bit = docBitDepth.includes('16') || doc.bitsPerChannel === 16;

                    let skippedCount = 0;

                    for (let i = 0; i < orderedLayers.length; i++) {
                        const layerData = orderedLayers[i];

                        // Add maskProfile to layerData (from form values)
                        const layerDataWithProfile = {
                            ...layerData,
                            maskProfile: posterizationData.params.maskProfile
                        };

                        // Route to appropriate layer creation method based on bit depth
                        const createdLayer = is16bit
                            ? await PhotoshopAPI.createLabSeparationLayer16Bit(layerDataWithProfile)
                            : await PhotoshopAPI.createLabSeparationLayer(layerDataWithProfile);

                        // Handle skipped layers (empty masks)
                        if (createdLayer === null) {
                            skippedCount++;
                        }
                    }

                    // Warn if many layers were skipped
                    if (skippedCount > 0) {
                        const skipPercent = (skippedCount / orderedLayers.length * 100).toFixed(1);
                        logger.warn(`⚠ Skipped ${skippedCount}/${orderedLayers.length} layers (${skipPercent}%) due to empty masks`);

                        if (skippedCount > orderedLayers.length * 0.2) {
                            logger.error(`⚠⚠ HIGH SKIP RATE: More than 20% of layers skipped!`);
                            logger.error(`   This may indicate a bug in mask generation or palette selection.`);
                        }
                    }

                    // Hide the original source layer so only separation layers are visible
                    try {
                        if (originalLayer) {
                            // Verify layer still exists (wasn't deleted during separation)
                            const layerStillExists = doc.layers.find(l => l.id === originalLayer.id);
                            if (layerStillExists) {
                                originalLayer.visible = false;
                            } else {
                                logger.warn(`⚠ Original layer was deleted during separation`);
                            }
                        } else {
                            logger.warn(`⚠ No original layer reference to hide`);
                        }
                    } catch (err) {
                        logger.warn(`⚠ Could not hide original layer: ${err.message}`);
                    }

                    // Resume history and commit all layer creation as a single "Reveal" state
                    if (historySuspendedByUs && suspensionID !== null) {
                        await executionContext.hostControl.resumeHistory(suspensionID);
                    }
                } catch (error) {
                    // If error occurs, resume history without committing (cancel changes)
                    if (historySuspendedByUs && suspensionID !== null) {
                        await executionContext.hostControl.resumeHistory(suspensionID, false);
                    }
                    throw error;
                }
            }, {
                commandName: "Reveal"
            });


            // CLEANUP: Release resources proactively
            if (fullResPixels && fullResPixels.pixels) {
                fullResPixels.pixels = null;
            }
            fullResLayers.forEach(layer => {
                if (layer.mask) {
                    layer.mask = null;
                }
            });

            // Close palette dialog
            const paletteDialog = document.getElementById('paletteDialog');
            if (paletteDialog) {
                paletteDialog.close();
            }

            // Note: Button stays disabled since dialog is closed
            // It will be reset when dialog reopens

            // Success dialog removed - was originally for golden stats capture
            // Separation complete, dialog closes automatically

        } catch (error) {
            logger.error("Error applying separation:", error);

            // Extract error message - Photoshop errors may not have standard .message property
            let errorMessage = error.message || error.toString() || "An unknown error occurred";

            // Try to extract error code from various sources
            let errorCode = error.number || error.code;

            // If no code property, try to parse from error string
            if (!errorCode && errorMessage.includes("Code:")) {
                const codeMatch = errorMessage.match(/Code:\s*(-?\d+)/);
                if (codeMatch) {
                    errorCode = parseInt(codeMatch[1]);
                }
            }

            // CRITICAL: Detect user cancellation and handle gracefully
            // Photoshop throws error -8007 (userCanceledErr) or messages containing "cancel"
            const isCancellation =
                errorCode === -8007 ||
                errorCode === 8007 ||
                errorMessage.toLowerCase().includes('cancel') ||
                errorMessage.toLowerCase().includes('abort') ||
                errorMessage.toLowerCase().includes('user stopped');

            if (isCancellation) {

                // Just reset button state, don't show error dialog
                btnApply.disabled = false;
                btnApply.textContent = "Separate with this palette →";

                // Exit cleanly without showing error
                return;
            }

            logger.error("Error details:", {
                message: errorMessage,
                code: errorCode,
                stack: error.stack
            });

            let errorDetails = '';
            if (errorCode) {
                errorDetails = `Photoshop Error Code: ${errorCode}`;

                // Add helpful hints for known error codes
                if (errorCode === -25010) {
                    errorDetails += '\n\nThis error may occur with very large images or after multiple operations. Try:\n• Closing and reopening the document\n• Reducing the image size\n• Using fewer colors';
                }
            }

            showErrorDialog(
                "Separation Failed",
                errorMessage,
                errorDetails
            );

            // UNLOCK: Re-enable button after error
            btnApply.disabled = false;
            btnApply.textContent = "Separate with this palette →";
        }
    });

    // Update dialog title
    document.querySelector('.reveal-title').textContent = 'Reveal - Customize Palette & Separate';


    // Note: Diagnostic dimension checks removed - palette editor is now in separate dialog
}


/**
 * Show preview section and hide parameter entry
 */
function showPreviewSection() {
    // WORKAROUND: UXP has layout bugs when toggling visibility
    // Instead of hiding/showing, just forcefully inject inline styles

    // Hide all parameter sections with inline style
    const paramSections = document.querySelectorAll('.form-section');
    paramSections.forEach(section => {
        if (!section.closest('#previewSection')) {
            section.style.display = 'none';
        }
    });

    // Hide info box with inline style
    const infoBox = document.querySelector('.info-box');
    if (infoBox && !infoBox.closest('#previewSection')) {
        infoBox.style.display = 'none';
    }

    // Also hide the version badge from parameter entry
    const versionBadge = document.querySelector('.version-badge');
    if (versionBadge) {
        versionBadge.style.display = 'none';
    }

    // CRITICAL: Set dialog width FIRST so grid has something to calculate from
    const dialog = document.getElementById('mainDialog');
    if (dialog) {
        dialog.style.width = '520px';  // Force explicit width
    } else {
        logger.error("Could not find mainDialog element!");
    }

    // Show preview section with explicit inline styles to force rendering
    const previewSection = document.getElementById('previewSection');
    previewSection.style.display = 'block';
    previewSection.style.width = '100%';
    previewSection.style.minWidth = '400px';

    // Force flexbox layout (UXP has bugs with CSS Grid)
    const previewGrid = document.querySelector('.preview-grid');
    if (previewGrid) {
        previewGrid.style.display = 'flex';
        previewGrid.style.flexWrap = 'wrap';
        previewGrid.style.width = '100%';
        previewGrid.style.minWidth = '400px';
        previewGrid.style.gap = '16px';
    }

    // Force preview items to have dimensions (flexbox 2-column)
    const previewItems = document.querySelectorAll('.preview-item');
    previewItems.forEach(item => {
        item.style.minHeight = '150px';
        item.style.flex = '0 0 calc(50% - 8px)';
        item.style.width = 'calc(50% - 8px)';
        item.style.maxWidth = 'calc(50% - 8px)';
        item.style.padding = '12px';
        item.style.border = '2px solid #e1e1e1';
        item.style.borderRadius = '6px';
        item.style.background = '#fafafa';
    });

    // Hide Next button, show Use Colors button
    document.getElementById('btnNext').style.display = 'none';
    document.getElementById('btnUseColors').style.display = 'block';

    // Update dialog title
    document.querySelector('.reveal-title').textContent = 'Reveal - Color Selection';
    document.querySelector('.version-badge').textContent = 'Phase 2.5: Posterization Preview';
}

/**
 * Display posterization previews
 */
function displayPreviews(originalPixels, originalWidth, originalHeight, previews, docInfo) {

    // Remove preview images (UXP limitation - canvas.toDataURL() not supported)
    // Just hide them to avoid layout collapse
    const previewOriginal = document.getElementById('previewOriginal');
    const preview3 = document.getElementById('preview3');
    const preview5 = document.getElementById('preview5');
    const preview7 = document.getElementById('preview7');

    if (previewOriginal) previewOriginal.style.display = 'none';
    if (preview3) preview3.style.display = 'none';
    if (preview5) preview5.style.display = 'none';
    if (preview7) preview7.style.display = 'none';

    // Display document info
    document.getElementById('originalInfo').textContent =
        `${docInfo.width} × ${docInfo.height}px (${docInfo.colorMode}, ${docInfo.bitDepth})`;

    // CRITICAL WORKAROUND: Show preview section FIRST, then create swatches
    // UXP refuses to render dynamically created content in hidden containers
    showPreviewSection();

    // Display posterized previews - show color palettes
    previews.forEach(preview => {

        // Display color palette swatches
        const paletteDiv = document.getElementById(`palette${preview.colorCount}`);
        if (!paletteDiv) {
            logger.error(`Palette div not found: palette${preview.colorCount}`);
            return;
        }


        // WORKAROUND: UXP layout bug with createElement/appendChild
        // Use innerHTML injection instead - renders everything in one pass
        const swatchesHTML = preview.hexColors.map(hex => `
            <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
                <div class="color-swatch"
                     style="width: 48px; height: 48px; min-width: 48px; min-height: 48px;
                            background-color: ${hex}; border: 1px solid #cacaca;
                            border-radius: 3px; box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.1);
                            display: block;"
                     title="${hex}">
                </div>
                <div style="font-size: 10px; text-align: center; margin-top: 4px; color: #323232;">
                    ${hex}
                </div>
            </div>
        `).join('');

        paletteDiv.innerHTML = swatchesHTML;

    });


    // Debug: Check if preview grid is visible
    const dialog = document.getElementById('mainDialog');
    const previewGrid = document.querySelector('.preview-grid');
    const previewSection = document.getElementById('previewSection');
    const previewItems = document.querySelectorAll('.preview-item');


    previewItems.forEach((item, i) => {
        const styles = window.getComputedStyle(item);
    });

    // Check if grid items have the palette divs populated
    const palette3 = document.getElementById('palette3');
    const palette5 = document.getElementById('palette5');
    const palette7 = document.getElementById('palette7');


    // Check swatch dimensions
    if (palette3.children.length > 0) {
        const firstSwatch = palette3.children[0].querySelector('.color-swatch');
        if (firstSwatch) {
        }
    }
}

/**
 * Get current form values
 */
function getFormValues() {
    return {
        targetColors: parseInt(document.getElementById("targetColorsSlider").value),
        preserveWhite: document.getElementById("preserveWhite")?.checked ?? false,
        preserveBlack: document.getElementById("preserveBlack")?.checked ?? false,
        ignoreTransparent: document.getElementById("ignoreTransparent")?.checked ?? true,
        enableHueGapAnalysis: document.getElementById("enableHueGapAnalysis")?.checked ?? true,  // Hue diversity (default ON)
        maskProfile: document.getElementById("maskProfile")?.value ?? "Gray Gamma 2.2",
        engineType: document.getElementById("engineType")?.value ?? "reveal-mk1.5",  // Engine selection
        centroidStrategy: document.getElementById("centroidStrategy")?.value ?? "SALIENCY",  // Centroid strategy (SALIENCY or VOLUMETRIC)
        colorMode: document.getElementById("colorMode")?.value ?? "color",  // Color or B/W mode
        substrateMode: document.getElementById("substrateMode")?.value ?? "white",  // Substrate awareness
        substrateTolerance: parseFloat(document.getElementById("substrateTolerance")?.value ?? 3.5),  // ΔE threshold
        vibrancyMode: document.getElementById("vibrancyMode")?.value ?? "moderate",  // Vibrancy algorithm
        vibrancyBoost: parseFloat(document.getElementById("vibrancyBoost")?.value ?? 1.6),  // Fixed vibrancy multiplier (split.vibrancyBoost)
        highlightThreshold: parseInt(document.getElementById("highlightThreshold")?.value ?? 85),  // White point (prune.whitePoint)
        highlightBoost: parseFloat(document.getElementById("highlightBoost")?.value ?? 1.0),  // Highlight boost (split.highlightBoost)
        hueLockAngle: parseFloat(document.getElementById("hueLockAngle")?.value ?? 20),  // Hue lock angle (prune.hueLockAngle)
        shadowPoint: parseFloat(document.getElementById("shadowPoint")?.value ?? 15),  // Shadow point (prune.shadowPoint)
        lWeight: parseFloat(document.getElementById("lWeight")?.value ?? 1.0),  // Saliency L-weight (centroid.lWeight)
        cWeight: parseFloat(document.getElementById("cWeight")?.value ?? 1.0),  // Saliency C-weight (centroid.cWeight)
        blackBias: parseFloat(document.getElementById("blackBias")?.value ?? 5.0),  // Black bias (centroid.blackBias)
        enablePaletteReduction: document.getElementById("enablePaletteReduction")?.checked ?? true,  // Enable/disable palette reduction
        paletteReduction: parseFloat(document.getElementById("paletteReduction")?.value ?? 10.0),  // Color merging threshold (prune.threshold)
        // Dithering settings
        ditherType: document.getElementById("ditherType")?.value ?? "none",  // Dithering algorithm
        // Mesh-aware dithering settings
        mesh: getMeshValue(),  // Screen mesh TPI (0 = pixel-level)
        ppi: PhotoshopAPI.getDocumentInfo()?.resolution || 72,  // Document PPI for mesh calculations
        // Distance metric for color matching
        distanceMetric: document.getElementById("distanceMetric")?.value ?? "cie94",  // 'cie76' (Graphic) or 'cie94' (Photographic)
        // Preprocessing (noise reduction)
        preprocessingIntensity: document.getElementById("preprocessingIntensity")?.value ?? "auto",  // 'off', 'auto', 'light', 'heavy'
        // Production Quality Controls (Archetype Overrides)
        minVolume: parseFloat(document.getElementById("minVolume")?.value ?? 0),  // Ghost plate removal (0-5%)
        speckleRescue: parseInt(document.getElementById("speckleRescue")?.value ?? 0),  // Halftone cleanup (0-10px)
        shadowClamp: parseFloat(document.getElementById("shadowClamp")?.value ?? 0)  // Ink density floor (0-20%)
    };
}

/**
 * Get mesh value from UI, handling custom input
 * @returns {number} Mesh TPI (0 = pixel-level)
 */
function getMeshValue() {
    const meshSelect = document.getElementById("meshSize");
    if (!meshSelect) return 0;

    if (meshSelect.value === "custom") {
        const customInput = document.getElementById("customMeshValue");
        return customInput ? parseInt(customInput.value, 10) || 0 : 0;
    }

    return parseInt(meshSelect.value, 10) || 0;
}

/**
 * Slider configuration for value display formatting
 * Used by both dialog initialization and preset/analysis application
 */
const sliderConfigs = [
    { id: 'substrateTolerance', format: v => v.toFixed(1) },
    { id: 'lWeight', format: v => v.toFixed(1) },
    { id: 'cWeight', format: v => v.toFixed(1) },
    { id: 'blackBias', format: v => v.toFixed(1) },
    { id: 'vibrancyBoost', format: v => v.toFixed(1) },
    { id: 'highlightThreshold', format: v => v.toFixed(0) },
    { id: 'highlightBoost', format: v => v.toFixed(1) },
    { id: 'paletteReduction', format: v => v.toFixed(1) },
    { id: 'hueLockAngle', format: v => v.toFixed(0) },
    { id: 'shadowPoint', format: v => v.toFixed(0) },
    { id: 'targetColorsSlider', valueId: 'targetColorsValue', format: v => v.toFixed(0) },
    // Production Quality Controls
    { id: 'minVolume', format: v => v.toFixed(1) },
    { id: 'speckleRescue', format: v => v.toFixed(0) },
    { id: 'shadowClamp', format: v => v.toFixed(1) }
];

/**
 * Map analyzer parameter names to actual form element IDs
 *
 * @param {Object} analyzerSettings - Settings from ImageHeuristicAnalyzer
 * @returns {Object} - Mapped settings with correct form IDs
 */
function mapAnalyzerSettings(analyzerSettings) {
    const mapped = { ...analyzerSettings };

    // Rename mappings
    if ('whitePoint' in mapped) {
        mapped.highlightThreshold = mapped.whitePoint;
        delete mapped.whitePoint;
    }

    if ('blackPoint' in mapped) {
        mapped.shadowPoint = mapped.blackPoint;
        delete mapped.blackPoint;
    }

    if ('snapThreshold' in mapped) {
        mapped.paletteReduction = mapped.snapThreshold;
        delete mapped.snapThreshold;
    }

    return mapped;
}

/**
 * Apply analyzed settings to form controls
 * Follows same pattern as Reset to Defaults handler
 *
 * @param {Object} settings - Settings object with form IDs as keys
 */
function applyAnalyzedSettings(settings) {

    Object.keys(settings).forEach(key => {
        const element = document.getElementById(key);
        if (!element) {
            return;
        }

        const value = settings[key];

        try {
            if (element.type === 'checkbox') {
                // Checkboxes: Just set the checked state, no event dispatch needed
                // UXP checkboxes update visually without requiring events
                element.checked = value;

            } else if (element.tagName === 'SELECT') {
                element.value = value;
                element.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value } }));

            } else if (element.tagName === 'SP-SLIDER') {
                element.value = value;

                // Update value display label
                const valueDisplay = document.getElementById(`${key}Value`);
                if (valueDisplay) {
                    // Find slider config for formatting
                    const config = sliderConfigs.find(c => c.id === key);
                    if (config) {
                        valueDisplay.textContent = config.format(value);
                    } else {
                        valueDisplay.textContent = value.toString();
                    }
                }

                // Trigger events with CustomEvent to ensure detail property exists
                element.dispatchEvent(new CustomEvent('input', { bubbles: true, detail: { value } }));
                element.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value } }));
            }
        } catch (error) {
            logger.error(`Failed to apply setting ${key}=${value}:`, error);
        }
    });

}

/**
 * Load all presets from JSON files
 * Note: Must be hardcoded for UXP/browser environment (no fs module)
 * To add a preset: Add require() line below AND add JSON file to reveal-core/presets/
 */
const PARAMETER_PRESETS = {
    'standard-image': require('@reveal/core/presets/standard-image.json'),
    'halftone-portrait': require('@reveal/core/presets/halftone-portrait.json'),
    'vibrant-graphic': require('@reveal/core/presets/vibrant-graphic.json'),
    'atmospheric-photo': require('@reveal/core/presets/atmospheric-photo.json'),
    'pastel-high-key': require('@reveal/core/presets/pastel-high-key.json'),
    'vintage-muted': require('@reveal/core/presets/vintage-muted.json'),
    'deep-shadow-noir': require('@reveal/core/presets/deep-shadow-noir.json'),
    'neon-fluorescent': require('@reveal/core/presets/neon-fluorescent.json'),
    'textural-grunge': require('@reveal/core/presets/textural-grunge.json'),
    'commercial-offset': require('@reveal/core/presets/commercial-offset.json'),
    'minkler-justice': require('@reveal/core/presets/minkler-justice.json'),
    'warhol-pop': require('@reveal/core/presets/warhol-pop.json'),
    'technical-enamel': require('@reveal/core/presets/technical-enamel.json'),
    'punchy-commercial': require('@reveal/core/presets/punchy-commercial.json'),
    'cinematic-moody': require('@reveal/core/presets/cinematic-moody.json')
};

// Validate presets on load
Object.keys(PARAMETER_PRESETS).forEach(id => {
    const preset = PARAMETER_PRESETS[id];
    if (!preset.id || !preset.name || !preset.settings) {
        logger.error(`Invalid preset: ${id} - missing required fields`);
    }
});

/**
 * ARCHETYPES - DNA-driven parameter baselines
 * Each archetype contains complete 30-parameter specifications
 * Note: Must be hardcoded for UXP/browser environment (no fs module)
 *
 * ALL 19 DNA v2.0 ARCHETYPES (Updated 2026-02-05 - Added Jethro Monroe Clinical)
 */
const ARCHETYPES = {
    // Core archetypes (DNA v2.0 optimized)
    'subtle-naturalist': require('@reveal/core/archetypes/subtle-naturalist.json'),
    'structural-outlier-rescue': require('@reveal/core/archetypes/structural-outlier-rescue.json'),
    'blue-rescue': require('@reveal/core/archetypes/blue-rescue.json'),
    'silver-gelatin': require('@reveal/core/archetypes/silver-gelatin.json'),
    'neon-graphic': require('@reveal/core/archetypes/neon-graphic.json'),
    'cinematic-moody': require('@reveal/core/archetypes/cinematic-moody.json'),
    'muted-vintage': require('@reveal/core/archetypes/muted-vintage.json'),
    'pastel-high-key': require('@reveal/core/archetypes/pastel-high-key.json'),
    'noir-shadow': require('@reveal/core/archetypes/noir-shadow.json'),
    'pure-graphic': require('@reveal/core/archetypes/pure-graphic.json'),
    'vibrant-tonal': require('@reveal/core/archetypes/vibrant-tonal.json'),
    'warm-tonal-optimized': require('@reveal/core/archetypes/warm-tonal-optimized.json'),
    'thermonuclear-yellow': require('@reveal/core/archetypes/thermonuclear-yellow.json'),
    'soft-ethereal': require('@reveal/core/archetypes/soft-ethereal.json'),
    'hard-commercial': require('@reveal/core/archetypes/hard-commercial.json'),
    'bright-desaturated': require('@reveal/core/archetypes/bright-desaturated.json'),
    'jethro-monroe-clinical': require('@reveal/core/archetypes/jethro-monroe-clinical.json'),

    // Legacy archetypes (backward compatibility)
    'vibrant-hyper': require('@reveal/core/archetypes/vibrant-hyper.json'),
    'standard-balanced': require('@reveal/core/archetypes/standard-balanced.json')
};

// Validate archetypes on load
Object.keys(ARCHETYPES).forEach(id => {
    const archetype = ARCHETYPES[id];
    if (!archetype.id || !archetype.name || !archetype.parameters) {
        logger.error(`Invalid archetype: ${id} - missing required fields`);
    }
});

/**
 * Validate form inputs
 */
function validateForm() {
    const values = getFormValues();
    const errors = [];

    // Validate target colors range (must be between 1-20)
    if (values.targetColors < 1 || values.targetColors > 20) {
        errors.push("Target Colors must be between 1 and 20");
    }

    // Color distance is always valid (radio button always has selection)

    return errors;
}

/**
 * Setup zoom preview dialog controls
 */
function setupZoomPreviewControls() {
    if (!zoomPreviewState) {
        logger.error("Cannot setup zoom preview controls - state not initialized");
        return;
    }

    const { renderer, docWidth, docHeight } = zoomPreviewState;

    // Get UI elements
    const btnClose = document.getElementById('btnZoomClose');
    const zoomDialog = document.getElementById('zoomPreviewDialog');
    const zoomTileImg = document.getElementById('zoomTileImg');
    const zoomDownsampleFactor = document.getElementById('zoomDownsampleFactor');
    const viewportContainer = document.getElementById('zoomViewportContainer');

    const panStep = 100; // Pan distance for arrow keys (reduced for finer control)

    // Resolution dropdown - controls how much area is visible
    if (zoomDownsampleFactor) {
        // Set to 1:1 by default (resolution already set to 1 in constructor)
        zoomDownsampleFactor.value = '1';

        zoomDownsampleFactor.addEventListener('change', async (e) => {
            const resolution = parseInt(e.target.value);

            // Show busy cursor on viewport
            if (viewportContainer) {
                viewportContainer.style.cursor = 'wait';
            }
            zoomDownsampleFactor.disabled = true;

            try {
                // Use focal-point zoom to center of viewport to prevent re-centering
                const centerX = renderer.width / 2;
                const centerY = renderer.height / 2;
                await renderer.setResolutionAtPoint(resolution, centerX, centerY);
            } finally {
                // Restore cursor
                if (viewportContainer) {
                    viewportContainer.style.cursor = '';
                }
                zoomDownsampleFactor.disabled = false;
            }
        });

    }

    // Wheel zoom-to-cursor
    if (viewportContainer) {
        viewportContainer.addEventListener('wheel', async (e) => {
            e.preventDefault();

            const resolutions = [1, 2, 4, 8];
            let currentIndex = resolutions.indexOf(renderer.resolution);

            // Scroll down = zoom out, scroll up = zoom in
            const zoomDirection = e.deltaY > 0 ? 1 : -1;
            let nextIndex = currentIndex + zoomDirection;

            if (nextIndex < 0 || nextIndex >= resolutions.length) return;

            const nextRes = resolutions[nextIndex];

            // Get mouse position relative to viewport
            const rect = viewportContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            // Zoom to cursor position
            await renderer.setResolutionAtPoint(nextRes, mouseX, mouseY);

            // Update dropdown to match
            if (zoomDownsampleFactor) {
                zoomDownsampleFactor.value = nextRes;
            }
        }, { passive: false });

    }

    // Mouse drag panning
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

            // Progressive pan and render (isRendering guard prevents overwhelming)
            // Only update if we've moved at least 5px to avoid excessive calls
            if (Math.abs(deltaX) >= 5 || Math.abs(deltaY) >= 5) {
                renderer.pan(deltaX, deltaY);
                renderer.fetchAndRender(); // Will return immediately if already rendering

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

    // Recenter button (Home key)
    document.addEventListener('keydown', (e) => {
        if (!zoomDialog || !zoomDialog.open) return;

        if (e.code === 'Home') {
            e.preventDefault();
            // Center viewport on document
            renderer.viewportX = (renderer.docWidth / renderer.resolution - renderer.width) / 2;
            renderer.viewportY = (renderer.docHeight / renderer.resolution - renderer.height) / 2;
            renderer.applyBounds();
            renderer.fetchAndRender();

        }
    });

    // Close button
    if (btnClose) {
        btnClose.addEventListener('click', () => {
            if (zoomDialog) {
                zoomDialog.close();
            }

            // Cleanup
            if (renderer) {
                renderer.clearCache();
            }
            zoomPreviewState = null;

        });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', async (e) => {
        if (!zoomDialog || !zoomDialog.open) return;

        // Arrow keys: Pan viewport and re-fetch
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

        // Escape: Close
        if (e.code === 'Escape') {
            e.preventDefault();
            btnClose?.click();
        }
    });
}

/**
 * Handle Analyze Image - Extract DNA and configure parameters
 * Used by both btnAnalyzeAndSet and archetype selector dropdown
 */
async function handleAnalyzeImage() {

    try {
        // Get Lab pixels from current document (800px for analysis)
        const result = await core.executeAsModal(async () => {
            const pixelData = await PhotoshopAPI.getDocumentPixels(800, 800);
            return {
                pixels: pixelData.pixels,  // Lab bytes (Uint8ClampedArray, 3 bytes per pixel)
                width: pixelData.width,
                height: pixelData.height
            };
        }, { commandName: "Analyze Document DNA" });


        // Generate DNA from Lab pixels
        const startTime = Date.now();
        const dna = DNAGenerator.generate(result.pixels, result.width, result.height, 40);
        const dnaTime = Date.now() - startTime;


        // Run ParameterGenerator to get dynamic configuration (with entropy analysis)
        // Pass manualArchetypeId if user has manually selected an archetype
        const config = ParameterGenerator.generate(dna, {
            imageData: result.pixels,
            width: result.width,
            height: result.height,
            preprocessingIntensity: 'auto',  // Let entropy analysis decide
            manualArchetypeId: lastSelectedArchetypeId  // Bypass DNA matching if manual selection
        });

        // Log preprocessing decision from entropy analysis
        if (config.preprocessing) {
            const pp = config.preprocessing;
            if (pp.entropyScore !== undefined) {
            }
        }

        // Store DNA and complete config globally for "Smart Reveal" and posterization
        lastImageDNA = {
            ...dna,
            archetype: config.meta?.archetype || null,
            preprocessing: config.preprocessing  // Store preprocessing config for posterization
        };
        // Store complete config including all parameters (even those not in UI)
        lastGeneratedConfig = config;

        // Determine preprocessing dropdown value based on analysis
        // Show the actual decision so user knows what will happen
        let preprocessingDropdownValue = 'off';  // Default if no config
        if (config.preprocessing) {
            if (config.preprocessing.enabled) {
                // Show the actual intensity (light or heavy)
                preprocessingDropdownValue = config.preprocessing.intensity || 'light';
            } else {
                // Analysis says no preprocessing needed
                preprocessingDropdownValue = 'off';
            }
        }

        // Map ALL parameters to UI elements from Expert System Configurator
        // ParameterGenerator now provides full parameter mapping
        // Parameters without UI elements will be logged and skipped by applyAnalyzedSettings()
        const uiSettings = {
            // Core posterization (DNA-driven)
            targetColorsSlider: config.targetColors,
            ditherType: config.ditherType,
            distanceMetric: config.distanceMetric || 'auto',  // Use config value or auto

            // Saliency weights (DNA-driven)
            lWeight: config.lWeight,
            cWeight: config.cWeight,
            blackBias: config.blackBias,

            // Vibrancy settings (DNA-driven)
            vibrancyMode: config.vibrancyMode,
            vibrancyBoost: config.vibrancyBoost,
            vibrancyThreshold: config.vibrancyThreshold,  // May not have UI element

            // Highlight protection (DNA-driven)
            highlightThreshold: config.highlightThreshold,
            highlightBoost: config.highlightBoost,

            // Color merging (DNA-driven)
            enablePaletteReduction: config.enablePaletteReduction !== false,
            paletteReduction: config.paletteReduction,

            // Substrate (DNA-driven)
            substrateMode: config.substrateMode,
            substrateTolerance: config.substrateTolerance || 3.5,

            // Neutral sovereignty (DNA-driven, may not have UI elements)
            neutralSovereigntyThreshold: config.neutralSovereigntyThreshold,
            neutralCentroidClampThreshold: config.neutralCentroidClampThreshold,

            // Preprocessing (entropy-driven)
            preprocessingIntensity: config.preprocessingIntensity || preprocessingDropdownValue,

            // Additional parameters from config
            engineType: config.engineType || 'reveal-mk1.5',
            centroidStrategy: config.centroidStrategy || 'SALIENCY',
            hueLockAngle: config.hueLockAngle || 20,
            shadowPoint: config.shadowPoint || 15,
            colorMode: config.colorMode || 'color',
            preserveWhite: config.preserveWhite !== false,
            preserveBlack: config.preserveBlack !== false,
            ignoreTransparent: config.ignoreTransparent !== false,
            enableHueGapAnalysis: config.enableHueGapAnalysis !== false,
            maskProfile: config.maskProfile || 'Gray Gamma 2.2'
        };


        // Apply ALL DNA-based settings to UI
        applyAnalyzedSettings(uiSettings);

        // Compute what Smart Reveal would use
        const smartMetric = resolveDistanceMetric('auto', lastImageDNA);
        const smartMetricLabels = { 'cie76': 'Poster/Graphic', 'cie94': 'Photographic', 'cie2000': 'Museum Grade' };
        const smartMetricLabel = smartMetricLabels[smartMetric] || smartMetric;

        // Format preprocessing info for alert
        let preprocessingInfo = 'Off';
        if (config.preprocessing) {
            if (config.preprocessing.enabled) {
                const entropy = config.preprocessing.entropyScore?.toFixed(0) || '?';
                preprocessingInfo = `${config.preprocessing.intensity} (entropy: ${entropy})`;
            } else {
                preprocessingInfo = `Skipped (${config.preprocessing.reason})`;
            }
        }

        // Show simple alert to user
        const alertMsg = `Image Analysis Complete\n\nProfile: ${config.name}\nArchetype: ${config.meta?.archetype || 'Unknown'}\nColors: ${config.targetColors}\nDither: ${config.ditherType}\nPreprocessing: ${preprocessingInfo}\n\nParameters have been configured.\nClick "Posterize" to generate separations.`;

        // Log full details to console

        alert(alertMsg);


        // Update archetype selector to show "auto" since we just analyzed
        const archetypeSelector = document.getElementById("archetypeSelector");
        if (archetypeSelector) {
            archetypeSelector.value = 'auto';
        }

    } catch (error) {
        logger.error("Image analysis failed:", error);
        alert(
            `Image analysis failed:\n\n${error.message}\n\n` +
            `Please ensure a document is open and try again.`
        );
    }
}

/**
 * Show the main dialog
 */
async function showDialog() {
    try {
        const dialog = document.getElementById("mainDialog");

        if (!dialog) {
            logger.error("Dialog element not found! DOM might not be ready.");
            throw new Error("Dialog element not found");
        }


        // CRITICAL: Validate document BEFORE showing dialog
        const validation = PhotoshopAPI.validateDocument();

        if (!validation.valid) {

            // Use alert instead of modal dialog to avoid UXP crashes during entrypoint
            const errorMessage = "Your document doesn't meet the requirements for Reveal:\n\n" +
                validation.errors.map((err, i) => `${i + 1}. ${err}`).join('\n');
            alert(errorMessage);

            return; // Don't open dialog
        }


        // CRITICAL: Reset UI state to initial view (parameter entry)
        // This ensures re-invoking the plugin starts fresh

        // Show parameter entry section wrapper
        const parameterEntrySection = document.getElementById('parameterEntrySection');
        if (parameterEntrySection) {
            parameterEntrySection.style.display = 'block';
        }

        // Show version badge
        const versionBadge = document.querySelector('.version-badge');
        if (versionBadge) {
            versionBadge.style.display = '';
            versionBadge.textContent = 'Phase 2: Parameter Entry';
        }

        // Hide auto-detect section
        document.getElementById('autoDetectSection').style.display = 'none';
        // Note: paletteEditorSection is now in a separate dialog (paletteDialog)

        // Show Posterize button (other buttons are in paletteDialog)
        const btnPosterize = document.getElementById('btnPosterize');
        if (btnPosterize) btnPosterize.style.display = '';

        // Note: btnApplySeparation and btnBack are now in paletteDialog, not mainDialog

        // Reset dialog title
        document.querySelector('.reveal-title').textContent = 'Reveal - Posterization Parameters';

        // Clear posterization data from previous session
        posterizationData = null;

        // Clear preview state from previous session
        if (window.previewState) {
            window.previewState = null;
        }


        // CRITICAL: Set up event listeners BEFORE showing dialog
        // showModal() blocks until dialog closes, so code after it won't run until then!
        // Only attach listeners once to prevent accumulation on dialog reopen
        if (!listenersAttached) {

            // Set up collapsible sections
            const sectionTitles = document.querySelectorAll('.section-title');
            sectionTitles.forEach(title => {
                title.addEventListener('click', () => {
                    const section = title.parentElement;
                    section.classList.toggle('collapsed');
                    title.classList.toggle('collapsed');
                });
            });

            // Set up mesh dropdown (show/hide custom input)
            const meshSizeSelect = document.getElementById('meshSize');
            const customMeshInput = document.getElementById('customMeshInput');
            if (meshSizeSelect && customMeshInput) {
                meshSizeSelect.addEventListener('change', () => {
                    if (meshSizeSelect.value === 'custom') {
                        customMeshInput.style.display = 'block';
                        const customMeshValue = document.getElementById('customMeshValue');
                        if (customMeshValue) customMeshValue.focus();
                    } else {
                        customMeshInput.style.display = 'none';
                    }
                });
            }

            // Set up preview item selection
            const previewItems = document.querySelectorAll('.preview-item[data-color-count]');
            previewItems.forEach(item => {
                item.addEventListener('click', (event) => {
                    const colorCount = item.dataset.colorCount;
                    const radio = document.getElementById(`color${colorCount}`);

                    // Update selection state
                    previewItems.forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    radio.checked = true;

                });
            });

            // Set up Cancel button
            const btnCancel = document.getElementById("btnCancel");
            if (btnCancel) {
                btnCancel.addEventListener("click", () => {
                    dialog.close();
                });
            }

            // Set up Cancel button in palette dialog
            const btnPaletteCancel = document.getElementById("btnPaletteCancel");
            if (btnPaletteCancel) {
                btnPaletteCancel.addEventListener("click", () => {

                    // Cleanup zoom renderer if in zoom mode
                    if (window.previewState && window.previewState.viewMode === 'zoom') {
                        detachPreviewZoomHandlers();

                        if (window.previewState.zoomRenderer) {
                            // Clear quality timeout
                            if (window.previewState.zoomRenderer.qualityTimeout) {
                                clearTimeout(window.previewState.zoomRenderer.qualityTimeout);
                            }

                            // Dispose pixel data
                            if (window.previewState.zoomRenderer.activePixelData &&
                                window.previewState.zoomRenderer.activePixelData.imageData) {
                                window.previewState.zoomRenderer.activePixelData.imageData.dispose();
                            }

                            window.previewState.zoomRenderer = null;
                        }
                    }

                    const paletteDialog = document.getElementById('paletteDialog');
                    if (paletteDialog) {
                        paletteDialog.close();
                    }
                });
            }

            // Set up Back button (goes from palette editor back to posterization settings)
            const btnBack = document.getElementById("btnBack");
            if (btnBack) {
                btnBack.addEventListener("click", () => {

                    // Cleanup zoom renderer if in zoom mode
                    if (window.previewState && window.previewState.viewMode === 'zoom') {
                        detachPreviewZoomHandlers();

                        if (window.previewState.zoomRenderer) {
                            // Clear quality timeout
                            if (window.previewState.zoomRenderer.qualityTimeout) {
                                clearTimeout(window.previewState.zoomRenderer.qualityTimeout);
                            }

                            // Dispose pixel data
                            if (window.previewState.zoomRenderer.activePixelData &&
                                window.previewState.zoomRenderer.activePixelData.imageData) {
                                window.previewState.zoomRenderer.activePixelData.imageData.dispose();
                            }

                            window.previewState.zoomRenderer = null;
                        }
                    }

                    // Close palette dialog
                    const paletteDialog = document.getElementById('paletteDialog');
                    if (paletteDialog) {
                        paletteDialog.close();
                    }

                    // Show Posterize button (it was hidden when palette editor opened)
                    const btnPosterize = document.getElementById('btnPosterize');
                    if (btnPosterize) {
                        btnPosterize.style.display = '';
                    }

                    // Reopen main dialog with size options (NON-MODAL for LAB slider access)
                    const mainDialog = document.getElementById('mainDialog');
                    if (mainDialog) {
                        mainDialog.show({
                            resize: "both",
                            size: {
                                width: 620,
                                height: 700,
                                minWidth: 580,
                                minHeight: 500,
                                maxWidth: 750,
                                maxHeight: 900
                            }
                        });
                    }

                    // Note: Keep posterizationData intact so user doesn't lose their work
                    // They can modify settings and re-posterize if desired

                });
            }

            // Set up Run Mask Tests button
            // Set up Pixel Data Mask Test button (alpha channel → selection → mask)
            const btnRunNetwisdomTests = document.getElementById("btnRunNetwisdomTests");
            if (btnRunNetwisdomTests) {
                btnRunNetwisdomTests.addEventListener("click", async () => {
                    btnRunNetwisdomTests.disabled = true;
                    btnRunNetwisdomTests.textContent = "Running Test...";

                    try {
                        // Import test suite
                        const { runAllNetwisdomTests } = require('./tests/netwisdom-mask-test');

                        // Run test (pixel data → alpha channel → selection → mask)
                        const results = await runAllNetwisdomTests();

                        // Show results summary
                        if (results.passed === results.total) {
                            showSuccessDialog(
                                2,  // 2 layers created
                                { hexColors: [] },  // dummy preview
                                0,
                                `✓ Overlapping layers test passed!\n\nCheck Photoshop:\n- RED circle layer with mask\n- GREEN rectangle layer with mask\n- Masks show correct patterns\n\nThis approach WORKS!\nSelection → revealSelection creates perfect masks!`
                            );
                        } else {
                            showErrorDialog(
                                "Test Failed",
                                "Overlapping layers test failed",
                                "Check console for error details"
                            );
                        }
                    } catch (error) {
                        logger.error("Test execution failed:", error);
                        showErrorDialog(
                            "Test Error",
                            error.message,
                            "Check console for details"
                        );
                    } finally {
                        btnRunNetwisdomTests.disabled = false;
                        btnRunNetwisdomTests.textContent = "🔬 Test Pixel Data Mask";
                    }
                });
            }

            // Set up Lab Uniformity Test button
            const btnTestLabUniformity = document.getElementById("btnTestLabUniformity");
            if (btnTestLabUniformity) {
                btnTestLabUniformity.addEventListener("click", async () => {
                    btnTestLabUniformity.disabled = true;
                    btnTestLabUniformity.textContent = "Running Test...";

                    try {
                        const width = 100;
                        const height = 100;
                        const testLab = { L: 204, a: 128, b: 128 };

                        // 1. Create Lab document
                        await action.batchPlay([{
                            "_obj": "make",
                            "_target": [{ "_ref": "document" }],
                            "documentPreset": {
                                "_obj": "documentPreset",
                                "width": { "_unit": "pixelsUnit", "_value": width },
                                "height": { "_unit": "pixelsUnit", "_value": height },
                                "resolution": { "_unit": "densityUnit", "_value": 72 },
                                "mode": { "_class": "mode", "_value": "labColorMode" },
                                "depth": 8,
                                "fill": { "_class": "fill", "_value": "white" }
                            }
                        }], {});

                        const doc = app.activeDocument;

                        // 2. Write UNIFORM Lab data
                        const labData = new Uint8Array(width * height * 3);
                        for (let i = 0; i < width * height; i++) {
                            const idx = i * 3;
                            labData[idx] = testLab.L;
                            labData[idx + 1] = testLab.a;
                            labData[idx + 2] = testLab.b;
                        }

                        const imageData = await imaging.createImageDataFromBuffer(labData, {
                            width, height, components: 3, chunky: true, colorSpace: "Lab"
                        });

                        await imaging.putPixels({
                            layerID: doc.layers[0].id,
                            imageData: imageData,
                            replace: true
                        });

                        imageData.dispose();

                        // 3. Read it back
                        const pixelData = await imaging.getPixels({
                            documentID: doc.id,
                            componentSize: 8,
                            targetComponentCount: 3,
                            colorSpace: "Lab"
                        });

                        let readData;
                        if (pixelData.imageData) {
                            readData = await pixelData.imageData.getData({ chunky: true });
                        } else if (pixelData.pixels) {
                            readData = pixelData.pixels;
                        }

                        // 4. Check uniformity
                        const uniqueValues = new Set();
                        for (let i = 0; i < width * height; i++) {
                            const idx = i * 3;
                            const val = `${readData[idx]},${readData[idx + 1]},${readData[idx + 2]}`;
                            uniqueValues.add(val);
                        }


                        // Log the values for debugging
                        if (uniqueValues.size <= 10) {
                        }

                        // 5. Close document (may fail if already closed)
                        try {
                            await doc.close();
                        } catch (closeError) {
                        }

                        // Show results
                        if (uniqueValues.size === 1) {
                            const resultValue = Array.from(uniqueValues)[0];
                            showSuccessDialog(
                                0, { hexColors: [] }, 0,
                                `✓ Lab Uniformity Test PASSED!\n\nWrote uniform Lab values\nRead back: ${uniqueValues.size} unique value\nValue: ${resultValue}\n\n✅ Photoshop preserves Lab uniformity!\n\nThis means the dithering in your PSD was introduced during its creation, not during reading.`
                            );
                        } else {
                            const values = Array.from(uniqueValues).slice(0, 5).join('\n  ');
                            showErrorDialog(
                                "Lab Uniformity Test FAILED",
                                `Found ${uniqueValues.size} different Lab values after round-trip`,
                                `Wrote: ${testLab.L},${testLab.a},${testLab.b}\nRead back:\n  ${values}\n${uniqueValues.size > 5 ? `  ... and ${uniqueValues.size - 5} more` : ''}\n\n❌ Photoshop's imaging.getPixels() dithers Lab data!`
                            );
                        }
                    } catch (error) {
                        logger.error("Lab uniformity test failed:", error);
                        showErrorDialog("Test Error", error.message, "Check console for details");
                    } finally {
                        btnTestLabUniformity.disabled = false;
                        btnTestLabUniformity.textContent = "🔬 Test Lab Uniformity";
                    }
                });
            }

            // Posterization handler - reads color mode from form values
            const handlePosterization = async (buttonElement, buttonOriginalText) => {
                // Validate form
                const errors = validateForm();

                if (errors.length > 0) {
                    showError("Validation Error", "Please correct the following errors:", errors);
                    return;
                }

                // Get form values and merge with stored config (includes parameters not in UI)
                const formParams = getFormValues();

                // DIAGNOSTIC: Log what we're merging
                if (lastGeneratedConfig) {
                }

                const params = {
                    ...lastGeneratedConfig,  // Start with complete config from ParameterGenerator
                    ...formParams            // Override with user-adjusted UI values
                };
                const grayscaleOnly = params.colorMode === 'bw';  // Determine from dropdown

                // Log final merged parameters
                if (lastGeneratedConfig) {
                }

                try {
                    // Validate document (includes Lab mode check)
                    const validation = PhotoshopAPI.validateDocument();

                    if (!validation.valid) {
                        showError("Document Error", "Your document doesn't meet the requirements for Reveal:", validation.errors);
                        return;
                    }


                    // Get document info
                    const docInfo = PhotoshopAPI.getDocumentInfo();

                    // Show processing message
                    buttonElement.disabled = true;
                    buttonElement.textContent = "Analyzing...";

                    // Read document pixels for preview (800px max for performance)
                    const pixelData = await PhotoshopAPI.getDocumentPixels(800, 800);

                    // DIAGNOSTIC: Check ORIGINAL buffer before copying

                    // CRITICAL: Copy pixel buffer IMMEDIATELY before any processing
                    // Photoshop may clear/reuse the buffer after the API call returns
                    const pixelsCopy = new Uint16Array(pixelData.pixels);

                    // Apply preprocessing (bilateral filter for noise reduction) if enabled
                    // Engine always operates in 16-bit Lab space
                    const preprocessingIntensity = params.preprocessingIntensity || 'auto';

                    if (preprocessingIntensity !== 'off') {
                        buttonElement.textContent = "Preprocessing...";

                        // For "auto" mode, use DNA-based decision; for manual modes, force the setting
                        const dnaForPreprocessing = lastImageDNA || {};

                        // Calculate entropy from 16-bit Lab L channel
                        if (pixelData.pixels && pixelData.pixels.length > 0) {
                        }
                        const entropyScore = BilateralFilter.calculateEntropyScoreLab(
                            pixelData.pixels, pixelData.width, pixelData.height
                        );

                        // Get preprocessing config based on DNA and entropy
                        // Detect bit depth from pixel data type
                        const is16Bit = pixelData.pixels instanceof Uint16Array;

                        let preprocessConfig;
                        if (preprocessingIntensity === 'auto') {
                            const decision = BilateralFilter.shouldPreprocess(dnaForPreprocessing, entropyScore, is16Bit);
                            preprocessConfig = {
                                enabled: decision.shouldProcess,
                                reason: decision.reason,
                                entropyScore,
                                radius: decision.radius,
                                sigmaR: decision.sigmaR,
                                intensity: decision.shouldProcess ? (decision.radius >= 5 ? 'heavy' : 'light') : 'off'
                            };
                        } else {
                            // Manual override (light or heavy) - use bit-depth-aware sigmaR
                            const isHeavy = preprocessingIntensity === 'heavy';
                            // 8-bit: sigmaR=10, 16-bit: sigmaR=500 (per architect recommendation)
                            // sigmaR in 16-bit L units (no internal scaling)
                            const sigmaR = is16Bit ? 5000 : 3000;
                            preprocessConfig = {
                                enabled: true,
                                reason: `${preprocessingIntensity} filter (user override)`,
                                entropyScore,
                                radius: isHeavy ? 5 : 3,
                                sigmaR: sigmaR,
                                intensity: preprocessingIntensity
                            };
                        }

                        if (preprocessConfig.enabled) {

                            // Apply bilateral filter in 16-bit Lab space
                            BilateralFilter.applyBilateralFilterLab(
                                pixelData.pixels,
                                pixelData.width,
                                pixelData.height,
                                preprocessConfig.radius,
                                preprocessConfig.sigmaR
                            );

                        } else {
                        }
                    } else {
                    }

                    // TEMP: Store preprocessed image data (config will be stored later after tuning is defined)
                    // This must happen AFTER preprocessing so sliders can skip preprocessing step
                    window._originalImageData = {
                        labPixels: new Uint16Array(pixelsCopy), // pixelsCopy now contains preprocessed data
                        width: pixelData.width,
                        height: pixelData.height,
                        bitDepth: pixelData.bitDepth,
                        format: pixelData.format
                    };

                    // Determine color count (manual override or auto-detect)
                    let colorCount;
                    if (params.targetColors > 0) {
                        colorCount = params.targetColors;
                        buttonElement.textContent = `Posterizing to ${colorCount} colors...`;
                    } else {
                        buttonElement.textContent = "Analyzing complexity...";

                        colorCount = PosterizationEngine.analyzeOptimalColorCount(
                            pixelData.pixels,
                            pixelData.width,
                            pixelData.height
                        );

                        buttonElement.textContent = `Posterizing to ${colorCount} colors...`;
                    }

                    // Generate posterization using selected engine
                    // Factory method dispatches to appropriate algorithm based on engineType
                    // Build tuning config from UI parameters
                    const tuning = {
                        split: {
                            highlightBoost: params.highlightBoost,     // Facial highlight protection (default: 2.2)
                            vibrancyBoost: params.vibrancyBoost,       // Chroma-rich pixel weighting (default: 1.6)
                            minVariance: 10                             // Minimum variance to split
                        },
                        prune: {
                            threshold: params.paletteReduction,         // Delta-E merge distance (default: 9.0)
                            hueLockAngle: params.hueLockAngle,          // Hue protection angle (default: 18°)
                            whitePoint: params.highlightThreshold,      // L-value floor for white protection (default: 85)
                            shadowPoint: params.shadowPoint,            // L-value ceiling for shadow protection (default: 15)
                            isolationThreshold: params.isolationThreshold !== undefined ? params.isolationThreshold : 0.0  // Peak eligibility floor (25.0 = 1% minimum)
                        },
                        centroid: {
                            lWeight: params.lWeight,                    // Saliency lightness priority (default: 1.1)
                            cWeight: params.cWeight,                    // Saliency chroma priority (default: 2.0)
                            blackBias: params.blackBias,                // Black boost multiplier for halftones (default: 5.0)
                            bitDepth: pixelData.bitDepth,               // Source bit depth (8 or 16) for 16-bit precision fixes
                            vibrancyMode: params.vibrancyMode,          // Vibrancy mode: 'aggressive', 'exponential', 'linear'
                            vibrancyBoost: params.vibrancyBoost         // Vibrancy boost exponent (default: 2.2)
                        }
                    };

                    // Store config for re-posterization (now that tuning is defined)
                    window._originalImageData.config = {
                        engineType: params.engineType,
                        centroidStrategy: params.centroidStrategy,
                        distanceMetric: params.distanceMetric,
                        enableHueGapAnalysis: params.enableHueGapAnalysis,
                        preserveWhite: params.preserveWhite,
                        preserveBlack: params.preserveBlack,
                        preservedUnifyThreshold: params.preservedUnifyThreshold,
                        substrateMode: params.substrateMode,
                        substrateTolerance: params.substrateTolerance,
                        vibrancyMode: params.vibrancyMode,
                        vibrancyBoost: params.vibrancyBoost,
                        highlightThreshold: params.highlightThreshold,
                        highlightBoost: params.highlightBoost,
                        enablePaletteReduction: params.enablePaletteReduction,
                        paletteReduction: params.paletteReduction,
                        densityFloor: params.densityFloor,
                        isolationThreshold: params.isolationThreshold,
                        grayscaleOnly: grayscaleOnly,
                        tuning: tuning  // Now defined!
                    };

                    const result = PosterizationEngine.posterize(
                        pixelData.pixels,
                        pixelData.width,
                        pixelData.height,
                        colorCount,
                        {
                            engineType: params.engineType,           // NEW: Engine selection (reveal, balanced, classic, stencil)
                            centroidStrategy: params.centroidStrategy,  // NEW: User-selected strategy (SALIENCY or VOLUMETRIC)
                            enableGridOptimization: true,            // NEW: Default ON (Architect's requirement)
                            enableHueGapAnalysis: params.enableHueGapAnalysis,  // USER-CONTROLLED: Force hue diversity (default: ON, may exceed target count)
                            distanceMetric: params.distanceMetric,   // CIE76/CIE94/CIE2000 (cie76 = legacy v1 behavior)
                            format: pixelData.format,                // Pass Lab format flag for optimization
                            bitDepth: pixelData.bitDepth,            // Source bit depth (8 or 16) for Shadow Gate calibration
                            grayscaleOnly,                           // User-selected mode: grayscale (L-only) or color (full Lab)
                            preserveWhite: params.preserveWhite,
                            preserveBlack: params.preserveBlack,
                            preservedUnifyThreshold: params.preservedUnifyThreshold,  // ΔE threshold for white/black unification (default: 12.0, Jethro: 0.5)
                            substrateMode: params.substrateMode,     // Substrate awareness mode (auto, white, black, none)
                            substrateTolerance: params.substrateTolerance,  // ΔE threshold for substrate culling
                            vibrancyMode: params.vibrancyMode,       // Vibrancy algorithm (linear, aggressive, exponential)
                            vibrancyBoost: params.vibrancyBoost,     // Fixed vibrancy multiplier (split.vibrancyBoost)
                            highlightThreshold: params.highlightThreshold,  // White point (prune.whitePoint)
                            highlightBoost: params.highlightBoost,   // Highlight boost (split.highlightBoost)
                            enablePaletteReduction: params.enablePaletteReduction,  // Enable/disable palette reduction (default: true)
                            paletteReduction: params.paletteReduction,  // Color merging threshold (prune.threshold)
                            densityFloor: params.densityFloor,       // Density floor threshold (default: 0.005 = 0.5%, Jethro: 0.0 = disabled)
                            isolationThreshold: params.isolationThreshold,  // Peak eligibility floor (25.0 = 1% minimum cluster size)
                            tuning: tuning,                          // NEW: Centralized tuning configuration
                            // ignoreTransparent is handled during RGB→Lab conversion (alpha channel check)
                            isPreview: true,                          // Enable stride optimization for preview speed
                            previewStride: parseInt(document.getElementById('previewStride')?.value || '4', 10)  // User-selected stride (4=Standard, 2=Fine, 1=Finest)
                        }
                    );

                    const hexColors = PosterizationEngine.paletteToHex(result.palette);

                    // Show palette in Lab space (primary) with hex (secondary)
                    if (result.paletteLab) {
                        const labSummary = result.paletteLab.map((lab, i) => {
                            const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
                            const hue = (Math.atan2(lab.b, lab.a) * 180 / Math.PI + 360) % 360;
                            return `Lab(${lab.L.toFixed(0)},${lab.a.toFixed(0)},${lab.b.toFixed(0)})`;
                        }).join(', ');
                    }

                    // Analyze palette composition (Lab first, then RGB hex)
                    hexColors.forEach((color, i) => {
                        if (result.paletteLab && result.paletteLab[i]) {
                            const lab = result.paletteLab[i];
                            const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
                            const hue = (Math.atan2(lab.b, lab.a) * 180 / Math.PI + 360) % 360;
                        } else {
                        }
                    });

                    // Count pixel assignments per color
                    if (result.assignments) {
                        const counts = new Array(hexColors.length).fill(0);
                        for (let i = 0; i < result.assignments.length; i++) {
                            counts[result.assignments[i]]++;
                        }
                        counts.forEach((count, i) => {
                            const percent = ((count / result.assignments.length) * 100).toFixed(1);
                            if (result.paletteLab && result.paletteLab[i]) {
                                const lab = result.paletteLab[i];
                            } else {
                            }
                        });
                    }

                    // Log curation info if colors were merged
                    if (result.metadata.finalColors < result.metadata.targetColors) {
                    }


                    // Filter out substrate from UI display (but keep in full palette for separation)
                    // Substrate is the paper/medium, not an ink color
                    const inkHexColors = result.substrateIndex !== null
                        ? hexColors.filter((_, i) => i !== result.substrateIndex)
                        : hexColors;


                    // Store results for later use
                    const selectedPreview = {
                        colorCount: inkHexColors.length,    // Count of INK colors (excludes substrate)
                        assignments: result.assignments,    // Pixel→palette assignments
                        palette: result.palette,            // RGB palette for UI display (includes substrate)
                        paletteLab: result.paletteLab,      // Lab palette for layer creation (includes substrate)
                        hexColors: inkHexColors,            // INK colors for UI swatches (excludes substrate)
                        allHexColors: hexColors,            // ALL colors including substrate (for separation)
                        originalHexColors: [...inkHexColors],  // Store original ink colors before edits
                        substrateIndex: result.substrateIndex,  // Index of substrate in full palette (null if none)
                        substrateLab: result.substrateLab   // Substrate Lab color for layer identification
                    };

                    // Store globally for substrate-aware swatch/preview functions
                    window.selectedPreview = selectedPreview;

                    // 🏛️ FROZEN PALETTE PROTOCOL: Lock the palette as immutable Law
                    // Once Parameters Dialog closes, these colors are SOVEREIGN and never change
                    window._frozenPalette = {
                        labPalette: result.paletteLab,      // Immutable Lab colors
                        rgbPalette: result.palette,         // Immutable RGB colors
                        hexColors: hexColors,               // Immutable hex colors
                        inkHexColors: inkHexColors,         // Immutable ink-only colors
                        substrateIndex: result.substrateIndex
                    };

                    // Use the pixel copy we made at the beginning (before any processing)

                    posterizationData = {
                        params,
                        originalPixels: pixelsCopy,  // Lab format - COPIED at start, before any processing!
                        originalWidth: pixelData.width,
                        originalHeight: pixelData.height,
                        bitDepth: pixelData.bitDepth,  // Source bit depth (8 or 16)
                        docInfo,
                        selectedPreview
                    };

                    // Reset button
                    buttonElement.disabled = false;
                    buttonElement.textContent = buttonOriginalText;

                    // Show palette editor first (sets up UI layout)
                    showPaletteEditor(selectedPreview);

                    // CRITICAL: Wait for UXP layout to complete before rendering preview
                    // UXP needs time to calculate element dimensions after DOM changes
                    setTimeout(async () => {
                        // Check if img is ready (in paletteDialog)
                        const img = document.getElementById('previewImg');
                        if (img) {
                        }

                        // Initialize preview AFTER palette dialog layout is complete
                        initializePreviewCanvas(
                            pixelData.width,
                            pixelData.height,
                            hexColors,  // Use ALL colors (matches assignment indices)
                            result.assignments
                        );

                        // Render initial preview
                        renderPreview();

                        // Initialize ViewportManager for 1:1 mode (Phase 2)
                        try {

                            // Create CropEngine with PRE-COMPUTED separation state
                            // CRITICAL: Use the frozen palette from main pipeline (not re-posterize)
                            // This ensures Navigator Map thumbnail shows the SAME colors as the preview
                            const cropEngine = new CropEngine();
                            const initResult = await cropEngine.initializeWithSeparation(
                                posterizationData.originalPixels,
                                posterizationData.originalWidth,
                                posterizationData.originalHeight,
                                {
                                    paletteLab: window._frozenPalette.labPalette,
                                    rgbPalette: window._frozenPalette.rgbPalette,
                                    colorIndices: result.assignments
                                },
                                {
                                    bitDepth: posterizationData.bitDepth || 16,
                                    actualDocumentWidth: pixelData.originalWidth,   // ACTUAL document size, not preview
                                    actualDocumentHeight: pixelData.originalHeight  // ACTUAL document size, not preview
                                }
                            );

                            // Create ViewportManager
                            const viewportManager = new ViewportManager(cropEngine, {
                                documentDPI: pixelData.resolution || 300,
                                meshTPI: 230
                            });

                            // Store globally for access by view mode handlers
                            window.viewportManager = viewportManager;
                            window.cropEngine = cropEngine;

                            // CRITICAL: Sync initial center position to CropEngine for Navigator Map
                            // ViewportManager defaults to center (0.5, 0.5) but CropEngine viewport isn't synced yet
                            viewportManager.jumpToNormalized(0.5, 0.5);

                            // DIAGNOSTIC: Log ALL dimension values for debugging viewport issues


                            // Initialize Navigator Map with current image
                            renderNavigatorMap();
                        } catch (error) {
                            logger.error('[Phase 2] Failed to initialize ViewportManager:', error);
                        }

                        // Set up view mode dropdown
                        // Use stored handler reference to properly remove old listener (avoids cloneNode DOM corruption)
                        const viewModeSelect = document.getElementById('viewMode');
                        if (viewModeSelect) {
                            // Remove previous listener if it exists
                            if (window._viewModeChangeHandler) {
                                viewModeSelect.removeEventListener('change', window._viewModeChangeHandler);
                            }

                            viewModeSelect.value = 'fit';  // Default to fit mode

                            window._viewModeChangeHandler = async (e) => {
                                const mode = e.target.value;

                                document.body.style.cursor = 'wait';
                                try {
                                    await setPreviewMode(mode);
                                } catch (error) {
                                    logger.error('Failed to switch view mode:', error);
                                    showErrorDialog("View Mode Error", error.message, error.stack);
                                } finally {
                                    document.body.style.cursor = '';
                                }
                            };

                            viewModeSelect.addEventListener('change', window._viewModeChangeHandler);
                        }
                    }, 300); // 300ms delay for UXP layout

                } catch (error) {
                    logger.error("Error processing document:", error);
                    showError("Processing Error", `An error occurred while processing your document: ${error.message}`);

                    // Reset button
                    buttonElement.disabled = false;
                    buttonElement.textContent = buttonOriginalText;
                }
            };

            // Set up Posterize button
            const btnPosterize = document.getElementById("btnPosterize");
            if (btnPosterize) {
                const originalText = btnPosterize.textContent;
                btnPosterize.addEventListener("click", () => {
                    handlePosterization(btnPosterize, originalText);
                });
            }

            // Target Colors slider value display is handled by sliderConfigs below (no sync needed)

            // Spectrum slider value display updates
            // (sliderConfigs defined at module level for reuse by preset/analysis functions)
            sliderConfigs.forEach(config => {
                const slider = document.getElementById(config.id);
                const valueDisplay = document.getElementById(config.valueId || `${config.id}Value`);

                if (slider && valueDisplay) {
                    slider.addEventListener('input', () => {
                        const value = parseFloat(slider.value);
                        valueDisplay.textContent = config.format(value);
                    });
                    slider.addEventListener('change', () => {
                        const value = parseFloat(slider.value);
                        valueDisplay.textContent = config.format(value);
                    });
                }
            });

            // Collapsible section toggle functionality
            const collapsibleHeaders = document.querySelectorAll('.collapsible-header');
            collapsibleHeaders.forEach(header => {
                header.addEventListener('click', () => {
                    const section = header.parentElement;
                    section.classList.toggle('open');
                });
            });

            // Conditional UI disabling - Centroid Strategy
            const centroidStrategy = document.getElementById("centroidStrategy");
            const lWeight = document.getElementById("lWeight");
            const cWeight = document.getElementById("cWeight");
            const blackBias = document.getElementById("blackBias");

            function updateSaliencyControls() {
                const isVolumetric = centroidStrategy.value === "VOLUMETRIC";

                if (lWeight) {
                    lWeight.disabled = isVolumetric;
                    lWeight.style.opacity = isVolumetric ? "0.5" : "1";
                }
                if (cWeight) {
                    cWeight.disabled = isVolumetric;
                    cWeight.style.opacity = isVolumetric ? "0.5" : "1";
                }
                if (blackBias) {
                    blackBias.disabled = isVolumetric;
                    blackBias.style.opacity = isVolumetric ? "0.5" : "1";
                }

                // Also disable the labels
                const lWeightValue = document.getElementById("lWeightValue");
                const cWeightValue = document.getElementById("cWeightValue");
                const blackBiasValue = document.getElementById("blackBiasValue");

                if (lWeightValue) lWeightValue.style.opacity = isVolumetric ? "0.5" : "1";
                if (cWeightValue) cWeightValue.style.opacity = isVolumetric ? "0.5" : "1";
                if (blackBiasValue) blackBiasValue.style.opacity = isVolumetric ? "0.5" : "1";
            }

            if (centroidStrategy) {
                centroidStrategy.addEventListener("change", updateSaliencyControls);
                updateSaliencyControls(); // Set initial state
            }

            // Conditional UI disabling - Substrate Awareness
            const substrateMode = document.getElementById("substrateMode");
            const substrateTolerance = document.getElementById("substrateTolerance");

            function updateSubstrateToleranceControl() {
                const isAutoDetect = substrateMode.value === "auto";

                if (substrateTolerance) {
                    substrateTolerance.disabled = !isAutoDetect;
                    substrateTolerance.style.opacity = isAutoDetect ? "1" : "0.5";
                }

                // Also disable the label
                const substrateToleranceValue = document.getElementById("substrateToleranceValue");
                if (substrateToleranceValue) {
                    substrateToleranceValue.style.opacity = isAutoDetect ? "1" : "0.5";
                }
            }

            if (substrateMode) {
                substrateMode.addEventListener("change", updateSubstrateToleranceControl);
                updateSubstrateToleranceControl(); // Set initial state
            }

            // Reset to Defaults button
            const btnResetDefaults = document.getElementById("btnResetDefaults");
            if (btnResetDefaults) {
                btnResetDefaults.addEventListener("click", () => {

                    // Default values object
                    const defaults = {
                        engineType: 'reveal-mk1.5',
                        centroidStrategy: 'SALIENCY',
                        substrateMode: 'white',
                        substrateTolerance: 3.5,
                        vibrancyMode: 'aggressive',
                        vibrancyBoost: 1.6,
                        highlightThreshold: 85,
                        highlightBoost: 2.2,
                        enablePaletteReduction: true,
                        paletteReduction: 10.0,
                        hueLockAngle: 18,
                        shadowPoint: 15,
                        lWeight: 1.1,
                        cWeight: 2.0,
                        blackBias: 5.0,
                        colorMode: 'color',
                        targetColors: 8,
                        preserveWhite: false,
                        preserveBlack: false,
                        ignoreTransparent: true,
                        enableHueGapAnalysis: true,
                        maskProfile: 'Gray Gamma 2.2'
                    };

                    // Reset all form controls (use targetColorsSlider instead of targetColors)
                    const resetDefaults = { ...defaults, targetColorsSlider: defaults.targetColors };
                    delete resetDefaults.targetColors;

                    Object.keys(resetDefaults).forEach(key => {
                        const element = document.getElementById(key);
                        if (!element) {
                            return;
                        }

                        const value = resetDefaults[key];

                        if (element.type === 'checkbox') {
                            element.checked = value;
                            element.dispatchEvent(new Event('change', { bubbles: true }));
                        } else if (element.tagName === 'SELECT') {
                            element.value = value;
                            element.dispatchEvent(new Event('change', { bubbles: true }));
                        } else if (element.tagName === 'SP-SLIDER') {
                            element.value = value;
                            // Update value display
                            const valueDisplay = document.getElementById(`${key}Value`);
                            if (valueDisplay) {
                                const config = sliderConfigs.find(c => c.id === key);
                                if (config) {
                                    valueDisplay.textContent = config.format(value);
                                } else {
                                    valueDisplay.textContent = value.toString();
                                }
                            }
                            // Trigger events
                            element.dispatchEvent(new Event('input', { bubbles: true }));
                            element.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    });

                });
            }

            // Archetype Selector - populate dropdown and add event listener
            const archetypeSelector = document.getElementById("archetypeSelector");
            if (archetypeSelector) {
                // Populate dropdown with all loaded archetypes
                // First, clear any existing archetype options (keep "Analyze Image..." and "Manual Input")
                const existingOptions = Array.from(archetypeSelector.options);
                existingOptions.forEach(opt => {
                    if (opt.value !== 'auto' && opt.value !== 'manual' && !opt.disabled) {
                        archetypeSelector.removeChild(opt);
                    }
                });

                // Add archetype options
                Object.keys(ARCHETYPES).forEach(archetypeId => {
                    const archetype = ARCHETYPES[archetypeId];
                    const option = document.createElement('option');
                    option.value = archetypeId;
                    option.textContent = archetype.name;
                    archetypeSelector.appendChild(option);
                });


                // Add change event listener
                archetypeSelector.addEventListener('change', async () => {
                    const selectedValue = archetypeSelector.value;

                    if (selectedValue === 'auto') {
                        // "Analyze Image..." - trigger DNA analysis
                        lastSelectedArchetypeId = null;  // Clear manual selection
                        await handleAnalyzeImage();
                    } else if (selectedValue === 'manual') {
                        // "Manual Input" - reset to defaults
                        lastSelectedArchetypeId = null;  // Clear manual selection

                        // Use the same defaults as btnResetDefaults
                        const defaults = {
                            engineType: 'reveal-mk1.5',
                            centroidStrategy: 'SALIENCY',
                            substrateMode: 'white',
                            substrateTolerance: 3.5,
                            vibrancyMode: 'aggressive',
                            vibrancyBoost: 1.6,
                            highlightThreshold: 85,
                            highlightBoost: 2.2,
                            enablePaletteReduction: true,
                            paletteReduction: 10.0,
                            hueLockAngle: 18,
                            shadowPoint: 15,
                            lWeight: 1.1,
                            cWeight: 2.0,
                            blackBias: 5.0,
                            colorMode: 'color',
                            targetColors: 6,
                            preserveWhite: false,
                            preserveBlack: false,
                            ignoreTransparent: true,
                            enableHueGapAnalysis: true,
                            maskProfile: 'Gray Gamma 2.2',
                            // Production Quality Controls (defaults off)
                            minVolume: 0,
                            speckleRescue: 0,
                            shadowClamp: 0
                        };

                        // Reset all form controls
                        const resetDefaults = { ...defaults, targetColorsSlider: defaults.targetColors };
                        delete resetDefaults.targetColors;

                        Object.keys(resetDefaults).forEach(key => {
                            const element = document.getElementById(key);
                            if (!element) return;

                            const value = resetDefaults[key];

                            if (element.type === 'checkbox') {
                                element.checked = value;
                                element.dispatchEvent(new Event('change', { bubbles: true }));
                            } else if (element.tagName === 'SELECT') {
                                element.value = value;
                                element.dispatchEvent(new Event('change', { bubbles: true }));
                            } else if (element.tagName === 'SP-SLIDER') {
                                element.value = value;
                                const valueDisplay = document.getElementById(`${key}Value`);
                                if (valueDisplay) {
                                    const config = sliderConfigs.find(c => c.id === key);
                                    if (config) {
                                        valueDisplay.textContent = config.format(value);
                                    } else {
                                        valueDisplay.textContent = value.toString();
                                    }
                                }
                                element.dispatchEvent(new Event('input', { bubbles: true }));
                                element.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        });

                        // Clear stored config
                        lastGeneratedConfig = null;
                        lastImageDNA = null;

                    } else {
                        // Archetype selected - load parameters from archetype
                        const archetype = ARCHETYPES[selectedValue];

                        if (archetype && archetype.parameters) {
                            lastSelectedArchetypeId = selectedValue;  // Store manual selection ID

                            const params = archetype.parameters;

                            // Map archetype parameters to UI controls
                            const paramMapping = {
                                engineType: params.engineType,
                                centroidStrategy: params.centroidStrategy,
                                targetColorsSlider: params.targetColorsSlider,
                                ditherType: params.ditherType,
                                distanceMetric: params.distanceMetric,
                                lWeight: params.lWeight,
                                cWeight: params.cWeight,
                                blackBias: params.blackBias,
                                vibrancyMode: params.vibrancyMode,
                                vibrancyBoost: params.vibrancyBoost,
                                highlightThreshold: params.highlightThreshold,
                                highlightBoost: params.highlightBoost,
                                enablePaletteReduction: params.enablePaletteReduction,
                                paletteReduction: params.paletteReduction,
                                substrateMode: params.substrateMode,
                                substrateTolerance: params.substrateTolerance,
                                shadowPoint: params.shadowPoint,
                                enableHueGapAnalysis: params.enableHueGapAnalysis,
                                hueLockAngle: params.hueLockAngle,
                                colorMode: params.colorMode,
                                preserveWhite: params.preserveWhite,
                                preserveBlack: params.preserveBlack,
                                ignoreTransparent: params.ignoreTransparent,
                                maskProfile: params.maskProfile,
                                // Production Quality Controls (Archetype Overrides)
                                minVolume: params.minVolume,
                                speckleRescue: params.speckleRescue,
                                shadowClamp: params.shadowClamp
                            };

                            // Apply parameters to UI

                            try {
                                Object.keys(paramMapping).forEach(key => {
                                const element = document.getElementById(key);
                                if (!element) {
                                    return;
                                }

                                const value = paramMapping[key];

                                // Special diagnostic for paletteReduction
                                if (key === 'paletteReduction') {
                                }

                                if (element.type === 'checkbox') {
                                    element.checked = value;
                                    // Don't dispatch events - we're loading programmatically, not responding to user input
                                } else if (element.tagName === 'SELECT') {
                                    element.value = value;
                                    // Don't dispatch events - we're loading programmatically
                                } else if (element.tagName === 'SP-SLIDER') {
                                    element.value = value;
                                    const valueDisplay = document.getElementById(`${key}Value`);
                                    if (valueDisplay) {
                                        const config = sliderConfigs.find(c => c.id === key);
                                        if (config) {
                                            valueDisplay.textContent = config.format(value);
                                        } else {
                                            valueDisplay.textContent = value.toString();
                                        }
                                    }
                                    // Don't dispatch events - we're loading programmatically

                                    // Special diagnostic for paletteReduction AFTER setting
                                    if (key === 'paletteReduction') {
                                    }
                                }

                                    // Log if paletteReduction wasn't handled by any branch
                                    if (key === 'paletteReduction' && element.tagName !== 'SP-SLIDER' && element.tagName !== 'SELECT' && element.type !== 'checkbox') {
                                    }
                                });

                            } catch (error) {
                                logger.error(`❌ ERROR in UI application loop:`, error);
                                logger.error(`   Error message: ${error.message}`);
                                logger.error(`   Error stack:`, error.stack);
                            }


                            // Store the complete config for posterization (includes parameters not in UI)
                            // CRITICAL: Must include archetype ID and metadata to prevent parameter dilution
                            lastGeneratedConfig = {
                                // Identity (prevents DNA hijacking)
                                id: archetype.id,
                                name: archetype.name,

                                // All parameters from archetype JSON
                                ...params,

                                // Metadata
                                meta: {
                                    archetype: archetype.name,
                                    archetypeId: archetype.id,
                                    manualSelection: true  // Flag to indicate this was manually chosen
                                }
                            };

                        } else {
                            logger.error(`Archetype not found or missing parameters: ${selectedValue}`);
                        }
                    }
                });

            }

            // Preview Quality dropdown - initial setup for fit mode
            // Each mode switch (Fit/Zoom) rebuilds the dropdown from scratch via rebuildPreviewStrideForMode()
            rebuildPreviewStrideForMode('fit');

            // Analyse Image button handler (image analysis for dynamic configuration)
            const btnAnalyzeAndSet = document.getElementById("btnAnalyzeAndSet");
            if (btnAnalyzeAndSet) {
                btnAnalyzeAndSet.addEventListener("click", async () => {
                    // Disable button and show loading state
                    const originalText = btnAnalyzeAndSet.textContent;
                    btnAnalyzeAndSet.disabled = true;
                    btnAnalyzeAndSet.textContent = "Analysing...";
                    btnAnalyzeAndSet.style.opacity = "0.6";

                    try {
                        // Call shared analysis function
                        await handleAnalyzeImage();
                    } finally {
                        // Restore button state
                        btnAnalyzeAndSet.disabled = false;
                        btnAnalyzeAndSet.textContent = originalText;
                        btnAnalyzeAndSet.style.opacity = "1";
                    }
                });
            }


            // Preset selector change handler
            // Preset selector handler (DEPRECATED - DNA analysis now used)
            // Kept for rollback if needed
            /* const presetSelector = document.getElementById("presetSelector");
            if (presetSelector) {
                presetSelector.addEventListener("change", () => {
                    const presetId = presetSelector.value;

                    if (!presetId) {
                        return;
                    }

                    const preset = PARAMETER_PRESETS[presetId];
                    if (!preset) {
                        logger.error(`Invalid preset ID: ${presetId}`);
                        return;
                    }


                    // Apply preset settings
                    applyAnalyzedSettings(preset.settings);

                    // Reset selector to default
                    presetSelector.value = "";

                    // Log confirmation to console (no alert dialog)
                });
            } */

            // Palette Reduction checkbox toggle
            const enablePaletteReductionCheckbox = document.getElementById("enablePaletteReduction");
            const paletteReductionSlider = document.getElementById("paletteReduction");
            const paletteReductionControl = document.getElementById("paletteReductionControl");

            if (enablePaletteReductionCheckbox && paletteReductionSlider && paletteReductionControl) {
                // Toggle slider enabled/disabled based on checkbox
                const updateReductionState = () => {
                    const enabled = enablePaletteReductionCheckbox.checked;
                    paletteReductionSlider.disabled = !enabled;
                    paletteReductionControl.style.opacity = enabled ? "1" : "0.5";
                };

                enablePaletteReductionCheckbox.addEventListener("change", updateReductionState);
                updateReductionState(); // Set initial state
            }

            // NOTE: Apply Separation button handler is attached in showPaletteEditor()
            // This ensures a fresh handler with current posterizationData on each invocation

            // Mark listeners as attached so they don't get duplicated on dialog reopen
            listenersAttached = true;
        } else {
        }

        // Set up View Mode switching (Phase 1: UI state machine)
        // View mode switching is handled by setPreviewMode() function
        // (called from the change handler set up during posterization)

        // NOW show the dialog (after all event listeners are set up)
        // NON-MODAL to allow access to Photoshop Color Panel for LAB slider sync
        dialog.show({
            resize: "both",
            size: {
                width: 620,        // Wide enough for preset selector and buttons
                height: 700,       // Taller for palette
                minWidth: 580,
                minHeight: 500,
                maxWidth: 750,
                maxHeight: 900
            }
        });

    } catch (error) {
        logger.error("Error showing dialog:", error);
        logger.error("Error stack:", error.stack);
        // Can't use showError here since DOM might not be ready
        alert(`Error: ${error.message}`);
    }
}

// Ensure DOM is loaded before registering commands
let isInitialized = false;
let listenersAttached = false; // Track if event listeners have been set up

function ensureInitialized() {
    if (!isInitialized) {
        isInitialized = true;
    }
}

/**
 * Register plugin entrypoints
 */
entrypoints.setup({
    commands: {
        "reveal.showDialog": showDialog
    }
});

// Initialize on load
initPlugin();

// Initialize test client if in test mode
if (typeof __TEST_MODE__ !== 'undefined' && __TEST_MODE__) {
    try {
        require('./test-client');
    } catch (error) {
        logger.error('[Reveal] Failed to load test client:', error);
    }
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        showDialog,
        initPlugin
    };
}
