const { parsePPM } = require('./src/ppmParser');
const Reveal = require('@electrosaur-labs/core');
const path = require('path');

// Parse astronaut PPM
const ppm = parsePPM(path.join(__dirname, 'data/CQ100_v4/input/ppm/astronaut.ppm'));
const { width, height, pixels } = ppm;

console.log('Astronaut PPM:');
console.log(`  Dimensions: ${width}×${height}`);
console.log(`  Total pixels: ${width * height}`);

// Sample first 10 pixels
console.log('\nFirst 10 pixels (RGB):');
for (let i = 0; i < 10; i++) {
    const r = pixels[i * 3];
    const g = pixels[i * 3 + 1];
    const b = pixels[i * 3 + 2];
    console.log(`  Pixel ${i}: RGB(${r}, ${g}, ${b})`);
}

// Convert to Lab
const labPixels = new Uint8ClampedArray(width * height * 3);
for (let i = 0; i < 10; i++) {
    const r = pixels[i * 3];
    const g = pixels[i * 3 + 1];
    const b = pixels[i * 3 + 2];

    const lab = Reveal.rgbToLab({ r, g, b });

    // Convert to byte encoding
    labPixels[i * 3] = (lab.L / 100) * 255;
    labPixels[i * 3 + 1] = lab.a + 128;
    labPixels[i * 3 + 2] = lab.b + 128;

    console.log(`    → Lab(${lab.L.toFixed(2)}, ${lab.a.toFixed(2)}, ${lab.b.toFixed(2)})`);
    console.log(`    → Bytes(${labPixels[i * 3]}, ${labPixels[i * 3 + 1]}, ${labPixels[i * 3 + 2]})`);
}

// Check for any out-of-range values
let minL = 255, maxL = 0;
let minA = 255, maxA = 0;
let minB = 255, maxB = 0;

for (let i = 0; i < width * height; i++) {
    const r = pixels[i * 3];
    const g = pixels[i * 3 + 1];
    const b = pixels[i * 3 + 2];

    const lab = Reveal.rgbToLab({ r, g, b });

    const L_byte = (lab.L / 100) * 255;
    const a_byte = lab.a + 128;
    const b_byte = lab.b + 128;

    minL = Math.min(minL, L_byte);
    maxL = Math.max(maxL, L_byte);
    minA = Math.min(minA, a_byte);
    maxA = Math.max(maxA, a_byte);
    minB = Math.min(minB, b_byte);
    maxB = Math.max(maxB, b_byte);
}

console.log('\nLab byte ranges (entire image):');
console.log(`  L: ${minL.toFixed(1)} to ${maxL.toFixed(1)}`);
console.log(`  a: ${minA.toFixed(1)} to ${maxA.toFixed(1)}`);
console.log(`  b: ${minB.toFixed(1)} to ${maxB.toFixed(1)}`);

// Check if any values are out of valid byte range (0-255)
if (minL < 0 || maxL > 255 || minA < 0 || maxA > 255 || minB < 0 || maxB > 255) {
    console.log('\n⚠️  WARNING: Some Lab byte values are out of range (0-255)!');
}
