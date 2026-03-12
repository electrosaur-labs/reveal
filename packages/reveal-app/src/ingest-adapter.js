/**
 * ingest-adapter.js — Multi-format image reader for reveal-app.
 *
 * Copied from reveal-cli/src/ingest.js — same logic, same formats.
 * Kept as a separate copy (not shared package) per Architect's guidance:
 * "Do not over-engineer the package graph for two consumers."
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
 * @param {string} filePath - Path to uploaded temp file
 * @param {string} originalName - Original filename (for extension detection)
 * @returns {Promise<{lab16bit: Uint16Array, width: number, height: number, inputFormat: string}>}
 */
async function ingest(filePath, originalName) {
    const ext = path.extname(originalName || filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
        throw new Error(`Unsupported format "${ext}". Supported: PNG, TIFF, JPEG, PSD`);
    }

    if (ext === '.psd') return ingestPsd(filePath);
    if (ext === '.tif' || ext === '.tiff') return ingestTiff(filePath);
    return ingestRgb(filePath, ext);
}

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

function ingestTiff(filePath) {
    const buf = fs.readFileSync(filePath);
    const ifds = UTIF.decode(buf);
    if (ifds.length === 0) throw new Error('TIFF: no IFDs found');

    const ifd = ifds[0];
    UTIF.decodeImage(buf, ifd);

    const width = ifd.width || ifd.t256?.[0];
    const height = ifd.height || ifd.t257?.[0];
    if (!width || !height) throw new Error('TIFF: missing dimensions');

    const photometric = ifd.t262?.[0];
    const bitsPerSample = ifd.t258?.[0] || 8;
    const samplesPerPixel = ifd.t277?.[0] || 3;
    const pixelCount = width * height;
    const lab16bit = new Uint16Array(pixelCount * 3);

    if (photometric === 8) {
        if (bitsPerSample === 16) {
            const u16 = new Uint16Array(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength / 2);
            const i16 = new Int16Array(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength / 2);
            for (let i = 0; i < pixelCount; i++) {
                const si = i * samplesPerPixel, di = i * 3;
                lab16bit[di] = Math.round(u16[si] * (32768 / 65535));
                lab16bit[di + 1] = Math.round(i16[si + 1] / 2 + 16384);
                lab16bit[di + 2] = Math.round(i16[si + 2] / 2 + 16384);
            }
        } else {
            for (let i = 0; i < pixelCount; i++) {
                const si = i * samplesPerPixel, di = i * 3;
                lab16bit[di] = Math.round(ifd.data[si] * (32768 / 255));
                const a = ifd.data[si + 1] > 127 ? ifd.data[si + 1] - 256 : ifd.data[si + 1];
                const b = ifd.data[si + 2] > 127 ? ifd.data[si + 2] - 256 : ifd.data[si + 2];
                lab16bit[di + 1] = Math.round(a * (32768 / 256) + 16384);
                lab16bit[di + 2] = Math.round(b * (32768 / 256) + 16384);
            }
        }
    } else {
        if (bitsPerSample === 16) {
            const u16 = new Uint16Array(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength / 2);
            for (let i = 0; i < pixelCount; i++) {
                const si = i * samplesPerPixel, di = i * 3;
                const r = Math.round(u16[si] * (255 / 65535));
                const g = Math.round(u16[si + 1] * (255 / 65535));
                const b2 = Math.round(u16[si + 2] * (255 / 65535));
                const lab = LabEncoding.rgbToLab({ r, g, b: b2 });
                lab16bit[di] = Math.round((lab.L / 100) * 32768);
                lab16bit[di + 1] = Math.round(((lab.a + 128) / 256) * 32768);
                lab16bit[di + 2] = Math.round(((lab.b + 128) / 256) * 32768);
            }
        } else {
            for (let i = 0; i < pixelCount; i++) {
                const si = i * samplesPerPixel, di = i * 3;
                const lab = LabEncoding.rgbToLab({ r: ifd.data[si], g: ifd.data[si + 1], b: ifd.data[si + 2] });
                lab16bit[di] = Math.round((lab.L / 100) * 32768);
                lab16bit[di + 1] = Math.round(((lab.a + 128) / 256) * 32768);
                lab16bit[di + 2] = Math.round(((lab.b + 128) / 256) * 32768);
            }
        }
    }

    return { lab16bit, width, height, inputFormat: 'tiff' };
}

async function ingestRgb(filePath, ext) {
    const { data, info } = await sharp(filePath)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const pixelCount = width * height;
    const lab16bit = new Uint16Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const si = i * channels, di = i * 3;
        const lab = LabEncoding.rgbToLab({ r: data[si], g: data[si + 1], b: data[si + 2] });
        lab16bit[di] = Math.round((lab.L / 100) * 32768);
        lab16bit[di + 1] = Math.round(((lab.a + 128) / 256) * 32768);
        lab16bit[di + 2] = Math.round(((lab.b + 128) / 256) * 32768);
    }

    return { lab16bit, width, height, inputFormat: ext === '.png' ? 'png' : 'jpeg' };
}

module.exports = { ingest, SUPPORTED_EXTENSIONS };
