#!/usr/bin/env node
/**
 * Test structural-outlier-rescue archetype on all failing images
 * FORCES the rescue parameters regardless of DNA matching
 */
const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const { readPsd } = require('@reveal/psd-reader');
const MetricsCalculator = require('./src/MetricsCalculator');

// Failing images to test
const failingImages = [
    'cards_b.psd',
    'snails.psd',
    'screws.psd',
    'multimeter.psd',
    'pencils_b.psd',
    'ducks.psd',
    'baloons.psd',
    'sweets.psd'
];

const inputDir = '/workspaces/electrosaur/reveal-project/packages/reveal-batch/data/TESTIMAGES/input/psd/16bit';
const originalOutputDir = '/workspaces/electrosaur/reveal-project/packages/reveal-batch/data/TESTIMAGES/output/psd/16bit';
const testOutputDir = '/workspaces/electrosaur/reveal-project/packages/reveal-batch/data/TESTIMAGES/output/psd/16bit/rescue_forced';

// Load rescue archetype
const rescueArchetype = JSON.parse(fs.readFileSync(
    '/workspaces/electrosaur/reveal-project/packages/reveal-core/archetypes/structural-outlier-rescue.json',
    'utf8'
));

// Ensure output directory exists
if (!fs.existsSync(testOutputDir)) {
    fs.mkdirSync(testOutputDir, { recursive: true });
}

// Conversion functions
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

async function processImage(filename) {
    const basename = path.basename(filename, '.psd');
    const inputPath = path.join(inputDir, filename);
    const originalJsonPath = path.join(originalOutputDir, `${basename}.json`);

    console.log(`\n${'='.repeat(70)}`);
    console.log(`  Processing: ${filename}`);
    console.log('='.repeat(70));

    // Load original results
    if (!fs.existsSync(originalJsonPath)) {
        console.log(`⚠️  Original results not found, skipping: ${basename}`);
        return null;
    }
    const originalResults = JSON.parse(fs.readFileSync(originalJsonPath, 'utf8'));

    // Read PSD
    const psdBuffer = fs.readFileSync(inputPath);
    const psd = readPsd(psdBuffer);
    const { width, height, depth, data: labData } = psd;
    const pixelCount = width * height;

    console.log(`  Size: ${width}x${height}, Depth: ${depth}-bit`);

    // Convert Lab data
    let lab16bit, lab8bit;
    if (depth === 8) {
        lab8bit = labData;
        lab16bit = convert8bitTo16bitLab(lab8bit, pixelCount);
    } else {
        lab16bit = convertPsd16bitToEngineLab(labData, pixelCount);
        lab8bit = convert16bitTo8bitLab(labData, pixelCount); // Convert from PSD 16-bit, not engine 16-bit
    }


    // FORCE rescue archetype parameters
    const config = {
        ...rescueArchetype.parameters,
        meta: {
            archetype: rescueArchetype.name,
            archetypeId: rescueArchetype.id,
            forced: true
        }
    };

    console.log(`  FORCING: ${rescueArchetype.name}`);
    console.log(`    Dither: ${config.ditherType}`);
    console.log(`    lWeight: ${config.lWeight}, cWeight: ${config.cWeight}`);
    console.log(`    paletteReduction: ${config.paletteReduction}`);

    // Process with rescue parameters
    const startTime = Date.now();
    const posterizeResult = await Reveal.posterizeImage(lab16bit, width, height, config.targetColorsSlider, config);
    const separateResult = await Reveal.separateImage(lab16bit, posterizeResult.labPalette, width, height, config);
    const processingTime = Date.now() - startTime;

    console.log(`  ✓ Generated ${posterizeResult.labPalette.length} colors in ${processingTime}ms`);

    // Calculate metrics
    const processedLab = reconstructProcessedLab(separateResult.colorIndices, posterizeResult.labPalette, pixelCount);
    const metrics = MetricsCalculator.calculate(lab8bit, processedLab, width, height);

    // Compare to original
    const origRev = originalResults.metrics.feature_preservation.revelationScore;
    const testRev = metrics.feature_preservation.revelationScore;
    const revDiff = testRev - origRev;

    console.log(`\n  Results:`);
    console.log(`    Original: ${origRev.toFixed(1)} (${originalResults.configuration.ditherType}, ${originalResults.configuration.name})`);
    console.log(`    Rescue:   ${testRev.toFixed(1)} (${revDiff >= 0 ? '+' : ''}${revDiff.toFixed(1)})`);

    if (testRev >= 20 && origRev < 20) {
        console.log(`    🎉 SUCCESS! Passed threshold (${origRev.toFixed(1)} → ${testRev.toFixed(1)})`);
    } else if (testRev > origRev) {
        console.log(`    ✓ Improved but still below 20`);
    } else if (testRev < origRev) {
        console.log(`    ✗ Made it worse`);
    } else {
        console.log(`    = No change`);
    }

    // Save results
    const outputJson = {
        filename: `${basename}_rescue.psd`,
        configuration: config,
        palette: posterizeResult.rgbPalette,
        labPalette: posterizeResult.labPalette,
        metrics: metrics,
        comparison: {
            original: {
                revelationScore: origRev,
                archetype: originalResults.configuration.name
            },
            rescue: {
                revelationScore: testRev,
                difference: revDiff
            }
        },
        processingTime: processingTime
    };

    const outputJsonPath = path.join(testOutputDir, `${basename}.json`);
    fs.writeFileSync(outputJsonPath, JSON.stringify(outputJson, null, 2));

    return {
        filename: basename,
        original: origRev,
        rescue: testRev,
        diff: revDiff,
        passed: testRev >= 20,
        improved: testRev > origRev
    };
}

async function main() {
    console.log('\n' + '='.repeat(70));
    console.log('  FORCED RESCUE ARCHETYPE TEST');
    console.log('  Testing structural-outlier-rescue on all 8 failing images');
    console.log('='.repeat(70));

    const results = [];

    for (const filename of failingImages) {
        const result = await processImage(filename);
        if (result) {
            results.push(result);
        }
    }

    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('  SUMMARY');
    console.log('='.repeat(70));
    console.log('\n| Image | Original | Rescue | Diff | Status |');
    console.log('|-------|----------|--------|------|--------|');

    results.forEach(r => {
        const status = r.passed ? '✅ PASS' : r.improved ? '📈 Better' : r.diff < 0 ? '📉 Worse' : '= Same';
        console.log(`| ${r.filename.padEnd(12)} | ${r.original.toFixed(1).padStart(6)} | ${r.rescue.toFixed(1).padStart(6)} | ${(r.diff >= 0 ? '+' : '') + r.diff.toFixed(1).padStart(5)} | ${status} |`);
    });

    const improved = results.filter(r => r.improved).length;
    const passed = results.filter(r => r.passed).length;
    const worse = results.filter(r => r.diff < 0).length;

    console.log(`\n  Improved: ${improved}/${results.length}`);
    console.log(`  Passed threshold: ${passed}/${results.length}`);
    console.log(`  Made worse: ${worse}/${results.length}`);
}

main().catch(error => {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
});
