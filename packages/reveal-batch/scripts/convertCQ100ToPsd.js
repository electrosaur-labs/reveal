#!/usr/bin/env node
/**
 * CQ100 PPM → Lab PSD Converter
 *
 * Converts CQ100 PPM files to both 8-bit and 16-bit Lab PSD format.
 *
 * Input:  data/CQ100_v4/input/ppm/*.ppm
 * Output: data/CQ100_v4/output/psd/8bit/*.psd
 *         data/CQ100_v4/output/psd/16bit/*.psd
 *
 * Usage:
 *   node scripts/convertCQ100ToPsd.js              # Convert all PPMs
 *   node scripts/convertCQ100ToPsd.js astronaut    # Convert single file
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Reveal = require('@reveal/core');
const { PSDWriter } = require('@reveal/psd-writer');
const { parsePPM } = require('../src/ppmParser');
const chalk = require('chalk');

// Directories
const DATA_DIR = path.join(__dirname, '../data/CQ100_v4');
const INPUT_DIR = path.join(DATA_DIR, 'input/ppm');
const OUTPUT_DIR_8BIT = path.join(DATA_DIR, 'input/psd/8bit');
const OUTPUT_DIR_16BIT = path.join(DATA_DIR, 'input/psd/16bit');

/**
 * Convert RGB to Lab with 8-bit encoding
 * L: 0-100 → 0-255
 * a: -128 to +127 → 0-255 (128 = neutral)
 * b: -128 to +127 → 0-255 (128 = neutral)
 */
function rgbToLab8(r, g, b) {
    const lab = Reveal.rgbToLab({ r, g, b });
    return {
        L: Math.round(Math.max(0, Math.min(255, (lab.L / 100) * 255))),
        a: Math.round(Math.max(0, Math.min(255, lab.a + 128))),
        b: Math.round(Math.max(0, Math.min(255, lab.b + 128)))
    };
}

/**
 * Generate JPEG thumbnail from RGB pixel data
 * @param {Buffer} rgbPixels - RGB pixel data (3 bytes per pixel)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Promise<{jpegData: Buffer, width: number, height: number}>}
 */
async function generateThumbnail(rgbPixels, width, height) {
    const THUMB_MAX = 160;  // Max dimension for thumbnail (matches Photoshop default)

    // Calculate thumbnail dimensions (preserve aspect ratio)
    const scale = Math.min(THUMB_MAX / width, THUMB_MAX / height);
    const thumbWidth = Math.round(width * scale);
    const thumbHeight = Math.round(height * scale);

    // Generate JPEG thumbnail using sharp
    const jpegData = await sharp(rgbPixels, {
        raw: { width, height, channels: 3 }
    })
        .resize(thumbWidth, thumbHeight)
        .jpeg({ quality: 80 })
        .toBuffer();

    return { jpegData, width: thumbWidth, height: thumbHeight };
}

/**
 * Convert a single PPM to both 8-bit and 16-bit Lab PSDs
 */
async function convertPPM(inputPath, outputDir8, outputDir16) {
    const basename = path.basename(inputPath, '.ppm');

    try {
        // 1. Parse PPM file
        const ppm = parsePPM(inputPath);
        const { width, height, pixels: rgbPixels } = ppm;
        const pixelCount = width * height;

        // 2. Convert RGB to Lab (8-bit encoding)
        const labPixels = new Uint8ClampedArray(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const r = rgbPixels[i * 3];
            const g = rgbPixels[i * 3 + 1];
            const b = rgbPixels[i * 3 + 2];

            const lab = rgbToLab8(r, g, b);

            labPixels[i * 3] = lab.L;
            labPixels[i * 3 + 1] = lab.a;
            labPixels[i * 3 + 2] = lab.b;
        }

        // 3. Generate thumbnail for QuickLook
        const thumbnail = await generateThumbnail(rgbPixels, width, height);

        // 4. Write 8-bit Lab PSD (flat mode for QuickLook compatibility)
        const outputPath8 = path.join(outputDir8, `${basename}.psd`);
        const writer8 = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 8
        });
        writer8.setComposite(labPixels);  // Flat mode: 3 channels, no layers
        writer8.setThumbnail({
            jpegData: thumbnail.jpegData,
            width: thumbnail.width,
            height: thumbnail.height
        });
        const psdBuffer8 = writer8.write();
        fs.writeFileSync(outputPath8, psdBuffer8);
        const size8KB = (psdBuffer8.length / 1024).toFixed(1);

        // 5. Write 16-bit Lab PSD (flat mode for QuickLook compatibility)
        // Note: 16-bit requires raw compression (not RLE) for QuickLook
        const outputPath16 = path.join(outputDir16, `${basename}.psd`);
        const writer16 = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 16,
            compression: 'none'  // Raw compression for 16-bit QuickLook compatibility
        });
        writer16.setComposite(labPixels);  // Flat mode: 3 channels, no layers
        writer16.setThumbnail({
            jpegData: thumbnail.jpegData,
            width: thumbnail.width,
            height: thumbnail.height
        });
        const psdBuffer16 = writer16.write();
        fs.writeFileSync(outputPath16, psdBuffer16);
        const size16KB = (psdBuffer16.length / 1024).toFixed(1);

        return {
            success: true,
            filename: basename,
            width,
            height,
            size8: psdBuffer8.length,
            size16: psdBuffer16.length,
            message: `${width}×${height} → 8bit: ${size8KB}KB, 16bit: ${size16KB}KB`
        };
    } catch (error) {
        return {
            success: false,
            filename: basename,
            error: error.message
        };
    }
}

/**
 * Main conversion function
 */
async function main() {
    console.log(chalk.bold(`\n📦 CQ100 PPM → Lab PSD Converter`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));

    // Ensure input directory exists
    if (!fs.existsSync(INPUT_DIR)) {
        console.error(chalk.red(`Input directory not found: ${INPUT_DIR}`));
        process.exit(1);
    }

    // Create output directories
    if (!fs.existsSync(OUTPUT_DIR_8BIT)) {
        fs.mkdirSync(OUTPUT_DIR_8BIT, { recursive: true });
    }
    if (!fs.existsSync(OUTPUT_DIR_16BIT)) {
        fs.mkdirSync(OUTPUT_DIR_16BIT, { recursive: true });
    }

    // Get list of PPM files
    let files = fs.readdirSync(INPUT_DIR)
        .filter(f => f.endsWith('.ppm'))
        .sort();

    // Check for single file argument
    const singleFile = process.argv[2];
    if (singleFile) {
        const match = files.find(f => f.includes(singleFile));
        if (!match) {
            console.error(chalk.red(`No PPM file matching "${singleFile}" found`));
            console.log(`Available files: ${files.slice(0, 5).join(', ')}...`);
            process.exit(1);
        }
        files = [match];
        console.log(chalk.yellow(`Single file mode: ${match}\n`));
    }

    console.log(`Input:   ${INPUT_DIR}`);
    console.log(`Output:  ${OUTPUT_DIR_8BIT}`);
    console.log(`         ${OUTPUT_DIR_16BIT}`);
    console.log(`Files:   ${files.length} image(s)\n`);

    const startTime = Date.now();
    const results = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(INPUT_DIR, file);

        process.stdout.write(`[${i + 1}/${files.length}] ${file.padEnd(30)} `);

        const result = await convertPPM(inputPath, OUTPUT_DIR_8BIT, OUTPUT_DIR_16BIT);

        if (result.success) {
            console.log(chalk.green(`✓ ${result.message}`));
            results.push(result);
        } else {
            console.log(chalk.red(`✗ ${result.error}`));
            errors.push(result);
        }
    }

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(chalk.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(chalk.bold(`SUMMARY`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Total:   ${files.length}`);
    console.log(chalk.green(`Success: ${results.length}`));
    if (errors.length > 0) {
        console.log(chalk.red(`Failed:  ${errors.length}`));
    }
    console.log(`Time:    ${elapsed}s\n`);

    if (results.length > 0) {
        const total8 = results.reduce((sum, r) => sum + r.size8, 0);
        const total16 = results.reduce((sum, r) => sum + r.size16, 0);
        console.log(`8-bit total:  ${(total8 / 1024 / 1024).toFixed(1)} MB`);
        console.log(`16-bit total: ${(total16 / 1024 / 1024).toFixed(1)} MB\n`);
    }

    if (errors.length > 0) {
        console.log(chalk.red(`Failed files:`));
        errors.forEach(e => console.log(`  - ${e.filename}: ${e.error}`));
    }
}

main().catch(err => {
    console.error(chalk.red(`\n❌ Fatal error: ${err.message}`));
    console.error(err.stack);
    process.exit(1);
});
