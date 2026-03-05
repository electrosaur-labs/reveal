#!/usr/bin/env node
/**
 * Create a simple test PSD with a gradient from black to white
 */

const fs = require('fs');
const { PSDWriter } = require('@electrosaur-labs/psd-writer');

const width = 100;
const height = 100;
const pixelCount = width * height;
const labPixels = new Uint8ClampedArray(pixelCount * 3);

// Create a gradient: black (top) to white (bottom)
for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
        const i = (y * width + x);
        const L = Math.floor((y / height) * 255);  // 0 (black) to 255 (white)

        labPixels[i * 3] = L;       // L
        labPixels[i * 3 + 1] = 128;  // a (neutral)
        labPixels[i * 3 + 2] = 128;  // b (neutral)
    }
}

const writer = new PSDWriter({
    width,
    height,
    colorMode: 'lab',
    bitsPerChannel: 16
});

writer.addPixelLayer({
    name: 'Gradient',
    pixels: labPixels,
    visible: true
});

const psdBuffer = writer.write();
fs.writeFileSync('test-gradient.psd', psdBuffer);

console.log('Created test-gradient.psd (100×100, gradient from black to white)');
console.log(`File size: ${(psdBuffer.length / 1024).toFixed(1)} KB`);
console.log('\nPlease open this file in Photoshop to verify it displays correctly.');
