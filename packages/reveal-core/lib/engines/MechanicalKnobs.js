/**
 * MechanicalKnobs - Shared post-separation mask processing
 *
 * Pure functions for the three screen-printing knobs:
 *   - minVolume:     Ghost plate removal (merge weak colors)
 *   - speckleRescue: Halftone solidity (despeckle + heal)
 *   - shadowClamp:   Ink body / edge erosion (tonal-aware)
 *
 * DESIGN: These are the SINGLE implementations used by both ProxyEngine
 * (real-time preview) and ProductionWorker (full-res commit). The preview
 * is the user's decision surface — both paths MUST produce identical results
 * given identical inputs.
 *
 * All functions are pure — they operate on masks/indices arrays in place.
 * No I/O, no Photoshop dependencies.
 *
 * @module MechanicalKnobs
 */

const SeparationEngine = require('./SeparationEngine');

class MechanicalKnobs {

    /**
     * Apply minVolume: remap weak-color pixels to nearest strong neighbor.
     *
     * Colors with coverage below the threshold percentage are merged into
     * their nearest CIE76 neighbor. Palette array stays the same length
     * (indices remain stable for palette overrides).
     *
     * @param {Uint8Array} colorIndices - Per-pixel palette index (mutated in place)
     * @param {Array<{L,a,b}>} palette - Lab palette
     * @param {number} pixelCount - Total pixels
     * @param {number} minVolumePercent - Threshold (0-5%)
     * @returns {{remappedCount: number}} Number of weak colors remapped
     */
    static applyMinVolume(colorIndices, palette, pixelCount, minVolumePercent) {
        if (minVolumePercent <= 0) return { remappedCount: 0 };

        const minPixels = Math.round(pixelCount * minVolumePercent / 100);

        // Count pixels per color
        const colorCounts = new Uint32Array(palette.length);
        for (let i = 0; i < pixelCount; i++) {
            colorCounts[colorIndices[i]]++;
        }

        // Partition into weak and strong
        const weakIndices = [];
        const strongIndices = [];
        for (let i = 0; i < palette.length; i++) {
            if (colorCounts[i] > 0 && colorCounts[i] < minPixels) {
                weakIndices.push(i);
            } else if (colorCounts[i] > 0) {
                strongIndices.push(i);
            }
        }

        if (weakIndices.length === 0 || strongIndices.length === 0) {
            return { remappedCount: 0 };
        }

        // Build remap table: each weak color → nearest strong (CIE76)
        const remapTable = new Uint8Array(palette.length);
        for (let i = 0; i < remapTable.length; i++) remapTable[i] = i;

        for (const weakIdx of weakIndices) {
            const wc = palette[weakIdx];
            let nearestIdx = strongIndices[0];
            let minDist = Infinity;
            for (const strongIdx of strongIndices) {
                const sc = palette[strongIdx];
                const dL = wc.L - sc.L;
                const da = wc.a - sc.a;
                const db = wc.b - sc.b;
                const dist = dL * dL + da * da + db * db;
                if (dist < minDist) {
                    minDist = dist;
                    nearestIdx = strongIdx;
                }
            }
            remapTable[weakIdx] = nearestIdx;
        }

        // Remap indices in place (palette array untouched)
        for (let i = 0; i < pixelCount; i++) {
            colorIndices[i] = remapTable[colorIndices[i]];
        }

        return { remappedCount: weakIndices.length };
    }

    /**
     * Apply speckleRescue: morphological despeckle + BFS healing.
     *
     * Removes isolated pixel clusters smaller than threshold, then heals
     * the orphaned pixels by flooding them with neighboring colors.
     *
     * @param {Array<Uint8Array>} masks - Per-color binary masks (mutated in place)
     * @param {Uint8Array} colorIndices - Per-pixel palette index (mutated by healing)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} thresholdPixels - User-facing speckle size (0-10px)
     * @param {number} [originalWidth] - Full document width (for proxy scaling)
     */
    static applySpeckleRescue(masks, colorIndices, width, height, thresholdPixels, originalWidth) {
        if (thresholdPixels <= 0) return;

        let threshold = Math.round(thresholdPixels);

        // Scale threshold for proxy resolution.
        // Despeckle removes connected components below a pixel-area threshold.
        // Area scales as linearScale², so linear scaling overshoots badly.
        // Use sqrt(linearScale) — scales by perimeter dimension.
        if (originalWidth && originalWidth > width) {
            const linearScale = originalWidth / width;
            threshold = Math.round(threshold * Math.sqrt(linearScale));
        }

        for (let colorIdx = 0; colorIdx < masks.length; colorIdx++) {
            SeparationEngine._despeckleMask(masks[colorIdx], width, height, threshold);
        }

        // Heal orphaned pixels so despeckled areas absorb into surrounding color
        MechanicalKnobs.healOrphanedPixels(masks, colorIndices, width, height);
    }

    /**
     * Apply shadowClamp as tonal-aware edge erosion.
     *
     * For each mask pixel, compute the fraction of 8-connected neighbors
     * sharing the same mask. If below a per-ink threshold, zero the pixel.
     * Light inks (high L) erode more aggressively than dark inks.
     *
     * shadowClamp=0%  → nothing removed
     * shadowClamp=10% → removes thin edges (light inks more aggressively)
     * shadowClamp=40% → erodes ~1-2px from all edges
     *
     * @param {Array<Uint8Array>} masks - Per-color binary masks (mutated in place)
     * @param {Uint8Array} colorIndices - Per-pixel palette index (mutated by healing)
     * @param {Array<{L,a,b}>} palette - Lab palette (for tonal modulation)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} clampPercent - shadowClamp value (0-40%)
     */
    static applyShadowClamp(masks, colorIndices, palette, width, height, clampPercent) {
        if (clampPercent <= 0) return;

        // Map 0-40% slider range onto 0-1.2 base neighbor fraction (3× scale)
        const baseThreshold = (clampPercent / 100) * 3;

        for (let c = 0; c < masks.length; c++) {
            const mask = masks[c];

            // Tonal modulation: light inks erode more, dark inks less
            //   Black ink (L=0):   threshold = base × 0.5 (tolerant)
            //   Mid ink (L=50):    threshold = base × 1.0 (normal)
            //   Light ink (L=100): threshold = base × 1.5 (aggressive)
            const inkL = (palette[c] && palette[c].L !== undefined) ? palette[c].L : 50;
            const lightnessBoost = inkL / 100;
            const threshold = baseThreshold * (0.5 + lightnessBoost);

            const toRemove = [];

            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = y * width + x;
                    if (mask[i] === 0) continue;

                    let same = 0, total = 0;
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            if (dx === 0 && dy === 0) continue;
                            const nx = x + dx, ny = y + dy;
                            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                                total++;
                                if (mask[ny * width + nx] > 0) same++;
                            }
                        }
                    }

                    if (same / total < threshold) {
                        toRemove.push(i);
                    }
                }
            }

            for (const idx of toRemove) {
                mask[idx] = 0;
            }
        }

        // Heal eroded edges into surrounding color
        MechanicalKnobs.healOrphanedPixels(masks, colorIndices, width, height);
    }

    /**
     * BFS-fill orphaned pixels from surrounding non-orphan neighbors.
     *
     * An orphaned pixel is one where its assigned color's mask was zeroed
     * (by despeckle or erosion) but colorIndices still points to that color.
     * This floods orphans with the nearest non-orphan neighbor's color,
     * so removed speckles/edges absorb into surrounding ink.
     *
     * O(pixelCount) — each pixel visited at most twice.
     *
     * @param {Array<Uint8Array>} masks - Per-color binary masks (mutated)
     * @param {Uint8Array} colorIndices - Per-pixel palette index (mutated)
     * @param {number} width
     * @param {number} height
     */
    static healOrphanedPixels(masks, colorIndices, width, height) {
        const pixelCount = width * height;
        const numColors = masks.length;

        // Mark orphaned pixels (their assigned mask was zeroed)
        const isOrphan = new Uint8Array(pixelCount);
        let orphanCount = 0;

        for (let i = 0; i < pixelCount; i++) {
            const ci = colorIndices[i];
            if (ci >= numColors || masks[ci][i] === 0) {
                isOrphan[i] = 1;
                orphanCount++;
            }
        }

        if (orphanCount === 0) return;

        // Seed BFS queue with non-orphan pixels adjacent to at least one orphan
        const queue = new Uint32Array(pixelCount);
        let head = 0;
        let tail = 0;

        for (let i = 0; i < pixelCount; i++) {
            if (isOrphan[i]) continue;
            const x = i % width;
            const y = (i - x) / width;
            let adjacent = false;
            for (let dy = -1; dy <= 1 && !adjacent; dy++) {
                for (let dx = -1; dx <= 1 && !adjacent; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx, ny = y + dy;
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        if (isOrphan[ny * width + nx]) adjacent = true;
                    }
                }
            }
            if (adjacent) queue[tail++] = i;
        }

        // BFS: spread non-orphan colors into orphan gaps
        while (head < tail) {
            const i = queue[head++];
            const ci = colorIndices[i];
            const x = i % width;
            const y = (i - x) / width;

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    const ni = ny * width + nx;
                    if (isOrphan[ni]) {
                        colorIndices[ni] = ci;
                        masks[ci][ni] = 255;
                        isOrphan[ni] = 0;
                        queue[tail++] = ni;
                    }
                }
            }
        }
    }

    /**
     * Rebuild masks from colorIndices (after minVolume remapping).
     *
     * @param {Uint8Array} colorIndices - Per-pixel palette index
     * @param {number} paletteSize - Number of palette entries
     * @param {number} pixelCount - Total pixel count
     * @returns {Array<Uint8Array>} New masks array
     */
    static rebuildMasks(colorIndices, paletteSize, pixelCount) {
        const masks = [];
        for (let i = 0; i < paletteSize; i++) {
            masks.push(new Uint8Array(pixelCount));
        }
        for (let i = 0; i < pixelCount; i++) {
            const ci = colorIndices[i];
            if (ci < paletteSize) {
                masks[ci][i] = 255;
            }
        }
        return masks;
    }
}

module.exports = MechanicalKnobs;
