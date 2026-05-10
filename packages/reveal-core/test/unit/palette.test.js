import { describe, it, expect } from 'vitest';
const Reveal = require('../../index');
const Palette = Reveal.engines.Palette || require('../../lib/palette/Palette');

describe('Palette & PaletteGraph', () => {

    const baseline = [
        { L: 10, a: 0, b: 0 }, // palette-0
        { L: 50, a: 0, b: 0 }, // palette-1
        { L: 90, a: 0, b: 0 }  // palette-2
    ];

    it('initializes with baseline colors', () => {
        const p = new Palette(baseline);
        expect(p.getEffectivePalette()).toHaveLength(3);
        expect(p.getEffectivePalette()[0].L).toBe(10);
        expect(p.getVisibleNodes()).toHaveLength(3);
    });

    it('handles color overrides', () => {
        const p = new Palette(baseline);
        p.override('palette-1', { L: 55, a: 10, b: 10 });
        
        const effective = p.getEffectivePalette();
        expect(effective[1].L).toBe(55);
        expect(p.hasEdits()).toBe(true);
    });

    it('handles merging nodes', () => {
        const p = new Palette(baseline);
        // Merge palette-1 into palette-2
        p.merge('palette-1', 'palette-2');
        
        const effective = p.getEffectivePalette();
        expect(effective).toHaveLength(2);
        expect(effective[1].L).toBe(90); // palette-2's color
        
        const nodes = p.getVisibleNodes();
        expect(nodes).toHaveLength(3);
        expect(nodes[1].isMerged).toBe(true);
        expect(nodes[1].mergeTargetId).toBe('palette-2');
    });

    it('handles node deletion (auto-merge)', () => {
        const p = new Palette(baseline);
        // Delete palette-0 (should merge into palette-1 as nearest)
        p.delete('palette-0');
        
        const effective = p.getEffectivePalette();
        expect(effective).toHaveLength(2);
        expect(effective[0].L).toBe(50); // palette-1's color
        
        expect(p.graph.deletedColors.has(0)).toBe(true);
    });

    it('handles suggested color promotion', () => {
        const suggested = [
            { L: 100, a: 0, b: 0, source: 'test', reason: 'highlight' }
        ];
        const p = new Palette(baseline, suggested);
        expect(p.getSuggestions()).toHaveLength(1);
        
        const newNodeId = p.promote('suggested-0');
        expect(newNodeId).toBe('added-0');
        expect(p.getEffectivePalette()).toHaveLength(4);
        expect(p.getEffectivePalette()[3].L).toBe(100);
        expect(p.getSuggestions()).toHaveLength(0);
    });

    it('supports snapshot and restore', () => {
        const p1 = new Palette(baseline);
        p1.override('palette-0', { L: 15, a: 5, b: 5 });
        p1.delete('palette-2');
        
        const snapshot = p1.snapshot();
        
        const p2 = new Palette(baseline);
        p2.restore(snapshot);
        
        expect(p2.getEffectivePalette()).toHaveLength(2);
        expect(p2.getEffectivePalette()[0].L).toBe(15);
        expect(p2.graph.deletedColors.has(2)).toBe(true);
    });

    it('calculates merge remap correctly', () => {
        const p = new Palette(baseline);
        p.merge('palette-1', 'palette-2'); // 1 -> 2
        
        const remap = p.graph.getMergeRemap();
        expect(remap[0]).toBe(0); // 0 -> 0
        expect(remap[1]).toBe(1); // 1 -> index 1 in live palette (palette-2)
        expect(remap[2]).toBe(1); // 2 -> index 1 in live palette
    });

    // ─── Advanced Stress Tests ───────────────────────────────

    describe('Multi-level Merge Chains', () => {
        it('resolves color through deep chains (A -> B -> C)', () => {
            const p = new Palette(baseline);
            // palette-0 -> palette-1 -> palette-2
            p.merge('palette-0', 'palette-1');
            p.merge('palette-1', 'palette-2');
            
            const effective = p.getEffectivePalette();
            expect(effective).toHaveLength(1);
            expect(effective[0].L).toBe(90); // palette-2's color

            expect(p.graph.getEffectiveLab('palette-0').L).toBe(90);
            expect(p.graph.getEffectiveLab('palette-1').L).toBe(90);
        });

        it('remapping works for deep chains', () => {
            const p = new Palette(baseline);
            p.merge('palette-0', 'palette-1');
            p.merge('palette-1', 'palette-2');
            
            const remap = p.graph.getMergeRemap();
            expect(remap[0]).toBe(0); // palette-0 -> index 0 (palette-2)
            expect(remap[1]).toBe(0); // palette-1 -> index 0 (palette-2)
            expect(remap[2]).toBe(0); // palette-2 -> index 0 (palette-2)
        });
    });

    describe('Dependent Reparenting', () => {
        it('reparents or reverts dependents when a middle target is removed', () => {
            const p = new Palette(baseline);
            const addedId = p.graph.addNode({ L: 100, a: 0, b: 0 }); // added-0
            
            // palette-0 -> added-0, palette-1 -> added-0
            p.merge('palette-0', addedId);
            p.merge('palette-1', addedId);
            
            expect(p.getEffectivePalette()).toHaveLength(2); // added-0 and palette-2
            
            // Remove added-0
            p.graph.removeAddedNode(addedId);
            
            expect(p.getEffectivePalette()).toHaveLength(3); // palette-0, palette-1, palette-2 restored
            expect(p.graph.getNodeById('palette-0').isLive()).toBe(true);
            expect(p.graph.getNodeById('palette-1').isLive()).toBe(true);
        });
    });

    describe('Cycle Detection', () => {
        it('throws error when creating a direct cycle (A -> B, B -> A)', () => {
            const p = new Palette(baseline);
            p.merge('palette-0', 'palette-1');
            expect(() => p.merge('palette-1', 'palette-0')).toThrow(/cycle/);
        });

        it('throws error when creating a deep cycle (A -> B -> C, C -> A)', () => {
            const p = new Palette(baseline);
            p.merge('palette-0', 'palette-1');
            p.merge('palette-1', 'palette-2');
            expect(() => p.merge('palette-2', 'palette-0')).toThrow(/cycle/);
        });
    });

    describe('Distance Metrics', () => {
        it('selects nearest neighbor based on specific metric during deletion', () => {
            // palette-0: {10,0,0}, palette-1: {50,0,0}, palette-2: {90,0,0}
            const p = new Palette(baseline);
            
            // Override palette-1 to be slightly closer to palette-2 than palette-0
            p.override('palette-1', { L: 70, a: 0, b: 0 });
            
            // Delete palette-1 (should merge into palette-2)
            p.delete('palette-1', 'cie76');
            
            const node1 = p.graph.getNodeById('palette-1');
            expect(node1.mergeTargetId).toBe('palette-2');
        });
    });
});
