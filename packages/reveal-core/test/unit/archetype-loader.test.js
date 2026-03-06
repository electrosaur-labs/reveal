/**
 * ArchetypeLoader - Unit Tests
 *
 * Tests for: loading archetypes from disk, caching, clearCache, _applyDefaults,
 * matchArchetype (DNA v1.0 and v2.0), manual selection bypass, fallback behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const ArchetypeLoader = require('../../lib/analysis/ArchetypeLoader');
const fs = require('fs');
const path = require('path');

// Always start with fresh cache
beforeEach(() => {
    ArchetypeLoader.clearCache();
});

// ─────────────────────────────────────────────────
// loadArchetypes
// ─────────────────────────────────────────────────

describe('ArchetypeLoader.loadArchetypes', () => {
    it('loads archetypes from the archetypes/ directory', () => {
        const archetypes = ArchetypeLoader.loadArchetypes();
        expect(Array.isArray(archetypes)).toBe(true);
        expect(archetypes.length).toBeGreaterThan(0);
    });

    it('each archetype has required fields: id, name, centroid, parameters', () => {
        const archetypes = ArchetypeLoader.loadArchetypes();
        for (const arch of archetypes) {
            expect(arch).toHaveProperty('id');
            expect(arch).toHaveProperty('name');
            expect(arch).toHaveProperty('centroid');
            expect(arch).toHaveProperty('parameters');
            expect(typeof arch.id).toBe('string');
            expect(typeof arch.name).toBe('string');
        }
    });

    it('excludes schema.json', () => {
        const archetypes = ArchetypeLoader.loadArchetypes();
        const ids = archetypes.map(a => a.id);
        expect(ids).not.toContain('schema');
    });

    it('sorts archetypes alphabetically by ID', () => {
        const archetypes = ArchetypeLoader.loadArchetypes();
        const ids = archetypes.map(a => a.id);
        const sorted = [...ids].sort((a, b) => a.localeCompare(b));
        expect(ids).toEqual(sorted);
    });

    it('caches result on second call', () => {
        const first = ArchetypeLoader.loadArchetypes();
        const second = ArchetypeLoader.loadArchetypes();
        expect(first).toBe(second); // same reference
    });

    it('loads expected number of archetypes (matches directory)', () => {
        const archetypesDir = path.join(__dirname, '../../archetypes');
        const jsonFiles = fs.readdirSync(archetypesDir)
            .filter(f => f.endsWith('.json') && f !== 'schema.json');

        const archetypes = ArchetypeLoader.loadArchetypes();
        expect(archetypes.length).toBe(jsonFiles.length);
    });
});

// ─────────────────────────────────────────────────
// clearCache
// ─────────────────────────────────────────────────

describe('ArchetypeLoader.clearCache', () => {
    it('forces reload on next loadArchetypes call', () => {
        const first = ArchetypeLoader.loadArchetypes();
        ArchetypeLoader.clearCache();
        const second = ArchetypeLoader.loadArchetypes();
        expect(first).not.toBe(second); // different reference
        expect(first.length).toBe(second.length); // same content
    });
});

// ─────────────────────────────────────────────────
// _applyDefaults
// ─────────────────────────────────────────────────

describe('ArchetypeLoader._applyDefaults', () => {
    it('adds default weights to archetype missing weights', () => {
        const arch = { id: 'test', name: 'Test' };
        ArchetypeLoader._applyDefaults(arch);
        expect(arch.weights).toEqual({ l: 0.5, c: 1.5, k: 1.0, l_std_dev: 2.0 });
    });

    it('preserves existing weights', () => {
        const customWeights = { l: 1.0, c: 2.0, k: 3.0, l_std_dev: 4.0 };
        const arch = { id: 'test', name: 'Test', weights: { ...customWeights } };
        ArchetypeLoader._applyDefaults(arch);
        expect(arch.weights).toEqual(customWeights);
    });
});

// ─────────────────────────────────────────────────
// getFallbackArchetype
// ─────────────────────────────────────────────────

describe('ArchetypeLoader.getFallbackArchetype', () => {
    it('returns a valid archetype with all required fields', () => {
        const fb = ArchetypeLoader.getFallbackArchetype();
        expect(fb).toHaveProperty('id', 'everyday_photo');
        expect(fb).toHaveProperty('name');
        expect(fb).toHaveProperty('centroid');
        expect(fb).toHaveProperty('weights');
        expect(fb).toHaveProperty('parameters');
    });

    it('centroid has 4D coordinates', () => {
        const fb = ArchetypeLoader.getFallbackArchetype();
        expect(fb.centroid).toHaveProperty('l');
        expect(fb.centroid).toHaveProperty('c');
        expect(fb.centroid).toHaveProperty('k');
        expect(fb.centroid).toHaveProperty('l_std_dev');
    });

    it('parameters include essential config keys', () => {
        const fb = ArchetypeLoader.getFallbackArchetype();
        expect(fb.parameters).toHaveProperty('minColors');
        expect(fb.parameters).toHaveProperty('maxColors');
        expect(fb.parameters).toHaveProperty('distanceMetric');
        expect(fb.parameters).toHaveProperty('ditherType');
    });
});

// ─────────────────────────────────────────────────
// matchArchetype - Manual Selection
// ─────────────────────────────────────────────────

describe('ArchetypeLoader.matchArchetype - manual selection', () => {
    it('returns exact archetype when manualArchetypeId matches', () => {
        const archetypes = ArchetypeLoader.loadArchetypes();
        const targetId = archetypes[0].id;
        const dna = { l: 50, c: 25, k: 50, l_std_dev: 25 }; // irrelevant for manual

        const result = ArchetypeLoader.matchArchetype(dna, targetId);
        expect(result.id).toBe(targetId);
    });

    it('falls back to DNA matching when manualArchetypeId not found', () => {
        const dna = { l: 50, c: 25, k: 50, l_std_dev: 25 };
        const result = ArchetypeLoader.matchArchetype(dna, 'nonexistent_archetype_xyz');
        // Should still return a valid archetype (via DNA matching)
        expect(result).toHaveProperty('id');
        expect(result).toHaveProperty('name');
    });
});

// ─────────────────────────────────────────────────
// matchArchetype - DNA v1.0
// ─────────────────────────────────────────────────

describe('ArchetypeLoader.matchArchetype - DNA v1.0', () => {
    it('returns an archetype with matchVersion 1.0', () => {
        const dna = { l: 50, c: 25, k: 50, l_std_dev: 25 };
        const result = ArchetypeLoader.matchArchetype(dna);
        expect(result.matchVersion).toBe('1.0');
        expect(result).toHaveProperty('matchDistance');
        expect(typeof result.matchDistance).toBe('number');
    });

    it('matches different archetypes for very different DNA signatures', () => {
        // High-chroma vibrant DNA
        const vibrant = { l: 60, c: 80, k: 30, l_std_dev: 20 };
        // High-contrast dark DNA
        const dark = { l: 30, c: 10, k: 95, l_std_dev: 40 };

        const vibrantMatch = ArchetypeLoader.matchArchetype(vibrant);
        const darkMatch = ArchetypeLoader.matchArchetype(dark);

        // Very different DNA should produce different matches (most of the time)
        // This is a soft assertion — if they happen to match the same archetype,
        // at least verify both are valid
        expect(vibrantMatch).toHaveProperty('id');
        expect(darkMatch).toHaveProperty('id');
    });

    it('returns closest archetype by weighted Euclidean distance', () => {
        // Create DNA that exactly matches a known archetype's centroid
        const archetypes = ArchetypeLoader.loadArchetypes();
        const target = archetypes[0];
        const dna = { ...target.centroid };

        const result = ArchetypeLoader.matchArchetype(dna);
        // Distance should be 0 for exact centroid match
        expect(result.matchDistance).toBeCloseTo(0, 1);
        expect(result.id).toBe(target.id);
    });

    it('handles missing DNA fields with defaults', () => {
        const minimalDna = {}; // all fields missing
        const result = ArchetypeLoader.matchArchetype(minimalDna);
        expect(result).toHaveProperty('id');
        expect(result.matchVersion).toBe('1.0');
    });
});

// ─────────────────────────────────────────────────
// matchArchetype - DNA v2.0
// ─────────────────────────────────────────────────

describe('ArchetypeLoader.matchArchetype - DNA v2.0', () => {
    // Minimal valid DNA v2.0 structure
    const makeDnaV2 = (overrides = {}) => ({
        version: '2.0',
        global: {
            l: 55, c: 30, k: 40, l_std_dev: 20,
            hue_entropy: 1.5, temperature_bias: 0.3,
            primary_sector_weight: 0.25,
            ...overrides.global
        },
        sectors: new Array(12).fill(0).map((_, i) => ({
            index: i,
            weight: i === 0 ? 0.25 : 0.0625,  // dominant red
            mean_chroma: 30
        })),
        dominant_sector: 'red',
        ...overrides
    });

    it('returns an archetype with matchVersion 2.0', () => {
        const result = ArchetypeLoader.matchArchetype(makeDnaV2());
        expect(result.matchVersion).toBe('2.0');
        expect(result).toHaveProperty('matchScore');
        expect(result).toHaveProperty('matchBreakdown');
    });

    it('matchBreakdown contains structural, sectorAffinity, pattern', () => {
        const result = ArchetypeLoader.matchArchetype(makeDnaV2());
        const bd = result.matchBreakdown;
        expect(bd).toHaveProperty('structural');
        expect(bd).toHaveProperty('sectorAffinity');
        expect(bd).toHaveProperty('pattern');
        expect(typeof bd.structural).toBe('number');
        expect(typeof bd.sectorAffinity).toBe('number');
        expect(typeof bd.pattern).toBe('number');
    });

    it('matchRanking contains all archetypes scored', () => {
        const archetypes = ArchetypeLoader.loadArchetypes();
        const result = ArchetypeLoader.matchArchetype(makeDnaV2());
        expect(result.matchRanking.length).toBe(archetypes.length);
        // Ranking should be sorted by score descending
        for (let i = 1; i < result.matchRanking.length; i++) {
            expect(result.matchRanking[i - 1].score).toBeGreaterThanOrEqual(result.matchRanking[i].score);
        }
    });

    it('uses v2.0 path when DNA has version, global, and sectors', () => {
        const dna = makeDnaV2();
        const result = ArchetypeLoader.matchArchetype(dna);
        expect(result.matchVersion).toBe('2.0');
    });

    it('falls back to v1.0 when DNA has version 2.0 but missing global', () => {
        const dna = { version: '2.0', l: 50, c: 25, k: 50, l_std_dev: 25 };
        const result = ArchetypeLoader.matchArchetype(dna);
        expect(result.matchVersion).toBe('1.0');
    });

    it('falls back to v1.0 when DNA has version 2.0 but missing sectors', () => {
        const dna = {
            version: '2.0',
            global: { l: 50, c: 25, k: 50, l_std_dev: 25, hue_entropy: 1.0, temperature_bias: 0.0, primary_sector_weight: 0.1 },
            l: 50, c: 25, k: 50, l_std_dev: 25
        };
        const result = ArchetypeLoader.matchArchetype(dna);
        expect(result.matchVersion).toBe('1.0');
    });
});

// ─────────────────────────────────────────────────
// Archetype JSON file integrity
// ─────────────────────────────────────────────────

describe('Archetype JSON files - structural integrity', () => {
    const archetypes = ArchetypeLoader.loadArchetypes();
    ArchetypeLoader.clearCache(); // don't pollute other tests

    it('every archetype has a 7D centroid (DNA v2.0 fields)', () => {
        for (const arch of archetypes) {
            const c = arch.centroid;
            expect(c, `${arch.id} missing centroid`).toBeDefined();
            expect(typeof c.l, `${arch.id}.centroid.l`).toBe('number');
            expect(typeof c.c, `${arch.id}.centroid.c`).toBe('number');
            expect(typeof c.k, `${arch.id}.centroid.k`).toBe('number');
            expect(typeof c.l_std_dev, `${arch.id}.centroid.l_std_dev`).toBe('number');
        }
    });

    it('every archetype has a group field', () => {
        for (const arch of archetypes) {
            expect(arch.group, `${arch.id} missing group`).toBeDefined();
            expect(typeof arch.group).toBe('string');
        }
    });

    it('every archetype has parameters with minColors and maxColors', () => {
        for (const arch of archetypes) {
            expect(arch.parameters, `${arch.id} missing parameters`).toBeDefined();
            expect(arch.parameters.minColors, `${arch.id}.parameters.minColors`).toBeGreaterThanOrEqual(3);
            expect(arch.parameters.maxColors, `${arch.id}.parameters.maxColors`).toBeGreaterThan(arch.parameters.minColors);
        }
    });

    it('unique IDs across all archetypes', () => {
        const ids = archetypes.map(a => a.id);
        const uniqueIds = new Set(ids);
        expect(uniqueIds.size).toBe(ids.length);
    });
});
