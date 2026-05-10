/**
 * PaletteNode — Private component for PaletteGraph
 */
class PaletteNode {
    constructor(id, baseLab, status = 'active') {
        this.id = id;
        this.baseLab = { ...baseLab };
        this.overrideLab = null;
        this.status = status; // 'active', 'deleted', 'added'
        this.mergeTargetId = null;
        this.mergedSourceIds = new Set();
    }

    /** True if this node is live (not deleted, not merged away). */
    isLive() {
        return this.status !== 'deleted' && this.mergeTargetId === null;
    }

    /** True if this node has been merged into another. */
    get isMerged() {
        return this.mergeTargetId !== null;
    }

    /** True if this node has been soft-deleted. */
    get isDeleted() {
        return this.status === 'deleted';
    }

    /** Effective Lab color (override or base). */
    get effectiveLab() {
        return this.overrideLab ? { ...this.overrideLab } : { ...this.baseLab };
    }

    /** Deep copy for snapshot/restore. */
    snapshot() {
        return {
            id: this.id,
            baseLab: { ...this.baseLab },
            overrideLab: this.overrideLab ? { ...this.overrideLab } : null,
            status: this.status,
            mergeTargetId: this.mergeTargetId,
            mergedSourceIds: Array.from(this.mergedSourceIds)
        };
    }

    /** Restore from snapshot. */
    restore(data) {
        this.id = data.id;
        this.baseLab = { ...data.baseLab };
        this.overrideLab = data.overrideLab ? { ...data.overrideLab } : null;
        this.status = data.status;
        this.mergeTargetId = data.mergeTargetId;
        this.mergedSourceIds = new Set(data.mergedSourceIds || []);
    }
}

/**
 * PaletteGraph — Node-based palette surgery data structure
 *
 * Replaces ad-hoc Maps/Sets with a proper graph of palette nodes.
 * Each palette entry is a stable node with identity, preventing index-shift bugs.
 *
 * Node schema:
 * - id: string (stable unique ID, e.g. 'palette-0', 'added-5')
 * - baseLab: {L, a, b} (original baseline color)
 * - overrideLab: {L, a, b}|null (user edit)
 * - status: 'active' | 'deleted' | 'added'
 * - mergeTargetId: string|null (if merged into another)
 * - mergedSourceIds: Set<string> (nodes merged into this)
 */

const logger = require('../utils/logger');
const LabDistance = require('../color/LabDistance');

class PaletteGraph {

    constructor(baselinePalette = []) {
        this._nodes = new Map(); // id → PaletteNode
        this._displayOrder = []; // stable ordering for UI
        this.reset(baselinePalette);
    }

    // ─── Lifecycle ───────────────────────────────────────────

    /** Reset to clean state with new baseline palette. */
    reset(baselinePalette = []) {
        this._nodes.clear();
        this._displayOrder = [];

        // Create nodes for baseline palette
        for (let i = 0; i < baselinePalette.length; i++) {
            const id = `palette-${i}`;
            const node = new PaletteNode(id, baselinePalette[i], 'active');
            this._nodes.set(id, node);
            this._displayOrder.push(id);
        }
    }

    /** Initialize with baseline palette. */
    initialize(baselinePalette) {
        this.reset(baselinePalette);
    }

    // ─── Query ───────────────────────────────────────────────

    /** Get all nodes. */
    getNodes() {
        return Array.from(this._nodes.values());
    }

    /** Get live (active/added, not merged) nodes. */
    getLiveNodes() {
        return this.getNodes().filter(n => n.isLive());
    }

    /** Get nodes visible in UI (includes deleted/added for revert). */
    getVisibleNodes() {
        return this._displayOrder.map(id => this._nodes.get(id)).filter(Boolean);
    }

    /** Get node by stable ID. */
    getNodeById(id) {
        return this._nodes.get(id) || null;
    }

    /** Returns true if any palette surgery edits exist. */
    hasEdits() {
        for (const node of this._nodes.values()) {
            if (node.overrideLab || node.isDeleted || node.isMerged || node.status === 'added') {
                return true;
            }
        }
        return false;
    }

    /** Returns a Map of displayIndex -> overrideLab. */
    get paletteOverrides() {
        const overrides = new Map();
        this._displayOrder.forEach((id, idx) => {
            const node = this._nodes.get(id);
            if (!node) return;
            
            if (node.overrideLab) {
                overrides.set(idx, { ...node.overrideLab });
            } else if (node.status === 'merged' || node.mergeTargetId) {
                // Compatibility: merged colors are reported as overrides
                const targetId = this.resolveMergeTarget(id);
                if (targetId !== id) {
                    const target = this._nodes.get(targetId);
                    if (target) {
                        const color = target.overrideLab || target.baseLab;
                        overrides.set(idx, { ...color });
                    }
                }
            }
        });
        return overrides;
    }

    /** Returns a Map of targetDisplayIndex -> Set of sourceDisplayIndices. */
    get mergeHistory() {
        const history = new Map();
        this._nodes.forEach(node => {
            if (node.mergeTargetId) {
                const finalTargetId = this.resolveMergeTarget(node.id);
                const targetIdx = this._displayOrder.indexOf(finalTargetId);
                const sourceIdx = this._displayOrder.indexOf(node.id);
                if (targetIdx !== -1 && sourceIdx !== -1) {
                    if (!history.has(targetIdx)) history.set(targetIdx, new Set());
                    history.get(targetIdx).add(sourceIdx);
                }
            }
        });
        return history;
    }

    /** Returns a Set of deleted displayIndices. */
    get deletedColors() {
        const deleted = new Set();
        this._displayOrder.forEach((id, idx) => {
            const node = this._nodes.get(id);
            if (node && node.isDeleted) {
                deleted.add(idx);
            }
        });
        return deleted;
    }

    /** Returns a Set of added displayIndices. */
    get addedColors() {
        const added = new Set();
        this._displayOrder.forEach((id, idx) => {
            const node = this._nodes.get(id);
            if (node && node.status === 'added') {
                added.add(idx);
            }
        });
        return added;
    }

    /** Get stable display order for UI. */
    getDisplayOrder() {
        return [...this._displayOrder];
    }

    /**
     * Get a mapping from baseline indices (the display order at the time of 
     * the last re-separation) to current live indices in getEffectivePalette().
     * 
     * @returns {Int32Array} remap[baselineIdx] = liveIdx
     */
    getMergeRemap() {
        const baselineIds = this._displayOrder;
        const liveNodes = this.getLiveNodes();
        
        // Sort live nodes by display order to match getEffectivePalette() index
        liveNodes.sort((a, b) => this._displayOrder.indexOf(a.id) - this._displayOrder.indexOf(b.id));
        const liveIds = liveNodes.map(n => n.id);

        const remap = new Int32Array(baselineIds.length);
        for (let i = 0; i < baselineIds.length; i++) {
            const id = baselineIds[i];
            const targetId = this.resolveMergeTarget(id);
            // Index in liveIds matches the index in getEffectivePalette()
            remap[i] = liveIds.indexOf(targetId);
        }
        return remap;
    }

    /**
     * Get the live index for a nodeId (index in the filtered/merged palette).
     * @param {string} nodeId
     * @returns {number} index in [0...liveCount-1], or -1 if not found/deleted
     */
    getIndexForNodeId(nodeId) {
        const liveNodes = this.getLiveNodes();
        liveNodes.sort((a, b) => this._displayOrder.indexOf(a.id) - this._displayOrder.indexOf(b.id));
        const liveIds = liveNodes.map(n => n.id);
        
        const targetId = this.resolveMergeTarget(nodeId);
        return liveIds.indexOf(targetId);
    }

    /** 
     * Get effective Lab color for a node, resolving through merge chains.
     * @param {string} nodeId
     * @returns {{L, a, b}}
     */
    getEffectiveLab(nodeId) {
        const targetId = this.resolveMergeTarget(nodeId);
        const node = this._nodes.get(targetId);
        if (!node) throw new Error(`Node ${targetId} not found during resolution of ${nodeId}`);
        return node.overrideLab ? { ...node.overrideLab } : { ...node.baseLab };
    }

    /** Get effective palette (live nodes only). */
    getEffectivePalette() {
        const liveNodes = this.getLiveNodes();
        // Sort by display order
        liveNodes.sort((a, b) => this._displayOrder.indexOf(a.id) - this._displayOrder.indexOf(b.id));
        return liveNodes.map(n => this.getEffectiveLab(n.id));
    }

    // ─── Mutations ───────────────────────────────────────────

    /** Override a node's color. */
    overrideNode(nodeId, labColor) {
        const node = this._nodes.get(nodeId);
        if (!node) throw new Error(`Node ${nodeId} not found`);
        node.overrideLab = { ...labColor };
        logger.log(`[PaletteGraph.override] ${nodeId}: ${JSON.stringify(labColor)}`);
    }

    /** 
     * Revert a node's edit/merge/deletion.
     * @param {string} nodeId
     * @returns {boolean}
     */
    revertNode(nodeId) {
        const node = this._nodes.get(nodeId);
        if (!node) return false;

        // If it was merged, remove from target's dependents
        if (node.mergeTargetId) {
            const target = this._nodes.get(node.mergeTargetId);
            if (target) target.mergedSourceIds.delete(nodeId);
        }

        node.overrideLab = null;
        node.status = node.id.startsWith('added-') ? 'added' : 'active';
        node.mergeTargetId = null;

        logger.log(`[PaletteGraph.revert] ${nodeId}`);
        return true;
    }

    /** Merge source node into target node. */
    mergeNode(sourceId, targetId) {
        if (sourceId === targetId) throw new Error('Cannot merge node into itself');

        const source = this._nodes.get(sourceId);
        const target = this._nodes.get(targetId);
        if (!source || !target) throw new Error(`Invalid node IDs: ${sourceId}, ${targetId}`);

        // Cycle detection
        if (this._wouldCauseCycle(sourceId, targetId)) {
            throw new Error(`Merging ${sourceId} into ${targetId} would cause a cycle`);
        }

        // If source was already merged elsewhere, clean it up
        if (source.mergeTargetId) {
            const oldTarget = this._nodes.get(source.mergeTargetId);
            if (oldTarget) oldTarget.mergedSourceIds.delete(sourceId);
        }

        source.mergeTargetId = targetId;
        target.mergedSourceIds.add(sourceId);

        logger.log(`[PaletteGraph.merge] ${sourceId} → ${targetId}`);
    }

    /** Delete a node by merging it into the nearest live neighbor. */
    deleteNode(nodeId, metric = 'cie76') {
        const node = this._nodes.get(nodeId);
        if (!node) throw new Error(`Node ${nodeId} not found`);

        if (node.isLive()) {
            const targetId = this._findMergeTargetForDeletedNode(nodeId, metric);
            if (!targetId) throw new Error('Cannot delete the last remaining color');
            
            node.status = 'deleted';
            this.mergeNode(nodeId, targetId);
            logger.log(`[PaletteGraph.delete] ${nodeId} → ${targetId}`);
        }
    }

    /** Add a new color to the palette. */
    addNode(labColor) {
        const index = this._getNextAddedIndex();
        const id = `added-${index}`;
        const node = new PaletteNode(id, labColor, 'added');
        this._nodes.set(id, node);
        this._displayOrder.push(id);
        logger.log(`[PaletteGraph.add] ${id}: ${JSON.stringify(labColor)}`);
        return id;
    }

    /** Remove an added node entirely. */
    removeAddedNode(nodeId) {
        const node = this._nodes.get(nodeId);
        if (!node || node.status !== 'added') return false;

        // If it was merged, remove from target's dependents
        if (node.mergeTargetId) {
            const target = this._nodes.get(node.mergeTargetId);
            if (target) target.mergedSourceIds.delete(nodeId);
        }

        // Reparent its dependents to its own target (if any), or revert them
        const deps = Array.from(node.mergedSourceIds);
        for (const depId of deps) {
            if (node.mergeTargetId) {
                this.mergeNode(depId, node.mergeTargetId);
            } else {
                this.revertNode(depId);
            }
        }

        // Remove from display order and nodes
        const idx = this._displayOrder.indexOf(nodeId);
        if (idx >= 0) this._displayOrder.splice(idx, 1);
        this._nodes.delete(nodeId);

        logger.log(`[PaletteGraph.removeAdded] ${nodeId}`);
        return true;
    }

    // ─── Utilities ───────────────────────────────────────────

    /** Resolve merge chain to ultimate target. */
    resolveMergeTarget(nodeId) {
        let currentId = nodeId;
        const visited = new Set();
        while (currentId) {
            if (visited.has(currentId)) throw new Error(`Merge cycle detected at ${currentId}`);
            visited.add(currentId);
            const node = this._nodes.get(currentId);
            if (!node || !node.mergeTargetId) break;
            currentId = node.mergeTargetId;
        }
        return currentId;
    }

    _wouldCauseCycle(sourceId, targetId) {
        let currentId = targetId;
        const visited = new Set([sourceId]);
        while (currentId) {
            if (visited.has(currentId)) return true;
            visited.add(currentId);
            const node = this._nodes.get(currentId);
            if (!node || !node.mergeTargetId) break;
            currentId = node.mergeTargetId;
        }
        return false;
    }

    // ─── Serialization ───────────────────────────────────────

    /** Snapshot entire graph state. */
    snapshot() {
        return {
            nodes: Array.from(this._nodes.entries()).map(([id, node]) => [id, node.snapshot()]),
            displayOrder: [...this._displayOrder]
        };
    }

    /** Restore from snapshot. */
    restore(data) {
        if (!data) {
            this._nodes.clear();
            this._displayOrder = [];
            return;
        }

        this._nodes.clear();
        for (const [id, nodeData] of data.nodes) {
            const node = new PaletteNode(id, {L:0,a:0,b:0});
            node.restore(nodeData);
            this._nodes.set(id, node);
        }
        this._displayOrder = [...data.displayOrder];
    }

    // ─── Private Helpers ─────────────────────────────────────

    _findMergeTargetForDeletedNode(excludeId, metric = 'cie76') {
        const liveNodes = this.getLiveNodes().filter(n => n.id !== excludeId);
        if (liveNodes.length === 0) return null;

        const excludeLab = this.getEffectiveLab(excludeId);

        const distFn = metric === 'cie2000' ? LabDistance.cie2000SquaredInline
                     : metric === 'cie94'   ? LabDistance.cie94SquaredInline
                     :                        LabDistance.cie76SquaredInline;

        let bestId = null;
        let bestDist = Infinity;
        for (const node of liveNodes) {
            const liveLab = this.getEffectiveLab(node.id);
            const dist = distFn(
                excludeLab.L, excludeLab.a, excludeLab.b,
                liveLab.L, liveLab.a, liveLab.b
            );
            if (dist < bestDist) {
                bestDist = dist;
                bestId = node.id;
            }
        }
        return bestId;
    }

    _getNextAddedIndex() {
        let maxIndex = -1;
        for (const id of this._nodes.keys()) {
            if (id.startsWith('added-')) {
                const index = parseInt(id.split('-')[1], 10);
                if (index > maxIndex) maxIndex = index;
            }
        }
        return maxIndex + 1;
    }
}

module.exports = PaletteGraph;
