/**
 * PaletteSurgeryManager — Palette edit state for Navigator
 *
 * Wraps the @electrosaur-labs/core Palette object.
 * Delegates all surgery (merges, deletes, overrides) to the core graph.
 * Provides index-based getters for backward compatibility with SessionState.
 */

const Reveal = require('@electrosaur-labs/core');
const logger = Reveal.logger;

class PaletteSurgeryManager {

    constructor() {
        this._proxyEngine = null;
        this._palette = new Reveal.Palette();
    }

    /** Bind to a ProxyEngine instance. */
    initialize(proxyEngine) {
        this._proxyEngine = proxyEngine;
        
        // Initialize core Palette with the current baseline from the engine
        if (proxyEngine && proxyEngine._baselineState) {
            this.reset(proxyEngine._baselineState.palette);
        }
    }

    // ─── State Access ────────────────────────────────────────

    /** Compatibility getters: return index-based structures for SessionState/UI. */
    get paletteOverrides() { return this._palette.graph.paletteOverrides; }
    get mergeHistory() { return this._palette.graph.mergeHistory; }
    get deletedColors() { return this._palette.graph.deletedColors; }
    get addedColors() { return this._palette.graph.addedColors; }

    // ─── Lifecycle ───────────────────────────────────────────

    /**
     * Reset to clean state with new baseline palette.
     * @param {Array<{L,a,b}>} [baselinePalette] - New baseline colors
     */
    reset(baselinePalette = []) {
        this._palette = new Reveal.Palette(baselinePalette);
        logger.log(`[PaletteSurgeryManager] Reset with ${baselinePalette.length} colors`);
    }

    /** Clear overrides/merges/deletions but preserve addedColors. */
    clearEdits() {
        this._palette.clearEdits();
    }

    // ─── Palette Building ────────────────────────────────────

    /**
     * Build an overridden palette from baseline + edits.
     * @returns {Array<{L,a,b}>|null} Overridden palette
     */
    buildOverriddenPalette() {
        if (!this._palette) return null;
        
        const graph = this._palette.graph;
        const baseOrder = graph.getDisplayOrder();
        
        // Map baseline IDs to their current effective Lab color
        const result = baseOrder.map(id => graph.getEffectiveLab(id));
        
        return result;
    }

    /**
     * Build a palette representing the "identity" of each slot.
     * Preserves the node's own color (override or base) even if it is merged.
     * Used by the UI to show what each swatch represents.
     * @returns {Array<{L,a,b}>|null}
     */
    getIdentityPalette() {
        if (!this._palette) return null;
        const graph = this._palette.graph;
        const baseOrder = graph.getDisplayOrder();
        return baseOrder.map(id => {
            const node = graph.getNodeById(id);
            return node ? node.effectiveLab : { L: 50, a: 0, b: 0 };
        });
    }

    // ─── Mutations ───────────────────────────────────────────

    /**
     * Record a color override.
     * @param {number} displayIndex
     * @param {{L,a,b}} newLabColor
     */
    setOverride(displayIndex, newLabColor) {
        const nodeId = this._nodeIdFromIndex(displayIndex);
        if (nodeId) {
            this._palette.override(nodeId, newLabColor);
            logger.log(`[PaletteSurgeryManager] Overrode ${nodeId} at index ${displayIndex}`);
        } else {
            logger.log(`[PaletteSurgeryManager] FAILED override: no node at index ${displayIndex}`);
        }
    }

    /**
     * Revert a single override + deletion.
     * @param {number} displayIndex
     * @returns {boolean} true if something was reverted
     */
    revertOverride(displayIndex) {
        const nodeId = this._nodeIdFromIndex(displayIndex);
        if (nodeId) {
            this._palette.revert(nodeId);
            return true;
        }
        return false;
    }

    /**
     * Find the nearest live palette color to merge a deleted color into.
     * @param {number} displayIndex - Color to delete
     * @param {string} distanceMetric - 'cie76', 'cie94', or 'cie2000'
     * @param {Array<{L,a,b}>} [extraColors] - Additional colors (checked suggestions)
     * @returns {{targetIndex: number, isSuggestion: boolean}} Nearest live color
     */
    findMergeTarget(displayIndex, distanceMetric, extraColors) {
        const basePalette = this.buildOverriddenPalette();
        if (!basePalette) throw new Error('Proxy not initialized');

        const suggestions = extraColors || [];
        const fullPalette = [...basePalette, ...suggestions];
        
        const src = fullPalette[displayIndex];
        let bestDist = Infinity;
        let bestIdx = -1;

        // Skip sources that are already merged or deleted
        const deadIndices = new Set(this.deletedColors);
        for (const sources of this.mergeHistory.values()) {
            for (const s of sources) deadIndices.add(s);
        }
        deadIndices.add(displayIndex);

        const metric = distanceMetric || 'cie76';
        const distFn = metric === 'cie2000' ? Reveal.LabDistance.cie2000SquaredInline
                     : metric === 'cie94'   ? Reveal.LabDistance.cie94SquaredInline
                     :                        Reveal.LabDistance.cie76SquaredInline;

        for (let i = 0; i < fullPalette.length; i++) {
            if (deadIndices.has(i)) continue;
            const d = distFn(src.L, src.a, src.b, fullPalette[i].L, fullPalette[i].a, fullPalette[i].b);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }

        if (bestIdx === -1) throw new Error('Cannot delete the last remaining color');

        return {
            targetIndex: bestIdx,
            isSuggestion: bestIdx >= basePalette.length
        };
    }

    /**
     * Mark a color as deleted.
     * @param {number} displayIndex
     */
    markDeleted(displayIndex) {
        const nodeId = this._nodeIdFromIndex(displayIndex);
        if (nodeId) {
            const node = this._palette.graph.getNodeById(nodeId);
            if (node) node.status = 'deleted';
        }
    }

    /**
     * Record a merge: source becomes a copy of target.
     * @param {number} sourceIndex
     * @param {number} targetIndex
     */
    recordMerge(sourceIndex, targetIndex) {
        const sId = this._nodeIdFromIndex(sourceIndex);
        const tId = this._nodeIdFromIndex(targetIndex);
        if (sId && tId) {
            this._palette.merge(sId, tId);
        }
    }

    /**
     * Track a newly added color.
     * @param {number} newIndex (ignored, uses lab color)
     * @param {{L,a,b}} labColor
     */
    trackAddedColor(newIndex, labColor) {
        if (labColor) {
            this._palette.graph.addNode(labColor);
        }
    }

    /**
     * Remove a user-added color.
     * @param {number} displayIndex
     * @returns {boolean} true if removed
     */
    removeTrackedColor(displayIndex) {
        const nodeId = this._nodeIdFromIndex(displayIndex);
        if (nodeId && nodeId.startsWith('added-')) {
            return this._palette.graph.removeAddedNode(nodeId);
        }
        return false;
    }

    // ─── Private Helpers ─────────────────────────────────────

    _nodeIdFromIndex(index) {
        const order = this._palette.graph.getDisplayOrder();
        return order[index] || null;
    }

    // ─── Serialization ───────────────────────────────────────

    /** Snapshot for archetype cache. */
    snapshot() {
        return this._palette.snapshot();
    }

    /** Restore from archetype cache. */
    restore(data) {
        // If data contains Maps/Sets (old format), we need to handle it or reset
        if (data && (data.paletteOverrides instanceof Map)) {
            logger.log('[PaletteSurgeryManager] Migrating old snapshot format');
            this.reset(); // Fallback for old cache
            return;
        }
        this._palette.restore(data);
    }

    /** Returns true if any palette surgery edits exist. */
    hasEdits() {
        return this._palette.hasEdits();
    }

    /** Check if a color index is a merge source. */
    isMergeSource(displayIndex) {
        const nodeId = this._nodeIdFromIndex(displayIndex);
        if (!nodeId) return false;
        const node = this._palette.graph.getNodeById(nodeId);
        return node ? node.isMerged : false;
    }
}

module.exports = PaletteSurgeryManager;
