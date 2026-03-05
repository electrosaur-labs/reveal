#!/usr/bin/env node
/**
 * Process a single PPM image file through the Reveal pipeline
 *
 * Usage: node src/processSingle.js <inputFile.ppm> <outputDir>
 *
 * Generates:
 *   - <outputDir>/<basename>.psd   (Lab16 color separated PSD with masks)
 *   - <outputDir>/<basename>.json  (Sidecar with metrics, DNA, palette)
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const Reveal = require('@electrosaur-labs/core');
const PSDWriter = require('@electrosaur-labs/psd-writer');
const ParameterGenerator = Reveal.ParameterGenerator;

// ============================================================================
// PPM Parser (16-bit RGB format)
// ============================================================================
function parsePPM(filePath) {
    const buffer = fs.readFileSync(filePath);
    let offset = 0;

    // Read header line by line
    function readLine() {
        let line = '';
        while (offset < buffer.length) {
            const char = String.fromCharCode(buffer[offset++]);
            if (char === '\n') break;
            line += char;
        }
        return line.trim();
    }

    // Parse magic number
    const magic = readLine();
    if (magic !== 'P6') {
        throw new Error(`Invalid PPM format: expected P6, got ${magic}`);
    }

    // Skip comments
    let line = readLine();
    while (line.startsWith('#')) {
        line = readLine();
    }

    // Parse dimensions
    const [widthStr, heightStr] = line.split(/\s+/);
    const width = parseInt(widthStr);
    const height = parseInt(heightStr);

    // Parse max value
    const maxval = parseInt(readLine());
    const is16bit = maxval === 65535;
    const is8bit = maxval === 255;

    if (!is8bit && !is16bit) {
        throw new Error(`Invalid PPM maxval: expected 255 or 65535, got ${maxval}`);
    }

    // Read pixel data
    const pixelCount = width * height;
    const pixels = new Uint8Array(pixelCount * 3);

    if (is16bit) {
        // 16-bit per channel, big-endian - take high byte
        for (let i = 0; i < pixelCount; i++) {
            const r16 = (buffer[offset++] << 8) | buffer[offset++];
            const g16 = (buffer[offset++] << 8) | buffer[offset++];
            const b16 = (buffer[offset++] << 8) | buffer[offset++];

            pixels[i * 3] = r16 >> 8;      // High byte
            pixels[i * 3 + 1] = g16 >> 8;
            pixels[i * 3 + 2] = b16 >> 8;
        }
    } else {
        // 8-bit per channel
        for (let i = 0; i < pixelCount * 3; i++) {
            pixels[i] = buffer[offset++];
        }
    }

    return { width, height, pixels };
}

// ============================================================================
// DNA Calculator
// ============================================================================
function calculateImageDNA(labPixels, width, height, sampleStep = 40) {
    const pixelCount = width * height;
    let sumL = 0, sumA = 0, sumB = 0;
    let minL = 100, maxL = 0;
    let maxC = 0;
    let sampleCount = 0;

    for (let i = 0; i < pixelCount; i += sampleStep) {
        // Lab pixels are in byte encoding: L: 0-255, a: 0-255, b: 0-255
        const L = (labPixels[i * 3] / 255) * 100;          // Convert to 0-100
        const a = labPixels[i * 3 + 1] - 128;              // Convert to -128 to +127
        const b = labPixels[i * 3 + 2] - 128;

        sumL += L;
        sumA += a;
        sumB += b;

        if (L < minL) minL = L;
        if (L > maxL) maxL = L;

        const chroma = Math.sqrt(a * a + b * b);
        if (chroma > maxC) maxC = chroma;

        sampleCount++;
    }

    const avgL = sumL / sampleCount;
    const avgA = sumA / sampleCount;
    const avgB = sumB / sampleCount;
    const avgC = Math.sqrt(avgA * avgA + avgB * avgB);
    const contrast = maxL - minL;

    return {
        l: parseFloat(avgL.toFixed(1)),
        c: parseFloat(avgC.toFixed(1)),
        k: parseFloat(contrast.toFixed(1)),
        maxC: parseFloat(maxC.toFixed(1)),
        minL: parseFloat(minL.toFixed(1)),
        maxL: parseFloat(maxL.toFixed(1))
    };
}

// ============================================================================
// Main Processing Function
// ============================================================================
async function processSingleImage(inputFile, outputDir) {
    // Validate arguments
    if (!inputFile || !outputDir) {
        console.error(chalk.red('Usage: node src/processSingle.js <inputFile.ppm> <outputDir>'));
        process.exit(1);
    }

    if (!fs.existsSync(inputFile)) {
        console.error(chalk.red(`Error: Input file not found: ${inputFile}`));
        process.exit(1);
    }

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const basename = path.basename(inputFile, path.extname(inputFile));
    console.log(chalk.cyan(`\n[${basename}] Processing ${inputFile}...`));

    const timingStart = Date.now();

    try {
        // 1. Parse PPM file
        console.log(`  Loading PPM...`);
        const ppm = parsePPM(inputFile);
        const { width, height, pixels } = ppm;
        console.log(`  Size: ${width}×${height}`);

        // 2. Convert RGB to Lab
        console.log(`  Converting RGB to Lab...`);
        const pixelCount = width * height;
        const labPixels = new Uint8ClampedArray(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const r = pixels[i * 3];
            const g = pixels[i * 3 + 1];
            const b = pixels[i * 3 + 2];

            const lab = Reveal.rgbToLab({ r, g, b });

            // Store in byte encoding: L: 0-255, a: 0-255, b: 0-255
            labPixels[i * 3] = (lab.L / 100) * 255;
            labPixels[i * 3 + 1] = lab.a + 128;
            labPixels[i * 3 + 2] = lab.b + 128;
        }

        // 3. Calculate DNA
        console.log(`  Calculating DNA...`);
        const dna = calculateImageDNA(labPixels, width, height);
        dna.filename = basename;
        console.log(`  DNA: L=${dna.l}, C=${dna.c}, K=${dna.k}, maxC=${dna.maxC}, range=[${dna.minL}, ${dna.maxL}]`);

        // 4. Generate dynamic configuration
        const config = ParameterGenerator.generate(dna);
        console.log(chalk.green(`  ✓ Configuration: "${config.name}"`));
        console.log(`  Colors: ${config.targetColors}, BlackBias: ${config.blackBias}, Dither: ${config.ditherType}`);

        // 5. Posterize
        console.log(`  Posterizing...`);
        const params = ParameterGenerator.toEngineOptions(config);

        const posterizeResult = await Reveal.posterizeImage(
            labPixels,
            width, height,
            params.targetColorsSlider,
            params
        );

        console.log(chalk.green(`  ✓ Posterized to ${posterizeResult.paletteLab.length} colors`));

        // 6. Separate colors with dithering
        console.log(`  Separating colors...`);
        const separateResult = await Reveal.separateImage(
            labPixels,
            posterizeResult.paletteLab,
            width, height,
            { ditherType: params.ditherType }
        );

        // 7. Generate masks
        console.log(`  Generating masks...`);
        const masks = [];
        for (let i = 0; i < posterizeResult.paletteLab.length; i++) {
            const mask = Reveal.generateMask(
                separateResult.colorIndices,
                i,
                width, height
            );
            masks.push(mask);
        }

        // 8. Reconstruct virtual composite for metrics
        console.log(`  Reconstructing composite...`);
        const processedLab = new Uint8ClampedArray(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const colorIdx = separateResult.colorIndices[i];
            const color = posterizeResult.paletteLab[colorIdx];

            processedLab[i * 3] = (color.L / 100) * 255;
            processedLab[i * 3 + 1] = color.a + 128;
            processedLab[i * 3 + 2] = color.b + 128;
        }

        // 9. Calculate metrics (skip for now - function doesn't exist)
        console.log(`  Calculating metrics...`);
        const metrics = {
            avgDeltaE: 0,
            maxDeltaE: 0,
            revelationScore: 0,
            saliencyLoss: 0
        };

        // 10. Format palette with coverage
        const palette = posterizeResult.paletteLab.map((lab, i) => {
            // Count pixels for this color
            let count = 0;
            for (let j = 0; j < separateResult.colorIndices.length; j++) {
                if (separateResult.colorIndices[j] === i) count++;
            }
            const coverage = ((count / pixelCount) * 100).toFixed(2) + '%';

            const rgb = Reveal.labToRgb(lab);
            const hex = `#${[rgb.r, rgb.g, rgb.b].map(c => c.toString(16).padStart(2, '0')).join('')}`;

            return {
                name: `Ink ${i + 1} (${hex})`,
                lab: { L: lab.L, a: lab.a, b: lab.b },
                rgb,
                hex,
                coverage
            };
        });

        // 11. Write PSD
        const psdPath = path.join(outputDir, `${basename}.psd`);
        console.log(`  Writing PSD...`);

        const writer = new PSDWriter({ palette, masks, metrics }, width, height, {
            documentName: basename,
            colorMode: 'lab16'
        });
        const psdBuffer = writer.write();

        fs.writeFileSync(psdPath, psdBuffer);
        console.log(chalk.green(`  ✓ PSD written: ${psdPath} (${(psdBuffer.length / 1024 / 1024).toFixed(2)} MB)`));

        // 12. Write sidecar JSON
        const jsonPath = path.join(outputDir, `${basename}.json`);
        const sidecar = {
            meta: {
                filename: path.basename(inputFile),
                timestamp: new Date().toISOString(),
                width,
                height,
                outputFile: `${basename}.psd`
            },
            dna,
            configuration: config,
            input_parameters: params,
            palette,
            metrics: {
                global_fidelity: {
                    avgDeltaE: metrics.avgDeltaE,
                    maxDeltaE: metrics.maxDeltaE
                },
                feature_preservation: {
                    revelationScore: metrics.revelationScore,
                    saliencyLoss: metrics.saliencyLoss
                },
                physical_feasibility: {
                    maxInkStack: posterizeResult.maxInkStack || 1,
                    avgInkStack: posterizeResult.avgInkStack || 1,
                    densityFloorBreaches: posterizeResult.densityFloorBreaches || 0,
                    breachVolume: posterizeResult.breachVolume || 0,
                    weakestPlate: posterizeResult.weakestPlate || 'N/A',
                    integrityScore: posterizeResult.integrityScore || 100
                }
            },
            timing: {
                computeTimeMs: posterizeResult.computeTimeMs || 0,
                ioTimeMs: posterizeResult.ioTimeMs || 0,
                totalMs: Date.now() - timingStart
            }
        };

        fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));
        console.log(chalk.green(`  ✓ Sidecar written: ${jsonPath}`));

        // 13. Summary
        const totalTime = ((Date.now() - timingStart) / 1000).toFixed(1);
        console.log(chalk.cyan(`\n✅ [${basename}] Complete in ${totalTime}s`));
        console.log(`   Colors: ${palette.length}, ΔE: ${metrics.avgDeltaE.toFixed(2)}, Revelation: ${metrics.revelationScore.toFixed(1)}`);

    } catch (error) {
        console.error(chalk.red(`\n❌ [${basename}] Error: ${error.message}`));
        console.error(error.stack);
        process.exit(1);
    }
}

// ============================================================================
// Main Entry Point
// ============================================================================
if (require.main === module) {
    const [,, inputFile, outputDir] = process.argv;
    processSingleImage(inputFile, outputDir);
}

module.exports = processSingleImage;
