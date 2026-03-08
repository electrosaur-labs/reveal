/**
 * flat.js — Flat posterized image writer
 *
 * Reconstructs the posterized image from color indices + palette,
 * converts Lab→RGB via reveal-core, writes as PNG or TIFF.
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
 * @param {string} inputFormat - 'png', 'tiff', or 'jpeg'
 */
async function writeFlat(colorIndices, paletteLab, width, height, outputPath, inputFormat) {
    const pixelCount = width * height;

    // Build 8-bit Lab buffer, then convert to RGB via reveal-core
    const lab8 = new Uint8Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const color = paletteLab[colorIndices[i]];
        const offset = i * 3;
        lab8[offset]     = Math.round((color.L / 100) * 255);
        lab8[offset + 1] = Math.round(color.a + 128);
        lab8[offset + 2] = Math.round(color.b + 128);
    }

    const rgb = LabEncoding.lab8bitToRgb(lab8, pixelCount);

    let pipeline = sharp(Buffer.from(rgb), {
        raw: { width, height, channels: 3 }
    });

    // Match output format to input (JPEG → PNG for lossless)
    if (inputFormat === 'tiff') {
        pipeline = pipeline.tiff({ compression: 'lzw' });
    } else {
        pipeline = pipeline.png();
    }

    await pipeline.toFile(outputPath);
}

module.exports = { writeFlat };
