#!/usr/bin/env node
/**
 * reveal-batch-preprocess.js
 * Batch processor with intelligent bilateral filter preprocessing.
 *
 * Usage: node reveal-batch-preprocess.js <input-dir> <output-dir>
 *
 * PERCEPTUAL RESCUE SYSTEM (3 Levels)
 * ===================================
 *
 * Level 1 - DNA (Archetype Detection):
 *   Handled by ParameterGenerator. Detects image type:
 *   Photographic, Vector/Flat, Vintage/Muted, Noir/Mono, Neon/Vibrant
 *
 * Level 2 - Entropy (Bilateral Filter):
 *   If entropy > 25, apply bilateral filter to reduce sensor noise.
 *   - Vector/Flat: NEVER filter (preserve sharp edges)
 *   - Photographic: Filter if entropy > 25
 *   - Noir/Mono: Filter if entropy > 25 (grayscale noise visible in halftones)
 *   - Vintage/Muted: Filter if entropy > 25 (noise rescue)
 *   - Neon/Vibrant: Filter if entropy > 30 (higher threshold)
 *
 * Level 3 - Complexity (CIE2000 Override):
 *   For complex Photographic images failing at CIE94, use CIE2000 for
 *   better perceptual grouping. (Handled by engine distanceMetric config)
 *
 * Filter Intensity:
 *   - entropy 25-40: Light filter (radius=3, sigmaR=30)
 *   - entropy > 40:  Heavy filter (radius=5, sigmaR=45)
 */
const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const { PSDWriter } = require('@reveal/psd-writer');
const { readPsd } = require('@reveal/psd-reader');
const ParameterGenerator = Reveal.ParameterGenerator;
const MetricsCalculator = require('./MetricsCalculator');
const BilateralFilter = Reveal.BilateralFilter;
const chalk = require('chalk');
const {
    convert8bitTo16bitLab,
    convertPsd16bitToEngineLab,
    convertEngine16bitTo8bitLab,
    rgbToHex,
    generateThumbnail
} = require('./batch-utils');

// === PREPROCESSING: BILATERAL FILTER ===

/**
 * Optimized Bilateral Filter for Reveal Engine
 * Uses an exponent lookup table and spatial stepping to save CPU cycles.
 */
function applyOptimizedBilateral(imageData, radius = 4, sigmaR = 30) {
    const { width, height, data } = imageData;
    const output = new Uint8ClampedArray(data.length);

    // 1. Pre-calculate Exponent Lookup Table for Range weights
    const rangeTable = new Float32Array(256 * 256 * 3);
    const rangeConstant = -1 / (2 * sigmaR * sigmaR);
    for (let i = 0; i < rangeTable.length; i++) {
        rangeTable[i] = Math.exp(i * rangeConstant);
    }

    // 2. Spatial Weight Table (Gaussian)
    const spatialTable = new Float32Array((radius * 2 + 1) * (radius * 2 + 1));
    const spatialConstant = -1 / (2 * radius * radius);
    let tableIdx = 0;
    for (let ky = -radius; ky <= radius; ky++) {
        for (let kx = -radius; kx <= radius; kx++) {
            spatialTable[tableIdx++] = Math.exp((kx * kx + ky * ky) * spatialConstant);
        }
    }

    // 3. Main Filter Loop
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const rC = data[i], gC = data[i + 1], bC = data[i + 2];

            let sumR = 0, sumG = 0, sumB = 0, wSum = 0;
            let sIdx = 0;

            for (let ky = -radius; ky <= radius; ky++) {
                const iy = y + ky;
                if (iy < 0 || iy >= height) { sIdx += (radius * 2 + 1); continue; }

                for (let kx = -radius; kx <= radius; kx++) {
                    const ix = x + kx;
                    const sWeight = spatialTable[sIdx++];

                    if (ix >= 0 && ix < width) {
                        const ni = (iy * width + ix) * 4;
                        const rN = data[ni], gN = data[ni+1], bN = data[ni+2];

                        // Perceptual Distance (Squared)
                        const dSq = (rC-rN)**2 + (gC-gN)**2 + (bC-bN)**2;
                        const weight = sWeight * rangeTable[dSq];

                        sumR += rN * weight;
                        sumG += gN * weight;
                        sumB += bN * weight;
                        wSum += weight;
                    }
                }
            }
            output[i] = sumR / wSum;
            output[i+1] = sumG / wSum;
            output[i+2] = sumB / wSum;
            output[i+3] = data[i+3];
        }
    }
    data.set(output);
}

/**
 * Computes the Local Entropy/Variance Score of an image.
 * Higher scores indicate "noisy" or "high-frequency" textures.
 */
function calculateEntropyScore(imageData) {
    const { width, height, data } = imageData;
    let totalVariance = 0;
    const sampleStep = 4;
    let samples = 0;

    for (let y = 1; y < height - 1; y += sampleStep) {
        for (let x = 1; x < width - 1; x += sampleStep) {
            const idx = (y * width + x) * 4;

            // Calculate Mean color of the 3x3 neighborhood
            let sumR = 0, sumG = 0, sumB = 0;
            for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {
                    const nIdx = ((y + ky) * width + (x + kx)) * 4;
                    sumR += data[nIdx];
                    sumG += data[nIdx + 1];
                    sumB += data[nIdx + 2];
                }
            }
            const meanR = sumR / 9;
            const meanG = sumG / 9;
            const meanB = sumB / 9;

            // Calculate Variance (Standard Deviation Squared)
            let variance = 0;
            for (let ky = -1; ky <= 1; ky++) {
                for (let kx = -1; kx <= 1; kx++) {
                    const nIdx = ((y + ky) * width + (x + kx)) * 4;
                    variance += (data[nIdx] - meanR) ** 2;
                    variance += (data[nIdx + 1] - meanG) ** 2;
                    variance += (data[nIdx + 2] - meanB) ** 2;
                }
            }

            totalVariance += Math.sqrt(variance / 9);
            samples++;
        }
    }

    return (totalVariance / samples);
}

/**
 * Determine if preprocessing should be applied based on DNA + entropy.
 * Returns { shouldProcess, reason, radius, sigmaR }
 *
 * PERCEPTUAL RESCUE SYSTEM - Level 2 (Entropy-based filtering)
 *
 * Level 1: DNA → Archetype detection (handled by ParameterGenerator)
 * Level 2: Entropy > 25 → Bilateral Filter (this function)
 * Level 3: CIE2000 Override → For complex images failing at CIE94 (handled by engine)
 *
 * Tiered filtering based on entropy:
 *   < 15:  Skip (pristine source - clean art)
 *   15-25: Skip (acceptable noise level)
 *   > 25:  Light filter (R:3, S:30) - removes sensor grain without over-smoothing
 *   > 40:  Heavy filter (R:5, S:45) - collapses noisy gradients
 */
function shouldPreprocess(dna, entropyScore) {
    const archetype = (dna.archetype || '').toLowerCase();
    const peakChroma = dna.maxC || dna.peakChroma || 0;

    // Vector/Flat: NEVER filter - preserve sharp edges
    if (archetype.includes('vector') || archetype.includes('flat')) {
        return { shouldProcess: false, reason: 'Vector/Flat - preserving sharp edges' };
    }

    // Low entropy (< 25): Skip filter - acceptable noise or clean art
    if (entropyScore < 25) {
        return { shouldProcess: false, reason: `Low entropy (${entropyScore.toFixed(1)}) - acceptable` };
    }

    // Determine filter intensity based on entropy level
    const getFilterParams = (entropy, chroma) => {
        if (entropy > 40) {
            // Heavy filter for very noisy images
            return { radius: 5, sigmaR: 45, intensity: 'heavy' };
        } else {
            // Light filter for moderate noise (25-40)
            // Slightly stronger if high chroma (intense texture)
            const radius = chroma > 90 ? 4 : 3;
            return { radius, sigmaR: 30, intensity: 'light' };
        }
    };

    // Photographic: Filter if entropy > 25
    if (archetype.includes('photo')) {
        const params = getFilterParams(entropyScore, peakChroma);
        return {
            shouldProcess: true,
            reason: `Photographic + entropy ${entropyScore.toFixed(1)} (${params.intensity} filter)`,
            radius: params.radius,
            sigmaR: params.sigmaR
        };
    }

    // Noir/Mono: Filter if entropy > 25 (grayscale noise visible in halftones)
    if (archetype.includes('noir') || archetype.includes('mono')) {
        const params = getFilterParams(entropyScore, peakChroma);
        return {
            shouldProcess: true,
            reason: `Noir/Mono + entropy ${entropyScore.toFixed(1)} (${params.intensity} filter)`,
            radius: params.radius,
            sigmaR: params.sigmaR
        };
    }

    // Vintage/Muted: Filter if entropy > 25 (noise rescue)
    if (archetype.includes('vintage') || archetype.includes('muted')) {
        const params = getFilterParams(entropyScore, peakChroma);
        // Extra aggressive if low chroma + very high entropy (likely sensor noise)
        if (peakChroma < 60 && entropyScore > 35) {
            return {
                shouldProcess: true,
                reason: `Vintage/Muted noise rescue (entropy=${entropyScore.toFixed(1)}, chroma=${peakChroma.toFixed(1)})`,
                radius: 4,
                sigmaR: 35
            };
        }
        return {
            shouldProcess: true,
            reason: `Vintage/Muted + entropy ${entropyScore.toFixed(1)} (${params.intensity} filter)`,
            radius: params.radius,
            sigmaR: params.sigmaR
        };
    }

    // Neon/Vibrant: Filter if entropy > 30 (higher threshold - preserve vibrant detail)
    if (archetype.includes('neon') || archetype.includes('vibrant')) {
        if (entropyScore > 30) {
            const params = getFilterParams(entropyScore, peakChroma);
            return {
                shouldProcess: true,
                reason: `Neon/Vibrant + entropy ${entropyScore.toFixed(1)} (${params.intensity} filter)`,
                radius: params.radius,
                sigmaR: params.sigmaR
            };
        }
        return { shouldProcess: false, reason: `Neon/Vibrant - preserving detail (entropy=${entropyScore.toFixed(1)})` };
    }

    // Default: Filter if entropy > 25
    const params = getFilterParams(entropyScore, peakChroma);
    return {
        shouldProcess: true,
        reason: `High entropy ${entropyScore.toFixed(1)} (${params.intensity} filter)`,
        radius: params.radius,
        sigmaR: params.sigmaR
    };
}

// === COLOR SPACE CONVERSIONS ===
// Standard Lab encoding conversions are imported from batch-utils.
// The following RGBA conversions are unique to preprocessing (bilateral filter operates in RGBA).

/**
 * Convert 8-bit Lab to RGBA for preprocessing
 */
function lab8bitToRgba(lab8bit, width, height) {
    const pixelCount = width * height;
    const rgba = new Uint8ClampedArray(pixelCount * 4);

    for (let i = 0; i < pixelCount; i++) {
        const L = (lab8bit[i * 3] / 255) * 100;
        const a = lab8bit[i * 3 + 1] - 128;
        const b = lab8bit[i * 3 + 2] - 128;

        // Lab to XYZ (D50)
        const fy = (L + 16) / 116;
        const fx = a / 500 + fy;
        const fz = fy - b / 200;

        const xr = fx > 0.206893 ? fx * fx * fx : (fx - 16/116) / 7.787;
        const yr = fy > 0.206893 ? fy * fy * fy : (fy - 16/116) / 7.787;
        const zr = fz > 0.206893 ? fz * fz * fz : (fz - 16/116) / 7.787;

        const X = xr * 96.422;
        const Y = yr * 100.0;
        const Z = zr * 82.521;

        // XYZ to sRGB (D50→D65 Bradford)
        let R =  3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
        let G = -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z;
        let B =  0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;

        R = R / 100;
        G = G / 100;
        B = B / 100;

        // sRGB gamma
        R = R > 0.0031308 ? 1.055 * Math.pow(Math.max(0, R), 1/2.4) - 0.055 : 12.92 * R;
        G = G > 0.0031308 ? 1.055 * Math.pow(Math.max(0, G), 1/2.4) - 0.055 : 12.92 * G;
        B = B > 0.0031308 ? 1.055 * Math.pow(Math.max(0, B), 1/2.4) - 0.055 : 12.92 * B;

        rgba[i * 4] = Math.max(0, Math.min(255, Math.round(R * 255)));
        rgba[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(G * 255)));
        rgba[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(B * 255)));
        rgba[i * 4 + 3] = 255;
    }

    return rgba;
}

/**
 * Convert RGBA back to 8-bit Lab after preprocessing
 */
function rgbaToLab8bit(rgba, width, height) {
    const pixelCount = width * height;
    const lab8bit = new Uint8Array(pixelCount * 3);

    for (let i = 0; i < pixelCount; i++) {
        let R = rgba[i * 4] / 255;
        let G = rgba[i * 4 + 1] / 255;
        let B = rgba[i * 4 + 2] / 255;

        // sRGB inverse gamma
        R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
        G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
        B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;

        R *= 100;
        G *= 100;
        B *= 100;

        // sRGB to XYZ (D65→D50 Bradford)
        const X = 0.4360747 * R + 0.3850649 * G + 0.1430804 * B;
        const Y = 0.2225045 * R + 0.7168786 * G + 0.0606169 * B;
        const Z = 0.0139322 * R + 0.0971045 * G + 0.7141733 * B;

        // XYZ to Lab (D50)
        const xr = X / 96.422;
        const yr = Y / 100.0;
        const zr = Z / 82.521;

        const fx = xr > 0.008856 ? Math.pow(xr, 1/3) : (7.787 * xr) + 16/116;
        const fy = yr > 0.008856 ? Math.pow(yr, 1/3) : (7.787 * yr) + 16/116;
        const fz = zr > 0.008856 ? Math.pow(zr, 1/3) : (7.787 * zr) + 16/116;

        const L = (116 * fy) - 16;
        const a = 500 * (fx - fy);
        const b = 200 * (fy - fz);

        // Convert to 8-bit encoding
        lab8bit[i * 3] = Math.max(0, Math.min(255, Math.round((L / 100) * 255)));
        lab8bit[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(a + 128)));
        lab8bit[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(b + 128)));
    }

    return lab8bit;
}

/**
 * Calculate image DNA from 8-bit Lab data
 * @deprecated Use calculateImageDNA16 for 16-bit Lab pipelines
 */
function calculateImageDNA(lab8bit, width, height, sampleStep = 40) {
    const pixelCount = width * height;
    let sumL = 0, sumC = 0;
    let minL = 100, maxL = 0, maxC = 0;
    let sampleCount = 0;
    const lValues = [];

    for (let i = 0; i < pixelCount; i += sampleStep) {
        const L = (lab8bit[i * 3] / 255) * 100;
        const a = lab8bit[i * 3 + 1] - 128;
        const b = lab8bit[i * 3 + 2] - 128;
        const C = Math.sqrt(a * a + b * b);

        sumL += L;
        sumC += C;
        lValues.push(L);
        if (L < minL) minL = L;
        if (L > maxL) maxL = L;
        if (C > maxC) maxC = C;
        sampleCount++;
    }

    const avgL = sumL / sampleCount;
    const avgC = sumC / sampleCount;
    const lVariance = lValues.reduce((sum, l) => sum + Math.pow(l - avgL, 2), 0) / sampleCount;
    const lStdDev = Math.sqrt(lVariance);

    return {
        l: parseFloat(avgL.toFixed(1)),
        c: parseFloat(avgC.toFixed(1)),
        k: parseFloat((maxL - minL).toFixed(1)),
        minL: parseFloat(minL.toFixed(1)),
        maxL: parseFloat(maxL.toFixed(1)),
        maxC: parseFloat(maxC.toFixed(1)),
        l_std_dev: parseFloat(lStdDev.toFixed(1))
    };
}

/**
 * Calculate image DNA from 16-bit Lab data
 * 16-bit Lab encoding: L = 0-32768 (maps to 0-100), a/b = 0-32768 with 16384 = neutral
 */
function calculateImageDNA16(lab16bit, width, height, sampleStep = 40) {
    const pixelCount = width * height;
    const maxValue = 32768;
    const neutralAB = 16384;
    const abScale = 128 / 16384;

    let sumL = 0, sumC = 0;
    let minL = 100, maxL = 0, maxC = 0;
    let sampleCount = 0;
    const lValues = [];

    for (let i = 0; i < pixelCount; i += sampleStep) {
        const L = (lab16bit[i * 3] / maxValue) * 100;
        const a = (lab16bit[i * 3 + 1] - neutralAB) * abScale;
        const b = (lab16bit[i * 3 + 2] - neutralAB) * abScale;
        const C = Math.sqrt(a * a + b * b);

        sumL += L;
        sumC += C;
        lValues.push(L);
        if (L < minL) minL = L;
        if (L > maxL) maxL = L;
        if (C > maxC) maxC = C;
        sampleCount++;
    }

    const avgL = sumL / sampleCount;
    const avgC = sumC / sampleCount;
    const lVariance = lValues.reduce((sum, l) => sum + Math.pow(l - avgL, 2), 0) / sampleCount;
    const lStdDev = Math.sqrt(lVariance);

    return {
        l: parseFloat(avgL.toFixed(1)),
        c: parseFloat(avgC.toFixed(1)),
        k: parseFloat((maxL - minL).toFixed(1)),
        minL: parseFloat(minL.toFixed(1)),
        maxL: parseFloat(maxL.toFixed(1)),
        maxC: parseFloat(maxC.toFixed(1)),
        l_std_dev: parseFloat(lStdDev.toFixed(1))
    };
}

/**
 * Process a single Lab PSD with optional preprocessing
 */
async function processImage(inputPath, outputDir) {
    const basename = path.basename(inputPath, '.psd');
    console.log(chalk.cyan(`\n[${basename}] Processing...`));

    const timingStart = Date.now();
    let preprocessed = false;
    let preprocessReason = '';

    try {
        // 1. Read Lab PSD - get raw Lab data
        const buffer = fs.readFileSync(inputPath);
        const psd = readPsd(buffer);
        const { width, height, depth, data: labData } = psd;
        const pixelCount = width * height;

        console.log(`  Size: ${width}×${height} (${depth}-bit Lab)`);

        // 2. Ensure 16-bit Lab format (engine operates exclusively in 16-bit Lab)
        // PSD files use ICC Lab encoding (0-65535), but engines expect Photoshop encoding (0-32768)
        let lab16bit;
        if (depth === 16) {
            // Create mutable copy and normalize from ICC Lab (0-65535) to Photoshop Lab (0-32768)
            // ICC 16-bit Lab: L=0-65535, a/b=0-65535 (neutral=32768)
            // Photoshop 16-bit Lab: L=0-32768, a/b=0-32768 (neutral=16384)
            const rawData = new Uint16Array(labData.buffer, labData.byteOffset, pixelCount * 3);
            lab16bit = convertPsd16bitToEngineLab(rawData, pixelCount);
            console.log(`  Normalized ICC Lab (0-65535) → Photoshop Lab (0-32768)`);
        } else {
            // Convert 8-bit to 16-bit Lab (8-bit encoding is same in ICC and Photoshop)
            console.log(`  Converting ${depth}-bit Lab to 16-bit...`);
            lab16bit = convert8bitTo16bitLab(new Uint8Array(labData), pixelCount);
        }

        // 3. Calculate image DNA from 16-bit Lab (no conversion needed)
        console.log(`  Calculating image DNA...`);
        const dna = calculateImageDNA16(lab16bit, width, height);
        dna.filename = basename;

        // 4. Generate config to get archetype
        const config = ParameterGenerator.generate(dna);
        dna.archetype = config.meta?.archetype || 'unknown';

        console.log(`  DNA: L=${dna.l}, C=${dna.c}, K=${dna.k}, StdDev=${dna.l_std_dev}, maxC=${dna.maxC}`);
        console.log(chalk.green(`  ✓ Archetype: ${dna.archetype}`));

        // 5. Calculate entropy from 16-bit Lab L channel (no RGBA conversion)
        console.log(`  Calculating entropy score...`);
        const entropyScore = BilateralFilter.calculateEntropyScoreLab(lab16bit, width, height);
        dna.entropy = parseFloat(entropyScore.toFixed(1));
        console.log(`  Entropy: ${dna.entropy}`);

        // 6. Determine if preprocessing is needed (using @reveal/core decision logic)
        const preprocessDecision = BilateralFilter.shouldPreprocess(dna, entropyScore);

        if (preprocessDecision.shouldProcess) {
            console.log(chalk.yellow(`  ⚡ Preprocessing: ${preprocessDecision.reason}`));
            console.log(`     Bilateral filter: radius=${preprocessDecision.radius}, sigmaR=${preprocessDecision.sigmaR}`);

            const preprocessStart = Date.now();

            // Apply bilateral filter directly on 16-bit Lab data (no RGBA conversion)
            BilateralFilter.applyBilateralFilterLab(
                lab16bit,
                width,
                height,
                preprocessDecision.radius,
                preprocessDecision.sigmaR
            );

            const preprocessTime = Date.now() - preprocessStart;
            console.log(chalk.green(`  ✓ Preprocessing complete (${preprocessTime}ms)`));

            preprocessed = true;
            preprocessReason = preprocessDecision.reason;
        } else {
            console.log(chalk.dim(`  ○ Skipping preprocessing: ${preprocessDecision.reason}`));
            preprocessReason = preprocessDecision.reason;
        }

        // Lab data is already in 16-bit format - no conversion needed

        // 8. Continue with standard posterization pipeline
        console.log(`  Colors: ${config.targetColors}, BlackBias: ${config.blackBias}, Dither: ${config.ditherType}`);

        const params = ParameterGenerator.toEngineOptions(config, { bitDepth: depth });

        // 9. Posterize
        console.log(`  Posterizing to ${params.targetColorsSlider} colors...`);
        const posterizeResult = await Reveal.posterizeImage(
            lab16bit,
            width, height,
            params.targetColorsSlider,
            params
        );

        console.log(`  ✓ Generated ${posterizeResult.paletteLab.length} colors`);

        // 10. Separate into layers
        console.log(`  Separating layers...`);
        const separateResult = await Reveal.separateImage(
            lab16bit,
            posterizeResult.paletteLab,
            width, height,
            { ditherType: params.ditherType }
        );

        // 11. Generate masks
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

        // 12. Reconstruct virtual composite for metrics
        console.log(`  Reconstructing virtual composite...`);
        const processedLab = new Uint8ClampedArray(pixelCount * 3);

        for (let i = 0; i < pixelCount; i++) {
            const colorIdx = separateResult.colorIndices[i];
            const color = posterizeResult.paletteLab[colorIdx];
            processedLab[i * 3] = (color.L / 100) * 255;
            processedLab[i * 3 + 1] = color.a + 128;
            processedLab[i * 3 + 2] = color.b + 128;
        }

        // Convert 16-bit Lab to 8-bit for output (PSD writing, metrics, thumbnail)
        // Note: All processing was done in 16-bit; 8-bit is only for legacy output formats
        const lab8bit = convertEngine16bitTo8bitLab(lab16bit, pixelCount);

        // 13. Calculate metrics
        console.log(`  Computing validation metrics...`);
        const layers = masks.map((mask, i) => ({
            name: `Ink ${i + 1}`,
            color: posterizeResult.paletteLab[i],
            mask: mask
        }));

        const metrics = MetricsCalculator.compute(
            lab8bit,
            processedLab,
            layers,
            width,
            height
        );

        // 14. Calculate coverage
        const coverageCounts = new Uint32Array(posterizeResult.paletteLab.length);
        for (let i = 0; i < pixelCount; i++) {
            coverageCounts[separateResult.colorIndices[i]]++;
        }

        const palette = posterizeResult.paletteLab.map((color, idx) => {
            const rgbColor = posterizeResult.palette[idx];
            const hex = rgbToHex(rgbColor.r, rgbColor.g, rgbColor.b);
            const coverage = ((coverageCounts[idx] / pixelCount) * 100).toFixed(2);

            return {
                name: `Ink ${idx + 1} (${hex})`,
                lab: { L: parseFloat(color.L.toFixed(2)), a: parseFloat(color.a.toFixed(2)), b: parseFloat(color.b.toFixed(2)) },
                rgb: { r: Math.round(rgbColor.r), g: Math.round(rgbColor.g), b: Math.round(rgbColor.b) },
                hex: hex,
                coverage: `${coverage}%`
            };
        });

        // 15. Write output PSD
        console.log(`  Writing PSD...`);
        const outputPsdPath = path.join(outputDir, `${basename}.psd`);
        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 8,
            documentName: basename
        });

        // Add original as invisible reference layer
        writer.addPixelLayer({
            name: 'Original Image (Reference)',
            pixels: lab8bit,
            visible: false
        });

        // Sort layers by lightness
        const layersToWrite = posterizeResult.paletteLab.map((color, i) => ({
            index: i,
            color: color,
            rgb: posterizeResult.palette[i],
            mask: masks[i],
            coverage: coverageCounts[i]
        }));
        layersToWrite.sort((a, b) => b.color.L - a.color.L);

        console.log(`  Layer order (bottom→top):`);
        layersToWrite.forEach((layer, idx) => {
            const hex = rgbToHex(layer.rgb.r, layer.rgb.g, layer.rgb.b);
            const pct = ((layer.coverage / pixelCount) * 100).toFixed(2);
            console.log(`    ${idx + 1}. ${hex} - L=${layer.color.L.toFixed(1)}, Coverage=${pct}%`);
        });

        // Add fill+mask layers
        for (const layer of layersToWrite) {
            const hex = rgbToHex(layer.rgb.r, layer.rgb.g, layer.rgb.b);
            writer.addFillLayer({
                name: `Color ${layer.index + 1} (${hex})`,
                color: layer.color,
                mask: layer.mask
            });
        }

        // Generate thumbnail
        console.log(`  Generating thumbnail...`);
        const thumbnail = await generateThumbnail(lab8bit, width, height);
        writer.setThumbnail(thumbnail);

        const psdBuffer = writer.write();
        fs.writeFileSync(outputPsdPath, psdBuffer);
        console.log(chalk.green(`  ✓ Saved: ${outputPsdPath} (${(psdBuffer.length / 1024).toFixed(1)} KB)`));

        // 16. Write sidecar JSON
        const jsonPath = path.join(outputDir, `${basename}.json`);
        const sidecar = {
            meta: {
                filename: path.basename(inputPath),
                timestamp: new Date().toISOString(),
                width, height, depth,
                outputFile: `${basename}.psd`
            },
            dna,
            preprocessing: {
                applied: preprocessed,
                reason: preprocessReason,
                entropyScore: dna.entropy
            },
            configuration: config,
            input_parameters: params,
            palette,
            metrics: metrics,
            timing: {
                totalMs: Date.now() - timingStart
            }
        };
        fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));
        console.log(chalk.green(`  ✓ Sidecar: ${jsonPath}`));

        return {
            success: true,
            filename: basename,
            colors: palette.length,
            avgDeltaE: metrics.global_fidelity.avgDeltaE,
            preprocessed,
            entropyScore: dna.entropy,
            timing: Date.now() - timingStart
        };

    } catch (error) {
        console.error(chalk.red(`  ✗ Error: ${error.message}`));
        return {
            success: false,
            filename: basename,
            error: error.message
        };
    }
}

/**
 * Main batch processing
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length < 2) {
        console.log(chalk.yellow(`
Usage: node reveal-batch-preprocess.js <input-dir> <output-dir>

Arguments:
  input-dir   Directory containing Lab PSDs (8-bit or 16-bit)
  output-dir  Directory for processed PSDs and validation JSONs

Preprocessing is applied selectively based on Image DNA + Entropy:
  - Photographic + entropy > 25: Bilateral filter
  - Noir/Mono: Always filter (grayscale noise)
  - Vector/Flat: Never filter (preserve edges)
  - Vintage/Muted + high entropy + low chroma: Noise rescue filter

Example:
  node reveal-batch-preprocess.js data/CQ100_v4/input/psd/8bit data/CQ100_v4/output/8bit-preprocessed
`));
        process.exit(1);
    }

    const inputDir = path.resolve(args[0]);
    const outputDir = path.resolve(args[1]);

    // Validate input directory
    if (!fs.existsSync(inputDir)) {
        console.error(chalk.red(`Error: Input directory does not exist: ${inputDir}`));
        process.exit(1);
    }

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Get all PSD files
    const files = fs.readdirSync(inputDir)
        .filter(f => f.endsWith('.psd'))
        .sort();

    if (files.length === 0) {
        console.error(chalk.red(`Error: No PSD files found in ${inputDir}`));
        process.exit(1);
    }

    console.log(chalk.bold(`\n🎨 Reveal Batch Processor (with Preprocessing)`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Input:  ${inputDir}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Files:  ${files.length} images\n`);

    const results = [];
    const startTime = Date.now();

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(inputDir, file);

        console.log(chalk.bold(`\n[${i + 1}/${files.length}] ${file}`));
        const result = await processImage(inputPath, outputDir);
        results.push(result);
    }

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);
    const preprocessedCount = successResults.filter(r => r.preprocessed).length;

    console.log(chalk.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(chalk.bold(`📊 SUMMARY`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Total:         ${files.length} images`);
    console.log(chalk.green(`Success:       ${successResults.length}`));
    console.log(chalk.red(`Failed:        ${failedResults.length}`));
    console.log(chalk.yellow(`Preprocessed:  ${preprocessedCount} (${((preprocessedCount / successResults.length) * 100).toFixed(1)}%)`));
    console.log(`Time:          ${elapsed}s`);
    console.log(`Avg:           ${(elapsed / files.length).toFixed(2)}s per image\n`);

    if (successResults.length > 0) {
        const avgDeltaE = successResults.reduce((sum, r) => sum + (r.avgDeltaE || 0), 0) / successResults.length;
        const avgEntropy = successResults.reduce((sum, r) => sum + (r.entropyScore || 0), 0) / successResults.length;
        console.log(`Avg ΔE:        ${avgDeltaE.toFixed(2)}`);
        console.log(`Avg Entropy:   ${avgEntropy.toFixed(1)}`);
    }

    // Save batch report
    const reportPath = path.join(outputDir, 'batch-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        inputDir,
        outputDir,
        preprocessing: true,
        total: files.length,
        success: successResults.length,
        failed: failedResults.length,
        preprocessed: preprocessedCount,
        elapsedSeconds: parseFloat(elapsed),
        avgDeltaE: successResults.length > 0
            ? successResults.reduce((sum, r) => sum + (r.avgDeltaE || 0), 0) / successResults.length
            : 0,
        avgEntropy: successResults.length > 0
            ? successResults.reduce((sum, r) => sum + (r.entropyScore || 0), 0) / successResults.length
            : 0,
        results: successResults,
        errors: failedResults.map(r => ({ filename: r.filename, error: r.error }))
    }, null, 2));

    console.log(chalk.green(`✓ Report saved: ${reportPath}\n`));
}

// Run if called directly
if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(`\n❌ Fatal error: ${err.message}`));
        console.error(err.stack);
        process.exit(1);
    });
}

module.exports = { processImage, applyOptimizedBilateral, calculateEntropyScore, shouldPreprocess };
