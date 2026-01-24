#!/usr/bin/env node
/**
 * reveal-batch.js
 * Generic batch processor for Lab PSDs through the Reveal engine.
 *
 * Usage: node reveal-batch.js <input-dir> <output-dir>
 *
 * Input:  Directory containing Lab PSDs (8-bit or 16-bit)
 * Output: Directory for processed PSDs and validation JSONs
 */
const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const { PSDWriter } = require('@reveal/psd-writer');
const { readPsd } = require('@reveal/psd-reader');
const DynamicConfigurator = require('./DynamicConfigurator');
const MetricsCalculator = require('./MetricsCalculator');
const chalk = require('chalk');
const sharp = require('sharp');

// === ENCODING CONVERSION FUNCTIONS ===

/**
 * Convert 8-bit Lab encoding to engine 16-bit Lab encoding
 */
function convert8bitTo16bitLab(lab8bit, pixelCount) {
    const lab16bit = new Uint16Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const L_8 = lab8bit[i * 3];
        const a_8 = lab8bit[i * 3 + 1];
        const b_8 = lab8bit[i * 3 + 2];

        lab16bit[i * 3] = Math.round(L_8 * 32768 / 255);
        lab16bit[i * 3 + 1] = (a_8 - 128) * 128 + 16384;
        lab16bit[i * 3 + 2] = (b_8 - 128) * 128 + 16384;
    }

    return lab16bit;
}

/**
 * Convert PSD 16-bit Lab encoding to engine 16-bit Lab encoding
 */
function convertPsd16bitToEngineLab(labPsd16, pixelCount) {
    const labEngine = new Uint16Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        labEngine[i * 3] = labPsd16[i * 3] >> 1;
        labEngine[i * 3 + 1] = labPsd16[i * 3 + 1] >> 1;
        labEngine[i * 3 + 2] = labPsd16[i * 3 + 2] >> 1;
    }

    return labEngine;
}

/**
 * Convert 16-bit Lab encoding to 8-bit Lab encoding
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
 * Convert 8-bit Lab to RGB for thumbnail generation
 */
function lab8bitToRgb(lab8bit, pixelCount) {
    const rgb = new Uint8Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const L = (lab8bit[i * 3] / 255) * 100;
        const a = lab8bit[i * 3 + 1] - 128;
        const b = lab8bit[i * 3 + 2] - 128;

        const fy = (L + 16) / 116;
        const fx = a / 500 + fy;
        const fz = fy - b / 200;

        const xr = fx > 0.206893 ? fx * fx * fx : (fx - 16/116) / 7.787;
        const yr = fy > 0.206893 ? fy * fy * fy : (fy - 16/116) / 7.787;
        const zr = fz > 0.206893 ? fz * fz * fz : (fz - 16/116) / 7.787;

        const X = xr * 96.422;
        const Y = yr * 100.0;
        const Z = zr * 82.521;

        let R =  3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
        let G = -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z;
        let B =  0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;

        R = R / 100;
        G = G / 100;
        B = B / 100;

        R = R > 0.0031308 ? 1.055 * Math.pow(R, 1/2.4) - 0.055 : 12.92 * R;
        G = G > 0.0031308 ? 1.055 * Math.pow(G, 1/2.4) - 0.055 : 12.92 * G;
        B = B > 0.0031308 ? 1.055 * Math.pow(B, 1/2.4) - 0.055 : 12.92 * B;

        rgb[i * 3] = Math.max(0, Math.min(255, Math.round(R * 255)));
        rgb[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(G * 255)));
        rgb[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(B * 255)));
    }

    return rgb;
}

/**
 * Generate JPEG thumbnail from 8-bit Lab data
 */
async function generateThumbnail(lab8bit, width, height, maxSize = 256) {
    const pixelCount = width * height;
    const rgb = lab8bitToRgb(lab8bit, pixelCount);

    const scale = Math.min(maxSize / width, maxSize / height);
    const thumbWidth = Math.round(width * scale);
    const thumbHeight = Math.round(height * scale);

    const jpegBuffer = await sharp(Buffer.from(rgb), {
        raw: { width, height, channels: 3 }
    })
    .resize(thumbWidth, thumbHeight)
    .jpeg({ quality: 80 })
    .toBuffer();

    return {
        jpegData: jpegBuffer,
        width: thumbWidth,
        height: thumbHeight
    };
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
 * Calculate image DNA from 8-bit Lab data
 */
function calculateImageDNA(lab8bit, width, height, sampleStep = 40) {
    const pixelCount = width * height;
    let sumL = 0, sumC = 0;
    let minL = 100, maxL = 0, maxC = 0;
    let sampleCount = 0;
    const lValues = [];

    for (let i = 0; i < pixelCount; i += sampleStep) {
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
 * Process a single Lab PSD
 */
async function processImage(inputPath, outputDir) {
    const basename = path.basename(inputPath, '.psd');
    console.log(chalk.cyan(`\n[${basename}] Processing...`));

    const timingStart = Date.now();

    try {
        // 1. Read Lab PSD
        const buffer = fs.readFileSync(inputPath);
        const psd = readPsd(buffer);
        const { width, height, depth, data: labData } = psd;
        const pixelCount = width * height;

        console.log(`  Size: ${width}×${height} (${depth}-bit Lab)`);

        // 2. Prepare engine 16-bit Lab and 8-bit Lab for metrics/thumbnail
        let lab16bit, lab8bit;

        if (depth === 8) {
            lab8bit = labData;
            console.log(`  Converting 8-bit Lab to engine 16-bit encoding...`);
            lab16bit = convert8bitTo16bitLab(lab8bit, pixelCount);
        } else {
            console.log(`  Converting PSD 16-bit to engine 16-bit encoding...`);
            lab16bit = convertPsd16bitToEngineLab(labData, pixelCount);
            lab8bit = convert16bitTo8bitLab(labData, pixelCount);
        }

        // 3. Calculate image DNA
        console.log(`  Calculating image DNA...`);
        const dna = calculateImageDNA(lab8bit, width, height);
        dna.filename = basename;

        console.log(`  DNA: L=${dna.l}, C=${dna.c}, K=${dna.k}, StdDev=${dna.l_std_dev}, maxC=${dna.maxC}`);

        // 4. Generate configuration
        const config = DynamicConfigurator.generate(dna);
        console.log(chalk.green(`  ✓ Archetype: ${config.meta?.archetype || 'unknown'}`));
        console.log(`  Colors: ${config.targetColors}, BlackBias: ${config.blackBias}, Dither: ${config.ditherType}`);

        // 5. Prepare params
        const params = {
            targetColorsSlider: config.targetColors,
            blackBias: config.blackBias,
            ditherType: config.ditherType,
            format: 'lab',
            bitDepth: depth,
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
            enableHueGapAnalysis: true,
            maskProfile: 'Gray Gamma 2.2'
        };

        // 6. Posterize
        console.log(`  Posterizing to ${params.targetColorsSlider} colors...`);
        const posterizeResult = await Reveal.posterizeImage(
            lab16bit,
            width, height,
            params.targetColorsSlider,
            params
        );

        console.log(`  ✓ Generated ${posterizeResult.paletteLab.length} colors`);

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

        // 9. Reconstruct virtual composite for metrics
        console.log(`  Reconstructing virtual composite...`);
        const processedLab = new Uint8ClampedArray(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const colorIdx = separateResult.colorIndices[i];
            const color = posterizeResult.paletteLab[colorIdx];
            processedLab[i * 3] = (color.L / 100) * 255;
            processedLab[i * 3 + 1] = color.a + 128;
            processedLab[i * 3 + 2] = color.b + 128;
        }

        // 10. Calculate metrics
        console.log(`  Computing validation metrics...`);
        const layers = masks.map((mask, i) => ({
            name: `Ink ${i + 1}`,
            color: posterizeResult.paletteLab[i],
            mask: mask
        }));

        const metrics = MetricsCalculator.compute(
            lab8bit,
            processedLab,
            layers,
            width,
            height
        );

        // 11. Calculate coverage
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

        // 12. Write output PSD
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
        console.log(`  Adding original image as reference layer...`);
        writer.addPixelLayer({
            name: 'Original Image (Reference)',
            pixels: lab8bit,
            visible: false
        });

        // Sort layers by lightness (light to dark)
        console.log(`  Sorting layers by lightness (light→dark)...`);
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

        // Generate thumbnail
        console.log(`  Generating thumbnail for QuickLook...`);
        const thumbnail = await generateThumbnail(lab8bit, width, height);
        writer.setThumbnail(thumbnail);

        const psdBuffer = writer.write();
        fs.writeFileSync(outputPsdPath, psdBuffer);
        console.log(chalk.green(`  ✓ Saved: ${outputPsdPath} (${(psdBuffer.length / 1024).toFixed(1)} KB)`));

        // 13. Write sidecar JSON
        const jsonPath = path.join(outputDir, `${basename}.json`);
        const sidecar = {
            meta: {
                filename: path.basename(inputPath),
                timestamp: new Date().toISOString(),
                width, height, depth,
                outputFile: `${basename}.psd`
            },
            dna,
            configuration: config,
            input_parameters: params,
            palette,
            metrics: metrics,
            timing: {
                totalMs: Date.now() - timingStart
            }
        };
        fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));
        console.log(chalk.green(`  ✓ Sidecar: ${jsonPath}`));

        return {
            success: true,
            filename: basename,
            colors: palette.length,
            avgDeltaE: metrics.global_fidelity.avgDeltaE,
            timing: Date.now() - timingStart
        };

    } catch (error) {
        console.error(chalk.red(`  ✗ Error: ${error.message}`));
        return {
            success: false,
            filename: basename,
            error: error.message
        };
    }
}

/**
 * Main batch processing
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.log(chalk.yellow(`
Usage: node reveal-batch.js <input-dir> <output-dir>

Arguments:
  input-dir   Directory containing Lab PSDs (8-bit or 16-bit)
  output-dir  Directory for processed PSDs and validation JSONs

Example:
  node reveal-batch.js data/CQ100/input/psd/8bit data/CQ100/output/8bit
  node reveal-batch.js data/SP100/input/met/psd/8bit data/SP100/output/met
`));
        process.exit(1);
    }

    const inputDir = path.resolve(args[0]);
    const outputDir = path.resolve(args[1]);

    // Validate input directory
    if (!fs.existsSync(inputDir)) {
        console.error(chalk.red(`Error: Input directory does not exist: ${inputDir}`));
        process.exit(1);
    }

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Get all PSD files
    const files = fs.readdirSync(inputDir)
        .filter(f => f.endsWith('.psd'))
        .sort();

    if (files.length === 0) {
        console.error(chalk.red(`Error: No PSD files found in ${inputDir}`));
        process.exit(1);
    }

    console.log(chalk.bold(`\n🎨 Reveal Batch Processor`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Input:  ${inputDir}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Files:  ${files.length} images\n`);

    const results = [];
    const startTime = Date.now();

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(inputDir, file);

        console.log(chalk.bold(`\n[${i + 1}/${files.length}] ${file}`));
        const result = await processImage(inputPath, outputDir);
        results.push(result);
    }

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);

    console.log(chalk.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(chalk.bold(`📊 SUMMARY`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Total:     ${files.length} images`);
    console.log(chalk.green(`Success:   ${successResults.length}`));
    console.log(chalk.red(`Failed:    ${failedResults.length}`));
    console.log(`Time:      ${elapsed}s`);
    console.log(`Avg:       ${(elapsed / files.length).toFixed(2)}s per image\n`);

    if (successResults.length > 0) {
        const avgDeltaE = successResults.reduce((sum, r) => sum + (r.avgDeltaE || 0), 0) / successResults.length;
        console.log(`Avg ΔE:    ${avgDeltaE.toFixed(2)}`);
    }

    // Save batch report
    const reportPath = path.join(outputDir, 'batch-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        inputDir,
        outputDir,
        total: files.length,
        success: successResults.length,
        failed: failedResults.length,
        elapsedSeconds: parseFloat(elapsed),
        avgDeltaE: successResults.length > 0
            ? successResults.reduce((sum, r) => sum + (r.avgDeltaE || 0), 0) / successResults.length
            : 0,
        results: successResults,
        errors: failedResults.map(r => ({ filename: r.filename, error: r.error }))
    }, null, 2));

    console.log(chalk.green(`✓ Report saved: ${reportPath}\n`));
}

// Run if called directly
if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(`\n❌ Fatal error: ${err.message}`));
        console.error(err.stack);
        process.exit(1);
    });
}

module.exports = { processImage };
