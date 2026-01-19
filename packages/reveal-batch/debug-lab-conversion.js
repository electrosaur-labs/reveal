/**
 * Debug Lab conversion
 */

const path = require('path');
const { parsePPM } = require('./src/ppmParser');
const Reveal = require('@reveal/core');

const inputPath = path.join(__dirname, 'data/CQ100_v4/input/ppm/astronaut.ppm');

console.log('Testing RGB to Lab conversion...\n');

// Parse PPM
const ppm = parsePPM(inputPath);
const { width, height, pixels } = ppm;

console.log(`Image: ${width}×${height}`);
console.log();

// Test conversion on first 10 pixels
console.log('First 10 pixels - RGB to Lab conversion:');
for (let i = 0; i < Math.min(10, width * height); i++) {
    const r = pixels[i * 3];
    const g = pixels[i * 3 + 1];
    const b = pixels[i * 3 + 2];

    const lab = Reveal.rgbToLab(r, g, b);

    // Convert to byte encoding
    const L_byte = (lab.L / 100) * 255;
    const a_byte = lab.a + 128;
    const b_byte = lab.b + 128;

    console.log(`  Pixel ${i}:`);
    console.log(`    RGB: (${r}, ${g}, ${b})`);
    console.log(`    Lab (perceptual): L=${lab.L.toFixed(2)}, a=${lab.a.toFixed(2)}, b=${lab.b.toFixed(2)}`);
    console.log(`    Lab (byte): L=${Math.round(L_byte)}, a=${Math.round(a_byte)}, b=${Math.round(b_byte)}`);
}

// Check if Reveal.rgbToLab exists and is working
console.log();
console.log('Testing specific conversions:');

// Pure white
const white = Reveal.rgbToLab(255, 255, 255);
console.log(`  White (255,255,255): L=${white.L.toFixed(2)}, a=${white.a.toFixed(2)}, b=${white.b.toFixed(2)}`);

// Pure black
const black = Reveal.rgbToLab(0, 0, 0);
console.log(`  Black (0,0,0): L=${black.L.toFixed(2)}, a=${black.a.toFixed(2)}, b=${black.b.toFixed(2)}`);

// Pure red
const red = Reveal.rgbToLab(255, 0, 0);
console.log(`  Red (255,0,0): L=${red.L.toFixed(2)}, a=${red.a.toFixed(2)}, b=${red.b.toFixed(2)}`);

// Mid gray
const gray = Reveal.rgbToLab(128, 128, 128);
console.log(`  Gray (128,128,128): L=${gray.L.toFixed(2)}, a=${gray.a.toFixed(2)}, b=${gray.b.toFixed(2)}`);
