#!/usr/bin/env node
/**
 * convert-jpg-to-lab-psd.js
 *
 * Converts JPG files to 8-bit and 16-bit Lab PSDs
 * Uses sharp for JPG reading and PSDWriter for PSD creation
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PSDWriter } = require('@reveal/psd-writer');
const LabEncoding = require('@reveal/core').LabEncoding;

const INPUT_DIR = path.join(__dirname, '../data/SP100/input/minkler/jpg');
const OUTPUT_8BIT = path.join(__dirname, '../data/SP100/output/minkler/psd/8bit');
const OUTPUT_16BIT = path.join(__dirname, '../data/SP100/output/minkler/psd/16bit');

/**
 * Convert RGB buffer to 8-bit Lab encoding for PSDWriter
 * @param {Buffer} rgbBuffer - Raw RGB pixels (3 bytes per pixel)
 * @param {number} pixelCount - Number of pixels
 * @returns {Uint8Array} Lab pixels in 8-bit encoding (3 bytes per pixel)
 */
function rgbToLab8bit(rgbBuffer, pixelCount) {
    const labPixels = new Uint8Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const r = rgbBuffer[i * 3];
        const g = rgbBuffer[i * 3 + 1];
        const b = rgbBuffer[i * 3 + 2];

        // Convert RGB to Lab
        const lab = LabEncoding.rgbToLab({ r, g, b });

        // Encode to 8-bit PSD format:
        // L: 0-100 → 0-255
        // a: -128 to +127 → 0-255 (128 = neutral)
        // b: -128 to +127 → 0-255 (128 = neutral)
        labPixels[i * 3] = Math.round((lab.L / 100) * 255);
        labPixels[i * 3 + 1] = Math.round(lab.a + 128);
        labPixels[i * 3 + 2] = Math.round(lab.b + 128);
    }

    return labPixels;
}

/**
 * Convert RGB buffer to native 16-bit Lab encoding for PSDWriter
 * @param {Buffer} rgbBuffer - Raw RGB pixels (3 bytes per pixel)
 * @param {number} pixelCount - Number of pixels
 * @returns {Buffer} Lab pixels in native 16-bit encoding (6 bytes per pixel, big-endian)
 */
function rgbToLab16bit(rgbBuffer, pixelCount) {
    const labPixels = Buffer.alloc(pixelCount * 6);

    for (let i = 0; i < pixelCount; i++) {
        const r = rgbBuffer[i * 3];
        const g = rgbBuffer[i * 3 + 1];
        const b = rgbBuffer[i * 3 + 2];

        // Convert RGB to Lab
        const lab = LabEncoding.rgbToLab({ r, g, b });

        // Encode to 16-bit PSD format (big-endian):
        // L: 0-100 → 0-65535
        // a: -128 to +127 → 0-65535 (32768 = neutral)
        // b: -128 to +127 → 0-65535 (32768 = neutral)
        const L16 = Math.round((lab.L / 100) * 65535);
        const a16 = Math.round(((lab.a + 128) / 255) * 65535);
        const b16 = Math.round(((lab.b + 128) / 255) * 65535);

        labPixels.writeUInt16BE(L16, i * 6);
        labPixels.writeUInt16BE(a16, i * 6 + 2);
        labPixels.writeUInt16BE(b16, i * 6 + 4);
    }

    return labPixels;
}

/**
 * Convert a single JPG file to 8-bit and 16-bit Lab PSDs
 * @param {string} jpgPath - Path to input JPG
 * @param {string} basename - Base filename without extension
 */
async function convertJpg(jpgPath, basename) {
    console.log(`Converting: ${basename}`);

    // Read JPG and get raw RGB pixels
    const image = sharp(jpgPath);
    const metadata = await image.metadata();
    const { width, height } = metadata;

    // Extract raw RGB pixels (no alpha)
    const rgbBuffer = await image.removeAlpha().raw().toBuffer();
    const pixelCount = width * height;

    console.log(`  Dimensions: ${width}x${height} (${pixelCount} pixels)`);

    // Convert to 8-bit Lab and write PSD
    const lab8bit = rgbToLab8bit(rgbBuffer, pixelCount);
    const psd8bit = new PSDWriter({
        width,
        height,
        colorMode: 'lab',
        bitsPerChannel: 8
    });
    psd8bit.addPixelLayer({
        name: basename,
        pixels: lab8bit
    });
    const psd8bitBuffer = psd8bit.write();
    const output8bit = path.join(OUTPUT_8BIT, `${basename}.psd`);
    fs.writeFileSync(output8bit, psd8bitBuffer);
    console.log(`  Wrote 8-bit: ${output8bit} (${(psd8bitBuffer.length / 1024).toFixed(1)} KB)`);

    // Convert to 16-bit Lab and write PSD
    const lab16bit = rgbToLab16bit(rgbBuffer, pixelCount);
    const psd16bit = new PSDWriter({
        width,
        height,
        colorMode: 'lab',
        bitsPerChannel: 16
    });
    psd16bit.addPixelLayer({
        name: basename,
        pixels: lab16bit
    });
    const psd16bitBuffer = psd16bit.write();
    const output16bit = path.join(OUTPUT_16BIT, `${basename}.psd`);
    fs.writeFileSync(output16bit, psd16bitBuffer);
    console.log(`  Wrote 16-bit: ${output16bit} (${(psd16bitBuffer.length / 1024).toFixed(1)} KB)`);
}

async function main() {
    console.log('JPG to Lab PSD Converter\n');
    console.log(`Input: ${INPUT_DIR}`);
    console.log(`Output 8-bit: ${OUTPUT_8BIT}`);
    console.log(`Output 16-bit: ${OUTPUT_16BIT}\n`);

    // Find all JPG files
    const files = fs.readdirSync(INPUT_DIR).filter(f =>
        f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg')
    );

    console.log(`Found ${files.length} JPG files\n`);

    let success = 0;
    let failed = 0;

    for (const file of files) {
        const jpgPath = path.join(INPUT_DIR, file);
        const basename = path.basename(file, path.extname(file));

        try {
            await convertJpg(jpgPath, basename);
            success++;
        } catch (error) {
            console.error(`  ERROR: ${error.message}`);
            failed++;
        }
    }

    console.log(`\nComplete: ${success} converted, ${failed} failed`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
