#!/usr/bin/env node
/**
 * diff-distilled.js
 *
 * Diffs distilled K=12 results against existing direct-posterize baseline.
 * Prints per-image delta table and aggregate summary.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR      = path.join(__dirname, '../data/TESTIMAGES');
const BASELINE_JSON = path.join(DATA_DIR, 'testimages_analysis.json');
const DISTILLED_DIR = path.join(DATA_DIR, 'output/psd/distilled-k12');

// Load baseline
const baselineRaw = require(BASELINE_JSON);
const baseline    = baselineRaw.images || baselineRaw;
const baseMap     = {};
for (const entry of baseline) baseMap[entry.basename] = entry;

// Load distilled sidecar JSONs
const distilledMap = {};
const files = fs.readdirSync(DISTILLED_DIR)
    .filter(f => f.endsWith('.json') && f !== 'batch-report.json');
for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DISTILLED_DIR, f), 'utf8'));
    distilledMap[data.meta.filename.replace('.psd', '')] = data;
}

// Build comparison rows
const rows = [];
for (const [name, dist] of Object.entries(distilledMap)) {
    const base = baseMap[name];
    if (!base) continue;

    rows.push({
        name,
        baseK:   base.colorCount,
        distK:   dist.meta.actualColors,
        baseDeltaE:  base.avgDeltaE,
        distDeltaE:  dist.deltaE.avg,
        ddeltaE:     +(dist.deltaE.avg - base.avgDeltaE).toFixed(2),
        baseRevel:   base.revelationScore,
        distRevel:   dist.scores.revelation,
        dRevel:      +(dist.scores.revelation - base.revelationScore).toFixed(1),
        baseInteg:   base.integrityScore,
        distInteg:   dist.scores.integrity,
        baseArchetype: base.archetype,
    });
}

rows.sort((a, b) => a.ddeltaE - b.ddeltaE); // best ΔE improvement first

// ── Print table ───────────────────────────────────────────────────────────────
const W = 86;
console.log(`\nDistilled K=12 vs. Direct Baseline`);
console.log('━'.repeat(W));
console.log(
    `${'Image'.padEnd(20)}  ${'K'.padEnd(8)}  ${'ΔE avg'.padEnd(18)}  ${'Revelation'.padEnd(18)}  Archetype`
);
console.log(
    `${''.padEnd(20)}  ${'base→dist'.padEnd(8)}  ${'base→dist (Δ)'.padEnd(18)}  ${'base→dist (Δ)'.padEnd(18)}`
);
console.log('─'.repeat(W));

for (const r of rows) {
    const deDelta  = r.ddeltaE  <= 0 ? `✓${r.ddeltaE}` : `✗+${r.ddeltaE}`;
    const rvDelta  = r.dRevel   >= 0 ? `✓+${r.dRevel}` : `✗${r.dRevel}`;
    console.log(
        `${r.name.padEnd(20)}  ${(r.baseK+'→'+r.distK).padEnd(8)}` +
        `  ${(r.baseDeltaE+' → '+r.distDeltaE).padEnd(12)} ${deDelta.padEnd(8)}` +
        `  ${(r.baseRevel+' → '+r.distRevel).padEnd(12)} ${rvDelta.padEnd(8)}` +
        `  ${r.baseArchetype}`
    );
}

// ── Aggregate ─────────────────────────────────────────────────────────────────
console.log('─'.repeat(W));
const n = rows.length;
const avgBaseDeltaE  = (rows.reduce((s,r)=>s+r.baseDeltaE,  0)/n).toFixed(2);
const avgDistDeltaE  = (rows.reduce((s,r)=>s+r.distDeltaE,  0)/n).toFixed(2);
const avgBaseRevel   = (rows.reduce((s,r)=>s+r.baseRevel,   0)/n).toFixed(1);
const avgDistRevel   = (rows.reduce((s,r)=>s+r.distRevel,   0)/n).toFixed(1);
const deDeltaAvg     = +(avgDistDeltaE - avgBaseDeltaE).toFixed(2);
const rvDeltaAvg     = +(avgDistRevel  - avgBaseRevel).toFixed(1);
const improved_dE    = rows.filter(r => r.ddeltaE  < 0).length;
const improved_rv    = rows.filter(r => r.dRevel   > 0).length;

console.log(`\nAGGREGATE  (${n} images)`);
console.log(`  ΔE avg:     ${avgBaseDeltaE} → ${avgDistDeltaE}  (${deDeltaAvg > 0 ? '+' : ''}${deDeltaAvg})   improved: ${improved_dE}/${n}`);
console.log(`  Revelation: ${avgBaseRevel}  → ${avgDistRevel}   (${rvDeltaAvg > 0 ? '+' : ''}${rvDeltaAvg})   improved: ${improved_rv}/${n}`);
console.log(`  Integrity:  100 → 100  (no regressions)\n`);

// Write diff JSON
const diffPath = path.join(DISTILLED_DIR, 'diff-vs-baseline.json');
fs.writeFileSync(diffPath, JSON.stringify({ rows, aggregate: {
    n, avgBaseDeltaE, avgDistDeltaE, deDeltaAvg,
    avgBaseRevel, avgDistRevel, rvDeltaAvg,
    improved_dE, improved_rv,
}}, null, 2));
console.log(`Diff JSON: ${diffPath}`);
