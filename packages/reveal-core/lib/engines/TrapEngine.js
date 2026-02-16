/**
 * TrapEngine - Color Trapping for Screen Print Separations
 *
 * Expands lighter colors under darker colors to prevent white gaps
 * from press misregistration. Works directly on single-channel binary
 * masks (255/0) — no RGBA conversion needed.
 *
 * Algorithm (identical to trapper-photoshop, adapted for Lab masks):
 *   1. Sort palette indices by Lab L descending (lightest first)
 *   2. Skip white (L >= 98) — paper/substrate doesn't trap
 *   3. Darkest color gets 0 trap (defines sharp edges)
 *   4. Linear interpolation: trapPx = round(maxTrap * (1 - pos / (total - 1)))
 *   5. For each color: build darker mask, dilate into it
 *   6. Dilation: iterative 4-connected, double-buffered, early termination
 *
 * DESIGN: Pure JS, static methods, no I/O, no Photoshop dependencies.
 * Applied AFTER all other knobs (minVolume, speckleRescue, shadowClamp),
 * BEFORE layer creation. Production-only — NOT in 512px proxy preview
 * (trap pixel sizes are resolution-dependent).
 *
 * @module TrapEngine
 */

class TrapEngine {

    /**
     * Main entry point. Modifies masks in place.
     *
     * @param {Array<Uint8Array>} masks - Per-color binary masks (255=ink, 0=no ink)
     * @param {Array<{L, a, b}>} labPalette - Lab colors for lightness sorting
     * @param {number} width - Image width in pixels
     * @param {number} height - Image height in pixels
     * @param {number} maxTrapPixels - Maximum trap expansion (0=off, 1-10 typical)
     * @returns {{trappedCount: number, trapSizes: Array<{index: number, trapPx: number}>}}
     */
    static applyTrapping(masks, labPalette, width, height, maxTrapPixels) {
        if (maxTrapPixels <= 0 || !masks || masks.length === 0) {
            return { trappedCount: 0, trapSizes: [] };
        }

        const paletteSize = labPalette.length;

        // Sort palette indices by L descending (lightest first)
        const sortedIndices = [];
        for (let i = 0; i < paletteSize; i++) {
            sortedIndices.push(i);
        }
        sortedIndices.sort((a, b) => labPalette[b].L - labPalette[a].L);

        // Filter out white (L >= 98) and empty masks
        const trappable = [];
        for (const idx of sortedIndices) {
            if (labPalette[idx].L >= 98) continue; // Skip white/substrate
            // Skip empty masks (no pixels to expand)
            let hasPixels = false;
            const mask = masks[idx];
            for (let i = 0, len = mask.length; i < len; i++) {
                if (mask[i] === 255) { hasPixels = true; break; }
            }
            if (hasPixels) trappable.push(idx);
        }

        if (trappable.length <= 1) {
            // Single color (or none): both lightest and darkest → 0 trap
            return { trappedCount: 0, trapSizes: [] };
        }

        // Calculate trap sizes via linear interpolation
        // trappable[0] = lightest non-white → max trap
        // trappable[last] = darkest → 0 trap
        const trapSizes = [];
        const total = trappable.length;
        let trappedCount = 0;

        for (let pos = 0; pos < total; pos++) {
            const idx = trappable[pos];
            const trapPx = (total === 1)
                ? 0
                : Math.round(maxTrapPixels * (1 - pos / (total - 1)));

            trapSizes.push({ index: idx, trapPx, expandedPixels: 0 });

            if (trapPx <= 0) continue;

            // Build union mask of all darker colors (everything after this position)
            const darkerMask = TrapEngine._buildDarkerMask(
                masks, trappable, pos, width, height
            );

            // Dilate this color's mask into darker mask territory
            const expanded = TrapEngine._dilateMaskInto(
                masks[idx], darkerMask, trapPx, width, height
            );

            trapSizes[trapSizes.length - 1].expandedPixels = expanded;
            if (expanded > 0) trappedCount++;
        }

        return { trappedCount, trapSizes };
    }

    /**
     * Build a union mask of all colors darker than the current position.
     *
     * @param {Array<Uint8Array>} masks - All per-color masks
     * @param {Array<number>} trappable - Sorted indices (lightest first)
     * @param {number} currentPos - Position in trappable array
     * @param {number} width
     * @param {number} height
     * @returns {Uint8Array} Binary mask (255 where any darker color exists)
     * @private
     */
    static _buildDarkerMask(masks, trappable, currentPos, width, height) {
        const pixelCount = width * height;
        const darkerMask = new Uint8Array(pixelCount);

        // OR together all masks for colors darker than current
        for (let pos = currentPos + 1; pos < trappable.length; pos++) {
            const mask = masks[trappable[pos]];
            for (let i = 0; i < pixelCount; i++) {
                if (mask[i] === 255) darkerMask[i] = 255;
            }
        }

        return darkerMask;
    }

    /**
     * Iterative 4-connected dilation constrained to darker mask area.
     * Double-buffered: snapshot per iteration to avoid order-dependent artifacts.
     * Early termination if no expansion occurred in an iteration.
     *
     * @param {Uint8Array} mask - Source color mask (mutated in place)
     * @param {Uint8Array} darkerMask - Constraint: only expand where darker ink exists
     * @param {number} iterations - Number of 1-pixel dilation steps
     * @param {number} width
     * @param {number} height
     * @returns {number} Total pixels added
     * @private
     */
    static _dilateMaskInto(mask, darkerMask, iterations, width, height) {
        const pixelCount = width * height;
        let totalAdded = 0;

        // Snapshot buffer for double-buffering
        const snapshot = new Uint8Array(pixelCount);

        for (let iter = 0; iter < iterations; iter++) {
            // Take snapshot of current mask state
            snapshot.set(mask);

            let addedThisIteration = 0;

            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = y * width + x;

                    // Only expand INTO empty pixels that are in darker territory
                    if (mask[i] !== 0) continue;
                    if (darkerMask[i] === 0) continue;

                    // Check 4-connected neighbors in the snapshot
                    let hasNeighbor = false;

                    // Top
                    if (y > 0 && snapshot[i - width] === 255) hasNeighbor = true;
                    // Bottom
                    if (!hasNeighbor && y < height - 1 && snapshot[i + width] === 255) hasNeighbor = true;
                    // Left
                    if (!hasNeighbor && x > 0 && snapshot[i - 1] === 255) hasNeighbor = true;
                    // Right
                    if (!hasNeighbor && x < width - 1 && snapshot[i + 1] === 255) hasNeighbor = true;

                    if (hasNeighbor) {
                        mask[i] = 255;
                        addedThisIteration++;
                    }
                }
            }

            totalAdded += addedThisIteration;

            // Early termination: no expansion means we've filled all reachable territory
            if (addedThisIteration === 0) break;
        }

        return totalAdded;
    }
}

module.exports = TrapEngine;
