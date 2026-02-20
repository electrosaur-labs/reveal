#!/usr/bin/env node
/**
 * harvest-dna.js — Aggregate DNA v2.0 vectors from existing sidecar JSONs
 *
 * Reads all sidecar JSONs from TESTIMAGES, SP100, and CQ100 datasets,
 * extracts 7D centroid + 12 sector weights + metadata, and writes a
 * single consolidated file for downstream clustering.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');

const SECTOR_NAMES = [
    'red', 'orange', 'yellow', 'chartreuse', 'green', 'cyan',
    'azure', 'blue', 'purple', 'magenta', 'pink', 'rose'
];

const SKIP_BASENAMES = new Set([
    'batch-report',
    'testimages_meta_analysis'
]);

// ---------------------------------------------------------------------------
// Dataset scan definitions
// ---------------------------------------------------------------------------
const SCAN_DIRS = [
    { dir: path.join(DATA_DIR, 'TESTIMAGES', 'output', 'psd', '16bit'), dataset: 'TESTIMAGES' },
    { dir: path.join(DATA_DIR, 'SP100', 'output', 'met', 'psd', '16bit'), dataset: 'SP100/met' },
    { dir: path.join(DATA_DIR, 'SP100', 'output', 'rijks', 'psd', '16bit'), dataset: 'SP100/rijks' },
    { dir: path.join(DATA_DIR, 'SP100', 'output', 'aic', 'psd', '16bit'), dataset: 'SP100/aic' },
    { dir: path.join(DATA_DIR, 'SP100', 'output', 'minkler', 'psd', '16bit'), dataset: 'SP100/minkler' },
    { dir: path.join(DATA_DIR, 'CQ100_v4', 'output', 'psd', '16bit'), dataset: 'CQ100' },
];

// ---------------------------------------------------------------------------
// Extract DNA from a sidecar JSON
// ---------------------------------------------------------------------------
function extractDNA(sidecar, filePath) {
    const basename = path.basename(filePath, '.json');
    const isV2 = sidecar.dna && sidecar.dna.version === '2.0';

    let dna, sectors;

    if (isV2) {
        // New format: dna.global has all 7 dimensions, dna.sectors.*.weight
        const g = sidecar.dna.global;
        if (!g) return null;

        dna = {
            l: g.l,
            c: g.c,
            k: g.k,
            l_std_dev: g.l_std_dev,
            hue_entropy: g.hue_entropy,
            temperature_bias: g.temperature_bias,
            primary_sector_weight: g.primary_sector_weight
        };

        const rawSectors = sidecar.dna.sectors;
        if (!rawSectors) return null;

        sectors = {};
        for (const name of SECTOR_NAMES) {
            const s = rawSectors[name];
            sectors[name] = s ? s.weight : 0;
        }
    } else {
        // Old format: dna has l/c/k/l_std_dev, dnaFidelity.global has remaining 3D
        if (!sidecar.dnaFidelity || !sidecar.dnaFidelity.global) return null;

        const fg = sidecar.dnaFidelity.global;
        dna = {
            l: sidecar.dna.l,
            c: sidecar.dna.c,
            k: sidecar.dna.k,
            l_std_dev: sidecar.dna.l_std_dev,
            hue_entropy: fg.hue_entropy ? fg.hue_entropy.input : undefined,
            temperature_bias: fg.temperature_bias ? fg.temperature_bias.input : undefined,
            primary_sector_weight: fg.primary_sector_weight ? fg.primary_sector_weight.input : undefined
        };

        // Need all 7 dimensions
        if (dna.hue_entropy === undefined || dna.temperature_bias === undefined || dna.primary_sector_weight === undefined) {
            return null;
        }

        const rawSectors = sidecar.dnaFidelity.sectors;
        if (!rawSectors) return null;

        sectors = {};
        for (const name of SECTOR_NAMES) {
            const s = rawSectors[name];
            sectors[name] = s ? s.input : 0;
        }
    }

    // Validate all 7 dimensions are present and numeric
    for (const key of ['l', 'c', 'k', 'l_std_dev', 'hue_entropy', 'temperature_bias', 'primary_sector_weight']) {
        if (typeof dna[key] !== 'number' || isNaN(dna[key])) return null;
    }

    // Archetype ID
    const currentArchetype =
        (sidecar.archetype && sidecar.archetype.id) ||
        (sidecar.configuration && sidecar.configuration.meta && sidecar.configuration.meta.archetypeId) ||
        (sidecar.dna && sidecar.dna.archetype) ||
        'unknown';

    // Quality metrics
    const revelationScore = sidecar.metrics && sidecar.metrics.feature_preservation
        ? sidecar.metrics.feature_preservation.revelationScore : null;
    const avgDeltaE = sidecar.metrics && sidecar.metrics.global_fidelity
        ? sidecar.metrics.global_fidelity.avgDeltaE : null;

    // Filename (strip .psd extension if present)
    const filename = sidecar.meta && sidecar.meta.filename
        ? sidecar.meta.filename.replace(/\.psd$/i, '')
        : basename;

    return {
        filename,
        currentArchetype,
        dna,
        sectors,
        quality: {
            revelationScore,
            avgDeltaE
        }
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
    const images = [];
    let skippedNoData = 0;
    let skippedMeta = 0;

    for (const { dir, dataset } of SCAN_DIRS) {
        if (!fs.existsSync(dir)) {
            console.warn(`  WARN: directory not found: ${dir}`);
            continue;
        }

        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();

        for (const file of files) {
            const basename = path.basename(file, '.json');

            // Skip non-image files
            if (SKIP_BASENAMES.has(basename)) {
                skippedMeta++;
                continue;
            }

            const filePath = path.join(dir, file);
            let sidecar;
            try {
                sidecar = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            } catch (e) {
                console.warn(`  WARN: failed to parse ${filePath}: ${e.message}`);
                continue;
            }

            const record = extractDNA(sidecar, filePath);
            if (!record) {
                skippedNoData++;
                continue;
            }

            record.dataset = dataset;
            images.push(record);
        }
    }

    // Sort by dataset then filename for stable output
    images.sort((a, b) => {
        if (a.dataset !== b.dataset) return a.dataset.localeCompare(b.dataset);
        return a.filename.localeCompare(b.filename);
    });

    const output = {
        version: '1.0',
        harvested: new Date().toISOString(),
        count: images.length,
        dimensions: ['l', 'c', 'k', 'l_std_dev', 'hue_entropy', 'temperature_bias', 'primary_sector_weight'],
        sectors: SECTOR_NAMES,
        images
    };

    const outPath = path.join(DATA_DIR, 'dna-harvest.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

    // Summary
    const datasetCounts = {};
    for (const img of images) {
        datasetCounts[img.dataset] = (datasetCounts[img.dataset] || 0) + 1;
    }

    console.log(`Harvested ${images.length} DNA vectors → ${path.relative(process.cwd(), outPath)}`);
    console.log('');
    for (const [ds, count] of Object.entries(datasetCounts).sort()) {
        console.log(`  ${ds}: ${count}`);
    }
    if (skippedMeta > 0) console.log(`  (skipped ${skippedMeta} meta/report files)`);
    if (skippedNoData > 0) console.log(`  (skipped ${skippedNoData} files missing DNA v2.0 data)`);
}

main();
