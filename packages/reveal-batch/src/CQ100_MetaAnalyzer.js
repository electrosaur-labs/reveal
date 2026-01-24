/**
 * CQ100_MetaAnalyzer.js
 * Aggregates individual separation metrics into a global health report.
 *
 * CALIBRATION UPDATE (2026-01-20):
 * - Integrity Pass: 60 (Physical print safety limit)
 * - Revelation Pass: 20 (Lowered from 50→30→20 to isolate true outliers)
 * - Stack Pass: 5 (Max ink overlap)
 *
 * Rationale: A validator that flags 32% of images as "Failures" is one users
 * will turn off - it cries wolf too often. By setting threshold to 20:
 * - Score 28: "A bit rough, but printable" (Pass - acceptable)
 * - Score 8: "This is broken" (Fail - actionable)
 *
 * This turns the metric from a "Grade" (which hurts feelings) into an "Alarm"
 * (which saves money). Captures only the bottom ~10% true failures.
 */
const fs = require('fs');
const path = require('path');

// CONFIGURATION - Parse arguments from command line
// Usage:
//   node src/CQ100_MetaAnalyzer.js [8|16]                    # CQ100 dataset
//   node src/CQ100_MetaAnalyzer.js sp100 [met|rijks] [8|16]  # SP100 dataset
let INPUT_DIR, OUTPUT_REPORT, OUTPUT_CSV, DATASET_NAME;

if (process.argv[2] === 'sp100') {
    const source = process.argv[3] || 'met';
    const bitDepth = process.argv[4] === '16' ? '16bit' : '8bit';
    DATASET_NAME = `SP100/${source}/${bitDepth}`;
    INPUT_DIR = path.join(__dirname, `../data/SP100/output/${source}/psd/${bitDepth}`);
    OUTPUT_REPORT = path.join(__dirname, `../data/SP100/output/${source}/sp100_${source}_meta_analysis_${bitDepth}.json`);
    OUTPUT_CSV = path.join(__dirname, `../data/SP100/output/${source}/sp100_${source}_summary_${bitDepth}.csv`);
} else {
    const bitDepth = process.argv[2] === '16' ? '16bit' : '8bit';
    DATASET_NAME = `CQ100/${bitDepth}`;
    INPUT_DIR = path.join(__dirname, `../data/CQ100_v4/output/${bitDepth}`);
    OUTPUT_REPORT = path.join(__dirname, `../data/CQ100_v4/output/cq100_meta_analysis_${bitDepth}.json`);
    OUTPUT_CSV = path.join(__dirname, `../data/CQ100_v4/output/cq100_summary_${bitDepth}.csv`);
}

// --- CALIBRATED THRESHOLDS ---
const THRESHOLD_INTEGRITY = 60;   // Must be physically printable
const THRESHOLD_REVELATION = 20;  // Captures only true failures (lights, charts)
const THRESHOLD_STACK = 5;        // Max ink overlap

class MetaAnalyzer {
    // --- STATISTICAL HELPERS ---

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

    static run() {
        console.log(`🔍 Scanning ${INPUT_DIR} for sidecars...`);

        const files = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith('.json'));
        if (files.length === 0) {
            console.error("❌ No JSON files found.");
            return;
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

        // Collect all image records for outlier analysis
        const allImages = [];

        const stats = {
            totalImages: 0,
            global: {},  // Will be populated with full statistics
            byPreset: {},
            extremes: {
                highestDeltaE: { val: 0, file: '' },
                lowestScore: { val: 100, file: '' },
                worstIntegrity: { val: 100, file: '' },
                slowestProcess: { val: 0, file: '' }
            },
            outliers: [],  // P75-based outliers
            failures: []
        };

        const csvRows = ['Filename,Preset,AvgDeltaE,MaxDeltaE,RevScore,Integrity,Breaches,ProcTime,Colors'];

        files.forEach(file => {
            try {
                const content = fs.readFileSync(path.join(INPUT_DIR, file), 'utf8');
                const data = JSON.parse(content);

                stats.totalImages++;

                const imgRecord = {
                    filename: file,
                    avgDeltaE: data.metrics.global_fidelity.avgDeltaE,
                    maxDeltaE: data.metrics.global_fidelity.maxDeltaE,
                    revelation: data.metrics.feature_preservation.revelationScore,
                    integrity: parseFloat(data.metrics.physical_feasibility.integrityScore),
                    colorCount: data.palette ? data.palette.length : 0,
                    processTime: data.timing.totalMs
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

                this.accumulatePreset(stats, data);
                this.checkExtremes(stats, data, file);
                this.checkFailure(stats, data, file);

                // Add to CSV buffer
                const colorCount = data.palette ? data.palette.length : 0;
                csvRows.push(`${data.meta.filename},${data.input_parameters.presetId || 'auto'},${data.metrics.global_fidelity.avgDeltaE},${data.metrics.global_fidelity.maxDeltaE},${data.metrics.feature_preservation.revelationScore},${data.metrics.physical_feasibility.integrityScore},${data.metrics.physical_feasibility.densityFloorBreaches || 0},${data.timing.totalMs},${colorCount}`);

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

        // Identify P75-based outliers (images exceeding 75th percentile)
        stats.outliers = this.findOutliers(allImages, stats.global);

        this.finalizePresetStats(stats);

        // Write outputs
        fs.writeFileSync(OUTPUT_REPORT, JSON.stringify(stats, null, 4));
        fs.writeFileSync(OUTPUT_CSV, csvRows.join('\n'));

        console.log(`\n✅ Analysis Complete. Scanned ${stats.totalImages} images.`);
        console.log(`👉 Report: ${OUTPUT_REPORT}`);
        console.log(`👉 Spreadsheet: ${OUTPUT_CSV}`);

        // Print summary to console
        console.log(`\n${'='.repeat(60)}`);
        console.log(`GLOBAL STATISTICS`);
        console.log(`${'='.repeat(60)}`);
        this.printMetricStats('DeltaE (avg)', stats.global.deltaE);
        this.printMetricStats('DeltaE (max)', stats.global.maxDeltaE);
        this.printMetricStats('Revelation', stats.global.revelation);
        this.printMetricStats('Integrity', stats.global.integrity);
        this.printMetricStats('Process Time (ms)', stats.global.processTime);
        this.printMetricStats('Color Count', stats.global.colorCount);

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
                console.log(`  ⚠️ ${img.filename.padEnd(30)} avgΔE=${img.avgDeltaE.toFixed(1).padStart(5)}, maxΔE=${img.maxDeltaE.toFixed(1).padStart(6)}, colors=${img.colorCount}`);
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
            // Sort by revelation score (worst first)
            stats.failures.sort((a, b) => a.score - b.score);
            stats.failures.forEach(f => {
                console.log(`  ⚠️ ${f.file}: ${f.reason}`);
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

    // --- AGGREGATION LOGIC ---

    static printMetricStats(name, s) {
        console.log(`  ${name.padEnd(20)} mean=${s.mean.toFixed(2).padStart(7)}, median=${s.median.toFixed(2).padStart(7)}, std=${s.stdDev.toFixed(2).padStart(6)}, range=[${s.min.toFixed(1)}, ${s.max.toFixed(1)}], IQR=[${s.p25.toFixed(1)}, ${s.p75.toFixed(1)}]`);
    }

    static accumulatePreset(stats, data) {
        const preset = data.input_parameters.presetId || 'auto';
        if (!stats.byPreset[preset]) {
            stats.byPreset[preset] = {
                count: 0,
                values: {
                    deltaE: [],
                    revelation: [],
                    breaches: []
                }
            };
        }
        const p = stats.byPreset[preset];
        p.count++;
        p.values.deltaE.push(data.metrics.global_fidelity.avgDeltaE);
        p.values.revelation.push(data.metrics.feature_preservation.revelationScore);
        p.values.breaches.push(data.metrics.physical_feasibility.densityFloorBreaches || 0);
    }

    static checkExtremes(stats, data, filename) {
        const m = data.metrics;

        if (m.global_fidelity.maxDeltaE > stats.extremes.highestDeltaE.val) {
            stats.extremes.highestDeltaE = { val: m.global_fidelity.maxDeltaE, file: filename };
        }
        if (m.feature_preservation.revelationScore < stats.extremes.lowestScore.val) {
            stats.extremes.lowestScore = { val: m.feature_preservation.revelationScore, file: filename };
        }
        if (parseFloat(m.physical_feasibility.integrityScore) < stats.extremes.worstIntegrity.val) {
            stats.extremes.worstIntegrity = { val: parseFloat(m.physical_feasibility.integrityScore), file: filename };
        }
        if (data.timing.totalMs > stats.extremes.slowestProcess.val) {
            stats.extremes.slowestProcess = { val: data.timing.totalMs, file: filename };
        }
    }

    /**
     * Find outliers using P75 thresholds (images exceeding 75th percentile)
     * An image is an outlier if avgDeltaE > P75 OR maxDeltaE > P75
     */
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
            return {
                ...img,
                reason: reasons.join(', ')
            };
        });

        // Sort by avgDeltaE descending (worst first)
        outliers.sort((a, b) => b.avgDeltaE - a.avgDeltaE);

        return outliers;
    }

    static checkFailure(stats, data, filename) {
        // DEFINITION OF FAILURE (Calibrated 2026-01-20):
        // 1. Unprintable (Integrity < 60) - Physical print safety
        // 2. Unrecognizable (Rev Score < 30) - Visual quality (calibrated from 50)
        // 3. Thick Stack (Max Ink > 5 layers) - Ink overlap limit
        const integrity = parseFloat(data.metrics.physical_feasibility.integrityScore);
        const score = data.metrics.feature_preservation.revelationScore;
        const stack = data.metrics.physical_feasibility.maxInkStack;

        // Build specific failure reasons
        const reasons = [];
        if (integrity < THRESHOLD_INTEGRITY) reasons.push(`Integrity ${integrity.toFixed(1)}`);
        if (score < THRESHOLD_REVELATION) reasons.push(`RevScore ${score.toFixed(1)}`);
        if (stack > THRESHOLD_STACK) reasons.push(`Stack ${stack}`);

        if (reasons.length > 0) {
            stats.failures.push({
                file: filename,
                reason: reasons.join(', '),
                integrity,
                score,
                stack
            });
        }
    }

    static finalizePresetStats(stats) {
        // Calculate Per-Preset Statistics
        for (const key in stats.byPreset) {
            const p = stats.byPreset[key];
            p.deltaE = this.computeStats(p.values.deltaE);
            p.revelation = this.computeStats(p.values.revelation);
            p.breaches = this.computeStats(p.values.breaches);
            delete p.values;  // Remove raw values from output
        }
    }
}

// Run if called directly
if (require.main === module) {
    MetaAnalyzer.run();
}

module.exports = MetaAnalyzer;
