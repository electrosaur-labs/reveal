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
        logger.log(`Smart Reveal: peakC=${peakChroma.toFixed(1)}, archetype=${useDNA.archetype || 'unknown'} → ${resolved === 'cie94' ? 'Photo/Tonal' : 'Poster/Graphic'}`);
        return resolved;
    }

    // No DNA available - default to cie94 (safer for unknown images)
    logger.log('Smart Reveal: No DNA analysis available, defaulting to Photo/Tonal (CIE94)');
    return 'cie94';
}

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

    logger.log(`Initializing preview: ${width}×${height} pixels`);

    // Store preview state globally
    logger.log(`[DEBUG] Creating window.previewState with ${assignments.length} assignments and ${palette.length} colors`);
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
            logger.log('Preview image clicked - returning to full preview');
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
    logger.log(`  Palette (${palette.length} colors): ${palette.join(', ')}`);

    // Debug: Check assignment distribution for 2-color images
    if (palette.length <= 3) {
        const counts = {};
        for (let i = 0; i < assignments.length; i++) {
            counts[assignments[i]] = (counts[assignments[i]] || 0) + 1;
        }
        logger.log(`  Assignment distribution: ${JSON.stringify(counts)}`);
    }

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

    logger.log(`✓ Preview rendered ${width}×${height} as JPEG (${Math.round(jpegData.data.length / 1024)}KB)`);
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
        logger.log(`Already in ${mode} mode`);
        return;
    }

    const container = document.getElementById('previewContainer');
    const imageEl = document.getElementById('previewImg');
    const previewStrideLabel = document.getElementById('previewStrideLabel');
    const previewStrideSelect = document.getElementById('previewStride');

    logger.log(`Switching preview mode: ${state.viewMode} → ${mode}`);

    if (mode === 'zoom') {
        // ZOOM MODE: Initialize ZoomPreviewRenderer

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

        logger.log(`Zoom mode - Document: ${docWidth}×${docHeight}, Layer: ${originalLayerID}, BitDepth: ${bitDepth}`);
        logger.log(`Container size BEFORE: ${container.clientWidth}×${container.clientHeight}`);

        // Create separation data for ZoomPreviewRenderer
        const selectedPreview = posterizationData.selectedPreview;
        logger.log(`Palette debug: ${selectedPreview.paletteLab.length} colors`);
        if (selectedPreview.paletteLab.length > 0) {
            logger.log(`First color format:`, selectedPreview.paletteLab[0]);
        }

        const separationData = {
            palette: selectedPreview.paletteLab
        };

        // Add zoom mode class (container stays responsive via flex layout)
        container.classList.add('zoom-mode');

        logger.log(`Container size: ${container.clientWidth}×${container.clientHeight}`);

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
            logger.log(`Preserving solo mode: color ${state.activeSoloIndex}`);
            state.zoomRenderer.setSoloColor(state.activeSoloIndex);
        }

        logger.log(`Renderer viewport: ${state.zoomRenderer.width}×${state.zoomRenderer.height}`);

        // Initialize renderer (centers viewport, fetches first render)
        logger.log('Initializing renderer...');
        try {
            await state.zoomRenderer.init();
            logger.log('✓ Renderer initialized');
        } catch (err) {
            logger.error('Failed to initialize renderer:', err);
            throw err;
        }

        // Update dropdown label and options
        logger.log('Updating dropdown...');
        if (previewStrideLabel) {
            previewStrideLabel.textContent = 'Resolution:';
            logger.log('✓ Label updated');
        } else {
            logger.error('previewStrideLabel not found!');
        }

        if (previewStrideSelect) {
            previewStrideSelect.innerHTML = `
                <option value="1" selected>1:1 (Full Res)</option>
                <option value="2">1:2 (Half Res)</option>
                <option value="4">1:4 (Quarter Res)</option>
                <option value="8">1:8 (Eighth Res)</option>
            `;
            logger.log('✓ Dropdown options updated');
        } else {
            logger.error('previewStrideSelect not found!');
        }

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

                    logger.log(`Container resized: ${state.zoomRenderer.width}×${state.zoomRenderer.height} → ${newWidth}×${newHeight}`);

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
        logger.log('✓ Resize observer attached');

        state.viewMode = 'zoom';
        logger.log('✓ Zoom mode initialized');

    } else if (mode === 'fit') {
        // FIT MODE: Cleanup ZoomPreviewRenderer, restore renderPreview
        logger.log('Starting fit mode restoration...');

        // Cleanup zoom renderer
        if (state.zoomRenderer) {
            logger.log('Cleaning up zoom renderer...');
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
            logger.log('✓ Renderer cleaned up');
        }

        // Remove zoom event handlers
        logger.log('Detaching zoom handlers...');
        detachPreviewZoomHandlers();

        // Disconnect resize observer
        if (state._resizeObserver) {
            state._resizeObserver.disconnect();
            state._resizeObserver = null;
            logger.log('✓ Resize observer disconnected');
        }

        // Remove zoom mode class
        logger.log('Removing zoom-mode class...');
        container.classList.remove('zoom-mode');

        // Reset first image to normal (fit mode) styles
        logger.log('Resetting image 1 styles...');
        logger.log(`  Before: position=${imageEl.style.position}, transform=${imageEl.style.transform}, opacity=${imageEl.style.opacity}`);
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
        logger.log(`  After: position=${imageEl.style.position}, transform=${imageEl.style.transform}, opacity=${imageEl.style.opacity}`);

        // Hide and reset second buffer image
        const imageEl2 = document.getElementById('previewImgBuffer2');
        if (imageEl2) {
            logger.log('Resetting image 2 styles...');
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

        // Restore dropdown label and options
        logger.log('Restoring dropdown...');
        previewStrideLabel.textContent = 'Preview Quality:';
        previewStrideSelect.innerHTML = `
            <option value="4" selected>Standard (fast)</option>
            <option value="2">Fine (slow)</option>
            <option value="1">Finest (slower)</option>
        `;

        // Re-render preview in fit mode
        logger.log('Re-rendering preview in fit mode...');
        renderPreview();

        state.viewMode = 'fit';
        logger.log('✓ Fit mode restored');
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

        // Reset transform on the active image and fetch HQ at final position
        const activeImg = renderer.getActiveImage();
        if (activeImg) {
            activeImg.style.transform = 'translate3d(0, 0, 0)';
        }
        transformX = 0;
        transformY = 0;

        // Final high-quality render
        renderer.fetchAndRender(true);

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

    logger.log('✓ Preview zoom handlers attached');
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
    logger.log('✓ Preview zoom handlers detached');
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

    logger.log('Clearing swatch selection (clicked outside)');
    state.activeSoloIndex = null;
    updateSwatchHighlights();

    // Re-render preview (works in both modes)
    if (state.viewMode === 'fit') {
        renderPreview();
    } else if (state.viewMode === 'zoom' && state.zoomRenderer) {
        // Clear solo mode in zoom renderer
        state.zoomRenderer.setSoloColor(null);
        state.zoomRenderer.fetchAndRender();
        logger.log('✓ Zoom solo mode cleared');
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

    // Select this color (clicking same swatch keeps it selected)
    // To deselect, click outside the swatches or click a different swatch
    state.activeSoloIndex = paletteIndex;
    logger.log(`Selected swatch ${featureIndex + 1} (palette index ${paletteIndex})`);

    // Update swatch highlighting
    updateSwatchHighlights();

    // Re-render preview (works in both modes now!)
    if (state.viewMode === 'fit') {
        renderPreview();
    } else if (state.viewMode === 'zoom' && state.zoomRenderer) {
        // In zoom mode: Update renderer's solo color and re-render
        state.zoomRenderer.setSoloColor(paletteIndex);
        state.zoomRenderer.fetchAndRender();
        logger.log(`✓ Zoom solo mode: showing only color ${featureIndex + 1}`);
    }
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
                    logger.log(`✓ Updated Feature ${featureIndex + 1}: ${currentHex} → ${newHex}`);
                    logger.log(`  Lab: L${newLab.L.toFixed(1)} a${newLab.a.toFixed(1)} b${newLab.b.toFixed(1)}`);
                    logger.log(`  Entire feature group will remap to new ink (editing bones, not pixels)`);

                    // Convert featureIndex to full palette index (accounting for substrate)
                    const substrateIndex = selectedPalette.substrateIndex;
                    let paletteIndex = featureIndex;
                    if (substrateIndex !== null && featureIndex >= substrateIndex) {
                        paletteIndex = featureIndex + 1;  // Skip the substrate index
                    }

                    // Update full palette (used for preview rendering and layer creation)
                    selectedPalette.allHexColors[paletteIndex] = newHex;
                    selectedPalette.paletteLab[paletteIndex] = newLab;  // CRITICAL: Update Lab palette (used for layer creation)
                    logger.log(`  Full palette index: ${paletteIndex}`);

                    // Re-render entire palette to show new color, re-sort by L, and update all Lab values
                    logger.log(`🔄 Re-rendering palette with updated color...`);
                    renderPaletteSwatches();

                    // Update canvas preview with new color (use FULL palette to match assignments)
                    logger.log(`🔄 Updating canvas preview with new color...`);
                    if (window.previewState) {
                        window.previewState.palette = selectedPalette.allHexColors;
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
                event.stopPropagation(); // Prevent bubbling to container

                const featureIndex = parseInt(swatch.dataset.featureIndex);

                // Alt+Click: Toggle delete state
                if (event.altKey) {
                    logger.log(`🗑️ Swatch ${featureIndex + 1} Alt+Clicked - toggling delete state`);
                    handleSwatchDelete(featureIndex);
                    return;
                }

                // Normal click: Select this swatch (not toggle - click again to keep selected)
                logger.log(`🔍 Swatch ${featureIndex + 1} clicked - highlighting in preview`);
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
            logger.log('✓ Attached click handler to preview container (clears swatch selection)');
        }

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
                logger.log(`Color matching: ${distanceMetricSetting === 'auto' ? 'Smart Reveal → ' : ''}${metricLabel}`);

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
                            // Throttle logging to 25% intervals
                            if (percent % 25 === 0) {
                                logger.log(`Preview separation progress: ${percent}%`);
                            }
                        },
                        ditherType: ditherType,
                        mesh: meshValue,
                        ppi: documentPPI,
                        distanceMetric: distanceMetric
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
                            // Throttle logging to 25% intervals
                            if (percent % 25 === 0) {
                                logger.log(`Full-res separation progress: ${percent}%`);
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
        // Dithering settings
        ditherType: document.getElementById("ditherType")?.value ?? "none",  // Dithering algorithm
        // Mesh-aware dithering settings
        mesh: getMeshValue(),  // Screen mesh TPI (0 = pixel-level)
        ppi: PhotoshopAPI.getDocumentInfo()?.resolution || 72,  // Document PPI for mesh calculations
        // Distance metric for color matching
        distanceMetric: document.getElementById("distanceMetric")?.value ?? "cie94",  // 'cie76' (Graphic) or 'cie94' (Photographic)
        // Preprocessing (noise reduction)
        preprocessingIntensity: document.getElementById("preprocessingIntensity")?.value ?? "auto"  // 'off', 'auto', 'light', 'heavy'
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
    logger.log(`✓ Loaded archetype: "${archetype.name}" (${id})`);
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
            logger.log(`Resolution changing to 1:${resolution}...`);

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
                logger.log(`✓ Resolution changed to 1:${resolution} (scale: ${1/resolution})`);
            } finally {
                // Restore cursor
                if (viewportContainer) {
                    viewportContainer.style.cursor = '';
                }
                zoomDownsampleFactor.disabled = false;
            }
        });

        logger.log('✓ Resolution dropdown initialized: 1:1');
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
            logger.log(`✓ Zoomed to 1:${nextRes} at cursor (${mouseX}, ${mouseY})`);

            // Update dropdown to match
            if (zoomDownsampleFactor) {
                zoomDownsampleFactor.value = nextRes;
            }
        }, { passive: false });

        logger.log('✓ Wheel zoom-to-cursor initialized');
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

        logger.log('✓ Mouse drag panning initialized');
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

            logger.log(`Recentered viewport to (${renderer.viewportX}, ${renderer.viewportY})`);
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

            logger.log("✓ Zoom preview closed and cleaned up");
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
    logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.log("ANALYSE IMAGE - Starting analysis...");
    logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

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

        logger.log(`✓ Retrieved ${result.pixels.length} bytes (${result.width}×${result.height})`);

        // Generate DNA from Lab pixels
        const startTime = Date.now();
        const dna = DNAGenerator.generate(result.pixels, result.width, result.height, 40);
        const dnaTime = Date.now() - startTime;

        logger.log("✓ Image DNA extracted:", dna);
        logger.log(`  DNA generation time: ${dnaTime.toFixed(2)}ms`);

        // Run ParameterGenerator to get dynamic configuration (with entropy analysis)
        // Pass manualArchetypeId if user has manually selected an archetype
        const config = ParameterGenerator.generate(dna, {
            imageData: result.pixels,
            width: result.width,
            height: result.height,
            preprocessingIntensity: 'auto',  // Let entropy analysis decide
            manualArchetypeId: lastSelectedArchetypeId  // Bypass DNA matching if manual selection
        });
        logger.log("✓ Generated dynamic config:", config);

        // Log preprocessing decision from entropy analysis
        if (config.preprocessing) {
            const pp = config.preprocessing;
            logger.log(`✓ Preprocessing analysis: ${pp.enabled ? pp.intensity : 'off'} (${pp.reason})`);
            if (pp.entropyScore !== undefined) {
                logger.log(`  Entropy score: ${pp.entropyScore.toFixed(1)}`);
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
        logger.log(`✓ Stored DNA for Smart Reveal: peakC=${dna.maxC?.toFixed(1)}, archetype=${lastImageDNA.archetype}`);

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
            engineType: config.engineType || 'reveal',
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

        logger.log("  Setting ALL UI parameters from Expert System:");
        logger.log("  Core:", {
            targetColors: config.targetColors,
            ditherType: config.ditherType
        });
        logger.log("  Saliency:", {
            lWeight: config.lWeight,
            cWeight: config.cWeight,
            blackBias: config.blackBias
        });
        logger.log("  Vibrancy:", {
            mode: config.vibrancyMode,
            boost: config.vibrancyBoost
        });
        logger.log("  Highlights:", {
            threshold: config.highlightThreshold,
            boost: config.highlightBoost
        });
        logger.log("  Merging:", {
            paletteReduction: config.paletteReduction
        });
        logger.log("  Substrate:", config.substrateMode);

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
        logger.log(`\nDNA ANALYSIS COMPLETE`);
        logger.log(`Image DNA: L=${dna.l}, C=${dna.c}, K=${dna.k}, maxC=${dna.maxC}, range=[${dna.minL}, ${dna.maxL}]`);
        logger.log(`Archetype: ${config.meta?.archetype || 'unknown'}`);
        logger.log(`Config: ${config.name}`);
        logger.log(`  Target Colors: ${config.targetColors}`);
        logger.log(`  Black Bias: ${config.blackBias.toFixed(1)}`);
        logger.log(`  Vibrancy Boost: ${config.saturationBoost.toFixed(2)}`);
        logger.log(`  Dither Type: ${config.ditherType}`);
        logger.log(`  Smart Reveal → ${smartMetricLabel} (${smartMetric})`);
        logger.log(`  Preprocessing: ${preprocessingInfo}`);
        logger.log(`Analysis Time: ${dnaTime.toFixed(2)}ms`);

        alert(alertMsg);

        logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        logger.log("✓ ANALYSE IMAGE - Complete");
        logger.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

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
                        logger.log("✓ Palette dialog closed - plugin dismissed");
                    }
                });
            }

            // Set up Back button (goes from palette editor back to posterization settings)
            const btnBack = document.getElementById("btnBack");
            if (btnBack) {
                btnBack.addEventListener("click", () => {
                    logger.log("Back button clicked - returning to posterization settings");

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
                        logger.log("✓ Closed palette dialog");
                    }

                    // Show Posterize button (it was hidden when palette editor opened)
                    const btnPosterize = document.getElementById('btnPosterize');
                    if (btnPosterize) {
                        btnPosterize.style.display = '';
                        logger.log("✓ Posterize button restored");
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
                        logger.log("✓ Reopened main dialog (non-modal)");
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

                // Get form values and merge with stored config (includes parameters not in UI)
                const formParams = getFormValues();

                // DIAGNOSTIC: Log what we're merging
                logger.log("📋 Config merge diagnostic:");
                logger.log("  lastGeneratedConfig exists:", !!lastGeneratedConfig);
                if (lastGeneratedConfig) {
                    logger.log("  lastGeneratedConfig.id:", lastGeneratedConfig.id);
                    logger.log("  lastGeneratedConfig.distanceMetric:", lastGeneratedConfig.distanceMetric);
                    logger.log("  lastGeneratedConfig.cWeight:", lastGeneratedConfig.cWeight);
                    logger.log("  lastGeneratedConfig.vibrancyBoost:", lastGeneratedConfig.vibrancyBoost);
                }
                logger.log("  formParams.distanceMetric:", formParams.distanceMetric);
                logger.log("  formParams.cWeight:", formParams.cWeight);
                logger.log("  formParams.vibrancyBoost:", formParams.vibrancyBoost);

                const params = {
                    ...lastGeneratedConfig,  // Start with complete config from ParameterGenerator
                    ...formParams            // Override with user-adjusted UI values
                };
                const grayscaleOnly = params.colorMode === 'bw';  // Determine from dropdown

                // Log final merged parameters
                logger.log("📦 Final merged parameters:");
                logger.log("  id:", params.id);
                logger.log("  distanceMetric:", params.distanceMetric);
                logger.log("  cWeight:", params.cWeight);
                logger.log("  vibrancyBoost:", params.vibrancyBoost);
                logger.log("  targetColors:", params.targetColors);
                logger.log("  paletteReduction:", params.paletteReduction);
                if (lastGeneratedConfig) {
                    logger.log("  Config-only parameters (not in UI):", {
                        vibrancyThreshold: lastGeneratedConfig.vibrancyThreshold,
                        neutralSovereigntyThreshold: lastGeneratedConfig.neutralSovereigntyThreshold,
                        neutralCentroidClampThreshold: lastGeneratedConfig.neutralCentroidClampThreshold
                    });
                }

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

                    // Read document pixels for preview (800px max for performance)
                    logger.log(`Reading document pixels (max 800px)...`);
                    const pixelData = await PhotoshopAPI.getDocumentPixels(800, 800);
                    logger.log(`Read ${pixelData.width}x${pixelData.height} pixels (${pixelData.scale.toFixed(2)}x scale)`);
                    logger.log(`Pixel data: 16-bit Lab (source was ${pixelData.bitDepth}-bit)`);

                    // DIAGNOSTIC: Check ORIGINAL buffer before copying
                    logger.log(`🔍 DIAGNOSTIC - Original pixelData.pixels:`);
                    logger.log(`   Type: ${pixelData.pixels.constructor.name}`);
                    logger.log(`   Length: ${pixelData.pixels.length}`);
                    logger.log(`   First pixel (ORIGINAL): L=${pixelData.pixels[0]} a=${pixelData.pixels[1]} b=${pixelData.pixels[2]}`);
                    logger.log(`   Pixel at index 1000: L=${pixelData.pixels[3000]} a=${pixelData.pixels[3001]} b=${pixelData.pixels[3002]}`);
                    logger.log(`   Pixel at index 10000: L=${pixelData.pixels[30000]} a=${pixelData.pixels[30001]} b=${pixelData.pixels[30002]}`);

                    // CRITICAL: Copy pixel buffer IMMEDIATELY before any processing
                    // Photoshop may clear/reuse the buffer after the API call returns
                    const pixelsCopy = new Uint16Array(pixelData.pixels);
                    logger.log(`📦 Copied pixel buffer: ${pixelsCopy.length} elements`);
                    logger.log(`   First pixel (COPY): L=${pixelsCopy[0]} a=${pixelsCopy[1]} b=${pixelsCopy[2]}`);
                    logger.log(`   Second pixel (COPY): L=${pixelsCopy[3]} a=${pixelsCopy[4]} b=${pixelsCopy[5]}`);
                    logger.log(`   Third pixel (COPY): L=${pixelsCopy[6]} a=${pixelsCopy[7]} b=${pixelsCopy[8]}`);

                    // Apply preprocessing (bilateral filter for noise reduction) if enabled
                    // Engine always operates in 16-bit Lab space
                    const preprocessingIntensity = params.preprocessingIntensity || 'auto';

                    if (preprocessingIntensity !== 'off') {
                        buttonElement.textContent = "Preprocessing...";

                        // For "auto" mode, use DNA-based decision; for manual modes, force the setting
                        const dnaForPreprocessing = lastImageDNA || {};

                        // Calculate entropy from 16-bit Lab L channel
                        logger.log(`Entropy input: pixels type=${pixelData.pixels?.constructor?.name}, length=${pixelData.pixels?.length}, width=${pixelData.width}, height=${pixelData.height}`);
                        logger.log(`Expected length: ${pixelData.width * pixelData.height * 3}`);
                        if (pixelData.pixels && pixelData.pixels.length > 0) {
                            logger.log(`First 6 values: ${Array.from(pixelData.pixels.slice(0, 6)).join(', ')}`);
                        }
                        const entropyScore = BilateralFilter.calculateEntropyScoreLab(
                            pixelData.pixels, pixelData.width, pixelData.height
                        );
                        logger.log(`Entropy result: ${entropyScore}`);

                        // Get preprocessing config based on DNA and entropy
                        // Detect bit depth from pixel data type
                        const is16Bit = pixelData.pixels instanceof Uint16Array;
                        logger.log(`Bit depth for preprocessing: ${is16Bit ? '16-bit' : '8-bit'}`);

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
                            logger.log(`🔧 Preprocessing: ${preprocessConfig.intensity} (${preprocessConfig.reason})`);
                            logger.log(`   Entropy: ${preprocessConfig.entropyScore?.toFixed(1) || 'N/A'}, Radius: ${preprocessConfig.radius}, SigmaR: ${preprocessConfig.sigmaR}`);

                            // Apply bilateral filter in 16-bit Lab space
                            BilateralFilter.applyBilateralFilterLab(
                                pixelData.pixels,
                                pixelData.width,
                                pixelData.height,
                                preprocessConfig.radius,
                                preprocessConfig.sigmaR
                            );

                            logger.log(`✓ Preprocessing complete`);
                        } else {
                            logger.log(`⏭️ Preprocessing skipped: ${preprocessConfig.reason}`);
                        }
                    } else {
                        logger.log(`⏭️ Preprocessing: Off (user disabled)`);
                    }

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

                    // Store globally for substrate-aware swatch/preview functions
                    window.selectedPreview = selectedPreview;

                    // Use the pixel copy we made at the beginning (before any processing)
                    logger.log(`📦 Storing original pixel buffer copy: ${pixelsCopy.length} elements`);
                    logger.log(`   First 3 pixels (from original copy): L=${pixelsCopy[0]} a=${pixelsCopy[1]} b=${pixelsCopy[2]}`);

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

                        // Set up view mode dropdown
                        // Clone element to remove any existing listeners from previous posterization
                        const viewModeSelect = document.getElementById('viewMode');
                        if (viewModeSelect) {
                            const newViewModeSelect = viewModeSelect.cloneNode(true);
                            viewModeSelect.parentNode.replaceChild(newViewModeSelect, viewModeSelect);
                            newViewModeSelect.value = 'fit';  // Default to fit mode

                            newViewModeSelect.addEventListener('change', async (e) => {
                                const mode = e.target.value;
                                logger.log(`View mode changing to: ${mode}`);

                                document.body.style.cursor = 'wait';
                                try {
                                    await setPreviewMode(mode);
                                    logger.log(`✓ View mode switched to ${mode}`);
                                } catch (error) {
                                    logger.error('Failed to switch view mode:', error);
                                    showErrorDialog("View Mode Error", error.message, error.stack);
                                } finally {
                                    document.body.style.cursor = '';
                                }
                            });
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

                logger.log(`✓ Populated archetype selector with ${Object.keys(ARCHETYPES).length} archetypes`);

                // Add change event listener
                archetypeSelector.addEventListener('change', async () => {
                    const selectedValue = archetypeSelector.value;
                    logger.log(`Archetype selector changed to: ${selectedValue}`);

                    if (selectedValue === 'auto') {
                        // "Analyze Image..." - trigger DNA analysis
                        logger.log("Triggering DNA analysis...");
                        lastSelectedArchetypeId = null;  // Clear manual selection
                        await handleAnalyzeImage();
                    } else if (selectedValue === 'manual') {
                        // "Manual Input" - reset to defaults
                        logger.log("Resetting to manual input (defaults)...");
                        lastSelectedArchetypeId = null;  // Clear manual selection

                        // Use the same defaults as btnResetDefaults
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

                        logger.log("✓ Reset to manual input defaults");
                    } else {
                        // Archetype selected - load parameters from archetype
                        logger.log(`🔍 TRACE: Entering archetype selection for: ${selectedValue}`);
                        const archetype = ARCHETYPES[selectedValue];
                        logger.log(`🔍 TRACE: Archetype found:`, archetype ? 'YES' : 'NO');
                        logger.log(`🔍 TRACE: Has parameters:`, archetype?.parameters ? 'YES' : 'NO');

                        if (archetype && archetype.parameters) {
                            logger.log(`Loading parameters from archetype: ${archetype.name}`);
                            lastSelectedArchetypeId = selectedValue;  // Store manual selection ID
                            logger.log(`🔍 TRACE: Set lastSelectedArchetypeId to: ${lastSelectedArchetypeId}`);

                            const params = archetype.parameters;
                            logger.log(`🔍 TRACE: params object:`, params);

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
                                maskProfile: params.maskProfile
                            };

                            // Apply parameters to UI
                            logger.log(`🔍 TRACE: Starting UI application loop for ${Object.keys(paramMapping).length} parameters`);

                            try {
                                Object.keys(paramMapping).forEach(key => {
                                    logger.log(`🔍 TRACE: Processing parameter: ${key}`);
                                const element = document.getElementById(key);
                                if (!element) {
                                    logger.log(`  Element not found for parameter: ${key}`);
                                    return;
                                }

                                const value = paramMapping[key];

                                // Special diagnostic for paletteReduction
                                if (key === 'paletteReduction') {
                                    logger.log(`🔍 PALETTE REDUCTION TRACE:`);
                                    logger.log(`  Value from archetype: ${value}`);
                                    logger.log(`  Element type: ${element.tagName}`);
                                    logger.log(`  Current element value BEFORE: ${element.value}`);
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
                                        logger.log(`  Element value AFTER setting: ${element.value}`);
                                        logger.log(`  Display value: ${valueDisplay ? valueDisplay.textContent : 'N/A'}`);
                                    }
                                }

                                    // Log if paletteReduction wasn't handled by any branch
                                    if (key === 'paletteReduction' && element.tagName !== 'SP-SLIDER' && element.tagName !== 'SELECT' && element.type !== 'checkbox') {
                                        logger.log(`  ⚠️ WARNING: paletteReduction element is ${element.tagName} with type ${element.type}, not handled!`);
                                    }
                                });

                                logger.log(`🔍 TRACE: Finished UI application loop successfully`);
                            } catch (error) {
                                logger.error(`❌ ERROR in UI application loop:`, error);
                                logger.error(`   Error message: ${error.message}`);
                                logger.error(`   Error stack:`, error.stack);
                            }

                            logger.log(`🔍 TRACE: Finished applying ${Object.keys(paramMapping).length} parameters to UI`);

                            // Store the complete config for posterization (includes parameters not in UI)
                            // CRITICAL: Must include archetype ID and metadata to prevent parameter dilution
                            logger.log(`🔍 TRACE: About to set lastGeneratedConfig...`);
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

                            logger.log(`✓ Loaded ${Object.keys(paramMapping).length} parameters from archetype: ${archetype.name}`);
                            logger.log(`✓ Stored complete config: id=${lastGeneratedConfig.id}, distanceMetric=${lastGeneratedConfig.distanceMetric}, cWeight=${lastGeneratedConfig.cWeight}`);
                        } else {
                            logger.error(`Archetype not found or missing parameters: ${selectedValue}`);
                        }
                    }
                });

                logger.log("✓ Archetype selector event listener attached");
            }

            // Preview Quality dropdown - reassign pixels with new stride (fit mode) or change resolution (zoom mode)
            // Clone element to remove any existing listeners from previous posterization
            const previewStrideSelect = document.getElementById('previewStride');
            if (previewStrideSelect) {
                const newPreviewStrideSelect = previewStrideSelect.cloneNode(true);
                previewStrideSelect.parentNode.replaceChild(newPreviewStrideSelect, previewStrideSelect);

                newPreviewStrideSelect.addEventListener('change', async () => {
                    if (!posterizationData || !window.previewState) return;

                    const value = parseInt(newPreviewStrideSelect.value, 10);
                    const state = window.previewState;

                    if (state.viewMode === 'fit') {
                        // FIT MODE: Change stride (existing logic)
                        const stride = value;
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
                                const bitDepth = posterizationData.bitDepth || 8;
                                const assignments = PosterizationEngine.reassignWithStride(
                                    pixels, paletteLab, width, height, stride, bitDepth
                                );

                                window.previewState.assignments = assignments;
                                renderPreview();
                                logger.log(`✓ Preview updated: stride=${stride}, bitDepth=${bitDepth}`);
                            } catch (err) {
                                logger.error('Stride change error:', err);
                            }
                            document.body.style.cursor = '';
                        }, 50);

                    } else if (state.viewMode === 'zoom') {
                        // ZOOM MODE: Change resolution
                        logger.log(`Resolution changing to 1:${value}`);

                        if (state.zoomRenderer) {
                            const centerX = state.zoomRenderer.width / 2;
                            const centerY = state.zoomRenderer.height / 2;
                            await state.zoomRenderer.setResolutionAtPoint(value, centerX, centerY);
                        }
                    }
                });
            }

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
                logger.log("✓ Analyse Image button handler attached");
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

        // Set up View Mode switching (Phase 1: UI state machine)
        // OUTSIDE listenersAttached guard so it runs every time dialog opens
        const viewModeSelect = document.getElementById('viewMode');
        if (viewModeSelect) {
            // Remove existing listener if any to prevent duplicates
            const newSelect = viewModeSelect.cloneNode(true);
            viewModeSelect.parentNode.replaceChild(newSelect, viewModeSelect);

            newSelect.addEventListener('change', (e) => {
                const mode = e.target.value;
                logger.log(`[ViewMode] Switching to: ${mode}`);

                const navigatorMap = document.getElementById('navigatorMapContainer');
                const diagnosticTools = document.getElementById('diagnosticTools');
                const qualityGroup = document.getElementById('previewQualityGroup');

                if (mode === '1:1') {
                    // Show 1:1 Clinical Loupe UI
                    if (navigatorMap) navigatorMap.style.display = 'block';
                    if (diagnosticTools) diagnosticTools.style.display = 'flex';
                    if (qualityGroup) qualityGroup.style.display = 'none';
                    logger.log('[ViewMode] ✓ 1:1 mode UI shown');
                } else {
                    // Show standard Fit/Zoom UI
                    if (navigatorMap) navigatorMap.style.display = 'none';
                    if (diagnosticTools) diagnosticTools.style.display = 'none';
                    if (qualityGroup) qualityGroup.style.display = 'flex';
                    logger.log(`[ViewMode] ✓ ${mode} mode UI shown`);
                }
            });
            logger.log('[ViewMode] ✓ View mode switcher initialized');
        } else {
            logger.error('[ViewMode] ❌ viewMode select not found!');
        }

        // NOW show the dialog (after all event listeners are set up)
        // NON-MODAL to allow access to Photoshop Color Panel for LAB slider sync
        logger.log("All event listeners set up, now showing dialog (non-modal)...");
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

// Enable Proxy Mode Test Harness (Sovereign Foundation)
const { ProxyModeTestHarness } = require('./ProxyModeTestHarness');
ProxyModeTestHarness.attach();
