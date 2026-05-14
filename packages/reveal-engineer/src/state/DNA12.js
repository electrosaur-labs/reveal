/**
 * DNA12 — 12-vector image DNA for the Engineer's phase-space modulation.
 *
 * Per the Architect's spec, each feature is normalized to [0.0, 1.0]. The
 * 12-tuple is the signal that drives the modulation formula in
 * EngineBuilder._hydrateConfig:
 *
 *     value_final = clamp(default + DNA[modulateBy] * sensitivity, min, max)
 *
 * Each goddess engine subscribes to a small handful of features via the
 * `modulateBy` field on its JSON parameters.
 *
 * Implemented as a pre-pass over Lab pixels in the Engineer; reveal-core is
 * untouched (its DNAGenerator stays at v2.0 for Navigator parity).
 *
 * Usage: `DNA12.augment(dna, labPixels, w, h)` merges the 12 normalized fields
 * onto a v2.0 DNA object. The resulting object keeps the v2.0 nested structure
 * (`dna.global.l`, `dna.sectors.red.weight`, etc.) for ArchetypeMapper /
 * DNAFidelity / other reveal-core consumers, AND exposes flat normalized
 * fields at the top level (`dna.lMean`, `dna.spatialEntropy`, etc.) for
 * EngineBuilder modulation. One object, two views.
 */

const RevealCore = require('../../../reveal-core/index');
const { L_SCALE, AB_SCALE, LAB16_AB_NEUTRAL } = RevealCore.LabEncoding;

const HISTOGRAM_TARGET_SAMPLES = 250000;
const SPATIAL_STRIDE = 4;
const CHROMA_FLOOR = 5.0;          // distinguishes "color pixel" from "near-neutral"
const SCOHERENCE_L_TOL = 5.0;      // matches reveal-framework v3.0 measure
const EDGE_DENSITY_DELTA = 12.0;   // Architect's chosen threshold

// Max population variance of 12 sector weights (one sector at 1.0, rest at 0):
//   variance = ((1 - 1/12)^2 + 11 * (0 - 1/12)^2) / 12 = (132/144)/12 = 11/144.
const MAX_SECTOR_VARIANCE = 11 / 144;

class DNA12 {
    /**
     * Augment a v2.0 DNA object with the 12 normalized phase-space features.
     * The 12 fields are added at the top level of `dna` so EngineBuilder can
     * read them as `dna.lMean`, `dna.spatialEntropy`, etc. The original v2.0
     * nested fields are left intact.
     *
     * @param {Object} dna - reveal-core v2.0 DNA (mutated in place; also returned)
     * @param {Uint16Array|Float32Array} labPixels - Lab pixel data.
     *        Uint16Array → engine 16-bit (L: 0-32768, a/b: 0-32768, 16384=neutral).
     *        Float32Array → perceptual (L: 0-100, a/b: ±128).
     * @param {number} width
     * @param {number} height
     * @returns {Object} The same dna object with 12 normalized fields added.
     */
    static augment(dna, labPixels, width, height) {
        const features = this.compute(labPixels, width, height);
        for (const [k, v] of Object.entries(features)) {
            dna[k] = v;
        }
        return dna;
    }

    /**
     * Compute the 12-vector DNA from Lab pixels (without mutating anything).
     *
     * @param {Uint16Array|Float32Array} labPixels - Lab pixel data.
     *        Uint16Array → engine 16-bit (L: 0-32768, a/b: 0-32768, 16384=neutral).
     *        Float32Array → perceptual (L: 0-100, a/b: ±128).
     * @param {number} width
     * @param {number} height
     * @returns {Object} 12 normalized [0,1] features keyed by name.
     */
    static compute(labPixels, width, height) {
        const is16bit = labPixels instanceof Uint16Array;
        const pixelCount = labPixels.length / 3;

        const sampleStride = Math.max(1, Math.floor(pixelCount / HISTOGRAM_TARGET_SAMPLES));

        // Inline accessors — closures cost a bit per call but keep the loop body
        // legible and the encoding handled in one place.
        const getL = is16bit
            ? (i) => labPixels[i] / L_SCALE
            : (i) => labPixels[i];
        const getA = is16bit
            ? (i) => (labPixels[i + 1] - LAB16_AB_NEUTRAL) / AB_SCALE
            : (i) => labPixels[i + 1];
        const getB = is16bit
            ? (i) => (labPixels[i + 2] - LAB16_AB_NEUTRAL) / AB_SCALE
            : (i) => labPixels[i + 2];

        // ── PASS 1: per-pixel statistics, histograms, hue sectors ──
        const lHist = new Uint32Array(101);
        const cHist = new Uint32Array(141);
        const sectorCounts = new Float32Array(12);

        let lSum = 0, lSqSum = 0, cSum = 0;
        let chromaticPixels = 0, chromaticChromaSum = 0;
        let samples = 0;

        for (let p = 0; p < pixelCount; p += sampleStride) {
            const i = p * 3;
            const L = getL(i);
            const a = getA(i);
            const b = getB(i);
            const c = Math.sqrt(a * a + b * b);

            lSum += L;
            lSqSum += L * L;
            cSum += c;
            samples++;

            const lBin = L < 0 ? 0 : L > 100 ? 100 : Math.round(L);
            lHist[lBin]++;

            const cBin = c < 0 ? 0 : c > 140 ? 140 : Math.round(c);
            cHist[cBin]++;

            if (c >= CHROMA_FLOOR) {
                chromaticPixels++;
                chromaticChromaSum += c;
                const hue = Math.atan2(b, a) * 180 / Math.PI;
                const normalized = (hue + 360) % 360;
                const sIdx = Math.floor(normalized / 30) % 12;
                sectorCounts[sIdx]++;
            }
        }

        // Aggregates (mean / stddev)
        const lMean = samples > 0 ? lSum / samples : 0;
        const lVar = samples > 0 ? (lSqSum / samples) - (lMean * lMean) : 0;
        const lStdDev = Math.sqrt(Math.max(0, lVar));
        const cMean = samples > 0 ? cSum / samples : 0;

        // Shadow mass: pixel fraction with L < 15
        let shadowCount = 0;
        for (let i = 0; i <= 14; i++) shadowCount += lHist[i];
        const shadowMass = samples > 0 ? shadowCount / samples : 0;

        // Highlight mass: pixel fraction with L > 85
        let highlightCount = 0;
        for (let i = 85; i <= 100; i++) highlightCount += lHist[i];
        const highlightMass = samples > 0 ? highlightCount / samples : 0;

        // C-Max (P95 of per-pixel chroma) — Architect's choice: raw peak, not weighted.
        let cP95 = 0;
        {
            let cum = 0;
            const target = samples * 0.05;
            for (let i = 140; i >= 0; i--) {
                cum += cHist[i];
                if (cum >= target) { cP95 = i; break; }
            }
        }

        // Saliency: mean L of brightest decile minus global mean L, normalized.
        // Architect: "how much a highlight pops against the average substrate value."
        let topDecileThreshold = 100;
        {
            let cum = 0;
            const target = samples * 0.10;
            for (let i = 100; i >= 0; i--) {
                cum += lHist[i];
                if (cum >= target) { topDecileThreshold = i; break; }
            }
        }
        let topSum = 0, topCount = 0;
        for (let i = topDecileThreshold; i <= 100; i++) {
            topSum += i * lHist[i];
            topCount += lHist[i];
        }
        const topDecileMean = topCount > 0 ? topSum / topCount : lMean;
        // Max possible delta is 50 (mean=50, top=100 in a perfectly bimodal image).
        const saliency = Math.max(0, Math.min(1, (topDecileMean - lMean) / 50));

        // Neutral-Anchor: avg chroma of chromatic-only pixels. High = chromatic image.
        const neutralAnchor = chromaticPixels > 0
            ? Math.min(1, (chromaticChromaSum / chromaticPixels) / 128)
            : 0;

        // Hue-Count: occupied sectors / 12 (1% population threshold counts as occupied).
        // First normalize sector counts to fractional weights.
        let occupiedSectors = 0;
        if (chromaticPixels > 0) {
            for (let i = 0; i < 12; i++) {
                sectorCounts[i] /= chromaticPixels;
                if (sectorCounts[i] > 0.01) occupiedSectors++;
            }
        }
        const hueCount = occupiedSectors / 12;

        // Hue-Variance: population variance of sector weights / max possible variance.
        // High variance ⇒ image dominated by one or two sectors.
        // Undefined for fully-neutral images (no chromatic content) — report 0.
        let hueVariance = 0;
        if (chromaticPixels > 0) {
            const sectorMean = 1 / 12;
            let sectorVarSum = 0;
            for (let i = 0; i < 12; i++) {
                const d = sectorCounts[i] - sectorMean;
                sectorVarSum += d * d;
            }
            const sectorVar = sectorVarSum / 12;
            hueVariance = Math.min(1, sectorVar / MAX_SECTOR_VARIANCE);
        }

        // ── PASS 2: spatial features (Scoherence + Edge density) ──
        // Same stride pattern as reveal-framework v3.0's _calculateScoherence so the
        // signals stay mechanically aligned with the engine pipeline's edge-handling.
        let scMatches = 0, scTotal = 0;
        let edMatches = 0, edTotal = 0;

        for (let y = 0; y < height - SPATIAL_STRIDE; y += SPATIAL_STRIDE) {
            const rowBase = y * width;
            const nextRowBase = (y + 1) * width;
            for (let x = 0; x < width - SPATIAL_STRIDE; x += SPATIAL_STRIDE) {
                const idx = (rowBase + x) * 3;
                const rightIdx = (rowBase + x + 1) * 3;
                const downIdx = (nextRowBase + x) * 3;

                const L = getL(idx);
                const dRight = Math.abs(L - getL(rightIdx));
                const dDown = Math.abs(L - getL(downIdx));

                if (dRight < SCOHERENCE_L_TOL) scMatches++;
                if (dDown < SCOHERENCE_L_TOL) scMatches++;
                scTotal += 2;

                if ((dRight + dDown) > EDGE_DENSITY_DELTA) edMatches++;
                edTotal++;
            }
        }

        const scoherence = scTotal > 0 ? scMatches / scTotal : 0;
        const spatialEntropy = 1 - scoherence;
        const edgeDensity = edTotal > 0 ? edMatches / edTotal : 0;

        return {
            lMean:         Math.min(1, lMean / 100),
            lStdDev:       Math.min(1, lStdDev / 50),
            cMean:         Math.min(1, cMean / 128),
            cMax:          Math.min(1, cP95 / 128),
            hueCount,
            hueVariance,
            spatialEntropy,
            edgeDensity,
            saliency,
            neutralAnchor,
            shadowMass,
            highlightMass
        };
    }
}

module.exports = DNA12;
