/**
 * Unit tests for recipe.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadRecipe, saveRecipe, mergeRecipeWithCli } = require('../../src/recipe');

describe('recipe', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-recipe-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('loadRecipe', () => {
        it('loads a valid recipe', () => {
            const recipe = { archetype: 'cinematic', colors: 5, trap: 2 };
            const filePath = path.join(tmpDir, 'recipe.json');
            fs.writeFileSync(filePath, JSON.stringify(recipe));

            const result = loadRecipe(filePath);
            expect(result.archetype).toBe('cinematic');
            expect(result.colors).toBe(5);
            expect(result.trap).toBe(2);
        });

        it('throws on missing file', () => {
            expect(() => loadRecipe('/nonexistent/recipe.json')).toThrow('Recipe file not found');
        });

        it('throws on invalid JSON', () => {
            const filePath = path.join(tmpDir, 'bad.json');
            fs.writeFileSync(filePath, 'not json');
            expect(() => loadRecipe(filePath)).toThrow('Invalid recipe JSON');
        });

        it('throws on non-object JSON', () => {
            const filePath = path.join(tmpDir, 'array.json');
            fs.writeFileSync(filePath, '[1,2,3]');
            expect(() => loadRecipe(filePath)).toThrow('Recipe must be a JSON object');
        });

        it('validates colors range', () => {
            const filePath = path.join(tmpDir, 'recipe.json');
            fs.writeFileSync(filePath, JSON.stringify({ colors: 1 }));
            expect(() => loadRecipe(filePath)).toThrow('colors" must be 2-10');

            fs.writeFileSync(filePath, JSON.stringify({ colors: 11 }));
            expect(() => loadRecipe(filePath)).toThrow('colors" must be 2-10');
        });

        it('validates minVolume range', () => {
            const filePath = path.join(tmpDir, 'recipe.json');
            fs.writeFileSync(filePath, JSON.stringify({ minVolume: -1 }));
            expect(() => loadRecipe(filePath)).toThrow('minVolume" must be 0-5');

            fs.writeFileSync(filePath, JSON.stringify({ minVolume: 6 }));
            expect(() => loadRecipe(filePath)).toThrow('minVolume" must be 0-5');
        });

        it('validates speckleRescue range', () => {
            const filePath = path.join(tmpDir, 'recipe.json');
            fs.writeFileSync(filePath, JSON.stringify({ speckleRescue: 11 }));
            expect(() => loadRecipe(filePath)).toThrow('speckleRescue" must be 0-10');
        });

        it('validates shadowClamp range', () => {
            const filePath = path.join(tmpDir, 'recipe.json');
            fs.writeFileSync(filePath, JSON.stringify({ shadowClamp: 21 }));
            expect(() => loadRecipe(filePath)).toThrow('shadowClamp" must be 0-20');
        });

        it('validates outputs array', () => {
            const filePath = path.join(tmpDir, 'recipe.json');
            fs.writeFileSync(filePath, JSON.stringify({ outputs: 'psd' }));
            expect(() => loadRecipe(filePath)).toThrow('outputs" must be an array');

            fs.writeFileSync(filePath, JSON.stringify({ outputs: ['psd', 'invalid'] }));
            expect(() => loadRecipe(filePath)).toThrow('invalid value "invalid"');
        });

        it('accepts all valid output types', () => {
            const filePath = path.join(tmpDir, 'recipe.json');
            fs.writeFileSync(filePath, JSON.stringify({ outputs: ['flat', 'psd', 'ora', 'plates'] }));
            const result = loadRecipe(filePath);
            expect(result.outputs).toEqual(['flat', 'psd', 'ora', 'plates']);
        });

        it('accepts boundary values', () => {
            const filePath = path.join(tmpDir, 'recipe.json');
            fs.writeFileSync(filePath, JSON.stringify({
                colors: 2, minVolume: 0, speckleRescue: 0, shadowClamp: 0, trap: 0,
            }));
            const result = loadRecipe(filePath);
            expect(result.colors).toBe(2);
            expect(result.minVolume).toBe(0);

            fs.writeFileSync(filePath, JSON.stringify({
                colors: 10, minVolume: 5, speckleRescue: 10, shadowClamp: 20,
            }));
            const result2 = loadRecipe(filePath);
            expect(result2.colors).toBe(10);
            expect(result2.shadowClamp).toBe(20);
        });

        it('ignores unknown fields with warning', () => {
            const filePath = path.join(tmpDir, 'recipe.json');
            fs.writeFileSync(filePath, JSON.stringify({ colors: 5, bogus: true }));
            const result = loadRecipe(filePath);
            expect(result.colors).toBe(5);
            expect(result.bogus).toBeUndefined();
        });

        it('returns empty object for empty recipe', () => {
            const filePath = path.join(tmpDir, 'recipe.json');
            fs.writeFileSync(filePath, '{}');
            const result = loadRecipe(filePath);
            expect(result).toEqual({});
        });
    });

    describe('saveRecipe', () => {
        it('saves parameters to JSON', () => {
            const filePath = path.join(tmpDir, 'out.json');
            saveRecipe(filePath, { archetype: 'chameleon', colors: 6, trap: 2 });

            const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(saved.archetype).toBe('chameleon');
            expect(saved.colors).toBe(6);
            expect(saved.trap).toBe(2);
        });

        it('omits zero trap', () => {
            const filePath = path.join(tmpDir, 'out.json');
            saveRecipe(filePath, { colors: 5, trap: 0 });

            const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(saved.trap).toBeUndefined();
            expect(saved.colors).toBe(5);
        });

        it('omits undefined fields', () => {
            const filePath = path.join(tmpDir, 'out.json');
            saveRecipe(filePath, { archetype: 'chameleon' });

            const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(Object.keys(saved)).toEqual(['archetype']);
        });
    });

    describe('mergeRecipeWithCli', () => {
        it('CLI overrides recipe values', () => {
            const recipe = { archetype: 'cinematic', colors: 5 };
            const cli = { colors: 8 };
            const merged = mergeRecipeWithCli(recipe, cli);
            expect(merged.archetype).toBe('cinematic');
            expect(merged.colors).toBe(8);
        });

        it('recipe values preserved when CLI is undefined', () => {
            const recipe = { archetype: 'cinematic', colors: 5 };
            const cli = { colors: undefined, trap: undefined };
            const merged = mergeRecipeWithCli(recipe, cli);
            expect(merged.archetype).toBe('cinematic');
            expect(merged.colors).toBe(5);
        });

        it('does not mutate original recipe', () => {
            const recipe = { archetype: 'cinematic', colors: 5 };
            const cli = { colors: 8 };
            mergeRecipeWithCli(recipe, cli);
            expect(recipe.colors).toBe(5);
        });
    });
});
