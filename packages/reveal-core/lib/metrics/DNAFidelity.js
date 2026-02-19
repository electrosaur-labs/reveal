/**
 * DNAFidelity - Closed-loop posterization audit via DNA comparison
 *
 * Compares input DNA (original image) to output DNA (posterized result)
 * to detect structural drift that per-pixel ΔE cannot catch.
 *
 * Example: Jethro's gray fur (C*≈2) mapped to light blue (C*≈10) has
 * small per-pixel ΔE but the image's "soul" shifted from neutral to
 * chromatic. DNAFidelity catches this via chroma drift alert.
 *
 * Pure math — no I/O, no dependencies.
 *
 * @module DNAFidelity
 */

const DNAGenerator = require('../analysis/DNAGenerator');

// ─── Dimension metadata for normalization and alerting ───
//
// Calibrated against SP100 (147 images) + TESTIMAGES (40 images), 2026-02-19:
//
// Posterization inherently reduces hue entropy (millions → 8 colors) and shifts
// temperature balance and sector weights. These "quantization noise" dimensions
// get WIDE ranges (3× previous) to dampen their contribution — they dominate
// fidelity cost but don't reflect separation quality.
//
// Chroma drift is the primary quality signal — it catches problems like
// "blue fur" (neutral → chromatic) or archetype mismatch. Tightened range
// (60→30) amplifies its contribution so chroma accounts for >20% of cost.
//
// Decay=1.2 targets: typical posterization ≈ F=75, best ≈ F=90+, gaps ≈ F=50.

const GLOBAL_DIMS = [
    { key: 'l',                     range: 100,  weight: 1.0 },
    { key: 'c',                     range: 30,   weight: 2.5 },  // Primary quality signal (tightened from 60)
    { key: 'k',                     range: 200,  weight: 0.8 },  // Inherent to posterization (widened 2× from 100)
    { key: 'l_std_dev',             range: 40,   weight: 1.2 },
    { key: 'hue_entropy',           range: 3,    weight: 0.3 },  // Quantization noise (widened 3× from 1)
    { key: 'temperature_bias',      range: 6,    weight: 0.3 },  // Quantization noise (widened 3× from 2)
    { key: 'primary_sector_weight', range: 3,    weight: 0.8 }   // Quantization noise (widened 3× from 1)
];

// Alert thresholds — calibrated to fire only on anomalous drift,
// not normal posterization cost.
// TESTIMAGES baselines: |Δ entropy|≈0.24, |Δ temp|≈0.36, sector drift≈0.74
const ALERT_RULES = [
    {
        key: 'c',
        test: (delta) => Math.abs(delta) > 5.0,
        label: (delta) => `Chroma drift (${delta >= 0 ? '+' : ''}${delta.toFixed(1)})`
    },
    {
        key: 'hue_entropy',
        test: (delta) => delta < -0.40,
        label: (delta) => `Entropy collapse (${delta.toFixed(2)})`
    },
    {
        key: 'temperature_bias',
        test: (delta) => Math.abs(delta) > 0.8,
        label: (delta) => `Temperature shift (${delta >= 0 ? '+' : ''}${delta.toFixed(1)})`
    },
    {
        key: 'l_std_dev',
        test: (delta) => delta < -5.0,
        label: (delta) => `Contrast loss (${delta.toFixed(1)})`
    },
    {
        key: 'primary_sector_weight',
        test: (delta) => delta > 0.20,
        label: (delta) => `Ink imbalance (+${delta.toFixed(2)})`
    }
];

const SECTOR_DRIFT_THRESHOLD = 1.0;
const FIDELITY_DECAY = 1.2; // exp(-decay * distance) — targets avg F≈80 on TESTIMAGES

const DNAFidelity = {

    /**
     * Compare input DNA to output DNA.
     *
     * @param {Object} inputDNA - DNA v2.0 from original image
     * @param {Object} outputDNA - DNA v2.0 from posterized output
     * @returns {Object} { global, sectors, sectorDrift, fidelity, alerts }
     */
    compare(inputDNA, outputDNA) {
        if (!inputDNA || !inputDNA.global || !outputDNA || !outputDNA.global) {
            return { global: {}, sectors: {}, sectorDrift: 0, fidelity: 100, alerts: [] };
        }

        const inG = inputDNA.global;
        const outG = outputDNA.global;

        // ── Global dimension diffs ──
        const global = {};
        let sumSqNorm = 0;

        for (const dim of GLOBAL_DIMS) {
            const inVal = Number(inG[dim.key]) || 0;
            const outVal = Number(outG[dim.key]) || 0;
            const delta = outVal - inVal;

            global[dim.key] = {
                input: inVal,
                output: outVal,
                delta: parseFloat(delta.toFixed(4))
            };

            // Normalized weighted squared distance
            const norm = delta / dim.range;
            sumSqNorm += dim.weight * norm * norm;
        }

        // ── Sector weight diffs ──
        const sectors = {};
        let sectorDrift = 0;

        const inSectors = inputDNA.sectors || {};
        const outSectors = outputDNA.sectors || {};

        // Collect all sector names from both DNAs
        const allSectorNames = new Set([
            ...Object.keys(inSectors),
            ...Object.keys(outSectors)
        ]);

        for (const name of allSectorNames) {
            const inW = (inSectors[name] && inSectors[name].weight) || 0;
            const outW = (outSectors[name] && outSectors[name].weight) || 0;
            const delta = outW - inW;

            sectors[name] = {
                input: inW,
                output: outW,
                delta: parseFloat(delta.toFixed(4))
            };

            sectorDrift += Math.abs(delta);
        }

        sectorDrift = parseFloat(sectorDrift.toFixed(4));

        // ── Fidelity score (0-100) ──
        const distance = Math.sqrt(sumSqNorm);
        const fidelity = Math.round(100 * Math.exp(-FIDELITY_DECAY * distance));

        // ── Alerts ──
        const alerts = [];

        for (const rule of ALERT_RULES) {
            const delta = global[rule.key] ? global[rule.key].delta : 0;
            if (rule.test(delta)) {
                alerts.push(rule.label(delta));
            }
        }

        if (sectorDrift > SECTOR_DRIFT_THRESHOLD) {
            alerts.push(`Sector redistribution (${sectorDrift.toFixed(2)})`);
        }

        return { global, sectors, sectorDrift, fidelity, alerts };
    },

    /**
     * Full pipeline: compute output DNA from indices, then compare.
     *
     * @param {Object} inputDNA - Pre-computed input DNA
     * @param {Uint8Array} colorIndices - Posterized pixel indices
     * @param {Array<{L,a,b}>} labPalette - Palette in perceptual Lab
     * @param {number} width
     * @param {number} height
     * @returns {Object} Same as compare()
     */
    fromIndices(inputDNA, colorIndices, labPalette, width, height) {
        const outputDNA = DNAGenerator.fromIndices(colorIndices, labPalette, width, height);
        return this.compare(inputDNA, outputDNA);
    }
};

module.exports = DNAFidelity;
