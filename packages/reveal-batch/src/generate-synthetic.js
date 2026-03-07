#!/usr/bin/env node
/**
 * generate-synthetic.js — Create synthetic Lab PSDs that match archetype centroids
 *
 * Generates minimal 256×256 8-bit Lab PSDs whose DNA metrics reliably trigger
 * each target archetype in the ArchetypeMapper. Used to create test fixtures
 * for archetypes that lack representative images in existing datasets.
 *
 * Usage: node generate-synthetic.js <output-dir>
 *
 * Each archetype spec defines pixel regions with controlled L/a/b values
 * to hit the centroid's 7D target: L, C, K, l_std_dev, hue_entropy,
 * temperature_bias, primary_sector_weight.
 */

const fs = require('fs');
const path = require('path');
const { PSDWriter } = require('@electrosaur-labs/psd-writer');

const WIDTH = 256;
const HEIGHT = 256;
const PIXEL_COUNT = WIDTH * HEIGHT;

// Hue sectors: 12 sectors of 30° each
// To place a pixel in a given sector at chroma C and lightness L:
//   hue_angle = sector_center (in degrees)
//   a = C * cos(hue_angle)
//   b = C * sin(hue_angle)
const SECTOR_CENTERS = {
    red:        15,
    orange:     45,
    yellow:     75,
    chartreuse: 105,
    green:      135,
    cyan:       165,
    azure:      195,
    blue:       225,
    purple:     255,
    magenta:    285,
    pink:       315,
    rose:       345
};

/**
 * Convert perceptual Lab to 8-bit encoding
 * L: 0-100 → 0-255, a/b: -128..+127 → 0-255
 */
function labTo8bit(L, a, b) {
    return [
        Math.round((L / 100) * 255),
        Math.round(a + 128),
        Math.round(b + 128)
    ];
}

/**
 * Create a/b from hue sector name and chroma
 */
function sectorToAB(sectorName, chroma) {
    const angle = SECTOR_CENTERS[sectorName];
    const rad = angle * Math.PI / 180;
    return [chroma * Math.cos(rad), chroma * Math.sin(rad)];
}

/**
 * Fill a region of the Lab buffer
 * @param {Uint8ClampedArray} buf - 8-bit Lab buffer (L,a,b per pixel)
 * @param {number} startRow - Start row (0-based)
 * @param {number} endRow - End row (exclusive)
 * @param {number} startCol - Start column (0-based)
 * @param {number} endCol - End column (exclusive)
 * @param {number} L - Perceptual lightness 0-100
 * @param {number} a - Perceptual a -128..+127
 * @param {number} b - Perceptual b -128..+127
 */
function fillRegion(buf, startRow, endRow, startCol, endCol, L, a, b) {
    const [L8, a8, b8] = labTo8bit(L, a, b);
    for (let y = startRow; y < endRow; y++) {
        for (let x = startCol; x < endCol; x++) {
            const idx = (y * WIDTH + x) * 3;
            buf[idx] = L8;
            buf[idx + 1] = a8;
            buf[idx + 2] = b8;
        }
    }
}

/**
 * Fill entire buffer with a single color
 */
function fillAll(buf, L, a, b) {
    fillRegion(buf, 0, HEIGHT, 0, WIDTH, L, a, b);
}

/**
 * Create a gradient from dark to light (vertical) with given a/b
 */
function fillGradient(buf, startRow, endRow, startCol, endCol, Lmin, Lmax, a, b) {
    const rows = endRow - startRow;
    for (let y = startRow; y < endRow; y++) {
        const t = (y - startRow) / (rows - 1);
        const L = Lmin + t * (Lmax - Lmin);
        const [L8, a8, b8] = labTo8bit(L, a, b);
        for (let x = startCol; x < endCol; x++) {
            const idx = (y * WIDTH + x) * 3;
            buf[idx] = L8;
            buf[idx + 1] = a8;
            buf[idx + 2] = b8;
        }
    }
}

/**
 * Build pixel distribution from sector weights.
 * Divides the image into horizontal bands, each band gets a sector's color.
 * @param {Uint8ClampedArray} buf
 * @param {Array<{sector: string, weight: number, L: number, C: number}>} bands
 * @param {Array<{L: number, a: number, b: number, weight: number}>} [neutralBands] - achromatic fills
 */
function fillBySectorWeights(buf, bands, neutralBands = []) {
    // Normalize weights
    const totalWeight = bands.reduce((s, b) => s + b.weight, 0) +
                        neutralBands.reduce((s, b) => s + b.weight, 0);
    let currentRow = 0;

    for (const band of bands) {
        const rows = Math.round((band.weight / totalWeight) * HEIGHT);
        if (rows === 0) continue;
        const endRow = Math.min(currentRow + rows, HEIGHT);
        const [a, b] = sectorToAB(band.sector, band.C);
        fillRegion(buf, currentRow, endRow, 0, WIDTH, band.L, a, b);
        currentRow = endRow;
    }

    for (const band of neutralBands) {
        const rows = Math.round((band.weight / totalWeight) * HEIGHT);
        if (rows === 0) continue;
        const endRow = Math.min(currentRow + rows, HEIGHT);
        fillRegion(buf, currentRow, endRow, 0, WIDTH, band.L, band.a || 0, band.b || 0);
        currentRow = endRow;
    }

    // Fill any remaining rows with last color
    if (currentRow < HEIGHT) {
        const last = bands[bands.length - 1] || neutralBands[neutralBands.length - 1];
        if (last.sector) {
            const [a, b] = sectorToAB(last.sector, last.C);
            fillRegion(buf, currentRow, HEIGHT, 0, WIDTH, last.L, a, b);
        } else {
            fillRegion(buf, currentRow, HEIGHT, 0, WIDTH, last.L, last.a || 0, last.b || 0);
        }
    }
}

// ─── Archetype image specs ──────────────────────────────────────────

const SPECS = {
    // L=50, C=2, K=100, sL=28, ent=0.05, temp=0, psw=0.95
    // Nearly achromatic with full tonal range
    black_and_white: (buf) => {
        // Vertical gradient from black to white, near-zero chroma
        fillGradient(buf, 0, HEIGHT, 0, WIDTH, 0, 100, 1, 0);
    },

    // L=75, C=12, K=95, sL=24, ent=0.3, temp=0, psw=0.5
    // Profile: chromaProfile='very_low' (cMax < 20), tonalRange='bright' (lMean > 55)
    // max_l_std_dev_gate=15 — penalty if sL > 15, but centroid sL=24 so we need high sL
    // Key differentiation from faded_vintage: higher K (95 vs 40), higher sL (24 vs 10),
    // neutral temp (0 vs 0.3), brighter overall. Use vertical gradient for high K and sL.
    // Keep chroma very low (<15) and spread across a couple sectors with neutral temp.
    bleached: (buf) => {
        // Centroid: L=75, C=12, K=95, sL=24, ent=0.3, temp=0, psw=0.5
        // Bleached weights: l=2.5, c=0.5, k=2.5, l_std_dev=0.5, ent=1.5
        // Competitors: detail_recovery gets +20 affinity for sL>18 AND +20 pattern for ent<0.3
        //   golden_hour gets +100 affinity on warm preferred sectors
        // Strategy: ent>0.3 to kill monochrome bonus, balanced temp to avoid golden_hour,
        //   L≈75 and K≈95 (heavy weights). Use 4 sectors split warm/cool.
        const darkRows = HEIGHT * 0.08 | 0;
        fillRegion(buf, 0, darkRows, 0, WIDTH, 3, 0, 0);  // 8% dark for K≈95

        const brightStart = darkRows;
        const brightH = HEIGHT - brightStart;
        // 4 sectors: 2 warm + 2 cool → temp≈0, ent≈0.4
        // Bright zone mean ≈ 82 → overall L ≈ 0.08*3 + 0.92*82 ≈ 75.7
        const bands = [
            { sector: 'orange', weight: 0.35, L: 85, C: 12 },
            { sector: 'yellow', weight: 0.15, L: 88, C: 10 },
            { sector: 'cyan', weight: 0.30, L: 78, C: 10 },
            { sector: 'azure', weight: 0.20, L: 75, C: 10 },
        ];
        let row = brightStart;
        for (const s of bands) {
            const nRows = Math.round(s.weight * brightH);
            const [a, b] = sectorToAB(s.sector, s.C);
            fillRegion(buf, row, Math.min(row + nRows, HEIGHT), 0, WIDTH, s.L, a, b);
            row += nRows;
        }
        if (row < HEIGHT) fillRegion(buf, row, HEIGHT, 0, WIDTH, 80, 0, 0);
    },

    // L=40, C=25, K=65, sL=22, ent=0.55, temp=-0.2, psw=0.25
    // Dark, moderate chroma, cool-leaning, spread hue
    cinematic: (buf) => {
        fillBySectorWeights(buf, [
            { sector: 'blue', weight: 0.25, L: 25, C: 30 },
            { sector: 'cyan', weight: 0.20, L: 35, C: 25 },
            { sector: 'purple', weight: 0.15, L: 20, C: 25 },
            { sector: 'orange', weight: 0.15, L: 55, C: 20 },
            { sector: 'yellow', weight: 0.10, L: 60, C: 20 },
            { sector: 'red', weight: 0.10, L: 35, C: 25 },
        ], [
            { L: 5, a: 0, b: 0, weight: 0.05 },
        ]);
    },

    // L=40, C=35, K=80, sL=22, ent=0.45, temp=-0.6, psw=0.35
    // Dark, moderate-high chroma, strongly cool, blue/cyan/azure dominant
    cool_recovery: (buf) => {
        fillBySectorWeights(buf, [
            { sector: 'blue', weight: 0.30, L: 25, C: 45 },
            { sector: 'cyan', weight: 0.25, L: 40, C: 35 },
            { sector: 'azure', weight: 0.20, L: 30, C: 40 },
            { sector: 'purple', weight: 0.10, L: 20, C: 30 },
            { sector: 'green', weight: 0.05, L: 50, C: 20 },
        ], [
            { L: 0, a: 0, b: 0, weight: 0.05 },
            { L: 80, a: 0, b: 0, weight: 0.05 },
        ]);
    },

    // L=50, C=25, K=60, sL=20, ent=0.5, temp=0, psw=0.2
    // Mid-toned, moderate chroma, balanced temp, spread hue
    everyday_photo: (buf) => {
        fillBySectorWeights(buf, [
            { sector: 'blue', weight: 0.18, L: 40, C: 25 },
            { sector: 'green', weight: 0.18, L: 50, C: 25 },
            { sector: 'orange', weight: 0.18, L: 55, C: 25 },
            { sector: 'red', weight: 0.15, L: 40, C: 25 },
            { sector: 'yellow', weight: 0.12, L: 60, C: 20 },
            { sector: 'cyan', weight: 0.10, L: 45, C: 20 },
        ], [
            { L: 20, a: 0, b: 0, weight: 0.05 },
            { L: 80, a: 0, b: 0, weight: 0.04 },
        ]);
    },

    // L=60, C=10, K=40, sL=10, ent=0.35, temp=0.3, psw=0.45
    // Mid-bright, very low chroma, low contrast, warm-leaning
    faded_vintage: (buf) => {
        fillBySectorWeights(buf, [
            { sector: 'orange', weight: 0.45, L: 60, C: 10 },
            { sector: 'rose', weight: 0.20, L: 55, C: 8 },
            { sector: 'chartreuse', weight: 0.15, L: 65, C: 8 },
            { sector: 'yellow', weight: 0.10, L: 70, C: 8 },
        ], [
            { L: 40, a: 2, b: 3, weight: 0.05 },
            { L: 80, a: 1, b: 2, weight: 0.05 },
        ]);
    },

    // L=25, C=10, K=80, sL=30, ent=0.15, temp=0, psw=0.8
    // Very dark, low chroma, high contrast, near-monochrome
    film_noir: (buf) => {
        // Mostly black with bright highlights, near-achromatic
        fillGradient(buf, 0, HEIGHT, 0, WIDTH, 0, 80, 2, 1);
        // Make it mostly dark — overwrite middle to be dark
        fillRegion(buf, HEIGHT * 0.3 | 0, HEIGHT * 0.85 | 0, 0, WIDTH, 15, 3, 1);
    },

    // L=60, C=90, K=50, sL=4, ent=0.5, temp=0, psw=0.4
    // Bright, extremely high chroma, flat lightness, multi-hue neon
    neon: (buf) => {
        fillBySectorWeights(buf, [
            { sector: 'magenta', weight: 0.35, L: 60, C: 90 },
            { sector: 'yellow', weight: 0.25, L: 62, C: 90 },
            { sector: 'orange', weight: 0.20, L: 58, C: 85 },
            { sector: 'red', weight: 0.10, L: 58, C: 85 },
            { sector: 'green', weight: 0.10, L: 60, C: 80 },
        ]);
    },

    // L=85, C=20, K=30, sL=15, ent=0.6, temp=0.1, psw=0.2
    // Very bright, low-moderate chroma, low contrast, spread hue
    pastel: (buf) => {
        fillBySectorWeights(buf, [
            { sector: 'pink', weight: 0.18, L: 85, C: 20 },
            { sector: 'rose', weight: 0.15, L: 88, C: 18 },
            { sector: 'cyan', weight: 0.15, L: 82, C: 18 },
            { sector: 'yellow', weight: 0.15, L: 90, C: 15 },
            { sector: 'blue', weight: 0.12, L: 78, C: 20 },
            { sector: 'chartreuse', weight: 0.12, L: 87, C: 15 },
            { sector: 'orange', weight: 0.08, L: 83, C: 18 },
        ], [
            { L: 70, a: 2, b: 2, weight: 0.05 },
        ]);
    },

    // L=45, C=12, K=32, sL=28, ent=0.15, temp=-0.2, psw=0.85
    // Mid-dark, low chroma, low contrast, near-monochrome, cool, strongly dominant sector
    saturated_max: (buf) => {
        fillBySectorWeights(buf, [
            { sector: 'blue', weight: 0.80, L: 40, C: 14 },
            { sector: 'cyan', weight: 0.10, L: 50, C: 10 },
        ], [
            { L: 15, a: -2, b: -3, weight: 0.05 },
            { L: 70, a: 0, b: 0, weight: 0.05 },
        ]);
    },

    // L=65, C=20, K=40, sL=18, ent=0.5, temp=0, psw=0.2
    // Mid-bright, moderate chroma, moderate contrast, balanced, spread hue
    soft_light: (buf) => {
        fillBySectorWeights(buf, [
            { sector: 'yellow', weight: 0.18, L: 70, C: 20 },
            { sector: 'orange', weight: 0.16, L: 65, C: 20 },
            { sector: 'cyan', weight: 0.16, L: 60, C: 18 },
            { sector: 'blue', weight: 0.14, L: 55, C: 20 },
            { sector: 'green', weight: 0.14, L: 68, C: 18 },
            { sector: 'pink', weight: 0.12, L: 70, C: 15 },
        ], [
            { L: 45, a: 0, b: 0, weight: 0.05 },
            { L: 85, a: 0, b: 0, weight: 0.05 },
        ]);
    },

    // L=50, C=40, K=60, sL=2.5, ent=0.65, temp=0, psw=0.2
    // Derived profile: chromaProfile='moderate' (C=40→30-60 range), tonalRange='mid'
    // The structural score needs K≈60 but sL≈2.5 — most pixels at L≈50 with a few
    // extreme outliers. The sector affinity needs even spread (psw=0.2) with moderate cMax.
    // Problem: with all pixels at L=50, K comes from sampleStep=40 hitting outlier rows.
    // Place 96% of pixels at L=50 with varied hues, 2% at L=20, 2% at L=80.
    spot_color: (buf) => {
        // Bulk: 6 even sectors at L=50, C=40
        const sectors = ['red','blue','green','yellow','magenta','cyan'];
        const rowsPerSector = Math.floor(HEIGHT * 0.96 / sectors.length);
        let row = 0;
        for (const sector of sectors) {
            const [a, b] = sectorToAB(sector, 40);
            fillRegion(buf, row, row + rowsPerSector, 0, WIDTH, 50, a, b);
            row += rowsPerSector;
        }
        // Outlier rows for K range
        const outlierRows = Math.floor(HEIGHT * 0.02);
        fillRegion(buf, row, row + outlierRows, 0, WIDTH, 20, 0, 0);
        row += outlierRows;
        fillRegion(buf, row, HEIGHT, 0, WIDTH, 80, 0, 0);
    },

    // L=72, C=22, K=100, sL=30, ent=0.4, temp=0.7, psw=0.25
    // Preferred sectors: yellow, orange, chartreuse, green
    // Must beat golden_hour. Golden_hour centroid: L=55, C=30, K=80, sL=22, ent=0.45, temp=0.5, psw=0.3
    // Sunlit is brighter (L=72 vs 55), lower chroma (22 vs 30), higher K (100 vs 80),
    // higher sL (30 vs 22), warmer (0.7 vs 0.5). Lean into L=72 and temp=0.7.
    sunlit: (buf) => {
        // Need L≈72, C≈22, K≈100, sL≈30, ent≈0.4, temp≈0.7, psw≈0.25
        // Must avoid painterly (expects_diversity ent>0.7 bonus) — keep ent≈0.4
        // Concentrate in fewer sectors (3-4) to lower entropy, keep warm
        fillBySectorWeights(buf, [
            { sector: 'yellow', weight: 0.25, L: 82, C: 25 },
            { sector: 'orange', weight: 0.30, L: 72, C: 25 },
            { sector: 'chartreuse', weight: 0.20, L: 75, C: 22 },
            { sector: 'green', weight: 0.05, L: 60, C: 18 },
        ], [
            { L: 0, a: 0, b: 0, weight: 0.10 },
            { L: 100, a: 0, b: 0, weight: 0.10 },
        ]);
    },
};

async function main() {
    const outputDir = process.argv[2] || 'data/synthetic/8bit';
    fs.mkdirSync(outputDir, { recursive: true });

    const chalk = require('chalk');
    console.log(chalk.bold(`\nSynthetic Fixture Generator`));
    console.log(chalk.bold(`${'━'.repeat(50)}\n`));
    console.log(`Output: ${outputDir}`);
    console.log(`Size:   ${WIDTH}×${HEIGHT} 8-bit Lab`);
    console.log(`Archetypes: ${Object.keys(SPECS).length}\n`);

    for (const [archId, buildFn] of Object.entries(SPECS)) {
        const buf = new Uint8ClampedArray(PIXEL_COUNT * 3);
        buildFn(buf);

        const writer = new PSDWriter({
            width: WIDTH,
            height: HEIGHT,
            colorMode: 'lab',
            bitsPerChannel: 8,
            compression: 'none',
            documentName: `synthetic_${archId}`
        });

        writer.addPixelLayer({
            name: 'Synthetic Image',
            pixels: buf,
            visible: true
        });

        const psdBuffer = writer.write();
        const outputPath = path.join(outputDir, `synthetic_${archId}.psd`);
        fs.writeFileSync(outputPath, psdBuffer);
        console.log(chalk.green(`  ${archId} → ${outputPath} (${(psdBuffer.length / 1024).toFixed(1)} KB)`));
    }

    console.log(chalk.bold(`\nDone. Now run the batch processor to verify archetype matches:`));
    console.log(`  node src/reveal-batch.js ${outputDir} ${outputDir.replace('input', 'output').replace('8bit', '8bit')}\n`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
