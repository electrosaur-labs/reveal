#!/usr/bin/env node
/**
 * convert-testimages.js — 16-bit RGB PNG → 16-bit Lab PSD converter for TESTIMAGES dataset
 *
 * Input:  data/TESTIMAGES/input/png/16bit/*.png
 * Output: data/TESTIMAGES/input/psd/16bit/*.psd
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const sharp = require('sharp');
const { PSDWriter } = require('@electrosaur-labs/psd-writer');
const { convertRgb16ToLab8 } = require('./rgb-to-lab');
const { convert8bitTo16bitLab, generateThumbnail } = require('./batch-utils');

const DATA_ROOT = path.join(__dirname, '../data/TESTIMAGES');
const INPUT_DIR = path.join(DATA_ROOT, 'input/png/16bit');
const OUTPUT_DIR = path.join(DATA_ROOT, 'input/psd/16bit');

async function convertFile(filePath) {
    const basename = path.basename(filePath, '.png');

    // Read 16-bit RGB PNG via sharp → raw 16-bit buffer (big-endian)
    const { data: rgbBuffer16, info } = await sharp(filePath)
        .removeAlpha()
        .raw({ depth: 'ushort' })
        .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    const pixelCount = width * height;

    // 16-bit RGB → 8-bit Lab (via LUT-based converter)
    const lab8 = convertRgb16ToLab8(rgbBuffer16, pixelCount);

    // 8-bit Lab → 16-bit Lab (engine encoding for PSD)
    const lab16 = convert8bitTo16bitLab(lab8, pixelCount);

    // Write 16-bit Lab PSD
    const writer = new PSDWriter({
        width, height,
        colorMode: 'lab',
        bitsPerChannel: 16,
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
        console.log(`Download TESTIMAGES SAMPLING dataset first. See ${DATA_ROOT}/README.md`);
        process.exit(1);
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const files = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith('.png')).sort();
    if (files.length === 0) {
        console.error(chalk.red(`No PNG files found in ${INPUT_DIR}`));
        process.exit(1);
    }

    console.log(chalk.bold(`\nTESTIMAGES PNG → Lab PSD Converter`));
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
