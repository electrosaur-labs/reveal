/**
 * Test single file processing
 * Run processCQ100.js on just one image to verify before full batch
 */

const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const { PSDWriter } = require('@reveal/psd-writer');
const { parsePPM } = require('./src/ppmParser');
const chalk = require('chalk');

const ImageHeuristicAnalyzer = Reveal.engines.ImageHeuristicAnalyzer;

const PRESETS = {
    'standard-image': require('@reveal/core/presets/standard-image.json'),
    'halftone-portrait': require('@reveal/core/presets/halftone-portrait.json'),
    'vibrant-graphic': require('@reveal/core/presets/vibrant-graphic.json'),
    'atmospheric-photo': require('@reveal/core/presets/atmospheric-photo.json'),
    'pastel-high-key': require('@reveal/core/presets/pastel-high-key.json'),
    'vintage-muted': require('@reveal/core/presets/vintage-muted.json'),
    'deep-shadow-noir': require('@reveal/core/presets/deep-shadow-noir.json'),
    'neon-fluorescent': require('@reveal/core/presets/neon-fluorescent.json'),
    'textural-grunge': require('@reveal/core/presets/textural-grunge.json'),
    'commercial-offset': require('@reveal/core/presets/commercial-offset.json')
};

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => {
        const hex = Math.round(x).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('');
}

async function processImage(inputPath, outputPath) {
    const basename = path.basename(inputPath, '.ppm');
    console.log(chalk.cyan(`\nProcessing ${basename}...`));

    // 1. Parse PPM and convert to Lab
    const ppm = parsePPM(inputPath);
    const { width, height, pixels } = ppm;
    console.log(`  Size: ${width}×${height}`);

    // 2. Convert RGB to Lab
    console.log(`  Converting RGB to Lab...`);
    const pixelCount = width * height;
    const labPixels = new Uint8ClampedArray(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const r = pixels[i * 3];
        const g = pixels[i * 3 + 1];
        const b = pixels[i * 3 + 2];

        const lab = Reveal.rgbToLab({ r, g, b });

        // Convert to byte encoding
        labPixels[i * 3] = (lab.L / 100) * 255;
        labPixels[i * 3 + 1] = lab.a + 128;
        labPixels[i * 3 + 2] = lab.b + 128;
    }

    // CRITICAL: Save a copy of original Lab pixels BEFORE posterization
    // posterizeImage() might mutate the input array!
    const originalLabPixels = new Uint8ClampedArray(labPixels);

    // DEBUG: Log first 5 pixels
    console.log(`  DEBUG: First 5 Lab pixels (byte encoding):`);
    for (let i = 0; i < 5; i++) {
        console.log(`    Pixel ${i}: L=${labPixels[i*3]} a=${labPixels[i*3+1]} b=${labPixels[i*3+2]}`);
    }

    // 2. Auto-detect preset
    console.log(`  Analyzing image characteristics...`);
    const analysis = ImageHeuristicAnalyzer.analyze(labPixels, width, height);
    console.log(chalk.green(`  ✓ Detected: "${analysis.label}"`));
    console.log(`  Preset: ${analysis.presetId}`);

    // 3. Get preset parameters
    const preset = PRESETS[analysis.presetId];
    const params = preset.settings;

    // 4. Posterize (may mutate labPixels!)
    // The engine will automatically build the tuning object from the preset parameters
    console.log(`  Posterizing to ${params.targetColorsSlider} colors...`);
    console.log(`  DEBUG: All parameters:`, JSON.stringify({ ...params, format: 'lab' }, null, 2));
    const posterizeResult = await Reveal.posterizeImage(
        labPixels, width, height,
        params.targetColorsSlider,
        { ...params, format: 'lab' }  // Engine automatically builds tuning from params
    );
    console.log(`  ✓ Generated ${posterizeResult.paletteLab.length} colors`);

    // 5. Separate layers
    console.log(`  Separating layers...`);
    const separateResult = await Reveal.separateImage(
        labPixels,
        posterizeResult.paletteLab,
        width, height,
        { ditherType: params.ditherType }
    );

    // 6. Generate masks
    console.log(`  Generating masks...`);
    const masks = [];
    for (let i = 0; i < posterizeResult.paletteLab.length; i++) {
        const mask = Reveal.generateMask(
            separateResult.colorIndices,
            i,
            width, height
        );
        masks.push(mask);
    }

    // 7. Write 16-bit PSD
    console.log(`  Writing 16-bit PSD...`);
    const writer = new PSDWriter({
        width, height,
        colorMode: 'lab',
        bitsPerChannel: 16
    });

    // Add original image as VISIBLE pixel layer (bottom)
    // Use the SAVED copy, not the mutated labPixels!
    console.log(`  Adding original image as reference layer...`);
    writer.addPixelLayer({
        name: 'Original Image (Reference)',
        pixels: originalLabPixels,  // Use saved copy, not mutated labPixels!
        visible: true
    });

    // Add separated fill+mask layers (top)
    for (let i = 0; i < posterizeResult.paletteLab.length; i++) {
        const color = posterizeResult.paletteLab[i];
        const rgbColor = posterizeResult.palette[i];
        const hex = rgbToHex(rgbColor.r, rgbColor.g, rgbColor.b);

        writer.addFillLayer({
            name: `Color ${i + 1} (${hex})`,
            color: color,
            mask: masks[i]
        });
    }

    const psdBuffer = writer.write();
    fs.writeFileSync(outputPath, psdBuffer);

    console.log(chalk.green(`  ✓ Saved: ${outputPath} (${(psdBuffer.length / 1024).toFixed(2)} KB)`));
}

async function main() {
    const inputPath = path.join(__dirname, 'data/CQ100_v4/input/ppm/astronaut.ppm');  // Back to PPM for now
    const outputPath = path.join(__dirname, 'test-output/astronaut.psd');

    // Ensure output directory exists
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    await processImage(inputPath, outputPath);
    console.log(chalk.green(`\n✓ Test complete. Verify file opens in Photoshop before running full batch.`));
}

main().catch(err => {
    console.error(chalk.red(`\n❌ Error: ${err.message}`));
    console.error(err.stack);
    process.exit(1);
});
