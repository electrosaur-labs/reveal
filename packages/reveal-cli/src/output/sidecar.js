/**
 * sidecar.js — JSON metadata writer
 */

const fs = require('fs');

/**
 * Write JSON sidecar with separation metadata.
 *
 * @param {string} outputPath
 * @param {Object} result - Pipeline result
 * @param {Object} extra - Additional metadata (inputFile, outputFiles, etc.)
 */
function writeSidecar(outputPath, result, extra = {}) {
    const { paletteLab, paletteRgb, hexColors, coverage, dna, config } = result;

    const sidecar = {
        meta: {
            filename: extra.inputFile || '',
            timestamp: new Date().toISOString(),
            width: result.width,
            height: result.height,
            revealVersion: '1.0.0',
        },
        archetype: {
            id: config.meta?.archetypeId || null,
            name: config.meta?.archetype || null,
            score: config.meta?.matchScore || null,
            breakdown: config.meta?.matchBreakdown || null,
        },
        dna: dna ? {
            global: dna.global,
            sectors: dna.sectors,
        } : null,
        palette: paletteLab.map((lab, i) => ({
            index: i,
            name: `Ink ${i + 1} (${hexColors[i]})`,
            lab: { L: +lab.L.toFixed(2), a: +lab.a.toFixed(2), b: +lab.b.toFixed(2) },
            rgb: { r: Math.round(paletteRgb[i].r), g: Math.round(paletteRgb[i].g), b: Math.round(paletteRgb[i].b) },
            hex: hexColors[i],
            coverage: +(coverage[i] * 100).toFixed(2) + '%',
        })),
        parameters: {
            targetColors: config.targetColors,
            engineType: config.engineType,
            minVolume: config.minVolume,
            speckleRescue: config.speckleRescue,
            shadowClamp: config.shadowClamp,
            trap: extra.trap || 0,
        },
        outputs: extra.outputFiles || [],
    };

    fs.writeFileSync(outputPath, JSON.stringify(sidecar, null, 2) + '\n');
}

module.exports = { writeSidecar };
