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
const ParameterGenerator = Reveal.ParameterGenerator;
const MetricsCalculator = require('./MetricsCalculator');
const chalk = require('chalk');
const {
    convert8bitTo16bitLab,
    convertPsd16bitToEngineLab,
    convertPsd16bitTo8bitLab,
    rgbToHex
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
 * Calculate image DNA v2.0 from 8-bit Lab data
 * Returns comprehensive DNA metrics including 12-sector hue analysis
 *
 * DNA v2.0 Structure:
 * - version: "2.0"
 * - global: L/C/K metrics + derived hue values
 * - sectors: Per-sector weight, cMean, cMax, lMean for all 12 hue sectors
 * - legacy fields: Preserved for backward compatibility
 */
function calculateImageDNA(lab8bit, width, height, sampleStep = 40) {
    const pixelCount = width * height;
    const CHROMA_THRESHOLD = 5; // Minimum chroma to count for hue analysis

    // 12 hue sectors (30° each)
    const SECTORS = [
        'red', 'orange', 'yellow', 'chartreuse',
        'green', 'cyan', 'azure', 'blue',
        'purple', 'magenta', 'pink', 'rose'
    ];

    // Global metrics
    let sumL = 0, sumC = 0;
    let minL = 100, maxL = 0, maxC = 0;
    let sampleCount = 0;
    let lowChromaCount = 0;
    const lValues = [];

    // Per-sector data
    const sectorData = {};
    SECTORS.forEach(sector => {
        sectorData[sector] = {
            count: 0,
            sumC: 0,
            sumL: 0,
            maxC: 0,
            pixels: []
        };
    });

    let warmCount = 0;  // Red, orange, yellow (0-90°)
    let coolCount = 0;  // Cyan, azure, blue, purple (150-270°)
    let chromaPixelCount = 0;  // Pixels with C > threshold

    // Sample pixels
    for (let i = 0; i < pixelCount; i += sampleStep) {
        // Convert 8-bit to perceptual
        const L = (lab8bit[i * 3] / 255) * 100;
        const a = lab8bit[i * 3 + 1] - 128;
        const b = lab8bit[i * 3 + 2] - 128;
        const C = Math.sqrt(a * a + b * b);

        // Global metrics
        sumL += L;
        sumC += C;
        lValues.push(L);
        if (L < minL) minL = L;
        if (L > maxL) maxL = L;
        if (C > maxC) maxC = C;
        if (C < 15) lowChromaCount++;
        sampleCount++;

        // Hue sector analysis (only for chromatic pixels)
        if (C > CHROMA_THRESHOLD) {
            chromaPixelCount++;

            // Calculate hue angle (0-360°)
            let hue = Math.atan2(b, a) * (180 / Math.PI);
            if (hue < 0) hue += 360;

            // Determine sector (12 sectors of 30° each)
            const sectorIndex = Math.floor(hue / 30) % 12;
            const sector = SECTORS[sectorIndex];

            // Update sector data
            sectorData[sector].count++;
            sectorData[sector].sumC += C;
            sectorData[sector].sumL += L;
            if (C > sectorData[sector].maxC) sectorData[sector].maxC = C;

            // Warm/cool classification
            if (hue >= 0 && hue < 90) warmCount++;        // Red, orange, yellow
            else if (hue >= 150 && hue < 270) coolCount++; // Cyan, azure, blue, purple
        }
    }

    // Calculate global averages
    const avgL = sumL / sampleCount;
    const avgC = sumC / sampleCount;
    const lVariance = lValues.reduce((sum, l) => sum + Math.pow(l - avgL, 2), 0) / sampleCount;
    const lStdDev = Math.sqrt(lVariance);
    const lowChromaDensity = lowChromaCount / sampleCount;

    // Process sector data into final structure
    const sectors = {};
    let dominantSector = null;
    let dominantWeight = 0;
    let hueWeights = [];

    SECTORS.forEach(sector => {
        const data = sectorData[sector];
        const weight = chromaPixelCount > 0 ? data.count / chromaPixelCount : 0;

        sectors[sector] = {
            weight: parseFloat(weight.toFixed(4)),
            cMean: data.count > 0 ? parseFloat((data.sumC / data.count).toFixed(1)) : 0,
            cMax: parseFloat(data.maxC.toFixed(1)),
            lMean: data.count > 0 ? parseFloat((data.sumL / data.count).toFixed(1)) : 0
        };

        // Track dominant sector
        if (weight > dominantWeight) {
            dominantWeight = weight;
            dominantSector = sector;
        }

        // Collect weights for entropy calculation
        if (weight > 0) hueWeights.push(weight);
    });

    // Calculate hue entropy (Shannon entropy normalized 0-1)
    let hueEntropy = 0;
    if (hueWeights.length > 0) {
        const maxEntropy = Math.log2(12); // Maximum entropy for 12 sectors
        hueEntropy = -hueWeights.reduce((sum, w) => sum + w * Math.log2(w), 0) / maxEntropy;
    }

    // Calculate warm/cool metrics
    const warmCoolRatio = chromaPixelCount > 0
        ? parseFloat((warmCount / (warmCount + coolCount)).toFixed(3))
        : 0.5;

    // Temperature bias: (W-C)/(W+C) scale from -1 (pure cool) to +1 (pure warm)
    const temperatureBias = (warmCount + coolCount) > 0
        ? parseFloat(((warmCount - coolCount) / (warmCount + coolCount)).toFixed(3))
        : 0;

    // Return DNA v2.0 structure with global object (matches ArchetypeLoader expectations)
    return {
        // Version marker
        version: "2.0",

        // Global metrics (7D core + extended)
        global: {
            l: parseFloat(avgL.toFixed(1)),
            c: parseFloat(avgC.toFixed(1)),
            k: parseFloat((maxL - minL).toFixed(1)),
            l_std_dev: parseFloat(lStdDev.toFixed(1)),
            hue_entropy: parseFloat(hueEntropy.toFixed(3)),
            temperature_bias: temperatureBias,
            primary_sector_weight: parseFloat(dominantWeight.toFixed(4)),

            // Extended metrics (for backward compatibility and analysis)
            minL: parseFloat(minL.toFixed(1)),
            maxL: parseFloat(maxL.toFixed(1)),
            maxC: parseFloat(maxC.toFixed(1)),
            lowChromaDensity: parseFloat(lowChromaDensity.toFixed(3)),
            warm_cool_ratio: warmCoolRatio
        },

        // Dominant hue sector
        dominant_sector: dominantSector || 'none',

        // Per-sector chromatic fingerprint (12 hue sectors)
        sectors: sectors,

        // Legacy fields (for backward compatibility with DNA v1.0 code)
        l: parseFloat(avgL.toFixed(1)),
        c: parseFloat(avgC.toFixed(1)),
        k: parseFloat((maxL - minL).toFixed(1)),
        l_std_dev: parseFloat(lStdDev.toFixed(1)),
        minL: parseFloat(minL.toFixed(1)),
        maxL: parseFloat(maxL.toFixed(1)),
        maxC: parseFloat(maxC.toFixed(1))
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
        lab8bit = convertPsd16bitTo8bitLab(labData, pixelCount);
    }

    // 3. Calculate image DNA
    console.log(`  Calculating image DNA...`);
    const dna = calculateImageDNA(lab8bit, width, height);
    dna.filename = basename;
    dna.bitDepth = depth;

    console.log(`  DNA: L=${dna.l}, C=${dna.c}, K=${dna.k}, StdDev=${dna.l_std_dev}, maxC=${dna.maxC}`);

    // 4. Generate configuration
    const config = ParameterGenerator.generate(dna, {
        imageData: null,
        width,
        height,
        preprocessingIntensity: 'auto'
    });
    dna.archetype = config.meta?.archetypeId;
    console.log(chalk.green(`  Archetype: ${config.meta?.archetype || 'unknown'}`));
    console.log(`  Colors: ${config.targetColors}, BlackBias: ${config.blackBias}, Dither: ${config.ditherType}`);

    // 4a. Bilateral prefilter (edge-preserving noise reduction)
    const BilateralFilter = Reveal.BilateralFilter;
    const is16Bit = depth === 16;
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
        { targetColors: params.targetColorsSlider }
    );

    console.log(`  DeltaE: avg=${metrics.global_fidelity.avgDeltaE}, max=${metrics.global_fidelity.maxDeltaE}`);
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

    // Set Reveal metadata (Resource 4000) for filtering and analysis
    // TODO: Implement setRevealMetadata() in PSDWriter or use alternative approach
    // writer.setRevealMetadata({
    //     revScore: metrics.feature_preservation.revelationScore,
    //     archetype: config.meta?.archetype || 'unknown',
    //     colors: filteredPaletteLab.length, // Use filtered count (after removing empty layers)
    //     preset: config.id
    // });

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
