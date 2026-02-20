/**
 * TESTIMAGES_MetaAnalyzer.js
 * Aggregates individual separation metrics into a global health report for TESTIMAGES dataset.
 *
 * TESTIMAGES structure: data/TESTIMAGES/output/psd/16bit/*.json
 *
 * METRICS:
 * - integrityScore: True Integrity (ink + valid paper coverage)
 * - densityIntegrity: Density floor breach tolerance (small isolated pixels)
 * - revelationScore: Feature preservation quality
 *
 * CALIBRATION (from CQ100):
 * - Integrity Pass: 60 (Physical print safety limit)
 * - Revelation Pass: 20 (Isolate true outliers)
 * - Stack Pass: 5 (Max ink overlap)
 */
const fs = require('fs');
const path = require('path');

// CONFIGURATION
const TESTIMAGES_OUTPUT = path.join(__dirname, '../data/TESTIMAGES/output/psd/16bit');
const OUTPUT_REPORT = path.join(TESTIMAGES_OUTPUT, 'testimages_meta_analysis.json');
const OUTPUT_CSV = path.join(TESTIMAGES_OUTPUT, 'testimages_summary.csv');

// --- CALIBRATED THRESHOLDS ---
const THRESHOLD_INTEGRITY = 60;   // Must be physically printable
const THRESHOLD_REVELATION = 20;  // Captures only true failures (lights, charts)
const THRESHOLD_STACK = 5;        // Max ink overlap

class TESTIMAGESMetaAnalyzer {
    static run() {
        console.log(`🔍 Scanning TESTIMAGES dataset...`);

        // Collect JSON files (excluding non-image JSON files)
        const NON_IMAGE = new Set(['batch-report.json', 'testimages_meta_analysis.json', 'testimages_analysis.json']);
        const allFiles = fs.readdirSync(TESTIMAGES_OUTPUT)
            .filter(f => f.endsWith('.json') && !NON_IMAGE.has(f))
            .map(f => ({ file: f, fullPath: path.join(TESTIMAGES_OUTPUT, f) }));

        console.log(`  Found ${allFiles.length} JSON files`);

        if (allFiles.length === 0) {
            console.error("❌ No JSON files found.");
            return;
        }

        const stats = {
            totalImages: 0,
            global: {
                avgDeltaE: 0,
                avgMaxDeltaE: 0,
                avgRevelationScore: 0,
                avgBaseScore: 0,
                avgEfficiencyPenalty: 0,
                avgSaliencyLoss: 0,
                avgProcessingTime: 0,
                avgIntegrity: 0,
                avgDensityIntegrity: 0,
                avgScreenCount: 0,
                avgDnaFidelity: 0,
                avgSectorDrift: 0
            },
            byArchetype: {},  // Distribution by archetype
            byColorCount: {}, // Distribution by screen count
            byDitherType: {}, // Distribution by dither type
            outliers: {
                highestDeltaE: { val: 0, file: '' },
                lowestScore: { val: 100, file: '' },
                worstIntegrity: { val: 100, file: '' },
                slowestProcess: { val: 0, file: '' },
                mostScreens: { val: 0, file: '' },
                highestSaliencyLoss: { val: 0, file: '' },
                lowestDnaFidelity: { val: 100, file: '' },
                highestSectorDrift: { val: 0, file: '' }
            },
            qualityDistribution: {
                excellent: 0,    // Revelation > 60
                good: 0,         // Revelation 40-60
                acceptable: 0,   // Revelation 20-40
                poor: 0          // Revelation < 20
            },
            failures: []
        };

        const csvRows = ['Filename,Archetype,Colors,AvgDeltaE,MaxDeltaE,RevScore,BaseScore,EffPenalty,SaliencyLoss,Integrity,DensIntegrity,Breaches,DnaFidelity,SectorDrift,DnaAlerts,DitherType,ProcTime'];

        allFiles.forEach(({ file, fullPath }) => {
            try {
                const content = fs.readFileSync(fullPath, 'utf8');
                const data = JSON.parse(content);

                stats.totalImages++;
                this.accumulateGlobal(stats, data);
                this.accumulateArchetype(stats, data);
                this.accumulateColorCount(stats, data);
                this.accumulateDitherType(stats, data);
                this.checkOutliers(stats, data, file);
                this.checkQualityDistribution(stats, data);
                this.checkFailure(stats, data, file);

                // Extract metrics
                const colorCount = data.palette?.length || 'unknown';
                const archetype = data.configuration?.meta?.archetype || 'unknown';
                const ditherType = data.configuration?.ditherType || 'unknown';
                const dnaFidelity = data.dnaFidelity?.fidelity ?? null;
                const sectorDrift = data.dnaFidelity?.sectorDrift ?? null;
                const dnaAlerts = data.dnaFidelity?.alerts?.length || 0;

                // Add to CSV buffer
                csvRows.push([
                    data.meta.filename,
                    archetype,
                    colorCount,
                    data.metrics.global_fidelity.avgDeltaE.toFixed(2),
                    data.metrics.global_fidelity.maxDeltaE.toFixed(2),
                    data.metrics.feature_preservation.revelationScore.toFixed(1),
                    data.metrics.feature_preservation.baseScore.toFixed(1),
                    data.metrics.feature_preservation.efficiencyPenalty,
                    data.metrics.feature_preservation.saliencyLoss.toFixed(2),
                    data.metrics.physical_feasibility.integrityScore,
                    data.metrics.physical_feasibility.densityIntegrity,
                    data.metrics.physical_feasibility.densityFloorBreaches,
                    dnaFidelity ?? '',
                    sectorDrift != null ? sectorDrift.toFixed(3) : '',
                    dnaAlerts,
                    ditherType,
                    data.timing.totalMs
                ].join(','));

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
        this.printSummary(stats);
    }

    static accumulateGlobal(stats, data) {
        stats.global.avgDeltaE += data.metrics.global_fidelity.avgDeltaE;
        stats.global.avgMaxDeltaE += data.metrics.global_fidelity.maxDeltaE;
        stats.global.avgRevelationScore += data.metrics.feature_preservation.revelationScore;
        stats.global.avgBaseScore += data.metrics.feature_preservation.baseScore;
        stats.global.avgEfficiencyPenalty += data.metrics.feature_preservation.efficiencyPenalty;
        stats.global.avgSaliencyLoss += data.metrics.feature_preservation.saliencyLoss;
        stats.global.avgProcessingTime += data.timing.totalMs;
        stats.global.avgIntegrity += data.metrics.physical_feasibility.integrityScore;
        stats.global.avgDensityIntegrity += data.metrics.physical_feasibility.densityIntegrity || 0;
        stats.global.avgScreenCount += data.metrics.feature_preservation.screenCount;
        stats.global.avgDnaFidelity += data.dnaFidelity?.fidelity || 0;
        stats.global.avgSectorDrift += data.dnaFidelity?.sectorDrift || 0;
    }

    static accumulateArchetype(stats, data) {
        const archetype = data.configuration?.meta?.archetype || 'unknown';
        if (!stats.byArchetype[archetype]) {
            stats.byArchetype[archetype] = {
                count: 0,
                avgDeltaE: 0,
                avgScore: 0,
                avgIntegrity: 0,
                avgScreens: 0,
                avgDnaFidelity: 0
            };
        }
        const arch = stats.byArchetype[archetype];
        arch.count++;
        arch.avgDeltaE += data.metrics.global_fidelity.avgDeltaE;
        arch.avgScore += data.metrics.feature_preservation.revelationScore;
        arch.avgIntegrity += data.metrics.physical_feasibility.integrityScore;
        arch.avgScreens += data.metrics.feature_preservation.screenCount;
        arch.avgDnaFidelity += data.dnaFidelity?.fidelity || 0;
    }

    static accumulateColorCount(stats, data) {
        const colorCount = data.palette?.length || 0;
        stats.byColorCount[colorCount] = (stats.byColorCount[colorCount] || 0) + 1;
    }

    static accumulateDitherType(stats, data) {
        const ditherType = data.configuration?.ditherType || 'unknown';
        if (!stats.byDitherType[ditherType]) {
            stats.byDitherType[ditherType] = {
                count: 0,
                avgDeltaE: 0,
                avgScore: 0
            };
        }
        const dither = stats.byDitherType[ditherType];
        dither.count++;
        dither.avgDeltaE += data.metrics.global_fidelity.avgDeltaE;
        dither.avgScore += data.metrics.feature_preservation.revelationScore;
    }

    static checkOutliers(stats, data, file) {
        const deltaE = data.metrics.global_fidelity.avgDeltaE;
        const revScore = data.metrics.feature_preservation.revelationScore;
        const integrity = data.metrics.physical_feasibility.integrityScore;
        const procTime = data.timing.totalMs;
        const screens = data.metrics.feature_preservation.screenCount;
        const saliencyLoss = data.metrics.feature_preservation.saliencyLoss;

        if (deltaE > stats.outliers.highestDeltaE.val) {
            stats.outliers.highestDeltaE = { val: deltaE, file };
        }
        if (revScore < stats.outliers.lowestScore.val) {
            stats.outliers.lowestScore = { val: revScore, file };
        }
        if (integrity < stats.outliers.worstIntegrity.val) {
            stats.outliers.worstIntegrity = { val: integrity, file };
        }
        if (procTime > stats.outliers.slowestProcess.val) {
            stats.outliers.slowestProcess = { val: procTime, file };
        }
        if (screens > stats.outliers.mostScreens.val) {
            stats.outliers.mostScreens = { val: screens, file };
        }
        if (saliencyLoss > stats.outliers.highestSaliencyLoss.val) {
            stats.outliers.highestSaliencyLoss = { val: saliencyLoss, file };
        }
        const dnaFidelity = data.dnaFidelity?.fidelity;
        const sectorDrift = data.dnaFidelity?.sectorDrift;
        if (dnaFidelity != null && dnaFidelity < stats.outliers.lowestDnaFidelity.val) {
            stats.outliers.lowestDnaFidelity = { val: dnaFidelity, file };
        }
        if (sectorDrift != null && sectorDrift > stats.outliers.highestSectorDrift.val) {
            stats.outliers.highestSectorDrift = { val: sectorDrift, file };
        }
    }

    static checkQualityDistribution(stats, data) {
        const revScore = data.metrics.feature_preservation.revelationScore;
        if (revScore >= 60) {
            stats.qualityDistribution.excellent++;
        } else if (revScore >= 40) {
            stats.qualityDistribution.good++;
        } else if (revScore >= 20) {
            stats.qualityDistribution.acceptable++;
        } else {
            stats.qualityDistribution.poor++;
        }
    }

    static checkFailure(stats, data, file) {
        const revScore = data.metrics.feature_preservation.revelationScore;
        const integrity = data.metrics.physical_feasibility.integrityScore;

        const failures = [];
        if (revScore < THRESHOLD_REVELATION) failures.push('Low Revelation');
        if (integrity < THRESHOLD_INTEGRITY) failures.push('Low Integrity');

        if (failures.length > 0) {
            stats.failures.push({
                file,
                reasons: failures,
                revScore,
                integrity
            });
        }
    }

    static finalizeStats(stats) {
        const n = stats.totalImages;
        stats.global.avgDeltaE = (stats.global.avgDeltaE / n).toFixed(2);
        stats.global.avgMaxDeltaE = (stats.global.avgMaxDeltaE / n).toFixed(2);
        stats.global.avgRevelationScore = (stats.global.avgRevelationScore / n).toFixed(1);
        stats.global.avgBaseScore = (stats.global.avgBaseScore / n).toFixed(1);
        stats.global.avgEfficiencyPenalty = (stats.global.avgEfficiencyPenalty / n).toFixed(1);
        stats.global.avgSaliencyLoss = (stats.global.avgSaliencyLoss / n).toFixed(2);
        stats.global.avgProcessingTime = Math.round(stats.global.avgProcessingTime / n);
        stats.global.avgIntegrity = (stats.global.avgIntegrity / n).toFixed(1);
        stats.global.avgDensityIntegrity = (stats.global.avgDensityIntegrity / n).toFixed(1);
        stats.global.avgScreenCount = (stats.global.avgScreenCount / n).toFixed(1);
        stats.global.avgDnaFidelity = (stats.global.avgDnaFidelity / n).toFixed(1);
        stats.global.avgSectorDrift = (stats.global.avgSectorDrift / n).toFixed(3);

        // Finalize by-archetype
        Object.keys(stats.byArchetype).forEach(arch => {
            const data = stats.byArchetype[arch];
            data.avgDeltaE = (data.avgDeltaE / data.count).toFixed(2);
            data.avgScore = (data.avgScore / data.count).toFixed(1);
            data.avgIntegrity = (data.avgIntegrity / data.count).toFixed(1);
            data.avgScreens = (data.avgScreens / data.count).toFixed(1);
            data.avgDnaFidelity = (data.avgDnaFidelity / data.count).toFixed(1);
        });

        // Finalize by-dither
        Object.keys(stats.byDitherType).forEach(dither => {
            const data = stats.byDitherType[dither];
            data.avgDeltaE = (data.avgDeltaE / data.count).toFixed(2);
            data.avgScore = (data.avgScore / data.count).toFixed(1);
        });
    }

    static printSummary(stats) {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`GLOBAL AVERAGES (${stats.totalImages} images)`);
        console.log(`${'='.repeat(70)}`);
        console.log(`  Avg DeltaE:            ${stats.global.avgDeltaE}`);
        console.log(`  Avg Max DeltaE:        ${stats.global.avgMaxDeltaE}`);
        console.log(`  Avg Revelation Score:  ${stats.global.avgRevelationScore} (${this.getScoreGrade(stats.global.avgRevelationScore)})`);
        console.log(`  Avg Base Score:        ${stats.global.avgBaseScore}`);
        console.log(`  Avg Efficiency Penalty: ${stats.global.avgEfficiencyPenalty}`);
        console.log(`  Avg Saliency Loss:     ${stats.global.avgSaliencyLoss}%`);
        console.log(`  Avg Integrity:         ${stats.global.avgIntegrity}`);
        console.log(`  Avg Density Integrity: ${stats.global.avgDensityIntegrity}`);
        console.log(`  Avg Screen Count:      ${stats.global.avgScreenCount}`);
        console.log(`  Avg DNA Fidelity:      ${stats.global.avgDnaFidelity}`);
        console.log(`  Avg Sector Drift:      ${stats.global.avgSectorDrift}`);
        console.log(`  Avg Processing Time:   ${stats.global.avgProcessingTime}ms`);

        console.log(`\n${'='.repeat(70)}`);
        console.log(`QUALITY DISTRIBUTION`);
        console.log(`${'='.repeat(70)}`);
        const total = stats.totalImages;
        console.log(`  Excellent (≥60):  ${stats.qualityDistribution.excellent} (${((stats.qualityDistribution.excellent/total)*100).toFixed(1)}%)`);
        console.log(`  Good (40-60):     ${stats.qualityDistribution.good} (${((stats.qualityDistribution.good/total)*100).toFixed(1)}%)`);
        console.log(`  Acceptable (20-40): ${stats.qualityDistribution.acceptable} (${((stats.qualityDistribution.acceptable/total)*100).toFixed(1)}%)`);
        console.log(`  Poor (<20):       ${stats.qualityDistribution.poor} (${((stats.qualityDistribution.poor/total)*100).toFixed(1)}%)`);
        console.log(`  ---`);
        console.log(`  Pass Rate (≥20):  ${((1 - stats.qualityDistribution.poor/total)*100).toFixed(1)}%`);

        console.log(`\n${'='.repeat(70)}`);
        console.log(`BY ARCHETYPE`);
        console.log(`${'='.repeat(70)}`);
        Object.entries(stats.byArchetype)
            .sort((a, b) => b[1].count - a[1].count)
            .forEach(([archetype, data]) => {
                console.log(`  ${archetype}:`);
                console.log(`    Count:       ${data.count} images (${((data.count/total)*100).toFixed(1)}%)`);
                console.log(`    Avg DeltaE:  ${data.avgDeltaE}`);
                console.log(`    Avg Score:   ${data.avgScore} (${this.getScoreGrade(data.avgScore)})`);
                console.log(`    Avg Integrity: ${data.avgIntegrity}`);
                console.log(`    Avg DNA Fidelity: ${data.avgDnaFidelity}`);
                console.log(`    Avg Screens: ${data.avgScreens}`);
            });

        console.log(`\n${'='.repeat(70)}`);
        console.log(`COLOR COUNT DISTRIBUTION`);
        console.log(`${'='.repeat(70)}`);
        Object.entries(stats.byColorCount)
            .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
            .forEach(([count, num]) => {
                const pct = ((num / total) * 100).toFixed(1);
                console.log(`  ${count} colors: ${num} images (${pct}%)`);
            });

        console.log(`\n${'='.repeat(70)}`);
        console.log(`BY DITHER TYPE`);
        console.log(`${'='.repeat(70)}`);
        Object.entries(stats.byDitherType)
            .sort((a, b) => b[1].count - a[1].count)
            .forEach(([dither, data]) => {
                console.log(`  ${dither}:`);
                console.log(`    Count:       ${data.count} images (${((data.count/total)*100).toFixed(1)}%)`);
                console.log(`    Avg DeltaE:  ${data.avgDeltaE}`);
                console.log(`    Avg Score:   ${data.avgScore}`);
            });

        console.log(`\n${'='.repeat(70)}`);
        console.log(`OUTLIERS`);
        console.log(`${'='.repeat(70)}`);
        console.log(`  Highest ΔE:          ${stats.outliers.highestDeltaE.val.toFixed(2)} (${stats.outliers.highestDeltaE.file})`);
        console.log(`  Lowest Revelation:   ${stats.outliers.lowestScore.val.toFixed(1)} (${stats.outliers.lowestScore.file})`);
        console.log(`  Worst Integrity:     ${stats.outliers.worstIntegrity.val} (${stats.outliers.worstIntegrity.file})`);
        console.log(`  Slowest Process:     ${stats.outliers.slowestProcess.val}ms (${stats.outliers.slowestProcess.file})`);
        console.log(`  Most Screens:        ${stats.outliers.mostScreens.val} (${stats.outliers.mostScreens.file})`);
        console.log(`  Highest Saliency Loss: ${stats.outliers.highestSaliencyLoss.val.toFixed(2)}% (${stats.outliers.highestSaliencyLoss.file})`);
        console.log(`  Lowest DNA Fidelity: ${stats.outliers.lowestDnaFidelity.val} (${stats.outliers.lowestDnaFidelity.file})`);
        console.log(`  Highest Sector Drift: ${stats.outliers.highestSectorDrift.val.toFixed(3)} (${stats.outliers.highestSectorDrift.file})`);

        if (stats.failures.length > 0) {
            console.log(`\n${'='.repeat(70)}`);
            console.log(`FAILURES (${stats.failures.length})`);
            console.log(`${'='.repeat(70)}`);
            stats.failures.forEach(fail => {
                console.log(`  ${fail.file}`);
                console.log(`    Reasons: ${fail.reasons.join(', ')}`);
                console.log(`    Revelation: ${fail.revScore.toFixed(1)}, Integrity: ${fail.integrity}`);
            });
        } else {
            console.log(`\n✅ NO FAILURES - All images passed quality thresholds!`);
        }
    }

    static getScoreGrade(score) {
        const s = parseFloat(score);
        if (s >= 60) return 'Excellent';
        if (s >= 40) return 'Good';
        if (s >= 20) return 'Acceptable';
        return 'Poor';
    }
}

// Run if called directly
if (require.main === module) {
    TESTIMAGESMetaAnalyzer.run();
}

module.exports = TESTIMAGESMetaAnalyzer;
