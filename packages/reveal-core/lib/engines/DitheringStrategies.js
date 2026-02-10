/**
 * DitheringStrategies - Dithering Algorithms for Color Separation
 *
 * STRATEGY PATTERN: Implements various dithering algorithms for posterized images.
 * All algorithms operate in CIELAB space for perceptual accuracy.
 *
 * Algorithms:
 * - Error Diffusion: Floyd-Steinberg, Atkinson, Stucki
 * - Ordered Dithering: Blue Noise, Bayer 8x8 (both LPI-aware)
 *
 * Extracted from SeparationEngine for modularity.
 * Distance calculations use centralized LabDistance module.
 */

const logger = require("../utils/logger");
const { cie76SquaredInline } = require("../color/LabDistance");

/**
 * Cached Blue Noise LUT (64x64)
 * @private
 */
let _cachedBlueNoiseLUT = null;

/**
 * Returns the 64x64 Blue Noise Look-Up Table for ordered dithering.
 *
 * Blue noise provides spatially distributed threshold values with
 * minimal low-frequency artifacts (unlike Bayer matrices).
 *
 * NOTE: This is a pseudo-random approximation. For production use,
 * replace with a proper blue noise texture from Christoph Peters or
 * generated using void-and-cluster algorithm.
 *
 * Values range from 0-255.
 *
 * @returns {Uint8Array} - 64x64 blue noise mask (4096 values)
 */
function getBlueNoiseLUT() {
    // Cache the LUT to avoid regenerating it every time
    if (_cachedBlueNoiseLUT) {
        return _cachedBlueNoiseLUT;
    }

    const size = 64;
    const lut = new Uint8Array(size * size);

    // Simple pseudo-random blue noise approximation using hash function
    // This creates reasonably dispersed patterns, though not perfect blue noise
    // A proper implementation would use pre-generated blue noise textures
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const idx = y * size + x;
            // Hash function to generate pseudo-random values
            let hash = (x * 374761393) + (y * 668265263);
            hash = (hash ^ (hash >> 13)) * 1274126177;
            hash = hash ^ (hash >> 16);
            lut[idx] = Math.abs(hash) % 256;
        }
    }

    _cachedBlueNoiseLUT = lut;
    return lut;
}

/**
 * Standard 8x8 Bayer Matrix (values 0-63)
 * @constant
 */
const BAYER_MATRIX = [
    [ 0, 32,  8, 40,  2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44,  4, 36, 14, 46,  6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [ 3, 35, 11, 43,  1, 33,  9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47,  7, 39, 13, 45,  5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21]
];

/**
 * Finds the nearest palette color to a given Lab pixel
 * Uses squared CIE76 distances for performance (avoids sqrt)
 * Delegates to centralized LabDistance module.
 *
 * @param {number} L - Lightness (0-100)
 * @param {number} a - Green-red axis (-128 to 127)
 * @param {number} b - Blue-yellow axis (-128 to 127)
 * @param {Array<{L,a,b}>} labPalette - Palette colors
 * @returns {number} - Index of nearest color
 */
function getNearest(L, a, b, labPalette) {
    let minDistSq = Infinity;
    let bestIdx = 0;

    for (let j = 0; j < labPalette.length; j++) {
        const p = labPalette[j];
        const distSq = cie76SquaredInline(L, a, b, p.L, p.a, p.b);

        if (distSq < minDistSq) {
            minDistSq = distSq;
            bestIdx = j;
        }
    }

    return bestIdx;
}

/**
 * Finds the two nearest palette colors to a given Lab pixel
 * Uses squared CIE76 distances for performance (avoids sqrt)
 * Delegates to centralized LabDistance module.
 *
 * @param {number} L - Lightness (0-100)
 * @param {number} a - Green-red axis (-128 to 127)
 * @param {number} b - Blue-yellow axis (-128 to 127)
 * @param {Array<{L,a,b}>} labPalette - Palette colors
 * @returns {{i1: number, i2: number, d1: number, d2: number}} - Indices and squared distances
 */
function getTwoNearest(L, a, b, labPalette) {
    let d1 = Infinity, d2 = Infinity;
    let i1 = 0, i2 = 0;

    for (let j = 0; j < labPalette.length; j++) {
        const p = labPalette[j];
        // Squared CIE76 distance (faster - no sqrt needed)
        const distSq = cie76SquaredInline(L, a, b, p.L, p.a, p.b);

        if (distSq < d1) {
            // New closest color
            d2 = d1; i2 = i1;
            d1 = distSq; i1 = j;
        } else if (distSq < d2) {
            // New second-closest color
            d2 = distSq; i2 = j;
        }
    }

    return { i1, i2, d1, d2 };
}

/**
 * Distributes Floyd-Steinberg error to 4 neighboring pixels
 * Pattern:       X   7/16
 *         3/16  5/16  1/16
 *
 * @param {Float32Array} buf - Error buffer (3 floats per pixel: L, a, b)
 * @param {number} x - Current pixel X coordinate
 * @param {number} y - Current pixel Y coordinate
 * @param {number} w - Image width
 * @param {number} h - Image height
 * @param {number} eL - L channel error
 * @param {number} eA - a channel error
 * @param {number} eB - b channel error
 */
function distributeFloydSteinbergError(buf, x, y, w, h, eL, eA, eB) {
    const add = (nx, ny, weight) => {
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const idx = (ny * w + nx) * 3;
            buf[idx]     += eL * weight;
            buf[idx + 1] += eA * weight;
            buf[idx + 2] += eB * weight;
        }
    };

    add(x + 1, y,     7/16); // Right
    add(x - 1, y + 1, 3/16); // Bottom-Left
    add(x,     y + 1, 5/16); // Bottom
    add(x + 1, y + 1, 1/16); // Bottom-Right
}

/**
 * Distributes Atkinson error to 6 neighboring pixels
 * Pattern:       X   1/8  1/8
 *         1/8   1/8  1/8
 *               1/8
 * Total distributed: 6/8 = 75% (25% intentionally discarded)
 *
 * @param {Float32Array} buf - Error buffer (3 floats per pixel: L, a, b)
 * @param {number} x - Current pixel X coordinate
 * @param {number} y - Current pixel Y coordinate
 * @param {number} w - Image width
 * @param {number} h - Image height
 * @param {number} eL - L channel error
 * @param {number} eA - a channel error
 * @param {number} eB - b channel error
 * @param {number} weight - Weight per neighbor (1/8)
 */
function distributeAtkinsonError(buf, x, y, w, h, eL, eA, eB, weight) {
    const add = (nx, ny) => {
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const idx = (ny * w + nx) * 3;
            buf[idx]     += eL * weight;
            buf[idx + 1] += eA * weight;
            buf[idx + 2] += eB * weight;
        }
    };

    // Row 0 (current row, right side)
    add(x + 1, y);     // Right
    add(x + 2, y);     // Right+2

    // Row 1 (next row)
    add(x - 1, y + 1); // Bottom-Left
    add(x,     y + 1); // Bottom
    add(x + 1, y + 1); // Bottom-Right

    // Row 2 (two rows down)
    add(x,     y + 2); // Bottom+2
}

/**
 * Distributes Stucki error to 12 neighboring pixels
 * Pattern (weights out of 42):
 *              X   8   4
 *        2  4  8  4  2
 *        1  2  4  2  1
 * Total distributed: 42/42 = 100% (all error distributed)
 *
 * @param {Float32Array} buf - Error buffer (3 floats per pixel: L, a, b)
 * @param {number} x - Current pixel X coordinate
 * @param {number} y - Current pixel Y coordinate
 * @param {number} w - Image width
 * @param {number} h - Image height
 * @param {number} eL - L channel error
 * @param {number} eA - a channel error
 * @param {number} eB - b channel error
 */
function distributeStuckiError(buf, x, y, w, h, eL, eA, eB) {
    const add = (nx, ny, weight) => {
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
            const idx = (ny * w + nx) * 3;
            const factor = weight / 42;
            buf[idx]     += eL * factor;
            buf[idx + 1] += eA * factor;
            buf[idx + 2] += eB * factor;
        }
    };

    // Row 0 (current row, right side)
    add(x + 1, y, 8);      // Right
    add(x + 2, y, 4);      // Right+2

    // Row 1 (next row, wider distribution)
    add(x - 2, y + 1, 2);  // Bottom-Left-2
    add(x - 1, y + 1, 4);  // Bottom-Left
    add(x,     y + 1, 8);  // Bottom
    add(x + 1, y + 1, 4);  // Bottom-Right
    add(x + 2, y + 1, 2);  // Bottom-Right+2

    // Row 2 (two rows down)
    add(x - 2, y + 2, 1);  // Bottom+2-Left-2
    add(x - 1, y + 2, 2);  // Bottom+2-Left
    add(x,     y + 2, 4);  // Bottom+2
    add(x + 1, y + 2, 2);  // Bottom+2-Right
    add(x + 2, y + 2, 1);  // Bottom+2-Right+2
}

/**
 * Floyd-Steinberg Error Diffusion in CIELAB space
 * Propagates quantization error to neighboring pixels for smooth gradients
 *
 * @param {Uint16Array} rawBytes - 16-bit Lab data (L: 0-32768, a/b: 0-32768 neutral=16384)
 * @param {Array<{L,a,b}>} labPalette - Palette in perceptual Lab ranges
 * @param {number} width - Image width (required for error diffusion)
 * @param {number} height - Image height (required for error diffusion)
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Uint8Array>} - Palette indices
 */
async function floydSteinberg(rawBytes, labPalette, width, height, onProgress) {
    const pixelCount = rawBytes.length / 3;
    const colorIndices = new Uint8Array(pixelCount);

    // Handle empty palette gracefully
    if (!labPalette || labPalette.length === 0) {
        return colorIndices;
    }

    // Error buffer: L, a, b errors for each pixel (Float32 for fractional accuracy)
    const errorBuf = new Float32Array(rawBytes.length);

    const CHUNK_SIZE = 32768; // Smaller chunk for dithering overhead (181 rows of 1024px)


    // CRITICAL: Process row-by-row, left-to-right for error propagation
    // Cannot use random-access chunking like nearest-neighbor
    for (let i = 0; i < pixelCount; i++) {
        const pxIdx = i * 3;
        const y = Math.floor(i / width);
        const x = i % width;

        // 1. Get original 16-bit Lab + accumulated error from neighbors
        let L = (rawBytes[pxIdx] / 32768) * 100 + errorBuf[pxIdx];
        let a = (rawBytes[pxIdx + 1] - 16384) * (128 / 16384) + errorBuf[pxIdx + 1];
        let b = (rawBytes[pxIdx + 2] - 16384) * (128 / 16384) + errorBuf[pxIdx + 2];

        // Clamp to valid Lab ranges
        L = Math.max(0, Math.min(100, L));
        a = Math.max(-128, Math.min(127, a));
        b = Math.max(-128, Math.min(127, b));

        // 2. Find nearest palette color
        let bestIdx = 0;
        let minDistSq = Infinity;

        for (let j = 0; j < labPalette.length; j++) {
            const pal = labPalette[j];
            const dL = L - pal.L;
            const da = a - pal.a;
            const db = b - pal.b;
            const distSq = dL*dL + da*da + db*db;

            if (distSq < minDistSq) {
                minDistSq = distSq;
                bestIdx = j;
            }
        }

        colorIndices[i] = bestIdx;

        // 3. Calculate quantization error
        const chosen = labPalette[bestIdx];
        const errL = L - chosen.L;
        const errA = a - chosen.a;
        const errB = b - chosen.b;

        // 4. Distribute error to neighbors (Floyd-Steinberg pattern)
        distributeFloydSteinbergError(errorBuf, x, y, width, height, errL, errA, errB);

        // UI Yielding (every CHUNK_SIZE pixels)
        if (i % CHUNK_SIZE === 0 && onProgress) {
            onProgress(Math.round((i / pixelCount) * 100));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    if (onProgress) onProgress(100);
    return colorIndices;
}

/**
 * Atkinson Error Diffusion in CIELAB space
 * Classic algorithm from Bill Atkinson (original Macintosh)
 * Distributes only 75% of error for high-contrast, crisp output
 *
 * @param {Uint16Array} rawBytes - 16-bit Lab data (L: 0-32768, a/b: 0-32768 neutral=16384)
 * @param {Array<{L,a,b}>} labPalette - Palette in perceptual Lab ranges
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Uint8Array>} - Palette indices
 */
async function atkinson(rawBytes, labPalette, width, height, onProgress) {
    const pixelCount = rawBytes.length / 3;
    const colorIndices = new Uint8Array(pixelCount);

    // Handle empty palette gracefully
    if (!labPalette || labPalette.length === 0) {
        return colorIndices;
    }

    // Error buffer: L, a, b errors for each pixel (Float32 for fractional accuracy)
    const errorBuf = new Float32Array(rawBytes.length);

    const CHUNK_SIZE = 32768; // Smaller chunk for dithering overhead


    // CRITICAL: Process row-by-row, left-to-right for error propagation
    for (let i = 0; i < pixelCount; i++) {
        const pxIdx = i * 3;
        const y = Math.floor(i / width);
        const x = i % width;

        // 1. Get original 16-bit Lab + accumulated error from neighbors
        let L = (rawBytes[pxIdx] / 32768) * 100 + errorBuf[pxIdx];
        let a = (rawBytes[pxIdx + 1] - 16384) * (128 / 16384) + errorBuf[pxIdx + 1];
        let b = (rawBytes[pxIdx + 2] - 16384) * (128 / 16384) + errorBuf[pxIdx + 2];

        // Clamp to valid Lab ranges
        L = Math.max(0, Math.min(100, L));
        a = Math.max(-128, Math.min(127, a));
        b = Math.max(-128, Math.min(127, b));

        // 2. Find nearest palette color
        const bestIdx = getNearest(L, a, b, labPalette);
        colorIndices[i] = bestIdx;

        // 3. Calculate quantization error
        const chosen = labPalette[bestIdx];
        const errL = L - chosen.L;
        const errA = a - chosen.a;
        const errB = b - chosen.b;

        // 4. Distribute error to 6 neighbors (Atkinson pattern)
        // Each neighbor gets 1/8 of the error
        const weight = 1 / 8;
        distributeAtkinsonError(errorBuf, x, y, width, height, errL, errA, errB, weight);

        // UI Yielding (every CHUNK_SIZE pixels)
        if (i % CHUNK_SIZE === 0 && onProgress) {
            onProgress(Math.round((i / pixelCount) * 100));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    if (onProgress) onProgress(100);
    return colorIndices;
}

/**
 * Stucki Error Diffusion in CIELAB space
 * Enhanced error diffusion algorithm with wider neighborhood
 * Distributes to 12 neighbors for high-fidelity photographic transitions
 *
 * @param {Uint16Array} rawBytes - 16-bit Lab data (L: 0-32768, a/b: 0-32768 neutral=16384)
 * @param {Array<{L,a,b}>} labPalette - Palette in perceptual Lab ranges
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Uint8Array>} - Palette indices
 */
async function stucki(rawBytes, labPalette, width, height, onProgress) {
    const pixelCount = rawBytes.length / 3;
    const colorIndices = new Uint8Array(pixelCount);

    // Handle empty palette gracefully
    if (!labPalette || labPalette.length === 0) {
        return colorIndices;
    }

    // Error buffer: L, a, b errors for each pixel (Float32 for fractional accuracy)
    const errorBuf = new Float32Array(rawBytes.length);

    const CHUNK_SIZE = 32768; // Smaller chunk for dithering overhead


    // CRITICAL: Process row-by-row, left-to-right for error propagation
    for (let i = 0; i < pixelCount; i++) {
        const pxIdx = i * 3;
        const y = Math.floor(i / width);
        const x = i % width;

        // 1. Get original 16-bit Lab + accumulated error from neighbors
        let L = (rawBytes[pxIdx] / 32768) * 100 + errorBuf[pxIdx];
        let a = (rawBytes[pxIdx + 1] - 16384) * (128 / 16384) + errorBuf[pxIdx + 1];
        let b = (rawBytes[pxIdx + 2] - 16384) * (128 / 16384) + errorBuf[pxIdx + 2];

        // Clamp to valid Lab ranges
        L = Math.max(0, Math.min(100, L));
        a = Math.max(-128, Math.min(127, a));
        b = Math.max(-128, Math.min(127, b));

        // 2. Find nearest palette color
        const bestIdx = getNearest(L, a, b, labPalette);
        colorIndices[i] = bestIdx;

        // 3. Calculate quantization error
        const chosen = labPalette[bestIdx];
        const errL = L - chosen.L;
        const errA = a - chosen.a;
        const errB = b - chosen.b;

        // 4. Distribute error to 12 neighbors (Stucki pattern)
        // Stucki uses 42 as denominator (all error distributed)
        distributeStuckiError(errorBuf, x, y, width, height, errL, errA, errB);

        // UI Yielding (every CHUNK_SIZE pixels)
        if (i % CHUNK_SIZE === 0 && onProgress) {
            onProgress(Math.round((i / pixelCount) * 100));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    if (onProgress) onProgress(100);
    return colorIndices;
}

/**
 * Blue Noise Ordered Dithering (LPI-Aware / Clustered)
 * Uses pre-computed 64x64 threshold map for dispersed dot patterns.
 * Better than Floyd-Steinberg for screen printing (prevents "worming").
 *
 * LPI-AWARE MODE (Rule of 7):
 * When scale > 1, blue noise is sampled at Macro-Cell coordinates.
 * This "clusters" the stochastic dots into groups that won't fall
 * through screen mesh openings (prevents "Sieve Effect").
 *
 * @param {Uint16Array} rawBytes - 16-bit Lab data (L: 0-32768, a/b: 0-32768 neutral=16384)
 * @param {Array<{L,a,b}>} labPalette - Palette in perceptual Lab ranges
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Function} onProgress - Progress callback
 * @param {number} scale - Macro-Cell size in pixels (1 = no clustering, >1 = LPI-aware)
 * @returns {Promise<Uint8Array>} - Palette indices
 */
async function blueNoise(rawBytes, labPalette, width, height, onProgress, scale = 1) {
    const pixelCount = rawBytes.length / 3;
    const colorIndices = new Uint8Array(pixelCount);

    // Handle empty palette gracefully
    if (!labPalette || labPalette.length === 0) {
        return colorIndices;
    }

    // Handle single-color palette (no dithering needed)
    if (labPalette.length === 1) {
        return colorIndices; // Already filled with zeros
    }

    // Get the 64x64 Blue Noise Threshold Mask
    const blueNoiseLUT = getBlueNoiseLUT();
    const maskSize = 64;
    const CHUNK_SIZE = 65536; // 64k pixels per UI yield


    for (let i = 0; i < pixelCount; i++) {
        const pxIdx = i * 3;
        const x = i % width;
        const y = Math.floor(i / width);

        // Unpack 16-bit Lab to perceptual ranges
        const L = (rawBytes[pxIdx] / 32768) * 100;
        const a = (rawBytes[pxIdx + 1] - 16384) * (128 / 16384);
        const b = (rawBytes[pxIdx + 2] - 16384) * (128 / 16384);

        // Find the TWO closest palette colors using SQUARED distances (faster)
        const { i1, i2, d1, d2 } = getTwoNearest(L, a, b, labPalette);

        // Blue Noise Decision Logic
        // Calculate relative closeness ratio (0.0 to 1.0)
        // ratio = 0.5 means equidistant from both colors
        const totalDist = d1 + d2;
        const ratio = totalDist === 0 ? 0 : d1 / totalDist;

        // LPI-AWARE: Sample Blue Noise mask at Macro-Cell coordinates
        // When scale > 1, multiple pixels share the same threshold value
        // This "clusters" the stochastic dots into stable groups on screen mesh
        const cellX = Math.floor(x / scale);
        const cellY = Math.floor(y / scale);

        // Lookup threshold from Blue Noise LUT (tiled across Macro-Cells)
        const threshold = blueNoiseLUT[(cellY % maskSize) * maskSize + (cellX % maskSize)] / 255;

        // Decide which palette index to assign
        // If ratio > threshold, use second-closest color
        // This creates dispersed dot patterns instead of banding
        colorIndices[i] = (ratio > threshold) ? i2 : i1;

        // UI Yielding (every CHUNK_SIZE pixels)
        if (i % CHUNK_SIZE === 0 && onProgress) {
            onProgress(Math.round((i / pixelCount) * 100));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    if (onProgress) onProgress(100);
    return colorIndices;
}

/**
 * Bayer 8x8 Ordered Dithering (LPI-Aware)
 * Uses classic Bayer matrix for retro crosshatch pattern
 *
 * LPI-AWARE MODE (Rule of 7):
 * When scale > 1, the Bayer matrix is sampled at Macro-Cell coordinates
 * instead of per-pixel. This clusters dots into groups that won't fall
 * through screen mesh openings (prevents "Sieve Effect").
 *
 * @param {Uint16Array} rawBytes - 16-bit Lab data (L: 0-32768, a/b: 0-32768 neutral=16384)
 * @param {Array<{L,a,b}>} labPalette - Palette in perceptual Lab ranges
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Function} onProgress - Progress callback
 * @param {number} scale - Macro-Cell size in pixels (1 = no clustering, >1 = LPI-aware)
 * @returns {Promise<Uint8Array>} - Palette indices
 */
async function bayer(rawBytes, labPalette, width, height, onProgress, scale = 1) {
    const pixelCount = rawBytes.length / 3;
    const colorIndices = new Uint8Array(pixelCount);

    // Handle empty palette gracefully
    if (!labPalette || labPalette.length === 0) {
        return colorIndices;
    }

    // Handle single-color palette (no dithering needed)
    if (labPalette.length === 1) {
        return colorIndices;
    }

    const CHUNK_SIZE = 65536; // 64k pixels per UI yield


    for (let i = 0; i < pixelCount; i++) {
        const pxIdx = i * 3;
        const x = i % width;
        const y = Math.floor(i / width);

        // Unpack 16-bit Lab to perceptual ranges
        const L = (rawBytes[pxIdx] / 32768) * 100;
        const a = (rawBytes[pxIdx + 1] - 16384) * (128 / 16384);
        const b = (rawBytes[pxIdx + 2] - 16384) * (128 / 16384);

        // Find the TWO closest palette colors using SQUARED distances (faster)
        const { i1, i2, d1, d2 } = getTwoNearest(L, a, b, labPalette);

        // Bayer Decision Logic
        // Calculate relative closeness ratio (0.0 to 1.0)
        const totalDist = d1 + d2;
        const ratio = totalDist === 0 ? 0 : d1 / totalDist;

        // LPI-AWARE: Sample Bayer matrix at Macro-Cell coordinates
        // When scale > 1, multiple pixels share the same threshold value
        // This creates "Macro-Cells" that form stable dot clusters on screen mesh
        const cellX = Math.floor(x / scale);
        const cellY = Math.floor(y / scale);

        // Lookup threshold from Bayer matrix (tiled across Macro-Cells)
        // Normalize from 0-63 to 0-1 range
        const threshold = (BAYER_MATRIX[cellY % 8][cellX % 8] + 0.5) / 64;

        // Decide which palette index to assign
        colorIndices[i] = (ratio > threshold) ? i2 : i1;

        // UI Yielding (every CHUNK_SIZE pixels)
        if (i % CHUNK_SIZE === 0 && onProgress) {
            onProgress(Math.round((i / pixelCount) * 100));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    if (onProgress) onProgress(100);
    return colorIndices;
}

/**
 * All available dithering strategies
 */
const DitheringStrategies = {
    'floyd-steinberg': floydSteinberg,
    'atkinson': atkinson,
    'stucki': stucki,
    'blue-noise': blueNoise,
    'bayer': bayer
};

module.exports = {
    DitheringStrategies,
    floydSteinberg,
    atkinson,
    stucki,
    blueNoise,
    bayer,
    // Helpers (exposed for testing)
    getNearest,
    getTwoNearest,
    getBlueNoiseLUT,
    BAYER_MATRIX
};
