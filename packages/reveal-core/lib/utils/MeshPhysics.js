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
const DEFAULT_MESH_TPI = 230;
const DEFAULT_DPI = 300;

/**
 * Minimum linear dot dimension (in pixels) that spans PRINT_FACTOR mesh
 * openings, given a screen mesh count and image resolution.
 *
 * Falls back to industry-standard defaults (230 TPI / 300 DPI — the same
 * defaults used elsewhere in this codebase, e.g. ParameterGenerator's
 * KNOB_DEFAULTS.PRODUCTION) when the caller doesn't know its press/image
 * specifics. This is intentional: the Rule of 7 is a hard physical
 * constraint, not an opt-in preference, so callers that omit mesh/dpi
 * still get a physically sane floor rather than no enforcement at all.
 *
 * @param {number} [meshTPI] - Screen mesh threads-per-inch (e.g. 230, 305)
 * @param {number} [dpi] - Image resolution in dots-per-inch
 * @returns {number} Minimum dot diameter, in pixels (always >= 1)
 */
function minDotPx(meshTPI, dpi) {
    const tpi = meshTPI > 0 ? meshTPI : DEFAULT_MESH_TPI;
    const d = dpi > 0 ? dpi : DEFAULT_DPI;
    return Math.max(1, Math.ceil(PRINT_FACTOR * d / tpi));
}

module.exports = { PRINT_FACTOR, DEFAULT_MESH_TPI, DEFAULT_DPI, minDotPx };
