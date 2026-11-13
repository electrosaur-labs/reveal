/**
 * verify.test.js — Comprehensive Pre-Flight Separation Verification Test Suite
 *
 * Covers:
 * 1. Exact Euclidean Distance Transform (EDT)
 * 2. 8-Connected Components & Inscribed Disk Radius
 * 3. Manifest v2.1 Audit & Invariant Checks
 * 4. Trapping Invariants 1.1, 1.2, 1.3 (Directional Containment, Dilation Radius, Zero Reverse Trap)
 * 5. Physical Mesh Physics Invariant 2 (Dot Retention & Filament Disambiguation)
 * 6. End-to-End Separation Audit
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { euclideanDistanceTransform } = require('../../src/verify/edt');
const { labelConnectedComponents } = require('../../src/verify/connected-components');
const { parseRevealManifest } = require('../../src/verify/psd-inspector');
const { verifySeparation, auditTrapping, auditMeshPhysics } = require('../../src/verify/verifier');

describe('Euclidean Distance Transform (EDT)', () => {
    it('computes exact Euclidean distance from a single target point', () => {
        const w = 5, h = 5;
        const grid = new Uint8Array(w * h).fill(1);
        grid[0] = 0; // Target at (0, 0)

        const dist = euclideanDistanceTransform(grid, w, h, false);

        expect(dist[0]).toBeCloseTo(0.0, 5);
        expect(dist[1]).toBeCloseTo(1.0, 5); // (1, 0)
        expect(dist[w]).toBeCloseTo(1.0, 5); // (0, 1)
        expect(dist[w + 1]).toBeCloseTo(Math.SQRT2, 5); // (1, 1)
        expect(dist[4 * w + 3]).toBeCloseTo(5.0, 5); // (3, 4) -> 3^2 + 4^2 = 25 -> 5.0
    });

    it('handles inverted target calculation', () => {
        const w = 4, h = 4;
        const grid = new Uint8Array(w * h).fill(0);
        grid[0] = 1; // Target at (0, 0)

        const dist = euclideanDistanceTransform(grid, w, h, true);
        expect(dist[0]).toBeCloseTo(0.0, 5);
        expect(dist[1]).toBeCloseTo(1.0, 5);
        expect(dist[w + 1]).toBeCloseTo(Math.SQRT2, 5);
    });
});

describe('Connected Components & Inscribed Radius', () => {
    it('identifies 8-connected components and calculates inscribed radius', () => {
        const w = 12, h = 12;
        const mask = new Uint8Array(w * h);

        // Component 1: 4x4 square at (1, 1)
        for (let y = 1; y <= 4; y++) {
            for (let x = 1; x <= 4; x++) {
                mask[y * w + x] = 1;
            }
        }

        // Component 2: 1x8 horizontal stroke at y=8, x=2..9
        for (let x = 2; x <= 9; x++) {
            mask[8 * w + x] = 1;
        }

        const comps = labelConnectedComponents(mask, w, h);
        expect(comps).toHaveLength(2);

        // Sort by minX
        comps.sort((a, b) => a.minX - b.minX);

        const square = comps[0];
        expect(square.width).toBe(4);
        expect(square.height).toBe(4);
        expect(square.pixelCount).toBe(16);
        expect(square.inscribedRadius).toBeGreaterThanOrEqual(2.0);

        const stroke = comps[1];
        expect(stroke.width).toBe(8);
        expect(stroke.height).toBe(1);
        expect(stroke.pixelCount).toBe(8);
        expect(stroke.inscribedRadius).toBeCloseTo(1.0, 1);
    });
});

describe('Manifest v2.1 Parser', () => {
    it('extracts all v2.1 fields and palette sequences correctly', () => {
        const xml = `
            <x:xmpmeta xmlns:x="adobe:ns:meta/">
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                    <rdf:Description xmlns:reveal="http://electrosaur.org/reveal/2.1/">
                        <reveal:manifestVersion>2.1</reveal:manifestVersion>
                        <reveal:dpi>300</reveal:dpi>
                        <reveal:meshSize>355</reveal:meshSize>
                        <reveal:ruleOfN>7.0</reveal:ruleOfN>
                        <reveal:minDotPx>6</reveal:minDotPx>
                        <reveal:trapSize>2</reveal:trapSize>
                        <reveal:trapPx>8</reveal:trapPx>
                        <reveal:dualScale>true</reveal:dualScale>
                        <reveal:plateCount>3</reveal:plateCount>
                        <reveal:palette>
                            <rdf:Seq>
                                <rdf:li>#FFFFFF L=100 a=0 b=0 60%</rdf:li>
                                <rdf:li>#E0A030 L=70 a=20 b=65 25%</rdf:li>
                                <rdf:li>#000000 L=0 a=0 b=0 15%</rdf:li>
                            </rdf:Seq>
                        </reveal:palette>
                    </rdf:Description>
                </rdf:RDF>
            </x:xmpmeta>
        `;

        const m = parseRevealManifest(xml);
        expect(m).not.toBeNull();
        expect(m.manifestVersion).toBe('2.1');
        expect(m.dpi).toBe(300);
        expect(m.meshSize).toBe(355);
        expect(m.ruleOfN).toBe(7.0);
        expect(m.minDotPx).toBe(6);
        expect(m.trapPx).toBe(8);
        expect(m.dualScale).toBe(true);
        expect(m.plateCount).toBe(3);
        expect(m.palette).toHaveLength(3);
        expect(m.palette[1].hex).toBe('#E0A030');
        expect(m.palette[1].L).toBe(70);
    });
});

describe('Trapping Physics Audit (Invariants 1.1, 1.2, 1.3)', () => {
    const w = 10, h = 10;

    it('passes when light ink is trapped under darker ink within dilation limit', () => {
        // Plate 0 (Light): L=80, covers x=0..4 originally, dilated into x=5 by 1px
        const maskLight = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x <= 5; x++) maskLight[y * w + x] = 1;
        }

        // Plate 1 (Dark): L=20, covers x=5..9 originally
        const maskDark = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 5; x <= 9; x++) maskDark[y * w + x] = 1;
        }

        const plates = [
            { name: 'Light', L: 80, mask: maskLight },
            { name: 'Dark', L: 20, mask: maskDark }
        ];

        // Max trap is 1px
        const audit = auditTrapping(plates, w, h, 1);
        expect(audit.compliant).toBe(true);
        expect(audit.errors).toHaveLength(0);
        expect(audit.plateAudits[0].trappedPixels).toBe(10); // 1 column of 10 pixels trapped
        expect(audit.plateAudits[0].maxDilation).toBeCloseTo(1.0, 1);
        expect(audit.plateAudits[1].trappedPixels).toBe(0); // Darkest has 0 trapped pixels
    });

    it('fails Invariant 1.3 when the darkest ink contains reverse-trapped pixels', () => {
        const maskLight = new Uint8Array(w * h);
        const maskDark = new Uint8Array(w * h);
        const origLight = new Uint8Array(w * h);
        const origDark = new Uint8Array(w * h);

        origLight[0] = 1; maskLight[0] = 1;
        origDark[1] = 1; maskDark[1] = 1;
        // Dark plate traps into light territory (reverse trap)
        maskDark[0] = 1;

        const plates = [
            { name: 'Light', L: 80, mask: maskLight },
            { name: 'Dark', L: 20, mask: maskDark }
        ];

        const audit = auditTrapping(plates, w, h, 1, { originalMasks: [origLight, origDark] });
        expect(audit.compliant).toBe(false);
        expect(audit.errors.some(e => e.includes('reverse-trapped'))).toBe(true);
    });

    it('fails Invariant 1.1 when trapped pixels leak onto unprinted substrate', () => {
        const maskLight = new Uint8Array(w * h);
        const maskDark = new Uint8Array(w * h);
        const origLight = new Uint8Array(w * h);
        const origDark = new Uint8Array(w * h);

        // Light ink originally at (0, 0)
        origLight[0] = 1; maskLight[0] = 1;
        // Dark ink originally at (5, 5)
        origDark[5 * w + 5] = 1; maskDark[5 * w + 5] = 1;
        // Light ink dilated to (0, 1) where NO ink exists (substrate leak)
        maskLight[1] = 1;

        const plates = [
            { name: 'Light', L: 80, mask: maskLight },
            { name: 'Dark', L: 20, mask: maskDark }
        ];

        const audit = auditTrapping(plates, w, h, 1, { originalMasks: [origLight, origDark] });
        expect(audit.compliant).toBe(false);
        expect(audit.errors.some(e => e.includes('substrate'))).toBe(true);
    });

    it('fails Invariant 1.2 when trapped pixels exceed dilation limit (r + 0.5px)', () => {
        const maskLight = new Uint8Array(w * h);
        const maskDark = new Uint8Array(w * h);
        const origLight = new Uint8Array(w * h);
        const origDark = new Uint8Array(w * h);

        // Light ink originally at x=0
        origLight[0] = 1;
        for (let x = 0; x <= 4; x++) maskLight[x] = 1;

        // Dark ink originally at x=1..9
        for (let x = 1; x < 10; x++) {
            origDark[x] = 1;
            maskDark[x] = 1;
        }

        const plates = [
            { name: 'Light', L: 80, mask: maskLight },
            { name: 'Dark', L: 20, mask: maskDark }
        ];

        const audit = auditTrapping(plates, w, h, 1, { originalMasks: [origLight, origDark] }); // trap limit = 1px, max dilation = 4px
        expect(audit.compliant).toBe(false);
        expect(audit.errors.some(e => e.includes('dilation limit'))).toBe(true);
    });
});

describe('Mesh Physics Audit (Invariant 2)', () => {
    const w = 20, h = 20;
    const floorPx = 6; // floor = 6px, minInscribedRadius = 3.0px

    it('fails when isolated dot has inscribed radius < floorPx / 2 (Fatal Sub-Mesh Debris)', () => {
        const mask = new Uint8Array(w * h);

        // Isolated 2x2 dot at (2, 2) -> diagonal = 2.83 < 2*floorPx (12) -> Isolated Dot
        // Inscribed radius = 1.0 < 3.0 -> FAILS!
        mask[2 * w + 2] = 1; mask[2 * w + 3] = 1;
        mask[3 * w + 2] = 1; mask[3 * w + 3] = 1;

        const plates = [{ name: 'Plate 1', L: 50, mask }];
        const audit = auditMeshPhysics(plates, w, h, floorPx, 355, 7.0, 300);

        expect(audit.compliant).toBe(false);
        expect(audit.plateAudits[0].subMeshDebrisCount).toBe(1);
        expect(audit.errors.some(e => e.includes('sub-mesh debris'))).toBe(true);
    });

    it('passes when isolated dot satisfies inscribed radius >= floorPx / 2', () => {
        const mask = new Uint8Array(w * h);

        // 6x6 square dot at (2, 2) -> diagonal = 8.48 < 12 -> Isolated Dot
        // Inscribed radius >= 3.0 -> PASSES!
        for (let y = 2; y <= 7; y++) {
            for (let x = 2; x <= 7; x++) {
                mask[y * w + x] = 1;
            }
        }

        const plates = [{ name: 'Plate 1', L: 50, mask }];
        const audit = auditMeshPhysics(plates, w, h, floorPx, 355, 7.0, 300);

        expect(audit.compliant).toBe(true);
        expect(audit.plateAudits[0].subMeshDebrisCount).toBe(0);
        expect(audit.errors).toHaveLength(0);
    });

    it('treats long thin strokes as continuous line art under Dual-Scale without fatal error', () => {
        const mask = new Uint8Array(w * h);

        // 1x14 horizontal stroke at y=10, x=2..15 -> diagonal = 14.03 >= 12 -> Continuous Stroke
        for (let x = 2; x <= 15; x++) {
            mask[10 * w + x] = 1;
        }

        const plates = [{ name: 'Plate 1', L: 50, mask }];
        const audit = auditMeshPhysics(plates, w, h, floorPx, 355, 7.0, 300);

        // Continuous strokes do NOT fail with fatal debris error
        expect(audit.compliant).toBe(true);
        expect(audit.plateAudits[0].subMeshDebrisCount).toBe(0);
        expect(audit.plateAudits[0].continuousStrokesCount).toBe(1);
        // But raises a press starvation warning because thickness < 1.0 over run length > 3
        expect(audit.plateAudits[0].pinchWarningsCount).toBe(1);
        expect(audit.warnings.some(w => w.includes('pinch points'))).toBe(true);
    });

    it('skips mesh checks when minDotPx is 0 (1px pure mode)', () => {
        const mask = new Uint8Array(w * h);
        mask[0] = 1; // 1px dot

        const plates = [{ name: 'Plate 1', L: 50, mask }];
        const audit = auditMeshPhysics(plates, w, h, 0, 0, 7.0, 300);

        expect(audit.skipped).toBe(true);
        expect(audit.compliant).toBe(true);
        expect(audit.errors).toHaveLength(0);
    });
});

describe('Full Separation Verification Pipeline', () => {
    it('produces PASS report for fully compliant separation', () => {
        const w = 10, h = 10;
        const mask1 = new Uint8Array(w * h);
        const mask2 = new Uint8Array(w * h);

        // Clean partition: Plate 1 (x=0..4), Plate 2 (x=5..9)
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < 5; x++) mask1[y * w + x] = 1;
            for (let x = 5; x < 10; x++) mask2[y * w + x] = 1;
        }

        const parsed = {
            width: w,
            height: h,
            dpi: 300,
            manifest: {
                manifestVersion: '2.1',
                dpi: 300,
                plateCount: 2,
                trapPx: 0,
                minDotPx: 0, // 1px mode
                meshSize: 0,
                ruleOfN: 7.0,
                dualScale: true
            },
            plates: [
                { name: 'Light', color: { L: 80, a: 0, b: 0 }, mask: mask1 },
                { name: 'Dark', color: { L: 20, a: 0, b: 0 }, mask: mask2 }
            ]
        };

        const report = verifySeparation(parsed);
        expect(report.valid).toBe(true);
        expect(report.status).toBe('PASS');
        expect(report.summary.errors).toHaveLength(0);
    });

    it('executes CLI command via bin/reveal.js and returns valid JSON report', () => {
        const { execSync } = require('child_process');
        const path = require('path');
        const cliPath = path.resolve(__dirname, '../../bin/reveal.js');
        const fixturePath = path.resolve(__dirname, '../../../reveal-psd-writer/test-output/test-multiple-masks.psd');
        const cmd = `node "${cliPath}" verify "${fixturePath}" --json`;
        const stdout = execSync(cmd, { encoding: 'utf8' });
        const report = JSON.parse(stdout);
        expect(report.document.plateCount).toBe(3);
        expect(report.trappingAudit.compliant).toBe(true);
    });
});
