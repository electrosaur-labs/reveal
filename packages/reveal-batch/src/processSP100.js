/**
 * SP-100 Dataset Processor
 *
 * Lab PSD → Separated PSD Processor
 *
 * Input:  data/SP100/input/{source}/psd/*.psd (16-bit Lab composite images)
 * Output: data/SP100/output/{source}/*.psd (separated multi-layer PSDs)
 *         data/SP100/output/{source}/*.json (metrics sidecar files)
 *
 * Usage: node src/processSP100.js [source]
 *   source: 'loc', 'wikiart', or 'all' (default: 'all')
 */

const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const { PSDWriter } = require('@reveal/psd-writer');
const { readPsd } = require('@reveal/psd-reader');
const MetricsCalculator = require('./MetricsCalculator');
const DynamicConfigurator = require('./DynamicConfigurator');
const LabConverter = require('@reveal/core/lib/utils/LabConverter');
const chalk = require('chalk');

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
 */
function calculateImageDNA(labPixels, width, height) {
    return LabConverter.generateDNA(labPixels, width, height, 40);
}

/**
 * Process a single PSD image through separation engine
 */
async function processImage(inputPath, outputDir, sourceTag) {
    const ext = path.extname(inputPath);
    const basename = path.basename(inputPath, ext);
    console.log(chalk.cyan(`\n[${basename}] Processing...`));

    const timingStart = Date.now();
    let ioTime = 0;

    try {
        // 1. Read Lab PSD with reveal-psd-reader
        const ioStart = Date.now();
        const inputPsdBuffer = fs.readFileSync(inputPath);
        const psd = readPsd(inputPsdBuffer);
        const { width, height, data: labPixels } = psd;
        ioTime += Date.now() - ioStart;

        console.log(`  Size: ${width}×${height} (${psd.depth}-bit Lab)`);

        const pixelCount = width * height;

        // 2. Calculate image DNA
        console.log(`  Calculating image DNA...`);
        const dna = calculateImageDNA(labPixels, width, height);
        dna.filename = basename;

        console.log(`  DNA: L=${dna.l.toFixed(1)}, C=${dna.c.toFixed(1)}, K=${dna.k.toFixed(1)}, StdDev=${dna.l_std_dev?.toFixed(1) || '?'}, maxC=${dna.maxC.toFixed(1)}`);

        // 3. Generate configuration using DynamicConfigurator v1.7
        const config = DynamicConfigurator.generate(dna);

        console.log(chalk.green(`  ✓ Archetype: ${config.meta?.archetype || 'unknown'}`));
        console.log(`  Colors: ${config.targetColors}, BlackBias: ${config.blackBias}, Dither: ${config.ditherType}`);

        // 4. Convert config to params format
        // Mesh settings: 0 = pixel-level (batch default), non-zero = mesh TPI
        // PPI would come from input file metadata if available
        const meshTPI = 0;  // Pixel-level dithering for batch (finest detail)
        const ppi = 300;    // Default assumption for high-res museum images

        const params = {
            targetColorsSlider: config.targetColors,
            blackBias: config.blackBias,
            ditherType: config.ditherType,
            mesh: meshTPI,
            ppi: ppi,
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

        // 5. Posterize
        console.log(`  Posterizing to ${params.targetColorsSlider} colors...`);
        const posterizeResult = await Reveal.posterizeImage(
            labPixels,
            width, height,
            params.targetColorsSlider,
            {
                ...params,
                format: 'lab'
            }
        );

        console.log(`  ✓ Generated ${posterizeResult.paletteLab.length} colors`);

        // 6. Separate into layers
        console.log(`  Separating layers...`);
        const separateResult = await Reveal.separateImage(
            labPixels,
            posterizeResult.paletteLab,
            width, height,
            {
                ditherType: params.ditherType,
                mesh: params.mesh,
                ppi: params.ppi
            }
        );

        // 7. Generate masks
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

        // 8. Reconstruct virtual composite for metrics
        console.log(`  Reconstructing virtual composite...`);
        const processedLab = new Uint8ClampedArray(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const colorIdx = separateResult.colorIndices[i];
            const color = posterizeResult.paletteLab[colorIdx];

            processedLab[i * 3] = (color.L / 100) * 255;
            processedLab[i * 3 + 1] = color.a + 128;
            processedLab[i * 3 + 2] = color.b + 128;
        }

        // 9. Calculate palette coverage
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
            labPixels,
            processedLab,
            layers,
            width,
            height
        );

        // 11. Write output 16-bit PSD
        console.log(`  Writing 16-bit PSD...`);
        const ioStartWrite = Date.now();
        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        // Add original as reference layer
        writer.addPixelLayer({
            name: 'Original Image (Reference)',
            pixels: labPixels,
            visible: false
        });

        // Sort layers: Light to Dark
        const layersToWrite = posterizeResult.paletteLab.map((color, i) => ({
            index: i,
            color: color,
            rgbColor: posterizeResult.palette[i],
            mask: masks[i],
            coverage: (coverageCounts[i] / pixelCount) * 100
        }));

        layersToWrite.sort((a, b) => b.color.L - a.color.L);

        console.log(`  Layer order (bottom→top):`);
        layersToWrite.forEach((layer, idx) => {
            const hex = rgbToHex(layer.rgbColor.r, layer.rgbColor.g, layer.rgbColor.b);
            console.log(`    ${idx + 1}. Color ${layer.index + 1} (${hex}) - L=${layer.color.L.toFixed(1)}, Coverage=${layer.coverage.toFixed(2)}%`);
        });

        // Add fill+mask layers
        for (const layer of layersToWrite) {
            const hex = rgbToHex(layer.rgbColor.r, layer.rgbColor.g, layer.rgbColor.b);

            writer.addFillLayer({
                name: `Color ${layer.index + 1} (${hex})`,
                color: layer.color,
                mask: layer.mask
            });
        }

        const psdBuffer = writer.write();
        const outputPath = path.join(outputDir, `${basename}.psd`);
        fs.writeFileSync(outputPath, psdBuffer);
        ioTime += Date.now() - ioStartWrite;

        console.log(chalk.green(`  ✓ Saved: ${outputPath} (${(psdBuffer.length / 1024).toFixed(2)} KB)`));

        // 12. Write JSON sidecar
        const totalTime = Date.now() - timingStart;
        const computeTime = totalTime - ioTime;

        const jsonData = {
            meta: {
                filename: path.basename(inputPath),
                source: sourceTag,
                timestamp: new Date().toISOString(),
                width: width,
                height: height,
                outputFile: `${basename}.psd`
            },
            dna: dna,
            configuration: config,
            input_parameters: {
                configType: 'dynamic',
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
            source: sourceTag,
            archetype: config.meta?.archetype || 'unknown',
            configId: config.id,
            colors: posterizeResult.paletteLab.length,
            size: psdBuffer.length,
            width,
            height,
            metrics: metrics
        };
    } catch (error) {
        console.error(chalk.red(`  ✗ Error: ${error.message}`));
        console.error(error.stack);
        return {
            success: false,
            filename: basename,
            source: sourceTag,
            error: error.message
        };
    }
}

/**
 * Process a single source directory
 *
 * Structure:
 *   input/{source}/psd/*.psd   - 16-bit Lab composite PSDs (input)
 *   output/{source}/*.psd      - separated output PSDs
 *   output/{source}/*.json     - metrics sidecar files
 */
async function processSource(sourceDir, sourceName, baseDir) {
    const inputDir = path.join(sourceDir, 'psd');
    const outputDir = path.join(baseDir, 'output', sourceName, 'psd');

    // Ensure directories exist
    if (!fs.existsSync(inputDir)) {
        console.log(chalk.yellow(`Input directory not found: ${inputDir}`));
        return [];
    }
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Get all PSD files from psd subdirectory
    const files = fs.readdirSync(inputDir)
        .filter(f => /\.psd$/i.test(f))
        .sort();

    if (files.length === 0) {
        console.log(chalk.yellow(`No PSD files found in ${inputDir}`));
        return [];
    }

    console.log(chalk.bold(`\n📁 Processing ${sourceName.toUpperCase()}`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(`Input:  ${inputDir}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Files:  ${files.length} PSDs\n`);

    const results = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(inputDir, file);

        console.log(chalk.bold(`\n[${i + 1}/${files.length}] ${file}`));
        const result = await processImage(inputPath, outputDir, sourceName);
        results.push(result);
    }

    return results;
}

/**
 * Main batch processing
 */
async function main() {
    const sourceArg = process.argv[2] || 'all';
    const baseDir = path.join(__dirname, '../data/SP100');
    const inputBaseDir = path.join(baseDir, 'input');

    console.log(chalk.bold(`\n🎨 SP-100 Dataset Processor`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));

    // Get source directories
    let sources = [];
    if (sourceArg === 'all') {
        sources = fs.readdirSync(inputBaseDir)
            .filter(f => fs.statSync(path.join(inputBaseDir, f)).isDirectory())
            .filter(f => f !== 'psd'); // Exclude any top-level psd dir
    } else {
        sources = [sourceArg];
    }

    console.log(`Sources to process: ${sources.join(', ')}`);

    const allResults = [];
    const startTime = Date.now();

    for (const source of sources) {
        const sourceDir = path.join(inputBaseDir, source);
        if (!fs.existsSync(sourceDir)) {
            console.log(chalk.yellow(`Source directory not found: ${sourceDir}`));
            continue;
        }

        const results = await processSource(sourceDir, source, baseDir);
        allResults.push(...results);
    }

    // Summary report
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successResults = allResults.filter(r => r.success);
    const failedResults = allResults.filter(r => !r.success);

    console.log(chalk.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(chalk.bold(`📊 SUMMARY`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Total:     ${allResults.length} images`);
    console.log(chalk.green(`Success:   ${successResults.length}`));
    console.log(chalk.red(`Failed:    ${failedResults.length}`));
    console.log(`Time:      ${elapsed}s`);
    if (allResults.length > 0) {
        console.log(`Avg:       ${(elapsed / allResults.length).toFixed(2)}s per image\n`);
    }

    // Source distribution
    if (successResults.length > 0) {
        const sourceCounts = {};
        successResults.forEach(r => {
            sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1;
        });

        console.log(chalk.bold(`Source Distribution:`));
        Object.entries(sourceCounts).forEach(([source, count]) => {
            console.log(`  ${source}: ${count} images`);
        });
        console.log();

        // Color distribution
        const colorCounts = {};
        successResults.forEach(r => {
            colorCounts[r.colors] = (colorCounts[r.colors] || 0) + 1;
        });

        console.log(chalk.bold(`Color Count Distribution:`));
        Object.entries(colorCounts)
            .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
            .forEach(([colors, count]) => {
                const pct = ((count / successResults.length) * 100).toFixed(1);
                console.log(`  ${colors} colors: ${count} images (${pct}%)`);
            });
        console.log();
    }

    // Save report
    const reportPath = path.join(baseDir, 'output', 'batch-report.json');
    if (!fs.existsSync(path.dirname(reportPath))) {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    }

    fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        sources: sources,
        total: allResults.length,
        success: successResults.length,
        failed: failedResults.length,
        elapsedSeconds: parseFloat(elapsed),
        sourceDistribution: successResults.reduce((acc, r) => {
            acc[r.source] = (acc[r.source] || 0) + 1;
            return acc;
        }, {}),
        colorDistribution: successResults.reduce((acc, r) => {
            acc[r.colors] = (acc[r.colors] || 0) + 1;
            return acc;
        }, {}),
        results: successResults,
        errors: failedResults.map(r => ({ filename: r.filename, source: r.source, error: r.error }))
    }, null, 2));

    console.log(chalk.green(`✓ Report saved: ${reportPath}\n`));

    if (failedResults.length > 0) {
        console.log(chalk.yellow(`Failed files:`));
        failedResults.forEach(r => {
            console.log(`  - [${r.source}] ${r.filename}: ${r.error}`);
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

module.exports = { processImage, processSource };
