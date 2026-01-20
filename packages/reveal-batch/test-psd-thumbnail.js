#!/usr/bin/env node
/**
 * Test PSD thumbnail generation
 * Creates a PSD with Resource 1036 (JPEG thumbnail) for Finder preview
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PSDWriter } = require('@reveal/psd-writer');
const { readPsd } = require('../reveal-psd-reader');

const testFile = process.argv[2] || 'data/SP100/output/loc/psd/loc_2014635594.psd';
const outputFile = testFile.replace(/\.psd$/, '-thumb.psd');

async function main() {
    console.log(`\n=== PSD Thumbnail Test ===`);
    console.log(`Input:  ${testFile}`);
    console.log(`Output: ${outputFile}\n`);

    // Step 1: Read Lab PSD
    console.log('Step 1: Reading Lab PSD...');
    const buffer = fs.readFileSync(testFile);
    const psd = readPsd(buffer);
    console.log(`  ✓ Read ${psd.width}×${psd.height}, ${psd.depth}-bit\n`);

    // Step 2: Convert Lab to RGB for thumbnail using sharp
    console.log('Step 2: Converting Lab to RGB for thumbnail...');

    // Create raw Lab buffer for sharp (need to convert byte-encoded Lab to proper Lab)
    // PSD byte encoding: L=0-255 (maps to 0-100), a/b=0-255 (maps to -128 to 127)
    const pixelCount = psd.width * psd.height;
    const rgbPixels = new Uint8Array(pixelCount * 3);

    // Simple Lab to RGB conversion (approximate, good enough for thumbnail)
    for (let i = 0; i < pixelCount; i++) {
        const L_byte = psd.data[i * 3];      // 0-255
        const a_byte = psd.data[i * 3 + 1];  // 0-255, 128=neutral
        const b_byte = psd.data[i * 3 + 2];  // 0-255, 128=neutral

        // Convert to perceptual Lab
        const L = (L_byte / 255) * 100;
        const a = a_byte - 128;
        const b = b_byte - 128;

        // Lab to XYZ
        let y = (L + 16) / 116;
        let x = a / 500 + y;
        let z = y - b / 200;

        const delta = 6 / 29;
        x = x > delta ? x * x * x : (x - 16 / 116) * 3 * delta * delta;
        y = y > delta ? y * y * y : (y - 16 / 116) * 3 * delta * delta;
        z = z > delta ? z * z * z : (z - 16 / 116) * 3 * delta * delta;

        // D50 white point
        x *= 0.96422;
        y *= 1.0;
        z *= 0.82521;

        // XYZ to sRGB (D50 adapted matrix)
        let r = x *  3.1338561 + y * -1.6168667 + z * -0.4906146;
        let g = x * -0.9787684 + y *  1.9161415 + z *  0.0334540;
        let bb = x *  0.0719453 + y * -0.2289914 + z *  1.4052427;

        // Gamma correction
        r = r > 0.0031308 ? 1.055 * Math.pow(r, 1/2.4) - 0.055 : 12.92 * r;
        g = g > 0.0031308 ? 1.055 * Math.pow(g, 1/2.4) - 0.055 : 12.92 * g;
        bb = bb > 0.0031308 ? 1.055 * Math.pow(bb, 1/2.4) - 0.055 : 12.92 * bb;

        // Clamp and store
        rgbPixels[i * 3] = Math.max(0, Math.min(255, Math.round(r * 255)));
        rgbPixels[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
        rgbPixels[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(bb * 255)));
    }

    console.log(`  ✓ Converted ${pixelCount} pixels to RGB\n`);

    // Step 3: Create thumbnail with sharp
    console.log('Step 3: Creating JPEG thumbnail...');
    const MAX_SIZE = 160;
    const ratio = Math.min(MAX_SIZE / psd.width, MAX_SIZE / psd.height);
    const thumbWidth = Math.round(psd.width * ratio);
    const thumbHeight = Math.round(psd.height * ratio);

    const jpegBuffer = await sharp(Buffer.from(rgbPixels), {
        raw: {
            width: psd.width,
            height: psd.height,
            channels: 3
        }
    })
    .resize(thumbWidth, thumbHeight)
    .jpeg({ quality: 85 })
    .toBuffer();

    console.log(`  ✓ Thumbnail: ${thumbWidth}×${thumbHeight}, ${jpegBuffer.length} bytes JPEG\n`);

    // Step 4: Write PSD with thumbnail
    console.log('Step 4: Writing PSD with thumbnail...');
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

    writer.setThumbnail({
        jpegData: jpegBuffer,
        width: thumbWidth,
        height: thumbHeight
    });

    const psdBuffer = writer.write();
    fs.writeFileSync(outputFile, psdBuffer);

    const outputSize = (psdBuffer.length / 1024).toFixed(1);
    console.log(`  ✓ Written ${outputSize} KB\n`);

    console.log('✅ SUCCESS: PSD with thumbnail created!');
    console.log(`\nOutput file: ${outputFile}`);
    console.log('\nCheck in macOS Finder if the thumbnail/QuickLook preview appears.\n');
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
