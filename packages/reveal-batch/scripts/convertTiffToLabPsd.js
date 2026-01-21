/**
 * TIFF → 16-bit Lab PSD Converter
 *
 * Converts LOC TIFF files to 16-bit Lab PSD format using:
 * - sharp for TIFF reading
 * - reveal-core for RGB→Lab conversion
 * - reveal-psd-writer for 16-bit Lab PSD output
 *
 * Input:  data/SP100/input/loc/jpg/*.tif
 * Output: data/SP100/output/loc/psd/*.psd
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Reveal = require('@reveal/core');
const { PSDWriter } = require('@reveal/psd-writer');
const chalk = require('chalk');

const INPUT_DIR = path.join(__dirname, '../data/SP100/input/loc/tiff');
const OUTPUT_DIR = path.join(__dirname, '../data/SP100/input/loc/psd');

/**
 * Convert RGB to 8-bit Lab byte encoding
 *
 * PSDWriter expects 8-bit Lab encoding:
 * - L: 0-100 → 0-255 (multiply by 2.55)
 * - a: -128 to +127 → 0-255 (add 128)
 * - b: -128 to +127 → 0-255 (add 128)
 *
 * PSDWriter then internally converts to 16-bit by multiplying by 257
 */
function rgbToLab8(r, g, b) {
    // Note: Reveal.rgbToLab expects an object {r, g, b}
    const lab = Reveal.rgbToLab({ r, g, b });

    // Convert to 8-bit byte encoding
    // L: 0-100 → 0-255
    const L8 = Math.round((lab.L / 100) * 255);
    // a: -128 to +127 → 0-255 (add 128)
    const a8 = Math.round(lab.a + 128);
    // b: -128 to +127 → 0-255 (add 128)
    const b8 = Math.round(lab.b + 128);

    return {
        L: Math.max(0, Math.min(255, L8)),
        a: Math.max(0, Math.min(255, a8)),
        b: Math.max(0, Math.min(255, b8))
    };
}

/**
 * Convert a single TIFF to 16-bit Lab PSD
 */
async function convertTiffToLabPSD(inputPath, outputDir) {
    const basename = path.basename(inputPath, '.tif');

    try {
        // 1. Read TIFF with sharp
        const image = sharp(inputPath);
        const metadata = await image.metadata();
        const { width, height } = metadata;

        console.log(`  Reading ${basename} (${width}×${height})...`);

        // Get raw RGB pixel data (force 8-bit RGB output for consistency)
        const { data: rgbPixels } = await image
            .removeAlpha()
            .toColorspace('srgb')
            .raw()
            .toBuffer({ resolveWithObject: true });

        // 2. Convert RGB to 8-bit Lab byte encoding
        console.log(`  Converting to Lab...`);
        const pixelCount = width * height;

        // Create 8-bit Lab buffer (3 bytes per pixel: L, a, b)
        // PSDWriter will internally convert to 16-bit
        const labPixels = new Uint8ClampedArray(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const r = rgbPixels[i * 3];
            const g = rgbPixels[i * 3 + 1];
            const b = rgbPixels[i * 3 + 2];

            const lab8 = rgbToLab8(r, g, b);

            labPixels[i * 3] = lab8.L;
            labPixels[i * 3 + 1] = lab8.a;
            labPixels[i * 3 + 2] = lab8.b;
        }

        // 3. Write 16-bit Lab PSD
        console.log(`  Writing PSD...`);
        const outputPath = path.join(outputDir, `${basename}.psd`);

        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        // Add single pixel layer with Lab data
        // PSDWriter expects 8-bit Lab encoding, converts to 16-bit internally
        writer.addPixelLayer({
            name: 'Background',
            pixels: labPixels,
            visible: true
        });

        const psdBuffer = writer.write();
        fs.writeFileSync(outputPath, psdBuffer);

        const sizeMB = (psdBuffer.length / 1024 / 1024).toFixed(2);
        console.log(chalk.green(`  ✓ ${basename}.psd (${width}×${height}, ${sizeMB} MB)`));

        // Force garbage collection if available (run with --expose-gc)
        if (global.gc) {
            global.gc();
        }

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
    console.log(chalk.bold(`\n🔄 TIFF → 16-bit Lab PSD Converter`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));

    // Ensure directories exist
    if (!fs.existsSync(INPUT_DIR)) {
        console.error(chalk.red(`Input directory not found: ${INPUT_DIR}`));
        process.exit(1);
    }

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Get all TIFF files, sorted by file size (smallest first)
    const files = fs.readdirSync(INPUT_DIR)
        .filter(f => f.endsWith('.tif'))
        .map(f => ({
            name: f,
            size: fs.statSync(path.join(INPUT_DIR, f)).size
        }))
        .sort((a, b) => a.size - b.size)
        .map(f => f.name);

    console.log(`Input:  ${INPUT_DIR}`);
    console.log(`Output: ${OUTPUT_DIR}`);
    console.log(`Files:  ${files.length} TIFFs\n`);

    if (files.length === 0) {
        console.log(chalk.yellow('No TIFF files found.'));
        return;
    }

    const startTime = Date.now();
    const results = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(INPUT_DIR, file);

        console.log(`\n[${i + 1}/${files.length}] ${file}`);
        const result = await convertTiffToLabPSD(inputPath, OUTPUT_DIR);

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

    // Save manifest
    const manifest = {
        timestamp: new Date().toISOString(),
        totalFiles: files.length,
        successful: results.length,
        failed: errors.length,
        elapsedSeconds: parseFloat(elapsed),
        files: results
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`Manifest saved to ${OUTPUT_DIR}/manifest.json`);
}

main().catch(err => {
    console.error(chalk.red(`\n❌ Fatal error: ${err.message}`));
    console.error(err.stack);
    process.exit(1);
});
