/**
 * verifier.js — Core Pre-Flight Separation Verification Engine
 *
 * Implements the mathematical prepress audit specifications defined in debate.md:
 * 1. Manifest v2.1 Schema Compliance
 * 2. Trapping Physics (Invariants 1.1, 1.2, 1.3 via EDT boundary dilation)
 * 3. Dot Retention & Filament Disambiguation (Invariant 2 via connected components & inscribed radius)
 */

'use strict';

const { euclideanDistanceTransform } = require('./edt');
const { labelConnectedComponents } = require('./connected-components');

/**
 * Execute full pre-flight audit on parsed separation data.
 *
 * @param {Object} parsed - Result from inspectPsd()
 * @param {Object} [options={}] - { strict: boolean }
 * @returns {Object} Comprehensive verification report
 */
function verifySeparation(parsed, options = {}) {
    const { width, height, dpi, manifest } = parsed;
    const screens = parsed.screens || parsed.plates || [];
    const plates = screens; // Alias for backwards compatibility
    const totalPixels = width * height;

    const report = {
        valid: true,
        status: 'PASS',
        document: {
            width,
            height,
            dpi,
            pixelCount: totalPixels,
            screenCount: screens.length,
            plateCount: screens.length // Alias for backwards compatibility
        },
        manifestAudit: null,
        trappingAudit: null,
        meshAudit: null,
        summary: {
            errors: [],
            warnings: []
        }
    };

    // ─────────────────────────────────────────────────────────────
    // Step 1: Manifest v2.1 Audit
    // ─────────────────────────────────────────────────────────────
    report.manifestAudit = auditManifest(manifest, screens, dpi);
    for (const err of report.manifestAudit.errors) {
        report.summary.errors.push(`[Manifest] ${err}`);
    }
    for (const warn of report.manifestAudit.warnings) {
        report.summary.warnings.push(`[Manifest] ${warn}`);
    }

    if (screens.length === 0) {
        report.summary.errors.push('No separation screens found in document layers');
        report.valid = false;
        report.status = 'FAIL';
        return report;
    }

    // Sort screens by Lightness descending (L0 > L1 > ... > L_darkest)
    const sortedScreens = screens.map((s, idx) => ({
        index: idx,
        name: s.name,
        color: s.color,
        L: s.color.L,
        mask: s.mask
    })).sort((a, b) => b.L - a.L);
    const sortedPlates = sortedScreens; // Alias for backwards compatibility

    // ─────────────────────────────────────────────────────────────
    // Step 2: Trapping Physics Audit (Invariant 1)
    // ─────────────────────────────────────────────────────────────
    const effectiveTrapPx = manifest ? (manifest.trapPx || 0) : 0;
    report.trappingAudit = auditTrapping(sortedPlates, width, height, effectiveTrapPx);

    for (const err of report.trappingAudit.errors) {
        report.summary.errors.push(`[Trapping] ${err}`);
    }
    for (const warn of report.trappingAudit.warnings) {
        report.summary.warnings.push(`[Trapping] ${warn}`);
    }

    // ─────────────────────────────────────────────────────────────
    // Step 3: Dot Retention & Mesh Physics Audit (Invariant 2)
    // ─────────────────────────────────────────────────────────────
    const effectiveMinDotPx = manifest ? (manifest.minDotPx || 0) : 0;
    const effectiveMeshTPI = manifest ? (manifest.meshSize || 0) : 0;
    const effectiveRuleOfN = manifest ? (manifest.ruleOfN || 7.0) : 7.0;

    report.meshAudit = auditMeshPhysics(
        sortedPlates,
        width,
        height,
        effectiveMinDotPx,
        effectiveMeshTPI,
        effectiveRuleOfN,
        dpi
    );

    for (const err of report.meshAudit.errors) {
        report.summary.errors.push(`[Mesh Physics] ${err}`);
    }
    for (const warn of report.meshAudit.warnings) {
        report.summary.warnings.push(`[Mesh Physics] ${warn}`);
    }

    // Final Status Determination
    if (report.summary.errors.length > 0) {
        report.valid = false;
        report.status = 'FAIL';
    } else if (report.summary.warnings.length > 0) {
        report.status = 'WARN';
    } else {
        report.status = 'PASS';
    }

    return report;
}

/**
 * Audit Manifest v2.1 Schema Compliance
 */
function auditManifest(manifest, screens, docDpi) {
    const screenList = screens || [];
    const res = {
        present: !!manifest,
        version: manifest ? manifest.manifestVersion : null,
        valid: true,
        errors: [],
        warnings: [],
        fields: manifest || {}
    };

    if (!manifest) {
        res.warnings.push('Document contains no embedded Reveal XMP metadata (unmanaged separation)');
        return res;
    }

    if (manifest.manifestVersion !== '2.1') {
        res.warnings.push(`Manifest version is ${manifest.manifestVersion} (expected 2.1)`);
    }

    const declaredCount = manifest.screenCount ?? manifest.plateCount ?? 0;
    if (declaredCount > 0 && declaredCount !== screenList.length) {
        res.errors.push(`Screen count mismatch: manifest declares ${declaredCount}, but file has ${screenList.length} layers`);
    }

    if (manifest.dpi && docDpi && Math.abs(manifest.dpi - docDpi) > 1) {
        res.warnings.push(`DPI mismatch: manifest declares ${manifest.dpi} DPI, but ResolutionInfo has ${docDpi} DPI`);
    }

    return res;
}

/**
 * Audit Trapping Invariants 1.1, 1.2, 1.3
 *
 * @param {Array<Object>} sortedPlates - Plates ordered Light to Dark
 * @param {number} width - Document width
 * @param {number} height - Document height
 * @param {number} maxTrapPx - Maximum allowable dilation radius
 * @param {Object} [options={}] - { originalMasks: Array<Uint8Array> }
 */
function auditTrapping(sortedPlates, width, height, maxTrapPx, options = {}) {
    const M = sortedPlates.length;
    const totalPixels = width * height;

    const res = {
        trapPx: maxTrapPx,
        compliant: true,
        errors: [],
        warnings: [],
        plateAudits: []
    };

    const hasExplicitOrig = options.originalMasks && options.originalMasks.length === M;

    // Reconstruct original untrapped ownership:
    const originalOwner = new Int16Array(totalPixels).fill(-1);

    if (hasExplicitOrig) {
        for (let p = 0; p < totalPixels; p++) {
            for (let i = 0; i < M; i++) {
                if (options.originalMasks[i][p] === 1) {
                    originalOwner[p] = i;
                    break;
                }
            }
        }
    } else {
        for (let p = 0; p < totalPixels; p++) {
            // Check from darkest to lightest: the darkest plate covering p was the original owner
            for (let i = M - 1; i >= 0; i--) {
                if (sortedPlates[i].mask[p] === 1) {
                    originalOwner[p] = i;
                    break;
                }
            }
        }
    }

    // Audit each plate
    for (let i = 0; i < M; i++) {
        const plate = sortedPlates[i];
        const isDarkest = (i === M - 1);

        let finalCount = 0;
        let originalCount = 0;
        let trappedCount = 0;
        let leakOntoLighter = 0;
        let leakOntoSubstrate = 0;
        let maxDilationFound = 0;
        let overDilationCount = 0;

        // Isolate trapped zone: Zone_trap(i) = Mask_final(i) \ Mask_original(i)
        const origMask = new Uint8Array(totalPixels);
        const trappedZone = [];

        if (hasExplicitOrig) {
            origMask.set(options.originalMasks[i]);
            for (let p = 0; p < totalPixels; p++) {
                const inFinal = plate.mask[p] === 1;
                const inOrig = origMask[p] === 1;

                if (inFinal) finalCount++;
                if (inOrig) originalCount++;

                if (inFinal && !inOrig) {
                    trappedCount++;
                    trappedZone.push(p);

                    const owner = originalOwner[p];
                    if (owner === -1) {
                        leakOntoSubstrate++;
                    } else if (owner < i) {
                        leakOntoLighter++;
                    }
                }
            }
        } else {
            for (let p = 0; p < totalPixels; p++) {
                const inFinal = plate.mask[p] === 1;
                const inOrig = (originalOwner[p] === i);

                if (inFinal) finalCount++;
                if (inOrig) {
                    originalCount++;
                    origMask[p] = 1;
                }

                if (inFinal && !inOrig) {
                    trappedCount++;
                    trappedZone.push(p);

                    // Invariant 1.1: Directional containment (must only exist on darker inks)
                    const owner = originalOwner[p];
                    if (owner === -1) {
                        leakOntoSubstrate++;
                    } else if (owner < i) {
                        leakOntoLighter++;
                    }
                }
            }
        }

        // Invariant 1.3: Zero reverse trapping on darkest ink
        if (isDarkest && trappedCount > 0) {
            res.errors.push(`Screen [${plate.name}] is the darkest ink but contains ${trappedCount} reverse-trapped pixels`);
            res.compliant = false;
        }

        if (leakOntoSubstrate > 0) {
            res.errors.push(`Screen [${plate.name}] has ${leakOntoSubstrate} trapped pixels leaking onto unprinted substrate`);
            res.compliant = false;
        }

        if (leakOntoLighter > 0) {
            res.errors.push(`Screen [${plate.name}] has ${leakOntoLighter} trapped pixels leaking under lighter ink`);
            res.compliant = false;
        }

        // Invariant 1.2: Dilation Radius Boundary (d <= trapPx + 0.5)
        if (trappedZone.length > 0 && originalCount > 0) {
            // Distance from trapped pixels (outside origMask) to original mask boundary
            // invert = true so that target pixels are where origMask > 0
            const distMap = euclideanDistanceTransform(origMask, width, height, true);
            const tolerance = maxTrapPx + 0.5;

            for (let k = 0; k < trappedZone.length; k++) {
                const p = trappedZone[k];
                const d = distMap[p];
                if (d > maxDilationFound) {
                    maxDilationFound = d;
                }
                if (maxTrapPx > 0 && d > tolerance) {
                    overDilationCount++;
                }
            }

            if (overDilationCount > 0) {
                res.errors.push(`Screen [${plate.name}] exceeds trap dilation limit: max dilation is ${maxDilationFound.toFixed(2)}px (limit: ${tolerance.toFixed(2)}px, ${overDilationCount} over-dilated pixels)`);
                res.compliant = false;
            }
        }

        const screenAudit = {
            name: plate.name,
            L: plate.L,
            finalPixels: finalCount,
            originalPixels: originalCount,
            trappedPixels: trappedCount,
            maxDilation: maxDilationFound,
            leakOntoLighter,
            leakOntoSubstrate,
            overDilationCount
        };
        if (!res.screenAudits) {
            res.screenAudits = [];
            res.plateAudits = res.screenAudits; // Deprecated alias
        }
        res.screenAudits.push(screenAudit);
    }

    return res;
}

/**
 * Audit Physical Mesh Dot Retention & Line Art Continuity (Invariant 2)
 */
function auditMeshPhysics(sortedPlates, width, height, minDotPx, meshTPI, ruleOfN, dpi) {
    const floorPx = minDotPx > 0
        ? minDotPx
        : (meshTPI > 0 ? Math.ceil(ruleOfN * dpi / meshTPI) : 0);

    const res = {
        meshTPI,
        ruleOfN,
        minDotPx: floorPx,
        skipped: floorPx <= 0,
        compliant: true,
        errors: [],
        warnings: [],
        plateAudits: []
    };

    if (floorPx <= 0) {
        return res; // 1px mode (mesh size = 0)
    }

    const minInscribedRadius = floorPx / 2;
    const isolatedDiagonalThreshold = 2 * floorPx;

    for (let i = 0; i < sortedPlates.length; i++) {
        const plate = sortedPlates[i];
        const components = labelConnectedComponents(plate.mask, width, height);

        let isolatedDotsCount = 0;
        let subMeshDebrisCount = 0;
        let continuousStrokesCount = 0;
        let pinchWarningsCount = 0;

        for (let c = 0; c < components.length; c++) {
            const comp = components[c];

            if (comp.bboxDiagonal < isolatedDiagonalThreshold) {
                // Case A: Isolated Dot
                isolatedDotsCount++;
                if (comp.inscribedRadius < minInscribedRadius) {
                    subMeshDebrisCount++;
                }
            } else {
                // Case B: Continuous Stroke / Line Art
                continuousStrokesCount++;
                if (comp.maxPinchRunLength > 3) {
                    pinchWarningsCount++;
                }
            }
        }

        if (subMeshDebrisCount > 0) {
            res.errors.push(`Screen [${plate.name}] contains ${subMeshDebrisCount} sub-mesh debris dots smaller than physical floor (${floorPx}px / R<${minInscribedRadius.toFixed(1)}px)`);
            res.compliant = false;
        }

        if (pinchWarningsCount > 0) {
            res.warnings.push(`Screen [${plate.name}] contains ${pinchWarningsCount} continuous strokes with pinch points (<1.0px run >3px) prone to press starvation`);
        }

        const screenAudit = {
            name: plate.name,
            totalComponents: components.length,
            isolatedDotsCount,
            subMeshDebrisCount,
            continuousStrokesCount,
            pinchWarningsCount
        };
        if (!res.screenAudits) {
            res.screenAudits = [];
            res.plateAudits = res.screenAudits; // Deprecated alias
        }
        res.screenAudits.push(screenAudit);
    }

    return res;
}

module.exports = {
    verifySeparation,
    auditManifest,
    auditTrapping,
    auditMeshPhysics
};
