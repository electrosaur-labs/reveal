/**
 * CQ100_PassportGenerator.js
 * Generates Image DNA Passport JSON sidecar files for each input PSD.
 *
 * Output: One .json file per input PSD in data/CQ100_v4/input/tiff/
 * Example: astronaut.psd → astronaut.json
 */

const fs = require('fs');
const path = require('path');
const Reveal = require('@electrosaur-labs/core');
const { parsePPM } = require('./ppmParser');
const chalk = require('chalk');

// Import ImageHeuristicAnalyzer for preset detection
const ImageHeuristicAnalyzer = Reveal.engines.ImageHeuristicAnalyzer;

// CONFIG
const INPUT_DIR = path.join(__dirname, '../data/CQ100_v4/input/ppm');
const OUTPUT_DIR = path.join(__dirname, '../data/CQ100_v4/input/psd');

/**
 * Determine hue family from angle
 */
function getHueFamily(angle) {
    if (angle >= 0 && angle < 30) return "Red";
    if (angle >= 30 && angle < 60) return "Orange";
    if (angle >= 60 && angle < 90) return "Yellow";
    if (angle >= 90 && angle < 150) return "Green";
    if (angle >= 150 && angle < 210) return "Cyan";
    if (angle >= 210 && angle < 270) return "Blue";
    if (angle >= 270 && angle < 330) return "Magenta";
    return "Red";
}

/**
 * Determine warm/cool bias
 */
function getHueBias(angle) {
    // Warm: 330-360, 0-150 (red, orange, yellow, yellow-green)
    // Cool: 150-330 (cyan, blue, magenta)
    if ((angle >= 330 && angle <= 360) || (angle >= 0 && angle < 150)) {
        return "warm-dominant";
    }
    return "cool-dominant";
}

/**
 * Determine lightness distribution bucket
 */
function getLightnessBucket(avgL) {
    if (avgL < 30) return "deep-shadow";
    if (avgL < 45) return "low-key";
    if (avgL < 60) return "mid-tone";
    if (avgL < 75) return "high-key";
    return "ultra-bright";
}

/**
 * Extract DNA and generate passport JSON
 */
function generatePassport(pixels, width, height, filename) {
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
    let totalL = 0, totalC = 0, totalL_Sq = 0, totalC_Sq = 0;
    let minL = 100, maxL = 0, maxC = 0;
    const hues = new Uint32Array(360);

    for (let i = 0; i < pixelCount; i++) {
        const L = labPixels[i * 3];
        const a = labPixels[i * 3 + 1];
        const b = labPixels[i * 3 + 2];
        const C = Math.sqrt(a * a + b * b);
        const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;

        totalL += L;
        totalL_Sq += L * L;
        totalC += C;
        totalC_Sq += C * C;

        if (L < minL) minL = L;
        if (L > maxL) maxL = L;
        if (C > maxC) maxC = C;

        hues[Math.floor(h)]++;
    }

    const avgL = totalL / pixelCount;
    const avgC = totalC / pixelCount;
    const varianceL = (totalL_Sq / pixelCount) - (avgL * avgL);
    const varianceC = (totalC_Sq / pixelCount) - (avgC * avgC);
    const contrastL = Math.sqrt(varianceL);

    // Find Dominant Hue
    let domHue = 0, maxHueCount = 0;
    for (let h = 0; h < 360; h++) {
        if (hues[h] > maxHueCount) {
            maxHueCount = hues[h];
            domHue = h;
        }
    }

    // Run ImageHeuristicAnalyzer for preset detection
    // Convert to byte-encoded Lab for analyzer
    const labPixelsBytes = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        labPixelsBytes[i * 3] = (labPixels[i * 3] / 100) * 255;
        labPixelsBytes[i * 3 + 1] = labPixels[i * 3 + 1] + 128;
        labPixelsBytes[i * 3 + 2] = labPixels[i * 3 + 2] + 128;
    }

    const analysis = ImageHeuristicAnalyzer.analyze(labPixelsBytes, width, height);

    // Build tags
    const tags = [];
    if (contrastL > 25) tags.push("High Contrast");
    if (contrastL < 15) tags.push("Low Contrast");
    if (avgC > 35) tags.push("Saturated");
    if (avgC < 15) tags.push("Desaturated");
    if (maxL - minL > 90) tags.push("Broad Dynamic Range");
    if (maxL - minL < 50) tags.push("Narrow Dynamic Range");
    if (maxC > 100) tags.push("Neon Colors");

    // Build flags
    const flags = {
        has_deep_blacks: minL < 5,
        has_specular_highlights: maxL > 95,
        is_gamut_risk: maxC > 100,
        is_low_chroma: avgC < 15,
        is_high_key: avgL > 70,
        is_low_key: avgL < 35
    };

    // Determine confidence (placeholder logic)
    const confidence = 0.85;  // Will be refined with cluster analysis

    // Build reasoning
    let reasoning = [];
    if (avgL < 35) {
        reasoning.push(`AvgL (${avgL.toFixed(1)}) < 35 indicates low-key/dark image`);
    }
    if (avgC > 35) {
        reasoning.push(`AvgC (${avgC.toFixed(1)}) > 35 indicates high saturation`);
    }
    if (maxC > 100) {
        reasoning.push(`MaxC (${maxC.toFixed(1)}) > 100 indicates neon/fluorescent colors`);
    }

    // Build passport JSON
    const passport = {
        meta: {
            schema_version: "1.0",
            filename: filename.replace('.ppm', '.psd'),
            timestamp: new Date().toISOString(),
            resolution: {
                width: width,
                height: height
            },
            colorMode: "lab",
            bitsPerChannel: 16
        },
        physical_dna: {
            lightness: {
                avg: parseFloat(avgL.toFixed(2)),
                min: parseFloat(minL.toFixed(2)),
                max: parseFloat(maxL.toFixed(2)),
                dynamic_range: parseFloat((maxL - minL).toFixed(2)),
                contrast_std_dev: parseFloat(contrastL.toFixed(2)),
                distribution_bucket: getLightnessBucket(avgL)
            },
            chroma: {
                avg: parseFloat(avgC.toFixed(2)),
                max: parseFloat(maxC.toFixed(2)),
                variance: parseFloat(varianceC.toFixed(2)),
                is_neon: maxC > 100
            },
            hue: {
                dominant_angle: domHue,
                primary_family: getHueFamily(domHue),
                bias: getHueBias(domHue)
            }
        },
        analysis_inference: {
            tags: tags,
            flags: flags
        },
        prescription: {
            recommended_preset: analysis.presetId,
            confidence_score: parseFloat(confidence.toFixed(2)),
            reasoning: reasoning.join(". ") + ".",
            overrides: {}
        }
    };

    return passport;
}

/**
 * Main function
 */
async function main() {
    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Get all PPM files
    const files = fs.readdirSync(INPUT_DIR)
        .filter(f => f.endsWith('.ppm'))
        .sort();

    console.log(chalk.bold(`\n🧬 CQ100 Image DNA Passport Generator`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Input:  ${INPUT_DIR}`);
    console.log(`Output: ${OUTPUT_DIR}`);
    console.log(`Files:  ${files.length} images\n`);

    const startTime = Date.now();
    let success = 0;
    let failed = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(INPUT_DIR, file);

        try {
            // Parse PPM
            const ppm = parsePPM(inputPath);
            const { width, height, pixels } = ppm;

            // Generate passport JSON
            const passport = generatePassport(pixels, width, height, file);

            // Write JSON sidecar
            const basename = path.basename(file, '.ppm');
            const outputPath = path.join(OUTPUT_DIR, `${basename}.json`);
            fs.writeFileSync(outputPath, JSON.stringify(passport, null, 2));

            success++;

            // Progress indicator
            if ((i + 1) % 10 === 0 || i === files.length - 1) {
                process.stdout.write(chalk.cyan(`\r  Progress: ${i + 1}/${files.length} passports generated...`));
            }
        } catch (error) {
            console.error(chalk.red(`\n  ✗ Error processing ${file}: ${error.message}`));
            failed++;
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(chalk.bold(`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(chalk.bold(`SUMMARY`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Total:   ${files.length}`);
    console.log(chalk.green(`Success: ${success}`));
    console.log(chalk.red(`Failed:  ${failed}`));
    console.log(`Time:    ${elapsed}s\n`);
}

main().catch(err => {
    console.error(chalk.red(`\n❌ Fatal error: ${err.message}`));
    console.error(err.stack);
    process.exit(1);
});
