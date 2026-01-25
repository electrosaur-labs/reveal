#!/usr/bin/env node
/**
 * Test script to verify 16-bit Lab encoding in PSD files
 *
 * Usage: node test-encoding.js <path-to-16bit-lab-psd>
 *
 * Creates a test PSD if no argument provided, or reads the specified file.
 * Reports raw 16-bit values to determine encoding:
 *   - If white L ≈ 65535 → ICC encoding (0-65535)
 *   - If white L ≈ 32768 → Photoshop 15+1 encoding (0-32768)
 */

const fs = require('fs');
const path = require('path');
const { readPsd } = require('./index.js');

const inputFile = process.argv[2];

if (!inputFile) {
    console.log('Usage: node test-encoding.js <path-to-16bit-lab-psd>');
    console.log('\nCreate a 16-bit Lab PSD in Photoshop with known colors:');
    console.log('  - Pure white (L=100, a=0, b=0)');
    console.log('  - Pure black (L=0, a=0, b=0)');
    console.log('  - Neutral gray (L=50, a=0, b=0)');
    console.log('  - A colored pixel (e.g., L=50, a=50, b=-50)');
    console.log('\nThen run this script to check the raw 16-bit values.');
    process.exit(1);
}

if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
}

console.log(`\nReading: ${inputFile}\n`);

const buffer = fs.readFileSync(inputFile);
const psd = readPsd(buffer);

console.log(`Dimensions: ${psd.width} × ${psd.height}`);
console.log(`Bit depth: ${psd.depth}`);
console.log(`Color mode: ${psd.colorMode} (9 = Lab)`);
console.log(`Channels: ${psd.channels}`);
console.log();

if (psd.depth !== 16) {
    console.error('This test requires a 16-bit PSD file.');
    process.exit(1);
}

// Sample pixels
const data = psd.data;
const pixelCount = psd.width * psd.height;

// Get min/max values for each channel
let minL = 65535, maxL = 0;
let minA = 65535, maxA = 0;
let minB = 65535, maxB = 0;

for (let i = 0; i < pixelCount; i++) {
    const L = data[i * 3];
    const a = data[i * 3 + 1];
    const b = data[i * 3 + 2];

    if (L < minL) minL = L;
    if (L > maxL) maxL = L;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (b < minB) minB = b;
    if (b > maxB) maxB = b;
}

console.log('=== RAW 16-BIT VALUES ===');
console.log(`L channel: min=${minL}, max=${maxL}`);
console.log(`a channel: min=${minA}, max=${maxA}`);
console.log(`b channel: min=${minB}, max=${maxB}`);
console.log();

// Sample first 5 pixels
console.log('=== FIRST 5 PIXELS (raw values) ===');
for (let i = 0; i < Math.min(5, pixelCount); i++) {
    const L = data[i * 3];
    const a = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    console.log(`Pixel ${i}: L=${L}, a=${a}, b=${b}`);
}
console.log();

// Interpret encoding
console.log('=== ENCODING ANALYSIS ===');
if (maxL > 50000) {
    console.log('✓ Encoding appears to be ICC (0-65535)');
    console.log(`  White L would be: ${maxL} (expected ~65535)`);
    console.log(`  Neutral a/b would be: ~32768`);

    // Convert to perceptual
    console.log('\n  Perceptual interpretation (ICC):');
    console.log(`    L range: ${(minL / 65535 * 100).toFixed(1)} - ${(maxL / 65535 * 100).toFixed(1)}`);
    console.log(`    a range: ${((minA - 32768) / 256).toFixed(1)} - ${((maxA - 32768) / 256).toFixed(1)}`);
    console.log(`    b range: ${((minB - 32768) / 256).toFixed(1)} - ${((maxB - 32768) / 256).toFixed(1)}`);
} else if (maxL > 25000) {
    console.log('✓ Encoding appears to be Photoshop 15+1 (0-32768)');
    console.log(`  White L would be: ${maxL} (expected ~32768)`);
    console.log(`  Neutral a/b would be: ~16384`);

    // Convert to perceptual
    console.log('\n  Perceptual interpretation (Photoshop):');
    console.log(`    L range: ${(minL / 32768 * 100).toFixed(1)} - ${(maxL / 32768 * 100).toFixed(1)}`);
    console.log(`    a range: ${((minA - 16384) / 128).toFixed(1)} - ${((maxA - 16384) / 128).toFixed(1)}`);
    console.log(`    b range: ${((minB - 16384) / 128).toFixed(1)} - ${((maxB - 16384) / 128).toFixed(1)}`);
} else if (maxL <= 10000) {
    console.log('✓ Encoding appears to be Adobe spec (L: 0-10000)');
    console.log(`  White L would be: ${maxL} (expected ~10000)`);

    // Convert to perceptual
    console.log('\n  Perceptual interpretation (Adobe spec):');
    console.log(`    L range: ${(minL / 100).toFixed(1)} - ${(maxL / 100).toFixed(1)}`);
} else {
    console.log('? Unknown encoding');
    console.log(`  Max L = ${maxL}`);
}
