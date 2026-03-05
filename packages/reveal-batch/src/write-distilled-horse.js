#!/usr/bin/env node
/**
 * write-distilled-horse.js
 *
 * Reads the original horse PSD, runs distilledPosterize, and writes
 * a separated output PSD with fill+mask layers for visual inspection.
 *
 * Usage: node write-distilled-horse.js [targetK]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { readPsd }             = require('@electrosaur-labs/psd-reader');
const { PSDWriter }           = require('@electrosaur-labs/psd-writer');
const Reveal                  = require('@electrosaur-labs/core');
const { LabEncoding }         = Reveal;
const { PosterizationEngine } = Reveal.engines;
const { convertPsd16bitToEngineLab, convertEngine16bitTo8bitLab } = LabEncoding;

const INPUT_PSD  = path.resolve(__dirname, '../../../../fixtures/0B9A4230-original-16bit.psd');
const OUTPUT_DIR = path.resolve(__dirname, '../../../../fixtures');

async function main() {
    const targetK = parseInt(process.argv[2] || '6', 10);

    console.log(`\nDistilled Posterize → PSD  (K=${targetK})`);
    console.log('━'.repeat(50));

    // 1. Read PSD
    console.log(`Reading: ${path.basename(INPUT_PSD)}`);
    const buffer = fs.readFileSync(INPUT_PSD);
    const psd    = readPsd(buffer);
    const { width, height, depth, data: psdData } = psd;
    const pixelCount = width * height;
    console.log(`  ${width}×${height}  ${depth}-bit Lab`);

    // 2. Convert to engine 16-bit
    const lab16 = depth === 16
        ? convertPsd16bitToEngineLab(psdData, pixelCount)
        : LabEncoding.convert8bitTo16bitLab(psdData, pixelCount);

    // 3. Subsample for speed (stride=3 → ~1300×1900)
    const stride = 3;
    const sW = Math.ceil(width  / stride);
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
    console.log(`  Subsampled to ${sW}×${sH}\n`);

    const opts = {
        bitDepth: 16,
        engineType: 'reveal-mk2',
        format: 'lab',
        enablePaletteReduction: false,
        snapThreshold: 0,
        densityFloor: 0,
        peakFinderMaxPeaks: 1,
    };

    // 4. Run distilledPosterize
    console.log(`Running distilledPosterize (K=${targetK})...`);
    const t0 = Date.now();
    const result = PosterizationEngine.distilledPosterize(subPixels, sW, sH, targetK, opts);
    console.log(`  Done in ${Date.now() - t0}ms — ${result.paletteLab.length} colors`);
    console.log(`  overCount=${result.metadata.overCount}`);

    const { paletteLab, assignments } = result;
    const K = paletteLab.length;
    const subPixelCount = sW * sH;

    // 5. Print palette
    const counts = new Uint32Array(K);
    for (let i = 0; i < subPixelCount; i++) counts[assignments[i]]++;

    console.log('\nPalette:');
    for (let k = 0; k < K; k++) {
        const c   = paletteLab[k];
        const pct = ((counts[k] / subPixelCount) * 100).toFixed(1);
        const rgb = Reveal.labToRgb(c);
        const hex = '#' + [rgb.r, rgb.g, rgb.b].map(v =>
            Math.round(v).toString(16).padStart(2, '0')
        ).join('');
        console.log(`  [${k}] L=${c.L.toFixed(1).padStart(5)} a=${c.a.toFixed(1).padStart(6)} b=${c.b.toFixed(1).padStart(6)}  ${hex}  (${pct}%)`);
    }

    // 6. Build per-color masks (binary: 255 or 0)
    const masks = Array.from({ length: K }, () => new Uint8Array(subPixelCount));
    for (let i = 0; i < subPixelCount; i++) {
        masks[assignments[i]][i] = 255;
    }

    // 7. Convert subsampled engine-16bit pixels → 8-bit Lab for reference layer
    const lab8ref = convertEngine16bitTo8bitLab(subPixels, subPixelCount);

    // 8. Write output PSD
    const outName = `horse-distilled-k${targetK}.psd`;
    const outPath = path.join(OUTPUT_DIR, outName);

    const writer = new PSDWriter({
        width:          sW,
        height:         sH,
        colorMode:      'lab',
        bitsPerChannel: 8,
    });

    // Reference layer (hidden)
    writer.addPixelLayer({
        name:    'Original (Reference)',
        pixels:  lab8ref,
        visible: false,
    });

    // Fill+mask layers sorted light→dark (standard print stacking order)
    const sorted = paletteLab
        .map((c, k) => ({ k, c, mask: masks[k], coverage: counts[k] }))
        .sort((a, b) => b.c.L - a.c.L);

    for (const { k, c, mask } of sorted) {
        const rgb = Reveal.labToRgb(c);
        const hex = '#' + [rgb.r, rgb.g, rgb.b].map(v =>
            Math.round(v).toString(16).padStart(2, '0')
        ).join('');
        writer.addFillLayer({
            name:  `${hex}  L=${c.L.toFixed(0)} a=${c.a.toFixed(0)} b=${c.b.toFixed(0)}`,
            color: c,
            mask,
        });
    }

    const psdBuf = writer.write();
    fs.writeFileSync(outPath, psdBuf);
    console.log(`\nWrote: ${outPath}  (${(psdBuf.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(err => {
    console.error(err.message);
    console.error(err.stack);
    process.exit(1);
});
