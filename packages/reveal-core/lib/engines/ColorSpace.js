/**
 * ColorSpace - Lab/RGB Color Conversions and Distance Calculations
 *
 * All RGB↔Lab conversions are now centralized in lib/color/LabEncoding.js.
 * This module delegates to LabEncoding and preserves the API for backwards
 * compatibility. Distance functions delegate to lib/color/LabDistance.js.
 *
 * New code should import from LabEncoding or LabDistance directly.
 */

const LabDistance = require('../color/LabDistance');
const LabEncoding = require('../color/LabEncoding');

/** Convert sRGB to CIELAB. Delegates to LabEncoding. */
function rgbToLab(rgb) {
    return LabEncoding.rgbToLab(rgb);
}

/** Convert CIELAB to sRGB with gamut mapping. Delegates to LabEncoding. */
function labToRgb(lab) {
    return LabEncoding.labToRgb(lab);
}

/**
 * Calculate perceptual distance between two RGB colors using CIE76 (CIELAB ΔE)
 *
 * More perceptually accurate than RGB Euclidean distance. Better handles
 * dark/light colors and matches human vision sensitivity.
 *
 * Scale: 0-2 = imperceptible, 5-10 = noticeable, 10+ = clearly different
 *
 * @deprecated For Lab inputs, use LabDistance.cie76() from lib/color/LabDistance.js instead.
 *
 * @param {{r,g,b}} color1 - First color
 * @param {{r,g,b}} color2 - Second color
 * @returns {number} - Delta E (ΔE) distance
 */
function colorDistance(color1, color2) {
    const lab1 = LabEncoding.rgbToLab(color1);
    const lab2 = LabEncoding.rgbToLab(color2);

    return LabDistance.cie76(lab1, lab2);
}

/**
 * Calculate perceptual distance (ΔE) between two Lab colors
 *
 * @deprecated Use LabDistance.cie76() from lib/color/LabDistance.js instead.
 *
 * @param {{L: number, a: number, b: number}} lab1 - First Lab color
 * @param {{L: number, a: number, b: number}} lab2 - Second Lab color
 * @returns {number} - Perceptual distance (ΔE)
 */
function labDistance(lab1, lab2) {
    // Delegate to centralized LabDistance module
    return LabDistance.cie76(lab1, lab2);
}

/**
 * PERCEPTUAL L-SCALING: Weighted Lab distance for shadow preservation
 *
 * The human eye is much more sensitive to lightness changes in dark areas
 * than in light areas. This prevents dark greens and shadows from being
 * washed out into a single flat black/dark-grey layer.
 *
 * @deprecated Use LabDistance.cie76Weighted() from lib/color/LabDistance.js instead.
 *
 * @param {{L: number, a: number, b: number}} lab1 - First Lab color
 * @param {{L: number, a: number, b: number}} lab2 - Second Lab color
 * @returns {number} - Weighted perceptual distance
 */
function weightedLabDistance(lab1, lab2) {
    // Delegate to centralized LabDistance module
    return LabDistance.cie76Weighted(lab1, lab2);
}

/**
 * Calculate CIELAB ΔE SQUARED distance with L-channel emphasis (CIE76 modified)
 *
 * Over-weights the L (Lightness) channel to emphasize tonal contrast,
 * which creates the "bones" of the image in screen printing separations.
 * Shadows and highlights define subject structure.
 *
 * Performance: Returns SQUARED distance (no sqrt) - sufficient for comparisons.
 * When comparing distances, sqrt is unnecessary since sqrt(a) < sqrt(b) ⟺ a < b.
 *
 * Formula: ΔE² = 1.5*dL² + da² + db²
 * Standard CIE76: ΔE = sqrt(dL² + da² + db²)
 *
 * @param {Object} lab1 - {L, a, b}
 * @param {Object} lab2 - {L, a, b}
 * @param {boolean} isGrayscale - Use higher L weight for grayscale
 * @returns {number} distanceSquared - Perceptual distance squared (L-weighted)
 */
function calculateCIELABDistance(lab1, lab2, isGrayscale = false) {
    const deltaL = lab1.L - lab2.L;
    const deltaA = lab1.a - lab2.a;
    const deltaB = lab1.b - lab2.b;

    // Luma-aware weighting per Architect guidance:
    // Grayscale: L_WEIGHT = 3.0 (human vision extremely sensitive to luma steps)
    // Color: L_WEIGHT = 1.5 (balanced tonal structure)
    const L_WEIGHT = isGrayscale ? 3.0 : 1.5;

    // Return squared distance (no sqrt) - faster and sufficient for comparisons
    return L_WEIGHT * deltaL * deltaL + deltaA * deltaA + deltaB * deltaB;
}

/**
 * Convert RGB palette to hex color strings
 *
 * @param {Array<{r,g,b}>} palette - Color palette
 * @returns {Array<string>} - Array of hex color strings (e.g., ["#FF0000", "#00FF00"])
 */
function paletteToHex(palette) {
    return palette.map(color => {
        const r = color.r.toString(16).padStart(2, '0');
        const g = color.g.toString(16).padStart(2, '0');
        const b = color.b.toString(16).padStart(2, '0');
        return `#${r}${g}${b}`.toUpperCase();
    });
}

/**
 * Calculate perceptual distance (CIE76 ΔE) between two hex colors
 *
 * Used for real-time validation in the palette editor. Returns ΔE distance
 * where values < 12 indicate colors that are too perceptually similar.
 *
 * @param {string} hex1 - First color (e.g., "#FF0000")
 * @param {string} hex2 - Second color (e.g., "#FE0000")
 * @returns {number} - CIE76 ΔE distance (0 = identical, >12 = distinct)
 */
function calculateHexDistance(hex1, hex2) {
    // Parse hex colors to RGB
    const rgb1 = {
        r: parseInt(hex1.slice(1, 3), 16),
        g: parseInt(hex1.slice(3, 5), 16),
        b: parseInt(hex1.slice(5, 7), 16)
    };
    const rgb2 = {
        r: parseInt(hex2.slice(1, 3), 16),
        g: parseInt(hex2.slice(3, 5), 16),
        b: parseInt(hex2.slice(5, 7), 16)
    };

    // Use existing color distance calculation
    return colorDistance(rgb1, rgb2);
}

module.exports = {
    // Public API (delegates to LabEncoding)
    rgbToLab,
    labToRgb,

    // Distance functions (delegates to LabDistance)
    colorDistance,
    labDistance,
    weightedLabDistance,
    calculateCIELABDistance,

    // Utilities
    paletteToHex,
    calculateHexDistance
};
