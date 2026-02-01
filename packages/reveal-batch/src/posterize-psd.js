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
const MetricsCalculator = require('./MetricsCalculator');
const chalk = require('chalk');

// Import Rich DNA v2.0 generator and archetype-based configuration
const { DNAGenerator, ParameterGenerator } = Reveal;

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
 * Process a single Lab PSD (8-bit or 16-bit)
 */
async function posterizePsd(inputPath, outputDir, expectedBitDepth) {
    const basename = path.basename(inputPath, '.psd');
    console.log(chalk.cyan(`\nProcessing: ${basename}`));

    const timingStart = Date.now();

    // 1. Read Lab PSD (with thumbnail extraction)
    const buffer = fs.readFileSync(inputPath);
    const psd = readPsd(buffer);
    const { width, height, depth, data: labData, thumbnail } = psd;
    const pixelCount = width * height;

    if (thumbnail) {
        console.log(`  Thumbnail: ${thumbnail.width}×${thumbnail.height} (${thumbnail.jpegData.length} bytes)`);
    } else {
        console.log(chalk.yellow(`  Warning: No thumbnail found in input PSD`));
    }

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

    // 3. Generate Rich DNA v2.0 (with sectors, neutral metrics, and spatial complexity)
    console.log(`  Generating Rich DNA v2.0...`);
    const dna = DNAGenerator.generate(lab8bit, width, height, 40, {
        richDNA: true,
        spatialMetrics: true  // Include entropy, edge density, complexity score
    });
    dna.filename = basename;
    dna.bitDepth = depth;

    // Log DNA summary
    console.log(`  DNA v2.0: L=${dna.global.l}, C=${dna.global.c}, K=${dna.global.k}, Neutral=${(dna.global.neutralWeight * 100).toFixed(1)}%`);

    // Log dominant sectors
    const dominantSectors = Object.entries(dna.sectors)
        .filter(([_, s]) => s.weight > 0.10)
        .sort((a, b) => b[1].weight - a[1].weight)
        .slice(0, 3);

    if (dominantSectors.length > 0) {
        console.log(`  Dominant sectors: ${dominantSectors.map(([name, s]) => `${name}(${(s.weight * 100).toFixed(0)}%)`).join(', ')}`);
    }

    // 4. Load archetypes and generate configuration (DNA-driven constraints)
    console.log(`  Loading archetypes...`);
    const archetypes = ParameterGenerator.loadArchetypes();

    if (!archetypes) {
        throw new Error('Failed to load archetypes - ensure @reveal/core archetypes directory exists');
    }

    console.log(`  Generating archetype-based configuration...`);
    const config = ParameterGenerator.generateFromArchetypes(dna, archetypes, {
        targetColorsSlider: 8,  // User preference for number of colors
        bitDepth: depth
    });

    console.log(chalk.green(`  Archetype: ${config.selectedArchetype}`));
    console.log(`  Colors: ${config.targetColorsSlider}, BlackBias: ${config.blackBias}, Dither: ${config.ditherType}`);

    // Log activated constraints
    if (config.activatedConstraints && config.activatedConstraints.length > 0) {
        console.log(`  Activated constraints: ${config.activatedConstraints.join(', ')}`);
    }

    // 5. Posterize with archetype-based config + DNA for constraint evaluation
    console.log(`  Posterizing to ${config.targetColorsSlider} colors...`);
    const posterizeResult = await Reveal.posterizeImage(
        lab16bit,
        width, height,
        config.targetColorsSlider,
        {
            ...config,  // Use all archetype-based parameters
            dna: dna,   // Pass DNA for constraint evaluation (enables Dynamic Hue Anchoring, Neutral Gravity, etc.)
            format: 'lab',
            bitDepth: 8
        }
    );

    console.log(`  Generated ${posterizeResult.paletteLab.length} colors`);

    // 7. Separate into layers (using high-level API that handles mask generation and filtering)
    // This matches the UI flow which calls SeparationEngine.separateImage() directly
    console.log(`  Separating layers...`);

    // Import SeparationEngine for the high-level API
    const SeparationEngine = Reveal.engines.SeparationEngine;

    // Generate hex colors for display
    const hexColors = posterizeResult.palette.map(rgb =>
        rgbToHex(rgb.r, rgb.g, rgb.b)
    );

    // Call the same high-level API as the UI
    // This automatically generates masks AND filters out layers with < 0.1% coverage
    const layers = await SeparationEngine.separateImage(
        lab16bit,
        width,
        height,
        hexColors,                    // Hex colors for display
        null,                         // Unused parameter
        posterizeResult.paletteLab,   // Lab palette
        {
            ditherType: config.ditherType,
            distanceMetric: config.distanceMetric || 'cie76'
        }
    );

    console.log(`  Generated ${layers.length} layers (${posterizeResult.paletteLab.length - layers.length} empty layers filtered out)`);

    // Extract filtered data from layer objects
    const filteredMasks = layers.map(layer => layer.mask);
    const filteredPaletteLab = layers.map(layer => layer.labColor);
    const filteredPaletteRgb = layers.map(layer => {
        // Parse hex back to RGB (layers only have hex, not RGB objects)
        const hex = layer.hex;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return { r, g, b };
    });

    // Reconstruct colorIndices from layer masks (for metrics calculation)
    // Each mask tells us which pixels belong to that color
    const colorIndices = new Uint8Array(pixelCount);
    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
        const mask = layers[layerIdx].mask;
        for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
            if (mask[pixelIdx] === 255) {
                colorIndices[pixelIdx] = layerIdx;
            }
        }
    }

    // Release lab16bit - no longer needed after separation
    lab16bit = null;

    // 9. Calculate validation metrics (using filtered colors)
    console.log(`  Computing validation metrics...`);
    const processedLab = reconstructProcessedLab(
        colorIndices,
        filteredPaletteLab, // Use filtered palette (matches layers)
        pixelCount
    );

    // Create layers array for MetricsCalculator (already have layer objects)
    const layersForMetrics = layers.map((layer, idx) => ({
        name: layer.name,
        color: layer.labColor,
        mask: layer.mask
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
        { targetColors: config.targetColorsSlider }
    );

    console.log(`  DeltaE: avg=${metrics.global_fidelity.avgDeltaE}, max=${metrics.global_fidelity.maxDeltaE}`);
    console.log(`  Revelation Score: ${metrics.feature_preservation.revelationScore}`);
    console.log(`  Integrity: ${metrics.physical_feasibility.integrityScore}%`);

    // 10. Calculate coverage (colorIndices already map to filtered palette)
    const coverageCounts = new Uint32Array(filteredPaletteLab.length);
    for (let i = 0; i < pixelCount; i++) {
        coverageCounts[colorIndices[i]]++;
    }

    const palette = filteredPaletteLab.map((color, idx) => {
        const rgbColor = filteredPaletteRgb[idx];
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

    // Sort layers by lightness (light to dark) for proper print stacking (using filtered data)
    const layersToWrite = filteredPaletteLab.map((color, i) => ({
        index: i,
        color: color,
        rgb: filteredPaletteRgb[i],
        mask: filteredMasks[i],
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

    // Preserve thumbnail from input PSD (for Finder/Bridge icon previews)
    if (thumbnail) {
        console.log(`  Preserving thumbnail: ${thumbnail.width}×${thumbnail.height}`);
        writer.setThumbnail({
            jpegData: thumbnail.jpegData,
            width: thumbnail.width,
            height: thumbnail.height
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
