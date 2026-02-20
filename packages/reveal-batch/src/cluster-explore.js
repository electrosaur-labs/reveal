#!/usr/bin/env node
/**
 * cluster-explore.js — K-means clustering exploration on harvested DNA vectors
 *
 * Runs K-means for K=8..20 on the 287 DNA vectors (7D centroid + 12 sector weights),
 * computes silhouette scores, and compares clusters to current archetype assignments.
 *
 * Pure JS — no external dependencies.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const HARVEST_PATH = path.join(DATA_DIR, 'dna-harvest.json');

// ---------------------------------------------------------------------------
// Feature extraction & normalization
// ---------------------------------------------------------------------------

const DIM_7D = ['l', 'c', 'k', 'l_std_dev', 'hue_entropy', 'temperature_bias', 'primary_sector_weight'];
const SECTORS = ['red', 'orange', 'yellow', 'chartreuse', 'green', 'cyan',
                 'azure', 'blue', 'purple', 'magenta', 'pink', 'rose'];

function extractFeatures(image, mode) {
    const v = [];
    for (const d of DIM_7D) v.push(image.dna[d]);
    if (mode === '19d') {
        for (const s of SECTORS) v.push(image.sectors[s]);
    }
    return v;
}

function zNormalize(vectors) {
    const n = vectors.length;
    const dims = vectors[0].length;
    const mean = new Float64Array(dims);
    const std = new Float64Array(dims);

    // Compute mean
    for (let i = 0; i < n; i++) {
        for (let d = 0; d < dims; d++) mean[d] += vectors[i][d];
    }
    for (let d = 0; d < dims; d++) mean[d] /= n;

    // Compute std dev
    for (let i = 0; i < n; i++) {
        for (let d = 0; d < dims; d++) {
            const diff = vectors[i][d] - mean[d];
            std[d] += diff * diff;
        }
    }
    for (let d = 0; d < dims; d++) {
        std[d] = Math.sqrt(std[d] / n);
        if (std[d] < 1e-10) std[d] = 1; // avoid division by zero for constant dims
    }

    // Normalize
    const normalized = vectors.map(v => {
        const nv = new Float64Array(dims);
        for (let d = 0; d < dims; d++) nv[d] = (v[d] - mean[d]) / std[d];
        return nv;
    });

    return { normalized, mean, std };
}

// ---------------------------------------------------------------------------
// K-means
// ---------------------------------------------------------------------------

function euclideanSq(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return sum;
}

function kmeans(vectors, k, maxIter = 100, restarts = 10) {
    const n = vectors.length;
    const dims = vectors[0].length;
    let bestLabels = null;
    let bestInertia = Infinity;

    for (let r = 0; r < restarts; r++) {
        // K-means++ initialization
        const centroids = kmeansppInit(vectors, k);
        const labels = new Int32Array(n);

        for (let iter = 0; iter < maxIter; iter++) {
            // Assign
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

            // Update centroids
            const counts = new Int32Array(k);
            for (let c = 0; c < k; c++) {
                for (let d = 0; d < dims; d++) centroids[c][d] = 0;
            }
            for (let i = 0; i < n; i++) {
                const c = labels[i];
                counts[c]++;
                for (let d = 0; d < dims; d++) centroids[c][d] += vectors[i][d];
            }
            for (let c = 0; c < k; c++) {
                if (counts[c] > 0) {
                    for (let d = 0; d < dims; d++) centroids[c][d] /= counts[c];
                }
            }
        }

        // Compute inertia
        let inertia = 0;
        for (let i = 0; i < n; i++) {
            inertia += euclideanSq(vectors[i], centroids[labels[i]]);
        }

        if (inertia < bestInertia) {
            bestInertia = inertia;
            bestLabels = labels.slice();
        }
    }

    return { labels: bestLabels, inertia: bestInertia };
}

function kmeansppInit(vectors, k) {
    const n = vectors.length;
    const dims = vectors[0].length;
    const centroids = [];

    // First centroid: random
    const first = Math.floor(Math.random() * n);
    centroids.push(Float64Array.from(vectors[first]));

    const minDist = new Float64Array(n).fill(Infinity);

    for (let c = 1; c < k; c++) {
        // Update min distances to nearest existing centroid
        const lastCentroid = centroids[c - 1];
        for (let i = 0; i < n; i++) {
            const d = euclideanSq(vectors[i], lastCentroid);
            if (d < minDist[i]) minDist[i] = d;
        }

        // Weighted random selection proportional to distance squared
        let totalDist = 0;
        for (let i = 0; i < n; i++) totalDist += minDist[i];

        let target = Math.random() * totalDist;
        let selected = 0;
        for (let i = 0; i < n; i++) {
            target -= minDist[i];
            if (target <= 0) { selected = i; break; }
        }

        centroids.push(Float64Array.from(vectors[selected]));
    }

    return centroids;
}

// ---------------------------------------------------------------------------
// Silhouette score
// ---------------------------------------------------------------------------

function silhouetteScore(vectors, labels) {
    const n = vectors.length;
    const k = Math.max(...labels) + 1;

    // Group indices by cluster
    const clusters = Array.from({ length: k }, () => []);
    for (let i = 0; i < n; i++) clusters[labels[i]].push(i);

    // Skip degenerate cases
    if (clusters.some(c => c.length === 0)) return -1;
    if (k <= 1) return 0;

    let totalSil = 0;

    for (let i = 0; i < n; i++) {
        const myCluster = labels[i];
        if (clusters[myCluster].length === 1) {
            // Singleton cluster — silhouette = 0
            continue;
        }

        // a(i) = mean distance to same-cluster points
        let a = 0;
        for (const j of clusters[myCluster]) {
            if (j !== i) a += Math.sqrt(euclideanSq(vectors[i], vectors[j]));
        }
        a /= (clusters[myCluster].length - 1);

        // b(i) = min mean distance to any other cluster
        let b = Infinity;
        for (let c = 0; c < k; c++) {
            if (c === myCluster || clusters[c].length === 0) continue;
            let meanDist = 0;
            for (const j of clusters[c]) {
                meanDist += Math.sqrt(euclideanSq(vectors[i], vectors[j]));
            }
            meanDist /= clusters[c].length;
            if (meanDist < b) b = meanDist;
        }

        const sil = (b - a) / Math.max(a, b);
        totalSil += sil;
    }

    return totalSil / n;
}

// ---------------------------------------------------------------------------
// Adjusted Rand Index (cluster agreement with archetype labels)
// ---------------------------------------------------------------------------

function adjustedRandIndex(labelsA, labelsB) {
    const n = labelsA.length;
    const maxA = Math.max(...labelsA) + 1;
    const maxB = Math.max(...labelsB) + 1;

    // Contingency table
    const table = Array.from({ length: maxA }, () => new Int32Array(maxB));
    for (let i = 0; i < n; i++) table[labelsA[i]][labelsB[i]]++;

    const rowSums = new Int32Array(maxA);
    const colSums = new Int32Array(maxB);
    for (let a = 0; a < maxA; a++) {
        for (let b = 0; b < maxB; b++) {
            rowSums[a] += table[a][b];
            colSums[b] += table[a][b];
        }
    }

    const comb2 = x => x * (x - 1) / 2;

    let sumNij = 0;
    for (let a = 0; a < maxA; a++) {
        for (let b = 0; b < maxB; b++) sumNij += comb2(table[a][b]);
    }

    let sumAi = 0;
    for (let a = 0; a < maxA; a++) sumAi += comb2(rowSums[a]);

    let sumBj = 0;
    for (let b = 0; b < maxB; b++) sumBj += comb2(colSums[b]);

    const combN = comb2(n);
    const expected = (sumAi * sumBj) / combN;
    const maxIndex = 0.5 * (sumAi + sumBj);
    const denom = maxIndex - expected;

    if (Math.abs(denom) < 1e-10) return 0;
    return (sumNij - expected) / denom;
}

// ---------------------------------------------------------------------------
// Archetype purity: for each cluster, what % is the dominant archetype?
// ---------------------------------------------------------------------------

function clusterPurity(labels, archetypes) {
    const n = labels.length;
    const k = Math.max(...labels) + 1;

    const clusters = Array.from({ length: k }, () => []);
    for (let i = 0; i < n; i++) clusters[labels[i]].push(archetypes[i]);

    let totalCorrect = 0;
    const details = [];

    for (let c = 0; c < k; c++) {
        const counts = {};
        for (const a of clusters[c]) counts[a] = (counts[a] || 0) + 1;
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const dominant = sorted[0];
        totalCorrect += dominant[1];
        details.push({
            cluster: c,
            size: clusters[c].length,
            dominant: dominant[0],
            dominantCount: dominant[1],
            purity: (dominant[1] / clusters[c].length * 100).toFixed(1),
            others: sorted.slice(1).map(([name, cnt]) => `${name}(${cnt})`).join(', ')
        });
    }

    return {
        overallPurity: (totalCorrect / n * 100).toFixed(1),
        clusters: details.sort((a, b) => b.size - a.size)
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    const harvest = JSON.parse(fs.readFileSync(HARVEST_PATH, 'utf-8'));
    const images = harvest.images;
    console.log(`Loaded ${images.length} DNA vectors\n`);

    // Encode archetype labels as integers
    const archetypeNames = [...new Set(images.map(i => i.currentArchetype))].sort();
    const archetypeMap = {};
    archetypeNames.forEach((name, i) => archetypeMap[name] = i);
    const archetypeLabels = images.map(i => archetypeMap[i.currentArchetype]);

    for (const mode of ['7d', '19d']) {
        console.log(`${'='.repeat(70)}`);
        console.log(`  Feature space: ${mode.toUpperCase()} ${mode === '7d' ? '(centroid only)' : '(centroid + 12 sectors)'}`);
        console.log(`${'='.repeat(70)}\n`);

        const raw = images.map(img => extractFeatures(img, mode));
        const { normalized } = zNormalize(raw);

        console.log('  K  | Inertia   | Silhouette | ARI    | Purity | ΔInertia');
        console.log('  ---|-----------|------------|--------|--------|--------');

        let prevInertia = null;
        const results = [];

        for (let k = 6; k <= 22; k++) {
            const { labels, inertia } = kmeans(normalized, k);
            const sil = silhouetteScore(normalized, labels);
            const ari = adjustedRandIndex(labels, archetypeLabels);
            const purity = clusterPurity(labels, images.map(i => i.currentArchetype));
            const deltaInertia = prevInertia ? ((prevInertia - inertia) / prevInertia * 100).toFixed(1) : '   -';
            prevInertia = inertia;

            results.push({ k, inertia, sil, ari, purity, labels });

            console.log(`  ${String(k).padStart(2)} | ${inertia.toFixed(1).padStart(9)} | ${sil.toFixed(4).padStart(10)} | ${ari.toFixed(3).padStart(6)} | ${purity.overallPurity.padStart(5)}% | ${String(deltaInertia).padStart(6)}%`);
        }

        // Find best silhouette
        const bestSil = results.reduce((a, b) => a.sil > b.sil ? a : b);
        console.log(`\n  Best silhouette: K=${bestSil.k} (${bestSil.sil.toFixed(4)})\n`);

        // Show cluster detail for the best silhouette K
        console.log(`  Cluster detail for K=${bestSil.k}:`);
        console.log(`  ${'─'.repeat(66)}`);
        for (const cl of bestSil.purity.clusters) {
            const othersStr = cl.others ? ` | ${cl.others}` : '';
            console.log(`  C${String(cl.cluster).padStart(2)}: ${String(cl.size).padStart(3)} images | ${cl.purity}% ${cl.dominant}(${cl.dominantCount})${othersStr}`);
        }

        // Also show K=14 detail (matches current archetype count)
        const k14 = results.find(r => r.k === 14);
        if (k14 && k14.k !== bestSil.k) {
            console.log(`\n  Cluster detail for K=14 (current archetype count):`);
            console.log(`  ${'─'.repeat(66)}`);
            for (const cl of k14.purity.clusters) {
                const othersStr = cl.others ? ` | ${cl.others}` : '';
                console.log(`  C${String(cl.cluster).padStart(2)}: ${String(cl.size).padStart(3)} images | ${cl.purity}% ${cl.dominant}(${cl.dominantCount})${othersStr}`);
            }
        }

        console.log('');
    }

    // Write detailed results for the best K in 19d mode
    const raw19 = images.map(img => extractFeatures(img, '19d'));
    const { normalized: norm19, mean, std } = zNormalize(raw19);

    // Run best K from 19d
    let bestK = 12; // default
    let bestSilScore = -1;
    for (let k = 6; k <= 22; k++) {
        const { labels } = kmeans(norm19, k);
        const sil = silhouetteScore(norm19, labels);
        if (sil > bestSilScore) { bestSilScore = sil; bestK = k; }
    }

    const { labels: finalLabels } = kmeans(norm19, bestK);

    // Compute cluster centroids in original (unnormalized) space
    const dims = raw19[0].length;
    const clusterData = Array.from({ length: bestK }, () => ({
        members: [],
        centroid7d: {},
        sectorMeans: {}
    }));

    for (let i = 0; i < images.length; i++) {
        clusterData[finalLabels[i]].members.push(images[i]);
    }

    for (let c = 0; c < bestK; c++) {
        const members = clusterData[c].members;
        if (members.length === 0) continue;

        // 7D centroid
        for (const d of DIM_7D) {
            clusterData[c].centroid7d[d] = +(members.reduce((s, m) => s + m.dna[d], 0) / members.length).toFixed(3);
        }

        // Sector means
        for (const s of SECTORS) {
            clusterData[c].sectorMeans[s] = +(members.reduce((sum, m) => sum + m.sectors[s], 0) / members.length).toFixed(4);
        }
    }

    const outData = {
        mode: '19d',
        k: bestK,
        silhouette: bestSilScore,
        clusters: clusterData.map((cd, i) => ({
            id: i,
            size: cd.members.length,
            centroid7d: cd.centroid7d,
            sectorMeans: cd.sectorMeans,
            archetypeBreakdown: archetypeBreakdown(cd.members),
            qualityMean: {
                revelationScore: +(cd.members.reduce((s, m) => s + (m.quality.revelationScore || 0), 0) / cd.members.length).toFixed(1),
                avgDeltaE: +(cd.members.reduce((s, m) => s + (m.quality.avgDeltaE || 0), 0) / cd.members.length).toFixed(2)
            },
            memberFilenames: cd.members.map(m => m.filename).sort()
        })).filter(c => c.size > 0).sort((a, b) => b.size - a.size)
    };

    const outPath = path.join(DATA_DIR, 'cluster-explore.json');
    fs.writeFileSync(outPath, JSON.stringify(outData, null, 2));
    console.log(`Detailed cluster data written to ${path.relative(process.cwd(), outPath)}`);
}

function archetypeBreakdown(members) {
    const counts = {};
    for (const m of members) counts[m.currentArchetype] = (counts[m.currentArchetype] || 0) + 1;
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ archetype: name, count, pct: +(count / members.length * 100).toFixed(1) }));
}

main();
