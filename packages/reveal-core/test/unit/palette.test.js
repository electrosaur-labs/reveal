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
});
