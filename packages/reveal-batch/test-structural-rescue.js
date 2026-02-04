#!/usr/bin/env node
/**
 * Test structural-outlier-rescue archetype on cards_b.psd
 */
const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const { PSDWriter } = require('@reveal/psd-writer');
const { readPsd } = require('@reveal/psd-reader');
const MetricsCalculator = require('./src/MetricsCalculator');

// Paths
const inputPsd = '/workspaces/electrosaur/reveal-project/packages/reveal-batch/data/TESTIMAGES/input/psd/16bit/snails.psd';
const outputDir = '/workspaces/electrosaur/reveal-project/packages/reveal-batch/data/TESTIMAGES/output/psd/16bit';
const archetypePath = '/workspaces/electrosaur/reveal-project/packages/reveal-core/archetypes/structural-outlier-rescue.json';

// Load the archetype
const archetype = JSON.parse(fs.readFileSync(archetypePath, 'utf8'));
const config = {
    ...archetype.parameters,
    meta: {
        archetype: archetype.name,
        archetypeId: archetype.id
    }
};

// Convert functions (from posterize-psd.js)
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

function convertPsd16bitToEngineLab(labPsd16, pixelCount) {
    const labEngine = new Uint16Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        labEngine[i * 3] = labPsd16[i * 3] >> 1;
        labEngine[i * 3 + 1] = labPsd16[i * 3 + 1] >> 1;
        labEngine[i * 3 + 2] = labPsd16[i * 3 + 2] >> 1;
    }
    return labEngine;
}

function convert16bitTo8bitLab(lab16bit, pixelCount) {
    const lab8bit = new Uint8Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        lab8bit[i * 3] = Math.round(lab16bit[i * 3] / 257);
        lab8bit[i * 3 + 1] = Math.round(lab16bit[i * 3 + 1] / 257);
        lab8bit[i * 3 + 2] = Math.round(lab16bit[i * 3 + 2] / 257);
    }
    return lab8bit;
}

function reconstructProcessedLab(colorIndices, paletteLab, pixelCount) {
    const processedLab = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const colorIdx = colorIndices[i];
        const color = paletteLab[colorIdx];
        processedLab[i * 3] = Math.round((color.L / 100) * 255);
        processedLab[i * 3 + 1] = Math.round(color.a + 128);
        processedLab[i * 3 + 2] = Math.round(color.b + 128);
    }
    return processedLab;
}

async function main() {
    console.log('\n' + '='.repeat(70));
    console.log('  Testing Structural Outlier Rescue on snails.psd');
    console.log('='.repeat(70) + '\n');

    console.log('Configuration:');
    console.log(`  Archetype: ${archetype.name}`);
    console.log(`  Dither: ${config.ditherType}`);
    console.log(`  lWeight: ${config.lWeight}, cWeight: ${config.cWeight}`);
    console.log(`  paletteReduction: ${config.paletteReduction}`);
    console.log(`  substrateTolerance: ${config.substrateTolerance}\n`);

    // Read PSD
    console.log('Reading snails.psd...');
    const psdBuffer = fs.readFileSync(inputPsd);
    const psd = readPsd(psdBuffer);

    const { width, height, depth, data: labData } = psd;
    const pixelCount = width * height;

    console.log(`  Dimensions: ${width}x${height} (${pixelCount} pixels)`);
    console.log(`  Bit depth: ${depth}-bit\n`);

    // Convert Lab data
    let lab16bit, lab8bit;
    if (depth === 8) {
        lab8bit = labData;
        lab16bit = convert8bitTo16bitLab(lab8bit, pixelCount);
    } else {
        lab16bit = convertPsd16bitToEngineLab(labData, pixelCount);
        lab8bit = convert16bitTo8bitLab(labData, pixelCount);
    }

    // Process with reveal-core
    console.log('Processing with Reveal engine...');
    const startTime = Date.now();

    // Step 1: Posterize to get palette
    const posterizeResult = await Reveal.posterizeImage(lab16bit, width, height, config.targetColorsSlider, config);
    console.log(`  Posterized to ${posterizeResult.labPalette.length} colors`);

    // Step 2: Separate pixels to palette
    const separateResult = await Reveal.separateImage(lab16bit, posterizeResult.labPalette, width, height, config);
    console.log(`  Separated ${separateResult.metadata.totalPixels} pixels`);

    const processingTime = Date.now() - startTime;
    console.log(`  ✓ Completed in ${processingTime}ms\n`);

    // Calculate metrics
    console.log('Calculating quality metrics...');
    const processedLab = reconstructProcessedLab(separateResult.colorIndices, posterizeResult.labPalette, pixelCount);
    const metrics = MetricsCalculator.calculate(lab8bit, processedLab, width, height);

    // Output results
    console.log('\n' + '='.repeat(70));
    console.log('  RESULTS');
    console.log('='.repeat(70) + '\n');

    console.log('Color Palette:');
    posterizeResult.rgbPalette.forEach((color, i) => {
        const lab = posterizeResult.labPalette[i];
        console.log(`  ${i + 1}. L:${lab.L.toFixed(1)} a:${lab.a.toFixed(1)} b:${lab.b.toFixed(1)} | RGB:(${color.r},${color.g},${color.b})`);
    });

    console.log(`\nQuality Metrics:`);
    console.log(`  Revelation Score:     ${metrics.revelation.revelationScore.toFixed(1)} ${metrics.revelation.revelationScore >= 20 ? '✅' : '❌'}`);
    console.log(`  Base Score:           ${metrics.revelation.baseScore.toFixed(1)}`);
    console.log(`  Efficiency Penalty:   ${metrics.revelation.efficiencyPenalty.toFixed(1)}`);
    console.log(`  Saliency Loss:        ${metrics.revelation.saliencyLoss.toFixed(1)}%`);
    console.log(`  Avg ΔE:               ${metrics.global_fidelity.avg_delta_e.toFixed(2)}`);
    console.log(`  Max ΔE:               ${metrics.global_fidelity.max_delta_e.toFixed(2)}`);
    console.log(`  Integrity Score:      ${metrics.integrity.integrityScore.toFixed(1)}`);
    console.log(`  Density Integrity:    ${metrics.integrity.densityIntegrity.toFixed(1)}`);

    // Compare to original
    const originalJson = JSON.parse(fs.readFileSync(path.join(outputDir, 'snails.json'), 'utf8'));
    console.log(`\n${'─'.repeat(70)}`);
    console.log('Comparison to Original (blue-noise, subtle-naturalist):');
    console.log(`${'─'.repeat(70)}`);
    const revDiff = metrics.revelation.revelationScore - originalJson.metrics.revelation.revelationScore;
    const salDiff = metrics.revelation.saliencyLoss - originalJson.metrics.revelation.saliencyLoss;
    const deltaEDiff = metrics.global_fidelity.avg_delta_e - originalJson.metrics.global_fidelity.avg_delta_e;
    console.log(`  Revelation:  ${originalJson.metrics.revelation.revelationScore.toFixed(1)} → ${metrics.revelation.revelationScore.toFixed(1)} (${revDiff >= 0 ? '+' : ''}${revDiff.toFixed(1)})`);
    console.log(`  Saliency Loss: ${originalJson.metrics.revelation.saliencyLoss.toFixed(1)}% → ${metrics.revelation.saliencyLoss.toFixed(1)}% (${salDiff >= 0 ? '+' : ''}${salDiff.toFixed(1)}%)`);
    console.log(`  Avg ΔE:      ${originalJson.metrics.global_fidelity.avg_delta_e.toFixed(2)} → ${metrics.global_fidelity.avg_delta_e.toFixed(2)} (${deltaEDiff >= 0 ? '+' : ''}${deltaEDiff.toFixed(2)})`);

    // Save results
    const outputJson = {
        filename: 'snails_structural_rescue.psd',
        configuration: config,
        palette: posterizeResult.rgbPalette,
        labPalette: posterizeResult.labPalette,
        statistics: posterizeResult.statistics,
        metrics: metrics,
        processingTime: processingTime
    };

    const outputJsonPath = path.join(outputDir, 'snails_structural_rescue.json');
    fs.writeFileSync(outputJsonPath, JSON.stringify(outputJson, null, 2));
    console.log(`\n✓ Saved results to: snails_structural_rescue.json`);

    if (metrics.revelation.revelationScore >= 20) {
        console.log('\n🎉 SUCCESS! Revelation score passed the 20 threshold!');
    } else {
        console.log(`\n⚠️  Revelation score still below 20 (${metrics.revelation.revelationScore.toFixed(1)})`);
    }
}

main().catch(error => {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
});
