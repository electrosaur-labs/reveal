/**
 * ColorSpace - Lab/RGB Color Conversions and Distance Calculations
 *
 * Provides perceptually-accurate color space transformations using:
 * - CIE D65 illuminant
 * - sRGB color space matrices
 * - CIE76 ΔE distance calculations
 *
 * Extracted from PosterizationEngine for modularity.
 *
 * NOTE: Distance functions are now delegated to lib/color/LabDistance.js
 * The functions here are preserved for backwards compatibility but marked
 * as deprecated. New code should import from LabDistance directly.
 */

const LabDistance = require('../color/LabDistance');

/**
 * sRGB gamma correction (inverse): sRGB → Linear RGB
 * @private
 */
function gammaToLinear(channel) {
    if (channel <= 0.04045) {
        return channel / 12.92;
    } else {
        return Math.pow((channel + 0.055) / 1.055, 2.4);
    }
}

/**
 * sRGB gamma correction (forward): Linear RGB → sRGB
 * @private
 */
function linearToGamma(channel) {
    if (channel <= 0.0031308) {
        return channel * 12.92;
    } else {
        return 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
    }
}

/**
 * XYZ to Lab helper function (CIE standard function)
 * @private
 */
function xyzToLabHelper(t) {
    const delta = 6 / 29;
    if (t > delta * delta * delta) {
        return Math.pow(t, 1 / 3);
    } else {
        return t / (3 * delta * delta) + 4 / 29;
    }
}

/**
 * Lab to XYZ helper function (CIE standard function inverse)
 * @private
 */
function labToXyzHelper(t) {
    const delta = 6 / 29;
    if (t > delta) {
        return t * t * t;
    } else {
        return 3 * delta * delta * (t - 4 / 29);
    }
}

/**
 * Convert sRGB color to CIELAB color space
 *
 * Pipeline: sRGB → Linear RGB → XYZ → CIELAB
 * Uses D65 illuminant and sRGB color space matrices
 *
 * @param {Object} rgb - {r: 0-255, g: 0-255, b: 0-255}
 * @returns {Object} lab - {L: 0-100, a: -128 to 127, b: -128 to 127}
 */
function rgbToLab(rgb) {
    // Step 1: sRGB to Linear RGB (inverse gamma correction)
    const r = gammaToLinear(rgb.r / 255);
    const g = gammaToLinear(rgb.g / 255);
    const b = gammaToLinear(rgb.b / 255);

    // Step 2: Linear RGB to XYZ (using sRGB matrix)
    let x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
    let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    let z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;

    // Step 3: Normalize by D65 illuminant
    x = x / 0.95047;
    y = y / 1.00000;
    z = z / 1.08883;

    // Step 4: XYZ to Lab (CIE 1976)
    x = xyzToLabHelper(x);
    y = xyzToLabHelper(y);
    z = xyzToLabHelper(z);

    const L = 116 * y - 16;
    const a = 500 * (x - y);
    const b_value = 200 * (y - z);

    return { L, a, b: b_value };
}

/**
 * Convert CIELAB color to sRGB color space
 *
 * Pipeline: CIELAB → XYZ → Linear RGB → sRGB
 * Uses D65 illuminant and sRGB color space matrices
 * Includes gamut mapping to prevent clipping artifacts
 *
 * @param {Object} lab - {L: 0-100, a: -128 to 127, b: -128 to 127}
 * @returns {Object} rgb - {r: 0-255, g: 0-255, b: 0-255}
 */
function labToRgb(lab) {
    // GAMUT MAPPING: If Lab color is out of sRGB gamut, reduce chroma while preserving hue
    // This prevents yellow → orange shifts caused by hard clipping
    const MAX_ITERATIONS = 20;
    let currentLab = { L: lab.L, a: lab.a, b: lab.b };
    let iteration = 0;
    let inGamut = false;

    while (!inGamut && iteration < MAX_ITERATIONS) {
        // Step 1: Lab to XYZ
        let y = (currentLab.L + 16) / 116;
        let x = currentLab.a / 500 + y;
        let z = y - currentLab.b / 200;

        x = labToXyzHelper(x) * 0.95047;
        y = labToXyzHelper(y) * 1.00000;
        z = labToXyzHelper(z) * 1.08883;

        // Step 2: XYZ to Linear RGB
        let r = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
        let g = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
        let b = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

        // Step 3: Linear RGB to sRGB (gamma correction)
        r = linearToGamma(r);
        g = linearToGamma(g);
        b = linearToGamma(b);

        // Check if in gamut (all channels 0-1 range)
        if (r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1) {
            inGamut = true;
            // Step 4: Scale to 0-255
            return {
                r: Math.round(r * 255),
                g: Math.round(g * 255),
                b: Math.round(b * 255)
            };
        }

        // Out of gamut: Reduce chroma by 5% while preserving hue
        currentLab.a *= 0.95;
        currentLab.b *= 0.95;
        iteration++;
    }

    // Fallback: If still out of gamut after iterations, clamp
    let y = (currentLab.L + 16) / 116;
    let x = currentLab.a / 500 + y;
    let z = y - currentLab.b / 200;

    x = labToXyzHelper(x) * 0.95047;
    y = labToXyzHelper(y) * 1.00000;
    z = labToXyzHelper(z) * 1.08883;

    let r = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
    let g = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
    let b = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

    r = linearToGamma(r);
    g = linearToGamma(g);
    b = linearToGamma(b);

    // Clamp and scale to 0-255
    r = Math.max(0, Math.min(255, Math.round(r * 255)));
    g = Math.max(0, Math.min(255, Math.round(g * 255)));
    b = Math.max(0, Math.min(255, Math.round(b * 255)));

    return { r, g, b };
}

/**
 * Internal RGB to Lab conversion (slightly different implementation)
 *
 * @private
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {{L: number, a: number, b: number}} - LAB values
 */
function _rgbToLab(r, g, b) {
    // Step 1: RGB [0-255] → RGB [0-1]
    let R = r / 255;
    let G = g / 255;
    let B = b / 255;

    // Step 2: Apply gamma correction (sRGB → linear RGB)
    R = (R > 0.04045) ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
    G = (G > 0.04045) ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
    B = (B > 0.04045) ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;

    // Step 3: Linear RGB → XYZ (D65 illuminant matrix)
    let X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
    let Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
    let Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;

    // Step 4: Normalize to D65 white point
    X = X / 0.95047;
    Y = Y / 1.00000;
    Z = Z / 1.08883;

    // Step 5: XYZ → LAB
    const epsilon = 0.008856;
    const kappa = 903.3;

    const fx = (X > epsilon) ? Math.pow(X, 1/3) : (kappa * X + 16) / 116;
    const fy = (Y > epsilon) ? Math.pow(Y, 1/3) : (kappa * Y + 16) / 116;
    const fz = (Z > epsilon) ? Math.pow(Z, 1/3) : (kappa * Z + 16) / 116;

    const L = 116 * fy - 16;
    const a = 500 * (fx - fy);
    const b_lab = 200 * (fy - fz);

    return { L, a, b: b_lab };
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
    const lab1 = _rgbToLab(color1.r, color1.g, color1.b);
    const lab2 = _rgbToLab(color2.r, color2.g, color2.b);

    // Delegate to centralized LabDistance module
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
    // Public API
    rgbToLab,
    labToRgb,
    colorDistance,
    labDistance,
    weightedLabDistance,
    calculateCIELABDistance,
    paletteToHex,
    calculateHexDistance,

    // Internal helpers (exposed for PosterizationEngine compatibility)
    _rgbToLab,
    _gammaToLinear: gammaToLinear,
    _linearToGamma: linearToGamma,
    _xyzToLabHelper: xyzToLabHelper,
    _labToXyzHelper: labToXyzHelper
};
