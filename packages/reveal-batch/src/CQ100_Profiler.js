/**
 * CQ100_Profiler.js
 * Extracts the "Physical DNA" of every image to determine natural presets.
 *
 * This is an unsupervised learning approach: instead of guessing boundaries
 * (e.g., "Is Noir L < 40?"), we extract features and let the data tell us
 * where the natural clusters are.
 */

const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const { parsePPM } = require('./ppmParser');
const chalk = require('chalk');

// CONFIG
const INPUT_DIR = path.join(__dirname, '../data/CQ100_v4/input/ppm');
const OUTPUT_CSV = path.join(__dirname, '../data/CQ100_v4/cq100_dna.csv');

/**
 * Extract DNA features from a single image
 */
function extractDNA(pixels, width, height) {
    // Convert RGB to Lab
    const pixelCount = width * height;
    const labPixels = new Float32Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        const r = pixels[i * 3];
        const g = pixels[i * 3 + 1];
        const b = pixels[i * 3 + 2];

        const lab = Reveal.rgbToLab({ r, g, b });

        // Store as perceptual Lab values (not byte-encoded)
        labPixels[i * 3] = lab.L;      // 0-100
        labPixels[i * 3 + 1] = lab.a;  // -128 to +127
        labPixels[i * 3 + 2] = lab.b;  // -128 to +127
    }

    // Extract features
    let totalL = 0, totalC = 0, totalL_Sq = 0;
    let minL = 100, maxL = 0, maxC = 0;

    // Hue Histograms (to detect Warm vs Cool bias)
    const hues = new Uint32Array(360);

    for (let i = 0; i < pixelCount; i++) {
        const L = labPixels[i * 3];
        const a = labPixels[i * 3 + 1];
        const b = labPixels[i * 3 + 2];
        const C = Math.sqrt(a * a + b * b);
        const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;

        // Accumulate Stats
        totalL += L;
        totalL_Sq += L * L;
        totalC += C;

        if (L < minL) minL = L;
        if (L > maxL) maxL = L;
        if (C > maxC) maxC = C;

        hues[Math.floor(h)]++;
    }

    const avgL = totalL / pixelCount;
    const avgC = totalC / pixelCount;
    const variance = (totalL_Sq / pixelCount) - (avgL * avgL);
    const contrast = Math.sqrt(variance); // Standard Deviation

    // Find Dominant Hue
    let domHue = 0, maxHueCount = 0;
    for (let h = 0; h < 360; h++) {
        if (hues[h] > maxHueCount) {
            maxHueCount = hues[h];
            domHue = h;
        }
    }

    return {
        avgL: avgL.toFixed(2),
        avgC: avgC.toFixed(2),
        maxC: maxC.toFixed(2),
        minL: minL.toFixed(2),
        maxL: maxL.toFixed(2),
        range: (maxL - minL).toFixed(2),
        contrast: contrast.toFixed(2),
        domHue: domHue
    };
}

/**
 * Main profiling function
 */
async function runProfile() {
    const files = fs.readdirSync(INPUT_DIR)
        .filter(f => f.endsWith('.ppm'))
        .sort();

    const csvRows = ['Filename,AvgL,AvgC,MaxC,MinL,MaxL,Range,Contrast,DominantHue'];

    console.log(chalk.bold(`\n🧬 CQ100 DNA Extractor`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Input:  ${INPUT_DIR}`);
    console.log(`Output: ${OUTPUT_CSV}`);
    console.log(`Files:  ${files.length} images\n`);

    const startTime = Date.now();

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(INPUT_DIR, file);

        try {
            // Parse PPM
            const ppm = parsePPM(inputPath);
            const { width, height, pixels } = ppm;

            // Extract DNA features
            const dna = extractDNA(pixels, width, height);

            const row = [
                file,
                dna.avgL,
                dna.avgC,
                dna.maxC,
                dna.minL,
                dna.maxL,
                dna.range,
                dna.contrast,
                dna.domHue
            ];

            csvRows.push(row.join(','));

            // Progress indicator
            if ((i + 1) % 10 === 0 || i === files.length - 1) {
                process.stdout.write(chalk.cyan(`\r  Progress: ${i + 1}/${files.length} images processed...`));
            }
        } catch (error) {
            console.error(chalk.red(`\n  ✗ Error processing ${file}: ${error.message}`));
        }
    }

    // Write CSV
    fs.writeFileSync(OUTPUT_CSV, csvRows.join('\n'));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(chalk.bold(`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(chalk.bold(`COMPLETE`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(chalk.green(`✅ DNA Extraction Complete: ${OUTPUT_CSV}`));
    console.log(`   Processed: ${files.length} images`);
    console.log(`   Time: ${elapsed}s\n`);
}

// Run profiling
runProfile().catch(err => {
    console.error(chalk.red(`\n❌ Fatal error: ${err.message}`));
    console.error(err.stack);
    process.exit(1);
});
