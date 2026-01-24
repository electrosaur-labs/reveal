#!/usr/bin/env node
/**
 * SP100 16-bit Lab PSD Regenerator
 *
 * Regenerates existing 16-bit Lab PSDs with QuickLook support (thumbnail + proper composite).
 *
 * Input/Output: data/SP100/input/{met,rijks}/psd/16bit/*.psd (in-place)
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PSDWriter } = require('@reveal/psd-writer');
const { readPsd } = require('../../reveal-psd-reader');
const chalk = require('chalk');

const DATA_DIR = path.join(__dirname, '../data/SP100/input');
const SOURCES = ['met', 'rijks'];

/**
 * Generate JPEG thumbnail from Lab pixel data
 */
async function generateThumbnail(labPixels, width, height) {
    const THUMB_MAX = 160;
    const Reveal = require('@reveal/core');

    // Convert Lab to RGB for thumbnail
    const pixelCount = width * height;
    const rgbPixels = Buffer.alloc(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const L = labPixels[i * 3];
        const a = labPixels[i * 3 + 1];
        const b = labPixels[i * 3 + 2];

        // Decode from Photoshop 8-bit Lab encoding
        const labL = (L / 255) * 100;
        const labA = a - 128;
        const labB = b - 128;

        const rgb = Reveal.labToRgb(labL, labA, labB);
        rgbPixels[i * 3] = rgb.r;
        rgbPixels[i * 3 + 1] = rgb.g;
        rgbPixels[i * 3 + 2] = rgb.b;
    }

    // Calculate thumbnail dimensions
    const scale = Math.min(THUMB_MAX / width, THUMB_MAX / height);
    const thumbWidth = Math.round(width * scale);
    const thumbHeight = Math.round(height * scale);

    // Generate JPEG thumbnail
    const jpegData = await sharp(rgbPixels, {
        raw: { width, height, channels: 3 }
    })
        .resize(thumbWidth, thumbHeight)
        .jpeg({ quality: 80 })
        .toBuffer();

    return { jpegData, width: thumbWidth, height: thumbHeight };
}

/**
 * Regenerate 16-bit Lab PSD with QuickLook support
 */
async function regenerate16bit(inputPath) {
    const basename = path.basename(inputPath);

    try {
        // 1. Read existing 16-bit PSD
        const buffer = fs.readFileSync(inputPath);
        const psd = readPsd(buffer);

        if (!psd.data) {
            throw new Error('No pixel data found');
        }

        const { width, height, data: labPixels } = psd;

        // 2. Generate thumbnail for QuickLook
        const thumbnail = await generateThumbnail(labPixels, width, height);

        // 3. Write 16-bit Lab PSD with QuickLook support
        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 16,
            compression: 'none'  // Raw compression required for 16-bit QuickLook
        });

        writer.setComposite(labPixels);
        writer.setThumbnail(thumbnail);

        const psdBuffer = writer.write();

        // 4. Write back to same location
        fs.writeFileSync(inputPath, psdBuffer);

        const sizeKB = (psdBuffer.length / 1024).toFixed(1);
        return { success: true, filename: basename, width, height, size: psdBuffer.length, sizeKB };
    } catch (error) {
        return { success: false, filename: basename, error: error.message };
    }
}

/**
 * Process a source directory (met or rijks)
 */
async function processSource(source) {
    const dir16bit = path.join(DATA_DIR, source, 'psd/16bit');

    if (!fs.existsSync(dir16bit)) {
        console.log(chalk.yellow(`  Skipping ${source}: no 16bit directory`));
        return { success: 0, failed: 0 };
    }

    const files = fs.readdirSync(dir16bit)
        .filter(f => f.endsWith('.psd'))
        .sort();

    console.log(chalk.cyan(`  ${source}: ${files.length} files`));

    let success = 0, failed = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const filePath = path.join(dir16bit, file);

        process.stdout.write(`    [${i + 1}/${files.length}] ${file.substring(0, 40).padEnd(40)} `);

        const result = await regenerate16bit(filePath);

        if (result.success) {
            console.log(chalk.green(`✓ ${result.sizeKB}KB`));
            success++;
        } else {
            console.log(chalk.red(`✗ ${result.error}`));
            failed++;
        }
    }

    return { success, failed };
}

async function main() {
    console.log(chalk.bold(`\n📦 SP100 16-bit Lab PSD Regenerator (QuickLook)`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));

    const startTime = Date.now();
    let totalSuccess = 0, totalFailed = 0;

    for (const source of SOURCES) {
        const { success, failed } = await processSource(source);
        totalSuccess += success;
        totalFailed += failed;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(chalk.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(chalk.bold(`SUMMARY`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(chalk.green(`Success: ${totalSuccess}`));
    if (totalFailed > 0) {
        console.log(chalk.red(`Failed:  ${totalFailed}`));
    }
    console.log(`Time:    ${elapsed}s\n`);
}

main().catch(err => {
    console.error(chalk.red(`\n❌ Fatal error: ${err.message}`));
    console.error(err.stack);
    process.exit(1);
});
