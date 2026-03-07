#!/usr/bin/env node
/**
 * convert-sp100.js — JPEG/TIFF → 16-bit Lab PSD converter for SP100 dataset
 *
 * SP100 has 5 sources, each with a jpg/ subdirectory:
 *   data/SP100/input/{met,rijks,aic,loc,minkler}/jpg/*.{jpg,jpeg,tif,tiff}
 *
 * Output goes to per-source PSD directories:
 *   data/SP100/input/{source}/psd/16bit/*.psd
 *
 * Usage:
 *   node convert-sp100.js              # Convert all sources
 *   node convert-sp100.js met rijks    # Convert specific sources only
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const sharp = require('sharp');
const { PSDWriter } = require('@electrosaur-labs/psd-writer');
const { convertRgb8ToLab8 } = require('./rgb-to-lab');
const { convert8bitTo16bitLab, generateThumbnail } = require('./batch-utils');

const DATA_ROOT = path.join(__dirname, '../data/SP100');
const ALL_SOURCES = ['met', 'rijks', 'aic', 'loc', 'minkler'];
const IMAGE_EXTS = ['.jpg', '.jpeg', '.tif', '.tiff', '.png'];

async function convertFile(filePath, outputDir) {
    const ext = path.extname(filePath);
    const basename = path.basename(filePath, ext);

    // Read image via sharp → 8-bit RGB
    const { data: rgbBuffer, info } = await sharp(filePath)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height } = info;
    const pixelCount = width * height;

    // 8-bit RGB → 8-bit Lab → 16-bit Lab
    const lab8 = convertRgb8ToLab8(rgbBuffer, pixelCount);
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
    const outputPath = path.join(outputDir, `${basename}.psd`);
    fs.writeFileSync(outputPath, psdBuffer);

    return { basename, width, height, size: psdBuffer.length };
}

async function convertSource(source) {
    const jpgDir = path.join(DATA_ROOT, 'input', source, 'jpg');
    const outputDir = path.join(DATA_ROOT, 'input', source, 'psd', '16bit');

    if (!fs.existsSync(jpgDir)) {
        console.log(chalk.yellow(`  Skipping ${source}: no jpg/ directory at ${jpgDir}`));
        return 0;
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const files = fs.readdirSync(jpgDir)
        .filter(f => IMAGE_EXTS.includes(path.extname(f).toLowerCase()))
        .sort();

    if (files.length === 0) {
        console.log(chalk.yellow(`  Skipping ${source}: no image files found`));
        return 0;
    }

    console.log(chalk.cyan(`\n  [${source}] Converting ${files.length} images...`));

    let converted = 0;
    for (const file of files) {
        const result = await convertFile(path.join(jpgDir, file), outputDir);
        converted++;
        console.log(`    [${converted}/${files.length}] ${result.basename} ${result.width}x${result.height} (${(result.size / 1024).toFixed(0)} KB)`);
    }

    return converted;
}

async function main() {
    const args = process.argv.slice(2);
    const sources = args.length > 0
        ? args.filter(s => ALL_SOURCES.includes(s))
        : ALL_SOURCES;

    if (sources.length === 0) {
        console.error(chalk.red(`No valid sources. Choose from: ${ALL_SOURCES.join(', ')}`));
        process.exit(1);
    }

    console.log(chalk.bold(`\nSP100 Image → Lab PSD Converter`));
    console.log(`Sources: ${sources.join(', ')}`);

    let total = 0;
    for (const source of sources) {
        total += await convertSource(source);
    }

    console.log(chalk.green(`\nConverted ${total} files total.\n`));
}

if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(err.message));
        process.exit(1);
    });
}

module.exports = { convertFile, convertSource };
