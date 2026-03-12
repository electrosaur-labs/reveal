/**
 * Recipe Palette — Unit Tests
 */

import { describe, it, expect } from 'vitest';

const { Palette } = require('../../lib/recipe/Palette');

// Distinct perceptual Lab colors for testing
const RED    = { L: 45, a: 60, b: 30 };
const GREEN  = { L: 55, a: -50, b: 40 };
const BLUE   = { L: 30, a: 10, b: -55 };
const YELLOW = { L: 85, a: -5, b: 70 };
const BLACK  = { L: 5, a: 0, b: 0 };

function makePalette(colors = [RED, GREEN, BLUE, YELLOW, BLACK]) {
    return new Palette(colors);
}

describe('Recipe Palette', () => {

    describe('construction', () => {
        it('creates a palette from Lab colors', () => {
            const p = makePalette();
            expect(p.length).toBe(5);
            expect(p.colors).toHaveLength(5);
        });

        it('computes hex for each entry', () => {
            const p = makePalette();
            for (const c of p.colors) {
                expect(c.hex).toMatch(/^#[0-9A-F]{6}$/);
            }
        });

        it('throws on empty array', () => {
            expect(() => new Palette([])).toThrow('non-empty array');
        });

        it('throws on non-array', () => {
            expect(() => new Palette('red')).toThrow('non-empty array');
        });

        it('throws on color missing Lab properties', () => {
            expect(() => new Palette([{ r: 255, g: 0, b: 0 }])).toThrow('numeric L, a, b');
        });
    });

    describe('find', () => {
        it('finds by index', () => {
            const p = makePalette();
            const entry = p.find(0);
            expect(entry.L).toBe(RED.L);
        });

        it('finds by hex (exact)', () => {
            const p = makePalette();
            const entry0 = p.find(0);
            const found = p.find(entry0.hex);
            expect(found.index).toBe(0);
        });

        it('finds by hex (case insensitive)', () => {
            const p = makePalette();
            const entry0 = p.find(0);
            const found = p.find(entry0.hex.toLowerCase());
            expect(found.index).toBe(0);
        });

        it('finds by Lab proximity', () => {
            const p = makePalette();
            // Slightly off from RED
            const found = p.find({ L: 46, a: 59, b: 31 });
            expect(found.L).toBe(RED.L);
        });

        it('throws on no match (bad index)', () => {
            const p = makePalette();
            expect(() => p.find(99)).toThrow('no color matching');
        });

        it('throws on no match (distant hex)', () => {
            const p = makePalette();
            // Bright cyan — unlikely to be within ΔE<5 of any test color
            expect(() => p.find('#00FFFF')).toThrow('no color matching');
        });
    });

    describe('has', () => {
        it('returns true for existing index', () => {
            const p = makePalette();
            expect(p.has(0)).toBe(true);
        });

        it('returns false for missing index', () => {
            const p = makePalette();
            expect(p.has(99)).toBe(false);
        });

        it('returns false for distant hex', () => {
            const p = makePalette();
            expect(p.has('#00FFFF')).toBe(false);
        });
    });

    describe('merge', () => {
        it('merges source into target, removing source', () => {
            const p = makePalette();
            const redHex = p.find(0).hex;
            p.merge(0, 1); // merge RED into GREEN
            expect(p.length).toBe(4);
            // RED's exact hex should no longer be in the palette
            const remaining = p.colors.map(c => c.hex);
            expect(remaining).not.toContain(redHex);
        });

        it('reindexes after merge', () => {
            const p = makePalette();
            p.merge(0, 1);
            // All indices should be sequential
            const indices = p.colors.map(c => c.index);
            expect(indices).toEqual([0, 1, 2, 3]);
        });

        it('throws when merging color into itself', () => {
            const p = makePalette();
            expect(() => p.merge(0, 0)).toThrow('cannot merge a color into itself');
        });

        it('throws when source is locked', () => {
            const p = makePalette();
            p.find(0).lock();
            expect(() => p.merge(0, 1)).toThrow('locked');
        });

        it('allows merging into a locked target', () => {
            const p = makePalette();
            p.find(1).lock();
            p.merge(0, 1); // unlocked source into locked target is fine
            expect(p.length).toBe(4);
        });
    });

    describe('remove', () => {
        it('removes a color', () => {
            const p = makePalette();
            p.remove(0);
            expect(p.length).toBe(4);
        });

        it('reindexes after remove', () => {
            const p = makePalette();
            p.remove(2);
            const indices = p.colors.map(c => c.index);
            expect(indices).toEqual([0, 1, 2, 3]);
        });

        it('throws when removing locked color', () => {
            const p = makePalette();
            p.find(0).lock();
            expect(() => p.remove(0)).toThrow('locked');
        });

        it('throws when removing last color', () => {
            const p = new Palette([RED]);
            expect(() => p.remove(0)).toThrow('last color');
        });
    });

    describe('add', () => {
        it('adds a Lab color', () => {
            const p = makePalette();
            p.add({ L: 50, a: 0, b: 0 });
            expect(p.length).toBe(6);
        });

        it('adds with a name', () => {
            const p = makePalette();
            const entry = p.add({ L: 50, a: 0, b: 0, name: 'Gray' });
            expect(entry.name).toBe('Gray');
        });

        it('adds from hex string', () => {
            const p = makePalette();
            p.add('#8B4513');
            expect(p.length).toBe(6);
        });

        it('accepts lowercase l', () => {
            const p = makePalette();
            p.add({ l: 50, a: 0, b: 0 });
            expect(p.length).toBe(6);
        });

        it('throws on invalid hex', () => {
            const p = makePalette();
            expect(() => p.add('#ZZZ')).toThrow('invalid hex');
        });

        it('throws on non-numeric Lab', () => {
            const p = makePalette();
            expect(() => p.add({ L: 'bright', a: 0, b: 0 })).toThrow('numeric');
        });

        it('throws on wrong type', () => {
            const p = makePalette();
            expect(() => p.add(42)).toThrow('expected hex string');
        });
    });

    describe('PaletteEntry methods', () => {
        it('setWeight validates positive number', () => {
            const p = makePalette();
            const e = p.find(0);
            e.setWeight(2.5);
            expect(e.weight).toBe(2.5);

            expect(() => e.setWeight(0)).toThrow('positive number');
            expect(() => e.setWeight(-1)).toThrow('positive number');
            expect(() => e.setWeight('big')).toThrow('positive number');
        });

        it('setName validates string', () => {
            const p = makePalette();
            const e = p.find(0);
            e.setName('Rich Red');
            expect(e.name).toBe('Rich Red');

            expect(() => e.setName(42)).toThrow('string');
        });

        it('setLab updates color and recomputes hex', () => {
            const p = makePalette();
            const e = p.find(0);
            const oldHex = e.hex;
            e.setLab(90, 0, 0);
            expect(e.L).toBe(90);
            expect(e.a).toBe(0);
            expect(e.b).toBe(0);
            expect(e.hex).not.toBe(oldHex);
        });

        it('setLab validates ranges', () => {
            const p = makePalette();
            const e = p.find(0);
            expect(() => e.setLab(-1, 0, 0)).toThrow('L must be 0-100');
            expect(() => e.setLab(101, 0, 0)).toThrow('L must be 0-100');
            expect(() => e.setLab(50, -129, 0)).toThrow('a must be');
            expect(() => e.setLab(50, 0, 128)).toThrow('b must be');
            expect(() => e.setLab('bright', 0, 0)).toThrow('must all be numbers');
        });

        it('lock prevents merge and remove', () => {
            const p = makePalette();
            const e = p.find(0);
            e.lock();
            expect(e.locked).toBe(true);

            e.unlock();
            expect(e.locked).toBe(false);
        });
    });
});
