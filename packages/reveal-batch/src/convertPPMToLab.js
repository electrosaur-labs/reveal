/**
 * PPM → 16-bit Lab PSD Converter
 *
 * Converts CQ100_v4 PPM files to 16-bit Lab PSD format (composite images only, no layers).
 * These intermediate PSDs are then used as input for the separation processor.
 *
 * Input:  data/CQ100_v4/input/ppm/*.ppm
 * Output: data/CQ100_v4/input/psd/*.psd
 */

const fs = require('fs');
const path = require('path');
const Reveal = require('@electrosaur-labs/core');
const { PSDWriter } = Reveal;
const { parsePPM } = require('./ppmParser');
const chalk = require('chalk');

/**
 * Convert a single PPM file to 16-bit Lab PSD
 */
async function convertPPMToLabPSD(inputPath, outputDir) {
    const basename = path.basename(inputPath, '.ppm');
    console.log(chalk.cyan(`Converting ${basename}.ppm...`));

    try {
        // 1. Parse PPM file using custom parser
        const ppm = parsePPM(inputPath);
        const { width, height, pixels } = ppm;

        // 2. Convert RGB to Lab using Reveal's native conversion
        const pixelCount = width * height;
        const labPixels = new Uint8ClampedArray(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const r = pixels[i * 3];
            const g = pixels[i * 3 + 1];
            const b = pixels[i * 3 + 2];

            const lab = Reveal.rgbToLab(r, g, b);

            // Store in BYTE ENCODING format
            // Reveal's rgbToLab returns: L: 0-100, a: -128 to +127, b: -128 to +127
            // Convert to byte encoding: L: 0-255, a: 0-255 (128=neutral), b: 0-255 (128=neutral)
            labPixels[i * 3] = (lab.L / 100) * 255;        // L: 0-100 → 0-255
            labPixels[i * 3 + 1] = lab.a + 128;            // a: -128 to +127 → 0-255
            labPixels[i * 3 + 2] = lab.b + 128;            // b: -128 to +127 → 0-255
        }

        // 3. Write 16-bit Lab PSD (composite only, no layers)
        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        // Set the composite image data
        // Sharp.js returns Lab pixels as interleaved Uint8Array: [L,a,b,L,a,b,...]
        // L: 0-100, a: 0-255 (128 is neutral), b: 0-255 (128 is neutral)
        writer.setCompositeImage(labPixels, 'interleaved');

        const psdBuffer = writer.write();
        const outputPath = path.join(outputDir, `${basename}.psd`);
        fs.writeFileSync(outputPath, psdBuffer);

        console.log(chalk.green(`  ✓ ${outputPath} (${(psdBuffer.length / 1024).toFixed(2)} KB)`));
        return { success: true, filename: basename, size: psdBuffer.length };
    } catch (error) {
        console.error(chalk.red(`  ✗ Error: ${error.message}`));
        return { success: false, filename: basename, error: error.message };
    }
}

/**
 * Main batch conversion process
 */
async function main() {
    const inputDir = path.join(__dirname, '../data/CQ100_v4/input/ppm');
    const outputDir = path.join(__dirname, '../data/CQ100_v4/input/psd');

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Get all PPM files
    const files = fs.readdirSync(inputDir)
        .filter(f => f.endsWith('.ppm'))
        .sort();

    console.log(chalk.bold(`\n🔄 PPM → 16-bit Lab PSD Converter`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Input:  ${inputDir}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Files:  ${files.length} images\n`);

    const startTime = Date.now();
    const results = [];

    for (let i = 0; i < files.length; i++) {
        console.log(`[${i + 1}/${files.length}]`);
        const result = await convertPPMToLabPSD(
            path.join(inputDir, files[i]),
            outputDir
        );
        results.push(result);
    }

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    console.log(chalk.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(chalk.bold(`SUMMARY`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Total:   ${files.length}`);
    console.log(chalk.green(`Success: ${successCount}`));
    console.log(chalk.red(`Failed:  ${failedCount}`));
    console.log(`Time:    ${elapsed}s\n`);

    if (failedCount > 0) {
        console.log(chalk.yellow(`Failed files:`));
        results.filter(r => !r.success).forEach(r => {
            console.log(`  - ${r.filename}: ${r.error}`);
        });
        console.log();
    }
}

// Run if called directly
if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(`\n❌ Fatal error: ${err.message}`));
        console.error(err.stack);
        process.exit(1);
    });
}

module.exports = { convertPPMToLabPSD };
