#!/usr/bin/env node
/**
 * A/B Test: Current Archetype System vs InterpolatorEngine
 *
 * Mode 1 (--config): Compare generated configs without processing (instant)
 * Mode 2 (--pipeline): Full re-processing with interpolated params, compare quality
 *
 * Usage:
 *   node src/ab-test-interpolator.js --config              # Config comparison only
 *   node src/ab-test-interpolator.js --pipeline             # Full pipeline (all 287)
 *   node src/ab-test-interpolator.js --pipeline --sample 30 # Process 30 random images
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { InterpolatorEngine, DIM_KEYS, CONTINUOUS_PARAMS, ORDERED_ENUMS, CATEGORICAL_PARAMS } = require('./InterpolatorEngine');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', 'data');
const HARVEST_PATH = path.join(DATA_DIR, 'dna-harvest.json');
const MODEL_PATH = path.join(DATA_DIR, 'interpolator-model.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'ab-test-results.json');

// Input PSD directories (16-bit Lab)
const INPUT_DIRS = {
    TESTIMAGES: path.join(DATA_DIR, 'TESTIMAGES', 'input', 'psd', '16bit'),
    CQ100: path.join(DATA_DIR, 'CQ100_v4', 'input', 'psd', '16bit'),
    // SP100 sources are sub-directories
    SP100_met: path.join(DATA_DIR, 'SP100', 'input', 'met', 'psd', '16bit'),
    SP100_rijks: path.join(DATA_DIR, 'SP100', 'input', 'rijks', 'psd', '16bit'),
    SP100_aic: path.join(DATA_DIR, 'SP100', 'input', 'aic', 'psd', '16bit'),
    SP100_minkler: path.join(DATA_DIR, 'SP100', 'input', 'minkler', 'psd', '16bit'),
};

// Sidecar directories (for reading baseline metrics)
const SIDECAR_DIRS = {
    TESTIMAGES: path.join(DATA_DIR, 'TESTIMAGES', 'output', 'psd', '16bit'),
    CQ100: path.join(DATA_DIR, 'CQ100_v4', 'output', 'psd', '16bit'),
    SP100_met: path.join(DATA_DIR, 'SP100', 'output', 'met', 'psd', '16bit'),
    SP100_rijks: path.join(DATA_DIR, 'SP100', 'output', 'rijks', 'psd', '16bit'),
    SP100_aic: path.join(DATA_DIR, 'SP100', 'output', 'aic', 'psd', '16bit'),
    SP100_minkler: path.join(DATA_DIR, 'SP100', 'output', 'minkler', 'psd', '16bit'),
};

// Output directories for interpolated results
const INTERP_OUTPUT_DIRS = {
    TESTIMAGES: path.join(DATA_DIR, 'TESTIMAGES', 'output', 'psd', '16bit-interp'),
    CQ100: path.join(DATA_DIR, 'CQ100_v4', 'output', 'psd', '16bit-interp'),
    SP100_met: path.join(DATA_DIR, 'SP100', 'output', 'met', 'psd', '16bit-interp'),
    SP100_rijks: path.join(DATA_DIR, 'SP100', 'output', 'rijks', 'psd', '16bit-interp'),
    SP100_aic: path.join(DATA_DIR, 'SP100', 'output', 'aic', 'psd', '16bit-interp'),
    SP100_minkler: path.join(DATA_DIR, 'SP100', 'output', 'minkler', 'psd', '16bit-interp'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findDatasetKey(filename, harvest) {
    const img = harvest.images.find(i => i.filename === filename);
    if (!img) return null;
    return img.dataset || null;
}

// Map harvest dataset names (e.g., 'SP100/met') to directory keys
const DATASET_TO_DIRKEY = {
    'TESTIMAGES': 'TESTIMAGES',
    'CQ100': 'CQ100',
    'SP100/met': 'SP100_met',
    'SP100/rijks': 'SP100_rijks',
    'SP100/aic': 'SP100_aic',
    'SP100/minkler': 'SP100_minkler',
};

/**
 * Build a lookup: filename → { dataset, inputPsd, sidecarJson, interpOutputDir }
 */
function buildImageIndex(harvest) {
    const index = {};

    for (const img of harvest.images) {
        const fn = img.filename;
        const ds = img.dataset;
        const dk = DATASET_TO_DIRKEY[ds];

        if (!dk || !INPUT_DIRS[dk]) {
            index[fn] = { dataset: ds, dirKey: null, inputPsd: null, sidecarJson: null, interpOutputDir: null };
            continue;
        }

        const psdPath = path.join(INPUT_DIRS[dk], `${fn}.psd`);
        const sidecarPath = path.join(SIDECAR_DIRS[dk], `${fn}.json`);

        index[fn] = {
            dataset: ds,
            dirKey: dk,
            inputPsd: fs.existsSync(psdPath) ? psdPath : null,
            sidecarJson: fs.existsSync(sidecarPath) ? sidecarPath : null,
            interpOutputDir: INTERP_OUTPUT_DIRS[dk],
        };
    }

    return index;
}

/**
 * Load existing sidecar baseline metrics.
 */
function loadBaseline(sidecarPath) {
    if (!sidecarPath || !fs.existsSync(sidecarPath)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        return {
            revelationScore: data.metrics?.feature_preservation?.revelationScore,
            avgDeltaE: data.metrics?.global_fidelity?.avgDeltaE,
            maxDeltaE: data.metrics?.global_fidelity?.maxDeltaE,
            colorCount: data.palette?.length,
            archetype: data.archetype?.id,
            archetypeScore: data.archetype?.score
        };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Mode 1: Config Comparison
// ---------------------------------------------------------------------------

function runConfigComparison() {
    console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.bold('  A/B Test — Config Comparison'));
    console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    // Load data
    const harvest = JSON.parse(fs.readFileSync(HARVEST_PATH, 'utf8'));
    const model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    const engine = new InterpolatorEngine(model);

    // Load ParameterGenerator for current system
    const ParameterGenerator = require('@reveal/core/lib/analysis/ParameterGenerator');

    console.log(`Images: ${harvest.images.length}`);
    console.log(`Clusters: ${model.clusters.length}, Blend neighbors: ${model.blendNeighbors}\n`);

    // Track differences
    const diffs = {
        continuous: {},   // param → [abs diffs]
        ordinal: {},      // param → { same: n, different: n, shifts: {} }
        categorical: {},  // param → { same: n, different: n, values: {} }
    };

    for (const key of CONTINUOUS_PARAMS) diffs.continuous[key] = [];
    for (const key of Object.keys(ORDERED_ENUMS)) diffs.ordinal[key] = { same: 0, different: 0, shifts: {} };
    for (const key of CATEGORICAL_PARAMS) diffs.categorical[key] = { same: 0, different: 0, values: {} };

    // Archetype agreement
    let archetypeAgreement = 0;
    const archetypeMismatches = [];

    // Process each image
    for (const img of harvest.images) {
        // Build DNA object for ParameterGenerator (needs legacy + v2.0 fields)
        const dna = {
            version: '2.0',
            l: img.dna.l,
            c: img.dna.c,
            k: img.dna.k,
            l_std_dev: img.dna.l_std_dev,
            maxC: img.dna.c * 2.5, // Approximate — maxC not stored in harvest
            minL: Math.max(0, img.dna.l - img.dna.k / 2),
            maxL: Math.min(100, img.dna.l + img.dna.k / 2),
            global: {
                l: img.dna.l,
                c: img.dna.c,
                k: img.dna.k,
                l_std_dev: img.dna.l_std_dev,
                hue_entropy: img.dna.hue_entropy,
                temperature_bias: img.dna.temperature_bias,
                primary_sector_weight: img.dna.primary_sector_weight,
            },
            sectors: img.sectors ? Object.fromEntries(
                Object.entries(img.sectors).map(([name, weight]) => [
                    name, typeof weight === 'number' ? { weight } : weight
                ])
            ) : {},
            dominant_sector: 'unknown',
            filename: img.filename,
        };

        // Current system config
        const currentConfig = ParameterGenerator.generate(dna, {
            preprocessingIntensity: 'auto'
        });

        // Interpolated config
        const { parameters: interpParams, blendInfo } = engine.interpolate(img.dna);

        // Compare continuous params
        for (const key of CONTINUOUS_PARAMS) {
            const cv = currentConfig[key];
            const iv = interpParams[key];
            if (cv !== undefined && iv !== undefined) {
                diffs.continuous[key].push(Math.abs(cv - iv));
            }
        }

        // Compare ordered enums
        for (const key of Object.keys(ORDERED_ENUMS)) {
            const cv = currentConfig[key];
            const iv = interpParams[key];
            if (cv === iv) {
                diffs.ordinal[key].same++;
            } else {
                diffs.ordinal[key].different++;
                const shift = `${cv}→${iv}`;
                diffs.ordinal[key].shifts[shift] = (diffs.ordinal[key].shifts[shift] || 0) + 1;
            }
        }

        // Compare categorical params
        for (const key of CATEGORICAL_PARAMS) {
            const cv = currentConfig[key];
            const iv = interpParams[key];
            if (cv === iv || String(cv) === String(iv)) {
                diffs.categorical[key].same++;
            } else {
                diffs.categorical[key].different++;
                const shift = `${cv}→${iv}`;
                diffs.categorical[key].values[shift] = (diffs.categorical[key].values[shift] || 0) + 1;
            }
        }

        // Archetype agreement: interpolator's nearest cluster vs current archetype
        const nearestArchetype = blendInfo.neighbors[0].sourceArchetype;
        if (nearestArchetype === img.currentArchetype) {
            archetypeAgreement++;
        } else {
            archetypeMismatches.push({
                filename: img.filename,
                current: img.currentArchetype,
                interpolated: nearestArchetype,
                weight: blendInfo.neighbors[0].weight,
            });
        }
    }

    const N = harvest.images.length;

    // ---------------------------------------------------------------------------
    // Report
    // ---------------------------------------------------------------------------

    console.log(chalk.bold('═══ Archetype Agreement ═══'));
    console.log(`  Match: ${archetypeAgreement}/${N} (${(archetypeAgreement / N * 100).toFixed(1)}%)`);
    console.log(`  Mismatch: ${N - archetypeAgreement} images\n`);

    // Top mismatches
    if (archetypeMismatches.length > 0) {
        const mismatchSummary = {};
        for (const m of archetypeMismatches) {
            const key = `${m.current} → ${m.interpolated}`;
            mismatchSummary[key] = (mismatchSummary[key] || 0) + 1;
        }
        const sorted = Object.entries(mismatchSummary).sort((a, b) => b[1] - a[1]).slice(0, 10);
        console.log('  Top archetype shifts:');
        for (const [shift, count] of sorted) {
            console.log(`    ${shift}: ${count}`);
        }
        console.log();
    }

    // Continuous params
    console.log(chalk.bold('═══ Continuous Parameters (Mean Absolute Difference) ═══'));
    const continuousReport = [];
    for (const key of CONTINUOUS_PARAMS) {
        const vals = diffs.continuous[key];
        if (vals.length === 0) continue;
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const max = Math.max(...vals);
        const median = vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)];
        continuousReport.push({ key, mean, median, max, count: vals.length });
    }
    continuousReport.sort((a, b) => b.mean - a.mean);
    for (const { key, mean, median, max, count } of continuousReport) {
        const bar = '█'.repeat(Math.min(40, Math.round(mean * 10)));
        console.log(`  ${key.padEnd(35)} mean=${mean.toFixed(3).padStart(8)} median=${median.toFixed(3).padStart(8)} max=${max.toFixed(3).padStart(8)} ${bar}`);
    }
    console.log();

    // Ordered enums
    console.log(chalk.bold('═══ Ordered Enums ═══'));
    for (const key of Object.keys(ORDERED_ENUMS)) {
        const d = diffs.ordinal[key];
        const total = d.same + d.different;
        console.log(`  ${key}: ${d.same}/${total} same (${(d.same / total * 100).toFixed(1)}%)`);
        if (d.different > 0) {
            const sorted = Object.entries(d.shifts).sort((a, b) => b[1] - a[1]);
            for (const [shift, count] of sorted) {
                console.log(`    ${shift}: ${count}`);
            }
        }
    }
    console.log();

    // Categorical params
    console.log(chalk.bold('═══ Categorical Parameters ═══'));
    for (const key of CATEGORICAL_PARAMS) {
        const d = diffs.categorical[key];
        const total = d.same + d.different;
        if (total === 0) continue;
        const pct = (d.same / total * 100).toFixed(1);
        const marker = d.different > 0 ? chalk.yellow('*') : ' ';
        console.log(`  ${marker} ${key.padEnd(28)} ${d.same}/${total} same (${pct}%)`);
        if (d.different > 0) {
            const sorted = Object.entries(d.values).sort((a, b) => b[1] - a[1]).slice(0, 5);
            for (const [shift, count] of sorted) {
                console.log(`      ${shift}: ${count}`);
            }
        }
    }
    console.log();

    // Summary
    console.log(chalk.bold('═══ Summary ═══'));
    const bigDiffs = continuousReport.filter(r => r.mean > 1.0);
    console.log(`  Continuous params with mean diff > 1.0: ${bigDiffs.length}`);
    for (const r of bigDiffs) {
        console.log(`    ${r.key}: ${r.mean.toFixed(2)}`);
    }

    const catDisagreements = CATEGORICAL_PARAMS.filter(k => diffs.categorical[k].different > 0);
    console.log(`  Categorical params with any disagreement: ${catDisagreements.length}`);
    for (const k of catDisagreements) {
        console.log(`    ${k}: ${diffs.categorical[k].different}/${diffs.categorical[k].same + diffs.categorical[k].different} differ`);
    }

    // Save results
    const results = {
        timestamp: new Date().toISOString(),
        mode: 'config',
        imageCount: N,
        archetypeAgreement: { match: archetypeAgreement, total: N },
        continuousParams: Object.fromEntries(
            continuousReport.map(r => [r.key, { mean: +r.mean.toFixed(4), median: +r.median.toFixed(4), max: +r.max.toFixed(4) }])
        ),
        ordinalParams: diffs.ordinal,
        categoricalParams: diffs.categorical,
        archetypeMismatches: archetypeMismatches.slice(0, 50),
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2));
    console.log(`\nResults saved: ${OUTPUT_PATH}`);
}

// ---------------------------------------------------------------------------
// Mode 2: Full Pipeline A/B Test
// ---------------------------------------------------------------------------

async function runPipelineTest(sampleSize, opts = {}) {
    const { datasetFilter, writePsd } = opts;

    console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.bold('  A/B Test — Full Pipeline'));
    if (writePsd) console.log(chalk.bold('  (Writing output PSDs)'));
    console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    // Lazy-load heavy dependencies
    const Reveal = require('@reveal/core');
    const { readPsd } = require('@reveal/psd-reader');
    const MetricsCalculator = require('./MetricsCalculator');
    const ParameterGenerator = require('@reveal/core/lib/analysis/ParameterGenerator');
    const BilateralFilter = require('../../reveal-core/lib/preprocessing/BilateralFilter');
    const MedianFilter = require('../../reveal-core/lib/preprocessing/MedianFilter');
    const MechanicalKnobs = require('../../reveal-core/lib/engines/MechanicalKnobs');
    const ColorSpace = require('../../reveal-core/lib/engines/ColorSpace');

    // Load data
    const harvest = JSON.parse(fs.readFileSync(HARVEST_PATH, 'utf8'));
    const model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
    const engine = new InterpolatorEngine(model);
    const imageIndex = buildImageIndex(harvest);

    // Filter to images with source PSDs
    let testImages = harvest.images.filter(img => imageIndex[img.filename]?.inputPsd);

    // Filter by dataset if requested
    if (datasetFilter) {
        testImages = testImages.filter(img =>
            img.dataset.toLowerCase().startsWith(datasetFilter.toLowerCase())
        );
        console.log(`Dataset filter: ${datasetFilter}`);
    }

    console.log(`Total images with source PSDs: ${testImages.length}`);

    // Sample if requested
    if (sampleSize && sampleSize < testImages.length) {
        // Stratified sample: pick proportionally from each dataset
        const byDataset = {};
        for (const img of testImages) {
            const ds = img.dataset || 'unknown';
            if (!byDataset[ds]) byDataset[ds] = [];
            byDataset[ds].push(img);
        }

        const sampled = [];
        for (const [ds, imgs] of Object.entries(byDataset)) {
            const count = Math.max(1, Math.round(sampleSize * imgs.length / testImages.length));
            // Shuffle and take count
            const shuffled = imgs.slice().sort(() => Math.random() - 0.5);
            sampled.push(...shuffled.slice(0, count));
        }
        testImages = sampled.slice(0, sampleSize);
        console.log(`Sampled ${testImages.length} images (stratified by dataset)`);
    }

    console.log();

    // Results accumulator
    const results = [];
    let processed = 0;
    let errors = 0;
    const startTime = Date.now();

    for (const img of testImages) {
        processed++;
        const info = imageIndex[img.filename];
        const prefix = `[${processed}/${testImages.length}]`;

        // Load baseline from sidecar
        const baseline = loadBaseline(info.sidecarJson);
        if (!baseline) {
            console.log(chalk.yellow(`${prefix} ${img.filename} — no baseline sidecar, skipping`));
            continue;
        }

        console.log(`${prefix} ${chalk.cyan(img.filename)} (${img.dataset})`);
        console.log(`  Baseline: revScore=${baseline.revelationScore}, avgΔE=${baseline.avgDeltaE}, arch=${baseline.archetype}`);

        try {
            // Run interpolated pipeline
            const interpResult = await processWithInterpolation(
                info.inputPsd, info.interpOutputDir, img, engine,
                { Reveal, readPsd, MetricsCalculator, BilateralFilter, MedianFilter, MechanicalKnobs, ColorSpace },
                { writePsd }
            );

            const revDelta = interpResult.revelationScore - baseline.revelationScore;
            const deDelta = interpResult.avgDeltaE - baseline.avgDeltaE;

            const revColor = revDelta >= 0 ? chalk.green : chalk.red;
            const deColor = deDelta <= 0 ? chalk.green : chalk.red;

            console.log(`  Interpolated: revScore=${interpResult.revelationScore}, avgΔE=${interpResult.avgDeltaE}`);
            console.log(`  Delta: revScore=${revColor(revDelta >= 0 ? '+' : '')}${revColor(revDelta.toFixed(1))}, avgΔE=${deColor(deDelta >= 0 ? '+' : '')}${deColor(deDelta.toFixed(2))}`);

            results.push({
                filename: img.filename,
                dataset: img.dataset,
                currentArchetype: img.currentArchetype,
                interpArchetype: interpResult.blendInfo.neighbors[0].sourceArchetype,
                baseline: {
                    revelationScore: baseline.revelationScore,
                    avgDeltaE: baseline.avgDeltaE,
                    colorCount: baseline.colorCount,
                },
                interpolated: {
                    revelationScore: interpResult.revelationScore,
                    avgDeltaE: interpResult.avgDeltaE,
                    colorCount: interpResult.colorCount,
                },
                delta: {
                    revelationScore: +revDelta.toFixed(2),
                    avgDeltaE: +deDelta.toFixed(4),
                },
                blendInfo: interpResult.blendInfo,
            });
        } catch (err) {
            errors++;
            console.log(chalk.red(`  ERROR: ${err.message}`));
            results.push({
                filename: img.filename,
                dataset: img.dataset,
                error: err.message,
            });
        }

        // Memory cleanup
        if (global.gc) global.gc();
    }

    // ---------------------------------------------------------------------------
    // Aggregate Report
    // ---------------------------------------------------------------------------

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successful = results.filter(r => !r.error);

    console.log(chalk.bold('\n═══════════════════════════════════════════'));
    console.log(chalk.bold('  A/B Test Results'));
    console.log(chalk.bold('═══════════════════════════════════════════\n'));

    console.log(`  Processed: ${processed} images in ${elapsed}s`);
    console.log(`  Success: ${successful.length}, Errors: ${errors}\n`);

    if (successful.length === 0) {
        console.log(chalk.red('No successful results to analyze.'));
        return;
    }

    // Revelation Score analysis
    const revDeltas = successful.map(r => r.delta.revelationScore);
    const revImproved = revDeltas.filter(d => d > 0).length;
    const revDegraded = revDeltas.filter(d => d < 0).length;
    const revSame = revDeltas.filter(d => d === 0).length;
    const revMean = revDeltas.reduce((s, d) => s + d, 0) / revDeltas.length;
    const revMedian = revDeltas.sort((a, b) => a - b)[Math.floor(revDeltas.length / 2)];

    console.log(chalk.bold('  Revelation Score:'));
    console.log(`    Improved: ${revImproved} (${(revImproved / successful.length * 100).toFixed(1)}%)`);
    console.log(`    Degraded: ${revDegraded} (${(revDegraded / successful.length * 100).toFixed(1)}%)`);
    console.log(`    Same:     ${revSame}`);
    console.log(`    Mean Δ:   ${revMean >= 0 ? '+' : ''}${revMean.toFixed(2)}`);
    console.log(`    Median Δ: ${revMedian >= 0 ? '+' : ''}${revMedian.toFixed(2)}`);

    // ΔE analysis
    const deDeltas = successful.map(r => r.delta.avgDeltaE);
    const deImproved = deDeltas.filter(d => d < 0).length; // Lower ΔE is better
    const deDegraded = deDeltas.filter(d => d > 0).length;
    const deMean = deDeltas.reduce((s, d) => s + d, 0) / deDeltas.length;
    const deMedian = deDeltas.sort((a, b) => a - b)[Math.floor(deDeltas.length / 2)];

    console.log(chalk.bold('\n  Average ΔE (lower = better):'));
    console.log(`    Improved: ${deImproved} (${(deImproved / successful.length * 100).toFixed(1)}%)`);
    console.log(`    Degraded: ${deDegraded} (${(deDegraded / successful.length * 100).toFixed(1)}%)`);
    console.log(`    Mean Δ:   ${deMean >= 0 ? '+' : ''}${deMean.toFixed(3)}`);
    console.log(`    Median Δ: ${deMedian >= 0 ? '+' : ''}${deMedian.toFixed(3)}`);

    // Worst regressions
    const byRevDelta = successful.slice().sort((a, b) => a.delta.revelationScore - b.delta.revelationScore);
    console.log(chalk.bold('\n  Worst 5 Revelation Score regressions:'));
    for (const r of byRevDelta.slice(0, 5)) {
        console.log(`    ${r.filename}: ${r.baseline.revelationScore} → ${r.interpolated.revelationScore} (${r.delta.revelationScore >= 0 ? '+' : ''}${r.delta.revelationScore})`);
    }

    // Best improvements
    console.log(chalk.bold('\n  Best 5 Revelation Score improvements:'));
    for (const r of byRevDelta.slice(-5).reverse()) {
        console.log(`    ${r.filename}: ${r.baseline.revelationScore} → ${r.interpolated.revelationScore} (${r.delta.revelationScore >= 0 ? '+' : ''}${r.delta.revelationScore})`);
    }

    // Per-dataset breakdown
    console.log(chalk.bold('\n  Per-Dataset Breakdown:'));
    const byDataset = {};
    for (const r of successful) {
        if (!byDataset[r.dataset]) byDataset[r.dataset] = [];
        byDataset[r.dataset].push(r);
    }
    for (const [ds, items] of Object.entries(byDataset)) {
        const dsRevMean = items.reduce((s, r) => s + r.delta.revelationScore, 0) / items.length;
        const dsDeMean = items.reduce((s, r) => s + r.delta.avgDeltaE, 0) / items.length;
        const dsRevImproved = items.filter(r => r.delta.revelationScore > 0).length;
        console.log(`    ${ds} (${items.length}): revΔ=${dsRevMean >= 0 ? '+' : ''}${dsRevMean.toFixed(2)}, deΔ=${dsDeMean >= 0 ? '+' : ''}${dsDeMean.toFixed(3)}, improved=${dsRevImproved}/${items.length}`);
    }

    // Save results
    const report = {
        timestamp: new Date().toISOString(),
        mode: 'pipeline',
        imageCount: testImages.length,
        processed: processed,
        successful: successful.length,
        errors: errors,
        elapsedSeconds: +elapsed,
        summary: {
            revelationScore: {
                improved: revImproved,
                degraded: revDegraded,
                same: revSame,
                meanDelta: +revMean.toFixed(2),
                medianDelta: +revMedian.toFixed(2),
            },
            avgDeltaE: {
                improved: deImproved,
                degraded: deDegraded,
                meanDelta: +deMean.toFixed(4),
                medianDelta: +deMedian.toFixed(4),
            },
        },
        results,
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
    console.log(`\nFull results saved: ${OUTPUT_PATH}`);
}

// ---------------------------------------------------------------------------
// Pipeline processor — runs single image with interpolated params
// ---------------------------------------------------------------------------

async function processWithInterpolation(inputPath, outputDir, harvestImg, engine, deps, options = {}) {
    const { Reveal, readPsd, MetricsCalculator, BilateralFilter, MedianFilter, MechanicalKnobs, ColorSpace } = deps;
    const writePsd = options.writePsd || false;

    const basename = path.basename(inputPath, '.psd');

    // 1. Read Lab PSD
    const buffer = fs.readFileSync(inputPath);
    const psd = readPsd(buffer);
    const { width, height, depth, data: labData } = psd;
    const pixelCount = width * height;

    // 2. Convert to engine 16-bit
    let lab16bit;
    if (depth === 8) {
        lab16bit = new Uint16Array(pixelCount * 3);
        for (let i = 0; i < pixelCount; i++) {
            lab16bit[i * 3] = Math.round(labData[i * 3] * 32768 / 255);
            lab16bit[i * 3 + 1] = (labData[i * 3 + 1] - 128) * 128 + 16384;
            lab16bit[i * 3 + 2] = (labData[i * 3 + 2] - 128) * 128 + 16384;
        }
    } else {
        lab16bit = new Uint16Array(pixelCount * 3);
        for (let i = 0; i < pixelCount; i++) {
            lab16bit[i * 3] = labData[i * 3] >> 1;
            lab16bit[i * 3 + 1] = labData[i * 3 + 1] >> 1;
            lab16bit[i * 3 + 2] = labData[i * 3 + 2] >> 1;
        }
    }

    // 3. Calculate DNA (for preprocessing decisions)
    const lab8bit = new Uint8Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        lab8bit[i * 3] = Math.round(labData[i * 3] / (depth === 16 ? 257 : 1));
        lab8bit[i * 3 + 1] = Math.round(labData[i * 3 + 1] / (depth === 16 ? 257 : 1));
        lab8bit[i * 3 + 2] = Math.round(labData[i * 3 + 2] / (depth === 16 ? 257 : 1));
    }

    // Build minimal DNA for preprocessing decisions
    const dna = {
        l: harvestImg.dna.l,
        c: harvestImg.dna.c,
        k: harvestImg.dna.k,
        l_std_dev: harvestImg.dna.l_std_dev,
        maxC: harvestImg.dna.c * 2.5,
        minL: Math.max(0, harvestImg.dna.l - harvestImg.dna.k / 2),
        maxL: Math.min(100, harvestImg.dna.l + harvestImg.dna.k / 2),
        filename: basename,
    };

    // 4. Get interpolated config
    const { parameters: config, blendInfo } = engine.interpolate(harvestImg.dna);

    // 5. Bilateral prefilter
    const is16Bit = depth === 16;
    const entropyScore = BilateralFilter.calculateEntropyScoreLab(lab16bit, width, height);
    const preprocessDecision = BilateralFilter.shouldPreprocess(dna, entropyScore, is16Bit);

    if (preprocessDecision.shouldProcess) {
        BilateralFilter.applyBilateralFilterLab(
            lab16bit, width, height,
            preprocessDecision.radius,
            preprocessDecision.sigmaR
        );
    }

    // 5b. Pre-posterization median filter
    if (MedianFilter.shouldApply(dna, config)) {
        lab16bit = MedianFilter.apply3x3(lab16bit, width, height);
    }

    // 6. Posterize with interpolated params
    const params = {
        targetColorsSlider: 8, // Same override as baseline for fair comparison
        blackBias: config.blackBias || 3.0,
        ditherType: config.ditherType || 'blue-noise',
        format: 'lab',
        bitDepth: 8,
        engineType: 'reveal',
        centroidStrategy: config.centroidStrategy || 'SALIENCY',
        lWeight: config.lWeight || 1.2,
        cWeight: config.cWeight || 2.0,
        substrateMode: config.substrateMode || 'auto',
        substrateTolerance: config.substrateTolerance || 2.0,
        vibrancyMode: config.vibrancyMode || 'moderate',
        vibrancyBoost: config.saturationBoost || config.vibrancyBoost || 1.4,
        highlightThreshold: config.highlightThreshold || 90,
        highlightBoost: config.highlightBoost || 1.5,
        enablePaletteReduction: config.enablePaletteReduction !== undefined ? config.enablePaletteReduction : true,
        paletteReduction: config.paletteReduction || 6.0,
        hueLockAngle: config.hueLockAngle || 20,
        shadowPoint: config.shadowPoint || 15,
        colorMode: 'color',
        preserveWhite: true,
        preserveBlack: true,
        ignoreTransparent: true,
        enableHueGapAnalysis: config.enableHueGapAnalysis !== undefined ? config.enableHueGapAnalysis : true,
        shadowClamp: config.shadowClamp || 0,
        chromaGate: config.chromaGate || 1.0,
        detailRescue: config.detailRescue || 0,
        speckleRescue: config.speckleRescue || 0,
        medianPass: config.medianPass || false,
    };

    const posterizeResult = await Reveal.posterizeImage(
        lab16bit, width, height,
        params.targetColorsSlider, params
    );

    // 7. Map pixels to palette
    const SeparationEngine = Reveal.engines.SeparationEngine;
    let colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
        lab16bit, posterizeResult.paletteLab, null, width, height,
        { ditherType: config.ditherType, distanceMetric: config.distanceMetric }
    );

    let finalPaletteLab = posterizeResult.paletteLab;

    // 7.5. Palette pruning
    if (config.minVolume !== undefined && config.minVolume > 0) {
        const pruneResult = SeparationEngine.pruneWeakColors(
            finalPaletteLab, colorIndices, width, height,
            config.minVolume, { distanceMetric: config.distanceMetric }
        );
        if (pruneResult.mergedCount > 0) {
            finalPaletteLab = pruneResult.prunedPalette;
            colorIndices = pruneResult.remappedIndices;
        }
    }

    // 8. Build masks + apply knobs
    const masks = MechanicalKnobs.rebuildMasks(colorIndices, finalPaletteLab.length, pixelCount);
    if (config.speckleRescue > 0) {
        MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, config.speckleRescue);
    }

    // Sync colorIndices from masks
    for (let layerIdx = 0; layerIdx < masks.length; layerIdx++) {
        const mask = masks[layerIdx];
        for (let px = 0; px < pixelCount; px++) {
            if (mask[px] === 255) colorIndices[px] = layerIdx;
        }
    }

    // Release lab16bit
    lab16bit = null;

    // 9. Compute metrics
    const processedLab = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const color = finalPaletteLab[colorIndices[i]];
        processedLab[i * 3] = Math.round((color.L / 100) * 255);
        processedLab[i * 3 + 1] = Math.round(color.a + 128);
        processedLab[i * 3 + 2] = Math.round(color.b + 128);
    }

    const layersForMetrics = masks.map((mask, idx) => ({
        name: `Ink ${idx + 1}`,
        color: finalPaletteLab[idx],
        mask,
    }));

    const originalLabClamped = lab8bit instanceof Uint8ClampedArray
        ? lab8bit : new Uint8ClampedArray(lab8bit);

    const metrics = MetricsCalculator.compute(
        originalLabClamped, processedLab, layersForMetrics,
        width, height, { targetColors: params.targetColorsSlider }
    );

    // Build RGB palette and coverage for output
    const finalPaletteRgb = finalPaletteLab.map(lab => ColorSpace.labToRgb(lab));
    const coverageCounts = new Uint32Array(finalPaletteLab.length);
    for (let i = 0; i < pixelCount; i++) coverageCounts[colorIndices[i]]++;

    function rgbToHex(r, g, b) {
        return '#' + [r, g, b].map(x => {
            const hex = Math.round(x).toString(16);
            return hex.length === 1 ? '0' + hex : hex;
        }).join('');
    }

    const palette = finalPaletteLab.map((color, idx) => {
        const rgb = finalPaletteRgb[idx];
        const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
        return {
            name: `Ink ${idx + 1} (${hex})`,
            lab: { L: +color.L.toFixed(2), a: +color.a.toFixed(2), b: +color.b.toFixed(2) },
            rgb: { r: Math.round(rgb.r), g: Math.round(rgb.g), b: Math.round(rgb.b) },
            hex,
            coverage: `${((coverageCounts[idx] / pixelCount) * 100).toFixed(2)}%`
        };
    });

    // Write outputs
    if (outputDir) {
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        // Write PSD if requested
        if (writePsd) {
            const { PSDWriter } = require('@reveal/psd-writer');
            const outputPsdPath = path.join(outputDir, `${basename}.psd`);
            const writer = new PSDWriter({
                width, height,
                colorMode: 'lab',
                bitsPerChannel: 8,
                documentName: basename
            });

            // Add original as invisible reference layer
            writer.addPixelLayer({
                name: 'Original Image (Reference)',
                pixels: lab8bit,
                visible: false
            });

            // Sort layers by lightness (light to dark) for proper print stacking
            const layersToWrite = finalPaletteLab.map((color, i) => ({
                index: i, color, rgb: finalPaletteRgb[i], mask: masks[i], coverage: coverageCounts[i]
            }));
            layersToWrite.sort((a, b) => b.color.L - a.color.L);

            // Add fill+mask layers
            for (const layer of layersToWrite) {
                const hex = rgbToHex(layer.rgb.r, layer.rgb.g, layer.rgb.b);
                writer.addFillLayer({
                    name: `Color ${layer.index + 1} (${hex})`,
                    color: layer.color,
                    mask: layer.mask
                });
            }

            const psdBuffer = writer.write();
            fs.writeFileSync(outputPsdPath, psdBuffer);
        }

        // Write sidecar JSON
        const jsonPath = path.join(outputDir, `${basename}.json`);
        const sidecar = {
            meta: { filename: basename, timestamp: new Date().toISOString(), width, height, mode: 'interpolated' },
            interpolation: blendInfo,
            metrics,
            palette,
            config: params,
        };
        fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));
    }

    return {
        revelationScore: metrics.feature_preservation.revelationScore,
        avgDeltaE: metrics.global_fidelity.avgDeltaE,
        maxDeltaE: metrics.global_fidelity.maxDeltaE,
        colorCount: finalPaletteLab.length,
        blendInfo,
    };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--config') || args.length === 0) {
        runConfigComparison();
    } else if (args.includes('--pipeline')) {
        const sampleIdx = args.indexOf('--sample');
        const sampleSize = sampleIdx >= 0 ? parseInt(args[sampleIdx + 1], 10) : null;
        const datasetIdx = args.indexOf('--dataset');
        const datasetFilter = datasetIdx >= 0 ? args[datasetIdx + 1] : null;
        const writePsd = args.includes('--write-psd');
        await runPipelineTest(sampleSize, { datasetFilter, writePsd });
    } else {
        console.log('Usage:');
        console.log('  node src/ab-test-interpolator.js --config                           # Config comparison');
        console.log('  node src/ab-test-interpolator.js --pipeline                          # Full pipeline (all)');
        console.log('  node src/ab-test-interpolator.js --pipeline --sample 30              # Sample 30 images');
        console.log('  node src/ab-test-interpolator.js --pipeline --dataset CQ100          # CQ100 only');
        console.log('  node src/ab-test-interpolator.js --pipeline --dataset CQ100 --write-psd # With PSD output');
        process.exit(1);
    }
}

main().catch(err => {
    console.error(chalk.red(err.message));
    console.error(err.stack);
    process.exit(1);
});
