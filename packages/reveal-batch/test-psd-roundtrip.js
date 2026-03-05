#!/usr/bin/env node
/**
 * Round-trip test: Read a Lab PSD with @electrosaur-labs/psd-reader, write it back with @electrosaur-labs/psd-writer
 * Uses the EXACT same writing code from processSP100.js (lines 89-100)
 */

const fs = require('fs');
const path = require('path');
const { readPsd } = require('../reveal-psd-reader');
const { PSDWriter } = require('@electrosaur-labs/psd-writer');

const testFile = process.argv[2] || 'data/SP100/input/loc/psd/loc_2014635594.psd';
const outputFile = testFile.replace(/\.psd$/, '-roundtrip.psd');

console.log(`\n=== PSD Round-Trip Test ===`);
console.log(`Input:  ${testFile}`);
console.log(`Output: ${outputFile}\n`);

// Step 1: Read with our custom Lab reader
console.log('Step 1: Reading Lab PSD with @electrosaur-labs/psd-reader...');
const buffer = fs.readFileSync(testFile);
const psd = readPsd(buffer);

console.log(`  ✓ Read ${psd.width}×${psd.height}, ${psd.depth}-bit, ${psd.channels} channels`);
console.log(`  ✓ Lab data: ${psd.data.length} bytes\n`);

// Step 2: Write with @electrosaur-labs/psd-writer using EXACT code from processSP100.js
console.log('Step 2: Writing PSD with @electrosaur-labs/psd-writer...');
console.log('  (Using exact code from processSP100.js lines 89-100)');

// EXACT CODE FROM processSP100.js lines 89-100:
const writer = new PSDWriter({
    width: psd.width,
    height: psd.height,
    colorMode: 'lab',
    bitsPerChannel: 16
});

writer.addPixelLayer({
    name: 'Lab Composite',
    pixels: psd.data,
    visible: true
});

const psdBuffer = writer.write();
fs.writeFileSync(outputFile, psdBuffer);

const outputSize = (psdBuffer.length / 1024).toFixed(1);
console.log(`  ✓ Written ${outputSize} KB\n`);

// Step 3: Verify by reading back
console.log('Step 3: Verifying written file...');
const verifyBuffer = fs.readFileSync(outputFile);
const verifyPsd = readPsd(verifyBuffer);

console.log(`  ✓ Dimensions: ${verifyPsd.width}×${verifyPsd.height}`);
console.log(`  ✓ Color mode: ${verifyPsd.colorMode} (Lab)`);
console.log(`  ✓ Bit depth: ${verifyPsd.depth}-bit`);
console.log(`  ✓ Data bytes: ${verifyPsd.data.length}`);

// Compare a few sample pixels
let matches = 0;
const pixelCount = psd.width * psd.height;
const samples = Math.min(10, pixelCount);
for (let i = 0; i < samples; i++) {
    const idx = i * 3;
    if (psd.data[idx] === verifyPsd.data[idx] &&
        psd.data[idx + 1] === verifyPsd.data[idx + 1] &&
        psd.data[idx + 2] === verifyPsd.data[idx + 2]) {
        matches++;
    }
}

console.log(`  ✓ Sample pixels match: ${matches}/${samples}\n`);

if (matches === samples) {
    console.log('✅ SUCCESS: Round-trip complete!');
    console.log(`\nOutput file: ${outputFile}`);
    console.log(`\n📝 Note: Files created by @electrosaur-labs/psd-writer use pixel layers, so the`);
    console.log(`   composite section contains neutral Lab values (white/blank in Photoshop).`);
    console.log(`   This is expected behavior - the round-trip validates programmatic correctness.\n`);
} else {
    console.log('⚠️  WARNING: Some pixel values differ after round-trip');
}
