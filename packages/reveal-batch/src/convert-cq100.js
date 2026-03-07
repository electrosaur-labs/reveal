#!/usr/bin/env node
/**
 * convert-cq100.js — PPM → 8-bit Lab PSD converter for CQ100 dataset
 *
 * Input:  data/CQ100_v4/input/ppm/8bit/*.ppm (8-bit RGB)
 * Output: data/CQ100_v4/input/psd/8bit/*.psd (8-bit Lab)
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { PSDWriter } = require('@electrosaur-labs/psd-writer');
const { parsePPM } = require('./ppmParser');
const { convertRgb8ToLab8 } = require('./rgb-to-lab');
const { generateThumbnail } = require('./batch-utils');

const DATA_ROOT = path.join(__dirname, '../data/CQ100_v4');
const INPUT_DIR = path.join(DATA_ROOT, 'input/ppm/8bit');
const OUTPUT_DIR = path.join(DATA_ROOT, 'input/psd/8bit');

async function convertFile(filePath) {
    const basename = path.basename(filePath, '.ppm');
    const ppm = parsePPM(filePath);
    const { width, height, pixels } = ppm;
    const pixelCount = width * height;

    // RGB 8-bit → Lab 8-bit
    const lab8 = convertRgb8ToLab8(pixels, pixelCount);

    // Write 8-bit Lab PSD
    const writer = new PSDWriter({
        width, height,
        colorMode: 'lab',
        bitsPerChannel: 8,
        documentName: basename
    });

    const thumbnail = await generateThumbnail(lab8, width, height);
    writer.setThumbnail(thumbnail);
    writer.setComposite(lab8);

    writer.addPixelLayer({
        name: basename,
        pixels: lab8,
        visible: true
    });

    const psdBuffer = writer.write();
    const outputPath = path.join(OUTPUT_DIR, `${basename}.psd`);
    fs.writeFileSync(outputPath, psdBuffer);

    return { basename, width, height, size: psdBuffer.length };
}

async function main() {
    if (!fs.existsSync(INPUT_DIR)) {
        console.error(chalk.red(`Input directory not found: ${INPUT_DIR}`));
        console.log(`Download CQ100 PPM files first. See ${DATA_ROOT}/README.md`);
        process.exit(1);
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const files = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith('.ppm')).sort();
    if (files.length === 0) {
        console.error(chalk.red(`No PPM files found in ${INPUT_DIR}`));
        process.exit(1);
    }

    console.log(chalk.bold(`\nCQ100 PPM → 8-bit Lab PSD Converter`));
    console.log(`Input:  ${INPUT_DIR}`);
    console.log(`Output: ${OUTPUT_DIR}`);
    console.log(`Files:  ${files.length}\n`);

    let converted = 0;
    for (const file of files) {
        const result = await convertFile(path.join(INPUT_DIR, file));
        converted++;
        console.log(`  [${converted}/${files.length}] ${result.basename} ${result.width}x${result.height} (${(result.size / 1024).toFixed(0)} KB)`);
    }

    console.log(chalk.green(`\nConverted ${converted} files.\n`));
}

if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(err.message));
        process.exit(1);
    });
}

module.exports = { convertFile };
