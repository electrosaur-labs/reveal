/**
 * SeparationEngine.js
 *
 * ARCHITECTURE: Pure Lab Stream (Phase 4)
 * - Operates entirely in CIELAB space to avoid sRGB gamut clipping.
 * - Uses Squared Euclidean Distance for high-performance pixel mapping.
 * - Eliminates RGB as a middleman for feature discovery.
 *
 * MODULAR ARCHITECTURE (v2.0):
 * - Dithering algorithms extracted to DitheringStrategies.js
 * - Distance calculations centralized in LabDistance.js
 * - SeparationEngine handles routing and core separation logic
 *
 * CONFIGURABLE DISTANCE (v2.2):
 * - Supports CIE76, CIE94, and CIE2000 distance metrics
 * - CIE76: Fast, good for posters/graphics
 * - CIE94: Perceptual, good for photographs
 * - CIE2000: Museum grade, best for 16-bit files and blue/violet tones
 */

const logger = require("../utils/logger");
const DitheringStrategies = require("./DitheringStrategies");
const {
    DistanceMetric,
    // Perceptual space functions (deprecated for 16-bit pipelines)
    cie76WeightedSquaredInline,
    cie94SquaredInline,
    cie2000SquaredInline,
    preparePaletteChroma,
    normalizeDistanceConfig,
    // Native 16-bit integer functions
    cie76WeightedSquaredInline16,
    cie94SquaredInline16,
    preparePaletteChroma16,
    SNAP_THRESHOLD_SQ_16,
    LAB16_AB_NEUTRAL,
    DEFAULT_CIE94_PARAMS_16
} = require("../color/LabDistance");

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
     * DITHERING SUPPORT:
     * - Supports Floyd-Steinberg error diffusion (requires width/height)
     * - Supports Blue Noise ordered dithering (requires width/height)
     * - Defaults to nearest-neighbor (fast, posterized look)
     *
     * LPI-AWARE DITHERING (Rule of 7):
     * - When meshCount is provided, dithering patterns are scaled to form "Macro-Cells"
     * - Prevents "Sieve Effect" where dots fall through mesh openings
     * - Formula: maxLPI = meshCount / 7, scale = Math.round(dpi / maxLPI)
     *
     * CONFIGURABLE DISTANCE METRIC (v2.1):
     * - distanceMetric: 'cie76' (default) or 'cie94'
     * - CIE94 provides better perceptual accuracy for saturated colors (~2x slower)
     *
     * @param {Uint16Array} rawBytes - Raw Lab bytes (16-bit encoding: L 0-32768, a/b 0-32768 neutral=16384)
     * @param {Array} labPalette - Array of {L, a, b} objects (perceptual ranges)
     * @param {Function} onProgress - Progress callback (0-100)
     * @param {number} width - Image width (required for dithering)
     * @param {number} height - Image height (required for dithering)
     * @param {Object} options - Options object:
     *   - ditherType: 'none'|'floyd-steinberg'|'blue-noise'|'bayer'|'atkinson'|'stucki'
     *   - meshCount: Screen mesh TPI (e.g., 230, 305) - enables LPI-aware Macro-Cell clustering
     *   - dpi: Image DPI (default: 300) - used with meshCount for scale calculation
     *   - distanceMetric: 'cie76' (default) or 'cie94'
     *   - cie94Params: { kL, k1, k2 } - CIE94 parameters (optional)
     * @returns {Promise<Uint8Array>} - Array of palette indices per pixel
     */
    static async mapPixelsToPaletteAsync(rawBytes, labPalette, onProgress, width = null, height = null, options = {}) {
        const ditherType = options.ditherType || 'none';
        const meshCount = options.meshCount || null;
        const dpi = options.dpi || 300;
        const distanceConfig = normalizeDistanceConfig(options);

        // Calculate LPI-aware scale factor (Rule of 7)
        // If no meshCount provided, scale = 1 (no clustering)
        let scale = 1;
        if (meshCount) {
            const maxLPI = meshCount / 7;
            scale = Math.max(1, Math.round(dpi / maxLPI));
            logger.log(`LPI-Aware Dithering: Mesh=${meshCount} TPI, MaxLPI=${maxLPI.toFixed(1)}, Scale=${scale}px (Macro-Cell size)`);
        }

        // If no width/height or ditherType is 'none', use fast nearest-neighbor
        if (!width || !height || ditherType === 'none') {
            return this._mapPixelsNearestNeighbor(rawBytes, labPalette, onProgress, distanceConfig);
        }

        // Route to appropriate dithering strategy
        const strategy = DitheringStrategies.DitheringStrategies[ditherType];
        if (strategy) {
            // Ordered dithering (blue-noise, bayer) needs scale parameter
            if (ditherType === 'blue-noise' || ditherType === 'bayer') {
                return strategy(rawBytes, labPalette, width, height, onProgress, scale);
            }
            // Error diffusion (floyd-steinberg, atkinson, stucki) doesn't need scale
            return strategy(rawBytes, labPalette, width, height, onProgress);
        }

        // Fallback to nearest-neighbor for unknown types
        logger.log(`Unknown dithering type: ${ditherType}, falling back to nearest-neighbor`);
        return this._mapPixelsNearestNeighbor(rawBytes, labPalette, onProgress);
    }

    /**
     * Nearest-neighbor mapping (no dithering)
     * Fast hard-snap to closest palette color in Lab space
     *
     * NATIVE 16-BIT PROCESSING: Distance calculations happen in integer space (0-32768)
     * to preserve sub-bit-depth precision. No floating-point normalization leak.
     *
     * @param {Uint16Array} rawBytes - 16-bit Lab data (L: 0-32768, a/b: 0-32768 neutral=16384)
     * @param {Array} labPalette - Array of {L, a, b} objects (perceptual ranges)
     * @param {Function} onProgress - Progress callback (0-100)
     * @param {Object} distanceConfig - Distance metric configuration from normalizeDistanceConfig()
     * @returns {Promise<Uint8Array>} - Array of palette indices per pixel
     */
    static async _mapPixelsNearestNeighbor(rawBytes, labPalette, onProgress, distanceConfig = { metric: DistanceMetric.CIE76, isCIE94: false, isCIE2000: false }) {
        const pixelCount = rawBytes.length / 3;
        const colorIndices = new Uint8Array(pixelCount);
        const CHUNK_SIZE = 65536; // 64k pixels per UI yield (optimized for throughput)

        const metricLabel = distanceConfig.isCIE2000 ? 'CIE2000' : (distanceConfig.isCIE94 ? 'CIE94' : 'CIE76 (L-weighted)');
        logger.log(`Mapping ${pixelCount} pixels using ${metricLabel} [NATIVE 16-BIT] (async batching: ${Math.ceil(pixelCount / CHUNK_SIZE)} chunks)...`);

        // NATIVE 16-BIT: Convert palette to 16-bit integer space ONCE
        // This eliminates per-pixel floating-point conversion (the "Normalization Leak")
        const paletteSize = labPalette.length;
        const palL16 = new Int32Array(paletteSize);
        const palA16 = new Int32Array(paletteSize);
        const palB16 = new Int32Array(paletteSize);

        // Also keep perceptual values for CIE2000 (which requires perceptual space)
        const palL = new Float32Array(paletteSize);
        const palA = new Float32Array(paletteSize);
        const palB = new Float32Array(paletteSize);

        for (let j = 0; j < paletteSize; j++) {
            // Perceptual → 16-bit integer conversion
            palL16[j] = Math.round((labPalette[j].L / 100) * 32768);
            palA16[j] = Math.round((labPalette[j].a / 128) * 16384 + 16384);
            palB16[j] = Math.round((labPalette[j].b / 128) * 16384 + 16384);
            // Keep perceptual for CIE2000
            palL[j] = labPalette[j].L;
            palA[j] = labPalette[j].a;
            palB[j] = labPalette[j].b;
        }

        // Pre-compute chroma for CIE94 in 16-bit space
        let palChroma16 = null;
        let k1_16 = DEFAULT_CIE94_PARAMS_16.k1;
        let k2_16 = DEFAULT_CIE94_PARAMS_16.k2;
        if (distanceConfig.isCIE94) {
            palChroma16 = preparePaletteChroma16(labPalette.map((p, i) => ({
                L: palL16[i], a: palA16[i], b: palB16[i]
            })));
        }

        // Shadow threshold in 16-bit units: 40% L = 13107
        const SHADOW_THRESHOLD_16 = 13107;
        let lastBestIndex = 0;

        // Process in chunks with event loop yielding
        for (let i = 0; i < pixelCount; i += CHUNK_SIZE) {
            const chunkEnd = Math.min(i + CHUNK_SIZE, pixelCount);

            // --- INNER HOT LOOP (Synchronous for performance) ---
            for (let p = i; p < chunkEnd; p++) {
                const pIdx = p * 3;

                // NATIVE 16-BIT: Read raw pixel values directly (no conversion!)
                const pL = rawBytes[pIdx];      // Raw 16-bit L (0-32768)
                const pA = rawBytes[pIdx + 1];  // Raw 16-bit a (0-32768, 16384=neutral)
                const pB = rawBytes[pIdx + 2];  // Raw 16-bit b (0-32768, 16384=neutral)

                // Spatial Locality: Check last winner first
                let minDistanceSq;
                if (distanceConfig.isCIE2000) {
                    // CIE2000 requires perceptual space - convert just for this metric
                    const L = (pL / 32768) * 100;
                    const a = ((pA - 16384) / 16384) * 128;
                    const b = ((pB - 16384) / 16384) * 128;
                    minDistanceSq = cie2000SquaredInline(
                        L, a, b,
                        palL[lastBestIndex], palA[lastBestIndex], palB[lastBestIndex]
                    );
                } else if (distanceConfig.isCIE94) {
                    // CIE94 in native 16-bit space
                    minDistanceSq = cie94SquaredInline16(
                        pL, pA, pB,
                        palL16[lastBestIndex], palA16[lastBestIndex], palB16[lastBestIndex],
                        palChroma16[lastBestIndex], k1_16, k2_16
                    );
                } else {
                    // CIE76 with L-weighting in native 16-bit space
                    minDistanceSq = cie76WeightedSquaredInline16(
                        pL, pA, pB,
                        palL16[lastBestIndex], palA16[lastBestIndex], palB16[lastBestIndex],
                        SHADOW_THRESHOLD_16, 2.0
                    );
                }

                if (minDistanceSq > SNAP_THRESHOLD_SQ_16) {
                    let nearestIndex = lastBestIndex;

                    // Search all palette colors
                    for (let c = 0; c < paletteSize; c++) {
                        let distSq;
                        if (distanceConfig.isCIE2000) {
                            const L = (pL / 32768) * 100;
                            const a = ((pA - 16384) / 16384) * 128;
                            const b = ((pB - 16384) / 16384) * 128;
                            distSq = cie2000SquaredInline(
                                L, a, b,
                                palL[c], palA[c], palB[c]
                            );
                        } else if (distanceConfig.isCIE94) {
                            distSq = cie94SquaredInline16(
                                pL, pA, pB,
                                palL16[c], palA16[c], palB16[c],
                                palChroma16[c], k1_16, k2_16
                            );
                        } else {
                            // CIE76 with L-weighting in native 16-bit
                            distSq = cie76WeightedSquaredInline16(
                                pL, pA, pB,
                                palL16[c], palA16[c], palB16[c],
                                SHADOW_THRESHOLD_16, 2.0
                            );
                        }

                        if (distSq < minDistanceSq) {
                            minDistanceSq = distSq;
                            nearestIndex = c;
                            if (distSq < SNAP_THRESHOLD_SQ_16) break; // Early exit
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

        logger.log(`✓ Mapped ${pixelCount} pixels to palette (${metricLabel})`);
        return colorIndices;
    }

    /**
     * Map Lab pixels to nearest colors in the custom Lab palette (synchronous version).
     *
     * CRITICAL FIX: This uses normalized perceptual ranges (L:0-100, a/b:-128 to 127)
     * and performs distance checks without converting to RGB.
     *
     * CONFIGURABLE DISTANCE METRIC (v2.1):
     * - distanceMetric: 'cie76' (default) or 'cie94'
     * - CIE94 provides better perceptual accuracy for saturated colors
     *
     * @param {Uint16Array} rawBytes - 16-bit Lab data from imaging.getPixels() (3 channels)
     * @param {Array} labPalette - Array of {L, a, b} objects from PosterizationEngine
     * @param {number} width - Image width (optional, for future dithering support)
     * @param {number} height - Image height (optional, for future dithering support)
     * @param {Object} options - Options object:
     *   - distanceMetric: 'cie76' (default) or 'cie94'
     *   - cie94Params: { kL, k1, k2 } - CIE94 parameters (optional)
     * @returns {Uint8Array} - Array of palette indices per pixel
     */
    static mapPixelsToPalette(rawBytes, labPalette, width = null, height = null, options = {}) {
        const pixelCount = rawBytes.length / 3;
        const colorIndices = new Uint8Array(pixelCount);
        const distanceConfig = normalizeDistanceConfig(options);

        // ARTIST-CENTRIC MODEL: Early Exit Optimization
        // If a pixel is "close enough" to a palette color (Lab distance < 2.0),
        // stop checking remaining colors and assign immediately.
        // This dramatically speeds up separation for images with large uniform regions.
        const SNAP_THRESHOLD = 2.0;
        const SNAP_THRESHOLD_SQ = SNAP_THRESHOLD * SNAP_THRESHOLD;

        const metricLabel = distanceConfig.isCIE94 ? 'CIE94' : 'CIE76 (L-weighted)';
        logger.log(`Mapping ${pixelCount} pixels using ${metricLabel} (early exit < ${SNAP_THRESHOLD})...`);

        // OPTIMIZATION 3: Exact Match Cache
        // Pre-compute hash map for O(1) exact color lookup
        // Images with large flat regions benefit enormously from this
        const paletteMap = new Map();
        for (let j = 0; j < labPalette.length; j++) {
            const key = `${labPalette[j].L.toFixed(1)},${labPalette[j].a.toFixed(1)},${labPalette[j].b.toFixed(1)}`;
            paletteMap.set(key, j);
        }

        // Pre-compute chroma for CIE94
        let palChroma = null;
        let k1 = 0.045, k2 = 0.015;
        if (distanceConfig.isCIE94) {
            palChroma = preparePaletteChroma(labPalette);
            k1 = distanceConfig.cie94Params.k1;
            k2 = distanceConfig.cie94Params.k2;
        }

        let earlyExitCount = 0;
        let exactMatchCount = 0;
        let spatialHitCount = 0;

        // OPTIMIZATION 4: Spatial Locality
        // Adjacent pixels often have the same color - check previous winner first
        let lastBestIndex = 0;

        for (let i = 0; i < pixelCount; i++) {
            const pIdx = i * 3;

            // 1. MAP 16-BIT LAB TO PERCEPTUAL LAB
            // L: 0-32768 -> 0-100
            // a/b: 0-32768 (neutral=16384) -> -128 to +127
            const L = (rawBytes[pIdx] / 32768) * 100;
            const a = (rawBytes[pIdx + 1] - 16384) * (128 / 16384);
            const b = (rawBytes[pIdx + 2] - 16384) * (128 / 16384);

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
            let minDistanceSq;

            if (distanceConfig.isCIE94) {
                minDistanceSq = cie94SquaredInline(
                    L, a, b,
                    lastColor.L, lastColor.a, lastColor.b,
                    palChroma[lastBestIndex], k1, k2
                );
            } else {
                const avgL_last = (L + lastColor.L) / 2;
                const lWeight_last = avgL_last < 40 ? 2.0 : 1.0;
                minDistanceSq = cie76WeightedSquaredInline(
                    L, a, b,
                    lastColor.L, lastColor.a, lastColor.b,
                    lWeight_last
                );
            }

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
                let distSq;

                if (distanceConfig.isCIE94) {
                    distSq = cie94SquaredInline(
                        L, a, b,
                        target.L, target.a, target.b,
                        palChroma[j], k1, k2
                    );
                } else {
                    const dL = L - target.L;

                    // OPTIMIZATION 1: Early exit on L channel alone (CIE76 only)
                    const dLsq = dL * dL;
                    if (dLsq >= minDistanceSq) {
                        continue; // Can't be closer, skip rest of calculation
                    }

                    // Apply perceptual L-scaling to preserve shadow detail
                    const avgL_j = (L + target.L) / 2;
                    const lWeight_j = avgL_j < 40 ? 2.0 : 1.0;
                    distSq = cie76WeightedSquaredInline(
                        L, a, b,
                        target.L, target.a, target.b,
                        lWeight_j
                    );
                }

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
        logger.log(`✓ Mapped all pixels to palette using ${metricLabel} (${earlyExitCount} early exits = ${earlyExitPct}%, ${exactMatchCount} exact = ${exactMatchPct}%, ${spatialHitCount} spatial = ${spatialHitPct}%)`);
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
     * @param {Uint16Array} rawBytes - 16-bit Lab pixel data (3 values/pixel: L, a, b)
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
        const ditherType = options.ditherType || 'none';
        const distanceMetric = options.distanceMetric || 'cie76';
        const cie94Params = options.cie94Params;
        logger.log(`Dithering type: ${ditherType}, Distance metric: ${distanceMetric}`);

        const colorIndices = await this.mapPixelsToPaletteAsync(
            rawBytes,
            labPalette,
            onProgress,
            width,
            height,
            { ditherType, distanceMetric, cie94Params }
        );

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

            const coveragePercent = (opaquePixelCount / (width * height) * 100);
            logger.log(`  Layer has ${opaquePixelCount} pixels (${coveragePercent.toFixed(1)}% coverage)`);

            // Skip empty or near-empty layers
            // Minimum threshold: 0.1% coverage (prevents artifacts from palette reduction, substrate detection, etc.)
            const MIN_COVERAGE_PERCENT = 0.1;
            if (opaquePixelCount === 0 || coveragePercent < MIN_COVERAGE_PERCENT) {
                logger.log(`  ⚠ Skipping layer (${coveragePercent.toFixed(3)}% coverage < ${MIN_COVERAGE_PERCENT}% threshold)`);
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
