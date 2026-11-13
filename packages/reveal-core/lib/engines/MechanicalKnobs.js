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
const MeshPhysics = require('../utils/MeshPhysics');

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
     * @param {Object} [options]
     * @param {number} [options.maxColors=0] - Hard screen cap (0 = no cap). Lowest-coverage colors demoted to weak if count exceeds this.
     * @returns {{remappedCount: number}} Number of weak colors remapped
     */
    static applyMinVolume(colorIndices, palette, pixelCount, minVolumePercent, options = {}) {
        const maxColors = options.maxColors || 0;
        if (minVolumePercent <= 0 && maxColors <= 0) return { remappedCount: 0 };

        const minPixels = Math.round(pixelCount * minVolumePercent / 100);

        // Count pixels per color
        const colorCounts = new Uint32Array(palette.length);
        for (let i = 0; i < pixelCount; i++) {
            colorCounts[colorIndices[i]]++;
        }

        // Classify each color into a 30° hue sector (12 sectors).
        // Achromatic colors (C < 5) get sector -1 (no sector protection).
        const HUE_SECTORS = 12;
        const colorSectors = new Int8Array(palette.length);
        for (let i = 0; i < palette.length; i++) {
            const c = palette[i];
            const C = Math.sqrt(c.a * c.a + c.b * c.b);
            if (C < 5) {
                colorSectors[i] = -1;
            } else {
                const hue = (Math.atan2(c.b, c.a) * 180 / Math.PI + 360) % 360;
                colorSectors[i] = Math.floor(hue / 30) % HUE_SECTORS;
            }
        }

        // Partition into weak and strong.
        // Colors tagged _minVolumeExempt (hue gap injections, PeakFinder peaks)
        // get a reduced threshold — they were explicitly added to capture minority
        // signals but still need meaningful coverage to justify a screen.
        // Floor: 0.1% of image or 50 pixels, whichever is larger.
        const exemptMinPixels = Math.max(50, Math.round(pixelCount * 0.001));
        const weakIndices = [];
        const strongIndices = [];
        for (let i = 0; i < palette.length; i++) {
            if (colorCounts[i] === 0) continue;
            if (colorCounts[i] >= minPixels) {
                strongIndices.push(i);
            } else if (palette[i]._userAdded) {
                // User-added colors are unconditionally strong — the user
                // explicitly added this color; minVolume must not prune it.
                strongIndices.push(i);
            } else if (palette[i]._minVolumeExempt && colorCounts[i] >= exemptMinPixels) {
                strongIndices.push(i);
            } else {
                weakIndices.push(i);
            }
        }

        // Sector-aware rescue: if pruning a weak color would eliminate the last
        // chromatic representative of its hue sector, promote it to strong.
        // This prevents minVolume from destroying minority hue diversity —
        // e.g. a single chartreuse in a warm-dominant palette.
        if (weakIndices.length > 0 && strongIndices.length > 0) {
            const strongSectors = new Set();
            for (const idx of strongIndices) {
                if (colorSectors[idx] >= 0) strongSectors.add(colorSectors[idx]);
            }

            const rescued = [];
            for (let w = weakIndices.length - 1; w >= 0; w--) {
                const weakIdx = weakIndices[w];
                const sector = colorSectors[weakIdx];
                if (sector >= 0 && !strongSectors.has(sector)) {
                    // This is the last representative of its sector — rescue it
                    strongIndices.push(weakIdx);
                    strongSectors.add(sector);
                    weakIndices.splice(w, 1);
                    rescued.push(weakIdx);
                }
            }
        }

        // Screen cap — if active colors exceed maxColors, demote lowest-coverage
        // strong colors to weak so they get merged into nearest neighbor.
        if (maxColors > 0 && strongIndices.length > maxColors) {
            const ranked = strongIndices
                .map(idx => ({ idx, count: colorCounts[idx] }))
                .sort((a, b) => a.count - b.count);

            const demoteCount = strongIndices.length - maxColors;
            for (let i = 0; i < demoteCount; i++) {
                const demotedIdx = ranked[i].idx;
                weakIndices.push(demotedIdx);
                const strongPos = strongIndices.indexOf(demotedIdx);
                strongIndices.splice(strongPos, 1);
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
     * Removes isolated pixel clusters whose SPAN (minimum diameter — see
     * `SeparationEngine._despeckleMaskBySpan`) falls below a threshold
     * derived from the slider value, then BFS-heals orphaned pixels into
     * surrounding colors.
     *
     * This is the artist's creative despeckle control: sliderPx=0 with no
     * meshTPI is a deliberate no-op (ProxyEngine's preview/undo machinery
     * relies on "zero knobs" reproducing the clean baseline exactly). The
     * mesh-physics HARD FLOOR (Rule of 7 — no isolated element may span
     * less than PRINT_FACTOR mesh openings) is enforced separately, always,
     * at final-output time — see `enforceMeshRuleOfSeven`.
     *
     * AUTO-COMPUTE (sliderPx = 0, meshTPI > 0): derives a size from press
     * physics via MeshPhysics.minDotPx(meshTPI, imageDpi).
     *
     * UNITS: `sliderPx` and the mesh-derived value are LINEAR pixel
     * dimensions (minimum diameter), not area.
     *
     * PROXY SCALING: the linear dimension is divided by linearScale so the
     * proxy threshold correctly mirrors the production threshold.
     *
     * @param {Array<Uint8Array>} masks        Per-color binary masks (mutated)
     * @param {Uint8Array}        colorIndices Per-pixel palette index (mutated by healing)
     * @param {number}            width        Image width in pixels
     * @param {number}            height       Image height in pixels
     * @param {number}            sliderPx     Linear slider value (0 = auto from mesh physics, or no-op if meshTPI also 0)
     * @param {number}            [originalWidth] Full document width (for proxy scaling)
     * @param {number}            [meshTPI=0]  Screen mesh threads-per-inch (e.g. 230, 305, 355)
     * @param {number}            [imageDpi=0] Document DPI; 0 → assume 300
     * @param {number}            [ruleOfN=0]  Rule of N mesh factor; 0 → default 7.0
     */
    static applySpeckleRescue(masks, colorIndices, width, height, sliderPx, originalWidth, meshTPI = 0, imageDpi = 0, ruleOfN = 0) {
        let linearPx;
        if (sliderPx > 0) {
            linearPx = sliderPx;
        } else if (meshTPI > 0) {
            linearPx = MeshPhysics.minDotPx(meshTPI, imageDpi, ruleOfN);
        } else {
            return;
        }

        // Scale down for proxy: a blob N px wide at full-res is N/linearScale px
        // wide at proxy.
        let effectiveLinearPx = linearPx;
        if (originalWidth && originalWidth > width) {
            const linearScale = originalWidth / width;
            effectiveLinearPx = Math.max(1, Math.round(linearPx / linearScale));
        }

        for (let colorIdx = 0; colorIdx < masks.length; colorIdx++) {
            SeparationEngine._despeckleMaskBySpan(masks[colorIdx], width, height, effectiveLinearPx);
        }

        MechanicalKnobs.healOrphanedPixels(masks, colorIndices, width, height);
    }

    /**
     * Enforce the Rule of 7: no isolated printed element may span less than
     * PRINT_FACTOR mesh openings. Unlike `applySpeckleRescue` (the artist's
     * creative despeckle knob), this is a hard physical constraint on the
     * FINAL output and is always applied, unconditionally — meshTPI/imageDpi
     * default to 355 TPI / 300 DPI (see MeshPhysics)
     * when the caller doesn't know its press/image specifics.
     *
     * Call this once, at the point a separation is actually committed to a
     * deliverable (PSD/plates/export, or a Photoshop production render) —
     * not inside interactive preview/undo state, which intentionally keeps
     * "zero knobs" identical to the clean baseline.
     *
     * ASYNC: yields back to the host between colors (setTimeout(0)). At
     * production scale with many colors, running this fully synchronously
     * inside a single executeAsModal call made UXP/Photoshop treat the
     * plugin as unresponsive and abort the operation — callers MUST await
     * this (it was previously synchronous; this is a breaking signature
     * change for any caller not already awaiting it).
     *
     * @param {Array<Uint8Array>} masks        Per-color binary masks (mutated)
     * @param {Uint8Array}        colorIndices Per-pixel palette index (mutated by healing)
     * @param {number}            width
     * @param {number}            height
     * @param {Object}            [options]
     * @param {number}            [options.meshTPI=0]     Screen mesh TPI; 0 → default (355)
     * @param {number}            [options.imageDpi=0]    Document DPI; 0 → default (300)
     * @param {number}            [options.originalWidth] Full document width (for proxy scaling)
     * @param {number}            [options.ruleOfN=0]     Rule of N mesh factor; 0 → default 7.0
     * @returns {Promise<{clustersRemoved: number, pixelsRemoved: number, pixelsPruned: number}>} Aggregate across all colors
     */
    static async enforceMeshRuleOfSeven(masks, colorIndices, width, height, options = {}) {
        const { meshTPI = 0, imageDpi = 0, originalWidth = 0, ruleOfN = 0 } = options;
        const floorPx = MeshPhysics.minDotPx(meshTPI, imageDpi, ruleOfN);

        let effectiveFloorPx = floorPx;
        if (originalWidth && originalWidth > width) {
            const linearScale = originalWidth / width;
            effectiveFloorPx = Math.max(1, Math.round(floorPx / linearScale));
        }

        let clustersRemoved = 0;
        let pixelsRemoved = 0;
        let pixelsPruned = 0;
        const prunedColorIndices = [];

        // Yield back to the host between colors (matches the CHUNK_SIZE /
        // setTimeout(0) pattern already used in mapPixelsToPaletteAsync).
        // The full-canvas distance transform + despeckle + pruning per color
        // is now ~a few hundred ms, but across 10+ colors in one unbroken
        // synchronous stretch inside executeAsModal, UXP/Photoshop can treat
        // the plugin as unresponsive and abort the modal operation — this
        // was the actual cause of "Production failed" (err.message
        // undefined — a host-level abort, not a JS exception), not raw
        // per-call cost. Async + a yield per color keeps every synchronous
        // stretch short regardless of total color count or image size.
        const yieldToHost = () => new Promise(resolve => setTimeout(resolve, 0));

        // Filament Pruning Pass (additive, Architect-approved 2026-11-10) —
        // prunes unsupported interior stretches WITHIN components that
        // already survived the DOT-or-LINE check (e.g. the thin interior of
        // a large interconnected hatching network, far from any intersection
        // wide enough to anchor it). The full-canvas distance-to-background
        // transform is the dominant cost at production scale, so it's
        // computed ONCE per color here and shared between despeckle and
        // pruning — removed specks are, in the overwhelming majority of
        // cases, disjoint from and far from a surviving component's own
        // boundary, so the pre-despeckle field remains an accurate enough
        // basis for the immediately-following prune pass on the same color.
        for (let colorIdx = 0; colorIdx < masks.length; colorIdx++) {
            const mask = masks[colorIdx];
            const sqDist = SeparationEngine._squaredDistanceToBackground(mask, width, height);

            const despeckleResult = SeparationEngine._despeckleMaskBySpan(mask, width, height, effectiveFloorPx, sqDist);
            clustersRemoved += despeckleResult.clustersRemoved;
            pixelsRemoved += despeckleResult.pixelsRemoved;

            const pruneResult = SeparationEngine._pruneUnsupportedFilaments(mask, width, height, effectiveFloorPx, sqDist);
            pixelsPruned += pruneResult.pixelsPruned;
            if (pruneResult.pixelsPruned > 0) prunedColorIndices.push(colorIdx);

            await yieldToHost();
        }

        // Safety-net re-despeckle only for colors actually touched by pruning
        // — mops up any newly-orphaned debris, recomputing a fresh distance
        // field since pruning changed this color's mask (reuses the
        // already-vetted DOT-or-LINE logic rather than new orphan-detection
        // code, per the Architect's "must not create new specks" directive).
        for (const colorIdx of prunedColorIndices) {
            const result = SeparationEngine._despeckleMaskBySpan(masks[colorIdx], width, height, effectiveFloorPx);
            clustersRemoved += result.clustersRemoved;
            pixelsRemoved += result.pixelsRemoved;
            await yieldToHost();
        }

        MechanicalKnobs.healOrphanedPixels(masks, colorIndices, width, height);

        return { clustersRemoved, pixelsRemoved, pixelsPruned };
    }

    /**
     * Alias for enforceMeshRuleOfSeven supporting configurable Rule of N.
     */
    static enforceMeshRuleOfN(masks, colorIndices, width, height, options = {}) {
        return MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, width, height, options);
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
     * Async variant of applyShadowClamp for ProxyEngine (real-time preview).
     * Yields to the UI thread between per-color passes so archetype swaps stay responsive.
     * ProductionWorker and batch callers use the synchronous applyShadowClamp.
     */
    static async applyShadowClampAsync(masks, colorIndices, palette, width, height, clampPercent) {
        if (clampPercent <= 0) return;

        const baseThreshold = (clampPercent / 100) * 3;

        for (let c = 0; c < masks.length; c++) {
            const mask = masks[c];
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

            for (const idx of toRemove) mask[idx] = 0;

            // Yield to UXP UI thread between colors so archetype swaps don't freeze
            await new Promise(resolve => setTimeout(resolve, 0));
        }

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
