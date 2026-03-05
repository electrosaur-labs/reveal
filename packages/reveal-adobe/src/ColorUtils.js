/**
 * ColorUtils - Pure color helper functions
 *
 * Zero state dependencies. All functions are pure or take explicit parameters.
 */

const Reveal = require("@electrosaur-labs/core");
const PosterizationEngine = Reveal.engines.PosterizationEngine;
const logger = Reveal.logger;

/**
 * Validate hex color string
 * @param {string} hex - Hex color string (with or without #)
 * @returns {boolean} - True if valid hex color
 */
function isValidHex(hex) {
    hex = hex.replace('#', '');
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
 * Convert RGB float values (0-1) to hex string
 * Photoshop Color Picker returns RGB as floats 0-1
 * @param {Object} rgbFloat - {red, grain/green, blue} values 0-1
 * @returns {string} - Hex color string #RRGGBB
 */
function rgbFloatToHex(rgbFloat) {
    const r = Math.round((rgbFloat.red || 0) * 255);
    const g = Math.round((rgbFloat.grain || rgbFloat.green || 0) * 255);
    const b = Math.round((rgbFloat.blue || 0) * 255);

    return '#' +
        r.toString(16).padStart(2, '0').toUpperCase() +
        g.toString(16).padStart(2, '0').toUpperCase() +
        b.toString(16).padStart(2, '0').toUpperCase();
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
 * Resolve "auto" distance metric to actual metric using DNA-based rule
 * Rule: (peakChroma > 80 OR isPhotographic) → 'cie94', else 'cie76'
 * Note: CIE2000 is never auto-selected; it's a manual "Museum Grade" choice
 *
 * @param {string} metricSetting - 'auto', 'cie76', 'cie94', or 'cie2000'
 * @param {Object} dna - Image DNA with maxC and archetype (optional)
 * @returns {string} - Resolved metric: 'cie76', 'cie94', or 'cie2000'
 */
function resolveDistanceMetric(metricSetting, dna) {
    if (metricSetting !== 'auto') {
        return metricSetting;
    }

    if (dna) {
        const peakChroma = dna.maxC || 0;
        const isPhotographic = dna.archetype === 'Photographic';
        return (peakChroma > 80 || isPhotographic) ? 'cie94' : 'cie76';
    }

    // No DNA available - default to cie94 (safer for unknown images)
    return 'cie94';
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
            await action.batchPlay([{
                _obj: "set",
                _target: [{ _ref: "color", _property: "foregroundColor" }],
                to: {
                    _obj: "RGBColor",
                    red: initialColor.r,
                    grain: initialColor.g,
                    blue: initialColor.b
                }
            }], {});

            const response = await action.batchPlay([{
                _obj: "showColorPicker"
            }], {});

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
        return null;
    }

    return result;
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

    const survivorIndices = [];
    const survivorLabColors = [];

    for (let i = 0; i < hexColors.length; i++) {
        if (!deletedIndices.has(i)) {
            survivorIndices.push(i);
            const rgb = hexToRgb(hexColors[i]);
            const lab = PosterizationEngine.rgbToLab(rgb);
            survivorLabColors.push(lab);
        }
    }

    for (let i = 0; i < hexColors.length; i++) {
        if (deletedIndices.has(i)) {
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
            remapTable[i] = i;
        }
    }

    return remapTable;
}

module.exports = {
    isValidHex,
    hexToRgb,
    rgbToHex,
    rgbFloatToHex,
    bufferToBase64,
    resolveDistanceMetric,
    showPhotoshopColorPicker,
    buildRemapTable
};
