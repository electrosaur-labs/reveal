#!/usr/bin/env node
/**
 * Single-File PSD Posterizer
 *
 * Posterizes a Lab PSD file (8-bit or 16-bit) and outputs:
 *   - Separated PSD with fill+mask layers
 *   - DNA JSON sidecar file
 *
 * Usage: node posterize-psd.js <bitDepth> <inputPSD> <outputDir>
 *   bitDepth: 8 or 16
 *   inputPSD: Path to input Lab PSD file
 *   outputDir: Directory for output files
 *
 * Example:
 *   node posterize-psd.js 16 ./input/image.psd ./output
 */

const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const { PSDWriter } = require('@reveal/psd-writer');
const { readPsd } = require('@reveal/psd-reader');
const DynamicConfigurator = require('./DynamicConfigurator');
const MetricsCalculator = require('./MetricsCalculator');
const chalk = require('chalk');

/**
 * Convert 8-bit Lab encoding to engine 16-bit Lab encoding
 *
 * 8-bit PSD:    L: 0-255, a/b: 0-255 (128=neutral)
 * Engine 16-bit: L: 0-32768, a/b: 0-32768 (16384=neutral)
 */
function convert8bitTo16bitLab(lab8bit, pixelCount) {
    const lab16bit = new Uint16Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const L_8 = lab8bit[i * 3];
        const a_8 = lab8bit[i * 3 + 1];
        const b_8 = lab8bit[i * 3 + 2];

        // L: 0-255 → 0-32768
        lab16bit[i * 3] = Math.round(L_8 * 32768 / 255);

        // a: 0-255 (128=neutral) → 0-32768 (16384=neutral)
        lab16bit[i * 3 + 1] = (a_8 - 128) * 128 + 16384;

        // b: same as a
        lab16bit[i * 3 + 2] = (b_8 - 128) * 128 + 16384;
    }

    return lab16bit;
}

/**
 * Convert PSD 16-bit Lab encoding to engine 16-bit Lab encoding
 *
 * PSD 16-bit:    L: 0-65535, a/b: 0-65535 (32768=neutral)
 * Engine 16-bit: L: 0-32768, a/b: 0-32768 (16384=neutral)
 */
function convertPsd16bitToEngineLab(labPsd16, pixelCount) {
    const labEngine = new Uint16Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        // Divide by 2: 0-65535 → 0-32767, neutral 32768→16384
        labEngine[i * 3] = labPsd16[i * 3] >> 1;
        labEngine[i * 3 + 1] = labPsd16[i * 3 + 1] >> 1;
        labEngine[i * 3 + 2] = labPsd16[i * 3 + 2] >> 1;
    }

    return labEngine;
}

/**
 * Convert 16-bit Lab encoding to 8-bit Lab encoding (for DNA calculation)
 */
function convert16bitTo8bitLab(lab16bit, pixelCount) {
    const lab8bit = new Uint8Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        lab8bit[i * 3] = Math.round(lab16bit[i * 3] / 257);
        lab8bit[i * 3 + 1] = Math.round(lab16bit[i * 3 + 1] / 257);
        lab8bit[i * 3 + 2] = Math.round(lab16bit[i * 3 + 2] / 257);
    }

    return lab8bit;
}

/**
 * Convert RGB to hex string
 */
function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => {
        const hex = Math.round(x).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('');
}

/**
 * Reconstruct processedLab from colorIndices and palette
 * Output is 8-bit Lab encoding for MetricsCalculator
 *
 * Palette Lab is in perceptual format: L: 0-100, a/b: ~-128 to +127
 * Output 8-bit encoding: L: 0-255, a/b: 0-255 (128=neutral)
 */
function reconstructProcessedLab(colorIndices, paletteLab, pixelCount) {
    const processedLab = new Uint8ClampedArray(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const colorIdx = colorIndices[i];
        const color = paletteLab[colorIdx];

        // Convert perceptual Lab to 8-bit encoding
        processedLab[i * 3] = Math.round((color.L / 100) * 255);
        processedLab[i * 3 + 1] = Math.round(color.a + 128);
        processedLab[i * 3 + 2] = Math.round(color.b + 128);
    }

    return processedLab;
}

/**
 * Calculate image DNA from 8-bit Lab data
 */
function calculateImageDNA(lab8bit, width, height, sampleStep = 40) {
    const pixelCount = width * height;
    let sumL = 0, sumC = 0;
    let minL = 100, maxL = 0, maxC = 0;
    let sampleCount = 0;
    const lValues = [];

    for (let i = 0; i < pixelCount; i += sampleStep) {
        // Convert 8-bit to perceptual
        const L = (lab8bit[i * 3] / 255) * 100;
        const a = lab8bit[i * 3 + 1] - 128;
        const b = lab8bit[i * 3 + 2] - 128;
        const C = Math.sqrt(a * a + b * b);

        sumL += L;
        sumC += C;
        lValues.push(L);
        if (L < minL) minL = L;
        if (L > maxL) maxL = L;
        if (C > maxC) maxC = C;
        sampleCount++;
    }

    const avgL = sumL / sampleCount;
    const avgC = sumC / sampleCount;

    // Calculate L standard deviation
    const lVariance = lValues.reduce((sum, l) => sum + Math.pow(l - avgL, 2), 0) / sampleCount;
    const lStdDev = Math.sqrt(lVariance);

    return {
        l: parseFloat(avgL.toFixed(1)),
        c: parseFloat(avgC.toFixed(1)),
        k: parseFloat((maxL - minL).toFixed(1)),
        minL: parseFloat(minL.toFixed(1)),
        maxL: parseFloat(maxL.toFixed(1)),
        maxC: parseFloat(maxC.toFixed(1)),
        l_std_dev: parseFloat(lStdDev.toFixed(1))
    };
}

/**
 * Process a single Lab PSD (8-bit or 16-bit)
 */
async function posterizePsd(inputPath, outputDir, expectedBitDepth) {
    const basename = path.basename(inputPath, '.psd');
    console.log(chalk.cyan(`\nProcessing: ${basename}`));

    const timingStart = Date.now();

    // 1. Read Lab PSD
    const buffer = fs.readFileSync(inputPath);
    const psd = readPsd(buffer);
    const { width, height, depth, data: labData } = psd;
    const pixelCount = width * height;

    console.log(`  Size: ${width}×${height} (${depth}-bit Lab)`);

    // Verify bit depth matches expectation
    if (expectedBitDepth && depth !== expectedBitDepth) {
        console.log(chalk.yellow(`  Warning: Expected ${expectedBitDepth}-bit but got ${depth}-bit`));
    }

    // 2. Prepare engine 16-bit Lab and 8-bit Lab for DNA
    let lab16bit, lab8bit;

    if (depth === 8) {
        lab8bit = labData;
        console.log(`  Converting 8-bit Lab to engine encoding...`);
        lab16bit = convert8bitTo16bitLab(lab8bit, pixelCount);
    } else {
        console.log(`  Converting 16-bit Lab to engine encoding...`);
        lab16bit = convertPsd16bitToEngineLab(labData, pixelCount);
        lab8bit = convert16bitTo8bitLab(labData, pixelCount);
    }

    // 3. Calculate image DNA
    console.log(`  Calculating image DNA...`);
    const dna = calculateImageDNA(lab8bit, width, height);
    dna.filename = basename;
    dna.bitDepth = depth;

    console.log(`  DNA: L=${dna.l}, C=${dna.c}, K=${dna.k}, StdDev=${dna.l_std_dev}, maxC=${dna.maxC}`);

    // 4. Generate configuration
    const config = DynamicConfigurator.generate(dna);
    console.log(chalk.green(`  Archetype: ${config.meta?.archetype || 'unknown'}`));
    console.log(`  Colors: ${config.targetColors}, BlackBias: ${config.blackBias}, Dither: ${config.ditherType}`);

    // 5. Prepare params
    const params = {
        targetColorsSlider: config.targetColors,
        blackBias: config.blackBias,
        ditherType: config.ditherType,
        format: 'lab',
        bitDepth: 8,
        engineType: 'reveal',
        centroidStrategy: 'SALIENCY',
        lWeight: 1.0,
        cWeight: 1.0,
        substrateMode: 'auto',
        substrateTolerance: 2.0,
        vibrancyMode: 'moderate',
        vibrancyBoost: config.saturationBoost,
        highlightThreshold: 85,
        highlightBoost: 1.0,
        enablePaletteReduction: true,
        paletteReduction: 10.0,
        hueLockAngle: 20,
        shadowPoint: 15,
        colorMode: 'color',
        preserveWhite: true,
        preserveBlack: true,
        ignoreTransparent: true,
        enableHueGapAnalysis: true
    };

    // 6. Posterize
    console.log(`  Posterizing to ${params.targetColorsSlider} colors...`);
    const posterizeResult = await Reveal.posterizeImage(
        lab16bit,
        width, height,
        params.targetColorsSlider,
        params
    );

    console.log(`  Generated ${posterizeResult.paletteLab.length} colors`);

    // 7. Separate into layers
    console.log(`  Separating layers...`);
    const separateResult = await Reveal.separateImage(
        lab16bit,
        posterizeResult.paletteLab,
        width, height,
        { ditherType: params.ditherType }
    );

    // 8. Generate masks
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

    // Release lab16bit - no longer needed after separation
    lab16bit = null;

    // 9. Calculate validation metrics
    console.log(`  Computing validation metrics...`);
    const processedLab = reconstructProcessedLab(
        separateResult.colorIndices,
        posterizeResult.paletteLab,
        pixelCount
    );

    // Create layers array for MetricsCalculator
    const layersForMetrics = posterizeResult.paletteLab.map((color, idx) => ({
        name: `Color ${idx + 1}`,
        color: color,
        mask: masks[idx]
    }));

    // Convert lab8bit to Uint8ClampedArray if needed (MetricsCalculator expects this)
    const originalLabClamped = lab8bit instanceof Uint8ClampedArray
        ? lab8bit
        : new Uint8ClampedArray(lab8bit);

    const metrics = MetricsCalculator.compute(
        originalLabClamped,
        processedLab,
        layersForMetrics,
        width,
        height,
        { targetColors: params.targetColorsSlider }
    );

    console.log(`  DeltaE: avg=${metrics.global_fidelity.avgDeltaE}, max=${metrics.global_fidelity.maxDeltaE}`);
    console.log(`  Revelation Score: ${metrics.feature_preservation.revelationScore}`);
    console.log(`  Integrity: ${metrics.physical_feasibility.integrityScore}%`);

    // 10. Calculate coverage
    const coverageCounts = new Uint32Array(posterizeResult.paletteLab.length);
    for (let i = 0; i < pixelCount; i++) {
        coverageCounts[separateResult.colorIndices[i]]++;
    }

    const palette = posterizeResult.paletteLab.map((color, idx) => {
        const rgbColor = posterizeResult.palette[idx];
        const hex = rgbToHex(rgbColor.r, rgbColor.g, rgbColor.b);
        const coverage = ((coverageCounts[idx] / pixelCount) * 100).toFixed(2);

        return {
            name: `Ink ${idx + 1} (${hex})`,
            lab: { L: parseFloat(color.L.toFixed(2)), a: parseFloat(color.a.toFixed(2)), b: parseFloat(color.b.toFixed(2)) },
            rgb: { r: Math.round(rgbColor.r), g: Math.round(rgbColor.g), b: Math.round(rgbColor.b) },
            hex: hex,
            coverage: `${coverage}%`
        };
    });

    // 11. Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // 12. Write output PSD (8-bit for QuickLook compatibility)
    console.log(`  Writing PSD...`);
    const outputPsdPath = path.join(outputDir, `${basename}.psd`);
    const writer = new PSDWriter({
        width,
        height,
        colorMode: 'lab',
        bitsPerChannel: 8,
        documentName: basename
    });

    // Add original as invisible reference layer
    writer.addPixelLayer({
        name: 'Original Image (Reference)',
        pixels: lab8bit,
        visible: false
    });

    // Sort layers by lightness (light to dark) for proper print stacking
    const layersToWrite = posterizeResult.paletteLab.map((color, i) => ({
        index: i,
        color: color,
        rgb: posterizeResult.palette[i],
        mask: masks[i],
        coverage: coverageCounts[i]
    }));
    layersToWrite.sort((a, b) => b.color.L - a.color.L);

    console.log(`  Layer order (bottom→top):`);
    layersToWrite.forEach((layer, idx) => {
        const hex = rgbToHex(layer.rgb.r, layer.rgb.g, layer.rgb.b);
        const pct = ((layer.coverage / pixelCount) * 100).toFixed(2);
        console.log(`    ${idx + 1}. ${hex} - L=${layer.color.L.toFixed(1)}, Coverage=${pct}%`);
    });

    // Add fill+mask layers
    for (const layer of layersToWrite) {
        const hex = rgbToHex(layer.rgb.r, layer.rgb.g, layer.rgb.b);
        writer.addFillLayer({
            name: `Color ${layer.index + 1} (${hex})`,
            color: layer.color,
            mask: layer.mask
        });
    }

    const psdBuffer = writer.write();
    fs.writeFileSync(outputPsdPath, psdBuffer);
    console.log(chalk.green(`  Saved: ${outputPsdPath} (${(psdBuffer.length / 1024).toFixed(1)} KB)`));

    // 13. Write validation JSON sidecar
    const jsonPath = path.join(outputDir, `${basename}.json`);
    const sidecar = {
        meta: {
            filename: path.basename(inputPath),
            timestamp: new Date().toISOString(),
            width, height,
            inputBitDepth: depth,
            outputFile: `${basename}.psd`
        },
        dna,
        configuration: config,
        palette,
        metrics,
        timing: {
            totalMs: Date.now() - timingStart
        }
    };
    fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));
    console.log(chalk.green(`  Validation JSON: ${jsonPath}`));

    // 14. Explicit resource cleanup
    // Release all large arrays to free memory immediately
    lab8bit = null;
    masks.length = 0;
    layersToWrite.length = 0;
    // psdBuffer is already written and goes out of scope

    return {
        success: true,
        filename: basename,
        colors: palette.length,
        dna: dna,
        metrics: metrics
    };
}

// Main CLI
async function main() {
    const args = process.argv.slice(2);

    if (args.length < 3) {
        console.log(chalk.bold(`\nUsage: node posterize-psd.js <bitDepth> <inputPSD> <outputDir>`));
        console.log(`\n  bitDepth:  8 or 16 (expected bit depth of input file)`);
        console.log(`  inputPSD:  Path to input Lab PSD file`);
        console.log(`  outputDir: Directory for output PSD and JSON files`);
        console.log(`\nExample:`);
        console.log(`  node posterize-psd.js 16 ./input/image.psd ./output\n`);
        process.exit(1);
    }

    const [bitDepthArg, inputPath, outputDir] = args;
    const bitDepth = parseInt(bitDepthArg, 10);

    if (bitDepth !== 8 && bitDepth !== 16) {
        console.error(chalk.red(`Error: bitDepth must be 8 or 16, got: ${bitDepthArg}`));
        process.exit(1);
    }

    if (!fs.existsSync(inputPath)) {
        console.error(chalk.red(`Error: Input file not found: ${inputPath}`));
        process.exit(1);
    }

    console.log(chalk.bold(`\nPosterize PSD`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(`Input:    ${inputPath}`);
    console.log(`Output:   ${outputDir}`);
    console.log(`Expected: ${bitDepth}-bit Lab`);

    try {
        const result = await posterizePsd(inputPath, outputDir, bitDepth);
        console.log(chalk.green(`\nDone.`));
    } catch (error) {
        console.error(chalk.red(`\nError: ${error.message}`));
        console.error(error.stack);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = { posterizePsd };
