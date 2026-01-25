#!/usr/bin/env node
/**
 * Test Bilateral Filter on Patent Validation Images
 *
 * Runs the 16-bit Lab bilateral filter on the three generated test images
 * and verifies expected behavior:
 *
 * 1. Chromatic Zero-Crossing: Filter should preserve chromatic gradient (1024 unique a* values)
 * 2. Sub-Bit-Depth Gradient: Filter should preserve 16-bit precision (1024 unique L values)
 * 3. Edge-Preserving Impulse: Filter should smooth ±10% noise but preserve 40% edge
 */

const fs = require('fs');
const path = require('path');
const { readPsd } = require('../../reveal-psd-reader');
const {
    calculateEntropyScoreLab,
    applyBilateralFilterLab
} = require('../../reveal-core/lib/preprocessing/BilateralFilter');

const inputDir = path.join(__dirname, 'output', 'patent-test-images');

/**
 * Convert ICC 16-bit Lab (0-65535) to Photoshop 16-bit (0-32768)
 * The bilateral filter expects Photoshop encoding
 */
function iccToPhotoshop16(iccData) {
    const psData = new Uint16Array(iccData.length);
    for (let i = 0; i < iccData.length; i++) {
        psData[i] = Math.round(iccData[i] / 2);
    }
    return psData;
}

/**
 * Calculate statistics for a channel
 */
function channelStats(data, stride, offset, count) {
    let min = Infinity, max = -Infinity, sum = 0;
    const values = new Set();

    for (let i = 0; i < count; i++) {
        const val = data[i * stride + offset];
        if (val < min) min = val;
        if (val > max) max = val;
        sum += val;
        values.add(val);
    }

    return {
        min,
        max,
        mean: sum / count,
        uniqueValues: values.size
    };
}

/**
 * Calculate edge sharpness metric (average gradient at edge)
 */
function measureEdgeSharpness(labData, width, height, edgeX) {
    let totalGradient = 0;
    let count = 0;

    for (let y = 0; y < height; y++) {
        const leftIdx = (y * width + (edgeX - 1)) * 3;
        const rightIdx = (y * width + edgeX) * 3;

        const leftL = labData[leftIdx];
        const rightL = labData[rightIdx];

        totalGradient += Math.abs(rightL - leftL);
        count++;
    }

    return totalGradient / count;
}

/**
 * Count noise pixels based on deviation from expected background values
 * For the edge-preserving test:
 *   - Left side background: L=30% (PS encoding: 9830)
 *   - Right side background: L=70% (PS encoding: 22938)
 *   - Noise: anything deviating by more than tolerance
 */
function countNoisePixelsEdge(labData, width, height, darkBgPS, lightBgPS, tolerance) {
    let noiseCount = 0;
    const halfWidth = width / 2;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 3;
            const L = labData[idx];

            if (x < halfWidth) {
                // Left side - should be darkBgPS
                if (Math.abs(L - darkBgPS) > tolerance) {
                    noiseCount++;
                }
            } else {
                // Right side - should be lightBgPS
                if (Math.abs(L - lightBgPS) > tolerance) {
                    noiseCount++;
                }
            }
        }
    }

    return noiseCount;
}

// ============================================================================
// Test 1: Chromatic Zero-Crossing
// ============================================================================

function testChromaticZeroCrossing() {
    console.log('\n' + '='.repeat(70));
    console.log('TEST 1: Chromatic Zero-Crossing Target');
    console.log('='.repeat(70));

    const inputPath = path.join(inputDir, 'chromatic-zero-crossing.psd');
    if (!fs.existsSync(inputPath)) {
        console.log('ERROR: Test image not found. Run generate-patent-test-images.js first.');
        return false;
    }

    const buffer = fs.readFileSync(inputPath);
    const psd = readPsd(buffer);

    console.log(`Dimensions: ${psd.width}×${psd.height}`);
    console.log(`Bit depth: ${psd.depth}`);

    // Convert to Uint16Array and normalize ICC → Photoshop
    const rawData = new Uint16Array(psd.data.buffer, psd.data.byteOffset, psd.width * psd.height * 3);
    const labData = iccToPhotoshop16(rawData);

    const pixelCount = psd.width * psd.height;
    const beforeL = channelStats(labData, 3, 0, pixelCount);
    const beforeA = channelStats(labData, 3, 1, pixelCount);
    const beforeB = channelStats(labData, 3, 2, pixelCount);

    console.log('\nBefore filtering:');
    console.log(`  L: min=${beforeL.min}, max=${beforeL.max}, unique=${beforeL.uniqueValues}`);
    console.log(`  a: min=${beforeA.min}, max=${beforeA.max}, unique=${beforeA.uniqueValues}`);
    console.log(`  b: min=${beforeB.min}, max=${beforeB.max}, unique=${beforeB.uniqueValues}`);

    const entropyBefore = calculateEntropyScoreLab(labData, psd.width, psd.height);
    console.log(`  Entropy score: ${entropyBefore.toFixed(2)}`);

    // Verify we have many unique a* values (linear gradient from -30 to +30)
    // Range is ~15000 ICC values, which becomes ~7500 PS values after /2
    // Over 1024 pixels = ~7.3 PS values per pixel step
    // Should have close to 1024 unique values
    const hasLinearGradientA = beforeA.uniqueValues >= psd.width * 0.9;
    console.log(`  ✓ Linear gradient check: ${hasLinearGradientA ? 'PASS' : 'FAIL'} (${beforeA.uniqueValues} unique a* values, expected ~${psd.width})`);

    // Apply filter (light params for clean image)
    applyBilateralFilterLab(labData, psd.width, psd.height, 3, 30);

    const afterL = channelStats(labData, 3, 0, pixelCount);
    const afterA = channelStats(labData, 3, 1, pixelCount);
    const afterB = channelStats(labData, 3, 2, pixelCount);

    console.log('\nAfter filtering:');
    console.log(`  L: min=${afterL.min}, max=${afterL.max}, unique=${afterL.uniqueValues}`);
    console.log(`  a: min=${afterA.min}, max=${afterA.max}, unique=${afterA.uniqueValues}`);
    console.log(`  b: min=${afterB.min}, max=${afterB.max}, unique=${afterB.uniqueValues}`);

    const entropyAfter = calculateEntropyScoreLab(labData, psd.width, psd.height);
    console.log(`  Entropy score: ${entropyAfter.toFixed(2)}`);

    // Validation
    console.log('\nValidation:');

    const lPreserved = Math.abs(afterL.min - beforeL.min) < 100 && Math.abs(afterL.max - beforeL.max) < 100;
    console.log(`  ✓ L channel preserved: ${lPreserved ? 'PASS' : 'FAIL'}`);

    // a gradient should preserve most unique values (>95%)
    const aPreserved = afterA.uniqueValues > beforeA.uniqueValues * 0.95;
    console.log(`  ✓ a* gradient preserved: ${aPreserved ? 'PASS' : 'FAIL'} (${afterA.uniqueValues}/${beforeA.uniqueValues} unique)`);

    const bPreserved = Math.abs(afterB.min - beforeB.min) < 100 && Math.abs(afterB.max - beforeB.max) < 100;
    console.log(`  ✓ b* channel preserved: ${bPreserved ? 'PASS' : 'FAIL'}`);

    return hasLinearGradientA && lPreserved && aPreserved && bPreserved;
}

// ============================================================================
// Test 2: Sub-Bit-Depth Gradient
// ============================================================================

function testSubBitDepthGradient() {
    console.log('\n' + '='.repeat(70));
    console.log('TEST 2: Sub-Bit-Depth Gradient');
    console.log('='.repeat(70));

    const inputPath = path.join(inputDir, 'sub-bit-depth-gradient.psd');
    if (!fs.existsSync(inputPath)) {
        console.log('ERROR: Test image not found. Run generate-patent-test-images.js first.');
        return false;
    }

    const buffer = fs.readFileSync(inputPath);
    const psd = readPsd(buffer);

    console.log(`Dimensions: ${psd.width}×${psd.height}`);
    console.log(`Bit depth: ${psd.depth}`);

    const rawData = new Uint16Array(psd.data.buffer, psd.data.byteOffset, psd.width * psd.height * 3);
    const labData = iccToPhotoshop16(rawData);

    const pixelCount = psd.width * psd.height;
    const beforeL = channelStats(labData, 3, 0, pixelCount);

    console.log('\nBefore filtering:');
    console.log(`  L: min=${beforeL.min}, max=${beforeL.max}`);
    console.log(`  L range (16-bit steps): ${beforeL.max - beforeL.min}`);
    console.log(`  Unique L values: ${beforeL.uniqueValues}`);

    // Verify we have many unique L values (linear gradient from 20% to 80%)
    // Range is ~39000 ICC values, which becomes ~19500 PS values after /2
    // Over 1024 pixels = ~19 PS values per pixel step
    // Should have close to 1024 unique values
    const hasLinearGradientL = beforeL.uniqueValues >= psd.width * 0.9;
    console.log(`  ✓ Linear gradient check: ${hasLinearGradientL ? 'PASS' : 'FAIL'} (${beforeL.uniqueValues} unique L values, expected ~${psd.width})`);

    const entropyBefore = calculateEntropyScoreLab(labData, psd.width, psd.height);
    console.log(`  Entropy score: ${entropyBefore.toFixed(2)}`);

    const originalL = new Uint16Array(pixelCount);
    for (let i = 0; i < pixelCount; i++) {
        originalL[i] = labData[i * 3];
    }

    applyBilateralFilterLab(labData, psd.width, psd.height, 3, 30);

    const afterL = channelStats(labData, 3, 0, pixelCount);

    console.log('\nAfter filtering:');
    console.log(`  L: min=${afterL.min}, max=${afterL.max}`);
    console.log(`  L range (16-bit steps): ${afterL.max - afterL.min}`);
    console.log(`  Unique L values: ${afterL.uniqueValues}`);

    const entropyAfter = calculateEntropyScoreLab(labData, psd.width, psd.height);
    console.log(`  Entropy score: ${entropyAfter.toFixed(2)}`);

    let totalChange = 0;
    for (let i = 0; i < pixelCount; i++) {
        totalChange += Math.abs(labData[i * 3] - originalL[i]);
    }
    const avgChange = totalChange / pixelCount;

    console.log(`  Avg L change per pixel: ${avgChange.toFixed(2)}`);

    // Validation
    console.log('\nValidation:');

    const originalRange = beforeL.max - beforeL.min;
    const filteredRange = afterL.max - afterL.min;
    const rangePreserved = filteredRange > originalRange * 0.95;
    console.log(`  ✓ L range preserved: ${rangePreserved ? 'PASS' : 'FAIL'} (${filteredRange}/${originalRange})`);

    const uniquePreserved = afterL.uniqueValues > beforeL.uniqueValues * 0.9;
    console.log(`  ✓ Unique values preserved: ${uniquePreserved ? 'PASS' : 'FAIL'} (${afterL.uniqueValues}/${beforeL.uniqueValues})`);

    const minimalChange = avgChange < 50;
    console.log(`  ✓ Minimal modification: ${minimalChange ? 'PASS' : 'FAIL'} (avg=${avgChange.toFixed(1)})`);

    return hasLinearGradientL && rangePreserved && uniquePreserved && minimalChange;
}

// ============================================================================
// Test 3: Edge-Preserving Impulse
// ============================================================================

function testEdgePreservingImpulse() {
    console.log('\n' + '='.repeat(70));
    console.log('TEST 3: Edge-Preserving Impulse Target');
    console.log('='.repeat(70));

    const inputPath = path.join(inputDir, 'edge-preserving-impulse.psd');
    if (!fs.existsSync(inputPath)) {
        console.log('ERROR: Test image not found. Run generate-patent-test-images.js first.');
        return false;
    }

    const buffer = fs.readFileSync(inputPath);
    const psd = readPsd(buffer);

    console.log(`Dimensions: ${psd.width}×${psd.height}`);
    console.log(`Bit depth: ${psd.depth}`);

    const rawData = new Uint16Array(psd.data.buffer, psd.data.byteOffset, psd.width * psd.height * 3);
    const labData = iccToPhotoshop16(rawData);

    const pixelCount = psd.width * psd.height;
    const edgeX = psd.width / 2;

    // PS 16-bit encoding values:
    // L=10% → 3277, L=30% → 9830, L=50% → 16384
    // L=70% → 22938, L=90% → 29491
    // Noise is now ±20% from background (more visible)
    const darkBgPS = 9830;    // L=30%
    const lightBgPS = 22938;  // L=70%
    const tolerance = 1000;   // ~3% tolerance for "background"

    const entropyBefore = calculateEntropyScoreLab(labData, psd.width, psd.height);
    const noiseBefore = countNoisePixelsEdge(labData, psd.width, psd.height, darkBgPS, lightBgPS, tolerance);
    const edgeSharpnessBefore = measureEdgeSharpness(labData, psd.width, psd.height, edgeX);

    console.log('\nBefore filtering:');
    console.log(`  Entropy score: ${entropyBefore.toFixed(2)}`);
    console.log(`  Noise pixels: ${noiseBefore} (${(100 * noiseBefore / pixelCount).toFixed(2)}%)`);
    console.log(`  Edge sharpness (L gradient): ${edgeSharpnessBefore.toFixed(1)}`);

    // Apply filter - noise is ±10% from background, edge is 40% jump
    // σr=30 in 8-bit scales to ~3857 in 16-bit PS encoding
    // This should filter ±10% noise but preserve 40% edge
    applyBilateralFilterLab(labData, psd.width, psd.height, 5, 45);

    const entropyAfter = calculateEntropyScoreLab(labData, psd.width, psd.height);
    const noiseAfter = countNoisePixelsEdge(labData, psd.width, psd.height, darkBgPS, lightBgPS, tolerance);
    const edgeSharpnessAfter = measureEdgeSharpness(labData, psd.width, psd.height, edgeX);

    console.log('\nAfter filtering:');
    console.log(`  Entropy score: ${entropyAfter.toFixed(2)}`);
    console.log(`  Noise pixels: ${noiseAfter} (${(100 * noiseAfter / pixelCount).toFixed(2)}%)`);
    console.log(`  Edge sharpness (L gradient): ${edgeSharpnessAfter.toFixed(1)}`);

    // Validation
    console.log('\nValidation:');

    const entropyReduced = entropyAfter < entropyBefore * 0.8;
    console.log(`  ✓ Entropy reduced: ${entropyReduced ? 'PASS' : 'FAIL'} (${entropyBefore.toFixed(1)} → ${entropyAfter.toFixed(1)})`);

    const noiseReduced = noiseAfter < noiseBefore * 0.5;  // At least 50% noise reduction
    console.log(`  ✓ Noise reduced >50%: ${noiseReduced ? 'PASS' : 'FAIL'} (${noiseBefore} → ${noiseAfter})`);

    const edgePreserved = edgeSharpnessAfter > edgeSharpnessBefore * 0.7;
    console.log(`  ✓ Edge preserved: ${edgePreserved ? 'PASS' : 'FAIL'} (${edgeSharpnessBefore.toFixed(1)} → ${edgeSharpnessAfter.toFixed(1)})`);

    // Sample center of each half
    const leftSampleIdx = (psd.height / 2 * psd.width + psd.width / 4) * 3;
    const rightSampleIdx = (psd.height / 2 * psd.width + psd.width * 3 / 4) * 3;
    const leftL = labData[leftSampleIdx];
    const rightL = labData[rightSampleIdx];

    const leftCorrect = Math.abs(leftL - darkBgPS) < 1000;
    const rightCorrect = Math.abs(rightL - lightBgPS) < 1000;
    console.log(`  ✓ Region values correct: ${leftCorrect && rightCorrect ? 'PASS' : 'FAIL'} (left=${leftL}, right=${rightL})`);

    return entropyReduced && noiseReduced && edgePreserved && leftCorrect && rightCorrect;
}

// ============================================================================
// Main
// ============================================================================

console.log('Testing Bilateral Filter on Patent Validation Images');
console.log('=====================================================');
console.log('Using reveal-core/lib/preprocessing/BilateralFilter.js');

const results = [];
results.push({ name: 'Chromatic Zero-Crossing', passed: testChromaticZeroCrossing() });
results.push({ name: 'Sub-Bit-Depth Gradient', passed: testSubBitDepthGradient() });
results.push({ name: 'Edge-Preserving Impulse', passed: testEdgePreservingImpulse() });

console.log('\n' + '='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));

let allPassed = true;
for (const result of results) {
    const status = result.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${status}: ${result.name}`);
    if (!result.passed) allPassed = false;
}

console.log();
if (allPassed) {
    console.log('All tests passed! Bilateral filter behaves correctly.');
} else {
    console.log('Some tests failed. Review the output above.');
    process.exit(1);
}
