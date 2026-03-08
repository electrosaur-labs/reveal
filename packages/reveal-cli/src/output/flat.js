/**
 * flat.js — Flat posterized image writer
 *
 * Reconstructs the posterized image from color indices + palette,
 * converts Lab→RGB via reveal-core, writes as PNG.
 * Preserves input bit depth: 16-bit input → 16-bit PNG.
 */

const sharp = require('sharp');
const { LabEncoding } = require('@electrosaur-labs/core');

/**
 * Write a flat posterized image.
 *
 * @param {Uint32Array|Int32Array} colorIndices - Per-pixel palette index
 * @param {Array<{L,a,b}>} paletteLab - Palette in perceptual Lab
 * @param {number} width
 * @param {number} height
 * @param {string} outputPath - Output file path
 * @param {Object} [options]
 * @param {boolean} [options.sixteenBit=false] - Write 16-bit PNG
 */
async function writeFlat(colorIndices, paletteLab, width, height, outputPath, options = {}) {
    const pixelCount = width * height;

    // Pre-compute palette RGB (avoid per-pixel Lab→RGB conversion)
    const paletteRgb = paletteLab.map(lab => LabEncoding.labToRgbD50(lab));

    if (options.sixteenBit) {
        // 16-bit PNG: Uint16Array with values 0-65535
        const rgb16 = new Uint16Array(pixelCount * 3);
        for (let i = 0; i < pixelCount; i++) {
            const c = paletteRgb[colorIndices[i]];
            const offset = i * 3;
            rgb16[offset]     = Math.round((c.r / 255) * 65535);
            rgb16[offset + 1] = Math.round((c.g / 255) * 65535);
            rgb16[offset + 2] = Math.round((c.b / 255) * 65535);
        }

        await sharp(Buffer.from(rgb16.buffer), {
            raw: { width, height, channels: 3, depth: 'ushort' }
        }).png().toFile(outputPath);
    } else {
        // 8-bit PNG
        const rgb8 = new Uint8Array(pixelCount * 3);
        for (let i = 0; i < pixelCount; i++) {
            const c = paletteRgb[colorIndices[i]];
            const offset = i * 3;
            rgb8[offset]     = c.r;
            rgb8[offset + 1] = c.g;
            rgb8[offset + 2] = c.b;
        }

        await sharp(Buffer.from(rgb8), {
            raw: { width, height, channels: 3 }
        }).png().toFile(outputPath);
    }
}

module.exports = { writeFlat };
