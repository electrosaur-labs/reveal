/**
 * Image → 16-bit Lab PSD Converter
 *
 * Converts TIFF or JPG files to 16-bit Lab PSD format using:
 * - sharp for image reading (supports TIFF, JPG, PNG, etc.)
 * - reveal-core for RGB→Lab conversion
 * - reveal-psd-writer for 16-bit Lab PSD output
 *
 * Usage: node convertImageToLabPsd.js <source>
 *   source: 'met', 'rijks', or directory path
 *
 * Examples:
 *   node convertImageToLabPsd.js met      # Process Met Museum JPGs
 *   node convertImageToLabPsd.js rijks    # Process Rijksmuseum JPGs
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const Reveal = require('@reveal/core');
const { PSDWriter } = require('@reveal/psd-writer');
const chalk = require('chalk');

// Parse command line arguments
const sourceArg = process.argv[2] || 'met';

// Determine input/output directories based on source
let INPUT_DIR, OUTPUT_DIR;
if (sourceArg === 'met') {
    INPUT_DIR = path.join(__dirname, '../data/SP100/input/met/jpg');
    OUTPUT_DIR = path.join(__dirname, '../data/SP100/input/met/psd');
} else if (sourceArg === 'rijks') {
    INPUT_DIR = path.join(__dirname, '../data/SP100/input/rijks/jpg');
    OUTPUT_DIR = path.join(__dirname, '../data/SP100/input/rijks/psd');
} else {
    // Assume it's a custom path
    INPUT_DIR = sourceArg;
    OUTPUT_DIR = path.join(path.dirname(sourceArg), 'psd');
}

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
 * Convert a single image (TIFF, JPG, PNG) to 16-bit Lab PSD
 */
async function convertImageToLabPSD(inputPath, outputDir) {
    const ext = path.extname(inputPath);
    const basename = path.basename(inputPath, ext);

    try {
        // 1. Read image with sharp
        let image = sharp(inputPath);
        const metadata = await image.metadata();
        let { width, height } = metadata;

        // Cap at 4000px on the long edge to avoid PSD buffer limits
        const MAX_DIMENSION = 4000;
        const longEdge = Math.max(width, height);
        let resized = false;

        if (longEdge > MAX_DIMENSION) {
            const scale = MAX_DIMENSION / longEdge;
            const newWidth = Math.round(width * scale);
            const newHeight = Math.round(height * scale);
            console.log(`  Reading ${basename} (${width}×${height} → ${newWidth}×${newHeight})...`);
            image = image.resize(newWidth, newHeight);
            width = newWidth;
            height = newHeight;
            resized = true;
        } else {
            console.log(`  Reading ${basename} (${width}×${height})...`);
        }

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

    // Get all image files (TIFF, JPG, PNG), sorted by file size (smallest first)
    const supportedExtensions = ['.tif', '.tiff', '.jpg', '.jpeg', '.png'];
    const files = fs.readdirSync(INPUT_DIR)
        .filter(f => supportedExtensions.some(ext => f.toLowerCase().endsWith(ext)))
        .map(f => ({
            name: f,
            size: fs.statSync(path.join(INPUT_DIR, f)).size
        }))
        .sort((a, b) => a.size - b.size)
        .map(f => f.name);

    console.log(`Source: ${sourceArg}`);
    console.log(`Input:  ${INPUT_DIR}`);
    console.log(`Output: ${OUTPUT_DIR}`);
    console.log(`Files:  ${files.length} images\n`);

    if (files.length === 0) {
        console.log(chalk.yellow('No image files found.'));
        return;
    }

    const startTime = Date.now();
    const results = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(INPUT_DIR, file);

        console.log(`\n[${i + 1}/${files.length}] ${file}`);
        const result = await convertImageToLabPSD(inputPath, OUTPUT_DIR);

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
