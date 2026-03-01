#!/usr/bin/env node
/**
 * batch-distilled.js
 *
 * Runs distilledPosterize at K=12 on all TESTIMAGES 16-bit Lab PSDs.
 * Uses full DNA analysis + ParameterGenerator (same archetype pipeline as
 * production), overriding only the distiller-specific prune/snap settings.
 *
 * Writes per-image sidecar JSON (deltaE, DNA fidelity, revelation, integrity,
 * palette, archetype, distillation block) and a top-level batch-report.json.
 *
 * Usage: node batch-distilled.js [targetK]
 *   Defaults to K=12
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { readPsd }             = require('@reveal/psd-reader');
const { PSDWriter }           = require('@reveal/psd-writer');
const Reveal                  = require('@reveal/core');
const { LabEncoding }         = Reveal;
const { PosterizationEngine } = Reveal.engines;
const MetricsCalculator       = require('./MetricsCalculator');
const {
    convertPsd16bitToEngineLab,
    convert8bitTo16bitLab,
    convertEngine16bitTo8bitLab,
    convertPsd16bitTo8bitLab,
} = LabEncoding;

const DATA_DIR   = path.join(__dirname, '../data/TESTIMAGES');
const INPUT_DIR  = path.join(DATA_DIR, 'input/psd/16bit');
const TARGET_K   = parseInt(process.argv[2] || '12', 10);
const OUTPUT_DIR = path.join(DATA_DIR, `output/psd/distilled-k${TARGET_K}`);

// Fixed options for the distilled posterize pass.
// Archetype guidance (vibrancy, centroid weights, distance metric) is NOT
// applied here because ImageHeuristicAnalyzer's 3-bucket classifier is too
// coarse — it misclassifies structural/architectural images as deep-shadow-noir
// and applies vibrancy settings that degrade clean tonal separations.
// The neutral SALIENCY + cie76 approach outperforms archetype-guided on this
// dataset (34/40 improved vs 14/40). Archetype label is saved as metadata only.
const OPTS = {
    bitDepth:               16,
    engineType:             'reveal-mk2',
    format:                 'lab',
    enablePaletteReduction: false,
    snapThreshold:          0,
    densityFloor:           0,
};

/**
 * CIE76 nearest-neighbor assignment in 16-bit Lab space.
 * Used for the direct-engine path where posterize() doesn't return assignments.
 */
function buildAssignments(lab16, paletteLab, pixelCount) {
    const K = paletteLab.length;
    const palL = new Float64Array(K);
    const palA = new Float64Array(K);
    const palB = new Float64Array(K);
    for (let j = 0; j < K; j++) {
        palL[j] = (paletteLab[j].L / 100) * 32768;
        palA[j] = (paletteLab[j].a / 128) * 16384 + 16384;
        palB[j] = (paletteLab[j].b / 128) * 16384 + 16384;
    }
    const result = new Uint8Array(pixelCount);
    for (let p = 0; p < pixelCount; p++) {
        const off = p * 3;
        const pL = lab16[off], pA = lab16[off + 1], pB = lab16[off + 2];
        let best = 0, minDist = Infinity;
        for (let c = 0; c < K; c++) {
            const dL = pL - palL[c], dA = pA - palA[c], dB = pB - palB[c];
            const d = dL * dL + dA * dA + dB * dB;
            if (d < minDist) { minDist = d; best = c; }
        }
        result[p] = best;
    }
    return result;
}

function processFile(inputPath, outputDir) {
    const basename   = path.basename(inputPath, '.psd');
    const t0         = Date.now();

    // ── Read PSD ─────────────────────────────────────────────────────────────
    const buffer  = fs.readFileSync(inputPath);
    const psd     = readPsd(buffer);
    const { width, height, depth, data: psdData } = psd;
    const pixelCount = width * height;

    // ── Convert to engine 16-bit and 8-bit ───────────────────────────────────
    const lab16 = depth === 16
        ? convertPsd16bitToEngineLab(psdData, pixelCount)
        : convert8bitTo16bitLab(psdData, pixelCount);

    const lab8 = depth === 16
        ? convertPsd16bitTo8bitLab(psdData, pixelCount)
        : new Uint8Array(psdData);

    // ── DNA v2.0 analysis + archetype matching ────────────────────────────────
    const dna2           = Reveal.DNAGenerator.fromPixels(lab8, width, height);
    const matchedArch    = Reveal.ArchetypeLoader.matchArchetype(dna2);
    const archetypeId    = matchedArch.id;
    const engineMode     = matchedArch.engine || 'distilled';

    // ── Route by archetype engine field ───────────────────────────────────────
    let paletteLab, assignments, rMeta;

    if (engineMode === 'direct') {
        // Use archetype parameters with standard posterize (chroma-weighted centroids)
        const directParams = {
            ...matchedArch.parameters,
            bitDepth:   16,
            engineType: 'reveal-mk2',
            format:     'lab',
        };
        const directResult = PosterizationEngine.posterize(lab16, width, height, TARGET_K, directParams);
        paletteLab  = directResult.paletteLab;
        assignments = buildAssignments(lab16, paletteLab, pixelCount);
        rMeta       = { overCount: 0, ghostsExcluded: 0, keptIndices: [], overPaletteLab: [], overCoverageCounts: null };
    } else {
        // Distilled: over-quantize to 3×K then furthest-point reduce.
        // ghostFloor from archetype raises the min-coverage threshold for FPS
        // selection, preventing low-coverage outliers from consuming screen slots.
        const distOpts = matchedArch.parameters.ghostFloor !== undefined
            ? { ...OPTS, ghostFloor: matchedArch.parameters.ghostFloor }
            : OPTS;
        const distResult = PosterizationEngine.distilledPosterize(lab16, width, height, TARGET_K, distOpts);
        paletteLab  = distResult.paletteLab;
        assignments = distResult.assignments;
        rMeta       = distResult.metadata;
    }

    const K = paletteLab.length;

    // ── Coverage counts ───────────────────────────────────────────────────────
    const counts = new Uint32Array(K);
    for (let i = 0; i < pixelCount; i++) counts[assignments[i]]++;

    // ── Build masks ───────────────────────────────────────────────────────────
    const masks = Array.from({ length: K }, () => new Uint8Array(pixelCount));
    for (let i = 0; i < pixelCount; i++) masks[assignments[i]][i] = 255;

    // ── Reconstruct processed Lab (8-bit) for metrics ────────────────────────
    const processedLab8 = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const c = paletteLab[assignments[i]];
        processedLab8[i * 3]     = Math.round((c.L / 100) * 255);
        processedLab8[i * 3 + 1] = Math.round(c.a + 128);
        processedLab8[i * 3 + 2] = Math.round(c.b + 128);
    }

    // ── Quality metrics ───────────────────────────────────────────────────────
    const layersForMetrics = paletteLab.map((c, k) => ({ color: c, mask: masks[k] }));
    const originalClamped  = lab8 instanceof Uint8ClampedArray
        ? lab8 : new Uint8ClampedArray(lab8);

    const metrics = MetricsCalculator.compute(
        originalClamped, processedLab8, layersForMetrics, width, height,
        { targetColors: TARGET_K }
    );

    // ── DNA fidelity ──────────────────────────────────────────────────────────
    const outputDNA   = Reveal.DNAGenerator.fromIndices(assignments, paletteLab, width, height);
    const dnaFidelity = Reveal.DNAFidelity.compare(dna2, outputDNA);

    // ── Write PSD ─────────────────────────────────────────────────────────────
    const lab8ref  = convertEngine16bitTo8bitLab(lab16, pixelCount);
    const writer   = new PSDWriter({ width, height, colorMode: 'lab', bitsPerChannel: 8 });

    writer.addPixelLayer({ name: 'Original (Reference)', pixels: lab8ref, visible: false });

    const sorted = paletteLab
        .map((c, k) => ({ c, mask: masks[k], coverage: counts[k] }))
        .sort((a, b) => b.c.L - a.c.L);

    for (const { c, mask } of sorted) {
        const rgb = Reveal.labToRgb(c);
        const hex = '#' + [rgb.r, rgb.g, rgb.b]
            .map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
        writer.addFillLayer({
            name:  `${hex} L=${c.L.toFixed(0)} a=${c.a.toFixed(0)} b=${c.b.toFixed(0)}`,
            color: c,
            mask,
        });
    }

    const psdBuf  = writer.write();
    fs.writeFileSync(path.join(outputDir, `${basename}.psd`), psdBuf);

    // ── Build palette summary ─────────────────────────────────────────────────
    const palette = paletteLab.map((c, k) => {
        const rgb = Reveal.labToRgb(c);
        const hex = '#' + [rgb.r, rgb.g, rgb.b]
            .map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
        return {
            hex,
            L: +c.L.toFixed(1), a: +c.a.toFixed(1), b: +c.b.toFixed(1),
            coverage: +((counts[k] / pixelCount) * 100).toFixed(1),
        };
    }).sort((a, b) => b.coverage - a.coverage);

    // ── Build distillation block ──────────────────────────────────────────────
    // Over-palette: all colors the over-quantizer produced, with coverage pcts.
    const overPalette = (rMeta.overPaletteLab || []).map((c, i) => {
        const rgb = Reveal.labToRgb(c);
        const hex = '#' + [rgb.r, rgb.g, rgb.b]
            .map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
        const coveragePct = rMeta.overCoverageCounts
            ? +((rMeta.overCoverageCounts[i] / pixelCount) * 100).toFixed(2)
            : null;
        return { hex, L: +c.L.toFixed(1), a: +c.a.toFixed(1), b: +c.b.toFixed(1), coverage: coveragePct };
    });

    // ── Write sidecar JSON ────────────────────────────────────────────────────
    const sidecar = {
        meta: {
            filename:     path.basename(inputPath),
            timestamp:    new Date().toISOString(),
            width, height, depth,
            targetK:      TARGET_K,
            actualColors: K,
            overCount:    rMeta.overCount,
            archetype:    archetypeId,
            engine:       engineMode,
            ms:           Date.now() - t0,
        },
        deltaE: {
            avg: metrics.global_fidelity.avgDeltaE,
            max: metrics.global_fidelity.maxDeltaE,
        },
        scores: {
            revelation: metrics.feature_preservation.revelationScore,
            integrity:  metrics.physical_feasibility.integrityScore,
        },
        dnaFidelity: dnaFidelity ? {
            fidelity:    dnaFidelity.fidelity,
            sectorDrift: dnaFidelity.sectorDrift,
            alerts:      dnaFidelity.alerts,
        } : null,
        distillation: {
            ghostsExcluded: rMeta.ghostsExcluded ?? 0,
            keptIndices:    rMeta.keptIndices || [],
            overPalette,
        },
        palette,
    };

    fs.writeFileSync(
        path.join(outputDir, `${basename}.json`),
        JSON.stringify(sidecar, null, 2)
    );

    return {
        basename, width, height, colors: K, archetype: archetypeId, engine: engineMode,
        avgDeltaE:    metrics.global_fidelity.avgDeltaE,
        revelation:   metrics.feature_preservation.revelationScore,
        integrity:    metrics.physical_feasibility.integrityScore,
        dnaFidelity:  dnaFidelity?.fidelity ?? 'n/a',
        ms: Date.now() - t0,
    };
}

async function main() {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const files = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith('.psd')).sort();

    console.log(`\nDistilled Posterize  K=${TARGET_K}  —  TESTIMAGES  (archetype-guided)`);
    console.log('━'.repeat(80));
    console.log(`Input:  ${INPUT_DIR}`);
    console.log(`Output: ${OUTPUT_DIR}`);
    console.log(`Images: ${files.length}\n`);
    console.log(`${'Image'.padEnd(22)}  ${'Archetype'.padEnd(22)}  ${'Engine'.padEnd(10)}  ${'ΔE avg'.padEnd(8)}  ${'Reveal'.padEnd(8)}  ms`);
    console.log('─'.repeat(80));

    const report  = [];
    const t0Batch = Date.now();
    let passed = 0, failed = 0;

    for (const filename of files) {
        const inputPath = path.join(INPUT_DIR, filename);
        try {
            const info = processFile(inputPath, OUTPUT_DIR);
            console.log(
                `  ${info.basename.padEnd(20)}  ${info.archetype.padEnd(22)}  ${(info.engine || '').padEnd(10)}` +
                `  ${String(info.avgDeltaE).padEnd(8)}  ${String(info.revelation).padEnd(8)}  ${info.ms}ms`
            );
            report.push({ ...info, success: true });
            passed++;
        } catch (err) {
            console.error(`  ✗ ${filename.padEnd(22)}  ERROR: ${err.message}`);
            report.push({ basename: filename, success: false, error: err.message });
            failed++;
        }
    }

    const totalMs = Date.now() - t0Batch;
    console.log('─'.repeat(80));
    console.log(`Done: ${passed} passed, ${failed} failed  (${(totalMs / 1000).toFixed(1)}s total, avg ${(totalMs / files.length / 1000).toFixed(1)}s)\n`);

    // Aggregate stats
    const successful = report.filter(r => r.success);
    if (successful.length > 0) {
        const avgDeltaE = (successful.reduce((s, r) => s + r.avgDeltaE,  0) / successful.length).toFixed(2);
        const avgRevel  = (successful.reduce((s, r) => s + r.revelation, 0) / successful.length).toFixed(1);
        const avgInteg  = (successful.reduce((s, r) => s + r.integrity,  0) / successful.length).toFixed(1);
        console.log(`Averages:  ΔE=${avgDeltaE}  Revelation=${avgRevel}  Integrity=${avgInteg}`);
    }

    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'batch-report.json'),
        JSON.stringify({ targetK: TARGET_K, timestamp: new Date().toISOString(), report }, null, 2)
    );
    console.log(`\nReport: ${OUTPUT_DIR}/batch-report.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
