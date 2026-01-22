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

// Pure JS JPEG encoder for preview scaling workaround
// (UXP doesn't support canvas.toDataURL, so we encode JPEG manually)
const jpeg = require("jpeg-js");
const SeparationEngine = Reveal.engines.SeparationEngine;
const ImageHeuristicAnalyzer = Reveal.engines.ImageHeuristicAnalyzer;
const ParameterGenerator = require("@reveal/core/lib/analysis/ParameterGenerator");
const logger = Reveal.logger;

// Photoshop-specific API (stays in reveal-adobe)
const PhotoshopAPI = require("./api/PhotoshopAPI");
const DNAGenerator = require("./DNAGenerator");

// Test utilities
const { testTransparencySelection } = require("./test-16bit-transparency-selection");

// GoldenStatsCapture is Photoshop-specific (if it exists)
let GoldenStatsCapture = null;
try {
    GoldenStatsCapture = require("./core/GoldenStatsCapture");
} catch (e) {
    // GoldenStatsCapture may not exist in this package
    logger.log("GoldenStatsCapture not found (optional)");
}

/**
 * Initialize the plugin
 */
function initPlugin() {
    logger.log('Reveal plugin loaded');
    logger.log(`Build ID: ${typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'}`);
    logger.log(`Build Time: ${typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'development'}`);
}

// Store posterization results for preview
let posterizationData = null;

/**
 * Show custom error dialog (more readable than alert)
 */
function showError(title, message, errorList = null) {
    logger.log(`showError called: "${title}" - "${message}"`);
    logger.log("Error list:", errorList);

    const errorDialog = document.getElementById('errorDialog');
    const errorTitle = document.getElementById('errorTitle');
    const errorMessage = document.getElementById('errorMessage');
    const errorDetails = document.getElementById('errorDetails');
    const errorListEl = document.getElementById('errorList');

    logger.log("Error dialog element:", errorDialog);

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
    logger.log("✓ Error dialog opened as modal");

    // DEBUG: Log computed styles
    logger.log('\n=== ERROR DIALOG STYLE DEBUG ===');
    logger.log('Error Dialog computed styles:');
    logger.log(`  computed color: ${window.getComputedStyle(errorDialog).color}`);
    logger.log(`  computed background: ${window.getComputedStyle(errorDialog).backgroundColor}`);
    logger.log(`  inline style: ${errorDialog.getAttribute('style')}`);

    if (errorMessage) {
        logger.log('Error Message computed styles:');
        logger.log(`  computed color: ${window.getComputedStyle(errorMessage).color}`);
        logger.log(`  inline style: ${errorMessage.getAttribute('style')}`);
    }
    logger.log('=== END ERROR DEBUG ===\n');

    // Set up OK button to close
    const btnErrorOk = document.getElementById('btnErrorOk');
    if (btnErrorOk) {
        btnErrorOk.onclick = () => {
            logger.log("Error dialog OK clicked");
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
    logger.log(`showErrorDialog called: ${title} - ${message}`);

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
    logger.log("✓ Error dialog opened as modal");

    // DEBUG: Log computed styles
    logger.log('\n=== ERROR DIALOG STYLE DEBUG (showErrorDialog) ===');
    logger.log('Error Dialog computed styles:');
    logger.log(`  computed color: ${window.getComputedStyle(errorDialog).color}`);
    logger.log(`  computed background: ${window.getComputedStyle(errorDialog).backgroundColor}`);
    logger.log(`  inline style: ${errorDialog.getAttribute('style')}`);

    if (errorMessage) {
        logger.log('Error Message computed styles:');
        logger.log(`  computed color: ${window.getComputedStyle(errorMessage).color}`);
        logger.log(`  inline style: ${errorMessage.getAttribute('style')}`);
    }
    logger.log('=== END ERROR DEBUG ===\n');

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
    logger.log(`showSuccessDialog called: ${layerCount} layers, palette:`, palette);

    try {
        const successDialog = document.getElementById('successDialog');
        logger.log('Success dialog element:', successDialog);

        if (!successDialog) {
            logger.error('Success dialog element not found!');
            alert(`Separation complete! Created ${layerCount} layers.\n\nSuccess dialog not available - check console for errors.`);
            return;
        }

        const layerCountEl = document.getElementById('layerCount');
        const btnDone = document.getElementById('btnSuccessDone');
        const btnCaptureStats = document.getElementById('btnCaptureGoldenStats');
        const captureStatus = document.getElementById('captureStatus');

        logger.log('Got all elements:', { layerCountEl, btnDone, btnCaptureStats, captureStatus });

        if (!layerCountEl || !btnDone || !btnCaptureStats || !captureStatus) {
            logger.error('Missing required elements!');
            alert(`Separation complete! Created ${layerCount} layers.`);
            return;
        }

        layerCountEl.textContent = layerCount;
        captureStatus.textContent = '';

        // Show dialog using UXP dialog.showModal()
        // Close first if already open to avoid "already open" error
        logger.log('Showing success dialog with showModal()...');

        // LOG CANVAS AND TEXT COLORS BEFORE SHOWING
        logger.log('\n=== DIALOG STYLE DEBUG ===');
        logger.log('Success Dialog styles:');
        logger.log(`  inline style: ${successDialog.getAttribute('style')}`);
        logger.log(`  computed color: ${window.getComputedStyle(successDialog).color}`);
        logger.log(`  computed background: ${window.getComputedStyle(successDialog).backgroundColor}`);

        const successTitle = successDialog.querySelector('.success-title');
        if (successTitle) {
            logger.log('Success Title styles:');
            logger.log(`  inline style: ${successTitle.getAttribute('style')}`);
            logger.log(`  computed color: ${window.getComputedStyle(successTitle).color}`);
        }

        const successMessage = successDialog.querySelector('.success-message');
        if (successMessage) {
            logger.log('Success Message styles:');
            logger.log(`  inline style: ${successMessage.getAttribute('style')}`);
            logger.log(`  computed color: ${window.getComputedStyle(successMessage).color}`);
        }

        const successInfo = successDialog.querySelector('.success-info');
        if (successInfo) {
            logger.log('Success Info styles:');
            logger.log(`  inline style: ${successInfo.getAttribute('style')}`);
            logger.log(`  computed color: ${window.getComputedStyle(successInfo).color}`);
        }
        logger.log('=== END DEBUG ===\n');

        if (successDialog.open) {
            logger.log('Dialog already open, closing first...');
            successDialog.close();
        }
        successDialog.showModal();
        logger.log('Success dialog should now be visible');

        // Done button - close dialog properly
        btnDone.onclick = () => {
            logger.log('Done button clicked');
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

            logger.log('==========================================');
            logger.log(`GOLDEN OUTPUT: ${suggestedFilename}`);
            logger.log('==========================================');
            logger.log(json);
            logger.log('==========================================');
            logger.log(`Save as: tests/fixtures/golden-outputs/${suggestedFilename}`);
            logger.log('==========================================');

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

        logger.log('Success dialog setup complete');

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
    logger.log(`Converting ${width}x${height} pixels to data URL...`);
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
    logger.log(`✓ Converted to data URL (${dataURL.length} chars)`);
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

            logger.log(`  Set foreground to RGB(${initialColor.r}, ${initialColor.g}, ${initialColor.b})`);

            // Step 2: Show color picker (uses foreground color as initial color)
            const response = await action.batchPlay([{
                _obj: "showColorPicker"
            }], {});

            logger.log(`  Color picker response:`, response);

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
                logger.log(`  New foreground color: RGB(${result.red}, ${result.green}, ${result.blue})`);
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
 * Initialize preview state for JPEG-encoded img display
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

    logger.log(`Initializing preview: ${width}×${height} pixels`);

    // Store preview state globally
    logger.log(`[DEBUG] Creating window.previewState with ${assignments.length} assignments and ${palette.length} colors`);
    window.previewState = {
        width: width,
        height: height,
        palette: palette,
        assignments: assignments,
        activeSoloIndex: null,  // null = show all, number = solo that color
        deletedIndices: new Set()  // Track soft-deleted color indices
    };

    // Add click handler to preview image - clicking shows all colors
    // Remove any existing handler first to prevent duplicates
    const newImg = img.cloneNode(true);
    img.parentNode.replaceChild(newImg, img);

    newImg.addEventListener('click', () => {
        const state = window.previewState;
        if (state && state.activeSoloIndex !== null) {
            logger.log('Preview image clicked - returning to full preview');
            state.activeSoloIndex = null;
            renderPreview();
        }
    });

    logger.log(`✓ Preview initialized: ${width}×${height}`);
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

    logger.log(`Rendering preview (solo mode: ${activeSoloIndex !== null}, deleted: ${deletedIndices.size})`);
    logger.log(`  Image: ${width}×${height}`);

    // Build remap table for deleted colors (maps to nearest surviving color)
    let remapTable = null;
    if (deletedIndices.size > 0) {
        remapTable = buildRemapTable(palette, deletedIndices);
        logger.log(`  Remapping ${deletedIndices.size} deleted colors to nearest survivors`);
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
            pixelData[pixelOffset + 3] = 255; // Alpha (ignored by JPEG but required)
        }
    }

    // Encode to JPEG using pure-JS encoder
    // Use quality 100 for posterized images (already flat colors, compression artifacts would be visible)
    const jpegData = jpeg.encode({
        data: pixelData,
        width: width,
        height: height
    }, 100);

    // Convert to base64 data URL
    // Note: jpeg.encode returns { data: Buffer, width, height }
    const base64 = bufferToBase64(jpegData.data);
    const dataUrl = `data:image/jpeg;base64,${base64}`;

    // Set image source
    img.src = dataUrl;

    // Store dimensions for click coordinate mapping
    img.dataset.naturalWidth = width;
    img.dataset.naturalHeight = height;

    logger.log(`✓ Preview rendered ${width}×${height} as JPEG (${Math.round(jpegData.data.length / 1024)}KB)`);
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

    const container = document.getElementById('paletteEditorContainer');
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
            // Highlight active swatch
            swatch.style.border = '3px solid #0078d4';
            swatch.style.boxShadow = '0 0 8px rgba(0,120,212,0.6)';
        } else {
            // Normal swatch appearance
            swatch.style.border = '1px solid #ccc';
            swatch.style.boxShadow = 'none';
        }
    });
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
 * Handle swatch click - toggle highlight for that color in preview
 * @param {number} featureIndex - Index of the color feature (0-based, swatch index)
 */
function handleSwatchClick(featureIndex) {
    const state = window.previewState;
    if (!state) {
        logger.log("Preview not available");
        return;
    }

    // Convert swatch index to palette index (accounting for substrate offset)
    const selectedPreview = window.selectedPreview;
    const substrateIndex = selectedPreview?.substrateIndex;

    let paletteIndex = featureIndex;
    if (substrateIndex !== null && featureIndex >= substrateIndex) {
        paletteIndex = featureIndex + 1;  // Skip the substrate index
    }

    // Toggle solo mode for this color
    if (state.activeSoloIndex === paletteIndex) {
        // Already showing this color - turn off solo mode (show all)
        state.activeSoloIndex = null;
        logger.log(`Showing all colors`);
    } else {
        // Show only this color (using palette index)
        state.activeSoloIndex = paletteIndex;
        logger.log(`Highlighting swatch ${featureIndex + 1} (palette index ${paletteIndex})`);
    }

    // Update swatch highlighting
    updateSwatchHighlights();

    // Re-render preview
    renderPreview();
}

/**
 * Handle Alt+Click on swatch to toggle soft delete state
 * @param {number} swatchIndex - Zero-based swatch index (INK colors only, excluding substrate)
 */
function handleSwatchDelete(swatchIndex) {
    const state = window.previewState;
    if (!state) {
        logger.log("Preview not available");
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
        logger.log(`Restored swatch ${swatchIndex + 1} (palette index ${paletteIndex})`);
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
        logger.log(`Deleted swatch ${swatchIndex + 1} (palette index ${paletteIndex}, ${survivorCount - 1} survivors remaining)`);

        // Clear solo mode if deleted color was active
        if (state.activeSoloIndex === paletteIndex) {
            state.activeSoloIndex = null;
            logger.log('  Cleared solo mode (deleted color was active)');
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
    logger.log("Showing palette editor with colors:", selectedPalette.hexColors);

    // Close the main dialog
    const mainDialog = document.getElementById('mainDialog');
    if (mainDialog) {
        mainDialog.close();
        logger.log("✓ Closed main dialog");
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

    logger.log("✓ Palette dialog opened (1200×800, resizable)");

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

        logger.log(`📐 Panel layout updated: dialog=${Math.round(dialogRect.width)}×${Math.round(dialogRect.height)}, content height=${Math.round(availableHeight)}px`);
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
        logger.log("✓ ResizeObserver attached for panel layout");
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
        logger.log(`Injected ${selectedPalette.hexColors.length} editable swatches via innerHTML`);

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
        logger.log(`[UXP FIX] Container recalculated height: ${height}px`);

        // Force visibility on all swatches by reading their offsetHeight
        const swatches = container.querySelectorAll('.editable-swatch-container');
        swatches.forEach(swatch => {
            // Reading offsetHeight forces UXP to calculate dimensions
            swatch.offsetHeight;
        });

        logger.log(`[UXP FIX] Forced recalculation on ${swatches.length} swatches`);

        // Log first swatch dimensions to verify fix
        if (swatches.length > 0) {
            const firstSwatch = swatches[0];
            logger.log(`[UXP FIX] First swatch dimensions:`, {
                offsetWidth: firstSwatch.offsetWidth,
                offsetHeight: firstSwatch.offsetHeight
            });
        }
    });

    // Attach click handlers to swatches - extracted for re-rendering after color changes
    function attachSwatchClickHandlers() {
        const container = document.getElementById('editablePaletteContainer');

        // Handler: Lab text click → Color Picker
        const labTexts = container.querySelectorAll('.clickable-lab');
        logger.log(`Found ${labTexts.length} Lab text elements for color picker`);

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

                logger.log(`🎨 Opening Color Picker for Feature ${featureIndex + 1}: ${currentHex} (RGB: ${currentRgb.r}, ${currentRgb.g}, ${currentRgb.b})`);

                // Highlight this color in canvas preview (solo mode)
                if (window.previewState) {
                    window.previewState.activeSoloIndex = featureIndex;
                    renderPreview();
                    logger.log(`✓ Highlighted color ${featureIndex + 1} in canvas preview`);
                }

                try {
                    // Show Photoshop's Color Picker with current color
                    const result = await showPhotoshopColorPicker(currentRgb);

                    // User cancelled?
                    if (!result) {
                        logger.log(`⚠️ Color picker cancelled by user`);
                        // Keep solo mode active (user may want to try again)
                        return;
                    }

                    // Convert RGB result to hex
                    const newHex = rgbToHex(result.red, result.green, result.blue);
                    logger.log(`✓ Color picker returned: ${newHex} (RGB: ${result.red}, ${result.green}, ${result.blue})`);

                    // No change?
                    if (newHex === currentHex) {
                        logger.log(`  No change - keeping ${currentHex}`);
                        return;
                    }

                    // Convert to Lab for perceptual distance check
                    const newLab = PosterizationEngine.rgbToLab({ r: result.red, g: result.green, b: result.blue });
                    logger.log(`  Lab values: L${Math.round(newLab.L)} a${Math.round(newLab.a)} b${Math.round(newLab.b)}`);

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
                            logger.log(`⚠️ Warning: ${newHex} is too similar to Feature ${similarTo} (${otherHex}) - ΔE=${distance.toFixed(1)}`);
                            break;
                        }
                    }

                    // Show warning if too similar (but still allow)
                    if (tooSimilar) {
                        logger.log(`⚠️ Palette Sovereignty warning: ΔE=${minDistance.toFixed(1)} (threshold: ${MIN_DISTANCE})`);
                        alert(`⚠️ Warning: This color is very similar to Feature ${similarTo} (ΔE=${minDistance.toFixed(1)}). Colors may not separate cleanly in final output.`);
                    }

                    // Update palette data using feature index (maintains alignment with originalHexColors)
                    selectedPalette.hexColors[featureIndex] = newHex;
                    selectedPalette.paletteLab[featureIndex] = newLab;  // CRITICAL: Update Lab palette (used for layer creation)
                    logger.log(`✓ Updated Feature ${featureIndex + 1}: ${currentHex} → ${newHex}`);
                    logger.log(`  Lab: L${newLab.L.toFixed(1)} a${newLab.a.toFixed(1)} b${newLab.b.toFixed(1)}`);
                    logger.log(`  Entire feature group will remap to new ink (editing bones, not pixels)`);

                    // Re-render entire palette to show new color, re-sort by L, and update all Lab values
                    logger.log(`🔄 Re-rendering palette with updated color...`);
                    renderPaletteSwatches();

                    // Update canvas preview with new color
                    logger.log(`🔄 Updating canvas preview with new color...`);
                    if (window.previewState) {
                        window.previewState.palette = selectedPalette.hexColors;
                        renderPreview();
                        logger.log(`✓ Canvas preview updated with new color`);
                    }

                } catch (error) {
                    logger.error(`Failed to show color picker:`, error);
                    alert(`Error showing color picker: ${error.message}`);
                }
            });
        });

        // Handler: Swatch click → Highlight color in canvas preview
        const swatches = container.querySelectorAll('.editable-swatch');
        logger.log(`Found ${swatches.length} swatches for preview highlighting`);

        swatches.forEach(swatch => {
            swatch.addEventListener('click', (event) => {
                event.stopPropagation(); // Prevent bubbling

                const featureIndex = parseInt(swatch.dataset.featureIndex);

                // Alt+Click: Toggle delete state
                if (event.altKey) {
                    logger.log(`🗑️ Swatch ${featureIndex + 1} Alt+Clicked - toggling delete state`);
                    handleSwatchDelete(featureIndex);
                    return;
                }

                // Normal click: Toggle highlight in preview
                logger.log(`🔍 Swatch ${featureIndex + 1} clicked - highlighting in preview`);
                handleSwatchClick(featureIndex);
            });
        });
    }

    // Hide "Posterize" button, show "Apply Separation" and "Back" buttons
    const btnPosterize = document.getElementById('btnPosterize');
    if (btnPosterize) btnPosterize.style.display = 'none';
    logger.log(`✓ Hidden posterize button`);

    const btnApplySeparation = document.getElementById('btnApplySeparation');
    btnApplySeparation.style.display = 'block';
    btnApplySeparation.style.visibility = 'visible';

    // CRITICAL: Reset button state from any previous runs
    btnApplySeparation.disabled = false;
    btnApplySeparation.textContent = "Separate with this palette →";
    logger.log(`✓ Reset button state: enabled, text="${btnApplySeparation.textContent}"`);

    const btnBack = document.getElementById('btnBack');
    if (btnBack) {
        btnBack.style.display = 'block';
        logger.log(`✓ Showing back button`);
    }

    // Ensure buttons container is visible
    const buttonsContainer = document.querySelector('.reveal-buttons');
    if (buttonsContainer) {
        buttonsContainer.style.display = 'flex';
        logger.log(`✓ Buttons container display: ${buttonsContainer.style.display}`);
    }

    logger.log(`✓ Showing btnApplySeparation - display: ${btnApplySeparation.style.display}, text: "${btnApplySeparation.textContent}"`);

    // Note: Debug dimension checks removed - palette editor is now in separate paletteDialog

    // CRITICAL: Clone and replace button to remove ALL old event listeners
    // This prevents event listener accumulation on repeated posterizations
    const btnApplySeparationClone = btnApplySeparation.cloneNode(true);
    btnApplySeparation.parentNode.replaceChild(btnApplySeparationClone, btnApplySeparation);
    const btnApply = btnApplySeparationClone; // Use new reference

    // Attach fresh event listener to cloned button (no duplicates)
    btnApply.addEventListener("click", async () => {
        logger.log("Apply Separation button clicked!");

        // GUARD CLAUSE: Prevent concurrent executions
        if (btnApply.disabled) {
            logger.warn('⚠ Separation already in progress, ignoring duplicate click');
            return;
        }

        // LOCK: Disable button immediately
        btnApply.disabled = true;
        btnApply.textContent = "Applying Separation...";
        logger.log('✓ Button locked - separation starting');

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
        logger.log("Applying separation with Sovereign Palette:", selectedPreview.hexColors);
        logger.log("✓ User-edited colors are law - generating plates with exact hex values");

        // Filter out soft-deleted colors before separation
        let hexColors = selectedPreview.hexColors;
        let originalHexColors = selectedPreview.originalHexColors;
        let paletteLab = selectedPreview.paletteLab;

        if (window.previewState && window.previewState.deletedIndices.size > 0) {
            const deletedIndices = window.previewState.deletedIndices;
            logger.log(`🗑️ Filtering out ${deletedIndices.size} soft-deleted colors before separation`);

            // Filter all palette arrays to exclude deleted colors
            hexColors = selectedPreview.hexColors.filter((_, idx) => !deletedIndices.has(idx));
            originalHexColors = selectedPreview.originalHexColors.filter((_, idx) => !deletedIndices.has(idx));
            paletteLab = selectedPreview.paletteLab.filter((_, idx) => !deletedIndices.has(idx));

            logger.log(`  Original palette: ${selectedPreview.hexColors.length} colors`);
            logger.log(`  Filtered palette: ${hexColors.length} colors`);
            logger.log(`  Deleted colors: ${Array.from(deletedIndices).map(i => selectedPreview.hexColors[i]).join(', ')}`);
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
                logger.log("Step 1: Separating image into color layers...");

                // Get dithering setting from UI
                const ditherTypeEl = document.getElementById('ditherType');
                const ditherType = ditherTypeEl ? ditherTypeEl.value : 'none';
                logger.log(`Dithering: ${ditherType}`);

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
                    logger.log(`Mesh-aware: ${meshValue} TPI @ ${documentPPI} PPI → ${maxLPI} LPI max, ${cellSize}px cell size`);
                } else {
                    logger.log(`Mesh: Pixel-level (no constraint)`);
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
                            logger.log(`Preview separation progress: ${percent}%`);
                        },
                        ditherType: ditherType,
                        mesh: meshValue,
                        ppi: documentPPI
                    }
                );

                logger.log(`Generated ${layers.length} separated layers`);

                // Phase 4.2: Create layers in Photoshop
                logger.log("Step 2: Creating layers in Photoshop...");

                // Get full-resolution document pixels
                const docInfo = PhotoshopAPI.getDocumentInfo();
                logger.log(`Document: ${docInfo.width}x${docInfo.height}`);

                // Re-separate at full resolution (ASYNC with progress)
                fullResPixels = await PhotoshopAPI.getDocumentPixels(docInfo.width, docInfo.height);
                logger.log(`Full-resolution separation: ${fullResPixels.width}x${fullResPixels.height}`);

                fullResLayers = await SeparationEngine.separateImage(
                    fullResPixels.pixels,
                    fullResPixels.width,
                    fullResPixels.height,
                    hexColors,          // Rendering palette (user-edited, filtered)
                    originalHexColors,  // Assignment palette (original discovery, filtered)
                    paletteLab,         // Lab palette (NO RGB→Lab conversion, filtered)
                    {
                        onProgress: (percent) => {
                            logger.log(`Full-res separation progress: ${percent}%`);
                        },
                        ditherType: ditherType,
                        mesh: meshValue,
                        ppi: docInfo.resolution  // Use full-res document PPI
                    }
                );

                // Sort layers for screen printing: Light to Dark (Bottom to Top)
                // Substrate always goes at bottom regardless of lightness
                logger.log('Sorting layers for screen printing (light→dark)...');

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

                logger.log(`Analyzing ${fullResLayers.length} layers for substrate detection:`);
                for (const layer of fullResLayers) {
                    // Calculate coverage percentage for this layer
                    // Count non-zero pixels in mask
                    let coveragePixels = 0;
                    for (let i = 0; i < layer.mask.length; i++) {
                        if (layer.mask[i] > 0) coveragePixels++;
                    }
                    const coveragePercent = (coveragePixels / totalPixels) * 100;

                    logger.log(`  Layer: ${layer.name} | L=${layer.labColor.L.toFixed(2)} a=${layer.labColor.a.toFixed(2)} b=${layer.labColor.b.toFixed(2)} | Coverage: ${coveragePercent.toFixed(1)}%`);

                    // Check for pure white (L=100, a=0, b=0)
                    // Tolerance: L > 99 (near white), a/b within 2 (allows for slight tinting)
                    // Requires > 5% coverage to avoid treating highlights as substrate
                    const whiteL = layer.labColor.L > 99;
                    const whiteA = Math.abs(layer.labColor.a - 0) < 2;
                    const whiteB = Math.abs(layer.labColor.b - 0) < 2;
                    const whiteCoverage = coveragePercent >= SUBSTRATE_MIN_COVERAGE;
                    const isWhite = whiteL && whiteA && whiteB && whiteCoverage;

                    if (layer.labColor.L > 95) {
                        logger.log(`    White check: L>${99}? ${whiteL} (L=${layer.labColor.L.toFixed(2)}) | a<2? ${whiteA} (a=${layer.labColor.a.toFixed(2)}) | b<2? ${whiteB} (b=${layer.labColor.b.toFixed(2)}) | coverage>=${SUBSTRATE_MIN_COVERAGE}%? ${whiteCoverage} (${coveragePercent.toFixed(1)}%)`);
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
                        logger.log(`    Black check: L<${5}? ${blackL} (L=${layer.labColor.L.toFixed(2)}) | a<5? ${blackA} (a=${layer.labColor.a.toFixed(2)}) | b<5? ${blackB} (b=${layer.labColor.b.toFixed(2)}) | coverage>=${SUBSTRATE_MIN_COVERAGE}%? ${blackCoverage} (${coveragePercent.toFixed(1)}%)`);
                    }

                    // Check for detected substrate from posterization
                    const matchesDetectedSubstrate = selectedPreview.substrateLab &&
                                       Math.abs(layer.labColor.L - selectedPreview.substrateLab.L) < 0.1 &&
                                       Math.abs(layer.labColor.a - selectedPreview.substrateLab.a) < 0.1 &&
                                       Math.abs(layer.labColor.b - selectedPreview.substrateLab.b) < 0.1;

                    if (isWhite) {
                        whiteLayer = layer;
                        logger.log(`    → Identified as WHITE layer`);
                    } else if (isBlack) {
                        blackLayer = layer;
                        logger.log(`    → Identified as BLACK layer`);
                    } else if (matchesDetectedSubstrate) {
                        detectedSubstrateLayer = layer;
                        logger.log(`    → Identified as DETECTED SUBSTRATE`);
                    } else {
                        inkLayers.push(layer);
                        logger.log(`    → Added to INK LAYERS`);
                    }
                }

                // Check if auto-detected substrate indicates white or black paper
                const autoDetectedWhite = selectedPreview.substrateLab && selectedPreview.substrateLab.L > 95;
                const autoDetectedBlack = selectedPreview.substrateLab && selectedPreview.substrateLab.L < 5;

                if (autoDetectedWhite) {
                    logger.log(`  Auto-detected substrate is WHITE (L=${selectedPreview.substrateLab.L.toFixed(1)})`);
                } else if (autoDetectedBlack) {
                    logger.log(`  Auto-detected substrate is BLACK (L=${selectedPreview.substrateLab.L.toFixed(1)})`);
                }

                // Determine substrate with priority:
                // 1. If auto-detected is WHITE → use white layer, OR brightest layer if no pure white
                // 2. If auto-detected is BLACK → use black layer
                // 3. Fallback: White Layer > Black Layer > Detected Substrate
                if (autoDetectedWhite) {
                    // White paper detected - use white layer if available, otherwise use brightest layer
                    if (whiteLayer) {
                        substrateLayer = whiteLayer;
                        logger.log(`  Found substrate layer: ${substrateLayer.name} (L=${substrateLayer.labColor.L.toFixed(1)}) [WHITE PAPER - exact match]`);
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
                            logger.log(`  Found substrate layer: ${substrateLayer.name} (L=${substrateLayer.labColor.L.toFixed(1)}) [WHITE PAPER - brightest layer proxy]`);
                        } else {
                            logger.log(`  ⚠ White substrate detected but no suitable bright layer found (brightest L=${brightestL?.toFixed(1) || 'N/A'})`);
                        }
                    }
                    // Black becomes an ink layer if white is substrate
                    if (blackLayer && substrateLayer !== blackLayer) {
                        if (!inkLayers.includes(blackLayer)) {
                            inkLayers.push(blackLayer);
                            logger.log(`  Demoted black to ink layer: ${blackLayer.name}`);
                        }
                    }
                } else if (whiteLayer) {
                    substrateLayer = whiteLayer;
                    logger.log(`  Found substrate layer: ${substrateLayer.name} (L=${substrateLayer.labColor.L.toFixed(1)}) [WHITE PAPER]`);
                    // Black becomes an ink layer if white is substrate
                    if (blackLayer) {
                        inkLayers.push(blackLayer);
                        logger.log(`  Demoted black to ink layer: ${blackLayer.name}`);
                    }
                    // Detected substrate also becomes an ink layer if white takes priority
                    if (detectedSubstrateLayer) {
                        inkLayers.push(detectedSubstrateLayer);
                        logger.log(`  Demoted detected substrate to ink layer: ${detectedSubstrateLayer.name}`);
                    } else if (selectedPreview.substrateLab) {
                        logger.log(`  ⚠ Detected substrate from posterization was skipped (likely <0.1% coverage) - not creating layer`);
                    }
                } else if (autoDetectedBlack && blackLayer) {
                    // Black paper explicitly detected
                    substrateLayer = blackLayer;
                    logger.log(`  Found substrate layer: ${substrateLayer.name} (L=${substrateLayer.labColor.L.toFixed(1)}) [BLACK PAPER - auto-detected]`);
                    if (detectedSubstrateLayer && detectedSubstrateLayer !== blackLayer) {
                        inkLayers.push(detectedSubstrateLayer);
                        logger.log(`  Demoted detected substrate to ink layer: ${detectedSubstrateLayer.name}`);
                    }
                } else if (blackLayer) {
                    substrateLayer = blackLayer;
                    logger.log(`  Found substrate layer: ${substrateLayer.name} (L=${substrateLayer.labColor.L.toFixed(1)}) [BLACK PAPER]`);
                    // Detected substrate becomes an ink layer if black takes priority
                    if (detectedSubstrateLayer) {
                        inkLayers.push(detectedSubstrateLayer);
                        logger.log(`  Demoted detected substrate to ink layer: ${detectedSubstrateLayer.name}`);
                    } else if (selectedPreview.substrateLab) {
                        logger.log(`  ⚠ Detected substrate from posterization was skipped (likely <0.1% coverage) - not creating layer`);
                    }
                } else if (detectedSubstrateLayer) {
                    substrateLayer = detectedSubstrateLayer;
                    logger.log(`  Found substrate layer: ${substrateLayer.name} (L=${substrateLayer.labColor.L.toFixed(1)}) [AUTO-DETECTED]`);
                }

                // Sort ink layers by L value: HIGH to LOW (light to dark)
                // In Photoshop stacking: First layer created = bottom, last layer created = top
                // Screen printing order: Light inks print first (bottom), dark inks print last (top)
                // So we create light layers first (high L), dark layers last (low L)
                inkLayers.sort((a, b) => b.labColor.L - a.labColor.L);

                logger.log('Layer order (bottom→top):');
                const orderedLayers = [];
                let layerIndex = 0;

                // Substrate ALWAYS at bottom (if it exists)
                if (substrateLayer) {
                    orderedLayers.push(substrateLayer);
                    logger.log(`  ${layerIndex + 1}. ${substrateLayer.name} (SUBSTRATE - always at bottom)`);
                    layerIndex++;
                }

                // Then ink layers sorted by L value (light to dark)
                inkLayers.forEach((layer) => {
                    orderedLayers.push(layer);
                    logger.log(`  ${layerIndex + 1}. ${layer.name} (L=${layer.labColor.L.toFixed(1)})`);
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
                    logger.log(`⚠ Could not suspend history (may already be suspended): ${err.message}`);
                }

                try {
                    // CRITICAL: Show all layers before cleanup (might be hidden from previous run)
                    logger.log(`Ensuring all layers are visible before cleanup...`);
                    try {
                        for (const layer of doc.layers) {
                            if (!layer.visible) {
                                layer.visible = true;
                                logger.log(`✓ Showed hidden layer: "${layer.name}"`);
                            }
                        }
                    } catch (err) {
                        logger.warn(`⚠ Could not show hidden layers: ${err.message}`);
                    }

                    // CRITICAL: Delete all existing separation layers before creating new ones
                    // This prevents duplicates/conflicts when running the plugin multiple times
                    logger.log(`Deleting existing layers (current count: ${doc.layers.length})...`);
                    await PhotoshopAPI.deleteAllLayersExceptBackground();
                    logger.log(`✓ Cleaned up existing layers (remaining: ${doc.layers.length})`);

                    // Store reference to the original source layer (what remains after cleanup)
                    // This is the layer we'll hide after creating separation layers
                    // Note: Can't rely on isBackgroundLayer since user might have a regular layer
                    const originalLayer = doc.layers.length > 0 ? doc.layers[doc.layers.length - 1] : null;
                    if (originalLayer) {
                        logger.log(`Original source layer: "${originalLayer.name}" (ID: ${originalLayer.id})`);
                    } else {
                        logger.warn(`⚠ No original layer found after cleanup - this shouldn't happen!`);
                    }

                    // Detect document bit depth to route to appropriate layer creation method
                    const docBitDepth = String(doc.bitsPerChannel).toLowerCase();
                    const is16bit = docBitDepth.includes('16') || doc.bitsPerChannel === 16;
                    logger.log(`Document bit depth: ${doc.bitsPerChannel} → Using ${is16bit ? '16-bit' : '8-bit'} layer creation method`);

                    let skippedCount = 0;

                    for (let i = 0; i < orderedLayers.length; i++) {
                        const layerData = orderedLayers[i];
                        logger.log(`Creating layer ${i + 1}/${orderedLayers.length}: ${layerData.name}`);

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
                            logger.log(`  ⚠ Layer "${layerData.name}" was skipped (empty mask)`);
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
                    logger.log(`Hiding original source layer...`);
                    try {
                        if (originalLayer) {
                            // Verify layer still exists (wasn't deleted during separation)
                            const layerStillExists = doc.layers.find(l => l.id === originalLayer.id);
                            if (layerStillExists) {
                                originalLayer.visible = false;
                                logger.log(`✓ Original layer "${originalLayer.name}" hidden`);
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

            logger.log("✓ Separation complete!");

            // CLEANUP: Release resources proactively
            logger.log("Cleaning up resources...");
            if (fullResPixels && fullResPixels.pixels) {
                fullResPixels.pixels = null;
            }
            fullResLayers.forEach(layer => {
                if (layer.mask) {
                    layer.mask = null;
                }
            });
            logger.log("✓ Resources released");

            // Close palette dialog
            const paletteDialog = document.getElementById('paletteDialog');
            if (paletteDialog) {
                paletteDialog.close();
                logger.log('✓ Palette dialog closed');
            }

            // Note: Button stays disabled since dialog is closed
            // It will be reset when dialog reopens
            logger.log('✓ Separation complete - dialog closed');

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
                logger.log("⚠️ User cancelled separation - cleaning up gracefully");

                // Just reset button state, don't show error dialog
                btnApply.disabled = false;
                btnApply.textContent = "Separate with this palette →";
                logger.log('✓ Button unlocked after cancellation');

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
            logger.log('✓ Button unlocked after error');
        }
    });

    // Update dialog title
    document.querySelector('.reveal-title').textContent = 'Reveal - Customize Palette & Separate';

    logger.log("Palette editor displayed with", selectedPalette.hexColors.length, "colors");

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
        logger.log("Set dialog width to 520px");
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
    logger.log("Displaying previews (UXP canvas doesn't support toDataURL)");

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
    logger.log("About to call showPreviewSection() BEFORE creating swatches");
    showPreviewSection();
    logger.log("showPreviewSection() completed, now creating swatches");

    // Display posterized previews - show color palettes
    previews.forEach(preview => {
        logger.log(`Creating swatches for ${preview.colorCount} colors:`, preview.hexColors);

        // Display color palette swatches
        const paletteDiv = document.getElementById(`palette${preview.colorCount}`);
        if (!paletteDiv) {
            logger.error(`Palette div not found: palette${preview.colorCount}`);
            return;
        }

        logger.log(`Found palette div: palette${preview.colorCount}`);

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
        logger.log(`Injected ${preview.hexColors.length} swatches via innerHTML for palette${preview.colorCount}`);

        logger.log(`Palette ${preview.colorCount} now has ${paletteDiv.children.length} swatches`);
    });

    logger.log("Swatches created, checking dimensions...");

    // Debug: Check if preview grid is visible
    const dialog = document.getElementById('mainDialog');
    const previewGrid = document.querySelector('.preview-grid');
    const previewSection = document.getElementById('previewSection');
    const previewItems = document.querySelectorAll('.preview-item');

    logger.log("Dialog offsetWidth:", dialog.offsetWidth);
    logger.log("Dialog computed width:", window.getComputedStyle(dialog).width);
    logger.log("Preview section classes:", previewSection.className);
    logger.log("Preview section display style:", window.getComputedStyle(previewSection).display);
    logger.log("Preview section offsetHeight:", previewSection.offsetHeight);
    logger.log("Preview section scrollHeight:", previewSection.scrollHeight);

    logger.log("Preview grid display style:", window.getComputedStyle(previewGrid).display);
    logger.log("Preview grid computed width:", window.getComputedStyle(previewGrid).width);
    logger.log("Preview grid offsetHeight:", previewGrid.offsetHeight);
    logger.log("Preview grid offsetWidth:", previewGrid.offsetWidth);
    logger.log("Preview grid children:", previewGrid.children.length);

    logger.log("Preview items count:", previewItems.length);
    previewItems.forEach((item, i) => {
        const styles = window.getComputedStyle(item);
        logger.log(`  Item ${i}: display=${styles.display}, height=${item.offsetHeight}px, width=${item.offsetWidth}px, visibility=${styles.visibility}`);
    });

    // Check if grid items have the palette divs populated
    const palette3 = document.getElementById('palette3');
    const palette5 = document.getElementById('palette5');
    const palette7 = document.getElementById('palette7');

    logger.log("Palette3 children:", palette3.children.length);
    logger.log("Palette5 children:", palette5.children.length);
    logger.log("Palette7 children:", palette7.children.length);

    // Check swatch dimensions
    if (palette3.children.length > 0) {
        const firstSwatch = palette3.children[0].querySelector('.color-swatch');
        if (firstSwatch) {
            logger.log("First swatch computed styles:", {
                width: window.getComputedStyle(firstSwatch).width,
                height: window.getComputedStyle(firstSwatch).height,
                backgroundColor: window.getComputedStyle(firstSwatch).backgroundColor,
                display: window.getComputedStyle(firstSwatch).display
            });
            logger.log("First swatch offset dimensions:", {
                offsetWidth: firstSwatch.offsetWidth,
                offsetHeight: firstSwatch.offsetHeight
            });
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
        engineType: document.getElementById("engineType")?.value ?? "reveal",  // Engine selection
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
        // Mesh-aware dithering settings
        mesh: getMeshValue(),  // Screen mesh TPI (0 = pixel-level)
        ppi: PhotoshopAPI.getDocumentInfo()?.resolution || 72  // Document PPI for mesh calculations
        // CIELAB is always used - no toggle
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
    { id: 'targetColorsSlider', valueId: 'targetColorsValue', format: v => v.toFixed(0) }
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
    logger.log("[Analyze] Applying settings:", settings);

    Object.keys(settings).forEach(key => {
        const element = document.getElementById(key);
        if (!element) {
            logger.log(`  ⚠️ Element not found: ${key} (skipping)`);
            return;
        }

        const value = settings[key];
        logger.log(`  Setting ${key} = ${value}`);

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

    logger.log("✓ All analyzed settings applied");
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
    logger.log(`✓ Loaded preset: "${preset.name}" (${id})`);
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
 * Show the main dialog
 */
async function showDialog() {
    logger.log("showDialog() called");
    try {
        const dialog = document.getElementById("mainDialog");
        logger.log("Dialog element found:", dialog ? "yes" : "no");

        if (!dialog) {
            logger.error("Dialog element not found! DOM might not be ready.");
            throw new Error("Dialog element not found");
        }

        logger.log("Dialog object type:", typeof dialog);
        logger.log("Dialog showModal method:", typeof dialog.showModal);

        // CRITICAL: Validate document BEFORE showing dialog
        logger.log("Validating document...");
        const validation = PhotoshopAPI.validateDocument();

        if (!validation.valid) {
            logger.log("Document validation failed - showing error without opening dialog");
            logger.log("Errors:", validation.errors);

            // Use alert instead of modal dialog to avoid UXP crashes during entrypoint
            const errorMessage = "Your document doesn't meet the requirements for Reveal:\n\n" +
                validation.errors.map((err, i) => `${i + 1}. ${err}`).join('\n');
            alert(errorMessage);

            return; // Don't open dialog
        }

        logger.log("Document validation passed!");

        // CRITICAL: Reset UI state to initial view (parameter entry)
        // This ensures re-invoking the plugin starts fresh
        logger.log("Resetting UI to initial state...");

        // Show parameter entry section wrapper
        const parameterEntrySection = document.getElementById('parameterEntrySection');
        if (parameterEntrySection) {
            parameterEntrySection.style.display = 'block';
            logger.log("✓ Parameter entry section shown");
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
            logger.log("Clearing preview state...");
            window.previewState = null;
        }

        logger.log("UI reset complete - showing parameter entry screen");

        // CRITICAL: Set up event listeners BEFORE showing dialog
        // showModal() blocks until dialog closes, so code after it won't run until then!
        // Only attach listeners once to prevent accumulation on dialog reopen
        if (!listenersAttached) {
            logger.log("Attaching event listeners (first time only)...");

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
            logger.log(`Found ${previewItems.length} preview items for click handlers`);
            previewItems.forEach(item => {
                item.addEventListener('click', (event) => {
                    logger.log(`Preview item clicked! Target:`, event.target, `Current target:`, event.currentTarget);
                    const colorCount = item.dataset.colorCount;
                    const radio = document.getElementById(`color${colorCount}`);

                    // Update selection state
                    previewItems.forEach(i => i.classList.remove('selected'));
                    item.classList.add('selected');
                    radio.checked = true;

                    logger.log(`Selected ${colorCount} colors via preview item click`);
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
                    logger.log("Palette Cancel button clicked - dismissing plugin");
                    const paletteDialog = document.getElementById('paletteDialog');
                    if (paletteDialog) {
                        paletteDialog.close();
                        logger.log("✓ Palette dialog closed - plugin dismissed");
                    }
                });
            }

            // Set up Back button (goes from palette editor back to posterization settings)
            const btnBack = document.getElementById("btnBack");
            if (btnBack) {
                btnBack.addEventListener("click", () => {
                    logger.log("Back button clicked - returning to posterization settings");

                    // Close palette dialog
                    const paletteDialog = document.getElementById('paletteDialog');
                    if (paletteDialog) {
                        paletteDialog.close();
                        logger.log("✓ Closed palette dialog");
                    }

                    // Show Posterize button (it was hidden when palette editor opened)
                    const btnPosterize = document.getElementById('btnPosterize');
                    if (btnPosterize) {
                        btnPosterize.style.display = '';
                        logger.log("✓ Posterize button restored");
                    }

                    // Reopen main dialog with size options
                    const mainDialog = document.getElementById('mainDialog');
                    if (mainDialog) {
                        mainDialog.showModal({
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
                        logger.log("✓ Reopened main dialog");
                    }

                    // Note: Keep posterizationData intact so user doesn't lose their work
                    // They can modify settings and re-posterize if desired

                    logger.log("✓ Returned to posterization settings");
                });
            }

            // Set up Run Mask Tests button
            // Set up Pixel Data Mask Test button (alpha channel → selection → mask)
            const btnRunNetwisdomTests = document.getElementById("btnRunNetwisdomTests");
            if (btnRunNetwisdomTests) {
                btnRunNetwisdomTests.addEventListener("click", async () => {
                    logger.log("🔬 Running pixel data → mask test...");
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
                    logger.log("🔬 Testing Lab uniformity (write/read round-trip)...");
                    btnTestLabUniformity.disabled = true;
                    btnTestLabUniformity.textContent = "Running Test...";

                    try {
                        const width = 100;
                        const height = 100;
                        const testLab = { L: 204, a: 128, b: 128 };

                        // 1. Create Lab document
                        logger.log('Creating Lab document...');
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
                        logger.log(`Writing uniform Lab data (L=${testLab.L}, a=${testLab.a}, b=${testLab.b})...`);
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
                        logger.log('Reading Lab data back...');
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

                        logger.log(`Unique Lab values after round-trip: ${uniqueValues.size}`);

                        // Log the values for debugging
                        if (uniqueValues.size <= 10) {
                            uniqueValues.forEach(v => logger.log(`  Lab value: ${v}`));
                        }

                        // 5. Close document (may fail if already closed)
                        try {
                            await doc.close();
                        } catch (closeError) {
                            logger.log(`Note: Could not close test document (may already be closed)`);
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

                // Get form values
                const params = getFormValues();
                const grayscaleOnly = params.colorMode === 'bw';  // Determine from dropdown

                // Log parameters for debugging
                logger.log("Posterization parameters:", params);

                try {
                    // Validate document (includes Lab mode check)
                    logger.log("Validating document...");
                    const validation = PhotoshopAPI.validateDocument();
                    logger.log("Validation result:", validation);

                    if (!validation.valid) {
                        logger.log("Document validation failed, showing error");
                        logger.log("Errors:", validation.errors);
                        validation.errors.forEach((err, i) => logger.log(`  Error ${i+1}: ${err}`));
                        showError("Document Error", "Your document doesn't meet the requirements for Reveal:", validation.errors);
                        return;
                    }

                    logger.log("Document validation passed!");

                    // Get document info
                    const docInfo = PhotoshopAPI.getDocumentInfo();
                    logger.log("Document info:", docInfo);

                    // Show processing message
                    buttonElement.disabled = true;
                    buttonElement.textContent = "Analyzing...";

                    // Read document pixels (scaled to 800x800 max for preview)
                    logger.log("Reading document pixels...");
                    const pixelData = await PhotoshopAPI.getDocumentPixels(800, 800);
                    logger.log(`Read ${pixelData.width}x${pixelData.height} pixels (${pixelData.scale.toFixed(2)}x scale)`);
                    logger.log(`Pixel format flag: "${pixelData.format}" (undefined means RGB, "lab" means Lab)`);

                    // Determine color count (manual override or auto-detect)
                    let colorCount;
                    if (params.targetColors > 0) {
                        colorCount = params.targetColors;
                        logger.log(`Using manual color count: ${colorCount} colors`);
                        buttonElement.textContent = `Posterizing to ${colorCount} colors...`;
                    } else {
                        logger.log("Auto-detecting optimal color count...");
                        buttonElement.textContent = "Analyzing complexity...";

                        colorCount = PosterizationEngine.analyzeOptimalColorCount(
                            pixelData.pixels,
                            pixelData.width,
                            pixelData.height
                        );

                        logger.log(`✓ Auto-detected: ${colorCount} colors recommended`);
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
                            shadowPoint: params.shadowPoint             // L-value ceiling for shadow protection (default: 15)
                        },
                        centroid: {
                            lWeight: params.lWeight,                    // Saliency lightness priority (default: 1.1)
                            cWeight: params.cWeight,                    // Saliency chroma priority (default: 2.0)
                            blackBias: params.blackBias                 // Black boost multiplier for halftones (default: 5.0)
                        }
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
                            snapThreshold: 8.0,                      // Perceptual snap threshold (ΔE < 8 = noise)
                            format: pixelData.format,                // Pass Lab format flag for optimization
                            bitDepth: pixelData.bitDepth,            // Source bit depth (8 or 16) for Shadow Gate calibration
                            grayscaleOnly,                           // User-selected mode: grayscale (L-only) or color (full Lab)
                            preserveWhite: params.preserveWhite,
                            preserveBlack: params.preserveBlack,
                            substrateMode: params.substrateMode,     // Substrate awareness mode (auto, white, black, none)
                            substrateTolerance: params.substrateTolerance,  // ΔE threshold for substrate culling
                            vibrancyMode: params.vibrancyMode,       // Vibrancy algorithm (linear, aggressive, exponential)
                            vibrancyBoost: params.vibrancyBoost,     // Fixed vibrancy multiplier (split.vibrancyBoost)
                            highlightThreshold: params.highlightThreshold,  // White point (prune.whitePoint)
                            highlightBoost: params.highlightBoost,   // Highlight boost (split.highlightBoost)
                            enablePaletteReduction: params.enablePaletteReduction,  // Enable/disable palette reduction (default: true)
                            paletteReduction: params.paletteReduction,  // Color merging threshold (prune.threshold)
                            tuning: tuning,                          // NEW: Centralized tuning configuration
                            // ignoreTransparent is handled during RGB→Lab conversion (alpha channel check)
                            isPreview: true,                          // Enable stride optimization for preview speed
                            previewStride: parseInt(document.getElementById('previewStride')?.value || '4', 10)  // User-selected stride (4=Standard, 2=Fine, 1=Finest)
                        }
                    );

                    logger.log(`⚠️ POSTERIZATION RESULT: Requested ${colorCount} colors, got ${result.palette.length} colors`);
                    const hexColors = PosterizationEngine.paletteToHex(result.palette);
                    logger.log(`\n${'='.repeat(60)}`);
                    logger.log('POSTERIZATION RESULTS');
                    logger.log('='.repeat(60));
                    logger.log(`Colors found: ${hexColors.length}`);

                    // Show palette in Lab space (primary) with hex (secondary)
                    if (result.paletteLab) {
                        const labSummary = result.paletteLab.map((lab, i) => {
                            const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
                            const hue = (Math.atan2(lab.b, lab.a) * 180 / Math.PI + 360) % 360;
                            return `Lab(${lab.L.toFixed(0)},${lab.a.toFixed(0)},${lab.b.toFixed(0)})`;
                        }).join(', ');
                        logger.log(`Palette (Lab): ${labSummary}`);
                    }
                    logger.log(`Palette (RGB): ${hexColors.join(", ")}`);

                    // Analyze palette composition (Lab first, then RGB hex)
                    logger.log('\nPalette Details:');
                    hexColors.forEach((color, i) => {
                        if (result.paletteLab && result.paletteLab[i]) {
                            const lab = result.paletteLab[i];
                            const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
                            const hue = (Math.atan2(lab.b, lab.a) * 180 / Math.PI + 360) % 360;
                            logger.log(`  ${i + 1}. Lab(${lab.L.toFixed(1)}, ${lab.a.toFixed(1)}, ${lab.b.toFixed(1)}) C=${chroma.toFixed(1)} H=${hue.toFixed(0)}° → ${color}`);
                        } else {
                            logger.log(`  ${i + 1}. ${color}`);
                        }
                    });

                    // Count pixel assignments per color
                    if (result.assignments) {
                        logger.log('\nPixel distribution:');
                        const counts = new Array(hexColors.length).fill(0);
                        for (let i = 0; i < result.assignments.length; i++) {
                            counts[result.assignments[i]]++;
                        }
                        counts.forEach((count, i) => {
                            const percent = ((count / result.assignments.length) * 100).toFixed(1);
                            if (result.paletteLab && result.paletteLab[i]) {
                                const lab = result.paletteLab[i];
                                logger.log(`  Color ${i + 1} Lab(${lab.L.toFixed(1)}, ${lab.a.toFixed(1)}, ${lab.b.toFixed(1)}) ${hexColors[i]}: ${count} pixels (${percent}%)`);
                            } else {
                                logger.log(`  Color ${i + 1} (${hexColors[i]}): ${count} pixels (${percent}%)`);
                            }
                        });
                    }

                    // Log curation info if colors were merged
                    if (result.metadata.finalColors < result.metadata.targetColors) {
                        logger.log(`\nℹ️ Curated from ${result.metadata.targetColors} to ${result.metadata.finalColors} perceptually distinct features (Fidelity to Feature)`);
                    }

                    logger.log('='.repeat(60) + '\n');

                    // Filter out substrate from UI display (but keep in full palette for separation)
                    // Substrate is the paper/medium, not an ink color
                    const inkHexColors = result.substrateIndex !== null
                        ? hexColors.filter((_, i) => i !== result.substrateIndex)
                        : hexColors;

                    logger.log(`Substrate handling: ${result.substrateIndex !== null ? `Substrate at index ${result.substrateIndex}, showing ${inkHexColors.length} ink colors` : 'No substrate detected'}`);

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

                    posterizationData = {
                        params,
                        originalPixels: pixelData.pixels,  // Lab format (3 bytes/pixel)
                        originalWidth: pixelData.width,
                        originalHeight: pixelData.height,
                        docInfo,
                        selectedPreview
                    };

                    // Reset button
                    buttonElement.disabled = false;
                    buttonElement.textContent = buttonOriginalText;

                    // Show palette editor first (sets up UI layout)
                    logger.log(`Showing palette editor with ${result.palette.length} colors`);
                    showPaletteEditor(selectedPreview);

                    // CRITICAL: Wait for UXP layout to complete before rendering preview
                    // UXP needs time to calculate element dimensions after DOM changes
                    logger.log('✓ Posterization complete - waiting for layout...');
                    setTimeout(() => {
                        // Check if img is ready (in paletteDialog)
                        const img = document.getElementById('previewImg');
                        if (img) {
                            logger.log(`[After delay] Img offsetHeight BEFORE init: ${img.offsetHeight}`);
                        }

                        // Initialize preview AFTER palette dialog layout is complete
                        logger.log('Initializing preview...');
                        initializePreviewCanvas(
                            pixelData.width,
                            pixelData.height,
                            hexColors,  // Use ALL colors (matches assignment indices)
                            result.assignments
                        );

                        // Render initial preview
                        renderPreview();
                        logger.log('✓ Preview rendered');
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
            logger.log("✓ Spectrum slider value displays attached");

            // Collapsible section toggle functionality
            const collapsibleHeaders = document.querySelectorAll('.collapsible-header');
            collapsibleHeaders.forEach(header => {
                header.addEventListener('click', () => {
                    const section = header.parentElement;
                    section.classList.toggle('open');
                });
            });
            logger.log(`✓ Collapsible section toggles attached (${collapsibleHeaders.length} sections)`);

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
            logger.log("✓ Conditional UI disabling attached (Centroid Strategy)");

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
            logger.log("✓ Conditional UI disabling attached (Substrate Awareness)");

            // Reset to Defaults button
            const btnResetDefaults = document.getElementById("btnResetDefaults");
            if (btnResetDefaults) {
                btnResetDefaults.addEventListener("click", () => {
                    logger.log("Resetting all parameters to defaults...");

                    // Default values object
                    const defaults = {
                        engineType: 'reveal',
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
                        maskProfile: 'Gray Gamma 2.2'
                    };

                    // Reset all form controls (use targetColorsSlider instead of targetColors)
                    const resetDefaults = { ...defaults, targetColorsSlider: defaults.targetColors };
                    delete resetDefaults.targetColors;

                    Object.keys(resetDefaults).forEach(key => {
                        const element = document.getElementById(key);
                        if (!element) {
                            logger.log(`  Element not found: ${key}`);
                            return;
                        }

                        const value = resetDefaults[key];
                        logger.log(`  Resetting ${key} = ${value}`);

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

                    logger.log("✓ All parameters reset to defaults");
                });
                logger.log("✓ Reset to Defaults button attached");
            }

            // Preview Quality dropdown - reassign pixels with new stride
            const previewStrideSelect = document.getElementById('previewStride');
            if (previewStrideSelect) {
                previewStrideSelect.addEventListener('change', () => {
                    if (!posterizationData || !window.previewState) return;

                    const stride = parseInt(previewStrideSelect.value, 10);
                    const pixels = posterizationData.originalPixels;
                    const paletteLab = posterizationData.selectedPreview.paletteLab;
                    const width = posterizationData.originalWidth;
                    const height = posterizationData.originalHeight;

                    const labels = { 4: 'Standard', 2: 'Fine', 1: 'Finest' };
                    logger.log(`Preview stride change: ${labels[stride] || stride} (stride=${stride}), ${width}x${height}, palette=${paletteLab.length}`);
                    document.body.style.cursor = 'wait';

                    // Use setTimeout with enough delay for UXP to repaint cursor
                    setTimeout(() => {
                        try {
                            // Delegate to PosterizationEngine
                            const assignments = PosterizationEngine.reassignWithStride(
                                pixels, paletteLab, width, height, stride
                            );

                            window.previewState.assignments = assignments;
                            renderPreview();
                            logger.log(`✓ Preview updated: stride=${stride}`);
                        } catch (err) {
                            logger.error('Stride change error:', err);
                        }
                        document.body.style.cursor = '';
                    }, 50);
                });
            }

            // Analyze and Set button handler
            // Analyze DNA button handler (DNA-based dynamic configuration)
            const btnAnalyzeAndSet = document.getElementById("btnAnalyzeAndSet");
            if (btnAnalyzeAndSet) {
                btnAnalyzeAndSet.addEventListener("click", async () => {
                    logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    logger.log("🧬 ANALYZE DNA - Starting analysis...");
                    logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

                    // Disable button and show loading state
                    const originalText = btnAnalyzeAndSet.textContent;
                    btnAnalyzeAndSet.disabled = true;
                    btnAnalyzeAndSet.textContent = "⏳ Analyzing...";
                    btnAnalyzeAndSet.style.opacity = "0.6";

                    try {
                        // Get Lab pixels from current document (downsampled to 800x800 for speed)
                        const result = await core.executeAsModal(async () => {
                            const pixelData = await PhotoshopAPI.getDocumentPixels(800, 800);
                            return {
                                pixels: pixelData.pixels,  // Lab bytes (Uint8ClampedArray, 3 bytes per pixel)
                                width: pixelData.width,
                                height: pixelData.height
                            };
                        }, { commandName: "Analyze Document DNA" });

                        logger.log(`✓ Retrieved ${result.pixels.length} bytes (${result.width}×${result.height})`);

                        // Generate DNA from Lab pixels
                        const startTime = Date.now();
                        const dna = DNAGenerator.generate(result.pixels, result.width, result.height, 40);
                        const dnaTime = Date.now() - startTime;

                        logger.log("✓ Image DNA extracted:", dna);
                        logger.log(`  DNA generation time: ${dnaTime.toFixed(2)}ms`);

                        // Run ParameterGenerator to get dynamic configuration
                        const config = ParameterGenerator.generate(dna);
                        logger.log("✓ Generated dynamic config:", config);

                        // Map ALL parameters to UI elements (matching batch process configuration)
                        const uiSettings = {
                            // DNA-driven parameters
                            targetColorsSlider: config.targetColors,
                            blackBias: config.blackBias,
                            ditherType: config.ditherType,
                            vibrancyBoost: config.saturationBoost,

                            // Standard configuration parameters (batch defaults)
                            engineType: 'reveal',
                            centroidStrategy: 'SALIENCY',
                            lWeight: 1.0,
                            cWeight: 1.0,
                            substrateMode: 'white',
                            substrateTolerance: 2.0,
                            vibrancyMode: 'moderate',
                            highlightThreshold: 85,
                            highlightBoost: 1.0,
                            enablePaletteReduction: true,
                            paletteReduction: 10.0,
                            hueLockAngle: 20,
                            shadowPoint: 15,
                            colorMode: 'color',
                            preserveWhite: true,
                            preserveBlack: true,
                            ignoreTransparent: true,
                            enableHueGapAnalysis: true,
                            maskProfile: 'Gray Gamma 2.2'
                        };

                        logger.log("  Setting ALL UI parameters from DNA analysis:");
                        logger.log("  DNA-driven:", {
                            targetColors: config.targetColors,
                            blackBias: config.blackBias,
                            ditherType: config.ditherType,
                            saturationBoost: config.saturationBoost
                        });
                        logger.log("  Standard config: lWeight=1.0, cWeight=1.0, vibrancyMode=moderate, etc.");

                        // Apply ALL DNA-based settings to UI
                        applyAnalyzedSettings(uiSettings);

                        // Show simple alert to user
                        const alertMsg = `DNA Analysis Complete\n\nConfig: ${config.name}\nColors: ${config.targetColors}, Black Bias: ${config.blackBias.toFixed(1)}, Dither: ${config.ditherType}\n\nAll parameters have been set.\nClick "Posterize" to generate separations.`;

                        // Log full details to console
                        logger.log(`\nDNA ANALYSIS COMPLETE`);
                        logger.log(`Image DNA: L=${dna.l}, C=${dna.c}, K=${dna.k}, maxC=${dna.maxC}, range=[${dna.minL}, ${dna.maxL}]`);
                        logger.log(`Config: ${config.name}`);
                        logger.log(`  Target Colors: ${config.targetColors}`);
                        logger.log(`  Black Bias: ${config.blackBias.toFixed(1)}`);
                        logger.log(`  Vibrancy Boost: ${config.saturationBoost.toFixed(2)}`);
                        logger.log(`  Dither Type: ${config.ditherType}`);
                        logger.log(`Analysis Time: ${dnaTime.toFixed(2)}ms`);

                        alert(alertMsg);

                        logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                        logger.log("✓ ANALYZE DNA - Complete");
                        logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

                    } catch (error) {
                        logger.error("❌ DNA Analysis failed:", error);
                        alert(
                            `DNA Analysis failed:\n\n${error.message}\n\n` +
                            `Please ensure a document is open and try again.`
                        );
                    } finally {
                        // Restore button state
                        btnAnalyzeAndSet.disabled = false;
                        btnAnalyzeAndSet.textContent = originalText;
                        btnAnalyzeAndSet.style.opacity = "1";
                    }
                });
                logger.log("✓ Analyze DNA button handler attached");
            }

            // Preset selector change handler
            // Preset selector handler (DEPRECATED - DNA analysis now used)
            // Kept for rollback if needed
            /* const presetSelector = document.getElementById("presetSelector");
            if (presetSelector) {
                presetSelector.addEventListener("change", () => {
                    const presetId = presetSelector.value;

                    if (!presetId) {
                        logger.log("Preset selector cleared");
                        return;
                    }

                    const preset = PARAMETER_PRESETS[presetId];
                    if (!preset) {
                        logger.error(`Invalid preset ID: ${presetId}`);
                        return;
                    }

                    logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    logger.log(`📋 PRESET - Applying "${preset.name}"`);
                    logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                    logger.log(`  ${preset.description}`);
                    logger.log("  Settings:", preset.settings);

                    // Apply preset settings
                    applyAnalyzedSettings(preset.settings);

                    // Reset selector to default
                    presetSelector.value = "";

                    // Log confirmation to console (no alert dialog)
                    logger.log(`✓ PRESET - "${preset.name}" applied`);
                    logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                });
                logger.log("✓ Preset selector handler attached");
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
                logger.log("✓ Palette Reduction toggle attached");
            }

            // NOTE: Apply Separation button handler is attached in showPaletteEditor()
            // This ensures a fresh handler with current posterizationData on each invocation

            // Mark listeners as attached so they don't get duplicated on dialog reopen
            listenersAttached = true;
            logger.log("✓ All event listeners attached");
        } else {
            logger.log("Event listeners already attached, skipping setup");
        }

        // NOW show the dialog (after all event listeners are set up)
        logger.log("All event listeners set up, now showing dialog...");
        await dialog.showModal({
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
        logger.log("Dialog closed");

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
        logger.log("First-time initialization...");
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
    logger.log('[Reveal] Test mode enabled - loading test client');
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
