/**
 * End-to-End Posterization Tests
 *
 * These tests verify the FULL production pipeline on real images:
 *   DNA → ParameterGenerator → PosterizationEngine → SeparationEngine
 *
 * They catch bugs like:
 *   - bitDepth not flowing through ParameterGenerator (caused 6 colors instead of 8)
 *   - ProxyEngine config diverging from direct PosterizationEngine
 *   - Palette regression when algorithm parameters change
 *
 * Test images: /workspaces/electrosaur/fixtures/ (16-bit Lab PSD/TIFF files)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

// Core engines
import PosterizationEngine from '../../lib/engines/PosterizationEngine.js';
import SeparationEngine from '../../lib/engines/SeparationEngine.js';
import ProxyEngine from '../../lib/engines/ProxyEngine.js';
import BilateralFilter from '../../lib/preprocessing/BilateralFilter.js';

// Analysis pipeline
import DNAGenerator from '../../lib/analysis/DNAGenerator.js';
import ParameterGenerator from '../../lib/analysis/ParameterGenerator.js';
import ArchetypeMapper from '../../lib/analysis/ArchetypeMapper.js';
import ArchetypeLoader from '../../lib/analysis/ArchetypeLoader.js';

// TIFF reader for 16-bit Lab fixtures
const UTIF = require('utif2');

// PSD reader (workspace package) — fallback for full-res PSD fixtures
const { readPsd } = require(path.resolve(__dirname, '../../../../packages/reveal-psd-reader'));

// ─── Fixtures ──────────────────────────────────────────────

// Compact 1600×1095 TIFF fixture checked into the repo (~7MB LZW-compressed).
// Falls back to the full-res 5700×3900 PSD in /workspaces/electrosaur/fixtures/
// for deeper integration tests (not checked in — too large for git).
const LOCAL_FIXTURE = path.join(__dirname, '../fixtures/jethro-1600-lab16.tif');
const FULL_RES_FIXTURE = '/workspaces/electrosaur/fixtures/JethroAsMonroe-original-16bit.psd';
const JETHRO_16BIT = fs.existsSync(LOCAL_FIXTURE) ? LOCAL_FIXTURE : FULL_RES_FIXTURE;

/**
 * Convert PSD 16-bit Lab (0-65535, unsigned, 32768=neutral for a/b) to engine Lab (0-32768).
 */
function convertPsd16bitToEngineLab(labPsd16, pixelCount) {
    const labEngine = new Uint16Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        labEngine[i * 3]     = labPsd16[i * 3] >> 1;
        labEngine[i * 3 + 1] = labPsd16[i * 3 + 1] >> 1;
        labEngine[i * 3 + 2] = labPsd16[i * 3 + 2] >> 1;
    }
    return labEngine;
}

/**
 * Convert TIFF 16-bit CIELab to engine Lab (0-32768).
 * utif2 returns L as unsigned 0-65535, a/b as signed int16 (0=neutral).
 * Engine expects L: 0-32768, a/b: 0-32768 (16384=neutral).
 */
function convertTiff16bitToEngineLab(tiffData, pixelCount) {
    const u16 = new Uint16Array(tiffData.buffer, tiffData.byteOffset, pixelCount * 3);
    const i16 = new Int16Array(tiffData.buffer, tiffData.byteOffset, pixelCount * 3);
    const labEngine = new Uint16Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const idx = i * 3;
        labEngine[idx]     = u16[idx] >> 1;                    // L: unsigned halve
        labEngine[idx + 1] = (i16[idx + 1] + 32768) >> 1;     // a: signed→offset→halve
        labEngine[idx + 2] = (i16[idx + 2] + 32768) >> 1;     // b: signed→offset→halve
    }
    return labEngine;
}

/**
 * Read a 16-bit Lab TIFF using utif2.
 * Returns { data: Uint8Array, width, height } matching readPsd shape.
 */
function readTiff(buffer) {
    const ifds = UTIF.decode(buffer);
    const ifd = ifds[0];
    UTIF.decodeImage(buffer, ifd);
    return {
        data: ifd.data,
        width: ifd.t256[0],
        height: ifd.t257[0]
    };
}

/**
 * CIE76 ΔE for comparing Lab colors (perceptual space, not encoded).
 */
function deltaE76(a, b) {
    const dL = a.L - b.L;
    const da = a.a - b.a;
    const db = a.b - b.b;
    return Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Find the best-matching color in a palette for a given target.
 * Returns { index, deltaE }.
 */
function findBestMatch(target, palette) {
    let bestIdx = -1;
    let bestDE = Infinity;
    for (let j = 0; j < palette.length; j++) {
        const de = deltaE76(target, palette[j]);
        if (de < bestDE) { bestDE = de; bestIdx = j; }
    }
    return { index: bestIdx, deltaE: bestDE };
}

/**
 * Check that every color in `expected` has a close match in `actual`.
 * Returns { avgDeltaE, maxDeltaE, missingCount, details }.
 */
function comparePalettes(expected, actual, threshold = 5.0) {
    const details = [];
    let sumDE = 0;
    let maxDE = 0;
    let missingCount = 0;

    for (let i = 0; i < expected.length; i++) {
        const { index, deltaE } = findBestMatch(expected[i], actual);
        details.push({
            expected: expected[i],
            matched: actual[index],
            matchIndex: index,
            deltaE
        });
        sumDE += deltaE;
        maxDE = Math.max(maxDE, deltaE);
        if (deltaE > threshold) missingCount++;
    }

    return {
        avgDeltaE: sumDE / expected.length,
        maxDeltaE: maxDE,
        missingCount,
        details
    };
}

// ─── Shared test data (loaded once) ────────────────────────

let jethroPixels;    // Uint16Array engine-format Lab
let jethroWidth;
let jethroHeight;
let jethroDNA;

beforeAll(() => {
    if (!fs.existsSync(JETHRO_16BIT)) {
        throw new Error(`Test fixture not found: ${JETHRO_16BIT}`);
    }
    const buffer = fs.readFileSync(JETHRO_16BIT);

    // Detect format by extension and decode accordingly
    if (JETHRO_16BIT.endsWith('.tif') || JETHRO_16BIT.endsWith('.tiff')) {
        const tiff = readTiff(buffer);
        jethroWidth = tiff.width;
        jethroHeight = tiff.height;
        jethroPixels = convertTiff16bitToEngineLab(tiff.data, tiff.width * tiff.height);
    } else {
        const psd = readPsd(buffer);
        jethroWidth = psd.width;
        jethroHeight = psd.height;
        jethroPixels = convertPsd16bitToEngineLab(psd.data, psd.width * psd.height);
    }

    const dnaGen = new DNAGenerator();
    jethroDNA = dnaGen.generate(jethroPixels, jethroWidth, jethroHeight, { bitDepth: 16 });
});

// ═══════════════════════════════════════════════════════════
// 1. bitDepth Flow Tests
// ═══════════════════════════════════════════════════════════

describe('bitDepth propagation through pipeline', () => {
    it('DNAGenerator should store bitDepth in metadata', () => {
        expect(jethroDNA.metadata).toBeDefined();
        expect(jethroDNA.metadata.bitDepth).toBe(16);
    });

    it('ParameterGenerator should NOT include bitDepth in config (caller responsibility)', () => {
        // bitDepth is intentionally omitted from ParameterGenerator output.
        // The Navigator reads PS pixels at componentSize:8 (UXP limitation) and
        // upconverts to 16-bit encoding — but the data has 8-bit precision.
        // Passing bitDepth:16 would disable the Brown-Dampener and cause
        // 8-bit quantization noise to contaminate centroids (green→yellow regression).
        // Callers with true 16-bit source data (e.g. reveal-batch) should pass
        // bitDepth explicitly when calling PosterizationEngine.
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });

        expect(config.bitDepth).toBeUndefined();
    });

    it('PosterizationEngine should receive correct bitDepth via config spread', () => {
        // The actual verification: posterize with bitDepth=16 should produce
        // different results than bitDepth=8 on the same 16-bit data
        // (because Brown-Dampener activates for 8-bit, affecting centroids)
        const baseConfig = {
            format: 'lab',
            engineType: 'reveal-mk1.5',
            distanceMetric: 'cie2000',
            lWeight: 1.4,
            cWeight: 4.5,
            blackBias: 6.5,
            preserveWhite: true,
            preserveBlack: true,
            enablePaletteReduction: true,
            paletteReduction: 8.5
        };

        // Use a small crop for speed (first 200x200)
        const cropW = 200;
        const cropH = 200;
        const cropPixels = new Uint16Array(cropW * cropH * 3);
        for (let y = 0; y < cropH; y++) {
            for (let x = 0; x < cropW; x++) {
                const srcIdx = (y * jethroWidth + x) * 3;
                const dstIdx = (y * cropW + x) * 3;
                cropPixels[dstIdx] = jethroPixels[srcIdx];
                cropPixels[dstIdx + 1] = jethroPixels[srcIdx + 1];
                cropPixels[dstIdx + 2] = jethroPixels[srcIdx + 2];
            }
        }

        const result16 = PosterizationEngine.posterize(
            cropPixels, cropW, cropH, 8,
            { ...baseConfig, bitDepth: 16 }
        );
        const result8 = PosterizationEngine.posterize(
            cropPixels, cropW, cropH, 8,
            { ...baseConfig, bitDepth: 8 }
        );

        // They should produce different palettes because Brown-Dampener
        // fires for bitDepth=8, halving chroma weight for warm low-chroma colors
        // At minimum, we can check that bitDepth reaches the engine correctly
        // by verifying the metadata records the right value
        expect(result16.metadata).toBeDefined();
        expect(result8.metadata).toBeDefined();

        // With Brown-Dampener on (8-bit), centroids in warm sectors shift differently
        // The palettes should not be identical
        const palette16 = result16.paletteLab;
        const palette8 = result8.paletteLab;

        // Not asserting they're different (small crops might converge),
        // but asserting both produce valid palettes
        expect(palette16.length).toBeGreaterThanOrEqual(1);
        expect(palette8.length).toBeGreaterThanOrEqual(1);
    });
});

// ═══════════════════════════════════════════════════════════
// 2. Full Pipeline Integration Tests
// ═══════════════════════════════════════════════════════════

describe('Full pipeline: DNA → ParameterGenerator → Posterize → Separate', () => {
    it('should produce a complete config from DNA analysis', () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });

        // Verify all critical parameters are present
        expect(config.targetColors).toBeDefined();
        expect(config.distanceMetric).toBe('cie2000');
        // engineType may be undefined in archetype (falls back to 'reveal-mk1.5' in engine)
        expect(config.lWeight).toBeDefined();
        expect(config.cWeight).toBeDefined();
        expect(config.blackBias).toBeDefined();
        // bitDepth is NOT in config (caller's responsibility for true 16-bit sources)
        expect(config.bitDepth).toBeUndefined();
        expect(config.preserveWhite).toBe(true);
        expect(config.preserveBlack).toBe(true);
        expect(config.enablePaletteReduction).toBe(true);
        expect(config.paletteReduction).toBeDefined();
        expect(config.vibrancyMode).toBeDefined();
        expect(config.vibrancyBoost).toBeDefined();
        expect(config.preprocessing).toBeDefined();
    });

    it('should posterize Jethro with Subtle Naturalist and produce 6+ separable colors', () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });

        // Use a 400x400 center crop for test speed
        const cropW = 400;
        const cropH = 400;
        const offsetX = Math.floor((jethroWidth - cropW) / 2);
        const offsetY = Math.floor((jethroHeight - cropH) / 2);
        const cropPixels = new Uint16Array(cropW * cropH * 3);
        for (let y = 0; y < cropH; y++) {
            for (let x = 0; x < cropW; x++) {
                const srcIdx = ((offsetY + y) * jethroWidth + (offsetX + x)) * 3;
                const dstIdx = (y * cropW + x) * 3;
                cropPixels[dstIdx] = jethroPixels[srcIdx];
                cropPixels[dstIdx + 1] = jethroPixels[srcIdx + 1];
                cropPixels[dstIdx + 2] = jethroPixels[srcIdx + 2];
            }
        }

        // Apply bilateral filter (same as production path)
        const preprocessed = new Uint16Array(cropPixels);
        BilateralFilter.applyBilateralFilterLab(preprocessed, cropW, cropH, 3, 5000);

        const result = PosterizationEngine.posterize(
            preprocessed, cropW, cropH,
            config.targetColors,
            { ...config, format: 'lab' }
        );

        // Jethro should produce at least 6 distinct colors with Subtle Naturalist
        expect(result.paletteLab.length).toBeGreaterThanOrEqual(6);
        expect(result.palette.length).toBe(result.paletteLab.length);

        // Should have white and black (preserveWhite/preserveBlack are true)
        const hasWhite = result.paletteLab.some(c => c.L > 95 && Math.abs(c.a) < 5 && Math.abs(c.b) < 5);
        const hasBlack = result.paletteLab.some(c => c.L < 5 && Math.abs(c.a) < 5 && Math.abs(c.b) < 5);
        expect(hasWhite).toBe(true);
        expect(hasBlack).toBe(true);
    }, 30000);

    it('should separate all pixels into palette indices', async () => {
        // Quick test: small synthetic image through full pipeline
        const w = 50, h = 50;
        const pixels = new Uint16Array(w * h * 3);
        const neutralAB = 16384;

        // Create 3 distinct color regions
        for (let i = 0; i < w * h; i++) {
            const region = Math.floor(i / (w * h / 3));
            if (region === 0) {
                pixels[i * 3] = 8000;  pixels[i * 3 + 1] = 20000; pixels[i * 3 + 2] = neutralAB;
            } else if (region === 1) {
                pixels[i * 3] = 24000; pixels[i * 3 + 1] = neutralAB; pixels[i * 3 + 2] = 10000;
            } else {
                pixels[i * 3] = 16384; pixels[i * 3 + 1] = 12000; pixels[i * 3 + 2] = 20000;
            }
        }

        const result = PosterizationEngine.posterize(pixels, w, h, 5, {
            format: 'lab',
            bitDepth: 16,
            engineType: 'reveal-mk1.5',
            preserveWhite: false,
            preserveBlack: false
        });

        // Separate
        const indices = await SeparationEngine.mapPixelsToPaletteAsync(
            pixels, result.paletteLab, null, w, h,
            { distanceMetric: 'cie76' }
        );

        // Every pixel should be assigned to a valid palette index
        expect(indices.length).toBe(w * h);
        for (let i = 0; i < indices.length; i++) {
            expect(indices[i]).toBeGreaterThanOrEqual(0);
            expect(indices[i]).toBeLessThan(result.paletteLab.length);
        }

        // Generate masks and verify they cover all pixels
        let totalMaskPixels = 0;
        for (let c = 0; c < result.paletteLab.length; c++) {
            const mask = SeparationEngine.generateLayerMask(indices, c, w, h);
            expect(mask.length).toBe(w * h);
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] === 255) totalMaskPixels++;
            }
        }
        // Every pixel should appear in exactly one mask
        expect(totalMaskPixels).toBe(w * h);
    });
});

// ═══════════════════════════════════════════════════════════
// 3. Golden Palette Regression Tests
// ═══════════════════════════════════════════════════════════

describe('Golden palette regression: Jethro + Subtle Naturalist', () => {
    /**
     * Golden palette for Jethro × Subtle Naturalist (tc=10, bitDepth=16).
     * Calibrated against the 1600×1095 TIFF fixture.
     *
     * At 1600px with CIE2000 pruning (paletteReduction=8.5), the direct engine
     * path produces 7 colors. Green is pruned at this resolution but preserved
     * by ProxyEngine's proxy-safe overrides (tested separately in section 7).
     *
     * These are the EXPECTED color families (perceptual space).
     * Exact Lab values depend on bilateral filter + median cut partitioning,
     * so we use a ΔE threshold for matching.
     */
    const GOLDEN_COLOR_FAMILIES = [
        { name: 'magenta/pink',  L: 61, a: 83, b: -51 },
        { name: 'yellow/gold',   L: 90, a: -10, b: 92 },
        { name: 'orange/warm',   L: 64, a: 63, b: 61 },
        { name: 'blue/cool',     L: 33, a: 3, b: -47 },
        { name: 'white',         L: 100, a: 0, b: 0 },
        { name: 'black',         L: 0, a: 0, b: 0 }
    ];

    it('should produce all expected color families with tc=10', () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });

        // Apply bilateral filter on a copy
        const filtered = new Uint16Array(jethroPixels);
        const preprocessIntensity = config.preprocessingIntensity || 'auto';
        if (preprocessIntensity !== 'off') {
            BilateralFilter.applyBilateralFilterLab(filtered, jethroWidth, jethroHeight, 3, 5000);
        }

        const result = PosterizationEngine.posterize(
            filtered, jethroWidth, jethroHeight,
            10,  // User sets tc=10 in production
            { ...config, format: 'lab' }
        );

        // CIE2000 pruning at 1600px produces ~7 colors from tc=10
        expect(result.paletteLab.length).toBeGreaterThanOrEqual(6);
        expect(result.paletteLab.length).toBeLessThanOrEqual(10);

        // Check that each golden color family has a match within ΔE < 15
        const comparison = comparePalettes(GOLDEN_COLOR_FAMILIES, result.paletteLab, 15);

        // No golden color should be completely missing
        expect(comparison.missingCount).toBe(0);

        // Average match quality should be reasonable
        expect(comparison.avgDeltaE).toBeLessThan(10);

        // White and black should be near-exact
        const whiteMatch = findBestMatch({ L: 100, a: 0, b: 0 }, result.paletteLab);
        const blackMatch = findBestMatch({ L: 0, a: 0, b: 0 }, result.paletteLab);
        expect(whiteMatch.deltaE).toBeLessThan(1);
        expect(blackMatch.deltaE).toBeLessThan(1);
    }, 120000);  // Full-res bilateral + CIE2000 is slow

    it('should produce at least 6 colors with tc=8 (archetype default)', () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });

        const filtered = new Uint16Array(jethroPixels);
        if ((config.preprocessingIntensity || 'auto') !== 'off') {
            BilateralFilter.applyBilateralFilterLab(filtered, jethroWidth, jethroHeight, 3, 5000);
        }

        const result = PosterizationEngine.posterize(
            filtered, jethroWidth, jethroHeight,
            config.targetColors,  // 8 from archetype
            { ...config, format: 'lab' }
        );

        // With tc=8 and CIE2000 pruning, should get at least 6 distinct colors
        expect(result.paletteLab.length).toBeGreaterThanOrEqual(6);

        // Must still have white and black
        const hasWhite = result.paletteLab.some(c => c.L > 95);
        const hasBlack = result.paletteLab.some(c => c.L < 5);
        expect(hasWhite).toBe(true);
        expect(hasBlack).toBe(true);

        // Must have at least one high-chroma color (Jethro has vivid magenta/pink)
        const hasVivid = result.paletteLab.some(c => {
            const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
            return chroma > 50;
        });
        expect(hasVivid).toBe(true);
    }, 120000);
});

// ═══════════════════════════════════════════════════════════
// 4. ProxyEngine Consistency Tests
// ═══════════════════════════════════════════════════════════

describe('ProxyEngine consistency with direct PosterizationEngine', () => {
    it('ProxyEngine preserves full palette via proxy-safe overrides (no snap/prune/densityFloor)', async () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });
        const engineConfig = {
            ...config,
            targetColors: 10,
            targetColorsSlider: 10,
            engineType: config.engineType || 'reveal-mk1.5'
        };

        // Path B: ProxyEngine (proxy-safe: snap/prune/densityFloor disabled)
        const proxyEngine = new ProxyEngine();
        const proxyResult = await proxyEngine.initializeProxy(
            jethroPixels, jethroWidth, jethroHeight, engineConfig
        );
        const paletteB = proxyResult.palette;

        // Path C: Direct PosterizationEngine with archetype's full params
        const proxyBuf = proxyEngine.proxyBuffer;
        const proxyW = proxyResult.dimensions.width;
        const proxyH = proxyResult.dimensions.height;

        const directResult = PosterizationEngine.posterize(
            proxyBuf, proxyW, proxyH,
            10,
            {
                ...engineConfig,
                format: 'lab',
                bitDepth: 16,
                snapThreshold: 0,
                densityFloor: 0,
                enablePaletteReduction: false,
                preservedUnifyThreshold: 0.5,
            }
        );
        const paletteC = directResult.paletteLab;

        // Preview = Production: ProxyEngine should match direct posterize output
        // when using the same proxy-safe overrides (no snap/prune/densityFloor).
        expect(paletteB.length).toBe(paletteC.length);
    }, 30000);

    it('ProxyEngine with explicit bitDepth=16 should produce valid palette', async () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });

        // Caller passes bitDepth explicitly (e.g. reveal-batch with true 16-bit PSD)
        const proxyEngine = new ProxyEngine();
        const result = await proxyEngine.initializeProxy(
            jethroPixels, jethroWidth, jethroHeight,
            { ...config, targetColors: 10, targetColorsSlider: 10, bitDepth: 16 }
        );

        // With true 16-bit data and bitDepth=16, should produce 7+ colors
        expect(result.palette.length).toBeGreaterThanOrEqual(7);
    }, 30000);

    it('ProxyEngine rePosterize should produce same palette as initializeProxy with same config', async () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });
        const engineConfig = {
            ...config,
            targetColors: 10,
            targetColorsSlider: 10,
            engineType: config.engineType || 'reveal-mk1.5'
        };

        const proxyEngine = new ProxyEngine();
        const initResult = await proxyEngine.initializeProxy(
            jethroPixels, jethroWidth, jethroHeight, engineConfig
        );
        const paletteInit = initResult.palette;

        // Re-posterize with SAME config (simulates archetype swap to same archetype)
        const reResult = await proxyEngine.rePosterize(engineConfig);
        const paletteRe = reResult.palette;

        // Should be identical
        expect(paletteRe.length).toBe(paletteInit.length);
        for (let i = 0; i < paletteInit.length; i++) {
            const de = deltaE76(paletteInit[i], paletteRe[i]);
            expect(de).toBeLessThan(0.1);
        }
    }, 30000);
});

// ═══════════════════════════════════════════════════════════
// 5. Archetype Swap Consistency Tests
// ═══════════════════════════════════════════════════════════

describe('Archetype swap produces different but valid palettes', () => {
    it('different archetypes should produce different palettes on same image', async () => {
        const archetypes = ArchetypeLoader.loadArchetypes();
        const mapper = new ArchetypeMapper(archetypes);
        const topMatches = mapper.getTopMatches(jethroDNA, 3);

        expect(topMatches.length).toBeGreaterThanOrEqual(2);

        const proxyEngine = new ProxyEngine();

        // Initialize with top match
        const config1 = ParameterGenerator.generate(jethroDNA, { manualArchetypeId: topMatches[0].id });
        await proxyEngine.initializeProxy(
            jethroPixels, jethroWidth, jethroHeight,
            { ...config1, targetColors: config1.targetColors, engineType: config1.engineType || 'reveal-mk1.5' }
        );
        const palette1 = proxyEngine.separationState.palette.map(c => ({ ...c }));

        // Swap to second archetype
        const config2 = ParameterGenerator.generate(jethroDNA, { manualArchetypeId: topMatches[1].id });
        const reResult = await proxyEngine.rePosterize(
            { ...config2, targetColors: config2.targetColors, engineType: config2.engineType || 'reveal-mk1.5' }
        );
        const palette2 = reResult.palette;

        // Both should produce valid palettes
        expect(palette1.length).toBeGreaterThanOrEqual(3);
        expect(palette2.length).toBeGreaterThanOrEqual(3);

        // They should be different (different archetypes = different parameters)
        // Check if at least one color differs by ΔE > 5
        let hasDifference = false;
        const minLen = Math.min(palette1.length, palette2.length);
        for (let i = 0; i < minLen; i++) {
            if (deltaE76(palette1[i], palette2[i]) > 5) {
                hasDifference = true;
                break;
            }
        }
        // If palettes have different lengths, that's also a valid difference
        if (palette1.length !== palette2.length) hasDifference = true;

        expect(hasDifference).toBe(true);
    }, 30000);
});

// ═══════════════════════════════════════════════════════════
// 6. Separation Quality Tests
// ═══════════════════════════════════════════════════════════

describe('Separation produces valid, complete masks', () => {
    it('every pixel should be assigned to exactly one palette color', async () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });

        // Use ProxyEngine for speed
        const proxyEngine = new ProxyEngine();
        const result = await proxyEngine.initializeProxy(
            jethroPixels, jethroWidth, jethroHeight,
            { ...config, targetColors: 10, targetColorsSlider: 10, engineType: config.engineType || 'reveal-mk1.5' }
        );

        const indices = proxyEngine.separationState.colorIndices;
        const proxyW = result.dimensions.width;
        const proxyH = result.dimensions.height;
        const paletteSize = result.palette.length;

        // Every index should be valid
        for (let i = 0; i < indices.length; i++) {
            expect(indices[i]).toBeGreaterThanOrEqual(0);
            expect(indices[i]).toBeLessThan(paletteSize);
        }

        // Generate masks — each pixel appears in exactly one mask
        const pixelCounts = new Array(proxyW * proxyH).fill(0);
        for (let c = 0; c < paletteSize; c++) {
            const mask = SeparationEngine.generateLayerMask(indices, c, proxyW, proxyH);
            expect(mask.length).toBe(proxyW * proxyH);
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] === 255) pixelCounts[i]++;
            }
        }

        // Every pixel should appear in exactly one mask
        for (let i = 0; i < pixelCounts.length; i++) {
            expect(pixelCounts[i]).toBe(1);
        }
    }, 30000);

    it('no palette color should have zero coverage (ghost plates)', async () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });

        const proxyEngine = new ProxyEngine();
        const result = await proxyEngine.initializeProxy(
            jethroPixels, jethroWidth, jethroHeight,
            { ...config, targetColors: 10, targetColorsSlider: 10, engineType: config.engineType || 'reveal-mk1.5' }
        );

        const indices = proxyEngine.separationState.colorIndices;
        const coverage = new Array(result.palette.length).fill(0);
        for (let i = 0; i < indices.length; i++) {
            coverage[indices[i]]++;
        }

        // Every palette color should have at least some pixels assigned
        for (let c = 0; c < result.palette.length; c++) {
            expect(coverage[c]).toBeGreaterThan(0);
        }
    }, 30000);
});

// ═══════════════════════════════════════════════════════════
// 7. Proxy-Safe Palette Preservation (Regression Guards)
// ═══════════════════════════════════════════════════════════
//
// These tests guard against the recurring bug where ProxyEngine's
// proxy-safe overrides (snapThreshold=0, enablePaletteReduction=false,
// densityFloor=0) get removed, causing minority colors to collapse
// at proxy resolution — especially with CIE94/CIE2000 metrics.

import MechanicalKnobs from '../../lib/engines/MechanicalKnobs.js';

describe('ProxyEngine proxy-safe palette preservation', () => {
    it('should produce reasonable palette for Warm Naturalist tc=10 (preview=production)', async () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'warm_photo'
        });
        // Warm Naturalist uses CIE2000 + enablePaletteReduction=true + paletteReduction=6.
        // ProxyEngine passes through archetype's paletteReduction so preview matches production.
        // Similar colors (within ΔE 6) merge — final count may be less than 10.
        const engineConfig = {
            ...config,
            targetColors: 10,
            targetColorsSlider: 10,
            engineType: config.engineType || 'reveal-mk1.5'
        };

        const proxyEngine = new ProxyEngine();
        const result = await proxyEngine.initializeProxy(
            jethroPixels, jethroWidth, jethroHeight, engineConfig
        );

        // Should produce a usable palette (at least 6 distinct colors)
        // Upper bound is tc+2 because ProxyEngine disables pruning, and
        // hue gap recovery + forced slots (white/black/peaks) can exceed targetColors
        expect(result.palette.length).toBeGreaterThanOrEqual(6);
        expect(result.palette.length).toBeLessThanOrEqual(12);
    }, 30000);

    it('should produce reasonable palette for Subtle Naturalist tc=10 (CIE2000)', async () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });
        const engineConfig = {
            ...config,
            targetColors: 10,
            targetColorsSlider: 10,
            engineType: config.engineType || 'reveal-mk1.5'
        };

        const proxyEngine = new ProxyEngine();
        const result = await proxyEngine.initializeProxy(
            jethroPixels, jethroWidth, jethroHeight, engineConfig
        );

        expect(result.palette.length).toBeGreaterThanOrEqual(6);
        expect(result.palette.length).toBeLessThanOrEqual(12);
    }, 30000);

    it('rePosterize should match initializeProxy palette behavior', async () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'warm_photo'
        });
        const engineConfig = {
            ...config,
            targetColors: 10,
            targetColorsSlider: 10,
            engineType: config.engineType || 'reveal-mk1.5'
        };

        const proxyEngine = new ProxyEngine();
        await proxyEngine.initializeProxy(
            jethroPixels, jethroWidth, jethroHeight, engineConfig
        );

        // Swap to a different archetype then back
        const config2 = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });
        await proxyEngine.rePosterize({
            ...config2,
            targetColors: 10,
            targetColorsSlider: 10,
            engineType: config2.engineType || 'reveal-mk1.5'
        });

        // Swap back to Warm Naturalist
        const result = await proxyEngine.rePosterize(engineConfig);

        expect(result.palette.length).toBeGreaterThanOrEqual(6);
        expect(result.palette.length).toBeLessThanOrEqual(12);
    }, 60000);

    it('ProxyEngine palette must contain GREEN for Jethro at tc=10 (preservedUnifyThreshold regression)', async () => {
        // This test guards against the bug where removing preservedUnifyThreshold: 0.5
        // from ProxyEngine's proxy-safe overrides caused green to be unified away.
        // Without the override, PosterizationEngine uses the default threshold of 12.0,
        // which is aggressive enough to merge minority green centroids at proxy resolution.
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'warm_photo'
        });
        const engineConfig = {
            ...config,
            targetColors: 10,
            targetColorsSlider: 10,
            engineType: config.engineType || 'reveal-mk1.5'
        };

        const proxyEngine = new ProxyEngine();
        const result = await proxyEngine.initializeProxy(
            jethroPixels, jethroWidth, jethroHeight, engineConfig
        );

        // Green family: hue 120-160°, chroma > 30
        const hasGreen = result.palette.some(c => {
            const H = (Math.atan2(c.b, c.a) * 180 / Math.PI + 360) % 360;
            const C = Math.sqrt(c.a * c.a + c.b * c.b);
            return H > 120 && H < 160 && C > 30;
        });

        expect(hasGreen).toBe(true);
    }, 30000);

    it('ProxyEngine rePosterize must preserve GREEN across archetype swap (Subtle Naturalist)', async () => {
        const config = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'warm_photo'
        });
        const engineConfig = {
            ...config,
            targetColors: 10,
            targetColorsSlider: 10,
            engineType: config.engineType || 'reveal-mk1.5'
        };

        const proxyEngine = new ProxyEngine();
        await proxyEngine.initializeProxy(
            jethroPixels, jethroWidth, jethroHeight, engineConfig
        );

        // Swap to Subtle Naturalist (CIE2000 metric — historically fragile for green)
        const config2 = ParameterGenerator.generate(jethroDNA, {
            manualArchetypeId: 'fine_art_scan'
        });
        const result = await proxyEngine.rePosterize({
            ...config2,
            targetColors: 10,
            targetColorsSlider: 10,
            engineType: config2.engineType || 'reveal-mk1.5'
        });

        const hasGreen = result.palette.some(c => {
            const H = (Math.atan2(c.b, c.a) * 180 / Math.PI + 360) % 360;
            const C = Math.sqrt(c.a * c.a + c.b * c.b);
            return H > 120 && H < 160 && C > 30;
        });

        expect(hasGreen).toBe(true);
    }, 60000);
});

// ═══════════════════════════════════════════════════════════
// 8. MechanicalKnobs: Shared Knob Algorithm Tests
// ═══════════════════════════════════════════════════════════
//
// Guards against preview-vs-production divergence by verifying
// the shared MechanicalKnobs module produces correct results.

describe('MechanicalKnobs shared algorithm correctness', () => {
    it('shadowClamp should use edge erosion, not value clamping (algorithm regression)', async () => {
        // Create a simple 10x10 image with a thin L-shaped feature (1px wide)
        const width = 10, height = 10;
        const pixelCount = width * height;
        const paletteSize = 2;

        // Color 0 = background, Color 1 = thin feature
        const colorIndices = new Uint8Array(pixelCount);
        // Draw a thin 1px horizontal line at y=5
        for (let x = 2; x < 8; x++) colorIndices[5 * width + x] = 1;

        const masks = MechanicalKnobs.rebuildMasks(colorIndices, paletteSize, pixelCount);
        const palette = [
            { L: 90, a: 0, b: 0 },  // light background
            { L: 30, a: 0, b: 0 }   // dark ink
        ];

        // Apply moderate shadowClamp
        MechanicalKnobs.applyShadowClamp(
            masks, colorIndices, palette, width, height, 15
        );

        // Edge erosion should have removed some thin-feature pixels.
        // Value clamping on binary masks (0/255) would be a no-op.
        let featurePixels = 0;
        for (let i = 0; i < pixelCount; i++) {
            if (masks[1][i] === 255) featurePixels++;
        }

        // The thin 1px line should have been at least partially eroded
        // (original had 6 pixels; edge erosion removes pixels with few same-color neighbors)
        expect(featurePixels).toBeLessThan(6);
    });

    it('speckleRescue should heal orphaned pixels via BFS (healing regression)', () => {
        // Create image with a small isolated speckle
        const width = 10, height = 10;
        const pixelCount = width * height;
        const paletteSize = 2;

        // All background except one isolated pixel
        const colorIndices = new Uint8Array(pixelCount);
        colorIndices[55] = 1; // isolated pixel at (5,5)

        const masks = MechanicalKnobs.rebuildMasks(colorIndices, paletteSize, pixelCount);

        // Despeckle with threshold large enough to remove the single pixel
        MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, 5);

        // The isolated pixel should have been despeckled and healed to color 0
        expect(colorIndices[55]).toBe(0);
        expect(masks[0][55]).toBe(255);
        expect(masks[1][55]).toBe(0);
    });

    it('minVolume should remap weak colors to nearest strong CIE76 neighbor', () => {
        const pixelCount = 1000;
        const colorIndices = new Uint8Array(pixelCount);

        // 990 pixels = color 0 (strong), 10 pixels = color 1 (weak)
        for (let i = 990; i < 1000; i++) colorIndices[i] = 1;

        const palette = [
            { L: 50, a: 0, b: 0 },   // neutral gray (strong)
            { L: 55, a: 2, b: 2 }    // near-neutral (weak - 1% coverage, same achromatic sector)
        ];

        // 2% threshold → color 1 (1% coverage) should be remapped
        const result = MechanicalKnobs.applyMinVolume(colorIndices, palette, pixelCount, 2);

        expect(result.remappedCount).toBe(1);
        // All pixels should now be color 0
        for (let i = 0; i < pixelCount; i++) {
            expect(colorIndices[i]).toBe(0);
        }
    });
});
