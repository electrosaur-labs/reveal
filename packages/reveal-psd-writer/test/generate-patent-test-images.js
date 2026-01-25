#!/usr/bin/env node
/**
 * Generate 16-bit Lab PSD Test Images for Patent Validation
 *
 * Creates three specific test images to validate bilateral filter and separation logic:
 *
 * 1. Chromatic Zero-Crossing Target (1024×512)
 *    - Tests a* gradient crossing through neutral (green→gray→red)
 *    - L=50%, a gradient -30 to +30, b=+20
 *
 * 2. Sub-Bit-Depth Gradient (2048×512)
 *    - Proves 16-bit precision by encoding ~327 distinct L values
 *    - L gradient 40.0% to 40.5%, neutral a/b
 *
 * 3. Edge-Preserving Impulse Target (1024×1024)
 *    - Tests bilateral filter's edge-preserving noise reduction
 *    - Sharp L=30/L=70 edge with 2% salt-and-pepper noise
 *
 * All images use ICC Lab encoding (0-65535 range):
 *   - L: 0 = 0%, 65535 = 100%
 *   - a/b: 32768 = neutral, range maps to -128 to +127
 */

const fs = require('fs');
const path = require('path');
const { PSDWriter } = require('../src');

// Output directory
const outputDir = path.join(__dirname, 'output', 'patent-test-images');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

/**
 * Convert perceptual Lab values to 16-bit ICC encoding
 * @param {number} L - Lightness 0-100
 * @param {number} a - a* channel -128 to +127
 * @param {number} b - b* channel -128 to +127
 * @returns {Object} { L16, a16, b16 } in ICC encoding (0-65535)
 */
function labToICC16(L, a, b) {
    return {
        L16: Math.round((L / 100) * 65535),
        a16: Math.round(((a + 128) / 256) * 65535),
        b16: Math.round(((b + 128) / 256) * 65535)
    };
}

/**
 * Write 16-bit value as big-endian to buffer
 */
function write16BE(buffer, offset, value) {
    buffer[offset] = (value >> 8) & 0xFF;
    buffer[offset + 1] = value & 0xFF;
}

/**
 * Create a 16-bit Lab pixel buffer
 */
function create16bitLabBuffer(width, height) {
    return new Uint8Array(width * height * 6);  // 2 bytes per channel, 3 channels
}

/**
 * Set a pixel in the 16-bit Lab buffer
 */
function setPixel16(buffer, width, x, y, L16, a16, b16) {
    const offset = (y * width + x) * 6;
    write16BE(buffer, offset, L16);
    write16BE(buffer, offset + 2, a16);
    write16BE(buffer, offset + 4, b16);
}

// ============================================================================
// IMAGE 1: Chromatic Zero-Crossing Target
// ============================================================================

function generateChromaticZeroCrossing() {
    const WIDTH = 1024;
    const HEIGHT = 512;

    console.log('\n=== Chromatic Zero-Crossing Target ===');
    console.log(`Dimensions: ${WIDTH}×${HEIGHT}`);
    console.log('L = 50%, a gradient -30 to +30, b = +20');

    const pixels = create16bitLabBuffer(WIDTH, HEIGHT);
    const L = 50;  // Constant lightness
    const b = 20;  // Constant b* (yellow bias)

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            // a* gradient from -30 to +30 across width
            const a = -30 + (60 * x / (WIDTH - 1));

            const { L16, a16, b16 } = labToICC16(L, a, b);
            setPixel16(pixels, WIDTH, x, y, L16, a16, b16);
        }
    }

    // Create PSD
    const writer = new PSDWriter({
        width: WIDTH,
        height: HEIGHT,
        colorMode: 'lab',
        bitsPerChannel: 16
    });

    writer.addPixelLayer({
        name: 'Chromatic Zero-Crossing',
        pixels: pixels
    });

    const psdBuffer = writer.write();
    const outputPath = path.join(outputDir, 'chromatic-zero-crossing.psd');
    fs.writeFileSync(outputPath, psdBuffer);

    console.log(`✓ Saved: ${outputPath}`);
    console.log(`  File size: ${(psdBuffer.length / 1024).toFixed(2)} KB`);

    // Log sample values
    console.log('\nSample pixel values (perceptual):');
    console.log('  Left edge (x=0):   L=50, a=-30, b=+20 (green-yellow)');
    console.log('  Center (x=512):    L=50, a=0, b=+20 (neutral yellow)');
    console.log('  Right edge (x=1023): L=50, a=+30, b=+20 (red-yellow)');

    return outputPath;
}

// ============================================================================
// IMAGE 2: Sub-Bit-Depth Gradient
// ============================================================================

function generateSubBitDepthGradient() {
    const WIDTH = 2048;
    const HEIGHT = 512;

    console.log('\n=== Sub-Bit-Depth Gradient ===');
    console.log(`Dimensions: ${WIDTH}×${HEIGHT}`);
    console.log('L gradient 40.0% to 40.5%, neutral a/b');

    const pixels = create16bitLabBuffer(WIDTH, HEIGHT);

    // L gradient: 40.0% to 40.5%
    // In 16-bit: 40% = 26214, 40.5% = 26542
    // Range: 328 distinct values over 2048 pixels = ~6.2 pixels per step
    const L_start = 40.0;
    const L_end = 40.5;
    const a = 0;  // Neutral
    const b = 0;  // Neutral

    // Calculate expected step count
    const { L16: L16_start } = labToICC16(L_start, 0, 0);
    const { L16: L16_end } = labToICC16(L_end, 0, 0);
    console.log(`16-bit L range: ${L16_start} to ${L16_end} (${L16_end - L16_start + 1} distinct values)`);

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            // L gradient across width
            const L = L_start + (L_end - L_start) * (x / (WIDTH - 1));

            const { L16, a16, b16 } = labToICC16(L, a, b);
            setPixel16(pixels, WIDTH, x, y, L16, a16, b16);
        }
    }

    // Create PSD
    const writer = new PSDWriter({
        width: WIDTH,
        height: HEIGHT,
        colorMode: 'lab',
        bitsPerChannel: 16
    });

    writer.addPixelLayer({
        name: 'Sub-Bit-Depth Gradient',
        pixels: pixels
    });

    const psdBuffer = writer.write();
    const outputPath = path.join(outputDir, 'sub-bit-depth-gradient.psd');
    fs.writeFileSync(outputPath, psdBuffer);

    console.log(`✓ Saved: ${outputPath}`);
    console.log(`  File size: ${(psdBuffer.length / 1024).toFixed(2)} KB`);

    console.log('\nThis gradient spans only 0.5% L change, requiring 16-bit precision.');
    console.log('In 8-bit, this would be ~1 step (visually flat).');
    console.log('In 16-bit, this encodes ~328 distinct values.');

    return outputPath;
}

// ============================================================================
// IMAGE 3: Edge-Preserving Impulse Target
// ============================================================================

function generateEdgePreservingImpulse() {
    const WIDTH = 1024;
    const HEIGHT = 1024;

    console.log('\n=== Edge-Preserving Impulse Target ===');
    console.log(`Dimensions: ${WIDTH}×${HEIGHT}`);
    console.log('Sharp L=30/L=70 edge with 2% salt-and-pepper noise');

    const pixels = create16bitLabBuffer(WIDTH, HEIGHT);

    // Seeded random for reproducibility
    let seed = 12345;
    function random() {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    }

    const NOISE_PROBABILITY = 0.02;  // 2% noise
    const L_left = 30;   // Dark side
    const L_right = 70;  // Light side
    const a = 0;  // Neutral
    const b = 0;  // Neutral

    let noiseCount = 0;
    let edgePixels = 0;

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            // Sharp edge at x = WIDTH/2
            const isLeftSide = x < WIDTH / 2;
            let L = isLeftSide ? L_left : L_right;

            // Add salt-and-pepper noise
            if (random() < NOISE_PROBABILITY) {
                // Salt (white) or pepper (black) with equal probability
                L = random() < 0.5 ? 5 : 95;
                noiseCount++;
            }

            // Track edge pixels (within 1 pixel of boundary)
            if (Math.abs(x - WIDTH / 2) <= 1) {
                edgePixels++;
            }

            const { L16, a16, b16 } = labToICC16(L, a, b);
            setPixel16(pixels, WIDTH, x, y, L16, a16, b16);
        }
    }

    // Create PSD
    const writer = new PSDWriter({
        width: WIDTH,
        height: HEIGHT,
        colorMode: 'lab',
        bitsPerChannel: 16
    });

    writer.addPixelLayer({
        name: 'Edge-Preserving Impulse',
        pixels: pixels
    });

    const psdBuffer = writer.write();
    const outputPath = path.join(outputDir, 'edge-preserving-impulse.psd');
    fs.writeFileSync(outputPath, psdBuffer);

    console.log(`✓ Saved: ${outputPath}`);
    console.log(`  File size: ${(psdBuffer.length / 1024).toFixed(2)} KB`);

    const totalPixels = WIDTH * HEIGHT;
    console.log(`\nNoise statistics:`);
    console.log(`  Total pixels: ${totalPixels.toLocaleString()}`);
    console.log(`  Noise pixels: ${noiseCount.toLocaleString()} (${(100 * noiseCount / totalPixels).toFixed(2)}%)`);
    console.log(`  Edge pixels: ${edgePixels.toLocaleString()}`);

    console.log('\nExpected bilateral filter behavior:');
    console.log('  ✓ Noise should be smoothed within each region');
    console.log('  ✓ Sharp L=30/L=70 edge should be preserved');
    console.log('  ✓ No "halo" artifacts along the edge');

    return outputPath;
}

// ============================================================================
// Main
// ============================================================================

console.log('Generating 16-bit Lab PSD Test Images for Patent Validation');
console.log('============================================================');

const files = [];
files.push(generateChromaticZeroCrossing());
files.push(generateSubBitDepthGradient());
files.push(generateEdgePreservingImpulse());

console.log('\n============================================================');
console.log('All test images generated successfully!');
console.log('\nOutput files:');
files.forEach(f => console.log(`  ${f}`));

console.log('\nThese images can be used to validate:');
console.log('  1. Chromatic separation across neutral boundary (a* zero-crossing)');
console.log('  2. 16-bit precision preservation (sub-bit-depth gradient)');
console.log('  3. Edge-preserving noise reduction (bilateral filter)');
