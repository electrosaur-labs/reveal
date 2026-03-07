/**
 * rgb-to-lab.js — Shared RGB-to-Lab conversion for batch converters
 *
 * Two paths:
 * - LUT-based 16-bit converter (high performance, for 16-bit PNG sources)
 * - Per-pixel 8-bit converter (simple, for 8-bit JPEG sources)
 *
 * Both output 8-bit Lab byte encoding: L: 0-255, a: 0-255 (128=neutral), b: 0-255 (128=neutral)
 */

const Reveal = require('@electrosaur-labs/core');

// --- LUT-based 16-bit converter (lazy init) ---

let DE_GAMMA = null;
let LAB_F = null;
const LUT_SIZE = 65536;

function initLUTs() {
    if (DE_GAMMA) return;

    DE_GAMMA = new Float64Array(LUT_SIZE);
    LAB_F = new Float64Array(LUT_SIZE + 1);

    for (let i = 0; i < LUT_SIZE; i++) {
        const val = i / 65535;
        DE_GAMMA[i] = (val <= 0.04045) ? (val / 12.92) : Math.pow((val + 0.055) / 1.055, 2.4);
    }

    for (let i = 0; i <= LUT_SIZE; i++) {
        const t = i / LUT_SIZE * 1.1;
        LAB_F[i] = (t > 0.008856) ? Math.pow(t, 1/3) : (7.787 * t) + (16 / 116);
    }
}

function lutConvert(r16, g16, b16) {
    const r = DE_GAMMA[r16];
    const g = DE_GAMMA[g16];
    const b = DE_GAMMA[b16];

    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    const y = (r * 0.2126 + g * 0.7152 + b * 0.0722);
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;

    const getLabF = (t) => LAB_F[Math.round(t * LUT_SIZE / 1.1)];
    const fx = getLabF(x);
    const fy = getLabF(y);
    const fz = getLabF(z);

    return {
        L: Math.max(0, Math.min(65535, Math.round(((116 * fy) - 16) * 655.35))),
        a: Math.max(0, Math.min(65535, Math.round((500 * (fx - fy) + 128) * 256))),
        b: Math.max(0, Math.min(65535, Math.round((200 * (fy - fz) + 128) * 256)))
    };
}

/**
 * Convert 16-bit RGB buffer (big-endian from Sharp) to 8-bit Lab encoding.
 * Uses pre-calculated LUTs for high performance.
 *
 * @param {Buffer} rgbBuffer16 - 16-bit RGB buffer (6 bytes per pixel, big-endian)
 * @param {number} pixelCount - Number of pixels
 * @returns {Uint8Array} 8-bit Lab pixel data (3 bytes per pixel)
 */
function convertRgb16ToLab8(rgbBuffer16, pixelCount) {
    initLUTs();
    const labPixels = new Uint8Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const r16 = (rgbBuffer16[i * 6] << 8) | rgbBuffer16[i * 6 + 1];
        const g16 = (rgbBuffer16[i * 6 + 2] << 8) | rgbBuffer16[i * 6 + 3];
        const b16 = (rgbBuffer16[i * 6 + 4] << 8) | rgbBuffer16[i * 6 + 5];

        const lab = lutConvert(r16, g16, b16);
        labPixels[i * 3] = lab.L >> 8;
        labPixels[i * 3 + 1] = lab.a >> 8;
        labPixels[i * 3 + 2] = lab.b >> 8;
    }

    return labPixels;
}

/**
 * Convert 8-bit RGB buffer to 8-bit Lab encoding.
 * Uses Reveal's built-in rgbToLab for correctness.
 *
 * @param {Buffer|Uint8Array} rgbBuffer8 - 8-bit RGB buffer (3 bytes per pixel)
 * @param {number} pixelCount - Number of pixels
 * @returns {Uint8Array} 8-bit Lab pixel data (3 bytes per pixel)
 */
function convertRgb8ToLab8(rgbBuffer8, pixelCount) {
    const labPixels = new Uint8Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const r = rgbBuffer8[i * 3];
        const g = rgbBuffer8[i * 3 + 1];
        const b = rgbBuffer8[i * 3 + 2];

        const lab = Reveal.rgbToLab({ r, g, b });
        labPixels[i * 3] = Math.round((lab.L / 100) * 255);
        labPixels[i * 3 + 1] = Math.round(lab.a + 128);
        labPixels[i * 3 + 2] = Math.round(lab.b + 128);
    }

    return labPixels;
}

module.exports = { convertRgb16ToLab8, convertRgb8ToLab8 };
