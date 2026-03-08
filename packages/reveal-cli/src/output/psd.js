/**
 * psd.js — Layered PSD writer
 *
 * Creates a Lab PSD with fill+mask layers, one per palette color,
 * sorted by lightness (lightest on top).
 */

const fs = require('fs');
const sharp = require('sharp');
const { PSDWriter } = require('@electrosaur-labs/psd-writer');
const { LabEncoding } = require('@electrosaur-labs/core');

/**
 * Write a layered Lab PSD.
 *
 * @param {Array<{L,a,b}>} paletteLab
 * @param {Array<{r,g,b}>} paletteRgb
 * @param {Array<Uint8Array>} masks - Per-color binary masks
 * @param {Uint32Array|Int32Array} colorIndices - Per-pixel color index
 * @param {number} width
 * @param {number} height
 * @param {string} outputPath
 */
async function writePsd(paletteLab, paletteRgb, masks, colorIndices, width, height, outputPath) {
    const pixelCount = width * height;

    const writer = new PSDWriter({
        width,
        height,
        colorMode: 'lab',
        bitsPerChannel: 16,
        compression: 'none',
        documentName: require('path').basename(outputPath, '.psd')
    });

    // Build 8-bit Lab composite for thumbnail and composite preview
    const lab8bit = new Uint8Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const color = paletteLab[colorIndices[i]];
        lab8bit[i * 3]     = Math.round((color.L / 100) * 255);
        lab8bit[i * 3 + 1] = Math.round(color.a + 128);
        lab8bit[i * 3 + 2] = Math.round(color.b + 128);
    }

    // Thumbnail
    const thumbScale = Math.min(256 / width, 256 / height);
    const thumbW = Math.round(width * thumbScale);
    const thumbH = Math.round(height * thumbScale);
    const rgb = LabEncoding.lab8bitToRgb(lab8bit, pixelCount);
    const jpegData = await sharp(Buffer.from(rgb), {
        raw: { width, height, channels: 3 }
    }).resize(thumbW, thumbH).jpeg({ quality: 80 }).toBuffer();

    writer.setThumbnail({ jpegData, width: thumbW, height: thumbH });
    writer.setComposite(lab8bit);

    // Sort layers by lightness descending
    const layerOrder = paletteLab.map((color, i) => ({ index: i, L: color.L }));
    layerOrder.sort((a, b) => b.L - a.L);

    // Add fill+mask layers
    for (let li = 0; li < layerOrder.length; li++) {
        const { index } = layerOrder[li];
        const color = paletteLab[index];
        const rgb = paletteRgb[index];
        const hex = '#' + [rgb.r, rgb.g, rgb.b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase();
        const aSign = color.a >= 0 ? '+' : '';
        const bSign = color.b >= 0 ? '+' : '';

        writer.addFillLayer({
            name: `[${li + 1}] ${hex} L${Math.round(color.L)} a${aSign}${Math.round(color.a)} b${bSign}${Math.round(color.b)}`,
            color: color,
            mask: masks[index]
        });
    }

    const psdBuffer = writer.write();
    fs.writeFileSync(outputPath, psdBuffer);
    return psdBuffer.length;
}

module.exports = { writePsd };
