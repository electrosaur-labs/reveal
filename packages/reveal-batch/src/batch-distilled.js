#!/usr/bin/env node
/**
 * batch-distilled.js
 *
 * Runs distilledPosterize at K=12 on all TESTIMAGES 16-bit Lab PSDs.
 * Writes per-image sidecar JSON (deltaE, DNA fidelity, revelation score,
 * integrity) and a top-level batch-report.json for analysis.
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

const OPTS = {
    bitDepth:               16,
    engineType:             'reveal-mk2',
    format:                 'lab',
    enablePaletteReduction: false,
    snapThreshold:          0,
    densityFloor:           0,
};

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

    // ── Distilled posterize ───────────────────────────────────────────────────
    const result = PosterizationEngine.distilledPosterize(lab16, width, height, TARGET_K, OPTS);
    const { paletteLab, assignments } = result;
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
    const inputDNA  = Reveal.DNAGenerator.fromPixels
        ? Reveal.DNAGenerator.fromPixels(lab8, width, height)
        : null;
    const outputDNA = Reveal.DNAGenerator.fromIndices(assignments, paletteLab, width, height);
    const dnaFidelity = inputDNA
        ? Reveal.DNAFidelity.compare(inputDNA, outputDNA)
        : null;

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

    // ── Write sidecar JSON ────────────────────────────────────────────────────
    const sidecar = {
        meta: {
            filename: path.basename(inputPath),
            timestamp: new Date().toISOString(),
            width, height, depth,
            targetK: TARGET_K,
            actualColors: K,
            overCount: result.metadata.overCount,
            ms: Date.now() - t0,
        },
        deltaE: {
            avg:  metrics.global_fidelity.avgDeltaE,
            max:  metrics.global_fidelity.maxDeltaE,
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
        palette,
    };

    fs.writeFileSync(
        path.join(outputDir, `${basename}.json`),
        JSON.stringify(sidecar, null, 2)
    );

    return {
        basename, width, height, colors: K,
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

    console.log(`\nDistilled Posterize  K=${TARGET_K}  —  TESTIMAGES`);
    console.log('━'.repeat(72));
    console.log(`Input:  ${INPUT_DIR}`);
    console.log(`Output: ${OUTPUT_DIR}`);
    console.log(`Images: ${files.length}\n`);
    console.log(`${'Image'.padEnd(22)}  ${'Size'.padEnd(12)}  ${'ΔE avg'.padEnd(8)}  ${'Reveal'.padEnd(8)}  ${'Integrity'.padEnd(10)}  ms`);
    console.log('─'.repeat(72));

    const report  = [];
    const t0Batch = Date.now();
    let passed = 0, failed = 0;

    for (const filename of files) {
        const inputPath = path.join(INPUT_DIR, filename);
        try {
            const info = processFile(inputPath, OUTPUT_DIR);
            console.log(
                `  ${info.basename.padEnd(20)}  ${(info.width+'×'+info.height).padEnd(12)}` +
                `  ${String(info.avgDeltaE).padEnd(8)}  ${String(info.revelation).padEnd(8)}` +
                `  ${String(info.integrity).padEnd(10)}  ${info.ms}ms`
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
    console.log('─'.repeat(72));
    console.log(`Done: ${passed} passed, ${failed} failed  (${(totalMs / 1000).toFixed(1)}s total, avg ${(totalMs / files.length / 1000).toFixed(1)}s)\n`);

    // Aggregate stats
    const successful = report.filter(r => r.success);
    if (successful.length > 0) {
        const avgDeltaE   = (successful.reduce((s, r) => s + r.avgDeltaE,  0) / successful.length).toFixed(2);
        const avgRevel    = (successful.reduce((s, r) => s + r.revelation, 0) / successful.length).toFixed(1);
        const avgInteg    = (successful.reduce((s, r) => s + r.integrity,  0) / successful.length).toFixed(1);
        console.log(`Averages:  ΔE=${avgDeltaE}  Revelation=${avgRevel}  Integrity=${avgInteg}`);
    }

    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'batch-report.json'),
        JSON.stringify({ targetK: TARGET_K, timestamp: new Date().toISOString(), report }, null, 2)
    );
    console.log(`\nReport: ${OUTPUT_DIR}/batch-report.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
