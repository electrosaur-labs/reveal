#!/usr/bin/env node
/**
 * Simulate the UI (ProductionWorker) pipeline on a PSD input.
 *
 * Reads the input PSD, uses the SAME palette as the batch output JSON,
 * runs SeparationEngine.mapPixelsToPaletteAsync (the code path ProductionWorker
 * now uses after deleting _mapPixelsFast), and writes a 16-bit Lab PSD.
 *
 * Usage: node simulate-ui-pipeline.js <inputPSD> <batchJSON> <outputPSD>
 */
const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const { PSDWriter } = require('@reveal/psd-writer');
const { readPsd } = require('@reveal/psd-reader');
const { convertPsd16bitToEngineLab, convertPsd16bitTo8bitLab, convert8bitTo16bitLab } = require('./batch-utils');

const SeparationEngine = Reveal.engines.SeparationEngine;
const MechanicalKnobs = Reveal.MechanicalKnobs;

async function main() {
    const [,, inputPSD, batchJSON, outputPSD] = process.argv;
    if (!inputPSD || !batchJSON || !outputPSD) {
        console.error('Usage: node simulate-ui-pipeline.js <inputPSD> <batchJSON> <outputPSD>');
        process.exit(1);
    }

    // 1. Read input PSD
    const buffer = fs.readFileSync(inputPSD);
    const psd = readPsd(buffer);
    const { width, height, depth, data: labData } = psd;
    const pixelCount = width * height;
    console.log(`Input: ${width}x${height} ${depth}-bit Lab`);

    // 2. Convert to engine 16-bit (same as ProductionWorker gets from Photoshop)
    let lab16;
    if (depth === 16) {
        lab16 = convertPsd16bitToEngineLab(labData, pixelCount);
    } else {
        lab16 = convert8bitTo16bitLab(labData, pixelCount);
    }

    // 3. Read batch JSON to get the palette
    const sidecar = JSON.parse(fs.readFileSync(batchJSON, 'utf-8'));
    const labPalette = sidecar.palette.map(p => p.lab);
    const config = sidecar.configuration;
    console.log(`Palette: ${labPalette.length} colors from ${path.basename(batchJSON)}`);
    console.log(`Config: metric=${config.distanceMetric || 'cie76'}, dither=${config.ditherType || 'none'}, speckleRescue=${config.speckleRescue}`);

    // 4. Separate — exact same call as ProductionWorker now makes
    const metric = config.distanceMetric || 'cie76';
    const ditherType = config.ditherType || 'none';
    console.log(`Separating with SeparationEngine (metric=${metric}, dither=${ditherType})...`);
    const t0 = Date.now();
    const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
        lab16, labPalette, null, width, height,
        { ditherType, distanceMetric: metric }
    );
    console.log(`  Separated ${pixelCount} pixels in ${Date.now() - t0}ms`);

    // 5. Build masks + apply knobs (same as ProductionWorker._buildLayers)
    const masks = MechanicalKnobs.rebuildMasks(colorIndices, labPalette.length, pixelCount);

    if (config.speckleRescue > 0) {
        console.log(`  Applying speckleRescue=${config.speckleRescue}`);
        MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, config.speckleRescue);
    }

    // 6. Speckle diagnostic
    let totalSpeckles = 0;
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 1; x < width - 1; x++) {
            if (colorIndices[row + x] !== colorIndices[row + x - 1] &&
                colorIndices[row + x] !== colorIndices[row + x + 1]) {
                totalSpeckles++;
            }
        }
    }
    console.log(`  Speckles: ${(totalSpeckles / height).toFixed(1)} avg per scanline`);

    // 7. Write 16-bit Lab PSD
    const lab8bit = depth === 16
        ? convertPsd16bitTo8bitLab(labData, pixelCount)
        : labData;

    const writer = new PSDWriter({
        width, height,
        colorMode: 'lab',
        bitsPerChannel: 16,
        documentName: 'ui-simulation'
    });

    // Reference layer (8-bit data auto-scaled by PSDWriter)
    writer.addPixelLayer({
        name: 'Original (Reference)',
        pixels: lab8bit,
        visible: false
    });

    // Sort by lightness (same as ProductionWorker)
    const layerOrder = labPalette
        .map((c, i) => ({ color: c, index: i, mask: masks[i] }))
        .sort((a, b) => b.color.L - a.color.L);

    for (const layer of layerOrder) {
        let opaqueCount = 0;
        for (let i = 0; i < layer.mask.length; i++) {
            if (layer.mask[i] === 255) opaqueCount++;
        }
        if (opaqueCount === 0) continue;

        const rgb = Reveal.LabEncoding.labToRgb(layer.color);
        const hex = `#${[rgb.r, rgb.g, rgb.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
        writer.addFillLayer({
            name: `Color ${layer.index + 1} (${hex})`,
            color: layer.color,
            mask: layer.mask
        });
    }

    const psdBuffer = writer.write();
    fs.writeFileSync(outputPSD, psdBuffer);
    console.log(`Wrote: ${outputPSD} (${(psdBuffer.length / 1024 / 1024).toFixed(1)} MB, 16-bit Lab)`);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
