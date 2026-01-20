/**
 * PPM → Lab PSD + Separated PSD Processor
 *
 * Single-pass processor: reads PPM, converts to Lab in memory, writes intermediate
 * Lab PSD, then continues with separation using the same Lab data in memory.
 * Automatically detects optimal presets and generates multi-layer separated PSDs.
 *
 * Input:  data/CQ100_v4/input/ppm/*.ppm (source RGB images)
 * Intermediate: data/CQ100_v4/input/psd/*.psd (16-bit Lab composite images)
 * Output: data/CQ100_v4/output/psd/*.psd (separated multi-layer PSDs)
 */

const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const { PSDWriter } = require('@reveal/psd-writer');
const { parsePPM } = require('./ppmParser');
const MetricsCalculator = require('./MetricsCalculator');
const DynamicConfigurator = require('./DynamicConfigurator');
const LabConverter = require('@reveal/core/lib/utils/LabConverter');
const chalk = require('chalk');

// Load presets dynamically from reveal-core/presets directory
const { loadPresets } = require('@reveal/core/src/presetLoader');
const PRESETS = loadPresets();

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
 * Calculate image DNA statistics from Lab pixel data
 * Now delegates to LabConverter.generateDNA()
 *
 * @param {Uint8ClampedArray} labPixels - Lab pixel data in byte encoding
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {Object} DNA object with {l, c, k, minL, maxL, maxC}
 */
function calculateImageDNA(labPixels, width, height) {
    return LabConverter.generateDNA(labPixels, width, height, 40);
}

/**
 * Process a single PPM through separation engine
 */
async function processImage(inputPath, intermediatePsdDir, outputDir) {
    const basename = path.basename(inputPath, '.ppm');
    console.log(chalk.cyan(`\n[${basename}] Processing...`));

    const timingStart = Date.now();
    let ioTime = 0;

    try {
        // 1. Parse PPM file
        const ioStart = Date.now();
        const ppm = parsePPM(inputPath);
        const { width, height, pixels } = ppm;
        ioTime += Date.now() - ioStart;
        console.log(`  Size: ${width}×${height}`);

        // 2. Convert RGB to Lab using Reveal's native conversion (keep in memory!)
        console.log(`  Converting RGB to Lab...`);
        const pixelCount = width * height;
        const labPixels = new Uint8ClampedArray(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const r = pixels[i * 3];
            const g = pixels[i * 3 + 1];
            const b = pixels[i * 3 + 2];

            const lab = Reveal.rgbToLab({ r, g, b });  // Pass as object, not separate parameters

            // Store in BYTE ENCODING format (required by PosterizationEngine)
            // Reveal's rgbToLab returns: L: 0-100, a: -128 to +127, b: -128 to +127
            // Convert to byte encoding: L: 0-255, a: 0-255 (128=neutral), b: 0-255 (128=neutral)
            labPixels[i * 3] = (lab.L / 100) * 255;        // L: 0-100 → 0-255
            labPixels[i * 3 + 1] = lab.a + 128;            // a: -128 to +127 → 0-255
            labPixels[i * 3 + 2] = lab.b + 128;            // b: -128 to +127 → 0-255
        }

        // 3. Write intermediate Lab PSD (but keep working with labPixels)
        // TODO: Implement setCompositeImage() method in PSDWriter
        // console.log(`  Writing intermediate Lab PSD...`);
        // For now, skip intermediate PSD - not needed for testing mask fix

        // 3. Calculate image DNA (L, C, K, minL, maxL)
        console.log(`  Calculating image DNA...`);
        const dna = calculateImageDNA(labPixels, width, height);
        dna.filename = basename;  // Add filename for debugging in DynamicConfigurator

        console.log(`  DNA: L=${dna.l}, C=${dna.c}, K=${dna.k}, maxC=${dna.maxC}, range=[${dna.minL}, ${dna.maxL}]`);

        // 4. Generate bespoke configuration using DynamicConfigurator
        const config = DynamicConfigurator.generate(dna);

        console.log(chalk.green(`  ✓ Configuration: "${config.name}"`));
        console.log(`  Colors: ${config.targetColors}, BlackBias: ${config.blackBias}, Dither: ${config.ditherType}`);

        // Convert config to params format expected by posterization engine
        const params = {
            targetColorsSlider: config.targetColors,
            blackBias: config.blackBias,
            ditherType: config.ditherType,
            // Add other necessary parameters with defaults
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

        // 5. Posterize with detected preset
        console.log(`  Posterizing to ${params.targetColorsSlider} colors...`);
        const posterizeResult = await Reveal.posterizeImage(
            labPixels,
            width, height,
            params.targetColorsSlider,
            {
                ...params,
                format: 'lab'  // Tell engine we're passing Lab in byte encoding
            }
        );

        console.log(`  ✓ Generated ${posterizeResult.paletteLab.length} colors`);

        // 6. Separate into layers
        console.log(`  Separating layers...`);
        const separateResult = await Reveal.separateImage(
            labPixels,
            posterizeResult.paletteLab,
            width, height,
            { ditherType: params.ditherType }
        );

        // 7. Generate masks (8-bit, PSDWriter handles 16-bit conversion internally)
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

        // 8. Reconstruct "Virtual Composite" from separated colors for metrics
        console.log(`  Reconstructing virtual composite...`);
        const processedLab = new Uint8ClampedArray(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const colorIdx = separateResult.colorIndices[i];
            const color = posterizeResult.paletteLab[colorIdx];

            // Convert Lab values to byte encoding
            processedLab[i * 3] = (color.L / 100) * 255;        // L: 0-100 → 0-255
            processedLab[i * 3 + 1] = color.a + 128;            // a: -128 to +127 → 0-255
            processedLab[i * 3 + 2] = color.b + 128;            // b: -128 to +127 → 0-255
        }

        // 9. Calculate palette coverage percentages
        const coverageCounts = new Uint32Array(posterizeResult.paletteLab.length);
        for (let i = 0; i < pixelCount; i++) {
            coverageCounts[separateResult.colorIndices[i]]++;
        }

        const paletteWithCoverage = posterizeResult.paletteLab.map((color, idx) => {
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

        // 10. Calculate metrics
        console.log(`  Computing validation metrics...`);
        const layers = masks.map((mask, i) => ({
            name: paletteWithCoverage[i].name,
            color: posterizeResult.paletteLab[i],
            mask: mask
        }));

        const metrics = MetricsCalculator.compute(
            labPixels,      // Original Lab pixels
            processedLab,   // Virtual composite Lab pixels
            layers,
            width,
            height
        );

        // 11. Write 16-bit PSD
        console.log(`  Writing 16-bit PSD...`);
        const ioStartWrite = Date.now();
        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        // Add original image as invisible pixel layer (bottom layer)
        console.log(`  Adding original image as reference layer...`);
        writer.addPixelLayer({
            name: 'Original Image (Reference)',
            pixels: labPixels,
            visible: false
        });

        // Add separated fill+mask layers (top layers)
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
        const outputPath = path.join(outputDir, `${basename}.psd`);
        fs.writeFileSync(outputPath, psdBuffer);
        ioTime += Date.now() - ioStartWrite;

        console.log(chalk.green(`  ✓ Saved: ${outputPath} (${(psdBuffer.length / 1024).toFixed(2)} KB)`));

        // 12. Write JSON sidecar with complete metadata and metrics
        const totalTime = Date.now() - timingStart;
        const computeTime = totalTime - ioTime;

        const jsonData = {
            meta: {
                filename: `${basename}.ppm`,
                timestamp: new Date().toISOString(),
                width: width,
                height: height,
                outputFile: `${basename}.psd`
            },
            dna: dna,  // Store calculated DNA
            configuration: config,  // Store generated configuration
            input_parameters: {
                configType: 'dynamic',  // Mark as dynamically generated
                configId: config.id,
                targetColors: params.targetColorsSlider,
                ...params
            },
            palette: paletteWithCoverage,
            metrics: metrics,
            timing: {
                computeTimeMs: computeTime,
                ioTimeMs: ioTime,
                totalMs: totalTime
            }
        };

        const jsonPath = path.join(outputDir, `${basename}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
        console.log(chalk.gray(`  ✓ Metrics saved: ${basename}.json`));

        return {
            success: true,
            filename: basename,
            configType: 'dynamic',
            configId: config.id,
            colors: posterizeResult.paletteLab.length,
            size: psdBuffer.length,
            width,
            height,
            metrics: metrics
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
    const inputDir = path.join(__dirname, '../data/CQ100_v4/input/ppm');
    const intermediatePsdDir = path.join(__dirname, '../data/CQ100_v4/input/psd');
    const outputDir = path.join(__dirname, '../data/CQ100_v4/output/psd');

    // Ensure directories exist
    if (!fs.existsSync(intermediatePsdDir)) {
        fs.mkdirSync(intermediatePsdDir, { recursive: true });
    }
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Get all PPM files
    const files = fs.readdirSync(inputDir)
        .filter(f => f.endsWith('.ppm'))
        .sort();

    console.log(chalk.bold(`\n🎨 CQ100_v4 Batch Processor`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Input:  ${inputDir}`);
    console.log(`Intermediate: ${intermediatePsdDir}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Files:  ${files.length} images\n`);

    const results = [];
    const startTime = Date.now();

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(inputDir, file);

        console.log(chalk.bold(`\n[${i + 1}/${files.length}] ${file}`));
        const result = await processImage(inputPath, intermediatePsdDir, outputDir);
        results.push(result);
    }

    // Summary report
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

    // Preset distribution
    if (successResults.length > 0) {
        const presetCounts = {};
        successResults.forEach(r => {
            presetCounts[r.presetId] = (presetCounts[r.presetId] || 0) + 1;
        });

        console.log(chalk.bold(`Preset Distribution:`));
        Object.entries(presetCounts)
            .sort((a, b) => b[1] - a[1])
            .forEach(([preset, count]) => {
                console.log(`  ${preset}: ${count} images`);
            });
        console.log();
    }

    // Save detailed results
    const reportPath = path.join(outputDir, 'batch-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        total: files.length,
        success: successResults.length,
        failed: failedResults.length,
        elapsedSeconds: parseFloat(elapsed),
        presetDistribution: successResults.reduce((acc, r) => {
            acc[r.presetId] = (acc[r.presetId] || 0) + 1;
            return acc;
        }, {}),
        results: successResults,
        errors: failedResults.map(r => ({ filename: r.filename, error: r.error }))
    }, null, 2));

    console.log(chalk.green(`✓ Report saved: ${reportPath}\n`));

    if (failedResults.length > 0) {
        console.log(chalk.yellow(`Failed files:`));
        failedResults.forEach(r => {
            console.log(`  - ${r.filename}: ${r.error}`);
        });
        console.log();
    }
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
