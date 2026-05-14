const PipelineOperation = require('../PipelineOperation');
const RevealCore = require('../../../../../reveal-core/index');

/**
 * Refine: K-Means palette centroid refinement.
 *
 * Standard path (no edgePreservation): delegates to RevealCore PaletteOps._refineKMeans.
 * Applies spatialWeight as a lWeight multiplier so quantization and refinement
 * share the same Luminance Priority.
 *
 * Edge-aware path (edgePreservation > 0 with valid dimensions):
 *   1. Sobel gradient pre-pass on L-channel → normalized gradient map G[0,1].
 *   2. Switching-penalty K-Means: a pixel on a high-gradient boundary resists
 *      migrating to a new centroid by a factor of (1 + edgePreservation × G).
 *      It will only switch if the new centroid is that much closer than its current one.
 *      Pixels already at their nearest centroid bear no extra cost.
 */
class RefineOperation extends PipelineOperation {
    execute(state, config) {
        const iterations = this.params.iterations !== undefined
            ? this.params.iterations
            : (config.refinementPasses !== undefined ? config.refinementPasses : 1);
        if (iterations <= 0 || !state.palette || state.palette.length <= 1) {
            return state;
        }

        const p = { ...config, ...this.params };
        const edgePreservation = p.edgePreservation;
        const w = state.metadata.width;
        const h = state.metadata.height;

        if (edgePreservation > 0 && w > 0 && h > 0) {
            state.palette = this._edgeAwareRefine(state, w, h, edgePreservation, iterations);
            return state;
        }

        // Standard path: spatialWeight scales lWeight for centroid computation.
        const lW = (p.lWeight !== undefined ? p.lWeight : 1.1)
                 * (p.spatialWeight !== undefined ? p.spatialWeight : 1.0);
        const tuning = {
            centroid: {
                lWeight: lW,
                cWeight: p.cWeight !== undefined ? p.cWeight : 2.0,
                bWeight: p.bWeight !== undefined ? p.bWeight : 1.0,
                blackBias: p.blackBias !== undefined ? p.blackBias : 5.0,
                bitDepth: 16,
                vibrancyMode: p.vibrancyMode || 'aggressive',
                vibrancyBoost: p.vibrancyBoost !== undefined ? p.vibrancyBoost : 1.6
            }
        };

        let refined = state.palette;
        for (let i = 0; i < iterations; i++) {
            refined = RevealCore.engines.PaletteOps._refineKMeans(state.pixels, refined, tuning);
        }
        state.palette = refined;
        return state;
    }

    /**
     * Edge-aware K-Means refinement using a Sobel gradient switching penalty.
     * Pixels on high-gradient boundaries resist cluster migration in proportion
     * to edgePreservation × G, "locking" color plates to structural edges.
     */
    _edgeAwareRefine(state, w, h, edgePreservation, iterations) {
        const pixels = state.pixels; // Float32 perceptual (L: 0-100, a/b: ±128)
        const n = w * h;
        const gradMap = this._sobelGradient(pixels, w, h);

        let palette = state.palette.map(c => ({ ...c }));

        // Seed assignments from the prior map step if available; otherwise compute fresh.
        const prevAssign = state.assignments
            ? Uint8Array.from(state.assignments)
            : this._standardAssign(pixels, n, palette);

        for (let iter = 0; iter < iterations; iter++) {
            const k = palette.length;
            const sumL = new Float64Array(k);
            const sumA = new Float64Array(k);
            const sumB = new Float64Array(k);
            const cnt  = new Uint32Array(k);
            const newAssign = new Uint8Array(n);

            for (let i = 0; i < n; i++) {
                const L = pixels[i * 3];
                const a = pixels[i * 3 + 1];
                const b = pixels[i * 3 + 2];
                const switchCost = 1.0 + edgePreservation * gradMap[i];
                const prev = prevAssign[i];

                // Distance to current centroid — no switching penalty.
                let bestIdx = prev;
                let bestDist = this._dist(L, a, b, palette[prev].L, palette[prev].a, palette[prev].b);

                // Distance to all other centroids — penalised by switchCost.
                for (let j = 0; j < k; j++) {
                    if (j === prev) continue;
                    const d = this._dist(L, a, b, palette[j].L, palette[j].a, palette[j].b) * switchCost;
                    if (d < bestDist) { bestDist = d; bestIdx = j; }
                }

                newAssign[i] = bestIdx;
                sumL[bestIdx] += L;
                sumA[bestIdx] += a;
                sumB[bestIdx] += b;
                cnt[bestIdx]++;
            }

            // Update centroids from new assignments.
            for (let j = 0; j < k; j++) {
                if (cnt[j] > 0) {
                    palette[j] = { L: sumL[j] / cnt[j], a: sumA[j] / cnt[j], b: sumB[j] / cnt[j] };
                }
            }

            prevAssign.set(newAssign);
        }

        return palette;
    }

    /** Sobel gradient magnitude on L-channel, normalized to [0, 1]. */
    _sobelGradient(pixels, w, h) {
        const grad = new Float32Array(w * h);
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const tl = ((y-1)*w + (x-1))*3,  tc = ((y-1)*w + x)*3,  tr = ((y-1)*w + (x+1))*3;
                const ml = (    y*w + (x-1))*3,                           mr = (    y*w + (x+1))*3;
                const bl = ((y+1)*w + (x-1))*3,  bc = ((y+1)*w + x)*3,  br = ((y+1)*w + (x+1))*3;
                const gx = -pixels[tl] + pixels[tr]
                         + -2*pixels[ml] + 2*pixels[mr]
                         + -pixels[bl] + pixels[br];
                const gy = -pixels[tl] - 2*pixels[tc] - pixels[tr]
                         +  pixels[bl] + 2*pixels[bc] + pixels[br];
                grad[y * w + x] = Math.sqrt(gx * gx + gy * gy);
            }
        }
        let maxG = 0;
        for (let i = 0; i < grad.length; i++) if (grad[i] > maxG) maxG = grad[i];
        if (maxG > 0) for (let i = 0; i < grad.length; i++) grad[i] /= maxG;
        return grad;
    }

    /** Standard nearest-centroid assignment with no penalty. */
    _standardAssign(pixels, n, palette) {
        const k = palette.length;
        const assign = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const L = pixels[i*3], a = pixels[i*3+1], b = pixels[i*3+2];
            let best = 0, bestD = Infinity;
            for (let j = 0; j < k; j++) {
                const d = this._dist(L, a, b, palette[j].L, palette[j].a, palette[j].b);
                if (d < bestD) { bestD = d; best = j; }
            }
            assign[i] = best;
        }
        return assign;
    }

    _dist(L1, a1, b1, L2, a2, b2) {
        const dL = L1-L2, da = a1-a2, db = b1-b2;
        return Math.sqrt(dL*dL + da*da + db*db);
    }
}

module.exports = RefineOperation;
