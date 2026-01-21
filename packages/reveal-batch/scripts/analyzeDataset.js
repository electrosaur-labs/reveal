#!/usr/bin/env node
/**
 * analyzeDataset.js
 * Comprehensive metadata analysis for posterized images with validation JSON.
 *
 * USAGE:
 *   node scripts/analyzeDataset.js [path]
 *   node scripts/analyzeDataset.js                          # defaults to data/SP100/output
 *   node scripts/analyzeDataset.js data/SP100/output/loc/psd
 *   node scripts/analyzeDataset.js --json                   # output as JSON
 *
 * CALIBRATED THRESHOLDS (from CQ100):
 *   - Integrity:   ≥ 60 (Physical print safety)
 *   - Revelation:  ≥ 20 (Visual quality)
 *   - Max Stack:   ≤ 5  (Ink overlap limit)
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Default config (used when no config file provided)
const DEFAULT_CONFIG = {
    batch_id: 'default',
    description: 'Standard CQ100-calibrated thresholds',
    archetype_defaults: {
        revscore_floor: 20.0,
        delta_e_ceiling: null,
        weight: 1.0
    },
    archetype_overrides: {},
    physical_constraints: {
        max_ink_stack: 5,
        require_100_integrity: false,
        min_integrity: 60,
        max_saliency_loss: null
    },
    scoring: {
        pass_threshold: 0.5,
        weights: { revscore: 0.4, delta_e: 0.2, physical: 0.4 }
    }
};

// Active configuration (loaded from file or default)
let ACTIVE_CONFIG = DEFAULT_CONFIG;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Get thresholds for a specific archetype, merging defaults with overrides
 */
function getArchetypeThresholds(archetype) {
    const defaults = ACTIVE_CONFIG.archetype_defaults;
    const overrides = ACTIVE_CONFIG.archetype_overrides[archetype] || {};

    return {
        revscore_floor: overrides.revscore_floor ?? defaults.revscore_floor,
        delta_e_ceiling: overrides.delta_e_ceiling ?? defaults.delta_e_ceiling,
        weight: overrides.weight ?? defaults.weight,
        notes: overrides.notes || null
    };
}

/**
 * Load config from JSON file
 */
function loadConfig(configPath) {
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(content);
        // Merge with defaults to ensure all fields exist
        return {
            ...DEFAULT_CONFIG,
            ...config,
            archetype_defaults: { ...DEFAULT_CONFIG.archetype_defaults, ...config.archetype_defaults },
            physical_constraints: { ...DEFAULT_CONFIG.physical_constraints, ...config.physical_constraints },
            scoring: { ...DEFAULT_CONFIG.scoring, ...config.scoring }
        };
    } catch (err) {
        console.error(`⚠️ Could not load config from ${configPath}: ${err.message}`);
        return DEFAULT_CONFIG;
    }
}

function findJsonFiles(dir, files = []) {
    if (!fs.existsSync(dir)) return files;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            findJsonFiles(fullPath, files);
        } else if (entry.name.endsWith('.json') && !entry.name.includes('meta_analysis')) {
            files.push(fullPath);
        }
    }
    return files;
}

function median(arr) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdDev(arr) {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
}

function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}

function histogram(arr, buckets = 10) {
    if (arr.length === 0) return [];
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const range = max - min || 1;
    const bucketSize = range / buckets;

    const hist = new Array(buckets).fill(0);
    arr.forEach(val => {
        const idx = Math.min(Math.floor((val - min) / bucketSize), buckets - 1);
        hist[idx]++;
    });

    return hist.map((count, i) => ({
        range: `${(min + i * bucketSize).toFixed(1)}-${(min + (i + 1) * bucketSize).toFixed(1)}`,
        count,
        pct: ((count / arr.length) * 100).toFixed(1)
    }));
}

function formatTable(headers, rows, columnWidths) {
    const sep = columnWidths.map(w => '-'.repeat(w)).join('-+-');
    const header = headers.map((h, i) => h.padEnd(columnWidths[i])).join(' | ');
    const body = rows.map(row =>
        row.map((cell, i) => String(cell).padEnd(columnWidths[i])).join(' | ')
    ).join('\n');
    return `${header}\n${sep}\n${body}`;
}

// ============================================================================
// MAIN ANALYSIS CLASS
// ============================================================================
class DatasetAnalyzer {
    constructor(targetDirs) {
        // Accept single path or array of paths
        this.targetDirs = Array.isArray(targetDirs) ? targetDirs : [targetDirs];
        this.data = [];
        this.stats = {};
        this.sources = []; // Track which directories contributed data
    }

    loadData() {
        console.error(`\n🔍 Scanning ${this.targetDirs.length} director${this.targetDirs.length > 1 ? 'ies' : 'y'}...`);

        for (const targetDir of this.targetDirs) {
            const files = findJsonFiles(targetDir);
            console.error(`   ${targetDir}: ${files.length} JSON files`);

            let loadedCount = 0;
            for (const filePath of files) {
                try {
                    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    // Validate essential fields exist
                    if (content.metrics && content.meta) {
                        this.data.push({
                            ...content,
                            _filePath: filePath,
                            _filename: path.basename(filePath, '.json'),
                            _sourceDir: targetDir
                        });
                        loadedCount++;
                    }
                } catch (err) {
                    console.error(`   ⚠️ Skipped ${path.basename(filePath)}: ${err.message}`);
                }
            }

            if (loadedCount > 0) {
                this.sources.push({ directory: targetDir, count: loadedCount });
            }
        }

        console.error(`   Total: ${this.data.length} valid JSON files\n`);

        if (this.data.length === 0) {
            console.error('❌ No valid JSON files found in any directory.');
            process.exit(1);
        }

        return this;
    }

    analyze() {
        const s = this.stats;

        // ========== METADATA ==========
        s.meta = {
            timestamp: new Date().toISOString(),
            config_id: ACTIVE_CONFIG.batch_id,
            sources: this.sources,
            totalDirectories: this.targetDirs.length
        };

        // ========== BASIC COUNTS ==========
        s.totalImages = this.data.length;

        // ========== PASS/FAIL ANALYSIS ==========
        s.validation = this.analyzeValidation();

        // ========== DNA PROFILE ANALYSIS ==========
        s.dna = this.analyzeDNA();

        // ========== ARCHETYPE DISTRIBUTION ==========
        s.archetypes = this.analyzeArchetypes();

        // ========== COLOR ANALYSIS ==========
        s.colors = this.analyzeColors();

        // ========== FIDELITY METRICS ==========
        s.fidelity = this.analyzeFidelity();

        // ========== PHYSICAL FEASIBILITY ==========
        s.physical = this.analyzePhysical();

        // ========== TIMING ANALYSIS ==========
        s.timing = this.analyzeTiming();

        // ========== OUTLIERS & EDGE CASES ==========
        s.outliers = this.findOutliers();

        // ========== PER-IMAGE DETAILS ==========
        s.perImage = this.getPerImageDetails();

        return this;
    }

    analyzeValidation() {
        const cfg = ACTIVE_CONFIG;
        const phys = cfg.physical_constraints;

        const results = {
            config_id: cfg.batch_id,
            description: cfg.description,
            physical_constraints: phys,
            archetype_thresholds: {},
            passed: [],
            failed: [],
            byReason: {
                integrity: [],
                revelation: [],
                stack: [],
                deltaE: [],
                saliencyLoss: []
            },
            details: []
        };

        for (const item of this.data) {
            const m = item.metrics;
            const archetype = item.configuration?.meta?.archetype || 'Unknown';
            const thresholds = getArchetypeThresholds(archetype);

            // Store archetype thresholds for report
            if (!results.archetype_thresholds[archetype]) {
                results.archetype_thresholds[archetype] = thresholds;
            }

            // Extract metrics
            const integrity = parseFloat(m.physical_feasibility?.integrityScore || 0);
            const revelation = m.feature_preservation?.revelationScore || 0;
            const stack = m.physical_feasibility?.maxInkStack || 1;
            const avgDeltaE = m.global_fidelity?.avgDeltaE || 0;
            const saliencyLoss = m.feature_preservation?.saliencyLoss || 0;

            const failures = [];

            // Physical: Integrity check
            const minIntegrity = phys.require_100_integrity ? 100 : (phys.min_integrity || 60);
            if (integrity < minIntegrity) {
                failures.push(`Integrity ${integrity.toFixed(1)} < ${minIntegrity}`);
                results.byReason.integrity.push(item._filename);
            }

            // Physical: Stack check
            if (stack > phys.max_ink_stack) {
                failures.push(`Stack ${stack} > ${phys.max_ink_stack}`);
                results.byReason.stack.push(item._filename);
            }

            // Physical: Saliency loss check (if configured)
            if (phys.max_saliency_loss !== null && saliencyLoss > phys.max_saliency_loss) {
                failures.push(`SaliencyLoss ${saliencyLoss.toFixed(1)} > ${phys.max_saliency_loss}`);
                results.byReason.saliencyLoss.push(item._filename);
            }

            // Archetype-specific: RevScore check
            if (thresholds.revscore_floor !== null && revelation < thresholds.revscore_floor) {
                failures.push(`RevScore ${revelation.toFixed(1)} < ${thresholds.revscore_floor} (${archetype})`);
                results.byReason.revelation.push(item._filename);
            }

            // Archetype-specific: DeltaE check
            if (thresholds.delta_e_ceiling !== null && avgDeltaE > thresholds.delta_e_ceiling) {
                failures.push(`AvgΔE ${avgDeltaE.toFixed(1)} > ${thresholds.delta_e_ceiling} (${archetype})`);
                results.byReason.deltaE.push(item._filename);
            }

            const passed = failures.length === 0;

            results.details.push({
                filename: item._filename,
                archetype,
                passed,
                failures,
                metrics: { integrity, revelation, stack, avgDeltaE, saliencyLoss },
                thresholds_applied: thresholds
            });

            if (passed) {
                results.passed.push(item._filename);
            } else {
                results.failed.push({
                    filename: item._filename,
                    archetype,
                    reasons: failures,
                    integrity,
                    revelation,
                    stack,
                    avgDeltaE
                });
            }
        }

        results.passRate = ((results.passed.length / this.data.length) * 100).toFixed(1);
        results.summary = `${results.passed.length}/${this.data.length} (${results.passRate}%)`;

        return results;
    }

    analyzeDNA() {
        const vals = {
            l: [], c: [], k: [], maxC: [], minL: [], maxL: [], l_std_dev: []
        };

        for (const item of this.data) {
            const dna = item.dna || {};
            if (dna.l !== undefined) vals.l.push(dna.l);
            if (dna.c !== undefined) vals.c.push(dna.c);
            if (dna.k !== undefined) vals.k.push(dna.k);
            if (dna.maxC !== undefined) vals.maxC.push(dna.maxC);
            if (dna.minL !== undefined) vals.minL.push(dna.minL);
            if (dna.maxL !== undefined) vals.maxL.push(dna.maxL);
            if (dna.l_std_dev !== undefined) vals.l_std_dev.push(dna.l_std_dev);
        }

        const result = {};
        for (const [key, arr] of Object.entries(vals)) {
            if (arr.length > 0) {
                result[key] = {
                    min: Math.min(...arr).toFixed(1),
                    max: Math.max(...arr).toFixed(1),
                    mean: (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1),
                    median: median(arr).toFixed(1),
                    stdDev: stdDev(arr).toFixed(1)
                };
            }
        }

        return result;
    }

    analyzeArchetypes() {
        const counts = {};
        const metrics = {};

        for (const item of this.data) {
            const arch = item.configuration?.meta?.archetype || 'Unknown';
            if (!counts[arch]) {
                counts[arch] = 0;
                metrics[arch] = { deltaE: [], revScore: [], colors: [] };
            }
            counts[arch]++;

            metrics[arch].deltaE.push(item.metrics.global_fidelity?.avgDeltaE || 0);
            metrics[arch].revScore.push(item.metrics.feature_preservation?.revelationScore || 0);
            metrics[arch].colors.push(item.palette?.length || 0);
        }

        const result = {};
        for (const [arch, count] of Object.entries(counts)) {
            const m = metrics[arch];
            result[arch] = {
                count,
                pct: ((count / this.data.length) * 100).toFixed(1),
                avgDeltaE: (m.deltaE.reduce((a, b) => a + b, 0) / count).toFixed(1),
                avgRevScore: (m.revScore.reduce((a, b) => a + b, 0) / count).toFixed(1),
                avgColors: (m.colors.reduce((a, b) => a + b, 0) / count).toFixed(1)
            };
        }

        return result;
    }

    analyzeColors() {
        const colorCounts = [];
        const coverageByColor = {};
        const allHexColors = [];

        for (const item of this.data) {
            const palette = item.palette || [];
            colorCounts.push(palette.length);

            for (const ink of palette) {
                const hex = ink.hex?.toLowerCase();
                if (hex) {
                    allHexColors.push(hex);
                    if (!coverageByColor[hex]) coverageByColor[hex] = [];
                    const cov = parseFloat(ink.coverage?.replace('%', '') || 0);
                    coverageByColor[hex].push(cov);
                }
            }
        }

        // Find most common colors
        const colorFreq = {};
        allHexColors.forEach(hex => { colorFreq[hex] = (colorFreq[hex] || 0) + 1; });
        const topColors = Object.entries(colorFreq)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([hex, count]) => ({
                hex,
                count,
                avgCoverage: (coverageByColor[hex].reduce((a, b) => a + b, 0) / coverageByColor[hex].length).toFixed(1) + '%'
            }));

        // Color count distribution
        const countDist = {};
        colorCounts.forEach(c => { countDist[c] = (countDist[c] || 0) + 1; });

        return {
            distribution: Object.entries(countDist)
                .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
                .map(([count, num]) => ({
                    colors: parseInt(count),
                    images: num,
                    pct: ((num / this.data.length) * 100).toFixed(1)
                })),
            stats: {
                min: Math.min(...colorCounts),
                max: Math.max(...colorCounts),
                mean: (colorCounts.reduce((a, b) => a + b, 0) / colorCounts.length).toFixed(1),
                median: median(colorCounts).toFixed(1)
            },
            topColors,
            blackWhiteUsage: {
                black: colorFreq['#000000'] || 0,
                white: colorFreq['#ffffff'] || 0,
                pctWithBlack: (((colorFreq['#000000'] || 0) / this.data.length) * 100).toFixed(1),
                pctWithWhite: (((colorFreq['#ffffff'] || 0) / this.data.length) * 100).toFixed(1)
            }
        };
    }

    analyzeFidelity() {
        const avgDeltaE = [];
        const maxDeltaE = [];
        const revScores = [];
        const saliencyLoss = [];

        for (const item of this.data) {
            const gf = item.metrics.global_fidelity || {};
            const fp = item.metrics.feature_preservation || {};

            if (gf.avgDeltaE !== undefined) avgDeltaE.push(gf.avgDeltaE);
            if (gf.maxDeltaE !== undefined) maxDeltaE.push(gf.maxDeltaE);
            if (fp.revelationScore !== undefined) revScores.push(fp.revelationScore);
            if (fp.saliencyLoss !== undefined) saliencyLoss.push(fp.saliencyLoss);
        }

        return {
            avgDeltaE: {
                min: Math.min(...avgDeltaE).toFixed(1),
                max: Math.max(...avgDeltaE).toFixed(1),
                mean: (avgDeltaE.reduce((a, b) => a + b, 0) / avgDeltaE.length).toFixed(1),
                median: median(avgDeltaE).toFixed(1),
                p90: percentile(avgDeltaE, 90).toFixed(1)
            },
            maxDeltaE: {
                min: Math.min(...maxDeltaE).toFixed(1),
                max: Math.max(...maxDeltaE).toFixed(1),
                mean: (maxDeltaE.reduce((a, b) => a + b, 0) / maxDeltaE.length).toFixed(1),
                median: median(maxDeltaE).toFixed(1)
            },
            revelationScore: {
                min: Math.min(...revScores).toFixed(1),
                max: Math.max(...revScores).toFixed(1),
                mean: (revScores.reduce((a, b) => a + b, 0) / revScores.length).toFixed(1),
                median: median(revScores).toFixed(1),
                histogram: histogram(revScores, 5)
            },
            saliencyLoss: saliencyLoss.length > 0 ? {
                min: Math.min(...saliencyLoss).toFixed(1),
                max: Math.max(...saliencyLoss).toFixed(1),
                mean: (saliencyLoss.reduce((a, b) => a + b, 0) / saliencyLoss.length).toFixed(1)
            } : null
        };
    }

    analyzePhysical() {
        const integrity = [];
        const densityIntegrity = [];
        const breaches = [];
        const maxStack = [];

        for (const item of this.data) {
            const pf = item.metrics.physical_feasibility || {};
            if (pf.integrityScore !== undefined) integrity.push(parseFloat(pf.integrityScore));
            if (pf.densityIntegrity !== undefined) densityIntegrity.push(pf.densityIntegrity);
            if (pf.densityFloorBreaches !== undefined) breaches.push(pf.densityFloorBreaches);
            if (pf.maxInkStack !== undefined) maxStack.push(pf.maxInkStack);
        }

        // Weakest plate analysis
        const weakestPlates = {};
        for (const item of this.data) {
            const wp = item.metrics.physical_feasibility?.weakestPlate || 'Unknown';
            weakestPlates[wp] = (weakestPlates[wp] || 0) + 1;
        }

        return {
            integrityScore: integrity.length > 0 ? {
                min: Math.min(...integrity).toFixed(1),
                max: Math.max(...integrity).toFixed(1),
                mean: (integrity.reduce((a, b) => a + b, 0) / integrity.length).toFixed(1),
                allPassing: integrity.every(i => i >= (ACTIVE_CONFIG.physical_constraints.require_100_integrity ? 100 : ACTIVE_CONFIG.physical_constraints.min_integrity))
            } : null,
            densityIntegrity: densityIntegrity.length > 0 ? {
                min: Math.min(...densityIntegrity).toFixed(1),
                max: Math.max(...densityIntegrity).toFixed(1),
                mean: (densityIntegrity.reduce((a, b) => a + b, 0) / densityIntegrity.length).toFixed(1)
            } : null,
            breaches: breaches.length > 0 ? {
                min: Math.min(...breaches),
                max: Math.max(...breaches),
                mean: Math.round(breaches.reduce((a, b) => a + b, 0) / breaches.length),
                total: breaches.reduce((a, b) => a + b, 0)
            } : null,
            maxInkStack: maxStack.length > 0 ? {
                min: Math.min(...maxStack),
                max: Math.max(...maxStack),
                mean: (maxStack.reduce((a, b) => a + b, 0) / maxStack.length).toFixed(1)
            } : null,
            weakestPlates: Object.entries(weakestPlates)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([plate, count]) => ({ plate, count }))
        };
    }

    analyzeTiming() {
        const compute = [];
        const io = [];
        const total = [];

        for (const item of this.data) {
            const t = item.timing || {};
            if (t.computeTimeMs !== undefined) compute.push(t.computeTimeMs);
            if (t.ioTimeMs !== undefined) io.push(t.ioTimeMs);
            if (t.totalMs !== undefined) total.push(t.totalMs);
        }

        const formatMs = (arr) => arr.length > 0 ? {
            min: `${(Math.min(...arr) / 1000).toFixed(1)}s`,
            max: `${(Math.max(...arr) / 1000).toFixed(1)}s`,
            mean: `${((arr.reduce((a, b) => a + b, 0) / arr.length) / 1000).toFixed(1)}s`,
            total: `${(arr.reduce((a, b) => a + b, 0) / 1000 / 60).toFixed(1)}min`
        } : null;

        return {
            compute: formatMs(compute),
            io: formatMs(io),
            total: formatMs(total),
            efficiency: total.length > 0 && compute.length > 0 ? {
                computeRatio: ((compute.reduce((a, b) => a + b, 0) / total.reduce((a, b) => a + b, 0)) * 100).toFixed(1) + '%'
            } : null
        };
    }

    findOutliers() {
        let highestDeltaE = { val: 0, file: '' };
        let lowestRevScore = { val: Infinity, file: '' };
        let worstIntegrity = { val: Infinity, file: '' };
        let slowest = { val: 0, file: '' };
        let mostColors = { val: 0, file: '' };
        let fewestColors = { val: Infinity, file: '' };

        for (const item of this.data) {
            const m = item.metrics;
            const filename = item._filename;

            if ((m.global_fidelity?.maxDeltaE || 0) > highestDeltaE.val) {
                highestDeltaE = { val: m.global_fidelity.maxDeltaE, file: filename };
            }
            if ((m.feature_preservation?.revelationScore ?? Infinity) < lowestRevScore.val) {
                lowestRevScore = { val: m.feature_preservation.revelationScore, file: filename };
            }
            if ((parseFloat(m.physical_feasibility?.integrityScore) ?? Infinity) < worstIntegrity.val) {
                worstIntegrity = { val: parseFloat(m.physical_feasibility.integrityScore), file: filename };
            }
            if ((item.timing?.totalMs || 0) > slowest.val) {
                slowest = { val: item.timing.totalMs, file: filename };
            }

            const colorCount = item.palette?.length || 0;
            if (colorCount > mostColors.val) {
                mostColors = { val: colorCount, file: filename };
            }
            if (colorCount < fewestColors.val && colorCount > 0) {
                fewestColors = { val: colorCount, file: filename };
            }
        }

        return {
            highestDeltaE: { ...highestDeltaE, val: highestDeltaE.val.toFixed(1) },
            lowestRevScore: { ...lowestRevScore, val: lowestRevScore.val.toFixed(1) },
            worstIntegrity: { ...worstIntegrity, val: worstIntegrity.val.toFixed(1) },
            slowestProcess: { ...slowest, val: `${(slowest.val / 1000).toFixed(1)}s` },
            mostColors,
            fewestColors
        };
    }

    getPerImageDetails() {
        // Use validation details which already computed pass/fail
        const validationMap = {};
        this.stats.validation.details.forEach(d => {
            validationMap[d.filename] = d.passed;
        });

        return this.data.map(item => {
            const m = item.metrics;
            const integrity = parseFloat(m.physical_feasibility?.integrityScore || 0);
            const revelation = m.feature_preservation?.revelationScore || 0;

            return {
                filename: item._filename,
                archetype: item.configuration?.meta?.archetype || 'Unknown',
                colors: item.palette?.length || 0,
                avgDeltaE: (m.global_fidelity?.avgDeltaE || 0).toFixed(1),
                revScore: revelation.toFixed(1),
                integrity: integrity.toFixed(1),
                densityIntegrity: (m.physical_feasibility?.densityIntegrity || 0).toFixed(1),
                saliencyLoss: (m.feature_preservation?.saliencyLoss || 0).toFixed(1),
                timeMs: item.timing?.totalMs || 0,
                pass: validationMap[item._filename] ?? false
            };
        }).sort((a, b) => parseFloat(b.revScore) - parseFloat(a.revScore));
    }

    printReport() {
        const s = this.stats;
        const hr = '='.repeat(70);
        const hr2 = '-'.repeat(70);

        console.log(`\n${hr}`);
        console.log(`POSTERIZATION DATASET ANALYSIS REPORT`);
        console.log(`${hr}`);
        console.log(`Generated: ${s.meta.timestamp}`);
        console.log(`Config: ${s.meta.config_id}`);
        console.log(`Total Images: ${s.totalImages}`);
        console.log();
        console.log(`Sources (${s.meta.sources.length}):`);
        s.meta.sources.forEach(src => {
            console.log(`  - ${src.directory}: ${src.count} files`);
        });
        console.log();

        // VALIDATION SUMMARY
        console.log(`${hr}`);
        console.log(`VALIDATION SUMMARY`);
        console.log(`${hr}`);
        console.log(`Pass Rate: ${s.validation.summary}`);
        console.log();

        // Physical constraints
        const phys = s.validation.physical_constraints;
        console.log(`Physical Constraints:`);
        console.log(`  Integrity: ${phys.require_100_integrity ? '= 100' : `≥ ${phys.min_integrity}`}`);
        console.log(`  Max Ink Stack: ≤ ${phys.max_ink_stack}`);
        if (phys.max_saliency_loss !== null) {
            console.log(`  Max Saliency Loss: ≤ ${phys.max_saliency_loss}`);
        }
        console.log();

        // Per-archetype thresholds
        console.log(`Archetype Thresholds:`);
        Object.entries(s.validation.archetype_thresholds).forEach(([arch, th]) => {
            const revStr = th.revscore_floor !== null ? `RevScore ≥ ${th.revscore_floor}` : 'RevScore: any';
            const deStr = th.delta_e_ceiling !== null ? `ΔE ≤ ${th.delta_e_ceiling}` : 'ΔE: any';
            console.log(`  ${arch}: ${revStr}, ${deStr}`);
        });
        console.log();

        if (s.validation.failed.length > 0) {
            console.log(`FAILURES (${s.validation.failed.length}):`);
            s.validation.failed.forEach(f => {
                console.log(`  ✗ [${f.archetype}] ${f.filename}:`);
                f.reasons.forEach(r => console.log(`      - ${r}`));
            });
            console.log();
        }

        // ARCHETYPE DISTRIBUTION
        console.log(`${hr}`);
        console.log(`ARCHETYPE DISTRIBUTION`);
        console.log(`${hr}`);
        const archRows = Object.entries(s.archetypes).map(([arch, data]) => [
            arch, data.count, data.pct + '%', data.avgDeltaE, data.avgRevScore, data.avgColors
        ]);
        console.log(formatTable(
            ['Archetype', 'Count', 'Pct', 'AvgΔE', 'AvgRev', 'AvgColors'],
            archRows,
            [18, 6, 6, 8, 8, 10]
        ));
        console.log();

        // COLOR ANALYSIS
        console.log(`${hr}`);
        console.log(`COLOR PALETTE ANALYSIS`);
        console.log(`${hr}`);
        console.log(`Color Count: min=${s.colors.stats.min}, max=${s.colors.stats.max}, mean=${s.colors.stats.mean}, median=${s.colors.stats.median}`);
        console.log(`Black Usage: ${s.colors.blackWhiteUsage.pctWithBlack}% of images`);
        console.log(`White Usage: ${s.colors.blackWhiteUsage.pctWithWhite}% of images`);
        console.log();
        console.log(`Distribution:`);
        s.colors.distribution.forEach(d => {
            const bar = '█'.repeat(Math.round(parseFloat(d.pct) / 5)) || '▏';
            console.log(`  ${d.colors} colors: ${d.images.toString().padStart(3)} images (${d.pct.padStart(5)}%) ${bar}`);
        });
        console.log();

        // FIDELITY METRICS
        console.log(`${hr}`);
        console.log(`FIDELITY METRICS`);
        console.log(`${hr}`);
        console.log(`Average ΔE: min=${s.fidelity.avgDeltaE.min}, max=${s.fidelity.avgDeltaE.max}, mean=${s.fidelity.avgDeltaE.mean}, P90=${s.fidelity.avgDeltaE.p90}`);
        console.log(`Max ΔE:     min=${s.fidelity.maxDeltaE.min}, max=${s.fidelity.maxDeltaE.max}, mean=${s.fidelity.maxDeltaE.mean}`);
        console.log(`RevScore:   min=${s.fidelity.revelationScore.min}, max=${s.fidelity.revelationScore.max}, mean=${s.fidelity.revelationScore.mean}`);
        if (s.fidelity.saliencyLoss) {
            console.log(`SaliencyLoss: min=${s.fidelity.saliencyLoss.min}, max=${s.fidelity.saliencyLoss.max}, mean=${s.fidelity.saliencyLoss.mean}`);
        }
        console.log();
        console.log(`RevScore Distribution:`);
        s.fidelity.revelationScore.histogram.forEach(h => {
            const bar = '█'.repeat(Math.round(parseFloat(h.pct) / 5)) || '▏';
            console.log(`  ${h.range.padEnd(12)}: ${h.count.toString().padStart(3)} (${h.pct.padStart(5)}%) ${bar}`);
        });
        console.log();

        // PHYSICAL FEASIBILITY
        console.log(`${hr}`);
        console.log(`PHYSICAL FEASIBILITY`);
        console.log(`${hr}`);
        if (s.physical.integrityScore) {
            console.log(`Integrity: min=${s.physical.integrityScore.min}, max=${s.physical.integrityScore.max}, mean=${s.physical.integrityScore.mean}`);
        }
        if (s.physical.densityIntegrity) {
            console.log(`Density Integrity: min=${s.physical.densityIntegrity.min}, max=${s.physical.densityIntegrity.max}, mean=${s.physical.densityIntegrity.mean}`);
        }
        if (s.physical.maxInkStack) {
            console.log(`Max Ink Stack: min=${s.physical.maxInkStack.min}, max=${s.physical.maxInkStack.max}, mean=${s.physical.maxInkStack.mean}`);
        }
        if (s.physical.weakestPlates?.length > 0) {
            console.log(`Top Weakest Plates:`);
            s.physical.weakestPlates.forEach(wp => {
                console.log(`  ${wp.plate}: ${wp.count} times`);
            });
        }
        console.log();

        // DNA PROFILE
        console.log(`${hr}`);
        console.log(`IMAGE DNA PROFILE`);
        console.log(`${hr}`);
        const dnaFields = ['l', 'c', 'k', 'maxC', 'l_std_dev'];
        const dnaLabels = {
            l: 'Lightness (L)',
            c: 'Chroma (C)',
            k: 'Contrast (K)',
            maxC: 'Max Chroma',
            l_std_dev: 'L Std Dev'
        };
        dnaFields.forEach(field => {
            if (s.dna[field]) {
                const d = s.dna[field];
                console.log(`${dnaLabels[field].padEnd(15)}: min=${d.min.padStart(6)}, max=${d.max.padStart(6)}, mean=${d.mean.padStart(6)}, stdDev=${d.stdDev.padStart(6)}`);
            }
        });
        console.log();

        // TIMING
        console.log(`${hr}`);
        console.log(`PROCESSING TIME`);
        console.log(`${hr}`);
        if (s.timing.total) {
            console.log(`Total Time: min=${s.timing.total.min}, max=${s.timing.total.max}, mean=${s.timing.total.mean}`);
            console.log(`Batch Total: ${s.timing.total.total}`);
        }
        if (s.timing.compute) {
            console.log(`Compute Time: min=${s.timing.compute.min}, max=${s.timing.compute.max}, mean=${s.timing.compute.mean}`);
        }
        if (s.timing.efficiency) {
            console.log(`Compute/Total Ratio: ${s.timing.efficiency.computeRatio}`);
        }
        console.log();

        // OUTLIERS
        console.log(`${hr}`);
        console.log(`OUTLIERS & EDGE CASES`);
        console.log(`${hr}`);
        console.log(`Highest ΔE:       ${s.outliers.highestDeltaE.val} (${s.outliers.highestDeltaE.file})`);
        console.log(`Lowest RevScore:  ${s.outliers.lowestRevScore.val} (${s.outliers.lowestRevScore.file})`);
        console.log(`Worst Integrity:  ${s.outliers.worstIntegrity.val} (${s.outliers.worstIntegrity.file})`);
        console.log(`Slowest Process:  ${s.outliers.slowestProcess.val} (${s.outliers.slowestProcess.file})`);
        console.log(`Most Colors:      ${s.outliers.mostColors.val} (${s.outliers.mostColors.file})`);
        console.log(`Fewest Colors:    ${s.outliers.fewestColors.val} (${s.outliers.fewestColors.file})`);
        console.log();

        // PER-IMAGE TABLE
        console.log(`${hr}`);
        console.log(`PER-IMAGE DETAILS (sorted by RevScore)`);
        console.log(`${hr}`);
        const imgRows = s.perImage.map(img => [
            img.pass ? '✓' : '✗',
            img.filename.substring(0, 22),
            img.archetype.substring(0, 12),
            img.colors,
            img.avgDeltaE,
            img.revScore,
            img.integrity,
            img.saliencyLoss
        ]);
        console.log(formatTable(
            ['P', 'Filename', 'Archetype', 'Clr', 'AvgΔE', 'RevSc', 'Integ', 'SalLoss'],
            imgRows,
            [1, 22, 12, 3, 6, 6, 6, 7]
        ));
        console.log();

        // FINAL SUMMARY
        console.log(`${hr}`);
        const passIcon = s.validation.passed.length === s.totalImages ? '✅' : '⚠️';
        console.log(`${passIcon} FINAL: ${s.validation.summary} passing`);
        console.log(`${hr}\n`);
    }

    toJSON() {
        return JSON.stringify(this.stats, null, 2);
    }
}

// ============================================================================
// CLI
// ============================================================================
function printUsage() {
    console.error(`
Usage: node analyzeDataset.js [paths...] [options]

Arguments:
  paths             One or more directories containing (Lab PSD, JSON) pairs
                    If not specified, defaults to data/SP100/output

Options:
  --config=<file>   Load validation thresholds from JSON config file
  --json            Output results as JSON instead of formatted report
  --output=<file>   Write JSON output to file (implies --json)
  --help            Show this help message

Examples:
  node scripts/analyzeDataset.js data/SP100/output/loc/psd
  node scripts/analyzeDataset.js dir1 dir2 dir3 --config=config.json
  node scripts/analyzeDataset.js data/SP100/output --json --output=analysis.json
`);
}

function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help')) {
        printUsage();
        process.exit(0);
    }

    const jsonMode = args.includes('--json');
    const configArg = args.find(a => a.startsWith('--config='));
    const outputArg = args.find(a => a.startsWith('--output='));
    const pathArgs = args.filter(a => !a.startsWith('--'));

    // Load config file if specified
    if (configArg) {
        const configPath = configArg.split('=')[1];
        ACTIVE_CONFIG = loadConfig(path.resolve(configPath));
        console.error(`📋 Loaded config: ${ACTIVE_CONFIG.batch_id}\n`);
    }

    // Collect directories (default if none specified)
    const defaultPath = path.join(__dirname, '../data/SP100/output');
    const targetDirs = pathArgs.length > 0
        ? pathArgs.map(p => path.resolve(p))
        : [defaultPath];

    // Analyze all directories
    const analyzer = new DatasetAnalyzer(targetDirs);
    analyzer.loadData().analyze();

    // Output handling
    const writeJson = jsonMode || outputArg;

    if (outputArg) {
        const outputPath = outputArg.split('=')[1];
        fs.writeFileSync(path.resolve(outputPath), analyzer.toJSON());
        console.error(`✅ Analysis written to: ${outputPath}`);
    }

    if (jsonMode) {
        console.log(analyzer.toJSON());
    } else if (!outputArg) {
        analyzer.printReport();
    }
}

main();
