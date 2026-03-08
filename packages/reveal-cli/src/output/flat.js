/**
 * flat.js — Flat posterized image writer
 *
 * Reconstructs the posterized image from color indices + palette,
 * converts Lab→RGB via reveal-core, writes as PNG.
 * Preserves input bit depth: 16-bit input → 16-bit PNG.
 *
 * 16-bit PNGs are written with a pure-JS PNG encoder to avoid
 * sharp's color management (which applies incorrect colorspace
 * transforms to 16-bit raw input, causing a blue cast).
 */

const fs = require('fs');
const zlib = require('zlib');
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
        // 16-bit PNG via pure-JS encoder (sharp mangles 16-bit raw colorspace)
        const rgb16 = new Uint16Array(pixelCount * 3);
        for (let i = 0; i < pixelCount; i++) {
            const c = paletteRgb[colorIndices[i]];
            const offset = i * 3;
            rgb16[offset]     = Math.round((c.r / 255) * 65535);
            rgb16[offset + 1] = Math.round((c.g / 255) * 65535);
            rgb16[offset + 2] = Math.round((c.b / 255) * 65535);
        }

        const pngBuf = writePng16(rgb16, width, height);
        fs.writeFileSync(outputPath, pngBuf);
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

/**
 * Write a 16-bit RGB PNG using pure JS (zlib + manual chunk construction).
 * PNG 16-bit stores values in big-endian byte order.
 */
function writePng16(rgb16, width, height) {
    // Build IDAT payload: for each row, filter byte + 6 bytes/pixel (3 channels × 2 bytes)
    const rowBytes = 1 + width * 6; // filter byte + RGB16 data
    const raw = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y++) {
        const rowOff = y * rowBytes;
        raw[rowOff] = 0; // filter: None
        for (let x = 0; x < width; x++) {
            const si = (y * width + x) * 3;
            const di = rowOff + 1 + x * 6;
            // PNG uses big-endian for 16-bit values
            raw[di]     = (rgb16[si]     >> 8) & 0xFF;
            raw[di + 1] = rgb16[si]     & 0xFF;
            raw[di + 2] = (rgb16[si + 1] >> 8) & 0xFF;
            raw[di + 3] = rgb16[si + 1] & 0xFF;
            raw[di + 4] = (rgb16[si + 2] >> 8) & 0xFF;
            raw[di + 5] = rgb16[si + 2] & 0xFF;
        }
    }

    const deflated = zlib.deflateSync(raw);

    function crc32(buf) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            c ^= buf[i];
            for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function chunk(type, data) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(td), 0);
        return Buffer.concat([len, td, crc]);
    }

    // IHDR: width, height, bitDepth=16, colorType=2 (RGB)
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 16; // bit depth
    ihdr[9] = 2;  // color type: RGB
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    return Buffer.concat([
        sig,
        chunk('IHDR', ihdr),
        chunk('IDAT', deflated),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

module.exports = { writeFlat };
