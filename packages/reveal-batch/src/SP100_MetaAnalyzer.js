/**
 * SP100_MetaAnalyzer.js
 * Aggregates SP-100 separation metrics into a global health report.
 * Analyzes both LOC and WikiArt sources.
 */
const fs = require('fs');
const path = require('path');

// CONFIGURATION
const BASE_DIR = path.join(__dirname, '../data/SP100/output');
const SOURCES = ['loc', 'wikiart'];

// --- CALIBRATED THRESHOLDS ---
const THRESHOLD_INTEGRITY = 60;
const THRESHOLD_REVELATION = 20;
const THRESHOLD_STACK = 5;

class SP100MetaAnalyzer {
    static run() {
        console.log(`\n🎨 SP-100 Meta-Analysis`);
        console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

        const allResults = [];
        const bySource = {};

        for (const source of SOURCES) {
            const psdDir = path.join(BASE_DIR, source, 'psd');
            if (!fs.existsSync(psdDir)) {
                console.log(`⚠️ Source directory not found: ${psdDir}`);
                continue;
            }

            const files = fs.readdirSync(psdDir).filter(f => f.endsWith('.json') && f !== 'batch-report.json');
            console.log(`📁 ${source.toUpperCase()}: ${files.length} images`);

            bySource[source] = {
                count: 0,
                totalDeltaE: 0,
                totalRevScore: 0,
                totalIntegrity: 0,
                totalColors: 0,
                colorDist: {},
                failures: []
            };

            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(psdDir, file), 'utf8'));
                    const metrics = data.metrics;
                    const config = data.configuration;
                    const dna = data.dna;

                    if (!metrics || !metrics.global_fidelity) continue;

                    const revScore = metrics.feature_preservation?.revelationScore || 0;
                    const integrity = metrics.physical_feasibility?.integrityScore || 100;
                    const deltaE = metrics.global_fidelity?.avgDeltaE || 0;
                    const colors = config?.targetColors || data.palette?.length || 0;

                    bySource[source].count++;
                    bySource[source].totalDeltaE += deltaE;
                    bySource[source].totalRevScore += revScore;
                    bySource[source].totalIntegrity += integrity;
                    bySource[source].totalColors += colors;

                    // Track color distribution
                    bySource[source].colorDist[colors] = (bySource[source].colorDist[colors] || 0) + 1;

                    // Check for failures
                    const failed = revScore < THRESHOLD_REVELATION || integrity < THRESHOLD_INTEGRITY;
                    if (failed) {
                        bySource[source].failures.push({
                            file: file,
                            revScore: revScore.toFixed(1),
                            integrity: integrity.toFixed(1),
                            deltaE: deltaE.toFixed(2)
                        });
                    }

                    allResults.push({
                        source,
                        file,
                        revScore,
                        integrity,
                        deltaE,
                        colors,
                        dna: dna ? { l: dna.l, c: dna.c, k: dna.k } : null
                    });
                } catch (err) {
                    console.log(`  ⚠️ Skipped ${file}: ${err.message}`);
                }
            }
        }

        // Print results
        console.log(`\n${'━'.repeat(60)}`);
        console.log(`SOURCE BREAKDOWN`);
        console.log(`${'━'.repeat(60)}`);

        let totalCount = 0;
        let totalPass = 0;

        for (const source of SOURCES) {
            const s = bySource[source];
            if (!s || s.count === 0) continue;

            totalCount += s.count;
            const passCount = s.count - s.failures.length;
            totalPass += passCount;

            console.log(`\n📊 ${source.toUpperCase()}`);
            console.log(`  Images:      ${s.count}`);
            console.log(`  Avg DeltaE:  ${(s.totalDeltaE / s.count).toFixed(2)}`);
            console.log(`  Avg RevScore: ${(s.totalRevScore / s.count).toFixed(1)}`);
            console.log(`  Avg Integrity: ${(s.totalIntegrity / s.count).toFixed(1)}`);
            console.log(`  Avg Colors:  ${(s.totalColors / s.count).toFixed(1)}`);
            console.log(`  Pass Rate:   ${passCount}/${s.count} (${((passCount / s.count) * 100).toFixed(1)}%)`);

            // Color distribution
            console.log(`  Color Distribution:`);
            const sortedColors = Object.keys(s.colorDist).map(Number).sort((a, b) => a - b);
            for (const c of sortedColors) {
                const pct = ((s.colorDist[c] / s.count) * 100).toFixed(1);
                console.log(`    ${c} colors: ${s.colorDist[c]} (${pct}%)`);
            }

            if (s.failures.length > 0) {
                console.log(`  Failures (${s.failures.length}):`);
                s.failures.slice(0, 5).forEach(f => {
                    console.log(`    - ${f.file}: RevScore=${f.revScore}, ΔE=${f.deltaE}`);
                });
                if (s.failures.length > 5) {
                    console.log(`    ... and ${s.failures.length - 5} more`);
                }
            }
        }

        // Global summary
        console.log(`\n${'━'.repeat(60)}`);
        console.log(`GLOBAL SUMMARY`);
        console.log(`${'━'.repeat(60)}`);
        console.log(`Total Images:  ${totalCount}`);
        console.log(`Total Passing: ${totalPass}/${totalCount} (${((totalPass / totalCount) * 100).toFixed(1)}%)`);

        // Compare to CQ100 targets
        console.log(`\n${'━'.repeat(60)}`);
        console.log(`SP-100 vs CQ100 TARGETS`);
        console.log(`${'━'.repeat(60)}`);

        const allColors = allResults.map(r => r.colors);
        const avgColors = allColors.reduce((a, b) => a + b, 0) / allColors.length;
        const at12Colors = allColors.filter(c => c >= 12).length;
        const at12Pct = (at12Colors / allColors.length) * 100;

        console.log(`  Metric          | CQ100  | SP-100 | Target`);
        console.log(`  ----------------|--------|--------|--------`);
        console.log(`  Avg Colors      | 10.2   | ${avgColors.toFixed(1).padStart(5)}  | 6-8`);
        console.log(`  12+ Color %     | 41%    | ${at12Pct.toFixed(0).padStart(3)}%   | <20%`);
        console.log(`  Pass Rate       | 82%    | ${((totalPass / totalCount) * 100).toFixed(0).padStart(3)}%   | >90%`);

        // Save report
        const reportPath = path.join(BASE_DIR, 'sp100_meta_analysis.json');
        fs.writeFileSync(reportPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            summary: {
                totalImages: totalCount,
                totalPassing: totalPass,
                passRate: ((totalPass / totalCount) * 100).toFixed(1) + '%',
                avgColors: avgColors.toFixed(1),
                at12ColorsPct: at12Pct.toFixed(1) + '%'
            },
            bySource,
            results: allResults
        }, null, 2));

        console.log(`\n✓ Report saved: ${reportPath}\n`);
    }
}

// Run
SP100MetaAnalyzer.run();
