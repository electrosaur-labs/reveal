/**
 * pipeline.js — Core processing pipeline
 *
 * Pure computation, no I/O. Takes a 16-bit Lab buffer and returns
 * posterization results (palette, masks, color indices, DNA, config).
 * Reusable by single mode and compare mode.
 *
 * @module pipeline
 */

const Reveal = require('@electrosaur-labs/core');
const { LabEncoding } = Reveal;

/**
 * Stride subsample — picks every Nth pixel, no interpolation.
 * Exactly matches ProxyEngine._strideSubsample() for output parity.
 */
function strideSubsample(src, srcW, srcH, targetSize) {
    const longEdge = Math.max(srcW, srcH);
    const s = Math.max(1, Math.ceil(longEdge / targetSize));
    const dstW = Math.ceil(srcW / s);
    const dstH = Math.ceil(srcH / s);
    const dst = new Uint16Array(dstW * dstH * 3);

    let dp = 0;
    for (let y = 0; y < srcH; y += s) {
        for (let x = 0; x < srcW; x += s) {
            const sp = (y * srcW + x) * 3;
            dst[dp++] = src[sp];
            dst[dp++] = src[sp + 1];
            dst[dp++] = src[sp + 2];
        }
    }
    return { buffer: dst, width: dstW, height: dstH };
}

// Proxy-safe overrides — must match ProxyEngine's PROXY_SAFE_OVERRIDES exactly.
const PROXY_SAFE_OVERRIDES = Object.freeze({
    format: 'lab',
    bitDepth: 16,
    snapThreshold: 0,
    densityFloor: 0,
    preservedUnifyThreshold: 0.5,
});

const PSEUDO_ARCHETYPES = {
    'chameleon':   dna => Reveal.generateConfigurationMk2(dna),
    'distilled':   dna => Reveal.generateConfigurationDistilled(dna),
    'salamander':  dna => Reveal.generateConfigurationSalamander(dna),
};

const PSEUDO_IDS = new Set(Object.keys(PSEUDO_ARCHETYPES));

/**
 * Compute image DNA from 16-bit Lab buffer.
 *
 * @param {Int32Array} lab16bit - Engine 16-bit Lab data
 * @param {number} width
 * @param {number} height
 * @returns {Object} DNA object
 */
function computeDna(lab16bit, width, height) {
    const dna = Reveal.DNAGenerator.fromPixels(lab16bit, width, height, { bitDepth: 16 });
    // Legacy shim fields for downstream consumers
    dna.l = dna.global.l;
    dna.c = dna.global.c;
    dna.k = dna.global.k;
    dna.l_std_dev = dna.global.l_std_dev;
    dna.maxC = Math.max(...Object.values(dna.sectors).map(s => s.cMax || 0));
    return dna;
}

/**
 * Auto-detect the best archetype for the given DNA.
 * Returns { archetypeId, matchScore }.
 */
function autoDetectArchetype(dna, width, height) {
    const config = Reveal.ParameterGenerator.generate(dna, {
        imageData: null, width, height, preprocessingIntensity: 'auto'
    });
    return {
        archetypeId: config.meta?.archetypeId || 'unknown',
        matchScore: config.meta?.matchScore || 0,
        config
    };
}

/**
 * Process a single image through the full posterization pipeline.
 *
 * @param {Int32Array} lab16bit - Engine 16-bit Lab pixel data
 * @param {number} width
 * @param {number} height
 * @param {Object} options
 * @param {string} [options.archetype] - Archetype ID override
 * @param {number} [options.colors] - Target color count override
 * @param {number} [options.minVolume] - Ghost plate threshold
 * @param {number} [options.speckleRescue] - Despeckle threshold
 * @param {number} [options.shadowClamp] - Ink body clamp
 * @param {number} [options.trap] - Trap width in pixels
 * @param {Object} [options.dna] - Pre-computed DNA (for compare mode)
 * @param {Function} [options.onProgress] - Progress callback (phase, message)
 * @returns {Promise<Object>} { paletteLab, paletteRgb, masks, colorIndices, dna, config, hexColors }
 */
async function processSingle(lab16bit, width, height, options = {}) {
    const progress = options.onProgress || (() => {});
    const pixelCount = width * height;

    // 1. DNA (reuse if provided, e.g. compare mode)
    const dna = options.dna || computeDna(lab16bit, width, height);
    progress('dna', `DNA: L=${dna.global.l}, C=${dna.global.c}, K=${dna.global.k}`);

    // 2. Generate configuration
    const archetypeId = options.archetype;
    let config;

    if (archetypeId && PSEUDO_ARCHETYPES[archetypeId]) {
        config = PSEUDO_ARCHETYPES[archetypeId](dna);
        config.meta = config.meta || {};
        config.meta.archetypeId = archetypeId;
        config.meta.archetype = archetypeId;
        config.meta.matchScore = null;
        config.meta.matchBreakdown = null;
        config.meta.matchRanking = [];
        progress('archetype', `Archetype: ${archetypeId} (adaptive)`);
    } else if (archetypeId) {
        config = Reveal.ParameterGenerator.generate(dna, {
            imageData: null, width, height,
            preprocessingIntensity: 'auto',
            manualArchetypeId: archetypeId
        });
        progress('archetype', `Archetype: ${config.meta?.archetype || archetypeId}`);
    } else {
        config = Reveal.ParameterGenerator.generate(dna, {
            imageData: null, width, height,
            preprocessingIntensity: 'auto'
        });
        progress('archetype', `Archetype: ${config.meta?.archetype || 'unknown'} (auto, score=${config.meta?.matchScore || 0})`);
    }

    dna.archetype = config.meta?.archetypeId;

    // Apply CLI overrides
    if (options.colors !== undefined) config.targetColors = options.colors;
    if (options.minVolume !== undefined) config.minVolume = options.minVolume;
    if (options.speckleRescue !== undefined) config.speckleRescue = options.speckleRescue;
    if (options.shadowClamp !== undefined) config.shadowClamp = options.shadowClamp;

    // 3. Stride subsample to proxy (matches ProxyEngine._strideSubsample exactly)
    const proxy = strideSubsample(lab16bit, width, height, 1000);
    const proxyW = proxy.width;
    const proxyH = proxy.height;
    let proxyLab = new Uint16Array(proxy.buffer); // copy — bilateral mutates in place
    progress('proxy', `Stride subsample ${width}x${height} → ${proxyW}x${proxyH}`);

    // 4. Bilateral prefilter (matches ProxyEngine: radius 3/5, sigmaR 5000)
    const BilateralFilter = Reveal.BilateralFilter;
    const preprocessingIntensity = config.preprocessingIntensity || 'auto';

    if (preprocessingIntensity === 'off') {
        progress('preprocess', 'Preprocessing skipped');
    } else {
        const isHeavy = preprocessingIntensity === 'heavy';
        const radius = isHeavy ? 5 : 3;
        progress('preprocess', `Bilateral filter: radius=${radius}, sigmaR=5000`);
        BilateralFilter.applyBilateralFilterLab(proxyLab, proxyW, proxyH, radius, 5000);
    }

    // 5. Posterize on proxy with PROXY_SAFE_OVERRIDES (matches ProxyEngine exactly)
    const params = Reveal.ParameterGenerator.toEngineOptions(config, { bitDepth: 16 });
    const proxyConfig = { ...params, ...PROXY_SAFE_OVERRIDES };
    progress('posterize', `Posterizing ${proxyW}x${proxyH} proxy to ${proxyConfig.targetColorsSlider || proxyConfig.targetColors} colors...`);
    const posterizeResult = await Reveal.posterizeImage(proxyLab, proxyW, proxyH, proxyConfig.targetColorsSlider || proxyConfig.targetColors, proxyConfig);
    progress('posterize', `Generated ${posterizeResult.paletteLab.length} colors`);

    // 7. Map full-res pixels to locked palette (nearest-neighbor, no re-posterize)
    progress('map', `Mapping ${width}x${height} full-res pixels to palette...`);
    const SeparationEngine = Reveal.engines.SeparationEngine;
    let colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
        lab16bit, posterizeResult.paletteLab, null, width, height,
        { ditherType: config.ditherType, distanceMetric: config.distanceMetric }
    );

    let paletteLab = posterizeResult.paletteLab;
    let paletteRgb = posterizeResult.palette;

    // 7. Palette pruning
    if (config.minVolume !== undefined && config.minVolume > 0) {
        const pruneResult = SeparationEngine.pruneWeakColors(
            paletteLab, colorIndices, width, height, config.minVolume,
            { distanceMetric: config.distanceMetric }
        );
        if (pruneResult.mergedCount > 0) {
            paletteLab = pruneResult.prunedPalette;
            colorIndices = pruneResult.remappedIndices;
            paletteRgb = paletteLab.map(lab => LabEncoding.labToRgb(lab));
            progress('prune', `Pruned: ${posterizeResult.paletteLab.length} → ${paletteLab.length} colors`);
        }
    }

    // 8. Build masks and apply knobs
    const MechanicalKnobs = Reveal.MechanicalKnobs;
    const masks = MechanicalKnobs.rebuildMasks(colorIndices, paletteLab.length, pixelCount);

    if (config.speckleRescue !== undefined && config.speckleRescue > 0) {
        progress('knobs', `speckleRescue=${config.speckleRescue}px`);
        MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, config.speckleRescue);
    }

    // 9. Trapping
    const trapPx = options.trap || 0;
    if (trapPx > 0) {
        progress('trap', `Trapping: ${trapPx}px`);
        Reveal.TrapEngine.applyTrapping(masks, paletteLab, width, height, trapPx);
    }

    // 10. Build hex colors
    const hexColors = paletteRgb.map(rgb =>
        '#' + [rgb.r, rgb.g, rgb.b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase()
    );

    // 11. Coverage
    const coverageCounts = new Uint32Array(paletteLab.length);
    for (let i = 0; i < pixelCount; i++) {
        coverageCounts[colorIndices[i]]++;
    }
    const coverage = Array.from(coverageCounts).map(c => c / pixelCount);

    progress('done', `Complete: ${paletteLab.length} colors`);

    return {
        paletteLab,
        paletteRgb,
        masks,
        colorIndices,
        dna,
        config,
        hexColors,
        coverage,
        width,
        height,
    };
}

/**
 * List all available archetypes, grouped by category.
 * @returns {Object} { graphic: [...], faithful: [...], dramatic: [...], adaptive: [...] }
 */
function listArchetypes() {
    const loader = Reveal.ArchetypeLoader;
    const all = loader.loadArchetypes();
    const groups = { graphic: [], faithful: [], dramatic: [], adaptive: [] };

    // Adaptive pseudo-archetypes
    groups.adaptive = ['chameleon', 'distilled', 'salamander'];

    for (const arch of all) {
        const group = arch.group || 'graphic';
        if (!groups[group]) groups[group] = [];
        groups[group].push(arch.id);
    }

    return groups;
}

module.exports = { processSingle, computeDna, autoDetectArchetype, listArchetypes, PSEUDO_IDS };
