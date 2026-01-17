/**
 * SeparationEngine.js
 *
 * ARCHITECTURE: Pure Lab Stream (Phase 4)
 * - Operates entirely in CIELAB space to avoid sRGB gamut clipping.
 * - Uses Squared Euclidean Distance for high-performance pixel mapping.
 * - Eliminates RGB as a middleman for feature discovery.
 */

const logger = require("../utils/logger");

class SeparationEngine {
    /**
     * REFACTORED: mapPixelsToPaletteAsync
     * Optimized for Adobe UXP single-threaded performance.
     *
     * ARCHITECT'S OPTIMIZATIONS:
     * - Float32Array for palette (better math performance)
     * - Perceptual Lab space calculations (correct distance metric)
     * - Spatial locality first (check last winner before full search)
     * - 64K chunk size (fewer yields, better throughput)
     *
     * @param {Uint8ClampedArray} rawBytes - Raw Lab bytes (0-255 encoding: L, a+128, b+128)
     * @param {Array} labPalette - Array of {L, a, b} objects (perceptual ranges)
     * @param {Function} onProgress - Progress callback (0-100)
     * @returns {Promise<Uint8Array>} - Array of palette indices per pixel
     */
    static async mapPixelsToPaletteAsync(rawBytes, labPalette, onProgress) {
        const pixelCount = rawBytes.length / 3;
        const colorIndices = new Uint8Array(pixelCount);
        const CHUNK_SIZE = 65536; // 64k pixels per UI yield (optimized for throughput)

        logger.log(`Mapping ${pixelCount} pixels (async batching: ${Math.ceil(pixelCount / CHUNK_SIZE)} chunks)...`);

        // OPTIMIZATION 1: Flatten palette to typed arrays to avoid object overhead
        const paletteSize = labPalette.length;
        const palL = new Float32Array(paletteSize);
        const palA = new Float32Array(paletteSize);
        const palB = new Float32Array(paletteSize);

        for (let j = 0; j < paletteSize; j++) {
            palL[j] = labPalette[j].L;
            palA[j] = labPalette[j].a;
            palB[j] = labPalette[j].b;
        }

        const SNAP_THRESHOLD_SQ = 4.0; // Perceptual snap (ΔE 2.0 squared)
        let lastBestIndex = 0;

        // Process in chunks with event loop yielding
        for (let i = 0; i < pixelCount; i += CHUNK_SIZE) {
            const chunkEnd = Math.min(i + CHUNK_SIZE, pixelCount);

            // --- INNER HOT LOOP (Synchronous for performance) ---
            for (let p = i; p < chunkEnd; p++) {
                const pIdx = p * 3;

                // Map 0-255 bytes to perceptual Lab
                const L = (rawBytes[pIdx] / 255) * 100;        // L: 0-255 → 0-100
                const a = rawBytes[pIdx + 1] - 128;             // a: 0-255 → -128 to +127
                const b = rawBytes[pIdx + 2] - 128;             // b: 0-255 → -128 to +127

                // Spatial Locality: Check last winner first
                // PERCEPTUAL L-SCALING: Weight L more heavily for dark colors (shadow preservation)
                const dL_l = L - palL[lastBestIndex];
                const da_l = a - palA[lastBestIndex];
                const db_l = b - palB[lastBestIndex];
                const avgL_l = (L + palL[lastBestIndex]) / 2;
                const lWeight_l = avgL_l < 40 ? 2.0 : 1.0;
                let minDistanceSq = (dL_l * lWeight_l) ** 2 + (da_l * da_l) + (db_l * db_l);

                if (minDistanceSq > SNAP_THRESHOLD_SQ) {
                    let nearestIndex = lastBestIndex;

                    // Search all palette colors
                    for (let c = 0; c < paletteSize; c++) {
                        const dL = L - palL[c];
                        const da = a - palA[c];
                        const db = b - palB[c];
                        // Apply L-weighting for dark colors
                        const avgL_c = (L + palL[c]) / 2;
                        const lWeight_c = avgL_c < 40 ? 2.0 : 1.0;
                        const distSq = (dL * lWeight_c) ** 2 + (da * da) + (db * db);

                        if (distSq < minDistanceSq) {
                            minDistanceSq = distSq;
                            nearestIndex = c;
                            if (distSq < SNAP_THRESHOLD_SQ) break; // Early exit
                        }
                    }
                    lastBestIndex = nearestIndex;
                }
                colorIndices[p] = lastBestIndex;
            }

            // --- YIELD TO UI (Asynchronous) ---
            if (onProgress) {
                onProgress(Math.round((chunkEnd / pixelCount) * 100));
            }

            // This promise allows Photoshop to update its progress bar and remain responsive
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        logger.log(`✓ Mapped ${pixelCount} pixels to palette (async batching)`);
        return colorIndices;
    }

    /**
     * Map Lab pixels to nearest colors in the custom Lab palette (synchronous version).
     *
     * CRITICAL FIX: This uses normalized perceptual ranges (L:0-100, a/b:-128 to 127)
     * and performs distance checks without converting to RGB.
     *
     * @param {Uint8ClampedArray} rawBytes - Raw 3-channel Lab bytes from imaging.getPixels()
     * @param {Array} labPalette - Array of {L, a, b} objects from PosterizationEngine
     * @returns {Uint8Array} - Array of palette indices per pixel
     */
    static mapPixelsToPalette(rawBytes, labPalette) {
        const pixelCount = rawBytes.length / 3;
        const colorIndices = new Uint8Array(pixelCount);

        // ARTIST-CENTRIC MODEL: Early Exit Optimization
        // If a pixel is "close enough" to a palette color (Lab distance < 2.0),
        // stop checking remaining colors and assign immediately.
        // This dramatically speeds up separation for images with large uniform regions.
        const SNAP_THRESHOLD = 2.0;
        const SNAP_THRESHOLD_SQ = SNAP_THRESHOLD * SNAP_THRESHOLD;

        logger.log(`Mapping ${pixelCount} pixels using Squared Euclidean Lab distance (early exit < ${SNAP_THRESHOLD})...`);

        // OPTIMIZATION 3: Exact Match Cache
        // Pre-compute hash map for O(1) exact color lookup
        // Images with large flat regions benefit enormously from this
        const paletteMap = new Map();
        for (let j = 0; j < labPalette.length; j++) {
            const key = `${labPalette[j].L.toFixed(1)},${labPalette[j].a.toFixed(1)},${labPalette[j].b.toFixed(1)}`;
            paletteMap.set(key, j);
        }

        let earlyExitCount = 0;
        let exactMatchCount = 0;
        let spatialHitCount = 0;

        // OPTIMIZATION 4: Spatial Locality
        // Adjacent pixels often have the same color - check previous winner first
        let lastBestIndex = 0;

        for (let i = 0; i < pixelCount; i++) {
            const pIdx = i * 3;

            // 1. MAP BYTES TO PERCEPTUAL LAB (The "Center" Fix)
            // L: 0-255 -> 0-100
            // a/b: 0-255 -> -128 to +127
            const L = (rawBytes[pIdx] / 255) * 100;
            const a = rawBytes[pIdx + 1] - 128;
            const b = rawBytes[pIdx + 2] - 128;

            // OPTIMIZATION 3a: Check exact match cache first
            const key = `${L.toFixed(1)},${a.toFixed(1)},${b.toFixed(1)}`;
            const exactMatch = paletteMap.get(key);
            if (exactMatch !== undefined) {
                colorIndices[i] = exactMatch;
                exactMatchCount++;
                lastBestIndex = exactMatch; // Update spatial locality
                continue;
            }

            // OPTIMIZATION 4a: Check previous winner first (spatial locality)
            const lastColor = labPalette[lastBestIndex];
            const dL_last = L - lastColor.L;
            const da_last = a - lastColor.a;
            const db_last = b - lastColor.b;
            // Apply L-weighting for dark colors
            const avgL_last = (L + lastColor.L) / 2;
            const lWeight_last = avgL_last < 40 ? 2.0 : 1.0;
            let minDistanceSq = (dL_last * lWeight_last) ** 2 + (da_last * da_last) + (db_last * db_last);
            let nearestIndex = lastBestIndex;

            // If last color is close enough, use it immediately
            if (minDistanceSq < SNAP_THRESHOLD_SQ) {
                colorIndices[i] = nearestIndex;
                spatialHitCount++;
                earlyExitCount++;
                continue;
            }

            // 2. FIND NEAREST COLOR (Pure Lab Distance with Early Exit)
            for (let j = 0; j < labPalette.length; j++) {
                if (j === lastBestIndex) continue; // Already checked via spatial locality

                const target = labPalette[j];

                const dL = L - target.L;

                // OPTIMIZATION 1: Early exit on L channel alone
                // If L difference squared is already >= current minimum, skip this color
                const dLsq = dL * dL;
                if (dLsq >= minDistanceSq) {
                    continue; // Can't be closer, skip rest of calculation
                }

                const da = a - target.a;
                const db = b - target.b;

                // Squared Euclidean distance with L-weighting for dark colors
                // Apply perceptual L-scaling to preserve shadow detail
                const avgL_j = (L + target.L) / 2;
                const lWeight_j = avgL_j < 40 ? 2.0 : 1.0;
                const distSq = (dL * lWeight_j) ** 2 + (da * da) + (db * db);

                if (distSq < minDistanceSq) {
                    minDistanceSq = distSq;
                    nearestIndex = j;

                    // OPTIMIZATION 2: Early exit if "close enough"
                    // If distance is below snap threshold, this is a perfect match - stop searching
                    if (distSq < SNAP_THRESHOLD_SQ) {
                        earlyExitCount++;
                        break; // No need to check remaining colors
                    }
                }
            }
            colorIndices[i] = nearestIndex;
            lastBestIndex = nearestIndex; // Update for next pixel's spatial locality check
        }

        const earlyExitPct = ((earlyExitCount / pixelCount) * 100).toFixed(1);
        const exactMatchPct = ((exactMatchCount / pixelCount) * 100).toFixed(1);
        const spatialHitPct = ((spatialHitCount / pixelCount) * 100).toFixed(1);
        logger.log(`✓ Mapped all pixels to palette (${earlyExitCount} early exits = ${earlyExitPct}%, ${exactMatchCount} exact = ${exactMatchPct}%, ${spatialHitCount} spatial = ${spatialHitPct}%)`);
        return colorIndices;
    }

    /**
     * Convert hex color to {r, g, b} object (for UI display only)
     *
     * @param {string} hex - Hex color like "#5E4A25"
     * @returns {{r: number, g: number, b: number}}
     */
    static hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }

    /**
     * Generates a grayscale alpha mask for a specific color layer.
     * White (255) indicates the presence of the feature.
     *
     * @param {Uint8Array} colorIndices - Palette index for each pixel
     * @param {number} targetIndex - Which color to extract
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {Uint8Array} - Grayscale mask (white = color present, black = absent)
     */
    static generateLayerMask(colorIndices, targetIndex, width, height) {
        const mask = new Uint8Array(width * height);
        for (let i = 0; i < colorIndices.length; i++) {
            mask[i] = (colorIndices[i] === targetIndex) ? 255 : 0;
        }
        return mask;
    }

    /**
     * Main separation workflow (ASYNC with progress reporting).
     *
     * REWRITE NOTE: Removed generateLayerPixels (RGBA) to prevent RGB Ghosting.
     * Final output now prioritizes labColor objects for Photoshop's BatchPlay fill.
     *
     * ASYNC OPTIMIZATION: Uses batched processing to keep UI responsive.
     *
     * @param {Uint8ClampedArray} rawBytes - Raw Lab pixel data (3 bytes/pixel: L, a, b)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Array<string>} hexColors - Custom palette as hex strings (for UI display)
     * @param {null} _unused - Deprecated parameter (kept for compatibility)
     * @param {Array<Object>} labPalette - REQUIRED: Lab palette [{L, a, b}, ...] from posterization
     * @param {Object} options - Optional settings {onProgress: Function}
     * @returns {Promise<Array>} - Separated layer data [{name, labColor, hex, mask}, ...]
     */
    static async separateImage(rawBytes, width, height, hexColors, _unused = null, labPalette = null, options = {}) {
        logger.log(`Starting separation: ${width}x${height} → ${hexColors.length} colors (Pure Lab workflow, async)`);

        if (!labPalette || labPalette.length === 0) {
            throw new Error("Separation requires a valid Lab Palette for perceptual accuracy.");
        }

        logger.log(`Lab Palette (${labPalette.length} colors):`, labPalette.map(c =>
            `L:${c.L.toFixed(1)} a:${c.a.toFixed(1)} b:${c.b.toFixed(1)}`
        ));

        // Generate the pixel-to-color mapping (Async with progress)
        const onProgress = options.onProgress || null;
        const colorIndices = await this.mapPixelsToPaletteAsync(rawBytes, labPalette, onProgress);

        const layers = [];

        labPalette.forEach((labColor, index) => {
            const hex = hexColors[index];
            logger.log(`Processing Layer ${index + 1}: L:${labColor.L.toFixed(1)}`);

            const mask = this.generateLayerMask(colorIndices, index, width, height);

            // Count opaque pixels in this layer
            let opaquePixelCount = 0;
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] === 255) opaquePixelCount++;
            }

            logger.log(`  Layer has ${opaquePixelCount} pixels (${(opaquePixelCount / (width * height) * 100).toFixed(1)}% coverage)`);

            // Skip empty layers (caused by scale mismatch between posterization and layer creation)
            if (opaquePixelCount === 0) {
                logger.log(`  ⚠ Skipping empty layer (0 pixels at full resolution)`);
                return; // Skip this layer
            }

            // Pure Lab Stream Architecture:
            // - labColor: Native Lab values for Photoshop BatchPlay fill
            // - hex: For UI display only
            // - mask: Grayscale mask (255=opaque, 0=transparent)
            // NO RGB/RGBA - prevents gamut clipping and RGB Ghosting

            layers.push({
                name: `Feature ${index + 1} (${hex})`,
                labColor: labColor,  // Native Lab for Photoshop Fill
                hex: hex,            // For UI Preview only
                mask: mask,          // Grayscale mask for the layer
                width: width,
                height: height
            });
        });

        logger.log(`✓ Created ${layers.length} Lab-native layer definitions`);
        return layers;
    }
}

module.exports = SeparationEngine;
