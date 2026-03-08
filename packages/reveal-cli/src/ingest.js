/**
 * ingest.js — Multi-format image reader
 *
 * Accepts PNG, TIFF, JPEG, and Lab PSD files.
 * Always returns normalized 16-bit Lab in engine encoding:
 *   L: 0-32768, a/b: 0-32768 (16384 = neutral)
 *
 * @module ingest
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { LabEncoding } = require('@electrosaur-labs/core');

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.psd']);

/**
 * Read an image file and return normalized 16-bit Lab data.
 *
 * @param {string} filePath - Path to input image
 * @returns {Promise<{lab16bit: Int32Array, width: number, height: number, inputFormat: string}>}
 */
async function ingest(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
        throw new Error(`Unsupported format "${ext}". Supported: PNG, TIFF, JPEG, PSD`);
    }

    if (ext === '.psd') {
        return ingestPsd(filePath);
    }

    // Lab TIFFs: sharp cannot handle these (wrong colorspace conversion,
    // channel inflation, silent 16→8 bit downgrade). Reject with clear message.
    if (ext === '.tif' || ext === '.tiff') {
        const meta = await sharp(filePath).metadata();
        if (meta.space === 'labs' || meta.space === 'lab') {
            throw new Error(
                'Lab TIFF not yet supported — sharp cannot read Lab TIFFs correctly. ' +
                'Please convert to PSD (File → Save As → Photoshop) or export as RGB TIFF/PNG.'
            );
        }
    }

    return ingestRgb(filePath, ext);
}

/**
 * Ingest a Lab PSD via reveal-psd-reader.
 */
async function ingestPsd(filePath) {
    const { readPsd } = require('@electrosaur-labs/psd-reader');
    const buffer = fs.readFileSync(filePath);
    const psd = readPsd(buffer);
    const { width, height, depth, data: labData } = psd;
    const pixelCount = width * height;

    let lab16bit;
    if (depth === 8) {
        lab16bit = LabEncoding.convert8bitTo16bitLab(labData, pixelCount);
    } else {
        lab16bit = LabEncoding.convertPsd16bitToEngineLab(labData, pixelCount);
    }

    return { lab16bit, width, height, inputFormat: 'psd' };
}

/**
 * Ingest a standard image (PNG/TIFF/JPEG) via sharp.
 * Sharp converts to Lab float, then we normalize to engine 16-bit encoding.
 */
async function ingestRgb(filePath, ext) {
    // Sharp's Lab colorspace: float L: 0-100, a: -128..127, b: -128..127
    const { data, info } = await sharp(filePath)
        .toColourspace('lab')
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const pixelCount = width * height;

    // Convert sharp's 8-bit Lab to engine 16-bit encoding (Uint16Array)
    // Sharp raw Lab is 3 channels, uint8: L: 0-255 (maps to 0-100), a/b: 0-255 (128=neutral)
    // Engine encoding: L: 0-32768, a/b: 0-32768 (16384=neutral)
    const lab16bit = new Uint16Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const si = i * channels;
        const di = i * 3;

        lab16bit[di]     = Math.round(data[si]     * (32768 / 255));
        lab16bit[di + 1] = Math.round(data[si + 1] * (32768 / 255));
        lab16bit[di + 2] = Math.round(data[si + 2] * (32768 / 255));
    }

    // Determine format for output matching
    let inputFormat;
    if (ext === '.png') inputFormat = 'png';
    else if (ext === '.tif' || ext === '.tiff') inputFormat = 'tiff';
    else inputFormat = 'jpeg';

    return { lab16bit, width, height, inputFormat };
}

module.exports = { ingest, SUPPORTED_EXTENSIONS };
