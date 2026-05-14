/**
 * Goddess Engines Integration Test
 * 
 * Verifies that the 5 Celtic goddess engines (Synthesis Layer)
 * produce UNIQUE palettes when fused with the same archetype.
 */

import { describe, it, expect, beforeAll } from 'vitest';
const Reveal = require('../../index');
const { perceptualLabTo16bit } = require('../helpers/lab-conversion');

// ─── Synthetic Test Image (Colorful) ──────────────────────────
const WIDTH = 100;
const HEIGHT = 100;

function buildTestImage() {
    const REGIONS = [
        { L: 45, a: 60, b: 30 },    // Red
        { L: 55, a: -50, b: 40 },   // Green
        { L: 30, a: 10, b: -55 },   // Blue
        { L: 85, a: -5, b: 70 },    // Yellow
        { L: 50, a: 0, b: 0 },      // Gray
    ];

    const pixelCount = WIDTH * HEIGHT;
    const pixels = [];
    for (let i = 0; i < pixelCount; i++) {
        const region = Math.floor(Math.random() * REGIONS.length);
        pixels.push(REGIONS[region]);
    }
    return perceptualLabTo16bit(pixels);
}

describe('Synthesis Layer: Goddess Engines', () => {
    let testPixels;
    let imageDNA;
    let bestArchetype;

    beforeAll(() => {
        testPixels = buildTestImage();
        const dnaGen = new Reveal.DNAGenerator();
        imageDNA = dnaGen.generate(testPixels, WIDTH, HEIGHT, { bitDepth: 16 });

        const archetypes = Reveal.ArchetypeLoader.loadArchetypes();
        const mapper = new Reveal.ArchetypeMapper(archetypes);
        bestArchetype = mapper.getBestMatch(imageDNA);
    });

    it('should generate unique palettes for all 5 goddess engines', async () => {
        const goddessIds = ['aine', 'anu', 'brigid', 'cailleach', 'rhiannon'];
        const results = {};

        const proxyEngine = new Reveal.ProxyEngine();
        await proxyEngine.initializeProxy(testPixels, WIDTH, HEIGHT, {
            targetColors: 8,
            distanceMetric: 'cie76'
        });

        for (const id of goddessIds) {
            const engineDef = Reveal.engines.EngineRegistry.get(id);
            
            // --- Definitive Synthesis ---
            const hydratedEngine = Reveal.engines.EngineBuilder.synthesize(engineDef, bestArchetype);

            const config = Reveal.generateConfiguration(imageDNA, {
                manualArchetypeId: bestArchetype.id,
                engineOverride: hydratedEngine
            });

            // Re-posterize using the synthesized engine
            const result = await proxyEngine.rePosterize(config);
            
            // Generate a more distinct palette fingerprint:
            // Include sorted RGB values instead of just Lab coordinates
            // to catch subtle weight differences in the final quantization.
            results[id] = result.palette.map(c => 
                `L${c.L.toFixed(2)}a${c.a.toFixed(2)}b${c.b.toFixed(2)}`
            ).sort().join('|');
            
            console.log(`Engine [${id}] Palette:`, results[id].substring(0, 50) + '...');
        }

        // Check uniqueness
        const uniquePalettes = new Set(Object.values(results));
        
        // Final assertion
        expect(uniquePalettes.size, `Expected 5 unique palettes, but got ${uniquePalettes.size}.\nPalettes: ${JSON.stringify(results, null, 2)}`)
            .toBe(5);
    });
});
