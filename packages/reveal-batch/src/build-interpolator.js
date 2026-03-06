#!/usr/bin/env node
/**
 * build-interpolator.js — Build cluster model and validate interpolation
 *
 * 1. Loads harvested DNA vectors
 * 2. Runs K-means clustering in 7D space
 * 3. For each cluster, loads the dominant archetype's parameters
 * 4. Builds the interpolator model
 * 5. Validates: runs interpolation on all 287 images, compares to current system
 */

const fs = require('fs');
const path = require('path');
const { InterpolatorEngine, DIM_KEYS, CONTINUOUS_PARAMS, ORDERED_ENUMS, CATEGORICAL_PARAMS } = require('./InterpolatorEngine');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const ARCHETYPE_DIR = path.resolve(__dirname, '..', '..', 'reveal-core', 'archetypes');
const HARVEST_PATH = path.join(DATA_DIR, 'dna-harvest.json');

const DEFAULT_K = 12;
const DEFAULT_NEIGHBORS = 3;
const KMEANS_RESTARTS = 15;
const KMEANS_MAX_ITER = 150;

// ---------------------------------------------------------------------------
// K-means (copy from cluster-explore — could be shared module later)
// ---------------------------------------------------------------------------

function euclideanSq(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
    return sum;
}

function kmeansppInit(vectors, k) {
    const n = vectors.length;
    const centroids = [];
    const first = Math.floor(Math.random() * n);
    centroids.push(Float64Array.from(vectors[first]));
    const minDist = new Float64Array(n).fill(Infinity);

    for (let c = 1; c < k; c++) {
        const last = centroids[c - 1];
        for (let i = 0; i < n; i++) {
            const d = euclideanSq(vectors[i], last);
            if (d < minDist[i]) minDist[i] = d;
        }
        let total = 0;
        for (let i = 0; i < n; i++) total += minDist[i];
        let target = Math.random() * total;
        let sel = 0;
        for (let i = 0; i < n; i++) { target -= minDist[i]; if (target <= 0) { sel = i; break; } }
        centroids.push(Float64Array.from(vectors[sel]));
    }
    return centroids;
}

function kmeans(vectors, k) {
    const n = vectors.length;
    const dims = vectors[0].length;
    let bestLabels = null, bestInertia = Infinity, bestCentroids = null;

    for (let r = 0; r < KMEANS_RESTARTS; r++) {
        const centroids = kmeansppInit(vectors, k);
        const labels = new Int32Array(n);

        for (let iter = 0; iter < KMEANS_MAX_ITER; iter++) {
            let changed = false;
            for (let i = 0; i < n; i++) {
                let best = 0, bestDist = euclideanSq(vectors[i], centroids[0]);
                for (let c = 1; c < k; c++) {
                    const d = euclideanSq(vectors[i], centroids[c]);
                    if (d < bestDist) { bestDist = d; best = c; }
                }
                if (labels[i] !== best) { labels[i] = best; changed = true; }
            }
            if (!changed && iter > 0) break;

            const counts = new Int32Array(k);
            for (let c = 0; c < k; c++) for (let d = 0; d < dims; d++) centroids[c][d] = 0;
            for (let i = 0; i < n; i++) {
                counts[labels[i]]++;
                for (let d = 0; d < dims; d++) centroids[labels[i]][d] += vectors[i][d];
            }
            for (let c = 0; c < k; c++) {
                if (counts[c] > 0) for (let d = 0; d < dims; d++) centroids[c][d] /= counts[c];
            }
        }

        let inertia = 0;
        for (let i = 0; i < n; i++) inertia += euclideanSq(vectors[i], centroids[labels[i]]);
        if (inertia < bestInertia) {
            bestInertia = inertia;
            bestLabels = labels.slice();
            bestCentroids = centroids.map(c => Float64Array.from(c));
        }
    }

    return { labels: bestLabels, centroids: bestCentroids, inertia: bestInertia };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function zNormalize(vectors) {
    const n = vectors.length;
    const dims = vectors[0].length;
    const mean = new Float64Array(dims);
    const std = new Float64Array(dims);

    for (let i = 0; i < n; i++) for (let d = 0; d < dims; d++) mean[d] += vectors[i][d];
    for (let d = 0; d < dims; d++) mean[d] /= n;

    for (let i = 0; i < n; i++) for (let d = 0; d < dims; d++) { const diff = vectors[i][d] - mean[d]; std[d] += diff * diff; }
    for (let d = 0; d < dims; d++) { std[d] = Math.sqrt(std[d] / n); if (std[d] < 1e-10) std[d] = 1; }

    const normalized = vectors.map(v => {
        const nv = new Float64Array(dims);
        for (let d = 0; d < dims; d++) nv[d] = (v[d] - mean[d]) / std[d];
        return nv;
    });

    return { normalized, mean: Array.from(mean), std: Array.from(std) };
}

// ---------------------------------------------------------------------------
// Archetype loader
// ---------------------------------------------------------------------------

function loadArchetypeParams(archetypeId) {
    // Convert snake_case id to kebab-case filename
    const filename = archetypeId.replace(/_/g, '-') + '.json';
    const filePath = path.join(ARCHETYPE_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return data.parameters || null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    const K = parseInt(process.argv[2]) || DEFAULT_K;
    const NEIGHBORS = parseInt(process.argv[3]) || DEFAULT_NEIGHBORS;

    console.log(`Building interpolator model: K=${K}, neighbors=${NEIGHBORS}\n`);

    // Load harvest
    const harvest = JSON.parse(fs.readFileSync(HARVEST_PATH, 'utf-8'));
    const images = harvest.images;
    console.log(`Loaded ${images.length} DNA vectors`);

    // Extract 7D features
    const raw = images.map(img => DIM_KEYS.map(k => img.dna[k]));
    const { normalized, mean, std } = zNormalize(raw);

    // Cluster
    const { labels, centroids, inertia } = kmeans(normalized, K);
    console.log(`K-means converged (inertia: ${inertia.toFixed(1)})`);

    // Build cluster data
    const clusterMembers = Array.from({ length: K }, () => []);
    for (let i = 0; i < images.length; i++) clusterMembers[labels[i]].push(i);

    const clusters = [];
    for (let c = 0; c < K; c++) {
        const members = clusterMembers[c];
        if (members.length === 0) continue;

        // Find dominant archetype
        const archetypeCounts = {};
        for (const idx of members) {
            const a = images[idx].currentArchetype;
            archetypeCounts[a] = (archetypeCounts[a] || 0) + 1;
        }
        const sorted = Object.entries(archetypeCounts).sort((a, b) => b[1] - a[1]);
        const dominantArchetype = sorted[0][0];

        // Compute raw centroid (unnormalized)
        const rawCentroid = {};
        for (let d = 0; d < DIM_KEYS.length; d++) {
            rawCentroid[DIM_KEYS[d]] = +(members.reduce((s, idx) => s + raw[idx][d], 0) / members.length).toFixed(3);
        }

        // Load archetype parameters
        let params = loadArchetypeParams(dominantArchetype);
        if (!params) {
            console.warn(`  WARN: No archetype file for ${dominantArchetype}, using fine_art_scan fallback`);
            params = loadArchetypeParams('fine_art_scan');
        }

        // Find best-quality member for reference
        const bestMember = members.reduce((best, idx) => {
            const score = images[idx].quality.revelationScore || 0;
            return score > (images[best].quality.revelationScore || 0) ? idx : best;
        }, members[0]);

        clusters.push({
            id: c,
            centroid: Array.from(centroids[c]),
            centroidRaw: rawCentroid,
            size: members.length,
            sourceArchetype: dominantArchetype,
            archetypeBreakdown: sorted.map(([name, count]) => ({ archetype: name, count })),
            bestMember: images[bestMember].filename,
            bestRevScore: images[bestMember].quality.revelationScore,
            parameters: params
        });
    }

    // Sort by size descending
    clusters.sort((a, b) => b.size - a.size);

    // Build model
    const model = {
        version: '1.0',
        built: new Date().toISOString(),
        featureSpace: '7d',
        k: clusters.length,
        blendNeighbors: NEIGHBORS,
        normalization: { mean, std },
        clusters
    };

    // Write model
    const modelPath = path.join(DATA_DIR, 'interpolator-model.json');
    fs.writeFileSync(modelPath, JSON.stringify(model, null, 2));
    console.log(`\nModel written to ${path.relative(process.cwd(), modelPath)}`);

    // Print cluster summary
    console.log(`\n${'─'.repeat(80)}`);
    console.log('CLUSTER SUMMARY');
    console.log(`${'─'.repeat(80)}`);
    for (const cl of clusters) {
        const breakdown = cl.archetypeBreakdown
            .map(a => `${a.archetype}(${a.count})`)
            .join(', ');
        console.log(`  C${String(cl.id).padStart(2)}: ${String(cl.size).padStart(3)} images | source: ${cl.sourceArchetype} | ${breakdown}`);
    }

    // ---------------------------------------------------------------------------
    // Validation: interpolate all 287 images, compare to current
    // ---------------------------------------------------------------------------

    console.log(`\n${'─'.repeat(80)}`);
    console.log('VALIDATION: Interpolated vs. Current Parameters');
    console.log(`${'─'.repeat(80)}\n`);

    const engine = new InterpolatorEngine(model);

    // Track agreement/divergence
    const continuousDiffs = {};
    for (const p of CONTINUOUS_PARAMS) continuousDiffs[p] = [];

    const categoricalAgreement = {};
    for (const p of CATEGORICAL_PARAMS) categoricalAgreement[p] = { agree: 0, disagree: 0 };
    for (const p of Object.keys(ORDERED_ENUMS)) categoricalAgreement[p] = { agree: 0, disagree: 0 };

    const archetypeChanges = { same: 0, different: 0, details: {} };

    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const { parameters: interp, blendInfo } = engine.interpolate(img.dna);
        const currentArchetype = img.currentArchetype;
        const currentParams = loadArchetypeParams(currentArchetype);
        if (!currentParams) continue;

        // Did the dominant neighbor match?
        const interpArchetype = blendInfo.neighbors[0].sourceArchetype;
        if (interpArchetype === currentArchetype) {
            archetypeChanges.same++;
        } else {
            archetypeChanges.different++;
            const key = `${currentArchetype} → ${interpArchetype}`;
            archetypeChanges.details[key] = (archetypeChanges.details[key] || 0) + 1;
        }

        // Continuous diffs
        for (const p of CONTINUOUS_PARAMS) {
            const curr = currentParams[p];
            const intp = interp[p];
            if (curr !== undefined && intp !== undefined) {
                continuousDiffs[p].push(Math.abs(curr - intp));
            }
        }

        // Categorical agreement
        for (const p of CATEGORICAL_PARAMS) {
            if (currentParams[p] === undefined) continue;
            if (interp[p] === currentParams[p]) categoricalAgreement[p].agree++;
            else categoricalAgreement[p].disagree++;
        }
        for (const p of Object.keys(ORDERED_ENUMS)) {
            if (currentParams[p] === undefined) continue;
            const currNorm = p === 'preprocessingIntensity' && currentParams[p] === 'none' ? 'off' : currentParams[p];
            if (interp[p] === currNorm) categoricalAgreement[p].agree++;
            else categoricalAgreement[p].disagree++;
        }
    }

    // Report: archetype agreement
    console.log(`Nearest-cluster archetype agreement:`);
    console.log(`  Same:      ${archetypeChanges.same} (${(archetypeChanges.same / images.length * 100).toFixed(1)}%)`);
    console.log(`  Different: ${archetypeChanges.different} (${(archetypeChanges.different / images.length * 100).toFixed(1)}%)`);
    if (archetypeChanges.different > 0) {
        console.log(`\n  Top transitions:`);
        const transitions = Object.entries(archetypeChanges.details).sort((a, b) => b[1] - a[1]).slice(0, 10);
        for (const [trans, count] of transitions) {
            console.log(`    ${count}× ${trans}`);
        }
    }

    // Report: continuous parameter divergence
    console.log(`\n  Continuous parameter divergence (mean absolute diff):`);
    console.log(`  ${'Param'.padEnd(38)} | ${'MAD'.padStart(8)} | ${'Max'.padStart(8)} | Count`);
    console.log(`  ${'─'.repeat(38)}-|${'─'.repeat(10)}|${'─'.repeat(10)}|${'─'.repeat(6)}`);
    const sortedCont = Object.entries(continuousDiffs)
        .filter(([_, diffs]) => diffs.length > 0)
        .map(([param, diffs]) => ({
            param,
            mad: diffs.reduce((s, d) => s + d, 0) / diffs.length,
            max: Math.max(...diffs),
            count: diffs.length
        }))
        .sort((a, b) => b.mad - a.mad);

    for (const { param, mad, max, count } of sortedCont) {
        console.log(`  ${param.padEnd(38)} | ${mad.toFixed(3).padStart(8)} | ${max.toFixed(3).padStart(8)} | ${String(count).padStart(5)}`);
    }

    // Report: categorical agreement
    console.log(`\n  Categorical/enum parameter agreement:`);
    console.log(`  ${'Param'.padEnd(32)} | ${'Agree'.padStart(6)} | ${'Differ'.padStart(6)} | ${'%'.padStart(6)}`);
    console.log(`  ${'─'.repeat(32)}-|${'─'.repeat(8)}|${'─'.repeat(8)}|${'─'.repeat(8)}`);
    for (const [param, counts] of Object.entries(categoricalAgreement)) {
        const total = counts.agree + counts.disagree;
        if (total === 0) continue;
        const pct = (counts.agree / total * 100).toFixed(1);
        console.log(`  ${param.padEnd(32)} | ${String(counts.agree).padStart(6)} | ${String(counts.disagree).padStart(6)} | ${pct.padStart(5)}%`);
    }

    // Report: example blends
    console.log(`\n${'─'.repeat(80)}`);
    console.log('EXAMPLE BLENDS (first 5 images)');
    console.log(`${'─'.repeat(80)}\n`);

    for (let i = 0; i < 5; i++) {
        const img = images[i];
        const { parameters: interp, blendInfo } = engine.interpolate(img.dna);
        const currentParams = loadArchetypeParams(img.currentArchetype);

        console.log(`  ${img.filename} (${img.dataset})`);
        console.log(`    Current archetype: ${img.currentArchetype}`);
        console.log(`    Blend:`);
        for (const n of blendInfo.neighbors) {
            console.log(`      ${n.sourceArchetype} (d=${n.distance}, w=${(n.weight * 100).toFixed(1)}%)`);
        }

        // Show key param differences
        const keyParams = ['distanceMetric', 'ditherType', 'lWeight', 'cWeight', 'blackBias',
                           'vibrancyMode', 'vibrancyBoost', 'paletteReduction',
                           'shadowClamp', 'minVolume', 'speckleRescue',
                           'minColors', 'maxColors'];
        console.log(`    ${'Param'.padEnd(28)} | ${'Current'.padStart(12)} | ${'Interpolated'.padStart(12)}`);
        for (const p of keyParams) {
            const curr = currentParams ? currentParams[p] : '?';
            const intp = interp[p];
            if (curr === undefined && intp === undefined) continue;
            const marker = curr !== intp ? ' *' : '';
            console.log(`    ${p.padEnd(28)} | ${String(curr ?? '-').padStart(12)} | ${String(intp ?? '-').padStart(12)}${marker}`);
        }
        console.log('');
    }
}

main();
