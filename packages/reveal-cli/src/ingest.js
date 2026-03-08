/**
 * ingest.js — Multi-format image reader
 *
 * Accepts PNG, TIFF, JPEG, and Lab PSD files.
 * Always returns normalized 16-bit Lab in engine encoding:
 *   L: 0-32768, a/b: 0-32768 (16384 = neutral)
 *
 * TIFFs: read via utif2 (pure JS) — sharp mangles 16-bit and Lab TIFFs.
 * PNGs/JPEG: read via sharp (works for 8-bit RGB).
 * PSDs: read via @electrosaur-labs/psd-reader (native 16-bit Lab).
 *
 * @module ingest
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const UTIF = require('utif2');
const { LabEncoding } = require('@electrosaur-labs/core');

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.psd']);

/**
 * Read an image file and return normalized 16-bit Lab data.
 *
 * @param {string} filePath - Path to input image
 * @returns {Promise<{lab16bit: Uint16Array, width: number, height: number, inputFormat: string}>}
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

    if (ext === '.tif' || ext === '.tiff') {
        return ingestTiff(filePath);
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
 * TIFF pixel conversion functions — exported for unit testing.
 * Each converts raw TIFF pixel bytes to engine Lab16 encoding.
 */

/** 16-bit CIELab TIFF → engine Lab. L: unsigned 0-65535, a/b: signed Int16. */
function convertCieLab16(rawData, lab16bit, pixelCount, samplesPerPixel) {
    const u16 = new Uint16Array(rawData.buffer, rawData.byteOffset, rawData.byteLength / 2);
    const i16 = new Int16Array(rawData.buffer, rawData.byteOffset, rawData.byteLength / 2);
    for (let i = 0; i < pixelCount; i++) {
        const si = i * samplesPerPixel;
        const di = i * 3;
        lab16bit[di]     = Math.round(u16[si] * (32768 / 65535));  // L: unsigned
        lab16bit[di + 1] = Math.round(i16[si + 1] / 2 + 16384);   // a: signed, 0=neutral → 16384
        lab16bit[di + 2] = Math.round(i16[si + 2] / 2 + 16384);   // b: signed, 0=neutral → 16384
    }
}

/** 8-bit CIELab TIFF → engine Lab. L: unsigned 0-255, a/b: signed byte. */
function convertCieLab8(rawData, lab16bit, pixelCount, samplesPerPixel) {
    for (let i = 0; i < pixelCount; i++) {
        const si = i * samplesPerPixel;
        const di = i * 3;
        lab16bit[di] = Math.round(rawData[si] * (32768 / 255));
        const a_signed = (rawData[si + 1] > 127 ? rawData[si + 1] - 256 : rawData[si + 1]);
        const b_signed = (rawData[si + 2] > 127 ? rawData[si + 2] - 256 : rawData[si + 2]);
        lab16bit[di + 1] = Math.round(a_signed * (32768 / 256) + 16384);
        lab16bit[di + 2] = Math.round(b_signed * (32768 / 256) + 16384);
    }
}

/** 16-bit RGB TIFF → engine Lab. RGB unsigned 0-65535, converted via rgbToLab. */
function convertRgb16(rawData, lab16bit, pixelCount, samplesPerPixel) {
    const u16 = new Uint16Array(rawData.buffer, rawData.byteOffset, rawData.byteLength / 2);
    for (let i = 0; i < pixelCount; i++) {
        const si = i * samplesPerPixel;
        const di = i * 3;
        const r = Math.round(u16[si]     * (255 / 65535));
        const g = Math.round(u16[si + 1] * (255 / 65535));
        const b = Math.round(u16[si + 2] * (255 / 65535));
        const lab = LabEncoding.rgbToLab({ r, g, b });
        lab16bit[di]     = Math.round((lab.L / 100) * 32768);
        lab16bit[di + 1] = Math.round(((lab.a + 128) / 256) * 32768);
        lab16bit[di + 2] = Math.round(((lab.b + 128) / 256) * 32768);
    }
}

/** 8-bit RGB TIFF → engine Lab. RGB unsigned 0-255, converted via rgbToLab. */
function convertRgb8(rawData, lab16bit, pixelCount, samplesPerPixel) {
    for (let i = 0; i < pixelCount; i++) {
        const si = i * samplesPerPixel;
        const di = i * 3;
        const lab = LabEncoding.rgbToLab({ r: rawData[si], g: rawData[si + 1], b: rawData[si + 2] });
        lab16bit[di]     = Math.round((lab.L / 100) * 32768);
        lab16bit[di + 1] = Math.round(((lab.a + 128) / 256) * 32768);
        lab16bit[di + 2] = Math.round(((lab.b + 128) / 256) * 32768);
    }
}

/**
 * Ingest a TIFF via utif2 (pure JS). Handles Lab and RGB, 8-bit and 16-bit.
 * Sharp is unreliable for TIFFs (mangles 16-bit data, inflates channels).
 */
function ingestTiff(filePath) {
    const buf = fs.readFileSync(filePath);
    const ifds = UTIF.decode(buf);
    if (ifds.length === 0) throw new Error('TIFF: no IFDs found');

    const ifd = ifds[0];
    UTIF.decodeImage(buf, ifd);

    const width = ifd.width || ifd.t256?.[0];
    const height = ifd.height || ifd.t257?.[0];
    if (!width || !height) throw new Error('TIFF: missing dimensions');

    const photometric = ifd.t262?.[0]; // 2=RGB, 8=CIELab
    const bitsPerSample = ifd.t258?.[0] || 8;
    const samplesPerPixel = ifd.t277?.[0] || 3;
    const pixelCount = width * height;
    const lab16bit = new Uint16Array(pixelCount * 3);

    if (photometric === 8) {
        if (bitsPerSample === 16) {
            convertCieLab16(ifd.data, lab16bit, pixelCount, samplesPerPixel);
        } else {
            convertCieLab8(ifd.data, lab16bit, pixelCount, samplesPerPixel);
        }
    } else {
        if (bitsPerSample === 16) {
            convertRgb16(ifd.data, lab16bit, pixelCount, samplesPerPixel);
        } else {
            convertRgb8(ifd.data, lab16bit, pixelCount, samplesPerPixel);
        }
    }

    return { lab16bit, width, height, inputFormat: 'tiff' };
}

/**
 * Ingest a standard image (PNG/JPEG) via sharp.
 * Read raw RGB, then convert to Lab ourselves via LabEncoding.rgbToLab().
 * Sharp's .toColourspace('lab') is unreliable — same issues as with TIFFs.
 */
async function ingestRgb(filePath, ext) {
    const { data, info } = await sharp(filePath)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const pixelCount = width * height;
    const lab16bit = new Uint16Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const si = i * channels;
        const di = i * 3;
        const lab = LabEncoding.rgbToLab({ r: data[si], g: data[si + 1], b: data[si + 2] });
        lab16bit[di]     = Math.round((lab.L / 100) * 32768);
        lab16bit[di + 1] = Math.round(((lab.a + 128) / 256) * 32768);
        lab16bit[di + 2] = Math.round(((lab.b + 128) / 256) * 32768);
    }

    let inputFormat;
    if (ext === '.png') inputFormat = 'png';
    else inputFormat = 'jpeg';

    return { lab16bit, width, height, inputFormat };
}

module.exports = {
    ingest, SUPPORTED_EXTENSIONS,
    // Exported for unit testing (pure conversion functions, no I/O)
    convertCieLab16, convertCieLab8, convertRgb16, convertRgb8,
};
