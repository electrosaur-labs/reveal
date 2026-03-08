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

    // 3. Bilateral prefilter
    const BilateralFilter = Reveal.BilateralFilter;
    // Work on a copy so we don't mutate the shared buffer in compare mode
    let workLab = options.dna ? new Uint16Array(lab16bit) : lab16bit;

    if (config.preprocessingIntensity === 'off') {
        progress('preprocess', 'Preprocessing skipped');
    } else {
        const entropyScore = BilateralFilter.calculateEntropyScoreLab(workLab, width, height);
        const decision = BilateralFilter.shouldPreprocess(dna, entropyScore, true);
        if (decision.shouldProcess) {
            progress('preprocess', `Bilateral filter: radius=${decision.radius}, sigmaR=${decision.sigmaR}`);
            BilateralFilter.applyBilateralFilterLab(workLab, width, height, decision.radius, decision.sigmaR);
        } else {
            progress('preprocess', `Preprocessing skipped: ${decision.reason}`);
        }
    }

    // 4. Median filter
    const MedianFilter = Reveal.MedianFilter;
    if (MedianFilter.shouldApply(dna, config)) {
        progress('median', 'Median filter applied');
        workLab = MedianFilter.apply3x3(workLab, width, height);
    }

    // 5. Posterize
    const params = Reveal.ParameterGenerator.toEngineOptions(config, { bitDepth: 16 });
    progress('posterize', `Posterizing to ${params.targetColorsSlider} colors...`);
    const posterizeResult = await Reveal.posterizeImage(workLab, width, height, params.targetColorsSlider, params);
    progress('posterize', `Generated ${posterizeResult.paletteLab.length} colors`);

    // 6. Map pixels to palette
    progress('map', 'Mapping pixels to palette...');
    const SeparationEngine = Reveal.engines.SeparationEngine;
    let colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
        workLab, posterizeResult.paletteLab, null, width, height,
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
