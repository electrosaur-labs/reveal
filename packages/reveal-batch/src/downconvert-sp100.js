#!/usr/bin/env node
/**
 * downconvert-sp100.js — 16-bit Lab PSD → 8-bit Lab PSD converter
 *
 * For SP100 sources that were originally 8-bit but incorrectly saved as 16-bit.
 * Reads 16-bit Lab PSD, extracts 8-bit Lab data, rewrites as 8-bit Lab PSD.
 *
 * Usage:
 *   node downconvert-sp100.js <input-dir> <output-dir>
 *   node downconvert-sp100.js data/SP100/input/met/psd/16bit data/SP100/input/met/psd/8bit
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { readPsd } = require('@electrosaur-labs/psd-reader');
const { PSDWriter } = require('@electrosaur-labs/psd-writer');
const { convertPsd16bitTo8bitLab, generateThumbnail } = require('./batch-utils');

async function downconvertFile(filePath, outputDir) {
    const basename = path.basename(filePath, '.psd');

    const buffer = fs.readFileSync(filePath);
    const psd = readPsd(buffer);
    const { width, height, depth, data: labData } = psd;

    if (depth !== 16) {
        throw new Error(`Expected 16-bit PSD, got ${depth}-bit`);
    }

    const pixelCount = width * height;
    const lab8 = convertPsd16bitTo8bitLab(labData, pixelCount);

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
    const outputPath = path.join(outputDir, `${basename}.psd`);
    fs.writeFileSync(outputPath, psdBuffer);

    return { basename, width, height, size: psdBuffer.length };
}

async function main() {
    const [inputDir, outputDir] = process.argv.slice(2);

    if (!inputDir || !outputDir) {
        console.error('Usage: node downconvert-sp100.js <input-dir> <output-dir>');
        process.exit(1);
    }

    if (!fs.existsSync(inputDir)) {
        console.error(chalk.red(`Input directory not found: ${inputDir}`));
        process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.psd')).sort();
    if (files.length === 0) {
        console.error(chalk.red(`No PSD files found in ${inputDir}`));
        process.exit(1);
    }

    console.log(chalk.bold(`\n16-bit → 8-bit Lab PSD Downconverter`));
    console.log(`Input:  ${inputDir}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Files:  ${files.length}\n`);

    let converted = 0;
    let skipped = 0;
    for (const file of files) {
        try {
            const result = await downconvertFile(path.join(inputDir, file), outputDir);
            converted++;
            console.log(`  [${converted}/${files.length}] ${result.basename} ${result.width}x${result.height} (${(result.size / 1024).toFixed(0)} KB)`);
        } catch (err) {
            skipped++;
            console.log(chalk.yellow(`  [SKIP] ${file}: ${err.message}`));
        }
    }

    if (skipped > 0) console.log(chalk.yellow(`\nSkipped ${skipped} files due to errors`));
    console.log(chalk.green(`\nDownconverted ${converted} files.\n`));
}

if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(err.message));
        process.exit(1);
    });
}

module.exports = { downconvertFile };
