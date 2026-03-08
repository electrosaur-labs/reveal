/**
 * plates.js — Individual mask PNG writer
 *
 * Writes one grayscale PNG per palette color (255=ink, 0=no ink).
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

/**
 * Write individual plate PNGs.
 *
 * @param {Array<Uint8Array>} masks
 * @param {string[]} hexColors
 * @param {number} width
 * @param {number} height
 * @param {string} outputDir
 * @param {string} basename
 * @returns {Promise<string[]>} Paths of written files
 */
async function writePlates(masks, hexColors, width, height, outputDir, basename) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const files = [];
    for (let i = 0; i < masks.length; i++) {
        const hex = hexColors[i].replace('#', '');
        const filename = `${basename}_plate_${String(i + 1).padStart(2, '0')}_${hex}.png`;
        const filePath = path.join(outputDir, filename);

        await sharp(Buffer.from(masks[i]), {
            raw: { width, height, channels: 1 }
        }).png().toFile(filePath);

        files.push(filePath);
    }

    return files;
}

module.exports = { writePlates };
