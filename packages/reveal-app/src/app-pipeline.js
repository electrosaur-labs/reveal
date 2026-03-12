/**
 * app-pipeline.js — 3+1 archetype comparison pipeline.
 *
 * Wraps reveal-cli's processSingle() to compute N archetype passes
 * with progressive delivery (onCardReady callback).
 */

const Reveal = require('@electrosaur-labs/core');
const { LabEncoding } = Reveal;

// ─── Proxy sizing (match ProxyEngine) ───
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

const PROXY_SAFE_OVERRIDES = Object.freeze({
    format: 'lab',
    bitDepth: 16,
    snapThreshold: 0,
    densityFloor: 0,
    preservedUnifyThreshold: 0.5,
});

const PSEUDO_ARCHETYPES = {
    'chameleon':  dna => Reveal.generateConfigurationMk2(dna),
    'distilled':  dna => Reveal.generateConfigurationDistilled(dna),
    'salamander': dna => Reveal.generateConfigurationSalamander(dna),
};

/**
 * Compute DNA from Lab16 buffer.
 */
function computeDna(lab16bit, width, height) {
    const dna = Reveal.DNAGenerator.fromPixels(lab16bit, width, height, { bitDepth: 16 });
    dna.l = dna.global.l;
    dna.c = dna.global.c;
    dna.k = dna.global.k;
    dna.l_std_dev = dna.global.l_std_dev;
    dna.maxC = Math.max(...Object.values(dna.sectors).map(s => s.cMax || 0));
    return dna;
}

/**
 * Process a single archetype pass — returns card data with RGBA preview.
 */
async function processSingleCard(lab16bit, width, height, archetypeId, cardIndex, dna) {
    dna = dna || computeDna(lab16bit, width, height);

    // Generate config
    let config;
    if (PSEUDO_ARCHETYPES[archetypeId]) {
        config = PSEUDO_ARCHETYPES[archetypeId](dna);
        config.meta = config.meta || {};
        config.meta.archetypeId = archetypeId;
        config.meta.archetype = archetypeId;
    } else {
        config = Reveal.ParameterGenerator.generate(dna, {
            imageData: null, width, height,
            preprocessingIntensity: 'auto',
            manualArchetypeId: archetypeId
        });
    }

    // Stride subsample to proxy
    const proxy = strideSubsample(lab16bit, width, height, 800);
    let proxyLab = new Uint16Array(proxy.buffer);

    // Bilateral prefilter
    const preprocessingIntensity = config.preprocessingIntensity || 'auto';
    if (preprocessingIntensity !== 'off') {
        const radius = preprocessingIntensity === 'heavy' ? 5 : 3;
        Reveal.BilateralFilter.applyBilateralFilterLab(proxyLab, proxy.width, proxy.height, radius, 5000);
    }

    // Posterize
    const params = Reveal.ParameterGenerator.toEngineOptions(config, { bitDepth: 16 });
    const posterizeConfig = { ...params, ...PROXY_SAFE_OVERRIDES };
    const targetColors = posterizeConfig.targetColorsSlider || posterizeConfig.targetColors || 8;
    const result = await Reveal.posterizeImage(proxyLab, proxy.width, proxy.height, targetColors, posterizeConfig);

    // Generate RGBA preview from assignments + RGB palette
    const pixelCount = proxy.width * proxy.height;
    const rgbaPreview = new Uint8ClampedArray(pixelCount * 4);
    if (result.assignments) {
        for (let i = 0; i < pixelCount; i++) {
            const rgb = result.palette[result.assignments[i]];
            const off = i * 4;
            rgbaPreview[off]     = Math.round(rgb.r);
            rgbaPreview[off + 1] = Math.round(rgb.g);
            rgbaPreview[off + 2] = Math.round(rgb.b);
            rgbaPreview[off + 3] = 255;
        }
    }

    // Build palette swatches
    const hexColors = result.palette.map(rgb =>
        '#' + [rgb.r, rgb.g, rgb.b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase()
    );

    // Coverage
    const coverageCounts = new Uint32Array(result.paletteLab.length);
    if (result.assignments) {
        for (let i = 0; i < result.assignments.length; i++) {
            coverageCounts[result.assignments[i]]++;
        }
    }
    const coverage = Array.from(coverageCounts).map(c => c / pixelCount);

    return {
        cardIndex,
        archetypeId: config.meta?.archetypeId || archetypeId,
        archetypeName: config.meta?.archetype || archetypeId,
        matchScore: config.meta?.matchScore || null,
        hexColors,
        coverage,
        previewWidth: proxy.width,
        previewHeight: proxy.height,
        // RGBA as base64 for WebSocket transport
        previewRgba: Buffer.from(rgbaPreview.buffer, rgbaPreview.byteOffset, rgbaPreview.byteLength).toString('base64'),
        colorCount: result.paletteLab.length,
        // Store full result for export
        _paletteLab: result.paletteLab,
        _paletteRgb: result.palette,
        _config: config,
        _dna: dna,
    };
}

/**
 * Run the 3+1 comparison: Auto, Chameleon, Distilled.
 * The +1 (user pick) is handled separately via processSingleCard.
 */
async function processArchetypeComparison(lab16bit, width, height, { onCardReady, onProgress }) {
    onProgress('Computing image DNA...');
    const dna = computeDna(lab16bit, width, height);
    onProgress(`DNA: L=${dna.global.l}, C=${dna.global.c}, K=${dna.global.k}, entropy=${dna.global.hue_entropy}`);

    // Detect best archetype
    const autoConfig = Reveal.ParameterGenerator.generate(dna, {
        imageData: null, width, height, preprocessingIntensity: 'auto'
    });
    const autoId = autoConfig.meta?.archetypeId || 'full_spectrum';

    const passes = [
        { id: 'distilled', label: 'Distilled' },
        { id: 'chameleon', label: 'Chameleon' },
        { id: 'salamander', label: 'Salamander' },
        { id: autoId, label: `Auto (${autoId})` },
    ];

    const results = [];

    for (let i = 0; i < passes.length; i++) {
        const { id, label } = passes[i];
        onProgress(`Processing ${label} (${id})...`);
        const card = await processSingleCard(lab16bit, width, height, id, i, dna);
        card.label = label;
        results.push(card);
        onCardReady(card);
    }

    return results;
}

/**
 * List all available archetypes for the user-pick dropdown.
 */
function listArchetypes() {
    const all = Reveal.ArchetypeLoader.loadArchetypes();
    const groups = {};

    for (const arch of all) {
        const group = arch.group || 'other';
        if (!groups[group]) groups[group] = [];
        groups[group].push({ id: arch.id, name: arch.name });
    }

    // Add pseudo-archetypes
    groups.adaptive = [
        { id: 'chameleon', name: 'Chameleon' },
        { id: 'distilled', name: 'Distilled' },
        { id: 'salamander', name: 'Salamander' },
    ];

    return groups;
}

module.exports = { processArchetypeComparison, processSingleCard, listArchetypes };
