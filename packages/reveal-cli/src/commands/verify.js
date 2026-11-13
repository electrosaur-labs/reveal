/**
 * verify.js — Pre-Flight Separation Inspector Command
 *
 * Command: reveal verify <file.psd>
 * Audits delivered separation PSD files against physical screen-printing press physics:
 * 1. Embedded Manifest v2.1 Verification
 * 2. Trapping Physics (Invariants 1.1, 1.2, 1.3)
 * 3. Dot Retention & Mesh Physics (Invariant 2)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { inspectPsd } = require('../verify/psd-inspector');
const { verifySeparation } = require('../verify/verifier');

async function runVerify(filePath, options = {}) {
    if (!fs.existsSync(filePath)) {
        console.error(`Error: File not found: ${filePath}`);
        process.exit(1);
    }

    let buffer;
    try {
        buffer = fs.readFileSync(filePath);
    } catch (err) {
        console.error(`Error reading file: ${err.message}`);
        process.exit(1);
    }

    let parsed;
    try {
        parsed = inspectPsd(buffer);
    } catch (err) {
        console.error(`Error parsing PSD structure: ${err.message}`);
        process.exit(1);
    }

    const report = verifySeparation(parsed, options);

    if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        if (!report.valid || (options.strict && report.status === 'WARN')) {
            process.exit(1);
        }
        return report;
    }

    if (!options.quiet) {
        printReport(path.basename(filePath), report, options.verbose);
    }

    if (!report.valid || (options.strict && report.status === 'WARN')) {
        process.exit(1);
    }

    return report;
}

function printReport(filename, report, verbose = false) {
    const doc = report.document;
    const man = report.manifestAudit.fields || {};
    const trap = report.trappingAudit;
    const mesh = report.meshAudit;

    console.log('\n' + '═'.repeat(64));
    console.log(` REVEAL PRE-FLIGHT SEPARATION INSPECTOR — v2.1`);
    console.log(` File: ${filename}`);
    console.log('═'.repeat(64));

    console.log('\n[1] DOCUMENT SPECIFICATIONS');
    console.log(`  Dimensions:      ${doc.width} × ${doc.height} px`);
    console.log(`  Resolution:      ${doc.dpi} DPI`);
    console.log(`  Screen Count:    ${doc.screenCount ?? doc.plateCount} spot colors`);
    console.log(`  Manifest:        ${report.manifestAudit.present ? `v${report.manifestAudit.version || '2.1'} (embedded)` : 'MISSING'}`);

    console.log('\n[2] PRESS PHYSICS CONTRACT');
    if (mesh) {
        console.log(`  Screen Mesh:     ${mesh.meshTPI > 0 ? `${mesh.meshTPI} TPI` : 'None (1px pure mode)'}`);
        console.log(`  Rule of N:       ${mesh.ruleOfN.toFixed(1)}`);
        console.log(`  Min Dot Floor:   ${mesh.minDotPx > 0 ? `${mesh.minDotPx} px` : 'Off'}`);
    } else {
        console.log(`  Screen Mesh:     None`);
    }
    if (trap) {
        console.log(`  Trap Radius:     ${trap.trapPx > 0 ? `${trap.trapPx} px` : '0 px (untrapped)'}`);
    }
    console.log(`  Dual-Scale:      ${man.dualScale ? 'Enabled' : 'Disabled'}`);

    console.log('\n[3] TRAPPING AUDIT (INVARIANTS 1.1, 1.2, 1.3)');
    const trapAudits = (trap && (trap.screenAudits || trap.plateAudits)) || [];
    if (trapAudits.length > 0) {
        let totalTrapped = 0;
        let maxDilation = 0;
        for (const p of trapAudits) {
            totalTrapped += p.trappedPixels;
            if (p.maxDilation > maxDilation) maxDilation = p.maxDilation;
        }
        console.log(`  Status:          ${trap.compliant ? 'COMPLIANT' : 'VIOLATION DETECTED'}`);
        console.log(`  Trapped Pixels:  ${totalTrapped.toLocaleString()} px`);
        console.log(`  Max Dilation:    ${maxDilation.toFixed(2)} px (limit: ${(trap.trapPx + 0.5).toFixed(2)} px)`);
        console.log(`  Leak Count:      ${trap.errors.filter(e => e.includes('leaking')).length}`);
    } else {
        console.log('  Status:          SKIPPED (no separation screens)');
    }

    if (verbose && trapAudits.length > 0) {
        console.log('\n  Screen Trapping Detail:');
        for (const p of trapAudits) {
            console.log(`    • ${p.name.padEnd(32)} L=${String(Math.round(p.L)).padStart(3)} | Orig: ${String(p.originalPixels).padStart(8)} | Trap: ${String(p.trappedPixels).padStart(6)} | MaxDil: ${p.maxDilation.toFixed(1)}px`);
        }
    }

    console.log('\n[4] MESH PHYSICS AUDIT (INVARIANT 2)');
    const meshAudits = (mesh && (mesh.screenAudits || mesh.plateAudits)) || [];
    if (!mesh || mesh.skipped || meshAudits.length === 0) {
        console.log('  Status:          SKIPPED (0px / 1px pure mode or no screens)');
    } else {
        let totalDebris = 0;
        let totalPinch = 0;
        let totalComponents = 0;
        for (const p of meshAudits) {
            totalDebris += p.subMeshDebrisCount;
            totalPinch += p.pinchWarningsCount;
            totalComponents += p.totalComponents;
        }
        console.log(`  Status:          ${mesh.compliant ? 'COMPLIANT' : 'SUB-MESH DEBRIS DETECTED'}`);
        console.log(`  Physical Floor:  ${mesh.minDotPx} px (Inscribed R ≥ ${(mesh.minDotPx / 2).toFixed(1)} px)`);
        console.log(`  Total Shapes:    ${totalComponents.toLocaleString()} components`);
        console.log(`  Sub-Mesh Debris: ${totalDebris} isolated dots < floor`);
        console.log(`  Pinch Warnings:  ${totalPinch} stroke pinch points`);

        if (verbose && meshAudits.length > 0) {
            console.log('\n  Screen Mesh Detail:');
            for (const p of meshAudits) {
                console.log(`    • ${p.name.padEnd(32)} Dots: ${p.isolatedDotsCount} (Debris: ${p.subMeshDebrisCount}) | Strokes: ${p.continuousStrokesCount} (Pinch: ${p.pinchWarningsCount})`);
            }
        }
    }

    console.log('\n' + '─'.repeat(64));
    if (report.summary.errors.length > 0) {
        console.log(' FATAL DEFECTS:');
        for (const err of report.summary.errors) {
            console.log(`  ✗ ${err}`);
        }
    }
    if (report.summary.warnings.length > 0) {
        console.log(' WARNINGS:');
        for (const warn of report.summary.warnings) {
            console.log(`  ⚠ ${warn}`);
        }
    }

    console.log('─'.repeat(64));
    if (report.status === 'PASS') {
        console.log(' PRE-FLIGHT VERDICT: [PASS] READY FOR PRESS\n');
    } else if (report.status === 'WARN') {
        console.log(' PRE-FLIGHT VERDICT: [WARN] PRINTABLE WITH CAUTION\n');
    } else {
        console.log(' PRE-FLIGHT VERDICT: [FAIL] UNPRINTABLE ON PRESS\n');
    }
}

module.exports = {
    runVerify
};
