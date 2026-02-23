/**
 * LabEncoding.js — Centralized Lab Color Encoding Constants & Conversions
 *
 * All Lab encoding conversions flow through this module.
 * Three encoding spaces are used in the pipeline:
 *
 *   8-bit PSD:    L: 0-255,   a/b: 0-255   (neutral a/b = 128)
 *   Engine 16-bit: L: 0-32768, a/b: 0-32768 (neutral a/b = 16384)
 *   PSD ICC 16-bit: L: 0-65535, a/b: 0-65535 (neutral a/b = 32768)
 *   Perceptual:    L: 0-100,   a/b: -128..+127
 *
 * Engine 16-bit is the canonical internal representation.
 * All core computation should stay in Engine 16-bit.
 * Conversions to/from 8-bit or perceptual happen only at system boundaries
 * (PSD I/O, DNA calculation, palette display, UXP pixel reads).
 *
 * @module LabEncoding
 */

// ============================================================================
// Constants
// ============================================================================

/** Maximum L value in engine 16-bit encoding (maps to L=100) */
const LAB16_L_MAX = 32768;

/** Neutral a/b value in engine 16-bit encoding (maps to a=0, b=0) */
const LAB16_AB_NEUTRAL = 16384;

/** Scale factor: perceptual L (0-100) → engine 16-bit. Multiply L by this. */
const L_SCALE = LAB16_L_MAX / 100;  // 327.68

/** Scale factor: perceptual a/b offset → engine 16-bit offset. Multiply (a or b) by this. */
const AB_SCALE = LAB16_AB_NEUTRAL / 128;  // 128.0

/** Neutral a/b value in 8-bit PSD encoding */
const LAB8_AB_NEUTRAL = 128;

/** Scale factor for PSD ICC 16-bit (0-65535) ↔ 8-bit (0-255): 65535/255 = 257 */
const PSD16_SCALE = 257;

// ============================================================================
// Bulk Buffer Conversions (for pixel arrays)
// ============================================================================

/**
 * Convert 8-bit PSD Lab buffer to engine 16-bit Lab buffer.
 *
 * 8-bit PSD:     L: 0-255,   a/b: 0-255   (128=neutral)
 * Engine 16-bit: L: 0-32768, a/b: 0-32768 (16384=neutral)
 *
 * @param {Uint8Array|Uint8ClampedArray} lab8 - Input 8-bit Lab (3 values/pixel: L, a, b)
 * @param {number} pixelCount - Number of pixels
 * @returns {Uint16Array} Engine 16-bit Lab buffer
 */
function convert8bitTo16bitLab(lab8, pixelCount) {
    const lab16 = new Uint16Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const off = i * 3;
        // L: 0-255 → 0-32768
        lab16[off] = Math.round(lab8[off] * (LAB16_L_MAX / 255));
        // a/b: signed shift from 128-neutral to 16384-neutral
        lab16[off + 1] = (lab8[off + 1] - LAB8_AB_NEUTRAL) * AB_SCALE + LAB16_AB_NEUTRAL;
        lab16[off + 2] = (lab8[off + 2] - LAB8_AB_NEUTRAL) * AB_SCALE + LAB16_AB_NEUTRAL;
    }

    return lab16;
}

/**
 * Convert PSD ICC 16-bit Lab buffer to engine 16-bit Lab buffer.
 *
 * PSD ICC 16-bit: L: 0-65535, a/b: 0-65535 (32768=neutral)
 * Engine 16-bit:  L: 0-32768, a/b: 0-32768 (16384=neutral)
 *
 * Simple right-shift by 1 (divide by 2). Max L=65535 → 32767 (off by 1 at ceiling,
 * 0.003% error — visually indistinguishable).
 *
 * @param {Uint16Array} psd16 - PSD ICC 16-bit Lab (3 values/pixel)
 * @param {number} pixelCount - Number of pixels
 * @returns {Uint16Array} Engine 16-bit Lab buffer
 */
function convertPsd16bitToEngineLab(psd16, pixelCount) {
    const lab16 = new Uint16Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const off = i * 3;
        lab16[off]     = psd16[off] >> 1;
        lab16[off + 1] = psd16[off + 1] >> 1;
        lab16[off + 2] = psd16[off + 2] >> 1;
    }

    return lab16;
}

/**
 * Convert PSD ICC 16-bit Lab buffer to 8-bit PSD Lab buffer.
 *
 * PSD ICC 16-bit: L: 0-65535, a/b: 0-65535 (32768=neutral)
 * 8-bit PSD:     L: 0-255,   a/b: 0-255   (128=neutral)
 *
 * Standard ICC 16→8 scaling: divide by 257 (= 65535/255).
 * Neutral a/b: 32768/257 = 127.5 → 128 ✓
 *
 * @param {Uint16Array} psd16 - PSD ICC 16-bit Lab (3 values/pixel)
 * @param {number} pixelCount - Number of pixels
 * @returns {Uint8Array} 8-bit PSD Lab buffer
 */
function convertPsd16bitTo8bitLab(psd16, pixelCount) {
    const lab8 = new Uint8Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const off = i * 3;
        lab8[off]     = Math.round(psd16[off] / PSD16_SCALE);
        lab8[off + 1] = Math.round(psd16[off + 1] / PSD16_SCALE);
        lab8[off + 2] = Math.round(psd16[off + 2] / PSD16_SCALE);
    }

    return lab8;
}

/**
 * Convert engine 16-bit Lab buffer to 8-bit PSD Lab buffer.
 *
 * Engine 16-bit: L: 0-32768, a/b: 0-32768 (16384=neutral)
 * 8-bit PSD:    L: 0-255,   a/b: 0-255   (128=neutral)
 *
 * L: divide by (32768/255) ≈ 128.5
 * a/b: (value - 16384) / 128 + 128  — re-center from 16384 to 128
 *
 * NOTE: This is NOT the same as dividing by 257 (which assumes PSD ICC 0-65535 range).
 * The old batch code used /257 here which was incorrect for engine encoding.
 *
 * @param {Uint16Array} lab16 - Engine 16-bit Lab (3 values/pixel)
 * @param {number} pixelCount - Number of pixels
 * @returns {Uint8Array} 8-bit PSD Lab buffer
 */
function convertEngine16bitTo8bitLab(lab16, pixelCount) {
    const lab8 = new Uint8Array(pixelCount * 3);
    const lScale = 255 / LAB16_L_MAX;  // 255/32768

    for (let i = 0; i < pixelCount; i++) {
        const off = i * 3;
        // L: 0-32768 → 0-255
        lab8[off] = Math.round(Math.min(255, lab16[off] * lScale));
        // a/b: 0-32768 (neutral=16384) → 0-255 (neutral=128)
        lab8[off + 1] = Math.round(Math.min(255, (lab16[off + 1] - LAB16_AB_NEUTRAL) / AB_SCALE + LAB8_AB_NEUTRAL));
        lab8[off + 2] = Math.round(Math.min(255, (lab16[off + 2] - LAB16_AB_NEUTRAL) / AB_SCALE + LAB8_AB_NEUTRAL));
    }

    return lab8;
}

/**
 * Convert engine 16-bit Lab buffer to 8-bit PSD Lab buffer (inverse of convert8bitTo16bitLab).
 * Alias that matches the pattern used in the Navigator's PhotoshopBridge.
 *
 * @param {Uint16Array} lab16 - Engine 16-bit Lab (3 values/pixel)
 * @param {number} pixelCount - Number of pixels
 * @returns {Uint8Array} 8-bit PSD Lab buffer
 */
const lab16to8 = convertEngine16bitTo8bitLab;

/**
 * Convert 8-bit PSD Lab buffer to engine 16-bit Lab buffer.
 * Alias that matches the pattern used in PhotoshopAPI/PhotoshopBridge.
 *
 * @param {Uint8Array|Uint8ClampedArray} lab8 - Input 8-bit Lab (3 values/pixel)
 * @param {number} pixelCount - Number of pixels
 * @returns {Uint16Array} Engine 16-bit Lab buffer
 */
const lab8to16 = convert8bitTo16bitLab;

// ============================================================================
// Single-Pixel Conversions (for palette entries, UI, etc.)
// ============================================================================

/**
 * Convert a single perceptual Lab color to engine 16-bit encoding.
 *
 * Perceptual:     L: 0-100, a: -128..+127, b: -128..+127
 * Engine 16-bit: L: 0-32768, a/b: 0-32768 (16384=neutral)
 *
 * @param {number} L - Lightness (0-100)
 * @param {number} a - Green-red axis (-128..+127)
 * @param {number} b - Blue-yellow axis (-128..+127)
 * @returns {{L16: number, a16: number, b16: number}}
 */
function perceptualToEngine16(L, a, b) {
    return {
        L16: Math.round((L / 100) * LAB16_L_MAX),
        a16: Math.round(a * AB_SCALE + LAB16_AB_NEUTRAL),
        b16: Math.round(b * AB_SCALE + LAB16_AB_NEUTRAL)
    };
}

/**
 * Convert a single engine 16-bit Lab value to perceptual encoding.
 *
 * Engine 16-bit: L: 0-32768, a/b: 0-32768 (16384=neutral)
 * Perceptual:    L: 0-100, a: -128..+127, b: -128..+127
 *
 * @param {number} L16 - Engine 16-bit L (0-32768)
 * @param {number} a16 - Engine 16-bit a (0-32768, 16384=neutral)
 * @param {number} b16 - Engine 16-bit b (0-32768, 16384=neutral)
 * @returns {{L: number, a: number, b: number}}
 */
function engine16ToPerceptual(L16, a16, b16) {
    return {
        L: (L16 / LAB16_L_MAX) * 100,
        a: (a16 - LAB16_AB_NEUTRAL) / AB_SCALE,
        b: (b16 - LAB16_AB_NEUTRAL) / AB_SCALE
    };
}

// ============================================================================
// Display Conversions (Lab → RGB → Hex for UI)
// ============================================================================

/**
 * Convert 8-bit Lab pixel buffer to RGB pixel buffer.
 *
 * Uses Lab→XYZ→sRGB pipeline with D50 reference white and Bradford
 * chromatic adaptation. Includes sRGB gamma correction.
 *
 * @param {Uint8Array|Uint8ClampedArray} lab8 - 8-bit Lab (3 values/pixel)
 * @param {number} pixelCount - Number of pixels
 * @returns {Uint8Array} RGB buffer (3 values/pixel: R, G, B each 0-255)
 */
function lab8bitToRgb(lab8, pixelCount) {
    const rgb = new Uint8Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const off = i * 3;
        const L = (lab8[off] / 255) * 100;
        const a = lab8[off + 1] - 128;
        const b = lab8[off + 2] - 128;

        // Lab to XYZ (D50 illuminant)
        const fy = (L + 16) / 116;
        const fx = a / 500 + fy;
        const fz = fy - b / 200;

        const xr = fx > 0.206893 ? fx * fx * fx : (fx - 16 / 116) / 7.787;
        const yr = fy > 0.206893 ? fy * fy * fy : (fy - 16 / 116) / 7.787;
        const zr = fz > 0.206893 ? fz * fz * fz : (fz - 16 / 116) / 7.787;

        const X = xr * 96.422;
        const Y = yr * 100.0;
        const Z = zr * 82.521;

        // XYZ to sRGB (with D50→D65 Bradford adaptation baked in)
        let R =  3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
        let G = -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z;
        let B =  0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;

        R = R / 100;
        G = G / 100;
        B = B / 100;

        // sRGB gamma
        R = R > 0.0031308 ? 1.055 * Math.pow(Math.max(0, R), 1 / 2.4) - 0.055 : 12.92 * R;
        G = G > 0.0031308 ? 1.055 * Math.pow(Math.max(0, G), 1 / 2.4) - 0.055 : 12.92 * G;
        B = B > 0.0031308 ? 1.055 * Math.pow(Math.max(0, B), 1 / 2.4) - 0.055 : 12.92 * B;

        rgb[off]     = Math.max(0, Math.min(255, Math.round(R * 255)));
        rgb[off + 1] = Math.max(0, Math.min(255, Math.round(G * 255)));
        rgb[off + 2] = Math.max(0, Math.min(255, Math.round(B * 255)));
    }

    return rgb;
}

/**
 * Convert RGB components to hex string.
 *
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {string} Hex color string (e.g. '#ff0000')
 */
function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => {
        const hex = Math.round(x).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('');
}

// ============================================================================
// Single-Color Conversions: sRGB ↔ Perceptual Lab (D65 illuminant)
// ============================================================================
//
// These convert individual palette entries between sRGB and perceptual Lab.
// Pipeline: sRGB → Linear RGB → XYZ (D65) → Lab / Lab → XYZ → sRGB
//
// Note: lab8bitToRgb (above) uses D50+Bradford for bulk buffer rendering.
// These D65 functions are the canonical single-color converters used by
// PosterizationEngine, ColorSpace, and the public API.

/** @private sRGB gamma correction (inverse): sRGB → Linear RGB */
function _gammaToLinear(channel) {
    if (channel <= 0.04045) {
        return channel / 12.92;
    } else {
        return Math.pow((channel + 0.055) / 1.055, 2.4);
    }
}

/** @private sRGB gamma correction (forward): Linear RGB → sRGB */
function _linearToGamma(channel) {
    if (channel <= 0.0031308) {
        return channel * 12.92;
    } else {
        return 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
    }
}

/** @private XYZ to Lab helper function (CIE standard) */
function _xyzToLabHelper(t) {
    const delta = 6 / 29;
    if (t > delta * delta * delta) {
        return Math.pow(t, 1 / 3);
    } else {
        return t / (3 * delta * delta) + 4 / 29;
    }
}

/** @private Lab to XYZ helper function (CIE standard inverse) */
function _labToXyzHelper(t) {
    const delta = 6 / 29;
    if (t > delta) {
        return t * t * t;
    } else {
        return 3 * delta * delta * (t - 4 / 29);
    }
}

/**
 * Convert sRGB color to CIELAB color space.
 *
 * Pipeline: sRGB → Linear RGB → XYZ → CIELAB (D65 illuminant)
 *
 * @param {{r: number, g: number, b: number}} rgb - sRGB color (0-255)
 * @returns {{L: number, a: number, b: number}} Perceptual Lab
 */
function rgbToLab(rgb) {
    const r = _gammaToLinear(rgb.r / 255);
    const g = _gammaToLinear(rgb.g / 255);
    const b = _gammaToLinear(rgb.b / 255);

    let x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
    let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    let z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;

    x = x / 0.95047;
    y = y / 1.00000;
    z = z / 1.08883;

    x = _xyzToLabHelper(x);
    y = _xyzToLabHelper(y);
    z = _xyzToLabHelper(z);

    const L = 116 * y - 16;
    const a = 500 * (x - y);
    const b_value = 200 * (y - z);

    return { L, a, b: b_value };
}

/**
 * Convert CIELAB color to sRGB color space with gamut mapping.
 *
 * Pipeline: CIELAB → XYZ → Linear RGB → sRGB (D65 illuminant)
 * Out-of-gamut Lab colors have chroma iteratively reduced (max 20 iterations)
 * to force into sRGB gamut, preserving hue and preventing clipping artifacts.
 *
 * @param {{L: number, a: number, b: number}} lab - Perceptual Lab
 * @returns {{r: number, g: number, b: number}} sRGB color (0-255)
 */
function labToRgb(lab) {
    const MAX_ITERATIONS = 20;
    let currentLab = { L: lab.L, a: lab.a, b: lab.b };
    let iteration = 0;
    let inGamut = false;

    while (!inGamut && iteration < MAX_ITERATIONS) {
        let y = (currentLab.L + 16) / 116;
        let x = currentLab.a / 500 + y;
        let z = y - currentLab.b / 200;

        x = _labToXyzHelper(x) * 0.95047;
        y = _labToXyzHelper(y) * 1.00000;
        z = _labToXyzHelper(z) * 1.08883;

        let r = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
        let g = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
        let b = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

        r = _linearToGamma(r);
        g = _linearToGamma(g);
        b = _linearToGamma(b);

        if (r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1) {
            inGamut = true;
            return {
                r: Math.round(r * 255),
                g: Math.round(g * 255),
                b: Math.round(b * 255)
            };
        }

        currentLab.a *= 0.95;
        currentLab.b *= 0.95;
        iteration++;
    }

    // Fallback: clamp
    let y = (currentLab.L + 16) / 116;
    let x = currentLab.a / 500 + y;
    let z = y - currentLab.b / 200;

    x = _labToXyzHelper(x) * 0.95047;
    y = _labToXyzHelper(y) * 1.00000;
    z = _labToXyzHelper(z) * 1.08883;

    let r = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
    let g = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
    let b = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

    r = _linearToGamma(r);
    g = _linearToGamma(g);
    b = _linearToGamma(b);

    r = Math.max(0, Math.min(255, Math.round(r * 255)));
    g = Math.max(0, Math.min(255, Math.round(g * 255)));
    b = Math.max(0, Math.min(255, Math.round(b * 255)));

    return { r, g, b };
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
    // Constants
    LAB16_L_MAX,
    LAB16_AB_NEUTRAL,
    L_SCALE,
    AB_SCALE,
    LAB8_AB_NEUTRAL,
    PSD16_SCALE,

    // Bulk buffer conversions
    convert8bitTo16bitLab,
    convertPsd16bitToEngineLab,
    convertPsd16bitTo8bitLab,
    convertEngine16bitTo8bitLab,

    // Aliases matching UXP naming conventions
    lab8to16,
    lab16to8,

    // Single-pixel conversions
    perceptualToEngine16,
    engine16ToPerceptual,

    // Display conversions
    lab8bitToRgb,
    rgbToHex,

    // Single-color sRGB ↔ Lab (D65, gamut-mapped)
    rgbToLab,
    labToRgb
};
