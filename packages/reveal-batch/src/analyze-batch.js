#!/usr/bin/env node
/**
 * analyze-batch.js
 * Generic meta-analyzer for Reveal batch results.
 *
 * Usage: node analyze-batch.js <dataset-name> <output-dir> <result-dir-1> [result-dir-2] ...
 *
 * Arguments:
 *   dataset-name   Name used for output files (e.g., "CQ100", "SP100")
 *   output-dir     Directory for analysis output files
 *   result-dirs    One or more directories containing (PSD, JSON) pairs
 *
 * Output:
 *   {dataset-name}_meta_analysis.json  - Full statistical report
 *   {dataset-name}_summary.csv         - Spreadsheet-friendly summary
 */
const fs = require('fs');
const path = require('path');

// --- CALIBRATED THRESHOLDS ---
const THRESHOLD_INTEGRITY = 60;   // Must be physically printable
const THRESHOLD_REVELATION = 18;  // Captures only true failures
const THRESHOLD_STACK = 5;        // Max ink overlap

class BatchAnalyzer {
    // === STATISTICAL HELPERS ===

    static median(arr) {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    static percentile(arr, p) {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const idx = (p / 100) * (sorted.length - 1);
        const lower = Math.floor(idx);
        const upper = Math.ceil(idx);
        if (lower === upper) return sorted[lower];
        return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
    }

    static stdDev(arr) {
        if (arr.length === 0) return 0;
        const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
        const squareDiffs = arr.map(v => Math.pow(v - avg, 2));
        return Math.sqrt(squareDiffs.reduce((a, b) => a + b, 0) / arr.length);
    }

    static computeStats(arr) {
        if (arr.length === 0) return { mean: 0, median: 0, stdDev: 0, min: 0, max: 0, p25: 0, p75: 0 };
        const sorted = [...arr].sort((a, b) => a - b);
        return {
            mean: arr.reduce((a, b) => a + b, 0) / arr.length,
            median: this.median(arr),
            stdDev: this.stdDev(arr),
            min: sorted[0],
            max: sorted[sorted.length - 1],
            p25: this.percentile(arr, 25),
            p75: this.percentile(arr, 75)
        };
    }

    // === MAIN ANALYSIS ===

    static run(datasetName, outputDir, resultDirs) {
        console.log(`\n🔍 Analyzing dataset: ${datasetName}`);
        console.log(`   Output: ${outputDir}`);
        console.log(`   Sources: ${resultDirs.length} directories\n`);

        // Collect JSON files from all result directories
        const allFiles = [];
        resultDirs.forEach(dir => {
            if (!fs.existsSync(dir)) {
                console.warn(`⚠️ Directory not found: ${dir}`);
                return;
            }

            const files = fs.readdirSync(dir).filter(f =>
                f.endsWith('.json') && f !== 'batch-report.json'
            );

            files.forEach(f => {
                allFiles.push({
                    file: f,
                    fullPath: path.join(dir, f),
                    source: path.basename(dir)
                });
            });

            console.log(`   Found ${files.length} JSONs in ${path.basename(dir)}/`);
        });

        if (allFiles.length === 0) {
            console.error("❌ No JSON files found.");
            process.exit(1);
        }

        // Collect raw values for statistical analysis
        const values = {
            deltaE: [],
            maxDeltaE: [],
            revelation: [],
            integrity: [],
            processTime: [],
            breaches: [],
            colorCount: []
        };

        // Collect all image records
        const allImages = [];

        const stats = {
            datasetName,
            timestamp: new Date().toISOString(),
            totalImages: 0,
            sources: resultDirs.map(d => path.basename(d)),
            global: {},
            bySource: {},
            byPreset: {},
            byColorCount: {},
            extremes: {
                highestDeltaE: { val: 0, file: '', source: '' },
                lowestScore: { val: 100, file: '', source: '' },
                worstIntegrity: { val: 100, file: '', source: '' },
                slowestProcess: { val: 0, file: '', source: '' }
            },
            outliers: [],
            failures: []
        };

        const csvRows = ['Filename,Source,Preset,Colors,AvgDeltaE,MaxDeltaE,RevScore,Integrity,Breaches,ProcTime'];

        allFiles.forEach(({ file, fullPath, source }) => {
            try {
                const content = fs.readFileSync(fullPath, 'utf8');
                const data = JSON.parse(content);

                stats.totalImages++;

                const imgRecord = {
                    filename: file,
                    source,
                    avgDeltaE: data.metrics.global_fidelity.avgDeltaE,
                    maxDeltaE: data.metrics.global_fidelity.maxDeltaE,
                    revelation: data.metrics.feature_preservation.revelationScore,
                    integrity: parseFloat(data.metrics.physical_feasibility.integrityScore),
                    colorCount: data.palette ? data.palette.length : 0,
                    processTime: data.timing.totalMs,
                    preset: data.configuration?.id || 'unknown'
                };
                allImages.push(imgRecord);

                // Collect values for statistics
                values.deltaE.push(imgRecord.avgDeltaE);
                values.maxDeltaE.push(imgRecord.maxDeltaE);
                values.revelation.push(imgRecord.revelation);
                values.integrity.push(imgRecord.integrity);
                values.processTime.push(imgRecord.processTime);
                values.breaches.push(data.metrics.physical_feasibility.densityFloorBreaches || 0);
                values.colorCount.push(imgRecord.colorCount);

                this.accumulateSource(stats, imgRecord);
                this.accumulatePreset(stats, imgRecord, data);
                this.accumulateColorCount(stats, imgRecord);
                this.checkExtremes(stats, imgRecord, data);
                this.checkFailure(stats, imgRecord, data);

                // Add to CSV
                csvRows.push(`${data.meta.filename},${source},${imgRecord.preset},${imgRecord.colorCount},${imgRecord.avgDeltaE},${imgRecord.maxDeltaE},${imgRecord.revelation},${imgRecord.integrity},${data.metrics.physical_feasibility.densityFloorBreaches || 0},${imgRecord.processTime}`);

            } catch (err) {
                console.warn(`⚠️ Skipped corrupt file ${file}: ${err.message}`);
            }
        });

        // Compute full statistics
        stats.global = {
            deltaE: this.computeStats(values.deltaE),
            maxDeltaE: this.computeStats(values.maxDeltaE),
            revelation: this.computeStats(values.revelation),
            integrity: this.computeStats(values.integrity),
            processTime: this.computeStats(values.processTime),
            breaches: this.computeStats(values.breaches),
            colorCount: this.computeStats(values.colorCount)
        };

        // Identify P75-based outliers
        stats.outliers = this.findOutliers(allImages, stats.global);

        this.finalizeStats(stats);

        // Ensure output directory exists
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Write outputs
        const reportPath = path.join(outputDir, `${datasetName}_meta_analysis.json`);
        const csvPath = path.join(outputDir, `${datasetName}_summary.csv`);

        fs.writeFileSync(reportPath, JSON.stringify(stats, null, 4));
        fs.writeFileSync(csvPath, csvRows.join('\n'));

        console.log(`\n✅ Analysis Complete. Scanned ${stats.totalImages} images.`);
        console.log(`👉 Report: ${reportPath}`);
        console.log(`👉 Spreadsheet: ${csvPath}`);

        // Print summary to console
        this.printSummary(stats);
    }

    // === ACCUMULATION METHODS ===

    static accumulateSource(stats, imgRecord) {
        const { source } = imgRecord;
        if (!stats.bySource[source]) {
            stats.bySource[source] = {
                count: 0,
                values: { deltaE: [], revelation: [], integrity: [] }
            };
        }
        const s = stats.bySource[source];
        s.count++;
        s.values.deltaE.push(imgRecord.avgDeltaE);
        s.values.revelation.push(imgRecord.revelation);
        s.values.integrity.push(imgRecord.integrity);
    }

    static accumulatePreset(stats, imgRecord, data) {
        const preset = imgRecord.preset;
        if (!stats.byPreset[preset]) {
            stats.byPreset[preset] = {
                count: 0,
                values: { deltaE: [], revelation: [], breaches: [] }
            };
        }
        const p = stats.byPreset[preset];
        p.count++;
        p.values.deltaE.push(imgRecord.avgDeltaE);
        p.values.revelation.push(imgRecord.revelation);
        p.values.breaches.push(data.metrics.physical_feasibility.densityFloorBreaches || 0);
    }

    static accumulateColorCount(stats, imgRecord) {
        const count = imgRecord.colorCount;
        if (!stats.byColorCount[count]) {
            stats.byColorCount[count] = 0;
        }
        stats.byColorCount[count]++;
    }

    static checkExtremes(stats, imgRecord, data) {
        const m = data.metrics;

        if (m.global_fidelity.maxDeltaE > stats.extremes.highestDeltaE.val) {
            stats.extremes.highestDeltaE = {
                val: m.global_fidelity.maxDeltaE,
                file: imgRecord.filename,
                source: imgRecord.source
            };
        }
        if (m.feature_preservation.revelationScore < stats.extremes.lowestScore.val) {
            stats.extremes.lowestScore = {
                val: m.feature_preservation.revelationScore,
                file: imgRecord.filename,
                source: imgRecord.source
            };
        }
        if (imgRecord.integrity < stats.extremes.worstIntegrity.val) {
            stats.extremes.worstIntegrity = {
                val: imgRecord.integrity,
                file: imgRecord.filename,
                source: imgRecord.source
            };
        }
        if (data.timing.totalMs > stats.extremes.slowestProcess.val) {
            stats.extremes.slowestProcess = {
                val: data.timing.totalMs,
                file: imgRecord.filename,
                source: imgRecord.source
            };
        }
    }

    static findOutliers(images, globalStats) {
        const AVG_DE_THRESHOLD = globalStats.deltaE.p75;
        const MAX_DE_THRESHOLD = globalStats.maxDeltaE.p75;

        const outliers = images.filter(img => {
            return img.avgDeltaE > AVG_DE_THRESHOLD || img.maxDeltaE > MAX_DE_THRESHOLD;
        }).map(img => {
            const reasons = [];
            if (img.avgDeltaE > AVG_DE_THRESHOLD) {
                reasons.push(`avgΔE ${img.avgDeltaE.toFixed(1)} > P75 (${AVG_DE_THRESHOLD.toFixed(1)})`);
            }
            if (img.maxDeltaE > MAX_DE_THRESHOLD) {
                reasons.push(`maxΔE ${img.maxDeltaE.toFixed(1)} > P75 (${MAX_DE_THRESHOLD.toFixed(1)})`);
            }
            return { ...img, reason: reasons.join(', ') };
        });

        outliers.sort((a, b) => b.avgDeltaE - a.avgDeltaE);
        return outliers;
    }

    static checkFailure(stats, imgRecord, data) {
        const integrity = imgRecord.integrity;
        const score = imgRecord.revelation;
        const stack = data.metrics.physical_feasibility.maxInkStack;

        const reasons = [];
        if (integrity < THRESHOLD_INTEGRITY) reasons.push(`Integrity ${integrity.toFixed(1)}`);
        if (score < THRESHOLD_REVELATION) reasons.push(`RevScore ${score.toFixed(1)}`);
        if (stack > THRESHOLD_STACK) reasons.push(`Stack ${stack}`);

        if (reasons.length > 0) {
            stats.failures.push({
                file: imgRecord.filename,
                source: imgRecord.source,
                reason: reasons.join(', '),
                integrity,
                score,
                stack
            });
        }
    }

    static finalizeStats(stats) {
        // Finalize per-source stats
        for (const key in stats.bySource) {
            const s = stats.bySource[key];
            s.deltaE = this.computeStats(s.values.deltaE);
            s.revelation = this.computeStats(s.values.revelation);
            s.integrity = this.computeStats(s.values.integrity);
            delete s.values;
        }

        // Finalize per-preset stats
        for (const key in stats.byPreset) {
            const p = stats.byPreset[key];
            p.deltaE = this.computeStats(p.values.deltaE);
            p.revelation = this.computeStats(p.values.revelation);
            p.breaches = this.computeStats(p.values.breaches);
            delete p.values;
        }
    }

    // === CONSOLE OUTPUT ===

    static printMetricStats(name, s) {
        console.log(`  ${name.padEnd(20)} mean=${s.mean.toFixed(2).padStart(7)}, median=${s.median.toFixed(2).padStart(7)}, std=${s.stdDev.toFixed(2).padStart(6)}, range=[${s.min.toFixed(1)}, ${s.max.toFixed(1)}], IQR=[${s.p25.toFixed(1)}, ${s.p75.toFixed(1)}]`);
    }

    static printSummary(stats) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`GLOBAL STATISTICS`);
        console.log(`${'='.repeat(60)}`);
        this.printMetricStats('DeltaE (avg)', stats.global.deltaE);
        this.printMetricStats('DeltaE (max)', stats.global.maxDeltaE);
        this.printMetricStats('Revelation', stats.global.revelation);
        this.printMetricStats('Integrity', stats.global.integrity);
        this.printMetricStats('Process Time (ms)', stats.global.processTime);
        this.printMetricStats('Color Count', stats.global.colorCount);

        if (Object.keys(stats.bySource).length > 1) {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`BY SOURCE`);
            console.log(`${'='.repeat(60)}`);
            Object.entries(stats.bySource).forEach(([source, data]) => {
                console.log(`  ${source}:`);
                console.log(`    Count:        ${data.count} images`);
                console.log(`    DeltaE:       mean=${data.deltaE.mean.toFixed(2)}, median=${data.deltaE.median.toFixed(2)}`);
                console.log(`    Revelation:   mean=${data.revelation.mean.toFixed(1)}, median=${data.revelation.median.toFixed(1)}`);
            });
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`COLOR COUNT DISTRIBUTION`);
        console.log(`${'='.repeat(60)}`);
        Object.entries(stats.byColorCount)
            .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
            .forEach(([count, num]) => {
                const pct = ((num / stats.totalImages) * 100).toFixed(1);
                console.log(`  ${count} colors: ${num} images (${pct}%)`);
            });

        console.log(`\n${'='.repeat(60)}`);
        console.log(`PRESET DISTRIBUTION`);
        console.log(`${'='.repeat(60)}`);
        Object.entries(stats.byPreset)
            .sort((a, b) => b[1].count - a[1].count)
            .forEach(([preset, data]) => {
                console.log(`  ${preset}:`);
                console.log(`    Count:        ${data.count} images`);
                console.log(`    DeltaE:       mean=${data.deltaE.mean.toFixed(2)}, median=${data.deltaE.median.toFixed(2)}`);
                console.log(`    Revelation:   mean=${data.revelation.mean.toFixed(1)}, median=${data.revelation.median.toFixed(1)}`);
            });

        console.log(`\n${'='.repeat(60)}`);
        console.log(`EXTREMES`);
        console.log(`${'='.repeat(60)}`);
        console.log(`  Highest maxΔE:      ${stats.extremes.highestDeltaE.val.toFixed(2)} (${stats.extremes.highestDeltaE.file})`);
        console.log(`  Lowest RevScore:    ${stats.extremes.lowestScore.val.toFixed(1)} (${stats.extremes.lowestScore.file})`);
        console.log(`  Worst Integrity:    ${stats.extremes.worstIntegrity.val} (${stats.extremes.worstIntegrity.file})`);
        console.log(`  Slowest Process:    ${stats.extremes.slowestProcess.val}ms (${stats.extremes.slowestProcess.file})`);

        console.log(`\n${'='.repeat(60)}`);
        console.log(`P75 OUTLIERS (${stats.outliers.length} images exceed 75th percentile)`);
        console.log(`${'='.repeat(60)}`);
        console.log(`  Thresholds: avgΔE > ${stats.global.deltaE.p75.toFixed(1)}, maxΔE > ${stats.global.maxDeltaE.p75.toFixed(1)}`);
        if (stats.outliers.length > 0) {
            stats.outliers.slice(0, 15).forEach(img => {
                console.log(`  ⚠️ [${img.source}] ${img.filename.slice(0, 30).padEnd(30)} avgΔE=${img.avgDeltaE.toFixed(1).padStart(5)}, maxΔE=${img.maxDeltaE.toFixed(1).padStart(6)}`);
            });
            if (stats.outliers.length > 15) {
                console.log(`  ... and ${stats.outliers.length - 15} more`);
            }
        } else {
            console.log(`  ✅ No outliers detected!`);
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`THRESHOLDS (Calibrated)`);
        console.log(`${'='.repeat(60)}`);
        console.log(`  Integrity:    > ${THRESHOLD_INTEGRITY} (Physical print safety)`);
        console.log(`  Revelation:   > ${THRESHOLD_REVELATION} (Visual quality)`);
        console.log(`  Max Stack:    ≤ ${THRESHOLD_STACK} (Ink overlap limit)`);

        console.log(`\n${'='.repeat(60)}`);
        console.log(`FAILURES (${stats.failures.length} images)`);
        console.log(`${'='.repeat(60)}`);
        if (stats.failures.length > 0) {
            stats.failures.sort((a, b) => a.score - b.score);
            stats.failures.forEach(f => {
                console.log(`  ⚠️ [${f.source}] ${f.file}: ${f.reason}`);
            });
        } else {
            console.log(`  ✅ No failures detected!`);
        }

        // Summary line
        const passCount = stats.totalImages - stats.failures.length;
        const passRate = ((passCount / stats.totalImages) * 100).toFixed(1);
        console.log(`\n${'='.repeat(60)}`);
        console.log(`SUMMARY: ${passCount}/${stats.totalImages} images passing (${passRate}%)`);
        console.log(`${'='.repeat(60)}`);
        console.log();
    }
}

// === MAIN ===

function main() {
    const args = process.argv.slice(2);

    if (args.length < 3) {
        console.log(`
Usage: node analyze-batch.js <dataset-name> <output-dir> <result-dir-1> [result-dir-2] ...

Arguments:
  dataset-name   Name used for output files (e.g., "CQ100", "SP100")
  output-dir     Directory for analysis output files
  result-dirs    One or more directories containing (PSD, JSON) pairs

Output:
  {dataset-name}_meta_analysis.json  - Full statistical report
  {dataset-name}_summary.csv         - Spreadsheet-friendly summary

Examples:
  # Analyze CQ100 (single source)
  node analyze-batch.js CQ100 data/CQ100/output data/CQ100/output/8bit

  # Analyze SP100 (multiple sources)
  node analyze-batch.js SP100 data/SP100/output data/SP100/output/met data/SP100/output/rijks
`);
        process.exit(1);
    }

    const datasetName = args[0];
    const outputDir = path.resolve(args[1]);
    const resultDirs = args.slice(2).map(d => path.resolve(d));

    BatchAnalyzer.run(datasetName, outputDir, resultDirs);
}

if (require.main === module) {
    main();
}

module.exports = BatchAnalyzer;
