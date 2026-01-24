#!/usr/bin/env node
/**
 * CQ100 Lab PSD Batch Processor
 *
 * Processes Lab PSDs (8-bit or 16-bit) through the separation engine.
 * Compares separation quality between bit depths.
 *
 * Usage:
 *   node scripts/processCQ100FromPsd.js 8bit    # Process 8-bit PSDs
 *   node scripts/processCQ100FromPsd.js 16bit   # Process 16-bit PSDs
 *   node scripts/processCQ100FromPsd.js         # Process both
 */

const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const { readPsd } = require('../../reveal-psd-reader');
const DynamicConfigurator = require('../src/DynamicConfigurator');
const LabConverter = require('@reveal/core/lib/utils/LabConverter');
const chalk = require('chalk');

const DATA_DIR = path.join(__dirname, '../data/CQ100_v4');

/**
 * Calculate CIE76 Delta-E between two Lab pixels
 */
function deltaE76(L1, a1, b1, L2, a2, b2) {
    return Math.sqrt(
        Math.pow(L2 - L1, 2) +
        Math.pow(a2 - a1, 2) +
        Math.pow(b2 - b1, 2)
    );
}

/**
 * Calculate metrics from original and posterized Lab data
 */
function calculateMetrics(originalLab, posterizedLab, width, height) {
    const pixelCount = width * height;
    let totalDeltaE = 0;
    let maxDeltaE = 0;

    for (let i = 0; i < pixelCount; i++) {
        const idx = i * 3;

        // Convert byte encoding to Lab ranges
        const L1 = (originalLab[idx] / 255) * 100;
        const a1 = originalLab[idx + 1] - 128;
        const b1 = originalLab[idx + 2] - 128;

        const L2 = (posterizedLab[idx] / 255) * 100;
        const a2 = posterizedLab[idx + 1] - 128;
        const b2 = posterizedLab[idx + 2] - 128;

        const dE = deltaE76(L1, a1, b1, L2, a2, b2);
        totalDeltaE += dE;
        if (dE > maxDeltaE) maxDeltaE = dE;
    }

    return {
        avgDeltaE: totalDeltaE / pixelCount,
        maxDeltaE
    };
}

/**
 * Create posterized Lab buffer from color indices and palette
 */
function createPosterizedBuffer(colorIndices, palette, width, height) {
    const pixelCount = width * height;
    const posterized = new Uint8ClampedArray(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const color = palette[colorIndices[i]];
        posterized[i * 3] = Math.round((color.L / 100) * 255);
        posterized[i * 3 + 1] = Math.round(color.a + 128);
        posterized[i * 3 + 2] = Math.round(color.b + 128);
    }

    return posterized;
}

/**
 * Process a single Lab PSD through separation engine
 */
async function processPsd(inputPath, bitDepth) {
    const basename = path.basename(inputPath, '.psd');
    const timingStart = Date.now();

    try {
        // 1. Read Lab PSD
        const buffer = fs.readFileSync(inputPath);
        const psd = readPsd(buffer);

        if (!psd.data) {
            throw new Error('No pixel data found');
        }

        const { width, height, data: labPixels } = psd;

        // 2. Calculate image DNA
        const dna = LabConverter.generateDNA(labPixels, width, height, 40);
        dna.filename = basename;

        // 3. Get bespoke configuration
        const config = DynamicConfigurator.generate(dna);

        // 4. Run posterization
        const posterizeStart = Date.now();
        const posterResult = await Reveal.posterizeImage(
            labPixels, width, height,
            config.targetColors,
            {
                blackBias: config.blackBias,
                saturationBoost: config.saturationBoost
            }
        );
        const posterizeTime = Date.now() - posterizeStart;

        // 5. Run separation
        const separateStart = Date.now();
        const separationResult = await Reveal.separateImage(
            labPixels,
            posterResult.paletteLab,
            width,
            height,
            { ditherType: config.ditherType?.toLowerCase() || 'none' }
        );
        const separateTime = Date.now() - separateStart;

        // 6. Calculate fidelity metrics
        const posterizedBuffer = createPosterizedBuffer(
            separationResult.colorIndices,
            posterResult.paletteLab,
            width,
            height
        );
        const metrics = calculateMetrics(labPixels, posterizedBuffer, width, height);

        const totalTime = Date.now() - timingStart;

        return {
            success: true,
            filename: basename,
            bitDepth,
            dimensions: { width, height },
            dna: {
                l: dna.l,
                c: dna.c,
                k: dna.k,
                minL: dna.minL,
                maxL: dna.maxL,
                maxC: dna.maxC,
                l_std_dev: dna.l_std_dev
            },
            config: {
                targetColors: config.targetColors,
                archetype: config.meta?.archetype || 'unknown'
            },
            metrics: {
                avgDeltaE: metrics.avgDeltaE,
                maxDeltaE: metrics.maxDeltaE
            },
            timing: {
                posterizeMs: posterizeTime,
                separateMs: separateTime,
                totalMs: totalTime
            },
            paletteSize: posterResult.paletteLab.length
        };
    } catch (error) {
        return {
            success: false,
            filename: basename,
            bitDepth,
            error: error.message
        };
    }
}

/**
 * Process all PSDs in a directory
 */
async function processDirectory(bitDepth) {
    const inputDir = path.join(DATA_DIR, `input/psd/${bitDepth}`);
    const outputFile = path.join(DATA_DIR, `output/analysis_${bitDepth}.json`);

    if (!fs.existsSync(inputDir)) {
        console.log(chalk.yellow(`  Skipping ${bitDepth}: directory not found`));
        return null;
    }

    const files = fs.readdirSync(inputDir)
        .filter(f => f.endsWith('.psd'))
        .sort();

    console.log(chalk.cyan(`\n${bitDepth.toUpperCase()}: ${files.length} files`));
    console.log(chalk.dim(`  Input: ${inputDir}`));

    const results = [];
    let success = 0, failed = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(inputDir, file);

        process.stdout.write(`  [${(i + 1).toString().padStart(3)}/${files.length}] ${file.substring(0, 35).padEnd(35)} `);

        const result = await processPsd(inputPath, bitDepth);

        if (result.success) {
            console.log(chalk.green(`✓ ΔE=${result.metrics.avgDeltaE.toFixed(2)} (${result.config.archetype})`));
            results.push(result);
            success++;
        } else {
            console.log(chalk.red(`✗ ${result.error}`));
            failed++;
        }

        // Force GC hint between large images
        if (global.gc && i % 10 === 0) global.gc();
    }

    // Calculate summary statistics
    const summary = {
        bitDepth,
        totalImages: files.length,
        success,
        failed,
        avgDeltaE: results.length ? results.reduce((s, r) => s + r.metrics.avgDeltaE, 0) / results.length : NaN,
        avgMaxDeltaE: results.length ? results.reduce((s, r) => s + r.metrics.maxDeltaE, 0) / results.length : NaN,
        avgProcessingTime: results.length ? results.reduce((s, r) => s + r.timing.totalMs, 0) / results.length : NaN
    };

    // Ensure output directory exists
    const outputDir = path.dirname(outputFile);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write results
    fs.writeFileSync(outputFile, JSON.stringify({ summary, results }, null, 2));
    console.log(chalk.dim(`  Output: ${outputFile}`));

    return { summary, results };
}

async function main() {
    console.log(chalk.bold(`\n📊 CQ100 Lab PSD Batch Processor`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));

    const arg = process.argv[2];
    const bitDepths = arg ? [arg] : ['8bit', '16bit'];

    const startTime = Date.now();
    const allSummaries = {};

    for (const bitDepth of bitDepths) {
        const result = await processDirectory(bitDepth);
        if (result) {
            allSummaries[bitDepth] = result.summary;
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Print comparison summary
    console.log(chalk.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(chalk.bold(`SUMMARY`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));

    for (const [depth, summary] of Object.entries(allSummaries)) {
        console.log(chalk.cyan(`${depth.toUpperCase()}:`));
        console.log(`  Images:      ${summary.success}/${summary.totalImages}`);
        console.log(`  Avg ΔE:      ${summary.avgDeltaE.toFixed(3)}`);
        console.log(`  Avg Max ΔE:  ${summary.avgMaxDeltaE.toFixed(3)}`);
        console.log(`  Avg Time:    ${summary.avgProcessingTime.toFixed(0)}ms`);
        console.log();
    }

    // If we have both, show comparison
    if (allSummaries['8bit'] && allSummaries['16bit']) {
        const s8 = allSummaries['8bit'];
        const s16 = allSummaries['16bit'];

        console.log(chalk.bold(`COMPARISON (16bit - 8bit):`));
        console.log(`  ΔE diff:     ${(s16.avgDeltaE - s8.avgDeltaE).toFixed(4)} (negative = 16bit better)`);
        console.log(`  Max ΔE diff: ${(s16.avgMaxDeltaE - s8.avgMaxDeltaE).toFixed(4)}`);
        console.log();
    }

    console.log(`Total time: ${elapsed}s\n`);
}

main().catch(err => {
    console.error(chalk.red(`\n❌ Fatal error: ${err.message}`));
    console.error(err.stack);
    process.exit(1);
});
