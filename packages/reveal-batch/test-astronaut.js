/**
 * Test single file: astronaut.ppm
 * Process and validate before running full batch
 */

const path = require('path');
const { processImage } = require('./src/processCQ100');

const inputPath = path.join(__dirname, 'data/CQ100_v4/input/ppm/astronaut.ppm');
const intermediatePsdDir = path.join(__dirname, 'data/CQ100_v4/input/psd');
const outputDir = path.join(__dirname, 'data/CQ100_v4/output/psd');

console.log('\n🧑‍🚀 Testing astronaut.ppm\n');
console.log('Input:', inputPath);
console.log('Output:', outputDir);
console.log();

processImage(inputPath, intermediatePsdDir, outputDir)
    .then((result) => {
        console.log('\n✅ Processing complete!');
        console.log('Result:', JSON.stringify(result, null, 2));
        console.log('\nPlease open and validate:');
        console.log(`  ${path.join(outputDir, 'astronaut.psd')}`);
        console.log('\nCheck for:');
        console.log('  - File opens in Photoshop without errors');
        console.log('  - Masks display correctly (no horizontal streaks)');
        console.log('  - Circles/shapes are smooth');
        console.log('  - Colors look correct');
    })
    .catch((err) => {
        console.error('\n❌ Error:', err.message);
        console.error(err.stack);
        process.exit(1);
    });
