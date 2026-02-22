#!/usr/bin/env node
/**
 * compare-codepaths.js — Palette Divergence Diagnostic
 *
 * Runs both the "reveal-adobe" code path (direct PosterizationEngine)
 * and the "Navigator/ProxyEngine" code path on the same image, then
 * compares palettes at every stage.
 *
 * Usage:
 *   node compare-codepaths.js [inputPSD] [archetypeId]
 *
 * Defaults:
 *   inputPSD:    /workspaces/electrosaur/fixtures/JethroAsMonroe-original-16bit.psd
 *   archetypeId: subtle_naturalist
 */

const fs = require('fs');
const path = require('path');
const { readPsd } = require('@reveal/psd-reader');
const Reveal = require('@reveal/core');
const PosterizationEngine = Reveal.engines.PosterizationEngine;
const SeparationEngine = Reveal.engines.SeparationEngine;
const ProxyEngine = Reveal.engines.ProxyEngine;
const BilateralFilter = Reveal.BilateralFilter;
const LabDistance = Reveal.LabDistance;

// ─── Helpers ──────────────────────────────────────────────

function convertPsd16bitToEngineLab(labPsd16, pixelCount) {
    const labEngine = new Uint16Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        labEngine[i * 3]     = labPsd16[i * 3] >> 1;
        labEngine[i * 3 + 1] = labPsd16[i * 3 + 1] >> 1;
        labEngine[i * 3 + 2] = labPsd16[i * 3 + 2] >> 1;
    }
    return labEngine;
}

function fmtLab(c) {
    return `L=${c.L.toFixed(1)} a=${c.a.toFixed(1)} b=${c.b.toFixed(1)}`;
}

function deltaE76(a, b) {
    const dL = a.L - b.L;
    const da = a.a - b.a;
    const db = a.b - b.b;
    return Math.sqrt(dL * dL + da * da + db * db);
}

function printPalette(label, palette) {
    console.log(`\n  ${label} (${palette.length} colors):`);
    for (let i = 0; i < palette.length; i++) {
        console.log(`    [${i}] ${fmtLab(palette[i])}`);
    }
}

function comparePalettes(labelA, paletteA, labelB, paletteB) {
    console.log(`\n  ── ${labelA} vs ${labelB} ──`);
    const n = Math.max(paletteA.length, paletteB.length);
    let maxDE = 0;
    let sumDE = 0;
    let matched = 0;

    for (let i = 0; i < n; i++) {
        const a = paletteA[i];
        const b = paletteB[i];
        if (!a || !b) {
            console.log(`    [${i}] ${a ? fmtLab(a) : '(missing)'} vs ${b ? fmtLab(b) : '(missing)'}`);
            continue;
        }
        const de = deltaE76(a, b);
        maxDE = Math.max(maxDE, de);
        sumDE += de;
        matched++;
        const flag = de > 3.0 ? ' ⚠️' : de > 1.0 ? ' ~' : ' ✓';
        console.log(`    [${i}] ΔE=${de.toFixed(2)}${flag}  A:(${fmtLab(a)})  B:(${fmtLab(b)})`);
    }

    if (matched > 0) {
        console.log(`    Summary: avgΔE=${(sumDE / matched).toFixed(2)}, maxΔE=${maxDE.toFixed(2)}, count A=${paletteA.length} B=${paletteB.length}`);
    }
    return { maxDE, avgDE: matched > 0 ? sumDE / matched : 0 };
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
    const inputPath = process.argv[2] || '/workspaces/electrosaur/fixtures/JethroAsMonroe-original-16bit.psd';
    const archetypeId = process.argv[3] || 'subtle_naturalist';

    console.log(`═══════════════════════════════════════════════════════════`);
    console.log(`  Code Path Comparison: ${path.basename(inputPath)}`);
    console.log(`  Archetype: ${archetypeId}`);
    console.log(`═══════════════════════════════════════════════════════════`);

    // ─── 1. Read PSD ──────────────────────────────────────
    console.log(`\n[1] Reading PSD...`);
    const buffer = fs.readFileSync(inputPath);
    const psd = readPsd(buffer);
    const { width, height, depth, data: labData } = psd;
    const pixelCount = width * height;
    console.log(`    ${width}×${height} ${depth}-bit Lab, ${pixelCount} pixels`);

    let lab16bit;
    if (depth === 16) {
        lab16bit = convertPsd16bitToEngineLab(labData, pixelCount);
    } else {
        throw new Error('This script expects 16-bit Lab PSD input');
    }

    // ─── 2. DNA analysis ──────────────────────────────────
    console.log(`\n[2] DNA analysis...`);
    const dnaGen = new Reveal.DNAGenerator();
    const dna = dnaGen.generate(lab16bit, width, height, { bitDepth: 16 });
    console.log(`    L=${dna.global.l}, C=${dna.global.c}, K=${dna.global.k}, σL=${dna.global.l_std_dev}`);
    console.log(`    Dominant sector: ${dna.dominant_sector}, Entropy: ${dna.global.hue_entropy.toFixed(3)}`);

    // ─── 3. Generate config for archetype ─────────────────
    console.log(`\n[3] Generating config for ${archetypeId}...`);
    const config = Reveal.generateConfiguration(dna, { manualArchetypeId: archetypeId });
    console.log(`    targetColors: ${config.targetColors}`);
    console.log(`    distanceMetric: ${config.distanceMetric}`);
    console.log(`    lWeight: ${config.lWeight}, cWeight: ${config.cWeight}, blackBias: ${config.blackBias}`);
    console.log(`    enablePaletteReduction: ${config.enablePaletteReduction}, paletteReduction: ${config.paletteReduction}`);
    console.log(`    vibrancyMode: ${config.vibrancyMode}, vibrancyBoost: ${config.vibrancyBoost}`);
    console.log(`    preprocessingIntensity: ${config.preprocessingIntensity}`);
    console.log(`    enableHueGapAnalysis: ${config.enableHueGapAnalysis}`);
    console.log(`    preserveWhite: ${config.preserveWhite}, preserveBlack: ${config.preserveBlack}`);
    console.log(`    bitDepth: ${config.bitDepth} (top-level — should be 16 for 16-bit Lab)`);

    // ─── PATH A: "reveal-adobe" style (full-res, bilateral, posterize) ───
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  PATH A: reveal-adobe style (full-res + bilateral + posterize)`);
    console.log(`${'═'.repeat(60)}`);

    // A.1 Bilateral filter on full-res
    const labA = new Uint16Array(lab16bit);  // Deep copy
    const preprocessIntensity = config.preprocessingIntensity || 'auto';
    if (preprocessIntensity !== 'off') {
        const isHeavy = preprocessIntensity === 'heavy';
        const radius = isHeavy ? 5 : 3;
        const sigmaR = 5000;  // 16-bit
        console.log(`  [A.1] Bilateral filter: radius=${radius}, sigmaR=${sigmaR}`);
        const t0 = performance.now();
        BilateralFilter.applyBilateralFilterLab(labA, width, height, radius, sigmaR);
        console.log(`         Done in ${(performance.now() - t0).toFixed(0)}ms`);
    }

    // A.2 Posterize — use targetColors=10 as the user sets in reveal-adobe
    const TC = 10;
    console.log(`  [A.2] Posterizing (tc=${TC}, ${config.distanceMetric}, bitDepth=${config.bitDepth})...`);
    const paramsA = {
        ...config,
        format: 'lab',
        engineType: config.engineType || 'reveal-mk1.5'
    };
    const t1 = performance.now();
    const posterizeA = await PosterizationEngine.posterize(
        labA, width, height,
        TC,
        paramsA
    );
    console.log(`         Done in ${(performance.now() - t1).toFixed(0)}ms`);
    printPalette('PATH A Palette', posterizeA.paletteLab);

    // A.3 Separation
    console.log(`  [A.3] Separating...`);
    const t2 = performance.now();
    const indicesA = await SeparationEngine.mapPixelsToPaletteAsync(
        labA, posterizeA.paletteLab, null, width, height,
        { ditherType: config.ditherType, distanceMetric: config.distanceMetric }
    );
    console.log(`         Done in ${(performance.now() - t2).toFixed(0)}ms`);

    // Count pixels per color
    const countsA = new Array(posterizeA.paletteLab.length).fill(0);
    for (let i = 0; i < indicesA.length; i++) countsA[indicesA[i]]++;
    console.log(`  [A.4] Coverage:`);
    for (let i = 0; i < posterizeA.paletteLab.length; i++) {
        const pct = ((countsA[i] / pixelCount) * 100).toFixed(2);
        console.log(`    [${i}] ${pct}% (${countsA[i]} px)  ${fmtLab(posterizeA.paletteLab[i])}`);
    }

    // ─── PATH B: Navigator/ProxyEngine style ─────────────────
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  PATH B: Navigator/ProxyEngine style (800px downsample + bilateral + posterize)`);
    console.log(`${'═'.repeat(60)}`);

    // B.1 ProxyEngine does: downsample → bilateral → posterize → separate
    const proxyEngine = new ProxyEngine();
    console.log(`  [B.1] ProxyEngine.initializeProxy() (includes downsample + bilateral + posterize + separate)...`);
    const proxyConfig = {
        ...config,
        targetColors: TC,
        targetColorsSlider: TC,
        engineType: config.engineType || 'reveal-mk1.5'
    };
    const t3 = performance.now();
    const proxyResult = await proxyEngine.initializeProxy(lab16bit, width, height, proxyConfig);
    console.log(`         Done in ${(performance.now() - t3).toFixed(0)}ms`);
    console.log(`         Proxy dimensions: ${proxyResult.dimensions.width}×${proxyResult.dimensions.height}`);
    printPalette('PATH B Palette', proxyResult.palette);

    // Count proxy pixels per color
    const indicesB = proxyEngine.separationState.colorIndices;
    const proxyPixels = proxyResult.dimensions.width * proxyResult.dimensions.height;
    const countsB = new Array(proxyResult.palette.length).fill(0);
    for (let i = 0; i < indicesB.length; i++) countsB[indicesB[i]]++;
    console.log(`  [B.2] Coverage:`);
    for (let i = 0; i < proxyResult.palette.length; i++) {
        const pct = ((countsB[i] / proxyPixels) * 100).toFixed(2);
        console.log(`    [${i}] ${pct}% (${countsB[i]} px)  ${fmtLab(proxyResult.palette[i])}`);
    }

    // ─── PATH D: mk1.5 with targetColors=10 (user's likely setting) ──
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  PATH D: mk1.5 + targetColors=10 + user sliders`);
    console.log(`  (lWeight=1.0, cWeight=4, blackBias=6)`);
    console.log(`${'═'.repeat(60)}`);

    const paramsD = {
        ...config,
        format: 'lab',
        bitDepth: 16,
        engineType: 'reveal-mk1.5',
        lWeight: 1.0,
        cWeight: 4.0,
        blackBias: 6.0
    };
    const posterizeD = await PosterizationEngine.posterize(
        labA, width, height, 10, paramsD
    );
    printPalette('PATH D (mk1.5, tc=10, user sliders)', posterizeD.paletteLab);

    // ─── PATH E: mk1.5 with targetColors=10 + archetype params ──
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  PATH E: mk1.5 + targetColors=10 + archetype params`);
    console.log(`${'═'.repeat(60)}`);

    const paramsE = {
        ...config,
        format: 'lab',
        bitDepth: 16,
        engineType: 'reveal-mk1.5'
    };
    const posterizeE = await PosterizationEngine.posterize(
        labA, width, height, 10, paramsE
    );
    printPalette('PATH E (mk1.5, tc=10, archetype params)', posterizeE.paletteLab);

    // ─── PATH F: mk1.5 with targetColors=8 + user sliders (baseline) ──
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  PATH F: mk1.5 + targetColors=8 + user sliders`);
    console.log(`${'═'.repeat(60)}`);

    const paramsF = {
        ...config,
        format: 'lab',
        bitDepth: 16,
        engineType: 'reveal-mk1.5',
        lWeight: 1.0,
        cWeight: 4.0,
        blackBias: 6.0
    };
    const posterizeF = await PosterizationEngine.posterize(
        labA, width, height, 8, paramsF
    );
    printPalette('PATH F (mk1.5, tc=8, user sliders)', posterizeF.paletteLab);

    // ─── Compare all against user's reported reveal-adobe palette ──
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  USER'S REPORTED reveal-adobe PALETTE`);
    console.log(`${'═'.repeat(60)}`);
    const userPalette = [
        { L: 65, a: -57, b: 44 },
        { L: 68, a: 52, b: 62 },
        { L: 88, a: -6, b: 86 },
        { L: 75, a: 0, b: 0 },
        { L: 41, a: -8, b: -28 },
        { L: 35, a: 2, b: -37 },
        { L: 62, a: 79, b: -45 },
        { L: 100, a: 0, b: 0 },
        { L: 0, a: 0, b: 0 }
    ];
    printPalette('User palette', userPalette);

    function bestMatchSummary(label, testPalette) {
        console.log(`\n  ── Best-Match: User → ${label} ──`);
        let sumDE = 0, count = 0;
        for (let i = 0; i < userPalette.length; i++) {
            let bestJ = -1, bestDE = Infinity;
            for (let j = 0; j < testPalette.length; j++) {
                const de = deltaE76(userPalette[i], testPalette[j]);
                if (de < bestDE) { bestDE = de; bestJ = j; }
            }
            sumDE += bestDE;
            count++;
            const flag = bestDE > 10 ? ' ⚠️ NO MATCH' : bestDE > 3 ? ' ~' : ' ✓';
            console.log(`    User[${i}] → [${bestJ}] ΔE=${bestDE.toFixed(1)}${flag}  (${fmtLab(userPalette[i])}) → (${fmtLab(testPalette[bestJ])})`);
        }
        const avg = sumDE / count;
        console.log(`    Avg best-match ΔE: ${avg.toFixed(1)}  (${count} colors)`);
        return avg;
    }

    const scoreA = bestMatchSummary('PATH A (mk1.5, archetype params, full-res)', posterizeA.paletteLab);
    const scoreB = bestMatchSummary('PATH B (ProxyEngine 800px)', proxyResult.palette);
    const scoreD = bestMatchSummary('PATH D (mk1.5, user sliders, full-res)', posterizeD.paletteLab);
    const scoreE = bestMatchSummary('PATH E (reveal engine, archetype params)', posterizeE.paletteLab);
    const scoreF = bestMatchSummary('PATH F (reveal engine, user sliders)', posterizeF.paletteLab);

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  SCORE RANKING (lower = closer to user's palette)`);
    console.log(`${'═'.repeat(60)}`);
    const scores = [
        { label: 'A: mk1.5 + archetype params + full-res', score: scoreA },
        { label: 'B: ProxyEngine 800px', score: scoreB },
        { label: 'D: mk1.5 + user sliders + full-res', score: scoreD },
        { label: 'E: reveal + archetype params + full-res', score: scoreE },
        { label: 'F: reveal + user sliders + full-res', score: scoreF }
    ];
    scores.sort((a, b) => a.score - b.score);
    for (const s of scores) {
        console.log(`    ${s.score.toFixed(1)} ΔE  ${s.label}`);
    }

    // ─── PATH C: Direct posterize on ProxyEngine's 800px buffer (same input as B) ──
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  PATH C: Direct posterize on ProxyEngine's 800px bilateral-filtered buffer`);
    console.log(`  (isolates config differences from input differences)`);
    console.log(`${'═'.repeat(60)}`);

    const proxyBuf = proxyEngine.proxyBuffer;
    const proxyW = proxyResult.dimensions.width;
    const proxyH = proxyResult.dimensions.height;

    // C.1 Posterize with the SAME config but using PosterizationEngine directly
    const paramsC = {
        ...config,
        format: 'lab',
        engineType: config.engineType || 'reveal-mk1.5'
    };
    console.log(`  [C.1] PosterizationEngine.posterize() on 800px buffer (tc=${TC}, bitDepth=${config.bitDepth})...`);
    const t4 = performance.now();
    const posterizeC = await PosterizationEngine.posterize(
        proxyBuf, proxyW, proxyH,
        TC,
        paramsC
    );
    console.log(`         Done in ${(performance.now() - t4).toFixed(0)}ms`);
    printPalette('PATH C Palette', posterizeC.paletteLab);

    // ─── COMPARISONS ──────────────────────────────────────
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  PALETTE COMPARISONS`);
    console.log(`${'═'.repeat(60)}`);

    // A vs B: full-res vs proxy (expected to differ due to input data)
    const abStats = comparePalettes('PATH A (full-res)', posterizeA.paletteLab, 'PATH B (ProxyEngine)', proxyResult.palette);

    // B vs C: ProxyEngine vs direct-on-proxy-buffer (should be identical if config matches)
    const bcStats = comparePalettes('PATH B (ProxyEngine)', proxyResult.palette, 'PATH C (direct on proxy buf)', posterizeC.paletteLab);

    // A vs C: full-res vs proxy-buffer-direct (input differs, config same)
    const acStats = comparePalettes('PATH A (full-res)', posterizeA.paletteLab, 'PATH C (direct on proxy buf)', posterizeC.paletteLab);

    // ─── Best-Match Comparison (A vs B) ─────────────────
    console.log(`\n  ── Best-Match: each A color → nearest B color ──`);
    for (let i = 0; i < posterizeA.paletteLab.length; i++) {
        let bestJ = -1, bestDE = Infinity;
        for (let j = 0; j < proxyResult.palette.length; j++) {
            const de = deltaE76(posterizeA.paletteLab[i], proxyResult.palette[j]);
            if (de < bestDE) { bestDE = de; bestJ = j; }
        }
        const flag = bestDE > 10 ? ' ⚠️ NO MATCH' : bestDE > 3 ? ' ~' : ' ✓';
        console.log(`    A[${i}] → B[${bestJ}] ΔE=${bestDE.toFixed(2)}${flag}  A:(${fmtLab(posterizeA.paletteLab[i])})  B:(${fmtLab(proxyResult.palette[bestJ])})`);
    }
    console.log(`\n  ── Best-Match: each B color → nearest A color ──`);
    for (let i = 0; i < proxyResult.palette.length; i++) {
        let bestJ = -1, bestDE = Infinity;
        for (let j = 0; j < posterizeA.paletteLab.length; j++) {
            const de = deltaE76(proxyResult.palette[i], posterizeA.paletteLab[j]);
            if (de < bestDE) { bestDE = de; bestJ = j; }
        }
        const flag = bestDE > 10 ? ' ⚠️ NO MATCH' : bestDE > 3 ? ' ~' : ' ✓';
        console.log(`    B[${i}] → A[${bestJ}] ΔE=${bestDE.toFixed(2)}${flag}  B:(${fmtLab(proxyResult.palette[i])})  A:(${fmtLab(posterizeA.paletteLab[bestJ])})`);
    }

    // ─── VERDICT ──────────────────────────────────────────
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  VERDICT`);
    console.log(`${'═'.repeat(60)}`);

    if (bcStats.maxDE < 0.01) {
        console.log(`  ✅ B vs C: IDENTICAL — ProxyEngine uses same config as direct posterize`);
    } else {
        console.log(`  ⚠️  B vs C: DIVERGED (maxΔE=${bcStats.maxDE.toFixed(2)}) — config mismatch!`);
    }

    if (abStats.maxDE < 5.0) {
        console.log(`  ✅ A vs B: Close (maxΔE=${abStats.maxDE.toFixed(2)}) — input data differences only`);
    } else {
        console.log(`  ⚠️  A vs B: Significant divergence (maxΔE=${abStats.maxDE.toFixed(2)})`);
    }

    console.log(`\n  Config used:`);
    console.log(`    snapThreshold: ${config.snapThreshold ?? '(default 8.0)'}`);
    console.log(`    enablePaletteReduction: ${config.enablePaletteReduction}`);
    console.log(`    paletteReduction: ${config.paletteReduction}`);
    console.log(`    densityFloor: ${config.densityFloor ?? '(default 0.005)'}`);
    console.log(`    preservedUnifyThreshold: ${config.preservedUnifyThreshold ?? '(default 12.0)'}`);
}

main().catch(err => {
    console.error(`\nFATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
