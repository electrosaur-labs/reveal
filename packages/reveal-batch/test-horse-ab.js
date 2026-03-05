#!/usr/bin/env node
/**
 * A/B test: posterize the horse image and compare palettes.
 *
 * Reads the 16-bit Lab PSD via @electrosaur-labs/psd-reader, converts to engine encoding,
 * runs PosterizationEngine with the matched archetype, and prints the palette
 * with Lab values + hue angles.
 *
 * Run twice: once with current code (yellow-zone gate), once after reverting,
 * to compare orange vs yellow centroid drift.
 */
const fs = require('fs');
const path = require('path');
const { readPsd } = require('@electrosaur-labs/psd-reader');
const Reveal = require('@electrosaur-labs/core');
const LabEncoding = require('@electrosaur-labs/core/lib/color/LabEncoding');

// Reuse the batch pipeline's DNA v2.0 calculator
const { posterizePsd } = require('./src/posterize-psd.js');

const INPUT = '/workspaces/electrosaur/fixtures/0B9A4230-original-16bit.psd';

async function run() {
    console.log('Reading PSD...');
    const buffer = fs.readFileSync(INPUT);
    const psd = readPsd(buffer);
    const { width, height, depth, data: psdData } = psd;
    const pixelCount = width * height;
    console.log(`Image: ${width}x${height}, ${depth}-bit Lab, ${pixelCount} pixels`);

    // Convert PSD 16-bit Lab to engine 16-bit and 8-bit
    console.log('Converting encodings...');
    const lab16 = LabEncoding.convertPsd16bitToEngineLab(psdData, pixelCount);
    const lab8 = LabEncoding.convertPsd16bitTo8bitLab(psdData, pixelCount);

    // DNA v2.0 analysis (inline, same as posterize-psd.js)
    console.log('Analyzing DNA v2.0...');
    const dna = calculateImageDNA(lab8, width, height);
    dna.bitDepth = depth;
    console.log(`DNA: L=${dna.global.l}, C=${dna.global.c}, K=${dna.global.k}, σL=${dna.global.l_std_dev}`);
    console.log(`Dominant sector: ${dna.dominant_sector}`);
    console.log(`Hue entropy: ${dna.global.hue_entropy}`);
    console.log(`Temp bias: ${dna.global.temperature_bias}`);

    // Generate config via ParameterGenerator
    const config = Reveal.ParameterGenerator.generate(dna, { width, height });
    console.log(`\nArchetype: ${config.meta?.archetype} (score=${config.meta?.matchScore?.toFixed(2)})`);
    console.log(`Config: targetColors=${config.targetColors}, vibrancyMode=${config.vibrancyMode}, cWeight=${config.cWeight}, lWeight=${config.lWeight}`);

    // Show top 5 archetype matches
    console.log('\nTop 5 archetype matches:');
    (config.meta?.matchRanking || []).slice(0, 5).forEach((m, i) => {
        console.log(`  ${i+1}. ${m.id} (score=${m.score?.toFixed(2)})`);
    });

    // Posterize
    console.log('\nPosterizing...');
    const params = Reveal.ParameterGenerator.toEngineOptions(config, {
        targetColorsSlider: config.targetColors,
        bitDepth: 16
    });

    const result = await Reveal.posterizeImage(
        lab16, width, height,
        config.targetColors,
        params
    );

    // Print palette with hue analysis
    const SECTORS = ['red','orange','yellow','chartreuse','green','cyan','azure','blue','purple','magenta','pink','rose'];

    console.log(`\n${'='.repeat(80)}`);
    console.log(`PALETTE (${result.paletteLab.length} colors)`);
    console.log(`${'='.repeat(80)}`);
    console.log(`${'Idx'.padStart(3)} | ${'L'.padStart(6)} ${'a'.padStart(7)} ${'b'.padStart(7)} | ${'C'.padStart(6)} ${'Hue°'.padStart(6)} | ${'Sector'.padEnd(12)} | RGB`);
    console.log(`${'-'.repeat(80)}`);

    for (let i = 0; i < result.paletteLab.length; i++) {
        const c = result.paletteLab[i];
        const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
        let hue = Math.atan2(c.b, c.a) * (180 / Math.PI);
        if (hue < 0) hue += 360;
        const sectorIdx = Math.floor(hue / 30) % 12;
        const sector = SECTORS[sectorIdx];
        const rgb = result.palette[i];
        const hex = `#${rgb.r.toString(16).padStart(2,'0')}${rgb.g.toString(16).padStart(2,'0')}${rgb.b.toString(16).padStart(2,'0')}`;

        console.log(
            `${String(i).padStart(3)} | ` +
            `${c.L.toFixed(1).padStart(6)} ${c.a.toFixed(1).padStart(7)} ${c.b.toFixed(1).padStart(7)} | ` +
            `${chroma.toFixed(1).padStart(6)} ${hue.toFixed(1).padStart(6)} | ` +
            `${sector.padEnd(12)} | ${hex}`
        );
    }

    // Count yellow vs orange in palette
    const yellowCount = result.paletteLab.filter(c => {
        const h = Math.atan2(c.b, c.a) * (180 / Math.PI);
        return h > 60 && h < 90 && Math.sqrt(c.a*c.a + c.b*c.b) > 10;
    }).length;
    const orangeCount = result.paletteLab.filter(c => {
        const h = Math.atan2(c.b, c.a) * (180 / Math.PI);
        return h > 30 && h <= 60 && Math.sqrt(c.a*c.a + c.b*c.b) > 10;
    }).length;
    console.log(`\nYellow-sector colors (60-90°): ${yellowCount}`);
    console.log(`Orange-sector colors (30-60°): ${orangeCount}`);
}

/**
 * DNA v2.0 calculator (from posterize-psd.js)
 */
function calculateImageDNA(lab8bit, width, height, sampleStep = 40) {
    const pixelCount = width * height;
    const CHROMA_THRESHOLD = 5;
    const SECTORS = ['red','orange','yellow','chartreuse','green','cyan','azure','blue','purple','magenta','pink','rose'];

    let sumL = 0, sumC = 0, minL = 100, maxL = 0, maxC = 0, sampleCount = 0, lowChromaCount = 0;
    const lValues = [];
    const sectorData = {};
    SECTORS.forEach(s => { sectorData[s] = { count: 0, sumC: 0, sumL: 0, maxC: 0 }; });
    let warmCount = 0, coolCount = 0, chromaPixelCount = 0;

    for (let i = 0; i < pixelCount; i += sampleStep) {
        const L = (lab8bit[i * 3] / 255) * 100;
        const a = lab8bit[i * 3 + 1] - 128;
        const b = lab8bit[i * 3 + 2] - 128;
        const C = Math.sqrt(a * a + b * b);

        sumL += L; sumC += C; lValues.push(L);
        if (L < minL) minL = L;
        if (L > maxL) maxL = L;
        if (C > maxC) maxC = C;
        if (C < 15) lowChromaCount++;
        sampleCount++;

        if (C > CHROMA_THRESHOLD) {
            chromaPixelCount++;
            let hue = Math.atan2(b, a) * (180 / Math.PI);
            if (hue < 0) hue += 360;
            const sectorIndex = Math.floor(hue / 30) % 12;
            const sector = SECTORS[sectorIndex];
            sectorData[sector].count++;
            sectorData[sector].sumC += C;
            sectorData[sector].sumL += L;
            if (C > sectorData[sector].maxC) sectorData[sector].maxC = C;
            if (hue >= 0 && hue < 90) warmCount++;
            else if (hue >= 150 && hue < 270) coolCount++;
        }
    }

    const avgL = sumL / sampleCount;
    const avgC = sumC / sampleCount;
    const lVariance = lValues.reduce((sum, l) => sum + Math.pow(l - avgL, 2), 0) / sampleCount;
    const lStdDev = Math.sqrt(lVariance);
    const lowChromaDensity = lowChromaCount / sampleCount;

    const sectors = {};
    let dominantSector = null, dominantWeight = 0, hueWeights = [];
    SECTORS.forEach(sector => {
        const data = sectorData[sector];
        const weight = chromaPixelCount > 0 ? data.count / chromaPixelCount : 0;
        sectors[sector] = {
            weight: parseFloat(weight.toFixed(4)),
            cMean: data.count > 0 ? parseFloat((data.sumC / data.count).toFixed(1)) : 0,
            cMax: parseFloat(data.maxC.toFixed(1)),
            lMean: data.count > 0 ? parseFloat((data.sumL / data.count).toFixed(1)) : 0
        };
        if (weight > dominantWeight) { dominantWeight = weight; dominantSector = sector; }
        if (weight > 0) hueWeights.push(weight);
    });

    let hueEntropy = 0;
    if (hueWeights.length > 0) {
        const maxEntropy = Math.log2(12);
        hueEntropy = -hueWeights.reduce((sum, w) => sum + w * Math.log2(w), 0) / maxEntropy;
    }

    const temperatureBias = (warmCount + coolCount) > 0
        ? parseFloat(((warmCount - coolCount) / (warmCount + coolCount)).toFixed(3))
        : 0;

    return {
        version: "2.0",
        global: {
            l: parseFloat(avgL.toFixed(1)),
            c: parseFloat(avgC.toFixed(1)),
            k: parseFloat((maxL - minL).toFixed(1)),
            l_std_dev: parseFloat(lStdDev.toFixed(1)),
            hue_entropy: parseFloat(hueEntropy.toFixed(3)),
            temperature_bias: temperatureBias,
            primary_sector_weight: parseFloat(dominantWeight.toFixed(4)),
            minL: parseFloat(minL.toFixed(1)),
            maxL: parseFloat(maxL.toFixed(1)),
            maxC: parseFloat(maxC.toFixed(1)),
            lowChromaDensity: parseFloat(lowChromaDensity.toFixed(3)),
        },
        dominant_sector: dominantSector || 'none',
        sectors,
        // Legacy fields
        l: parseFloat(avgL.toFixed(1)),
        c: parseFloat(avgC.toFixed(1)),
        k: parseFloat((maxL - minL).toFixed(1)),
        l_std_dev: parseFloat(lStdDev.toFixed(1)),
        minL: parseFloat(minL.toFixed(1)),
        maxL: parseFloat(maxL.toFixed(1)),
        maxC: parseFloat(maxC.toFixed(1))
    };
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
