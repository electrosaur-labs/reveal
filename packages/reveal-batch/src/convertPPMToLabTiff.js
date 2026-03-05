/**
 * PPM → 16-bit Lab PSD Converter
 *
 * Converts CQ100_v4 PPM files to 16-bit Lab PSD format.
 * Single composite layer, no separation.
 *
 * Input:  data/CQ100_v4/input/ppm/*.ppm
 * Output: data/CQ100_v4/input/psd/*.psd
 */

const fs = require('fs');
const path = require('path');
const Reveal = require('@electrosaur-labs/core');
const { PSDWriter } = require('@electrosaur-labs/psd-writer');
const { parsePPM } = require('./ppmParser');
const chalk = require('chalk');

/**
 * Convert a single PPM to 16-bit Lab PSD
 */
async function convertPPMToLabPSD(inputPath, outputDir) {
    const basename = path.basename(inputPath, '.ppm');
    console.log(chalk.cyan(`[${basename}] Converting...`));

    try {
        // 1. Parse PPM file
        const ppm = parsePPM(inputPath);
        const { width, height, pixels } = ppm;

        // 2. Convert RGB to Lab
        const pixelCount = width * height;
        const labPixels = new Uint8ClampedArray(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const r = pixels[i * 3];
            const g = pixels[i * 3 + 1];
            const b = pixels[i * 3 + 2];

            const lab = Reveal.rgbToLab({ r, g, b });

            // Convert to byte encoding (0-255 range)
            labPixels[i * 3] = (lab.L / 100) * 255;        // L: 0-100 → 0-255
            labPixels[i * 3 + 1] = lab.a + 128;             // a: -128 to +127 → 0-255
            labPixels[i * 3 + 2] = lab.b + 128;             // b: -128 to +127 → 0-255
        }

        // 3. Write 16-bit Lab PSD
        const outputPath = path.join(outputDir, `${basename}.psd`);

        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        // Add single pixel layer with Lab data
        writer.addPixelLayer({
            name: 'Background',
            pixels: labPixels,
            visible: true
        });

        const psdBuffer = writer.write();
        fs.writeFileSync(outputPath, psdBuffer);

        const sizeKB = (psdBuffer.length / 1024).toFixed(2);

        console.log(chalk.green(`  ✓ ${basename}.psd (${width}×${height}, ${sizeKB} KB)`));
        return { success: true, filename: basename, width, height, size: psdBuffer.length };
    } catch (error) {
        console.error(chalk.red(`  ✗ Error: ${error.message}`));
        return { success: false, filename: basename, error: error.message };
    }
}

/**
 * Main conversion function
 */
async function main() {
    const inputDir = path.join(__dirname, '../data/CQ100_v4/input/ppm');
    const outputDir = path.join(__dirname, '../data/CQ100_v4/input/tiff');

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Get all PPM files
    const files = fs.readdirSync(inputDir)
        .filter(f => f.endsWith('.ppm'))
        .sort();

    console.log(chalk.bold(`\n🔄 PPM → 16-bit Lab TIFF Converter`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Input:  ${inputDir}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Files:  ${files.length} images\n`);

    const startTime = Date.now();
    const results = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(inputDir, file);

        console.log(`\n[${i + 1}/${files.length}]`);
        const result = await convertPPMToLabTiff(inputPath, outputDir);

        if (result.success) {
            results.push(result);
        } else {
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
    console.log(chalk.red(`Failed:  ${errors.length}`));
    console.log(`Time:    ${elapsed}s\n`);

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
