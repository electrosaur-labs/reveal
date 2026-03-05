/**
 * MechanicalFiltersAdapter - Thin adapter bridging reveal-adobe's flat-assignments
 * interface to @electrosaur-labs/core's MechanicalKnobs (which operates on masks + colorIndices).
 *
 * reveal-adobe's preview pipeline works with flat Uint8Array assignment arrays.
 * Core MechanicalKnobs needs per-color binary masks + colorIndices.
 * This adapter handles the conversion in both directions.
 */

const { MechanicalKnobs } = require('@electrosaur-labs/core');

/**
 * Apply shadowClamp via core MechanicalKnobs.
 * Builds temporary masks from assignments, runs tonal-aware edge erosion,
 * then returns the healed colorIndices as a new Uint8Array.
 *
 * @param {Uint8Array} assignments - Per-pixel palette index
 * @param {number} paletteSize - Number of palette entries
 * @param {number} clampPercent - shadowClamp value (0-40%)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Array<{L,a,b}>} [palette] - Lab palette (for tonal modulation)
 * @returns {Uint8Array} Processed assignments
 */
function applyShadowClamp(assignments, paletteSize, clampPercent, width, height, palette) {
    if (clampPercent <= 0) return assignments;

    // Without width/height/palette, fall back to the simple coverage-based approach
    // (legacy callers from PaletteEditor.rerunPosterization don't always have dimensions)
    if (!width || !height) {
        return _applyShadowClampSimple(assignments, paletteSize, clampPercent);
    }

    const pixelCount = width * height;
    const colorIndices = new Uint8Array(assignments);
    const masks = MechanicalKnobs.rebuildMasks(colorIndices, paletteSize, pixelCount);

    // Core needs a palette for tonal modulation; synthesize neutral if not provided
    const effectivePalette = palette || Array.from({ length: paletteSize }, () => ({ L: 50, a: 0, b: 0 }));

    MechanicalKnobs.applyShadowClamp(masks, colorIndices, effectivePalette, width, height, clampPercent);

    return colorIndices;
}

/**
 * Simple coverage-based shadowClamp fallback (matches the old MechanicalFilters behavior).
 * Used when width/height are not available.
 */
function _applyShadowClampSimple(assignments, paletteSize, clampPercent) {
    const clampThreshold = clampPercent / 100;
    const colorCounts = new Array(paletteSize).fill(0);
    for (let i = 0; i < assignments.length; i++) {
        colorCounts[assignments[i]]++;
    }

    const totalPixels = assignments.length;
    const thinColors = new Set();
    const strongColors = [];
    colorCounts.forEach((count, colorIdx) => {
        const coverage = count / totalPixels;
        if (coverage > 0 && coverage < clampThreshold) {
            thinColors.add(colorIdx);
        } else if (coverage > 0) {
            strongColors.push(colorIdx);
        }
    });

    if (thinColors.size === 0 || strongColors.length === 0) return assignments;

    const result = new Uint8Array(assignments.length);
    for (let i = 0; i < assignments.length; i++) {
        result[i] = thinColors.has(assignments[i]) ? strongColors[0] : assignments[i];
    }
    return result;
}

/**
 * Apply minVolume via core MechanicalKnobs.
 * Uses core's hue-sector-aware ghost plate removal.
 *
 * @param {Uint8Array} assignments - Per-pixel palette index
 * @param {Array<{L,a,b}>} labPalette - Lab palette
 * @param {number} minVolumePercent - Threshold (0-5%)
 * @returns {Uint8Array} Processed assignments
 */
function applyMinVolume(assignments, labPalette, minVolumePercent) {
    if (minVolumePercent <= 0) return assignments;

    const pixelCount = assignments.length;
    const colorIndices = new Uint8Array(assignments);

    MechanicalKnobs.applyMinVolume(colorIndices, labPalette, pixelCount, minVolumePercent);

    return colorIndices;
}

/**
 * Apply speckleRescue via core MechanicalKnobs.
 * Uses core's morphological despeckle + BFS orphan healing.
 *
 * @param {Uint8Array} assignments - Per-pixel palette index
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} thresholdPixels - Speckle size threshold (0-10px)
 * @param {Array<{L,a,b}>} [labPalette] - Lab palette (needed to determine palette size)
 * @returns {Uint8Array} Processed assignments
 */
function applySpeckleRescue(assignments, width, height, thresholdPixels, labPalette) {
    if (thresholdPixels <= 0) return assignments;

    const pixelCount = width * height;
    const colorIndices = new Uint8Array(assignments);

    // Determine palette size from max index in assignments
    let paletteSize = 0;
    if (labPalette) {
        paletteSize = labPalette.length;
    } else {
        for (let i = 0; i < pixelCount; i++) {
            if (colorIndices[i] >= paletteSize) paletteSize = colorIndices[i] + 1;
        }
    }

    const masks = MechanicalKnobs.rebuildMasks(colorIndices, paletteSize, pixelCount);

    MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, thresholdPixels);

    return colorIndices;
}

module.exports = {
    applyShadowClamp,
    applyMinVolume,
    applySpeckleRescue
};
