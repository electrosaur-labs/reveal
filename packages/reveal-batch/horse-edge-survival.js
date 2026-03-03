#!/usr/bin/env node
/**
 * Horse edge survival benchmark — dump structural fidelity metrics
 * for all archetypes + pseudo-archetypes on the 350x512 horse fixture.
 *
 * Usage: node packages/reveal-batch/horse-edge-survival.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const Reveal = require('../reveal-core/index');
const { PosterizationEngine, ProxyEngine } = Reveal.engines;
const RevelationError = require('../reveal-core/lib/metrics/RevelationError');
const DNAGenerator = require('../reveal-core/lib/analysis/DNAGenerator');
const ArchetypeLoader = require('../reveal-core/lib/analysis/ArchetypeLoader');

// ── Load horse fixture ──
const gz = fs.readFileSync(path.join(__dirname, '../reveal-core/test/fixtures/horse-350x512-lab16.labbin.gz'));
const raw = zlib.gunzipSync(gz);
const width = raw.readUInt32LE(4);
const height = raw.readUInt32LE(8);
const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);
const pixelCount = width * height;

console.log(`Horse fixture: ${width}x${height} (${pixelCount} pixels)\n`);

// ── Generate DNA ──
const dnaGen = new DNAGenerator();
const dna = dnaGen.generate(pixels, width, height, { bitDepth: 16 });

// ── Score all archetypes ──
const archetypes = ArchetypeLoader.loadArchetypes();
const mapper = new Reveal.ArchetypeMapper(archetypes);
const scores = mapper.getTopMatches(dna, archetypes.length);

// Build config for each archetype
const results = [];

for (const match of scores) {
    try {
        const config = Reveal.generateConfiguration(dna, { manualArchetypeId: match.id });
        const posterized = PosterizationEngine.posterize(pixels, width, height, config.targetColors, {
            ...config,
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        const meanDeltaE = RevelationError.meanDeltaE16(
            pixels, posterized.assignments, posterized.paletteLab, pixelCount
        );
        const edge = RevelationError.edgeSurvival16(
            pixels, posterized.assignments, width, height
        );

        results.push({
            id: match.id,
            name: match.id.replace(/-/g, ' '),
            dnaScore: match.score,
            colors: posterized.paletteLab.length,
            meanDeltaE: meanDeltaE,
            edgeSurvival: edge.edgeSurvival,
            sigEdges: edge.significantEdges,
            survived: edge.survivedEdges,
        });
    } catch (err) {
        console.error(`  SKIP ${match.id}: ${err.message}`);
    }
}

// Add pseudo-archetypes
const pseudos = [
    { id: 'chameleon', gen: () => Reveal.generateConfigurationMk2(dna) },
    { id: 'distilled', gen: () => Reveal.generateConfigurationDistilled(dna) },
    { id: 'salamander', gen: () => Reveal.generateConfigurationSalamander(dna) },
];

for (const p of pseudos) {
    try {
        const config = p.gen();
        const posterized = PosterizationEngine.posterize(pixels, width, height, config.targetColors, {
            ...config,
            format: 'lab',
            bitDepth: 16,
            enablePaletteReduction: false,
            snapThreshold: 0,
            densityFloor: 0,
        });

        const meanDeltaE = RevelationError.meanDeltaE16(
            pixels, posterized.assignments, posterized.paletteLab, pixelCount
        );
        const edge = RevelationError.edgeSurvival16(
            pixels, posterized.assignments, width, height
        );

        results.push({
            id: p.id,
            name: `** ${p.id.toUpperCase()} **`,
            dnaScore: '-',
            colors: posterized.paletteLab.length,
            meanDeltaE: meanDeltaE,
            edgeSurvival: edge.edgeSurvival,
            sigEdges: edge.significantEdges,
            survived: edge.survivedEdges,
        });
    } catch (err) {
        console.error(`  SKIP ${p.id}: ${err.message}`);
    }
}

// Also run Chameleon WITH palette reduction (as it would actually run)
try {
    const config = Reveal.generateConfigurationMk2(dna);
    const posterized = PosterizationEngine.posterize(pixels, width, height, config.targetColors, {
        ...config,
        format: 'lab',
        bitDepth: 16,
        // Use Chameleon's actual settings (palette reduction ON)
    });

    const meanDeltaE = RevelationError.meanDeltaE16(
        pixels, posterized.assignments, posterized.paletteLab, pixelCount
    );
    const edge = RevelationError.edgeSurvival16(
        pixels, posterized.assignments, width, height
    );

    results.push({
        id: 'chameleon-pruned',
        name: '** CHAMELEON (pruned) **',
        dnaScore: '-',
        colors: posterized.paletteLab.length,
        meanDeltaE: meanDeltaE,
        edgeSurvival: edge.edgeSurvival,
        sigEdges: edge.significantEdges,
        survived: edge.survivedEdges,
    });
} catch (err) {
    console.error(`  SKIP chameleon-pruned: ${err.message}`);
}

// Sort by edge survival descending
results.sort((a, b) => b.edgeSurvival - a.edgeSurvival);

// ── Print table ──
console.log('=' .repeat(110));
console.log(
    'Rank'.padEnd(5) +
    'Archetype'.padEnd(32) +
    'DNA'.padStart(5) +
    'Clrs'.padStart(6) +
    'ΔE'.padStart(8) +
    'EdgeSurv'.padStart(10) +
    'SigEdges'.padStart(10) +
    'Survived'.padStart(10) +
    '  Composite'
);
console.log('-'.repeat(110));

for (let i = 0; i < results.length; i++) {
    const r = results[i];
    // Composite: lower is better. Structural loss + screen penalty.
    const structuralLoss = (1 - r.edgeSurvival) * 50;   // scale to ~0-50 range
    const excess = Math.max(0, r.colors - 8);
    const screenPenalty = excess > 0 ? 0.5 * Math.pow(1.6, excess - 1) : 0;
    const composite = structuralLoss + screenPenalty;

    console.log(
        String(i + 1).padStart(3).padEnd(5) +
        r.name.padEnd(32) +
        String(typeof r.dnaScore === 'number' ? r.dnaScore.toFixed(0) : r.dnaScore).padStart(5) +
        String(r.colors).padStart(6) +
        r.meanDeltaE.toFixed(1).padStart(8) +
        (r.edgeSurvival * 100).toFixed(1).padStart(9) + '%' +
        String(r.sigEdges).padStart(10) +
        String(r.survived).padStart(10) +
        composite.toFixed(1).padStart(10)
    );
}

console.log('=' .repeat(110));
console.log('\nEdgeSurvival: % of major color boundaries (ΔE>15) preserved in posterization');
console.log('Composite: structuralLoss + screenPenalty (lower = better)');
console.log('  structuralLoss = (1 - edgeSurvival) × 50');
console.log('  screenPenalty = 0.5 × 1.6^(colors-9) for colors>8');
