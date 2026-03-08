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

    // Lab TIFFs need special handling — sharp's toColourspace('lab') on a Lab
    // input produces wrong encoding (10 channels, non-standard value ranges).
    // Force through sRGB first, then convert to Lab ourselves.
    if (ext === '.tif' || ext === '.tiff') {
        const meta = await sharp(filePath).metadata();
        if (meta.space === 'labs' || meta.space === 'lab') {
            return ingestLabTiff(filePath);
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
 * Ingest a Lab TIFF by forcing sharp to convert to sRGB first.
 * Sharp's toColourspace('lab') on Lab input produces wrong encoding,
 * so we read as sRGB and convert to Lab ourselves.
 */
async function ingestLabTiff(filePath) {
    const { data, info } = await sharp(filePath)
        .removeAlpha()
        .toColourspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    const pixelCount = width * height;

    // Convert sRGB to engine 16-bit Lab
    const lab16bit = new Uint16Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const si = i * 3;
        const di = i * 3;
        const lab = LabEncoding.rgbToLab({ r: data[si], g: data[si + 1], b: data[si + 2] });
        // Perceptual Lab → engine encoding: L: 0-100 → 0-32768, a/b: -128..127 → 0-32768 (16384=neutral)
        lab16bit[di]     = Math.round((lab.L / 100) * 32768);
        lab16bit[di + 1] = Math.round(((lab.a + 128) / 256) * 32768);
        lab16bit[di + 2] = Math.round(((lab.b + 128) / 256) * 32768);
    }

    return { lab16bit, width, height, inputFormat: 'tiff' };
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
