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

// CONFIGURATION
const INPUT_DIR = path.join(__dirname, '../data/CQ100_v4/output/psd'); // Where your .json sidecars live
const OUTPUT_REPORT = path.join(__dirname, '../data/CQ100_v4/output/cq100_meta_analysis.json');
const OUTPUT_CSV = path.join(__dirname, '../data/CQ100_v4/output/cq100_summary.csv');

// --- CALIBRATED THRESHOLDS ---
const THRESHOLD_INTEGRITY = 60;   // Must be physically printable
const THRESHOLD_REVELATION = 20;  // Captures only true failures (lights, charts)
const THRESHOLD_STACK = 5;        // Max ink overlap

class MetaAnalyzer {
    static run() {
        console.log(`🔍 Scanning ${INPUT_DIR} for sidecars...`);

        const files = fs.readdirSync(INPUT_DIR).filter(f => f.endsWith('.json'));
        if (files.length === 0) {
            console.error("❌ No JSON files found.");
            return;
        }

        const stats = {
            totalImages: 0,
            global: {
                avgDeltaE: 0,
                avgRevelationScore: 0,
                avgProcessingTime: 0,
                avgIntegrity: 0
            },
            byPreset: {}, // Will auto-populate
            outliers: {
                highestDeltaE: { val: 0, file: '' },
                lowestScore: { val: 100, file: '' },
                worstIntegrity: { val: 100, file: '' },
                slowestProcess: { val: 0, file: '' }
            },
            failures: [] // Images that are "Unprintable"
        };

        const csvRows = ['Filename,Preset,AvgDeltaE,MaxDeltaE,RevScore,Integrity,Breaches,ProcTime'];

        files.forEach(file => {
            try {
                const content = fs.readFileSync(path.join(INPUT_DIR, file), 'utf8');
                const data = JSON.parse(content);

                stats.totalImages++;
                this.accumulateGlobal(stats, data);
                this.accumulatePreset(stats, data);
                this.checkOutliers(stats, data, file);
                this.checkFailure(stats, data, file);

                // Add to CSV buffer
                csvRows.push(`${data.meta.filename},${data.input_parameters.presetId},${data.metrics.global_fidelity.avgDeltaE},${data.metrics.global_fidelity.maxDeltaE},${data.metrics.feature_preservation.revelationScore},${data.metrics.physical_feasibility.integrityScore},${data.metrics.physical_feasibility.densityFloorBreaches},${data.timing.totalMs}`);

            } catch (err) {
                console.warn(`⚠️ Skipped corrupt file ${file}: ${err.message}`);
            }
        });

        this.finalizeStats(stats);

        // Write outputs
        fs.writeFileSync(OUTPUT_REPORT, JSON.stringify(stats, null, 4));
        fs.writeFileSync(OUTPUT_CSV, csvRows.join('\n'));

        console.log(`\n✅ Analysis Complete. Scanned ${stats.totalImages} images.`);
        console.log(`👉 Report: ${OUTPUT_REPORT}`);
        console.log(`👉 Spreadsheet: ${OUTPUT_CSV}`);

        // Print summary to console
        console.log(`\n${'='.repeat(60)}`);
        console.log(`GLOBAL AVERAGES`);
        console.log(`${'='.repeat(60)}`);
        console.log(`  Avg DeltaE:         ${stats.global.avgDeltaE}`);
        console.log(`  Avg Revelation:     ${stats.global.avgRevelationScore}`);
        console.log(`  Avg Integrity:      ${stats.global.avgIntegrity}`);
        console.log(`  Avg Process Time:   ${stats.global.avgProcessingTime}ms`);

        console.log(`\n${'='.repeat(60)}`);
        console.log(`PRESET DISTRIBUTION`);
        console.log(`${'='.repeat(60)}`);
        Object.entries(stats.byPreset)
            .sort((a, b) => b[1].count - a[1].count)
            .forEach(([preset, data]) => {
                console.log(`  ${preset}:`);
                console.log(`    Count:       ${data.count} images`);
                console.log(`    Avg DeltaE:  ${data.avgDeltaE}`);
                console.log(`    Avg Score:   ${data.avgScore}`);
                console.log(`    Avg Breaches: ${data.avgBreaches}`);
            });

        console.log(`\n${'='.repeat(60)}`);
        console.log(`OUTLIERS`);
        console.log(`${'='.repeat(60)}`);
        console.log(`  Highest DeltaE:     ${stats.outliers.highestDeltaE.val.toFixed(2)} (${stats.outliers.highestDeltaE.file})`);
        console.log(`  Lowest Score:       ${stats.outliers.lowestScore.val.toFixed(1)} (${stats.outliers.lowestScore.file})`);
        console.log(`  Worst Integrity:    ${stats.outliers.worstIntegrity.val} (${stats.outliers.worstIntegrity.file})`);
        console.log(`  Slowest Process:    ${stats.outliers.slowestProcess.val}ms (${stats.outliers.slowestProcess.file})`);

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

    static accumulateGlobal(stats, data) {
        stats.global.avgDeltaE += data.metrics.global_fidelity.avgDeltaE;
        stats.global.avgRevelationScore += data.metrics.feature_preservation.revelationScore;
        stats.global.avgProcessingTime += data.timing.totalMs;
        stats.global.avgIntegrity += parseFloat(data.metrics.physical_feasibility.integrityScore);
    }

    static accumulatePreset(stats, data) {
        const preset = data.input_parameters.presetId;
        if (!stats.byPreset[preset]) {
            stats.byPreset[preset] = {
                count: 0,
                avgDeltaE: 0,
                avgScore: 0,
                breaches: 0
            };
        }
        const p = stats.byPreset[preset];
        p.count++;
        p.avgDeltaE += data.metrics.global_fidelity.avgDeltaE;
        p.avgScore += data.metrics.feature_preservation.revelationScore;
        p.breaches += data.metrics.physical_feasibility.densityFloorBreaches;
    }

    static checkOutliers(stats, data, filename) {
        const m = data.metrics;

        if (m.global_fidelity.maxDeltaE > stats.outliers.highestDeltaE.val) {
            stats.outliers.highestDeltaE = { val: m.global_fidelity.maxDeltaE, file: filename };
        }
        if (m.feature_preservation.revelationScore < stats.outliers.lowestScore.val) {
            stats.outliers.lowestScore = { val: m.feature_preservation.revelationScore, file: filename };
        }
        if (parseFloat(m.physical_feasibility.integrityScore) < stats.outliers.worstIntegrity.val) {
            stats.outliers.worstIntegrity = { val: parseFloat(m.physical_feasibility.integrityScore), file: filename };
        }
        if (data.timing.totalMs > stats.outliers.slowestProcess.val) {
            stats.outliers.slowestProcess = { val: data.timing.totalMs, file: filename };
        }
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

    static finalizeStats(stats) {
        // Calculate Global Averages
        stats.global.avgDeltaE = (stats.global.avgDeltaE / stats.totalImages).toFixed(2);
        stats.global.avgRevelationScore = (stats.global.avgRevelationScore / stats.totalImages).toFixed(1);
        stats.global.avgProcessingTime = Math.round(stats.global.avgProcessingTime / stats.totalImages);
        stats.global.avgIntegrity = (stats.global.avgIntegrity / stats.totalImages).toFixed(1);

        // Calculate Per-Preset Averages
        for (const key in stats.byPreset) {
            const p = stats.byPreset[key];
            p.avgDeltaE = (p.avgDeltaE / p.count).toFixed(2);
            p.avgScore = (p.avgScore / p.count).toFixed(1);
            p.avgBreaches = Math.round(p.breaches / p.count);
        }
    }
}

// Run if called directly
if (require.main === module) {
    MetaAnalyzer.run();
}

module.exports = MetaAnalyzer;
