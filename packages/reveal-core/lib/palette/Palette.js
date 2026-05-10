/**
 * Palette — Unified color management for Reveal Core
 *
 * Encapsulates the active PaletteGraph and dormant Suggested colors.
 * Provides a high-level API for surgery, promotion, and identity resolution.
 */

const PaletteGraph = require('./PaletteGraph');
const LabDistance = require('../color/LabDistance');

class Palette {

    /**
     * @param {Array<{L, a, b}>} baseline - Original colors from posterization
     * @param {Array<{L, a, b, source, reason}>} suggested - Perceptual outliers
     */
    constructor(baseline = [], suggested = []) {
        this.graph = new PaletteGraph(baseline);
        this._suggestedNodes = new Map(); // nodeId -> PaletteNode
        
        // Initialize suggested colors with stable IDs
        suggested.forEach((s, i) => {
            const id = `suggested-${i}`;
            // We reuse PaletteNode structure logic here
            const node = {
                id,
                baseLab: { ...s },
                overrideLab: null,
                status: 'suggested',
                mergeTargetId: null,
                mergedSourceIds: new Set(),
                metadata: { source: s.source, reason: s.reason }
            };
            this._suggestedNodes.set(id, node);
        });
    }

    // ─── Query ───────────────────────────────────────────────

    /** Get current live palette as raw Lab array (for shaders/engines). */
    getEffectivePalette() {
        return this.graph.getEffectivePalette();
    }

    /** Get nodes visible in the active palette (including merges/deletes). */
    getVisibleNodes() {
        return this.graph.getVisibleNodes();
    }

    /** Get current suggestions (excluding those already promoted). */
    getSuggestions() {
        return Array.from(this._suggestedNodes.values());
    }

    /** Resolve nodeId to effective Lab color. */
    getEffectiveLab(nodeId) {
        if (nodeId.startsWith('suggested-')) {
            const node = this._suggestedNodes.get(nodeId);
            return node ? { ...node.baseLab } : null;
        }
        return this.graph.getEffectiveLab(nodeId);
    }

    /** Returns true if any palette edits exist. */
    hasEdits() {
        return this.graph.hasEdits();
    }

    // ─── Mutations ───────────────────────────────────────────

    /** Clear all edits (overrides, deletes, merges) but keep added nodes. */
    clearEdits() {
        this.graph.getNodes().forEach(n => {
            if (n.status !== 'added') this.graph.revertNode(n.id);
        });
    }

    /** Promote a suggested color to the active palette. */
    promote(suggestedId) {
        const node = this._suggestedNodes.get(suggestedId);
        if (!node) return null;

        // Add to main graph as a fresh 'added' node
        const newNodeId = this.graph.addNode(node.baseLab);
        
        // Remove from suggested list
        this._suggestedNodes.delete(suggestedId);
        
        return newNodeId;
    }

    /** Merge source node into target node. */
    merge(sourceId, targetId) {
        this.graph.mergeNode(sourceId, targetId);
    }

    /** Delete a node (merges into nearest live neighbor). */
    delete(nodeId, metric = 'cie76') {
        this.graph.deleteNode(nodeId, metric);
    }

    /** Override a node's color. */
    override(nodeId, labColor) {
        this.graph.overrideNode(nodeId, labColor);
    }

    /** Revert all edits/merges for a node. */
    revert(nodeId) {
        this.graph.revertNode(nodeId);
    }

    // ─── Serialization ───────────────────────────────────────

    /** Snapshot for session persistence. */
    snapshot() {
        return {
            graph: this.graph.snapshot(),
            suggested: Array.from(this._suggestedNodes.entries()).map(([id, n]) => [id, {
                ...n,
                mergedSourceIds: Array.from(n.mergedSourceIds)
            }])
        };
    }

    /** Restore from snapshot. */
    restore(data) {
        this.graph.restore(data ? data.graph : null);
        this._suggestedNodes.clear();
        if (data && data.suggested) {
            for (const [id, nData] of data.suggested) {
                this._suggestedNodes.set(id, {
                    ...nData,
                    mergedSourceIds: new Set(nData.mergedSourceIds || [])
                });
            }
        }
    }
}

module.exports = Palette;
