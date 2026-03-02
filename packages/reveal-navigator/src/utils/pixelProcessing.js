/**
 * Shared pixel processing utilities for Navigator preview rendering.
 *
 * Contains constants and functions used by both SessionState (proxy preview)
 * and Loupe (native-res tile preview) to avoid code duplication.
 */

// ─── Color Constants ─────────────────────────────────────

/** Dim color for non-highlighted / non-captured pixels (#282828) */
const DIM_COLOR = 0x28;

/** Background color for radar/panel (#323232) */
const BG_COLOR = 0x32;

// ─── 16-bit Lab Encoding ─────────────────────────────────

const L_SCALE = 327.68;
const AB_NEUTRAL = 16384;
const AB_SCALE = 128;

// ─── Suggestion Ghost ────────────────────────────────────

/**
 * Apply suggestion ghost coloring to an RGBA buffer in-place.
 *
 * For each pixel, compares the distance to the suggested color vs. the
 * distance to the pixel's current palette assignment. Pixels closer to
 * the suggestion are recolored to sugRgb; others keep existing color
 * (integrated mode) or dim to DIM_COLOR (solo mode).
 *
 * Used by both SessionState.generateSuggestionGhostPreview() and
 * Loupe._applySuggestionGhost() — identical algorithm, different pixel sources.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba - RGBA output buffer (mutated in place)
 * @param {number} pixelCount - Number of pixels (width × height)
 * @param {Uint16Array} labPixels - 16-bit Lab pixel data (3 values per pixel: L, a, b)
 * @param {Uint8Array} colorIndices - Per-pixel palette index
 * @param {Array<{L: number, a: number, b: number}>} labPalette - Lab palette colors
 * @param {{L: number, a: number, b: number}} ghostLab - Suggested color in Lab
 * @param {{r: number, g: number, b: number}} sugRgb - Suggested color in RGB
 * @param {boolean} solo - true = dim non-captured pixels; false = keep palette color
 */
function applySuggestionGhost(rgba, pixelCount, labPixels, colorIndices, labPalette, ghostLab, sugRgb, solo) {
    for (let i = 0; i < pixelCount; i++) {
        const off3 = i * 3;
        const off4 = i * 4;

        const pL = labPixels[off3] / L_SCALE;
        const pa = (labPixels[off3 + 1] - AB_NEUTRAL) / AB_SCALE;
        const pb = (labPixels[off3 + 2] - AB_NEUTRAL) / AB_SCALE;

        // Distance to suggestion
        const dSL = pL - ghostLab.L;
        const dSA = pa - ghostLab.a;
        const dSB = pb - ghostLab.b;
        const distSug = dSL * dSL + dSA * dSA + dSB * dSB;

        // Distance to current palette assignment
        const ci = colorIndices[i];
        const assigned = labPalette[ci];
        if (!assigned) continue;
        const dAL = pL - assigned.L;
        const dAA = pa - assigned.a;
        const dAB = pb - assigned.b;
        const distPal = dAL * dAL + dAA * dAA + dAB * dAB;

        if (distSug < distPal) {
            rgba[off4]     = sugRgb.r;
            rgba[off4 + 1] = sugRgb.g;
            rgba[off4 + 2] = sugRgb.b;
        } else if (solo) {
            rgba[off4]     = DIM_COLOR;
            rgba[off4 + 1] = DIM_COLOR;
            rgba[off4 + 2] = DIM_COLOR;
        }
        // else: keep existing palette RGB (already in buffer)
    }
}

module.exports = {
    DIM_COLOR,
    BG_COLOR,
    applySuggestionGhost
};
