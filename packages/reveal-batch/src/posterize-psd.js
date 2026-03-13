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
const Reveal = require('@electrosaur-labs/core');
const { PSDWriter } = require('@electrosaur-labs/psd-writer');
const { readPsd } = require('@electrosaur-labs/psd-reader');
const ParameterGenerator = Reveal.ParameterGenerator;
const MetricsCalculator = require('./MetricsCalculator');
const chalk = require('chalk');
const {
    convert8bitTo16bitLab,
    convertPsd16bitToEngineLab,
    convertPsd16bitTo8bitLab,
    rgbToHex,
    generateThumbnail
} = require('./batch-utils');

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
 * Reconstruct posterized Lab image from color indices in native 16-bit Lab encoding.
 * Photoshop 16-bit Lab: L: 0-32768, a/b: 0-32768 (16384=neutral), big-endian.
 */
function reconstructProcessedLab16(colorIndices, paletteLab, pixelCount) {
    const buf = Buffer.alloc(pixelCount * 6);
    for (let i = 0; i < pixelCount; i++) {
        const color = paletteLab[colorIndices[i]];
        // PSD file format: full 0-65535 range per channel (NOT UXP's 0-32768)
        const L16 = Math.max(0, Math.min(65535, Math.round((color.L / 100) * 65535)));
        const a16 = Math.max(0, Math.min(65535, Math.round((color.a + 128) * 257)));
        const b16 = Math.max(0, Math.min(65535, Math.round((color.b + 128) * 257)));
        buf.writeUInt16BE(L16, i * 6);
        buf.writeUInt16BE(a16, i * 6 + 2);
        buf.writeUInt16BE(b16, i * 6 + 4);
    }
    return buf;
}

/**
 * Pseudo-archetype IDs that use code-only generators instead of JSON archetypes.
 */
const PSEUDO_ARCHETYPES = {
    'chameleon':   dna => Reveal.generateConfigurationMk2(dna),
    'distilled':   dna => Reveal.generateConfigurationDistilled(dna),
    'salamander':  dna => Reveal.generateConfigurationSalamander(dna),
};

/**
 * Process a single Lab PSD (8-bit or 16-bit)
 * @param {string} inputPath - Path to input PSD
 * @param {string} outputDir - Output directory
 * @param {number} expectedBitDepth - 8 or 16
 * @param {Object} [cliOptions] - CLI options
 * @param {string} [cliOptions.archetype] - Archetype ID override (real JSON id or pseudo: chameleon, distilled, salamander)
 */
async function posterizePsd(inputPath, outputDir, expectedBitDepth, cliOptions = {}) {
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
        lab8bit = convertPsd16bitTo8bitLab(labData, pixelCount);
    }

    // 3. Calculate image DNA (canonical DNAGenerator — matches Navigator UI path)
    console.log(`  Calculating image DNA (DNAGenerator on 16-bit Lab)...`);
    const dna = Reveal.DNAGenerator.fromPixels(lab16bit, width, height, { bitDepth: 16 });
    dna.filename = basename;
    dna.bitDepth = depth;

    // Legacy shim fields for downstream consumers (BilateralFilter, MedianFilter, console.log)
    dna.l = dna.global.l;
    dna.c = dna.global.c;
    dna.k = dna.global.k;
    dna.l_std_dev = dna.global.l_std_dev;
    dna.maxC = Math.max(...Object.values(dna.sectors).map(s => s.cMax || 0));

    console.log(`  DNA: L=${dna.global.l}, C=${dna.global.c}, K=${dna.global.k}, StdDev=${dna.global.l_std_dev}, maxC=${dna.maxC}`);

    // 4. Generate configuration
    const archetypeOverride = cliOptions.archetype;
    let config;

    if (archetypeOverride && PSEUDO_ARCHETYPES[archetypeOverride]) {
        // Pseudo-archetype: code-only generator (chameleon, distilled, salamander)
        config = PSEUDO_ARCHETYPES[archetypeOverride](dna);
        config.meta = config.meta || {};
        config.meta.archetypeId = archetypeOverride;
        config.meta.archetype = archetypeOverride;
        config.meta.matchScore = null;
        config.meta.matchBreakdown = null;
        config.meta.matchRanking = [];
        console.log(chalk.green(`  Archetype: ${archetypeOverride} (pseudo — code-only generator)`));
    } else if (archetypeOverride) {
        // Real JSON archetype: manual override via manualArchetypeId
        config = ParameterGenerator.generate(dna, {
            imageData: null,
            width,
            height,
            preprocessingIntensity: 'auto',
            manualArchetypeId: archetypeOverride,
            image: { dna, width, height, bitDepth: depth },
            press: { mesh: 230 }
        });
        console.log(chalk.green(`  Archetype: ${config.meta?.archetype || archetypeOverride} (manual override)`));
    } else {
        // Default: DNA-based auto-match
        config = ParameterGenerator.generate(dna, {
            imageData: null,
            width,
            height,
            preprocessingIntensity: 'auto',
            image: { dna, width, height, bitDepth: depth },
            press: { mesh: 230 }
        });
        console.log(chalk.green(`  Archetype: ${config.meta?.archetype || 'unknown'} (DNA auto-match)`));
    }

    // Apply quantizer override if specified
    if (cliOptions.quantizer) {
        config.quantizer = cliOptions.quantizer;
        console.log(chalk.green(`  Quantizer: ${cliOptions.quantizer} (override)`));
    }

    dna.archetype = config.meta?.archetypeId;
    console.log(`  Colors: ${config.targetColors}, BlackBias: ${config.blackBias || 'n/a'}, Dither: ${config.ditherType || 'none'}`);

    // 4a. Bilateral prefilter (edge-preserving noise reduction)
    // Honor config.preprocessingIntensity: 'off' skips entirely (e.g. Salamander)
    const BilateralFilter = Reveal.BilateralFilter;
    const is16Bit = depth === 16;

    if (config.preprocessingIntensity === 'off') {
        console.log(`  [Preprocess] Skipped — config says preprocessingIntensity='off'`);
    } else {
        const entropyScore = BilateralFilter.calculateEntropyScoreLab(lab16bit, width, height);
        const preprocessDecision = BilateralFilter.shouldPreprocess(dna, entropyScore, is16Bit);

        if (preprocessDecision.shouldProcess) {
            console.log(chalk.yellow(`  ⚡ Bilateral filter: entropy=${entropyScore.toFixed(1)}, radius=${preprocessDecision.radius}, sigmaR=${preprocessDecision.sigmaR}`));
            console.log(chalk.yellow(`     Reason: ${preprocessDecision.reason}`));
            BilateralFilter.applyBilateralFilterLab(
                lab16bit, width, height,
                preprocessDecision.radius,
                preprocessDecision.sigmaR
            );
        } else {
            console.log(`  [Preprocess] Skipped — entropy=${entropyScore.toFixed(1)}, reason=${preprocessDecision.reason}`);
        }
    }

    // 4b. Pre-posterization median filter (salt & pepper noise removal)
    const MedianFilter = Reveal.MedianFilter;
    if (MedianFilter.shouldApply(dna, config)) {
        console.log(chalk.yellow(`  🧂 Median filter: removing sensor salt before posterization`));
        lab16bit = MedianFilter.apply3x3(lab16bit, width, height);
    }

    // 5. Prepare params via centralized config bridge
    const params = ParameterGenerator.toEngineOptions(config, {
        bitDepth: depth
    });

    // 6. Posterize
    console.log(`  Posterizing to ${params.targetColorsSlider} colors...`);
    const posterizeResult = await Reveal.posterizeImage(
        lab16bit,
        width, height,
        params.targetColorsSlider,
        params
    );

    console.log(`  Generated ${posterizeResult.paletteLab.length} colors`);

    // 7. Map pixels to palette (initial assignment)
    console.log(`  Mapping pixels to palette...`);
    const SeparationEngine = Reveal.engines.SeparationEngine;

    let colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
        lab16bit,
        posterizeResult.paletteLab,
        null,  // onProgress
        width,
        height,
        {
            ditherType: config.ditherType,
            distanceMetric: config.distanceMetric
        }
    );

    let finalPaletteLab = posterizeResult.paletteLab;
    let finalPaletteRgb = posterizeResult.palette;

    // 7.5. Palette Post-Pruning (Sovereign Solution)
    if (config.minVolume !== undefined && config.minVolume > 0) {
        console.log(chalk.yellow(`  🗑️ Palette pruning: minVolume=${config.minVolume}%`));
        const pruneResult = SeparationEngine.pruneWeakColors(
            finalPaletteLab,
            colorIndices,
            width,
            height,
            config.minVolume,
            { distanceMetric: config.distanceMetric }
        );

        if (pruneResult.mergedCount > 0) {
            finalPaletteLab = pruneResult.prunedPalette;
            colorIndices = pruneResult.remappedIndices;

            // Build pruned RGB palette by filtering original palette using strong indices
            const LabEnc = Reveal.LabEncoding;
            finalPaletteRgb = finalPaletteLab.map(lab => LabEnc.labToRgb(lab));

            console.log(chalk.green(`  ✅ Pruned: ${posterizeResult.paletteLab.length} → ${finalPaletteLab.length} colors`));
        }
    }

    // 8. Build masks and apply knobs (MechanicalKnobs — same algorithms as Navigator/ProductionWorker)
    console.log(`  Creating layer masks...`);
    const MechanicalKnobs = Reveal.MechanicalKnobs;
    const masks = MechanicalKnobs.rebuildMasks(colorIndices, finalPaletteLab.length, pixelCount);

    if (config.speckleRescue !== undefined && config.speckleRescue > 0) {
        console.log(chalk.yellow(`  🧹 speckleRescue=${config.speckleRescue}px`));
        MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, config.speckleRescue);
    }

    // NOTE: shadowClamp is a no-op on binary masks (all values are 0 or 255).
    // The old inline code (`if mask[i] > 0 && mask[i] < threshold`) never triggered.
    // MechanicalKnobs.applyShadowClamp does connectivity erosion which is designed
    // for the Navigator's tonal pipeline, not batch binary masks. Skip it here.

    // Generate hex colors for display
    const hexColors = finalPaletteRgb.map(rgb => rgbToHex(rgb.r, rgb.g, rgb.b));

    // Build layer objects (mimicking separateImage output)
    const layers = hexColors.map((hex, idx) => ({
        name: `Ink ${idx + 1} (${hex})`,
        labColor: finalPaletteLab[idx],
        hex: hex,
        mask: masks[idx]
    }));

    console.log(`  Generated ${layers.length} layers`);

    // Extract data for compatibility with existing code
    const filteredMasks = layers.map(layer => layer.mask);
    const filteredPaletteLab = layers.map(layer => layer.labColor);
    const filteredPaletteRgb = finalPaletteRgb;
    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
        const mask = layers[layerIdx].mask;
        for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
            if (mask[pixelIdx] === 255) {
                colorIndices[pixelIdx] = layerIdx;
            }
        }
    }

    // 8b. Edge survival — structural fidelity (needs lab16bit before release)
    const RevelationError = Reveal.RevelationError;
    const edgeResult = RevelationError.edgeSurvival16(
        lab16bit, colorIndices, width, height
    );

    // Release lab16bit - no longer needed after separation
    lab16bit = null;

    // 9. Calculate validation metrics (using filtered colors)
    console.log(`  Computing validation metrics...`);
    let processedLab = reconstructProcessedLab(
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
        { targetColors: params.targetColorsSlider }
    );

    // Inject edge survival into metrics (matches ProxyEngine/ScoringManager flow)
    metrics.feature_preservation.edgeSurvival = edgeResult.edgeSurvival;
    metrics.feature_preservation.significantEdges = edgeResult.significantEdges;
    metrics.feature_preservation.survivedEdges = edgeResult.survivedEdges;

    console.log(`  DeltaE: avg=${metrics.global_fidelity.avgDeltaE}, max=${metrics.global_fidelity.maxDeltaE}`);
    console.log(`  Edge Survival: ${(edgeResult.edgeSurvival * 100).toFixed(1)}% (${edgeResult.survivedEdges}/${edgeResult.significantEdges} edges)`);
    console.log(`  Revelation Score: ${metrics.feature_preservation.revelationScore}`);
    console.log(`  Integrity: ${metrics.physical_feasibility.integrityScore}%`);

    // 9b. DNA Fidelity — closed-loop posterization audit
    console.log(`  Computing DNA fidelity...`);
    const outputDNA = Reveal.DNAGenerator.fromIndices(colorIndices, filteredPaletteLab, width, height);
    const dnaFidelity = Reveal.DNAFidelity.compare(dna, outputDNA);
    const fidelityAlerts = dnaFidelity.alerts.length > 0 ? ` ⚠ ${dnaFidelity.alerts.join(', ')}` : '';
    console.log(`  DNA Fidelity: ${dnaFidelity.fidelity}, Sector Drift: ${dnaFidelity.sectorDrift.toFixed(2)}${fidelityAlerts}`);

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

    // === Release metrics data before PSD write (no longer needed) ===
    // colorIndices, layersForMetrics, originalLabClamped are done
    colorIndices = null;

    // 12. Write output PSD (match input bit depth)
    console.log(`  Writing ${depth}-bit PSD...`);
    const outputPsdPath = path.join(outputDir, `${basename}.psd`);
    const writer = new PSDWriter({
        width,
        height,
        colorMode: 'lab',
        bitsPerChannel: depth,
        compression: 'none',
        documentName: basename
    });

    // Generate thumbnail BEFORE adding layers (uses processedLab which we free after)
    console.log(`  Generating thumbnail + composite for QuickLook...`);
    const thumbnail = await generateThumbnail(processedLab, width, height);
    writer.setThumbnail(thumbnail);
    writer.setComposite(processedLab);  // Writer takes reference, no copy needed
    processedLab = null; // Free — writer has the reference now

    // Add original as invisible reference layer
    writer.addPixelLayer({
        name: 'Original Image (Reference)',
        pixels: lab8bit,
        visible: false
    });
    lab8bit = null; // Free — writer has the reference now

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

    // Add fill+mask layers (writer takes mask by reference)
    for (let li = 0; li < layersToWrite.length; li++) {
        const layer = layersToWrite[li];
        const hex = rgbToHex(layer.rgb.r, layer.rgb.g, layer.rgb.b);
        const aSign = layer.color.a >= 0 ? '+' : '';
        const bSign = layer.color.b >= 0 ? '+' : '';
        writer.addFillLayer({
            name: `[${li + 1}] ${hex} L${Math.round(layer.color.L)} a${aSign}${Math.round(layer.color.a)} b${bSign}${Math.round(layer.color.b)}`,
            color: layer.color,
            mask: layer.mask
        });
    }
    // Free masks array — writer has references to individual masks
    filteredMasks.length = 0;

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
        archetype: {
            id: config.meta.archetypeId,
            name: config.meta.archetype,
            score: config.meta.matchScore,
            breakdown: config.meta.matchBreakdown
        },
        deltaE: metrics.global_fidelity.avgDeltaE,
        dnaFidelity: {
            fidelity: dnaFidelity.fidelity,
            sectorDrift: dnaFidelity.sectorDrift,
            alerts: dnaFidelity.alerts,
            global: dnaFidelity.global
        },
        ranking: (config.meta.matchRanking || []).map(m => ({
            id: m.id,
            score: m.score,
            breakdown: m.breakdown
        })),
        dna,
        outputDna: outputDNA,
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
    // masks.length = 0; // TODO: masks not defined, cleanup if needed
    layersToWrite.length = 0;
    // psdBuffer is already written and goes out of scope

    return {
        success: true,
        filename: basename,
        colors: palette.length,
        dna: dna,
        metrics: metrics,
        dnaFidelity: {
            fidelity: dnaFidelity.fidelity,
            sectorDrift: dnaFidelity.sectorDrift,
            alerts: dnaFidelity.alerts
        }
    };
}

// Main CLI
async function main() {
    const args = process.argv.slice(2);

    // Parse --archetype flag from anywhere in args
    let archetype = null;
    const positionalArgs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--archetype' && i + 1 < args.length) {
            archetype = args[i + 1];
            i++; // skip value
        } else if (args[i].startsWith('--archetype=')) {
            archetype = args[i].split('=')[1];
        } else {
            positionalArgs.push(args[i]);
        }
    }

    if (positionalArgs.length < 3) {
        console.log(chalk.bold(`\nUsage: node posterize-psd.js <bitDepth> <inputPSD> <outputDir> [--archetype <id>]`));
        console.log(`\n  bitDepth:    8 or 16 (expected bit depth of input file)`);
        console.log(`  inputPSD:    Path to input Lab PSD file`);
        console.log(`  outputDir:   Directory for output PSD and JSON files`);
        console.log(`  --archetype: Optional archetype override. Accepts:`);
        console.log(`               Pseudo-archetypes: chameleon, distilled, salamander`);
        console.log(`               Real archetypes:   warm_photo, fine_art_scan, etc.`);
        console.log(`\nExamples:`);
        console.log(`  node posterize-psd.js 16 ./input/image.psd ./output`);
        console.log(`  node posterize-psd.js 16 ./input/image.psd ./output --archetype salamander\n`);
        process.exit(1);
    }

    const [bitDepthArg, inputPath, outputDir] = positionalArgs;
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
    if (archetype) {
        console.log(`Archetype: ${archetype} (override)`);
    }

    try {
        const result = await posterizePsd(inputPath, outputDir, bitDepth, { archetype });
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
