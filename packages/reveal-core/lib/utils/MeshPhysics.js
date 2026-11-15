/**
 * MeshPhysics - Single source of truth for screen-mesh dot-size physics.
 *
 * Rule of 7: an isolated printed element narrower than ~7 mesh openings
 * will not hold ink reliably — it either washes out (strains through) or
 * clogs the screen. This module governs both:
 *   - SeparationEngine's Macro-Cell dithering (dot formation)
 *   - MechanicalKnobs.applySpeckleRescue & enforceMeshRuleOfSeven (post-separation enforcement)
 *
 * Supports paired SAATI plain-weave polyester (TPI - µm) catalog presets
 * with open-area aperture scaling anchored to the 230-48 (32% open) press-room
 * baseline, while preserving 100% backward compatibility when threadDiaUm is
 * omitted or 0.
 *
 * @module MeshPhysics
 */

const PRINT_FACTOR = 7;
const DEFAULT_RULE_OF_N = 7.0;
const DEFAULT_MESH_TPI = 355;
const DEFAULT_THREAD_UM = 31;
const DEFAULT_DPI = 300;
const UM_PER_INCH = 25400;

/**
 * Standard monofilament plain-weave polyester catalog defaults: meshTpi -> threadDiaUm.
 * Note: 355 defaults to 31 µm matching Reveal's studio default 355-31 (32% open · Hi-R).
 */
const STANDARD_THREAD_UM = Object.freeze({
    110: 80,
    156: 64,
    196: 55,
    200: 55,
    230: 48,
    280: 40,
    305: 34,
    355: 31,
    380: 31,
    420: 27,
});

const STANDARD_MESH_TPI = Object.freeze(
    Object.keys(STANDARD_THREAD_UM)
        .map(Number)
        .sort((a, b) => a - b)
);

function createMeshPreset(meshTpi, threadDiaUm, hiR = false) {
    const pitchUm = UM_PER_INCH / meshTpi;
    const openPct = Math.round(Math.pow((pitchUm - threadDiaUm) / pitchUm, 2) * 100);
    const id = `${meshTpi}-${threadDiaUm}`;
    const tag = hiR ? `${openPct}% open · Hi-R` : `${openPct}% open`;
    return Object.freeze({
        id,
        meshTpi,
        threadDiaUm,
        openAreaPct: openPct,
        label: `${id} (${tag})`,
    });
}

/**
 * Official SAATI plain-weave polyester monofilament (TPI - µm) catalog pairs.
 */
const SAATI_MESH_PRESETS = Object.freeze([
    createMeshPreset(110, 80, false),
    createMeshPreset(110, 70, true),
    createMeshPreset(156, 64, false),
    createMeshPreset(156, 48, true),
    createMeshPreset(196, 55, false),
    createMeshPreset(196, 48, true),
    createMeshPreset(230, 48, false),
    createMeshPreset(230, 40, true),
    createMeshPreset(280, 40, false),
    createMeshPreset(280, 34, true),
    createMeshPreset(280, 31, true),
    createMeshPreset(305, 40, false),
    createMeshPreset(305, 34, false),
    createMeshPreset(305, 31, true),
    createMeshPreset(355, 34, false),
    createMeshPreset(355, 31, true),
    createMeshPreset(380, 34, false),
    createMeshPreset(380, 31, true),
    createMeshPreset(420, 31, false),
    createMeshPreset(420, 27, true),
]);

/**
 * Open-area reference baseline anchored to 230 TPI / 48 µm:
 *   pitch_230 = 25400 / 230 ≈ 110.4348 µm
 *   F_OPEN_REF = ((pitch_230 - 48) / pitch_230)^2 ≈ 0.319626
 */
const PITCH_230 = UM_PER_INCH / 230;
const F_OPEN_REF = Math.pow((PITCH_230 - 48) / PITCH_230, 2);

/**
 * Look up standard thread diameter (µm) for a given mesh count (TPI).
 * Returns 0 when meshTpi <= 0 or non-finite.
 *
 * @param {number} meshTpi
 * @returns {number}
 */
function getDefaultThreadDiaUm(meshTpi) {
    if (!Number.isFinite(meshTpi) || meshTpi <= 0) {
        return 0;
    }
    const rounded = Math.round(meshTpi);
    if (Object.prototype.hasOwnProperty.call(STANDARD_THREAD_UM, rounded) && Math.abs(meshTpi - rounded) < 1e-6) {
        return STANDARD_THREAD_UM[rounded];
    }
    const pitchUm = UM_PER_INCH / meshTpi;
    return Math.max(15, Math.round((1 - Math.sqrt(F_OPEN_REF)) * pitchUm));
}

/**
 * Compute fractional open area ((pitch - threadDia) / pitch)^2 for a plain-weave mesh.
 *
 * @param {number} meshTpi
 * @param {number} threadDiaUm
 * @returns {number} Open area fraction in [0, 1)
 */
function computeOpenArea(meshTpi, threadDiaUm) {
    if (!Number.isFinite(meshTpi) || meshTpi <= 0) return 0;
    const tdia = (Number.isFinite(threadDiaUm) && threadDiaUm > 0)
        ? threadDiaUm
        : getDefaultThreadDiaUm(meshTpi);
    const pitchUm = UM_PER_INCH / meshTpi;
    if (!(tdia > 0) || tdia >= pitchUm) return 0;
    return Math.pow((pitchUm - tdia) / pitchUm, 2);
}

/**
 * Minimum linear dot dimension (in pixels) that spans ruleOfN mesh
 * openings, given a screen mesh count, image resolution, and optional
 * thread diameter (µm).
 *
 * Falls back to the studio's default equipment (355 TPI / 300 DPI) when
 * meshTPI or dpi are omitted/zero. When threadDiaUm is omitted or <= 0,
 * openAreaScale = 1.0 (preserving exact legacy 0/1/2/3-arg behavior).
 *
 * @param {number} [meshTPI] - Screen mesh threads-per-inch (e.g. 230, 305, 355)
 * @param {number} [dpi] - Image resolution in dots-per-inch
 * @param {number} [ruleOfN=7.0] - Mesh factor N (openings per dot, e.g. 4.0 to 10.0)
 * @param {number} [threadDiaUm=0] - Thread diameter in µm (0 = unscaled TPI-only formula)
 * @returns {number} Minimum dot diameter, in pixels (always >= 1)
 */
function minDotPx(meshTPI, dpi, ruleOfN = PRINT_FACTOR, threadDiaUm = 0) {
    const tpi = meshTPI > 0 ? meshTPI : DEFAULT_MESH_TPI;
    const d = dpi > 0 ? dpi : DEFAULT_DPI;
    const n = (typeof ruleOfN === 'number' && ruleOfN > 0) ? ruleOfN : DEFAULT_RULE_OF_N;
    if (typeof threadDiaUm === 'number' && threadDiaUm > 0) {
        const pitchUm = UM_PER_INCH / tpi;
        if (threadDiaUm < pitchUm) {
            const openArea = Math.max(0.02, Math.pow((pitchUm - threadDiaUm) / pitchUm, 2));
            const openAreaScale = Math.sqrt(F_OPEN_REF / openArea);
            return Math.max(1, Math.ceil((n * d / tpi) * openAreaScale - 1e-9));
        }
    }
    return Math.max(1, Math.ceil(n * d / tpi));
}

module.exports = {
    PRINT_FACTOR,
    DEFAULT_RULE_OF_N,
    DEFAULT_MESH_TPI,
    DEFAULT_THREAD_UM,
    DEFAULT_DPI,
    UM_PER_INCH,
    STANDARD_THREAD_UM,
    STANDARD_MESH_TPI,
    SAATI_MESH_PRESETS,
    F_OPEN_REF,
    getDefaultThreadDiaUm,
    computeOpenArea,
    minDotPx,
};
