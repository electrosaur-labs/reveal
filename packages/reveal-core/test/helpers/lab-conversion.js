/**
 * Test helpers for Lab color space conversion
 *
 * These utilities help convert test data between 8-bit and 16-bit Lab encoding.
 */

/**
 * Convert 8-bit Lab array to 16-bit Lab encoding
 *
 * Photoshop Lab encoding:
 * - 8-bit:  L=0-255, a/b=0-255 (neutral=128)
 * - 16-bit: L=0-32768, a/b=0-32768 (neutral=16384)
 *
 * @param {Uint8Array|Uint8ClampedArray|number[]} lab8 - 8-bit Lab pixel data (L,a,b,L,a,b,...)
 * @returns {Uint16Array} - 16-bit Lab pixel data
 */
function lab8to16(lab8) {
    const lab16 = new Uint16Array(lab8.length);
    const lScale = 32768 / 255;
    const abScale = 16384 / 128;

    for (let i = 0; i < lab8.length; i += 3) {
        // L channel: direct scale (0-255 → 0-32768)
        lab16[i] = Math.round(lab8[i] * lScale);

        // a channel: convert to signed, scale, convert to unsigned
        lab16[i + 1] = Math.round((lab8[i + 1] - 128) * abScale + 16384);

        // b channel: same as a channel
        lab16[i + 2] = Math.round((lab8[i + 2] - 128) * abScale + 16384);
    }

    return lab16;
}

/**
 * Convert 16-bit Lab array to 8-bit Lab encoding
 *
 * @param {Uint16Array} lab16 - 16-bit Lab pixel data
 * @returns {Uint8Array} - 8-bit Lab pixel data
 */
function lab16to8(lab16) {
    const lab8 = new Uint8Array(lab16.length);
    const lScale = 255 / 32768;
    const abScale = 128 / 16384;

    for (let i = 0; i < lab16.length; i += 3) {
        // L channel: direct scale (0-32768 → 0-255)
        lab8[i] = Math.round(Math.min(255, lab16[i] * lScale));

        // a channel: convert to signed, scale, convert to unsigned
        lab8[i + 1] = Math.round(Math.max(0, Math.min(255, (lab16[i + 1] - 16384) * abScale + 128)));

        // b channel: same as a channel
        lab8[i + 2] = Math.round(Math.max(0, Math.min(255, (lab16[i + 2] - 16384) * abScale + 128)));
    }

    return lab8;
}

/**
 * Create a 16-bit Lab pixel array from perceptual Lab values
 *
 * @param {Array<{L: number, a: number, b: number}>} pixels - Array of perceptual Lab values
 *        (L: 0-100, a: -128 to +127, b: -128 to +127)
 * @returns {Uint16Array} - 16-bit Lab pixel data
 */
function perceptualLabTo16bit(pixels) {
    const lab16 = new Uint16Array(pixels.length * 3);

    for (let i = 0; i < pixels.length; i++) {
        const { L, a, b } = pixels[i];
        const idx = i * 3;

        // Convert perceptual to 16-bit encoding
        lab16[idx] = Math.round((L / 100) * 32768);
        lab16[idx + 1] = Math.round((a / 128) * 16384 + 16384);
        lab16[idx + 2] = Math.round((b / 128) * 16384 + 16384);
    }

    return lab16;
}

/**
 * Create a 16-bit Lab pixel array filled with a single color
 *
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} color - Lab color in perceptual ranges {L: 0-100, a: -128 to +127, b: -128 to +127}
 * @returns {Uint16Array} - 16-bit Lab pixel data
 */
function create16bitLabImage(width, height, color = { L: 50, a: 0, b: 0 }) {
    const pixelCount = width * height;
    const lab16 = new Uint16Array(pixelCount * 3);

    const l16 = Math.round((color.L / 100) * 32768);
    const a16 = Math.round((color.a / 128) * 16384 + 16384);
    const b16 = Math.round((color.b / 128) * 16384 + 16384);

    for (let i = 0; i < pixelCount; i++) {
        const idx = i * 3;
        lab16[idx] = l16;
        lab16[idx + 1] = a16;
        lab16[idx + 2] = b16;
    }

    return lab16;
}

module.exports = {
    lab8to16,
    lab16to8,
    perceptualLabTo16bit,
    create16bitLabImage
};
