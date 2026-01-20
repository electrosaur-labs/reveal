#!/usr/bin/env node
/**
 * Test script to verify ag-psd can read Lab color mode PSDs
 */

const fs = require('fs');
const path = require('path');
const { readPsd } = require('../reveal-psd-reader');

const testFile = process.argv[2] || 'data/SP100/input/loc/psd/loc_2014635594.psd';

console.log(`Reading PSD file: ${testFile}`);

const buffer = fs.readFileSync(testFile);
const psd = readPsd(buffer);

console.log('\nPSD Metadata:');
console.log(`  Dimensions: ${psd.width}×${psd.height}`);
console.log(`  Color mode: ${psd.colorMode} (9=Lab, 3=RGB)`);
console.log(`  Bit depth: ${psd.depth}-bit`);
console.log(`  Channels: ${psd.channels}`);

console.log('\nComposite Image Data:');
console.log(`  Data present: ${!!psd.data}`);
console.log(`  Bytes: ${psd.data ? psd.data.length : 0}`);
console.log(`  Expected: ${psd.width * psd.height * 3} (${psd.width}×${psd.height}×3 channels)`);

if (psd.data) {
    // Sample first pixel
    console.log(`\nFirst pixel (Lab):`);
    console.log(`  L: ${psd.data[0]}`);
    console.log(`  a: ${psd.data[1]}`);
    console.log(`  b: ${psd.data[2]}`);

    // Sample center pixel
    const centerIdx = (Math.floor(psd.height / 2) * psd.width + Math.floor(psd.width / 2)) * 3;
    console.log(`\nCenter pixel (Lab):`);
    console.log(`  L: ${psd.data[centerIdx]}`);
    console.log(`  a: ${psd.data[centerIdx + 1]}`);
    console.log(`  b: ${psd.data[centerIdx + 2]}`);
}

console.log('\n✓ PSD read successfully');
