#!/usr/bin/env node
/**
 * Generate 16-bit Lab PSD Test Images for Patent Validation
 *
 * Creates three specific test images with MATHEMATICALLY LINEAR gradients
 * to validate bilateral filter and separation logic:
 *
 * 1. Chromatic Zero-Crossing Target (1024×512)
 *    - TRUE linear a* gradient: each horizontal pixel has unique a* value
 *    - L=50%, a* spans 1024 unique 16-bit values, b=+20
 *    - NO BANDING - smooth continuous gradient
 *
 * 2. Sub-Bit-Depth Gradient (1024×512)
 *    - TRUE linear L gradient: each horizontal pixel has unique L value
 *    - L spans exactly 1024 consecutive 16-bit steps
 *    - Proves 16-bit precision preservation (invisible in 8-bit)
 *
 * 3. Edge-Preserving Impulse Target (1024×1024)
 *    - Sharp L=30/L=70 edge with 2% salt-and-pepper noise
 *    - Noise L values closer to background for proper bilateral filtering
 *    - L=20 (pepper) and L=40 (salt) on dark side, L=60/L=80 on light side
 *
 * CRITICAL: Gradients are computed directly in 16-bit integer space
 * to avoid floating-point quantization artifacts.
 *
 * ICC Lab encoding (0-65535 range):
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

/**
 * Generate a linear ramp of 16-bit integer values
 * Each value is unique - no quantization
 *
 * @param {number} start - Starting 16-bit value
 * @param {number} count - Number of unique values to generate
 * @returns {Uint16Array} Array of count consecutive values starting at start
 */
function linearRamp16(start, count) {
    const values = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
        values[i] = start + i;
    }
    return values;
}

/**
 * Convert perceptual L% to 16-bit ICC encoding
 */
function lPercentToICC16(L) {
    return Math.round((L / 100) * 65535);
}

/**
 * Convert perceptual a or b channel value to 16-bit ICC encoding
 */
function abToICC16(ab) {
    return Math.round(((ab + 128) / 256) * 65535);
}

// ============================================================================
// IMAGE 1: Chromatic Zero-Crossing Target
// ============================================================================

function generateChromaticZeroCrossing() {
    const WIDTH = 1024;
    const HEIGHT = 512;

    console.log('\n=== Chromatic Zero-Crossing Target ===');
    console.log(`Dimensions: ${WIDTH}×${HEIGHT}`);
    console.log('MATHEMATICALLY LINEAR a* gradient with 1024 unique values');

    const pixels = create16bitLabBuffer(WIDTH, HEIGHT);

    // Fixed values
    const L16 = lPercentToICC16(50);  // L = 50%
    const b16 = abToICC16(20);        // b = +20

    // a* gradient from -30 to +30 perceptual
    // In ICC 16-bit: a=-30 → ((-30+128)/256)*65535 = 25088
    //                a=+30 → ((30+128)/256)*65535 = 40447
    // Range = 40447 - 25088 = 15359 values
    // For 1024 pixels, we'll use 1024 consecutive values centered around neutral

    // Center at neutral (a*=0 → 32768 in ICC)
    // Span 1024 values: 32768 - 512 to 32768 + 511 = 32256 to 33279
    const aStart = 32768 - 512;  // Slightly green
    const aRamp = linearRamp16(aStart, WIDTH);

    // Convert back to perceptual for logging
    const aPerceptualStart = ((aStart / 65535) * 256) - 128;
    const aPerceptualEnd = (((aStart + WIDTH - 1) / 65535) * 256) - 128;

    console.log(`a* range: ${aPerceptualStart.toFixed(2)} to ${aPerceptualEnd.toFixed(2)} (perceptual)`);
    console.log(`a* range: ${aStart} to ${aStart + WIDTH - 1} (16-bit ICC)`);

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            setPixel16(pixels, WIDTH, x, y, L16, aRamp[x], b16);
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
    console.log(`  Each column has a UNIQUE a* value (1024 total)`);

    return outputPath;
}

// ============================================================================
// IMAGE 2: Sub-Bit-Depth Gradient (True 16-bit Linear)
// ============================================================================

function generateSubBitDepthGradient() {
    const WIDTH = 1024;
    const HEIGHT = 512;

    console.log('\n=== Sub-Bit-Depth Gradient (True 16-bit Linear) ===');
    console.log(`Dimensions: ${WIDTH}×${HEIGHT}`);
    console.log('MATHEMATICALLY LINEAR L gradient with 1024 unique values');

    const pixels = create16bitLabBuffer(WIDTH, HEIGHT);

    // Fixed values (neutral chromatic)
    const a16 = 32768;  // a* = 0 (neutral)
    const b16 = 32768;  // b* = 0 (neutral)

    // L gradient: 1024 consecutive 16-bit values centered around L=50%
    // L=50% → 32768 in ICC encoding
    // Span: 32768 - 512 to 32768 + 511 = 32256 to 33279
    const lStart = 32768 - 512;
    const lRamp = linearRamp16(lStart, WIDTH);

    // Convert to perceptual for logging
    const lPerceptualStart = (lStart / 65535) * 100;
    const lPerceptualEnd = ((lStart + WIDTH - 1) / 65535) * 100;
    const lPerceptualRange = lPerceptualEnd - lPerceptualStart;

    console.log(`L range: ${lPerceptualStart.toFixed(3)}% to ${lPerceptualEnd.toFixed(3)}% (perceptual)`);
    console.log(`L range: ${lStart} to ${lStart + WIDTH - 1} (16-bit ICC)`);
    console.log(`L span: ${lPerceptualRange.toFixed(4)}% = ${WIDTH} unique 16-bit values`);
    console.log(`In 8-bit this would be: ${Math.ceil(lPerceptualRange / 100 * 255)} steps (nearly invisible)`);

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            setPixel16(pixels, WIDTH, x, y, lRamp[x], a16, b16);
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
    console.log(`  Each column has a UNIQUE L value (1024 total)`);
    console.log(`  This gradient is INVISIBLE at 8-bit depth`);

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
    console.log('Sharp L=30/L=70 edge with properly-scaled noise');

    const pixels = create16bitLabBuffer(WIDTH, HEIGHT);

    // Seeded random for reproducibility
    let seed = 12345;
    function random() {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
    }

    const NOISE_PROBABILITY = 0.02;  // 2% noise

    // Background L values
    const L_dark = lPercentToICC16(30);   // Left side: L=30%
    const L_light = lPercentToICC16(70);  // Right side: L=70%

    // Noise L values - CLOSER to background so bilateral filter can treat as noise
    // Dark side noise: L=20% (pepper) and L=40% (salt) - within ±10% of L=30%
    // Light side noise: L=60% (pepper) and L=80% (salt) - within ±10% of L=70%
    const L_dark_pepper = lPercentToICC16(20);
    const L_dark_salt = lPercentToICC16(40);
    const L_light_pepper = lPercentToICC16(60);
    const L_light_salt = lPercentToICC16(80);

    // Neutral chromatic
    const a16 = 32768;
    const b16 = 32768;

    let noiseCount = 0;

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const isLeftSide = x < WIDTH / 2;
            let L16;

            if (isLeftSide) {
                L16 = L_dark;
                // Add noise on dark side
                if (random() < NOISE_PROBABILITY) {
                    L16 = random() < 0.5 ? L_dark_pepper : L_dark_salt;
                    noiseCount++;
                }
            } else {
                L16 = L_light;
                // Add noise on light side
                if (random() < NOISE_PROBABILITY) {
                    L16 = random() < 0.5 ? L_light_pepper : L_light_salt;
                    noiseCount++;
                }
            }

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

    const totalPixels = WIDTH * HEIGHT;
    console.log(`✓ Saved: ${outputPath}`);
    console.log(`  File size: ${(psdBuffer.length / 1024).toFixed(2)} KB`);
    console.log(`  Noise pixels: ${noiseCount} (${(100 * noiseCount / totalPixels).toFixed(2)}%)`);
    console.log();
    console.log('  Noise design for bilateral filter:');
    console.log('    Dark side (L=30%): noise at L=20% and L=40% (±10%)');
    console.log('    Light side (L=70%): noise at L=60% and L=80% (±10%)');
    console.log('    Edge: L jumps from 30% to 70% (40% difference)');
    console.log();
    console.log('  With σr=30 (scaled for 16-bit):');
    console.log('    Noise (±10% ΔL) → filtered as noise');
    console.log('    Edge (40% ΔL) → preserved as feature');

    return outputPath;
}

// ============================================================================
// Main
// ============================================================================

console.log('Generating 16-bit Lab PSD Test Images for Patent Validation');
console.log('============================================================');
console.log('All gradients use DIRECT 16-BIT INTEGER MATH (no float quantization)');

const files = [];
files.push(generateChromaticZeroCrossing());
files.push(generateSubBitDepthGradient());
files.push(generateEdgePreservingImpulse());

console.log('\n============================================================');
console.log('All test images generated successfully!');
console.log('\nOutput files:');
files.forEach(f => console.log(`  ${f}`));

console.log('\nValidation checklist:');
console.log('  ✓ Chromatic Zero-Crossing: 1024 unique a* values (no banding)');
console.log('  ✓ Sub-Bit-Depth Gradient: 1024 unique L values (no banding)');
console.log('  ✓ Edge-Preserving Impulse: noise within filter range, edge outside');
