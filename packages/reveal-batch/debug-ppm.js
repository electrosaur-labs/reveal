/**
 * Debug PPM parsing for astronaut.ppm
 */

const path = require('path');
const { parsePPM } = require('./src/ppmParser');

const inputPath = path.join(__dirname, 'data/CQ100_v4/input/ppm/astronaut.ppm');

console.log('Parsing:', inputPath);
console.log();

try {
    const ppm = parsePPM(inputPath);

    console.log('PPM Header:');
    console.log('  Width:', ppm.width);
    console.log('  Height:', ppm.height);
    console.log('  Max Value:', ppm.maxValue);
    console.log('  Pixels buffer length:', ppm.pixels.length);
    console.log('  Expected length:', ppm.width * ppm.height * 3);
    console.log();

    // Sample first 10 pixels
    console.log('First 10 pixels (RGB values):');
    for (let i = 0; i < Math.min(10, ppm.width * ppm.height); i++) {
        const r = ppm.pixels[i * 3];
        const g = ppm.pixels[i * 3 + 1];
        const b = ppm.pixels[i * 3 + 2];
        console.log(`  Pixel ${i}: R=${r} G=${g} B=${b}`);
    }
    console.log();

    // Check for all-black
    let allBlack = true;
    for (let i = 0; i < ppm.pixels.length; i++) {
        if (ppm.pixels[i] !== 0) {
            allBlack = false;
            break;
        }
    }

    if (allBlack) {
        console.log('⚠️  WARNING: All pixels are black (0,0,0)!');
    } else {
        console.log('✓ Image has non-black pixels');
    }

    // Sample some statistics
    let minR = 255, maxR = 0;
    let minG = 255, maxG = 0;
    let minB = 255, maxB = 0;

    for (let i = 0; i < ppm.width * ppm.height; i++) {
        const r = ppm.pixels[i * 3];
        const g = ppm.pixels[i * 3 + 1];
        const b = ppm.pixels[i * 3 + 2];

        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
        minG = Math.min(minG, g);
        maxG = Math.max(maxG, g);
        minB = Math.min(minB, b);
        maxB = Math.max(maxB, b);
    }

    console.log();
    console.log('RGB Value Ranges:');
    console.log(`  R: ${minR} - ${maxR}`);
    console.log(`  G: ${minG} - ${maxG}`);
    console.log(`  B: ${minB} - ${maxB}`);

} catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
}
