#!/usr/bin/env node
/**
 * Debug script: Compare proxy separation (archetype metric) vs production (CIE76)
 * to verify the metric mismatch fix.
 *
 * Usage: node scripts/debug-metric-mismatch.js <psd-file> <archetype-id>
 */

const fs = require('fs');
const path = require('path');
const { readPsd } = require('../packages/reveal-psd-reader');
const Reveal = require('../packages/reveal-core');

const PosterizationEngine = Reveal.engines.PosterizationEngine;
const SeparationEngine = Reveal.engines.SeparationEngine;
const ProxyEngine = Reveal.engines.ProxyEngine;

const psdPath = process.argv[2];
const archetypeId = process.argv[3];

if (!psdPath || !archetypeId) {
    console.error('Usage: node scripts/debug-metric-mismatch.js <psd-file> <archetype-id>');
    process.exit(1);
}

(async () => {
    // 1. Read PSD
    console.log(`Reading ${path.basename(psdPath)}...`);
    const buffer = fs.readFileSync(psdPath);
    const psd = readPsd(buffer);
    console.log(`  ${psd.width}x${psd.height}, ${psd.depth}-bit, ${psd.data.length} values`);

    // 2. DNA analysis
    console.log('\nRunning DNA analysis...');
    const dnaGen = new Reveal.DNAGenerator();
    const dna = dnaGen.generate(psd.data, psd.width, psd.height, { bitDepth: psd.depth });
    console.log(`  DNA v${dna.version}: L=${dna.global.l.toFixed(1)} C=${dna.global.c.toFixed(1)} K=${dna.global.k.toFixed(1)}`);

    // 3. Generate config with manual archetype
    console.log(`\nForcing archetype: ${archetypeId}`);
    const config = Reveal.generateConfiguration(dna, { manualArchetypeId: archetypeId });
    console.log(`  distanceMetric: ${config.distanceMetric}`);
    console.log(`  targetColors: ${config.targetColorsSlider || config.targetColors}`);

    // 4. Downsample to 512px proxy (same as ProxyEngine)
    const maxDim = Math.max(psd.width, psd.height);
    const scale = Math.min(1.0, 512 / maxDim);
    const proxyW = Math.round(psd.width * scale);
    const proxyH = Math.round(psd.height * scale);
    console.log(`\nProxy: ${proxyW}x${proxyH} (scale ${scale.toFixed(3)})`);

    // Use ProxyEngine for proxy
    const proxy = new ProxyEngine();
    const proxyResult = await proxy.initializeProxy(psd.data, psd.width, psd.height, config);
    const palette = proxyResult.palette; // perceptual Lab
    const rgbPalette = proxy.separationState.rgbPalette;

    console.log(`\nPalette (${palette.length} colors):`);
    for (let i = 0; i < palette.length; i++) {
        const c = palette[i];
        const rgb = rgbPalette[i];
        console.log(`  [${i}] L=${c.L.toFixed(1)} a=${c.a.toFixed(1)} b=${c.b.toFixed(1)}  → rgb(${rgb.r},${rgb.g},${rgb.b})`);
    }

    // 5. Separate proxy with archetype metric
    const archMetric = config.distanceMetric || 'cie76';
    console.log(`\n--- Separation with ARCHETYPE metric (${archMetric}) ---`);
    const indicesArch = await SeparationEngine.mapPixelsToPaletteAsync(
        proxy.proxyBuffer, palette, null, proxyW, proxyH,
        { ditherType: 'none', distanceMetric: archMetric }
    );

    // 6. Separate proxy with CIE76 (the old hardcoded production behavior)
    console.log(`--- Separation with CIE76 (old production) ---`);
    const indicesCIE76 = await SeparationEngine.mapPixelsToPaletteAsync(
        proxy.proxyBuffer, palette, null, proxyW, proxyH,
        { ditherType: 'none', distanceMetric: 'cie76' }
    );

    // 7. Compare
    const totalPixels = proxyW * proxyH;
    let mismatchCount = 0;
    const mismatchMap = new Map(); // "from→to" → count

    for (let i = 0; i < totalPixels; i++) {
        if (indicesArch[i] !== indicesCIE76[i]) {
            mismatchCount++;
            const key = `${indicesArch[i]}→${indicesCIE76[i]}`;
            mismatchMap.set(key, (mismatchMap.get(key) || 0) + 1);
        }
    }

    const mismatchPct = ((mismatchCount / totalPixels) * 100).toFixed(2);
    console.log(`\n=== MISMATCH: ${mismatchCount} pixels (${mismatchPct}%) differ ===`);

    if (mismatchCount > 0) {
        console.log('\nPixel reassignment breakdown:');
        const sorted = [...mismatchMap.entries()].sort((a, b) => b[1] - a[1]);
        for (const [key, count] of sorted) {
            const [from, to] = key.split('→').map(Number);
            const fromRgb = rgbPalette[from];
            const toRgb = rgbPalette[to];
            const pct = ((count / totalPixels) * 100).toFixed(2);
            console.log(`  ${archMetric}[${from}] rgb(${fromRgb.r},${fromRgb.g},${fromRgb.b}) → CIE76[${to}] rgb(${toRgb.r},${toRgb.g},${toRgb.b})  ${count} px (${pct}%)`);
        }

        // Identify if any "blue" is involved
        console.log('\nBlue analysis:');
        for (let i = 0; i < palette.length; i++) {
            const rgb = rgbPalette[i];
            const isBlue = rgb.b > rgb.r + 30 && rgb.b > rgb.g + 30;
            if (isBlue) {
                console.log(`  [${i}] rgb(${rgb.r},${rgb.g},${rgb.b}) is BLUE`);

                // Count how many pixels each metric assigns to this blue
                let archCount = 0, cie76Count = 0;
                for (let p = 0; p < totalPixels; p++) {
                    if (indicesArch[p] === i) archCount++;
                    if (indicesCIE76[p] === i) cie76Count++;
                }
                console.log(`    ${archMetric}: ${archCount} px (${((archCount/totalPixels)*100).toFixed(2)}%)`);
                console.log(`    CIE76:    ${cie76Count} px (${((cie76Count/totalPixels)*100).toFixed(2)}%)`);
            }
        }
    } else {
        console.log('No differences — both metrics produce identical assignments for this image/archetype.');
    }
})().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
