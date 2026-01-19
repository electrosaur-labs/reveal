/**
 * Generate 16-bit Lab PSD Test File
 *
 * Creates a working 16-bit PSD with two intersecting circle outline masks.
 * This file has been validated to work correctly in Photoshop.
 *
 * Generated file: test/output/circle-test-16bit.psd
 */

const fs = require('fs');
const path = require('path');
const { PSDWriter } = require('../src');

const WIDTH = 800;
const HEIGHT = 800;

console.log('Generating 16-bit Lab PSD test file...\n');

/**
 * Create a circular outline mask (ring) with soft edges
 * @param {number} centerX - Circle center X
 * @param {number} centerY - Circle center Y
 * @param {number} radius - Circle radius
 * @param {number} thickness - Thickness of the outline
 * @param {number} feather - Feather distance for soft edges
 */
function createCircleOutlineMask(centerX, centerY, radius, thickness = 3, feather = 2) {
    const mask = new Uint8Array(WIDTH * HEIGHT);

    const innerRadius = radius - thickness / 2;
    const outerRadius = radius + thickness / 2;

    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const idx = y * WIDTH + x;
            const dx = x - centerX;
            const dy = y - centerY;
            const distance = Math.sqrt(dx * dx + dy * dy);

            let opacity;
            if (distance >= innerRadius - feather && distance <= outerRadius + feather) {
                // Within the ring area (with feather)
                if (distance >= innerRadius && distance <= outerRadius) {
                    // Solid ring
                    opacity = 255;
                } else if (distance < innerRadius) {
                    // Inner edge feather
                    const fadeAmount = (innerRadius - distance) / feather;
                    opacity = Math.round(255 * (1 - fadeAmount));
                } else {
                    // Outer edge feather
                    const fadeAmount = (distance - outerRadius) / feather;
                    opacity = Math.round(255 * (1 - fadeAmount));
                }
            } else {
                opacity = 0;
            }

            mask[idx] = opacity;
        }
    }

    return mask;
}

// Create two intersecting circle outline masks
const mask1 = createCircleOutlineMask(300, 400, 200, 40, 20);
const mask2 = createCircleOutlineMask(500, 400, 200, 40, 20);

console.log('Layer 1 (RED):');
console.log('  Mask: Circle OUTLINE centered at (300, 400), radius 200px, thickness 40px');
console.log('  Color: L=60, a=60, b=40 (red/orange)');

console.log('\nLayer 2 (BLUE):');
console.log('  Mask: Circle OUTLINE centered at (500, 400), radius 200px, thickness 40px');
console.log('  Color: L=60, a=-30, b=-50 (blue)');

// Create 16-bit Lab PSD
const writer = new PSDWriter({
    width: WIDTH,
    height: HEIGHT,
    colorMode: 'lab',
    bitsPerChannel: 16
});

// Add Layer 1 (bottom): RED circle outline on left
writer.addFillLayer({
    name: 'Red Circle (Left)',
    color: { L: 60, a: 60, b: 40 },  // Red/orange
    mask: mask1
});

// Add Layer 2 (top): BLUE circle outline on right
writer.addFillLayer({
    name: 'Blue Circle (Right)',
    color: { L: 60, a: -30, b: -50 },  // Blue
    mask: mask2
});

// Write PSD file
const psdBuffer = writer.write();

// Ensure output directory exists
const outputDir = path.join(__dirname, 'output');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

const outputPath = path.join(outputDir, 'circle-test-16bit.psd');
fs.writeFileSync(outputPath, psdBuffer);

console.log(`\n✓ Saved: ${outputPath}`);
console.log(`  File size: ${(psdBuffer.length / 1024).toFixed(2)} KB`);
console.log(`  Dimensions: ${WIDTH}×${HEIGHT}`);
console.log(`  Bits per channel: 16`);
console.log(`  Mask compression: Uncompressed (raw)`);

console.log('\nExpected result in Photoshop:');
console.log('  ✓ LEFT side: RED/ORANGE ring outline with smooth edges');
console.log('  ✓ RIGHT side: BLUE ring outline with smooth edges');
console.log('  ✓ CENTER: Overlapping area where both rings intersect');
console.log('  ✓ Background: WHITE where no rings are present');
console.log('  ✓ NO horizontal streaks or artifacts');
