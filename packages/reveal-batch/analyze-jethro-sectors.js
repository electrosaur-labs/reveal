#!/usr/bin/env node
/**
 * Diagnostic: Analyze JethroAsMonroe hue sectors
 */
const fs = require('fs');
const { readPsd } = require('ag-psd');
const DNAGenerator = require('../reveal-adobe/src/DNAGenerator');

const psdPath = '/workspaces/electrosaur/fixtures/JethroAsMonroe-original-16bit.psd';

console.log('Reading PSD:', psdPath);
const buffer = fs.readFileSync(psdPath);
const psd = readPsd(buffer, { skipLayerImageData: true, skipCompositeImageData: false });

const width = psd.width;
const height = psd.height;
const labData = psd.data; // ag-psd uses .data not .imageData

console.log(`Image: ${width}x${height}`);
console.log(`Color mode: ${psd.colorMode} (9=Lab)`);
console.log(`Bit depth: ${psd.depth}-bit`);
console.log(`Lab data type: ${labData.constructor.name}, length: ${labData.length}`);
console.log(`Expected: ${width * height * 3} elements`);

// Check if 16-bit data needs conversion
let labPixels;
if (psd.depth === 16) {
    console.log('\n16-bit PSD detected, converting to engine format...');
    // ag-psd returns Uint16Array with 0-65535 range
    // DNAGenerator expects 0-32768 range
    labPixels = new Uint16Array(labData.length);
    for (let i = 0; i < labData.length; i++) {
        labPixels[i] = labData[i] >> 1; // Divide by 2
    }
} else {
    labPixels = labData;
}

// Generate Rich DNA with all sectors
console.log('\nGenerating Rich DNA v2.0...');
const dna = DNAGenerator.generate(labPixels, width, height, 40, {
    richDNA: true,
    spatialMetrics: false
});

console.log('\n=== DNA ANALYSIS ===');
console.log(`Version: ${dna.version}`);
console.log(`Global metrics:`);
console.log(`  L: ${dna.global.l}`);
console.log(`  C: ${dna.global.c}`);
console.log(`  neutralWeight: ${dna.global.neutralWeight} (${(dna.global.neutralWeight * 100).toFixed(1)}%)`);
console.log(`  chromaticCoverage: ${dna.global.chromaticCoverage}`);

console.log('\n=== SECTOR DISTRIBUTION (ALL 12 SECTORS) ===');
const sectorNames = ['red', 'orange', 'yellow', 'chartreuse', 'green', 'cyan',
                     'blue', 'violet', 'purple', 'magenta', 'pink', 'crimson'];

for (const sectorName of sectorNames) {
    const sector = dna.sectors[sectorName];
    const hueRange = {
        'red': '0-30°',
        'orange': '30-60°',
        'yellow': '60-90°',
        'chartreuse': '90-120°',
        'green': '120-150°',
        'cyan': '150-180°',
        'blue': '180-210°',
        'violet': '210-240°',
        'purple': '240-270°',
        'magenta': '270-300°',
        'pink': '300-330°',
        'crimson': '330-360°'
    };

    if (sector) {
        console.log(`  ${sectorName.padEnd(12)} (${hueRange[sectorName].padEnd(10)}): weight=${(sector.weight * 100).toFixed(1).padStart(5)}%, coverage=${(sector.coverage * 100).toFixed(1).padStart(5)}%, L=${sector.lMean.toFixed(1)}, C=${sector.cMean.toFixed(1)}`);
    } else {
        console.log(`  ${sectorName.padEnd(12)} (${hueRange[sectorName].padEnd(10)}): NOT PRESENT`);
    }
}

console.log('\n=== MANUAL HUE SCAN (Raw Pixel Analysis) ===');
// Manually scan all pixels and count by hue sector
const sectorCounts = new Array(12).fill(0);
const sectorChromaSum = new Array(12).fill(0);
let totalChromatic = 0;
let neutralCount = 0;

for (let i = 0; i < labPixels.length; i += 3) {
    const L = (labPixels[i] / 32768) * 100;
    const a = ((labPixels[i + 1] - 16384) / 16384) * 128;
    const b = ((labPixels[i + 2] - 16384) / 16384) * 128;

    const chroma = Math.sqrt(a * a + b * b);
    if (chroma > 5) {
        totalChromatic++;
        const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
        const sectorIndex = Math.floor(hue / 30) % 12;
        sectorCounts[sectorIndex]++;
        sectorChromaSum[sectorIndex] += chroma;
    } else {
        neutralCount++;
    }
}

for (let i = 0; i < 12; i++) {
    const sectorName = sectorNames[i];
    const count = sectorCounts[i];
    const percentage = (count / totalChromatic * 100).toFixed(1);
    const avgChroma = count > 0 ? (sectorChromaSum[i] / count).toFixed(1) : 0;
    console.log(`  ${sectorName.padEnd(12)}: ${count.toString().padStart(7)} pixels (${percentage.padStart(5)}%), avg C=${avgChroma}`);
}

console.log(`\nTotal chromatic pixels (C>5): ${totalChromatic}`);
console.log(`Total neutral pixels (C≤5): ${neutralCount}`);
console.log(`Neutral percentage: ${(neutralCount / (totalChromatic + neutralCount) * 100).toFixed(1)}%`);
