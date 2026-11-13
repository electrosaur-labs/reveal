/**
 * MeshPhysics - Single source of truth for screen-mesh dot-size physics.
 *
 * Rule of 7: an isolated printed element narrower than ~7 mesh openings
 * will not hold ink reliably — it either washes out (strains through) or
 * clogs the screen. This constant governs both:
 *   - SeparationEngine's Macro-Cell dithering (dot formation)
 *   - MechanicalKnobs.applySpeckleRescue (post-separation enforcement)
 *
 * Both subsystems must agree on this number; it is defined once here so
 * they can't drift apart.
 *
 * @module MeshPhysics
 */

const PRINT_FACTOR = 7;
const DEFAULT_RULE_OF_N = 7.0;
const DEFAULT_MESH_TPI = 355;
const DEFAULT_DPI = 300;

/**
 * Minimum linear dot dimension (in pixels) that spans ruleOfN mesh
 * openings, given a screen mesh count and image resolution.
 *
 * Falls back to the studio's default equipment (355 TPI / 300 DPI — the
 * same defaults used elsewhere in this codebase, e.g. ParameterGenerator's
 * KNOB_DEFAULTS.PRODUCTION) when the caller doesn't know its press/image
 * specifics.
 *
 * @param {number} [meshTPI] - Screen mesh threads-per-inch (e.g. 230, 305, 355)
 * @param {number} [dpi] - Image resolution in dots-per-inch
 * @param {number} [ruleOfN=7.0] - Mesh factor N (openings per dot, e.g. 4.0 to 10.0)
 * @returns {number} Minimum dot diameter, in pixels (always >= 1)
 */
function minDotPx(meshTPI, dpi, ruleOfN = PRINT_FACTOR) {
    const tpi = meshTPI > 0 ? meshTPI : DEFAULT_MESH_TPI;
    const d = dpi > 0 ? dpi : DEFAULT_DPI;
    const n = (typeof ruleOfN === 'number' && ruleOfN > 0) ? ruleOfN : DEFAULT_RULE_OF_N;
    return Math.max(1, Math.ceil(n * d / tpi));
}

module.exports = { PRINT_FACTOR, DEFAULT_RULE_OF_N, DEFAULT_MESH_TPI, DEFAULT_DPI, minDotPx };
