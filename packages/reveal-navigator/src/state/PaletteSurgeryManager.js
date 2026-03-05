/**
 * PaletteSurgeryManager — Palette edit state for Navigator
 *
 * Owns the 4 mutable palette data structures (overrides, merges,
 * deletions, additions) and the palette-building logic. SessionState
 * delegates palette mutations here and handles proxy updates itself.
 */

const Reveal = require('@electrosaur-labs/core');
const logger = Reveal.logger;

class PaletteSurgeryManager {

    constructor() {
        this._proxyEngine = null;
        this.reset();
    }

    /** Bind to a ProxyEngine instance (called once per image load). */
    initialize(proxyEngine) {
        this._proxyEngine = proxyEngine;
    }

    // ─── State Access ────────────────────────────────────────

    get paletteOverrides() { return this._paletteOverrides; }
    get mergeHistory() { return this._mergeHistory; }
    get deletedColors() { return this._deletedColors; }
    get addedColors() { return this._addedColors; }

    set addedColors(v) { this._addedColors = v; }
    set paletteOverrides(v) { this._paletteOverrides = v; }
    set mergeHistory(v) { this._mergeHistory = v; }
    set deletedColors(v) { this._deletedColors = v; }

    // ─── Lifecycle ───────────────────────────────────────────

    reset() {
        this._paletteOverrides = new Map();  // colorIndex → {L, a, b}
        this._mergeHistory = new Map();      // targetIndex → Set<sourceIndex>
        this._deletedColors = new Set();     // deleted colorIndex values
        this._addedColors = new Set();       // user-added palette indices
    }

    /** Clear overrides/merges/deletions but preserve addedColors. */
    clearEdits() {
        this._paletteOverrides.clear();
        this._mergeHistory.clear();
        this._deletedColors.clear();
    }

    // ─── Palette Building ────────────────────────────────────

    /**
     * Build an overridden palette from baseline + edits.
     * ALWAYS uses the clean, un-mutated baseline palette as the source.
     * Never falls back to separationState.palette — it's a mutable
     * result of knob application and creates index drift when minVolume remaps.
     *
     * @returns {Array<{L,a,b}>|null} Overridden palette, or null if proxy not ready
     */
    buildOverriddenPalette() {
        if (!this._proxyEngine || !this._proxyEngine._baselineState) return null;

        const basePalette = this._proxyEngine._baselineState.palette;
        const result = basePalette.map(c => ({ ...c }));

        for (const [idx, color] of this._paletteOverrides) {
            if (idx < result.length) {
                result[idx] = { ...color };
            }
        }

        return result;
    }

    // ─── Mutations ───────────────────────────────────────────

    /**
     * Record a color override.
     * @param {number} colorIndex
     * @param {{L,a,b}} newLabColor
     */
    setOverride(colorIndex, newLabColor) {
        logger.log(`[PaletteSurgery.override] idx=${colorIndex} Lab=(${newLabColor.L.toFixed(1)},${newLabColor.a.toFixed(1)},${newLabColor.b.toFixed(1)}) overrides=${this._paletteOverrides.size}`);
        this._paletteOverrides.set(colorIndex, { ...newLabColor });
    }

    /**
     * Revert a single override + deletion.
     * @param {number} colorIndex
     * @returns {boolean} true if something was reverted
     */
    revertOverride(colorIndex) {
        if (!this._paletteOverrides.has(colorIndex) && !this._deletedColors.has(colorIndex)) return false;

        this._paletteOverrides.delete(colorIndex);
        this._deletedColors.delete(colorIndex);

        // Clean up merge history: remove this source from whichever target absorbed it
        for (const [target, sources] of this._mergeHistory) {
            sources.delete(colorIndex);
            if (sources.size === 0) this._mergeHistory.delete(target);
        }

        // If this index was itself a merge target (had sources merged into it),
        // cascade-revert those sources too — they were pointing at this color
        // which is now restored to its original, so the chain is broken.
        const dependents = this._mergeHistory.get(colorIndex);
        if (dependents) {
            for (const dep of dependents) {
                this._paletteOverrides.delete(dep);
            }
            this._mergeHistory.delete(colorIndex);
        }

        return true;
    }

    /**
     * Find the nearest live palette color to merge a deleted color into.
     * @param {number} colorIndex - Color to delete
     * @param {string} distanceMetric - 'cie76', 'cie94', or 'cie2000'
     * @param {Array<{L,a,b}>} [extraColors] - Additional colors (e.g. checked suggestions)
     * @returns {{targetIndex: number, isSuggestion: boolean}} Nearest live color
     */
    findMergeTarget(colorIndex, distanceMetric, extraColors) {
        const basePalette = this.buildOverriddenPalette();
        if (!basePalette || colorIndex >= basePalette.length) {
            throw new Error(`Invalid palette index: ${colorIndex}`);
        }

        const palette = extraColors && extraColors.length > 0
            ? [...basePalette, ...extraColors]
            : basePalette;

        // Collect dead indices (merge sources + already deleted) to skip
        const dead = new Set(this._deletedColors);
        for (const sources of this._mergeHistory.values()) {
            for (const s of sources) dead.add(s);
        }
        dead.add(colorIndex);

        const metric = distanceMetric || 'cie76';
        const distFn = metric === 'cie2000' ? Reveal.LabDistance.cie2000SquaredInline
                     : metric === 'cie94'   ? Reveal.LabDistance.cie94SquaredInline
                     :                        Reveal.LabDistance.cie76SquaredInline;

        const src = palette[colorIndex];
        let bestDist = Infinity;
        let bestIdx = -1;
        for (let i = 0; i < palette.length; i++) {
            if (dead.has(i)) continue;
            const d = distFn(
                src.L, src.a, src.b,
                palette[i].L, palette[i].a, palette[i].b
            );
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) {
            throw new Error('Cannot delete the last remaining color');
        }

        logger.log(`[PaletteSurgery.delete] idx=${colorIndex} → nearest=${bestIdx} (dE²=${bestDist.toFixed(1)})`);

        return {
            targetIndex: bestIdx,
            isSuggestion: bestIdx >= basePalette.length
        };
    }

    /**
     * Mark a color as deleted.
     * @param {number} colorIndex
     */
    markDeleted(colorIndex) {
        this._deletedColors.add(colorIndex);
    }

    /**
     * Record a merge: source becomes a copy of target.
     * @param {number} sourceIndex
     * @param {number} targetIndex
     */
    recordMerge(sourceIndex, targetIndex) {
        const palette = this.buildOverriddenPalette();
        if (!palette || sourceIndex >= palette.length || targetIndex >= palette.length) {
            throw new Error(`Invalid palette index: source=${sourceIndex}, target=${targetIndex}, size=${palette ? palette.length : 0}`);
        }

        logger.log(`[PaletteSurgery.merge] source=${sourceIndex} target=${targetIndex} mapSize_before=${this._paletteOverrides.size} keys=[${[...this._paletteOverrides.keys()]}]`);

        this._paletteOverrides.set(sourceIndex, { ...palette[targetIndex] });

        if (!this._mergeHistory.has(targetIndex)) {
            this._mergeHistory.set(targetIndex, new Set());
        }
        this._mergeHistory.get(targetIndex).add(sourceIndex);
    }

    /**
     * Track a newly added color index.
     * @param {number} newIndex
     */
    trackAddedColor(newIndex) {
        this._addedColors.add(newIndex);
    }

    /**
     * Remove a user-added color and shift all tracked indices.
     * @param {number} colorIndex
     * @returns {boolean} true if removed, false if not an added color
     */
    removeTrackedColor(colorIndex) {
        if (!this._addedColors.has(colorIndex)) return false;

        logger.log(`[PaletteSurgery.removeAdded] Removing added color at index ${colorIndex}`);

        // Remove from addedColors; shift tracked indices above the removed one
        this._addedColors.delete(colorIndex);
        const shifted = new Set();
        for (const idx of this._addedColors) {
            shifted.add(idx > colorIndex ? idx - 1 : idx);
        }
        this._addedColors = shifted;

        // Shift paletteOverrides for indices above removed
        const newOverrides = new Map();
        for (const [idx, color] of this._paletteOverrides) {
            if (idx === colorIndex) continue;
            const newIdx = idx > colorIndex ? idx - 1 : idx;
            newOverrides.set(newIdx, color);
        }
        this._paletteOverrides = newOverrides;

        // Shift mergeHistory
        const newMergeHistory = new Map();
        for (const [target, sources] of this._mergeHistory) {
            if (target === colorIndex) continue;
            const newTarget = target > colorIndex ? target - 1 : target;
            const newSources = new Set();
            for (const s of sources) {
                if (s === colorIndex) continue;
                newSources.add(s > colorIndex ? s - 1 : s);
            }
            if (newSources.size > 0) newMergeHistory.set(newTarget, newSources);
        }
        this._mergeHistory = newMergeHistory;

        // Shift deletedColors
        const newDeleted = new Set();
        for (const idx of this._deletedColors) {
            if (idx === colorIndex) continue;
            newDeleted.add(idx > colorIndex ? idx - 1 : idx);
        }
        this._deletedColors = newDeleted;

        return true;
    }

    // ─── Serialization (for archetype state cache) ───────────

    /**
     * Snapshot current palette surgery state for later restore.
     * @returns {Object} Deep-copied state
     */
    snapshot() {
        return {
            paletteOverrides: new Map(
                [...this._paletteOverrides].map(([k, v]) => [k, { ...v }])
            ),
            mergeHistory: new Map(
                [...this._mergeHistory].map(([k, v]) => [k, new Set(v)])
            ),
            deletedColors: new Set(this._deletedColors),
            addedColors: new Set(this._addedColors)
        };
    }

    /**
     * Restore palette surgery state from a snapshot.
     * Deep-copies to prevent cache mutation from live edits.
     * @param {Object} data - From snapshot()
     */
    restore(data) {
        if (!data) {
            this.reset();
            return;
        }
        // Deep-copy Maps and Sets to prevent cross-archetype mutation
        this._paletteOverrides = new Map();
        if (data.paletteOverrides) {
            for (const [idx, color] of data.paletteOverrides) {
                this._paletteOverrides.set(idx, { ...color });
            }
        }
        this._mergeHistory = new Map();
        if (data.mergeHistory) {
            for (const [target, sources] of data.mergeHistory) {
                this._mergeHistory.set(target, new Set(sources));
            }
        }
        this._deletedColors = new Set(data.deletedColors || []);
        this._addedColors = new Set(data.addedColors || []);
    }

    /**
     * Check if any palette edits exist.
     * @returns {boolean}
     */
    hasEdits() {
        return this._paletteOverrides.size > 0 ||
            this._deletedColors.size > 0 ||
            this._addedColors.size > 0;
    }
}

module.exports = PaletteSurgeryManager;
