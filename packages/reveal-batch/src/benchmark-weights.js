#!/usr/bin/env node
/**
 * benchmark-weights.js — Three-way archetype scoring weight comparison
 *
 * Runs the full posterization pipeline (including PSD output) for each of
 * three weight configurations on all TESTIMAGES:
 *
 *   baseline  — 40 / 45 / 15  (current production)
 *   dev       — 35 / 40 / 25  (Developer proposal from debate)
 *   arch      — 35 / 30 / 35  (Architect proposal from debate)
 *
 * For each config, the archetype is selected using a custom ArchetypeMapper
 * instance with the given weights, then passed as an explicit override to
 * the full posterization pipeline.
 *
 * Output directories:
 *   <output-root>/baseline-40-45-15/   40 PSDs + 40 JSON sidecars
 *   <output-root>/dev-35-40-25/        40 PSDs + 40 JSON sidecars
 *   <output-root>/arch-35-30-35/       40 PSDs + 40 JSON sidecars
 *   <output-root>/weight-comparison.json
 *   <output-root>/weight-comparison.csv
 *
 * Usage:
 *   node benchmark-weights.js <input-dir> <output-root>
 *
 * Example:
 *   node benchmark-weights.js \
 *     data/TESTIMAGES/input/psd/16bit \
 *     data/TESTIMAGES/output/weight-benchmark
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const chalk = require('chalk');

const Reveal          = require('@electrosaur-labs/core');
const { readPsd }     = require('@electrosaur-labs/psd-reader');
const { posterizePsd } = require('./posterize-psd');

const ArchetypeMapper = Reveal.ArchetypeMapper;
const ArchetypeLoader = Reveal.ArchetypeLoader;
const DNAGenerator    = Reveal.DNAGenerator;

const { convertPsd16bitToEngineLab } = require('./batch-utils');

// ─── Weight configurations ────────────────────────────────────────────────────

const CONFIGS = [
    { id: 'baseline', label: '40/45/15 (baseline)',    dir: 'baseline-40-45-15', wStructural: 0.40, wSector: 0.45, wPattern: 0.15 },
    { id: 'dev',      label: '35/40/25 (dev proposal)', dir: 'dev-35-40-25',      wStructural: 0.35, wSector: 0.40, wPattern: 0.25 },
    { id: 'arch',     label: '35/30/35 (arch proposal)', dir: 'arch-35-30-35',    wStructural: 0.35, wSector: 0.30, wPattern: 0.35 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function pad(s, n) {
    const str = String(s);
    return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function rpad(s, n) {
    const str = String(s);
    return str.length >= n ? str : ' '.repeat(n - str.length) + str;
}

/**
 * Select the best archetype for a given DNA using custom scoring weights.
 * Returns the winning archetype ID and top-3 ranking for logging.
 */
function selectArchetype(dna, archetypes, cfg) {
    const mapper = new ArchetypeMapper(archetypes, {
        wStructural: cfg.wStructural,
        wSector:     cfg.wSector,
        wPattern:    cfg.wPattern,
    });
    const top = mapper.getTopMatches(dna, 3);
    return { winner: top[0].id, score: top[0].score, top3: top };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log(chalk.yellow(`
Usage: node benchmark-weights.js <input-dir> <output-root>

  input-dir    Directory containing 16-bit Lab PSDs (TESTIMAGES)
  output-root  Root directory for per-config output subdirectories

Example:
  node benchmark-weights.js \\
    data/TESTIMAGES/input/psd/16bit \\
    data/TESTIMAGES/output/weight-benchmark
`));
        process.exit(1);
    }

    const inputDir   = path.resolve(args[0]);
    const outputRoot = path.resolve(args[1]);

    if (!fs.existsSync(inputDir)) {
        console.error(chalk.red(`Input directory not found: ${inputDir}`));
        process.exit(1);
    }

    const files = fs.readdirSync(inputDir)
        .filter(f => f.endsWith('.psd'))
        .sort();

    if (files.length === 0) {
        console.error(chalk.red(`No PSD files found in ${inputDir}`));
        process.exit(1);
    }

    // Create output directories
    for (const cfg of CONFIGS) {
        fs.mkdirSync(path.join(outputRoot, cfg.dir), { recursive: true });
    }

    // Load archetypes once
    const archetypes = ArchetypeLoader.loadArchetypes();

    console.log(chalk.bold(`\n${'═'.repeat(70)}`));
    console.log(chalk.bold(` Weight Benchmark — ${files.length} images × ${CONFIGS.length} configs`));
    console.log(chalk.bold(`${'═'.repeat(70)}\n`));
    console.log(`Input:  ${inputDir}`);
    console.log(`Output: ${outputRoot}`);
    console.log(`Archetypes loaded: ${archetypes.length}\n`);

    // ── Per-image results ────────────────────────────────────────────────────
    // rows[filename] = { baseline: { archetype, deltaE }, dev: {...}, arch: {...} }
    const rows = {};
    const totalStart = Date.now();

    for (let fi = 0; fi < files.length; fi++) {
        const file     = files[fi];
        const basename = path.basename(file, '.psd');
        const inputPath = path.join(inputDir, file);

        console.log(chalk.bold(`\n[${fi + 1}/${files.length}] ${basename}`));

        // 1. Read PSD and compute DNA (once per image)
        const buffer       = fs.readFileSync(inputPath);
        const psd          = readPsd(buffer);
        const { width, height } = psd;
        const pixelCount   = width * height;
        const lab16bit     = convertPsd16bitToEngineLab(psd.data, pixelCount);
        const dna          = DNAGenerator.fromPixels(lab16bit, width, height, { bitDepth: 16 });
        // Shim legacy fields needed by posterize-psd internals
        dna.l        = dna.global.l;
        dna.c        = dna.global.c;
        dna.k        = dna.global.k;
        dna.l_std_dev = dna.global.l_std_dev;
        dna.maxC      = Math.max(...Object.values(dna.sectors).map(s => s.cMax || 0));
        dna.filename  = basename;
        dna.bitDepth  = psd.depth;

        rows[basename] = {};

        // 2. For each weight config: select archetype → run full pipeline
        for (const cfg of CONFIGS) {
            const { winner, score, top3 } = selectArchetype(dna, archetypes, cfg);
            const outDir = path.join(outputRoot, cfg.dir);

            console.log(
                chalk.cyan(`  [${cfg.id}]`) +
                ` → ${chalk.green(winner)} (${score.toFixed(1)})` +
                chalk.gray(`  top3: ${top3.map(m => `${m.id}(${m.score.toFixed(1)})`).join(', ')}`)
            );

            // Run full pipeline — writes PSD + JSON sidecar to outDir
            try {
                const result = await posterizePsd(inputPath, outDir, 16, { archetype: winner });
                rows[basename][cfg.id] = {
                    archetype: winner,
                    score:     parseFloat(score.toFixed(2)),
                    deltaE:    result.metrics.global_fidelity.avgDeltaE,
                    maxDeltaE: result.metrics.global_fidelity.maxDeltaE,
                    colors:    result.colors,
                };
            } catch (err) {
                console.error(chalk.red(`    ERROR: ${err.message}`));
                rows[basename][cfg.id] = { archetype: winner, score, deltaE: null, maxDeltaE: null, colors: null, error: err.message };
            }
        }
    }

    const elapsedSec = ((Date.now() - totalStart) / 1000).toFixed(1);

    // ── Build summary tables ─────────────────────────────────────────────────

    const imageNames  = Object.keys(rows).sort();
    const configIds   = CONFIGS.map(c => c.id);

    // Per-image deltaE per config
    const deltaEByConfig = {};
    configIds.forEach(id => { deltaEByConfig[id] = []; });

    // Which images flip between baseline and each alternative
    const flips = { dev: [], arch: [] };

    for (const name of imageNames) {
        const r = rows[name];
        configIds.forEach(id => {
            if (r[id]?.deltaE != null) deltaEByConfig[id].push(r[id].deltaE);
        });
        if (r.baseline?.archetype !== r.dev?.archetype)  flips.dev.push(name);
        if (r.baseline?.archetype !== r.arch?.archetype) flips.arch.push(name);
    }

    // Archetype frequency distribution per config
    const dist = {};
    configIds.forEach(id => { dist[id] = {}; });
    for (const name of imageNames) {
        for (const id of configIds) {
            const arch = rows[name][id]?.archetype;
            if (arch) dist[id][arch] = (dist[id][arch] || 0) + 1;
        }
    }

    // ── Console output ───────────────────────────────────────────────────────

    console.log(chalk.bold(`\n${'═'.repeat(70)}`));
    console.log(chalk.bold(` RESULTS`));
    console.log(chalk.bold(`${'═'.repeat(70)}\n`));

    // Per-image comparison table
    const COL = 22;
    const header = pad('Image', 20) + ' ' +
        CONFIGS.map(c => rpad(c.id, 8) + ' arch' + rpad('dE', 6)).join('  ');
    console.log(chalk.bold(header));
    console.log('─'.repeat(header.length));

    for (const name of imageNames) {
        const r    = rows[name];
        const base = r.baseline;
        let line   = pad(name, 20) + ' ';

        for (const cfg of CONFIGS) {
            const e = r[cfg.id];
            if (!e) { line += pad('—', 14) + '  '; continue; }
            const changed = cfg.id !== 'baseline' && e.archetype !== base?.archetype;
            const arch    = e.archetype.slice(0, 13).padEnd(13);
            const de      = e.deltaE != null ? e.deltaE.toFixed(2).padStart(6) : '  n/a';
            const seg     = `${arch} ${de}`;
            line += changed ? chalk.yellow(seg) : seg;
            line += '  ';
        }
        console.log(line);
    }

    // Mean deltaE summary
    console.log(chalk.bold(`\n── Mean ΔE ──`));
    for (const cfg of CONFIGS) {
        const m = mean(deltaEByConfig[cfg.id]);
        const marker = cfg.id === 'baseline' ? '' :
            (m < mean(deltaEByConfig.baseline) ? chalk.green(' ▼ better') : chalk.red(' ▲ worse'));
        console.log(`  ${pad(cfg.label, 30)} ${m.toFixed(3)}${marker}`);
    }

    // Flip summary
    console.log(chalk.bold(`\n── Archetype selection changes vs baseline ──`));
    console.log(`  dev  (35/40/25): ${flips.dev.length}/${imageNames.length} images changed`);
    if (flips.dev.length > 0) {
        flips.dev.forEach(name => {
            console.log(chalk.yellow(`    ${pad(name, 20)} ${rows[name].baseline.archetype} → ${rows[name].dev.archetype}`));
        });
    }
    console.log(`  arch (35/30/35): ${flips.arch.length}/${imageNames.length} images changed`);
    if (flips.arch.length > 0) {
        flips.arch.forEach(name => {
            console.log(chalk.yellow(`    ${pad(name, 20)} ${rows[name].baseline.archetype} → ${rows[name].arch.archetype}`));
        });
    }

    // Archetype distribution
    console.log(chalk.bold(`\n── Archetype distribution ──`));
    const allArchetypes = [...new Set(Object.values(dist).flatMap(d => Object.keys(d)))].sort();
    const distHeader = pad('Archetype', 22) + CONFIGS.map(c => rpad(c.id, 10)).join('');
    console.log(chalk.bold(distHeader));
    console.log('─'.repeat(distHeader.length));
    for (const arch of allArchetypes) {
        const counts = CONFIGS.map(c => rpad(dist[c.id][arch] || 0, 10)).join('');
        const hasChange = CONFIGS.slice(1).some(c => (dist[c.id][arch] || 0) !== (dist.baseline[arch] || 0));
        const line = pad(arch, 22) + counts;
        console.log(hasChange ? chalk.yellow(line) : line);
    }

    console.log(chalk.bold(`\n── Timing ──`));
    console.log(`  Total: ${elapsedSec}s  (${(elapsedSec / (imageNames.length * CONFIGS.length)).toFixed(2)}s/run)`);

    // ── Write JSON + CSV report ──────────────────────────────────────────────

    const report = {
        timestamp:   new Date().toISOString(),
        inputDir,
        configs:     CONFIGS.map(c => ({ id: c.id, label: c.label, weights: { structural: c.wStructural, sector: c.wSector, pattern: c.wPattern } })),
        summary: {
            meanDeltaE: Object.fromEntries(configIds.map(id => [id, parseFloat(mean(deltaEByConfig[id]).toFixed(3))])),
            selectionChanges: { dev: flips.dev.length, arch: flips.arch.length },
            distribution: dist,
        },
        flips: {
            dev:  flips.dev.map(n => ({ image: n, from: rows[n].baseline.archetype, to: rows[n].dev.archetype })),
            arch: flips.arch.map(n => ({ image: n, from: rows[n].baseline.archetype, to: rows[n].arch.archetype })),
        },
        images: imageNames.map(name => ({ image: name, ...rows[name] })),
    };

    const reportPath = path.join(outputRoot, 'weight-comparison.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    const csvLines = [
        'Image,' + CONFIGS.flatMap(c => [`${c.id}_archetype`, `${c.id}_deltaE`, `${c.id}_maxDeltaE`]).join(','),
        ...imageNames.map(name => {
            const r = rows[name];
            return [name, ...CONFIGS.flatMap(c => [
                r[c.id]?.archetype || '',
                r[c.id]?.deltaE    ?? '',
                r[c.id]?.maxDeltaE ?? '',
            ])].join(',');
        }),
    ];
    const csvPath = path.join(outputRoot, 'weight-comparison.csv');
    fs.writeFileSync(csvPath, csvLines.join('\n'));

    console.log(chalk.bold(`\n── Output ──`));
    for (const cfg of CONFIGS) {
        console.log(`  ${pad(cfg.label, 32)} ${path.join(outputRoot, cfg.dir)}/`);
    }
    console.log(`  ${'Report'.padEnd(32)} ${reportPath}`);
    console.log(`  ${'CSV'.padEnd(32)} ${csvPath}`);
    console.log();
}

if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(`Fatal: ${err.message}`));
        console.error(err.stack);
        process.exit(1);
    });
}
