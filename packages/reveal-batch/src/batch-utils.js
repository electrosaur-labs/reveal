/**
 * batch-utils.js — Shared utilities for reveal-batch scripts
 *
 * Re-exports centralized Lab encoding conversions from @reveal/core
 * and adds batch-specific helpers (thumbnail generation).
 *
 * @module batch-utils
 */
const { LabEncoding } = require('@reveal/core');
const sharp = require('sharp');

// Re-export all LabEncoding functions and constants
const {
    // Constants
    LAB16_L_MAX,
    LAB16_AB_NEUTRAL,
    L_SCALE,
    AB_SCALE,
    LAB8_AB_NEUTRAL,
    PSD16_SCALE,

    // Bulk buffer conversions
    convert8bitTo16bitLab,
    convertPsd16bitToEngineLab,
    convertPsd16bitTo8bitLab,
    convertEngine16bitTo8bitLab,

    // Single-pixel conversions
    perceptualToEngine16,
    engine16ToPerceptual,

    // Display conversions
    lab8bitToRgb,
    rgbToHex
} = LabEncoding;

/**
 * Generate JPEG thumbnail from 8-bit Lab data using sharp.
 *
 * @param {Uint8Array|Uint8ClampedArray} lab8bit - 8-bit Lab pixel data (3 values/pixel)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} [maxSize=256] - Maximum thumbnail dimension
 * @returns {Promise<{jpegData: Buffer, width: number, height: number}>}
 */
async function generateThumbnail(lab8bit, width, height, maxSize = 256) {
    const scale = Math.min(maxSize / width, maxSize / height);
    const thumbWidth = Math.round(width * scale);
    const thumbHeight = Math.round(height * scale);

    // Downsample Lab data first to avoid full-res RGB allocation
    const smallLab = new Uint8Array(thumbWidth * thumbHeight * 3);
    const xRatio = width / thumbWidth;
    const yRatio = height / thumbHeight;
    for (let y = 0; y < thumbHeight; y++) {
        const srcY = Math.min(Math.round(y * yRatio), height - 1);
        for (let x = 0; x < thumbWidth; x++) {
            const srcX = Math.min(Math.round(x * xRatio), width - 1);
            const srcIdx = (srcY * width + srcX) * 3;
            const dstIdx = (y * thumbWidth + x) * 3;
            smallLab[dstIdx] = lab8bit[srcIdx];
            smallLab[dstIdx + 1] = lab8bit[srcIdx + 1];
            smallLab[dstIdx + 2] = lab8bit[srcIdx + 2];
        }
    }

    const rgb = lab8bitToRgb(smallLab, thumbWidth * thumbHeight);

    const jpegBuffer = await sharp(Buffer.from(rgb), {
        raw: { width: thumbWidth, height: thumbHeight, channels: 3 }
    })
    .jpeg({ quality: 80 })
    .toBuffer();

    return {
        jpegData: jpegBuffer,
        width: thumbWidth,
        height: thumbHeight
    };
}

module.exports = {
    // Constants
    LAB16_L_MAX,
    LAB16_AB_NEUTRAL,
    L_SCALE,
    AB_SCALE,
    LAB8_AB_NEUTRAL,
    PSD16_SCALE,

    // Bulk buffer conversions
    convert8bitTo16bitLab,
    convertPsd16bitToEngineLab,
    convertPsd16bitTo8bitLab,
    convertEngine16bitTo8bitLab,

    // Single-pixel conversions
    perceptualToEngine16,
    engine16ToPerceptual,

    // Display conversions
    lab8bitToRgb,
    rgbToHex,

    // Batch-specific
    generateThumbnail
};
