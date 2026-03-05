#!/usr/bin/env node
/**
 * compare-distilled-horse.js
 *
 * Compares direct K-color posterize vs. distilledPosterize on the horse image.
 * Shows which approach captures distinctive hues (golden yellow, orange-gold)
 * that collapse under direct median-cut L*-dominance.
 *
 * Usage: node compare-distilled-horse.js [psdPath] [targetK]
 *   Defaults to horse-warm-sovereign.psd, K=6
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { readPsd }          = require('@electrosaur-labs/psd-reader');
const Reveal               = require('@electrosaur-labs/core');
const { LabEncoding }      = Reveal;
const { PosterizationEngine } = Reveal.engines;
const { convertPsd16bitToEngineLab } = LabEncoding;

// ── Target colors — derived from the 18-color over-quantized palette ─────────
// These are the hues the over-quantization finds that K=6 direct may collapse.
const TARGETS = [
    { name: 'bright-gold',  L: 90,  a: 26,  b: 114 },  // L=89.9 a=25.7 b=114 from over-quant
    { name: 'warm-golden',  L: 84,  a: 20,  b:  81 },  // L=84.3 a=20.7 b=80.9
    { name: 'deep-orange',  L: 63,  a: 42,  b:  60 },  // L=62.9 a=41.6 b=60
    { name: 'dark-shadow',  L: 17,  a:  4,  b:   3 },  // L=17.4 a=3.9  b=2.8
    { name: 'white-bg',     L: 93,  a:  0,  b:   0 },  // L=93.1 a=0.1  b=-0.7
];

// ── ΔE76 in perceptual Lab ────────────────────────────────────────────────────
function deltaE(c1, c2) {
    return Math.sqrt((c1.L - c2.L) ** 2 + (c1.a - c2.a) ** 2 + (c1.b - c2.b) ** 2);
}

function nearestDeltaE(palette, target) {
    let best = Infinity;
    let bestColor = null;
    for (const c of palette) {
        const d = deltaE(c, target);
        if (d < best) { best = d; bestColor = c; }
    }
    return { dE: best.toFixed(1), color: bestColor };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const psdPath = args[0] || path.resolve(__dirname, '../../../../fixtures/0B9A4230-original-16bit.psd');
    const targetK = parseInt(args[1] || '6', 10);

    console.log(`\nDistilled vs. Direct Posterize — ${path.basename(psdPath)}, K=${targetK}`);
    console.log('━'.repeat(70));

    // 1. Read PSD
    if (!fs.existsSync(psdPath)) {
        console.error(`PSD not found: ${psdPath}`);
        process.exit(1);
    }
    const buffer = fs.readFileSync(psdPath);
    const psd    = readPsd(buffer);
    const { width, height, depth, data: psdData } = psd;
    const pixelCount = width * height;
    console.log(`Image: ${width}×${height} (${depth}-bit Lab)\n`);

    // 2. Convert to engine 16-bit format
    let lab16;
    if (depth === 16) {
        lab16 = convertPsd16bitToEngineLab(psdData, pixelCount);
    } else {
        lab16 = LabEncoding.convert8bitTo16bitLab(psdData, pixelCount);
    }

    // Subsample to ~10% for speed: take every 3rd row and column
    const stride = 3;
    const sW = Math.ceil(width / stride);
    const sH = Math.ceil(height / stride);
    const subPixels = new Uint16Array(sW * sH * 3);
    let sp = 0;
    for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < width; x += stride) {
            const src = (y * width + x) * 3;
            subPixels[sp++] = lab16[src];
            subPixels[sp++] = lab16[src + 1];
            subPixels[sp++] = lab16[src + 2];
        }
    }
    const sw = sW, sh = sH;
    console.log(`Subsampled to ${sw}×${sh} (${sw*sh} pixels)\n`);

    const opts = {
        bitDepth: 16,
        engineType: 'reveal-mk2',
        format: 'lab',
        enablePaletteReduction: false,
        snapThreshold: 0,
        densityFloor: 0,
    };

    // 3. Direct posterize
    console.log(`Running direct posterize (K=${targetK})...`);
    const t0Direct = Date.now();
    const directResult = PosterizationEngine.posterize(subPixels, sw, sh, targetK, opts);
    const msD = Date.now() - t0Direct;
    console.log(`  Done in ${msD}ms — got ${directResult.paletteLab.length} colors\n`);

    // 4. Distilled posterize
    console.log(`Running distilledPosterize (K=${targetK})...`);
    const t0Dist = Date.now();
    const distResult = PosterizationEngine.distilledPosterize(subPixels, sw, sh, targetK, opts);
    const msR = Date.now() - t0Dist;
    console.log(`  Done in ${msR}ms — got ${distResult.paletteLab.length} colors`);
    console.log(`  overCount=${distResult.metadata.overCount}, kept=${distResult.metadata.keptIndices.join(',')}\n`);

    // 5. Print palettes
    function printPalette(label, paletteLab, assignments) {
        const counts = new Float64Array(paletteLab.length);
        for (let i = 0; i < assignments.length; i++) counts[assignments[i]]++;
        const total = assignments.length;

        console.log(`${label}:`);
        for (let i = 0; i < paletteLab.length; i++) {
            const c = paletteLab[i];
            const pct = ((counts[i] / total) * 100).toFixed(1);
            console.log(`  [${i}] L=${c.L.toFixed(1).padStart(5)} a=${c.a.toFixed(1).padStart(6)} b=${c.b.toFixed(1).padStart(6)}  (${pct.padStart(5)}%)`);
        }
        console.log();
    }

    printPalette('Direct   palette', directResult.paletteLab,   directResult.assignments);
    printPalette('Distilled palette', distResult.paletteLab, distResult.assignments);

    // 6. Target color coverage
    console.log('Target color coverage (ΔE76 to nearest palette entry):');
    console.log('─'.repeat(70));
    console.log(`${'Target'.padEnd(14)} | ${'Direct ΔE'.padEnd(10)} Direct color             | Distil ΔE  Distil color`);
    console.log('─'.repeat(70));

    for (const target of TARGETS) {
        const d = nearestDeltaE(directResult.paletteLab, target);
        const r = nearestDeltaE(distResult.paletteLab,   target);

        const dHit = d.dE <= 10 ? '✓' : '✗';
        const rHit = r.dE <= 10 ? '✓' : '✗';

        const dColor = `L=${d.color.L.toFixed(0)} a=${d.color.a.toFixed(0)} b=${d.color.b.toFixed(0)}`;
        const rColor = `L=${r.color.L.toFixed(0)} a=${r.color.a.toFixed(0)} b=${r.color.b.toFixed(0)}`;

        console.log(
            `${target.name.padEnd(14)} | ΔE=${d.dE.padStart(5)} ${dHit} ${dColor.padEnd(22)} | ΔE=${r.dE.padStart(5)} ${rHit} ${rColor}`
        );
    }
    console.log('─'.repeat(70));
    console.log();
}

main().catch(err => {
    console.error(err.message);
    console.error(err.stack);
    process.exit(1);
});
