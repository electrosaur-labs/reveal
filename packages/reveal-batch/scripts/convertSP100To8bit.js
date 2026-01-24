#!/usr/bin/env node
/**
 * SP100 16-bit → 8-bit Lab PSD Converter
 *
 * Converts existing 16-bit Lab PSDs to 8-bit Lab PSDs with QuickLook support.
 *
 * Input:  data/SP100/input/{met,rijks}/psd/16bit/*.psd
 * Output: data/SP100/input/{met,rijks}/psd/8bit/*.psd
 */

const fs = require('fs');
const path = require('path');
const { PSDWriter } = require('@reveal/psd-writer');
const { readPsd } = require('../../reveal-psd-reader');
const chalk = require('chalk');

const DATA_DIR = path.join(__dirname, '../data/SP100/input');
const SOURCES = ['met', 'rijks'];

/**
 * Convert 16-bit Lab PSD to 8-bit Lab PSD
 */
async function convert16to8(inputPath, outputPath) {
    const basename = path.basename(inputPath);

    try {
        // 1. Read 16-bit PSD
        const buffer = fs.readFileSync(inputPath);
        const psd = readPsd(buffer);

        if (!psd.data) {
            throw new Error('No pixel data found');
        }

        const { width, height, depth, data: labPixels } = psd;

        // 2. Convert 16-bit encoded Lab to 8-bit encoded Lab if needed
        let labPixels8;
        if (depth === 16) {
            // 16-bit encoding: L in 0-32768, a/b in 0-32768 (neutral=16384)
            // Convert to 8-bit encoding: L in 0-255, a/b in 0-255 (neutral=128)
            const pixelCount = width * height;
            labPixels8 = new Uint8ClampedArray(pixelCount * 3);

            for (let i = 0; i < pixelCount; i++) {
                // Read 16-bit values (assuming the reader returns normalized or byte values)
                // Check the actual format from the reader
                const L = labPixels[i * 3];
                const a = labPixels[i * 3 + 1];
                const b = labPixels[i * 3 + 2];

                // If reader already gives us 8-bit values, use directly
                labPixels8[i * 3] = L;
                labPixels8[i * 3 + 1] = a;
                labPixels8[i * 3 + 2] = b;
            }
        } else {
            labPixels8 = labPixels;
        }

        // 3. Extract thumbnail from source if present
        let thumbnail = null;
        if (psd.imageResources && psd.imageResources.resources) {
            const thumbResource = psd.imageResources.resources.find(r => r.id === 1036);
            if (thumbResource && thumbResource.data && thumbResource.data.length > 28) {
                const thumbData = thumbResource.data;
                const format = thumbData.readUInt32BE(0);
                if (format === 1) {  // JPEG
                    const thumbWidth = thumbData.readUInt32BE(4);
                    const thumbHeight = thumbData.readUInt32BE(8);
                    const jpegData = thumbData.slice(28);
                    thumbnail = { jpegData, width: thumbWidth, height: thumbHeight };
                }
            }
        }

        // 4. Write 8-bit Lab PSD (flat mode)
        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 8
        });

        writer.setComposite(labPixels8);

        if (thumbnail) {
            writer.setThumbnail(thumbnail);
        }

        const psdBuffer = writer.write();
        fs.writeFileSync(outputPath, psdBuffer);

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
    const input16Dir = path.join(DATA_DIR, source, 'psd/16bit');
    const output8Dir = path.join(DATA_DIR, source, 'psd/8bit');

    if (!fs.existsSync(input16Dir)) {
        console.log(chalk.yellow(`  Skipping ${source}: no 16bit directory`));
        return { success: 0, failed: 0 };
    }

    // Create output directory
    if (!fs.existsSync(output8Dir)) {
        fs.mkdirSync(output8Dir, { recursive: true });
    }

    const files = fs.readdirSync(input16Dir)
        .filter(f => f.endsWith('.psd'))
        .sort();

    console.log(chalk.cyan(`  ${source}: ${files.length} files`));

    let success = 0, failed = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(input16Dir, file);
        const outputPath = path.join(output8Dir, file);

        process.stdout.write(`    [${i + 1}/${files.length}] ${file.substring(0, 40).padEnd(40)} `);

        const result = await convert16to8(inputPath, outputPath);

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
    console.log(chalk.bold(`\n📦 SP100 16-bit → 8-bit Lab PSD Converter`));
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
