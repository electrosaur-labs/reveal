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
const {
    LAB16_L_MAX,
    AB_SCALE,
    perceptualToEngine16,
    engine16ToPerceptual
} = require("../color/LabEncoding");

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
        const meshCount = options.meshCount || options.mesh || null;  // Accept both names
        const dpi = options.dpi || 300;
        const distanceConfig = normalizeDistanceConfig(options);

        // Calculate LPI-aware scale factor (Rule of 7)
        // If no meshCount provided, scale = 1 (no clustering)
        let scale = 1;
        if (meshCount) {
            const maxLPI = meshCount / 7;
            scale = Math.max(1, Math.round(dpi / maxLPI));
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
            // Perceptual → 16-bit integer conversion (via centralized LabEncoding)
            const e16 = perceptualToEngine16(labPalette[j].L, labPalette[j].a, labPalette[j].b);
            palL16[j] = e16.L16;
            palA16[j] = e16.a16;
            palB16[j] = e16.b16;
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

        // Snap threshold must match the distance metric's scale:
        // - CIE76 16-bit: squared distances in 16-bit space (0 to ~3.2 billion). 180000 ≈ ΔE ~1.3 perceptual
        // - CIE2000: squared distances in perceptual ΔE² (0 to ~10000). 1.0 ≈ ΔE 1.0 (barely perceptible)
        // - CIE94 16-bit: squared distances in 16-bit-weighted space. Same scale as CIE76.
        const snapThreshold = distanceConfig.isCIE2000 ? 1.0 : SNAP_THRESHOLD_SQ_16;

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
                    // CIE2000 requires perceptual space — inline conversion using named constants
                    const L = (pL / LAB16_L_MAX) * 100;
                    const a = (pA - LAB16_AB_NEUTRAL) / AB_SCALE;
                    const b = (pB - LAB16_AB_NEUTRAL) / AB_SCALE;
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

                if (minDistanceSq > snapThreshold) {
                    let nearestIndex = lastBestIndex;

                    // Search all palette colors
                    for (let c = 0; c < paletteSize; c++) {
                        let distSq;
                        if (distanceConfig.isCIE2000) {
                            const L = (pL / LAB16_L_MAX) * 100;
                            const a = (pA - LAB16_AB_NEUTRAL) / AB_SCALE;
                            const b = (pB - LAB16_AB_NEUTRAL) / AB_SCALE;
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
                            if (distSq < snapThreshold) break; // Early exit
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

            // 1. MAP 16-BIT LAB TO PERCEPTUAL LAB (via LabEncoding constants)
            const L = (rawBytes[pIdx] / LAB16_L_MAX) * 100;
            const a = (rawBytes[pIdx + 1] - LAB16_AB_NEUTRAL) / AB_SCALE;
            const b = (rawBytes[pIdx + 2] - LAB16_AB_NEUTRAL) / AB_SCALE;

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
     * Morphological despeckle: Remove isolated pixel clusters below threshold
     * Uses iterative flood-fill (8-way connectivity) to identify connected components
     *
     * @param {Uint8Array} mask - Layer mask to despeckle (modified in-place)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} threshold - Minimum cluster size (clusters < threshold are removed)
     * @returns {Object} { clustersRemoved, pixelsRemoved }
     * @private
     */
    static _despeckleMask(mask, width, height, threshold) {
        const pixelCount = width * height;
        const visited = new Uint8Array(pixelCount);
        const stack = new Uint32Array(pixelCount);

        let clustersRemoved = 0;
        let pixelsRemoved = 0;
        const clustersToRemove = []; // Store small clusters for removal

        // Find all connected components using flood-fill
        for (let i = 0; i < pixelCount; i++) {
            // Skip empty pixels or already visited
            if (mask[i] === 0 || visited[i] === 1) continue;

            // Start new connected component with iterative flood fill
            const clusterPixels = [];
            let stackPtr = 0;

            stack[stackPtr++] = i;
            visited[i] = 1;

            // Iterative flood fill using explicit stack
            while (stackPtr > 0) {
                const idx = stack[--stackPtr];
                clusterPixels.push(idx);

                const x = idx % width;
                const y = Math.floor(idx / width);

                // Check 8 neighbors (diagonal connectivity counts)
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue; // Skip center pixel

                        const nx = x + dx;
                        const ny = y + dy;

                        // Bounds check
                        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

                        const nIdx = ny * width + nx;

                        // Add unvisited non-zero neighbors to stack
                        if (mask[nIdx] > 0 && visited[nIdx] === 0) {
                            stack[stackPtr++] = nIdx;
                            visited[nIdx] = 1;
                        }
                    }
                }
            }

            // If cluster is below threshold, mark for removal
            if (clusterPixels.length < threshold) {
                clustersToRemove.push(clusterPixels);
                clustersRemoved++;
                pixelsRemoved += clusterPixels.length;
            }
        }

        // Remove small clusters (set pixels to 0)
        for (const cluster of clustersToRemove) {
            for (const pixelIdx of cluster) {
                mask[pixelIdx] = 0;
            }
        }

        return { clustersRemoved, pixelsRemoved };
    }

    /**
     * Palette Post-Pruning: Merge colors below minVolume threshold
     *
     * SOVEREIGN SOLUTION: Treats color selection as resource allocation.
     * If a color doesn't have the "Volume" to justify a screen, it must be evicted.
     *
     * ALGORITHM:
     * 1. Count pixels per color (volume = pixelCount / totalPixels)
     * 2. Identify "weak" colors (volume < minVolume)
     * 3. Find nearest "strong" neighbor using Lab distance
     * 4. Reassign all weak pixels to strong neighbor
     * 5. Remove weak colors from palette
     *
     * @param {Array<Object>} labPalette - Original Lab palette [{L, a, b}, ...]
     * @param {Uint8ClampedArray} colorIndices - Pixel-to-color mapping
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} minVolume - Minimum coverage percentage (e.g., 1.5 = 1.5%)
     * @param {Object} options - {distanceMetric: 'cie76'|'cie94'|'cie2000'}
     * @returns {Object} {prunedPalette, remappedIndices, mergedCount, details}
     */
    static pruneWeakColors(labPalette, colorIndices, width, height, minVolume, options = {}) {
        const pixelCount = width * height;
        const minPixels = Math.ceil((minVolume / 100) * pixelCount);
        const maxColors = options.maxColors || 0; // 0 = no cap

        // 1. Count pixels per color
        const colorCounts = new Array(labPalette.length).fill(0);
        for (let i = 0; i < colorIndices.length; i++) {
            colorCounts[colorIndices[i]]++;
        }

        // Calculate volumes (percentages)
        const volumes = colorCounts.map(count => (count / pixelCount) * 100);

        // 2. Identify weak and strong colors
        const weakIndices = [];
        const strongIndices = [];
        for (let i = 0; i < labPalette.length; i++) {
            if (colorCounts[i] < minPixels) {
                weakIndices.push(i);
            } else {
                strongIndices.push(i);
            }
        }

        // 2.5. Screen cap — if strong colors exceed maxColors, demote the
        //      lowest-coverage strong colors to weak so they get merged
        if (maxColors > 0 && strongIndices.length > maxColors) {
            // Sort strong by coverage ascending
            const ranked = strongIndices
                .map(idx => ({ idx, count: colorCounts[idx] }))
                .sort((a, b) => a.count - b.count);

            const demoteCount = strongIndices.length - maxColors;
            for (let i = 0; i < demoteCount; i++) {
                const demotedIdx = ranked[i].idx;
                weakIndices.push(demotedIdx);
                const strongPos = strongIndices.indexOf(demotedIdx);
                strongIndices.splice(strongPos, 1);
            }
        }

        // No weak colors to prune
        if (weakIndices.length === 0) {
            return {
                prunedPalette: labPalette,
                remappedIndices: colorIndices,
                mergedCount: 0,
                details: []
            };
        }

        // No strong colors to merge into (shouldn't happen, but safety check)
        if (strongIndices.length === 0) {
            return {
                prunedPalette: labPalette,
                remappedIndices: colorIndices,
                mergedCount: 0,
                details: []
            };
        }

        // SAFETY CHECK: Prevent over-pruning below minimum viable palette
        const MIN_COLORS = 4; // Never prune below 4 colors (printmaker minimum)
        const finalColorCount = strongIndices.length;

        if (finalColorCount < MIN_COLORS) {
            const needed = MIN_COLORS - finalColorCount;

            // Sort weak colors by volume (descending) and promote the largest ones
            const sortedWeak = weakIndices
                .map(idx => ({ idx, volume: volumes[idx], count: colorCounts[idx] }))
                .sort((a, b) => b.count - a.count);

            // Move the largest N weak colors to strong list
            for (let i = 0; i < needed && i < sortedWeak.length; i++) {
                const promotedIdx = sortedWeak[i].idx;
                strongIndices.push(promotedIdx);
                const weakPos = weakIndices.indexOf(promotedIdx);
                weakIndices.splice(weakPos, 1);
            }
        }


        // 3. Create remapping table: weakIndex → strongIndex
        const remapTable = new Array(labPalette.length);
        const mergeDetails = [];

        for (const weakIdx of weakIndices) {
            const weakColor = labPalette[weakIdx];
            let bestStrongIdx = strongIndices[0];
            let bestDistSq = Infinity;

            // Find nearest strong neighbor using Lab distance
            for (const strongIdx of strongIndices) {
                const strongColor = labPalette[strongIdx];
                const dL = weakColor.L - strongColor.L;
                const da = weakColor.a - strongColor.a;
                const db = weakColor.b - strongColor.b;

                // Use CIE76 (Euclidean) for speed and simplicity
                const distSq = dL * dL + da * da + db * db;

                if (distSq < bestDistSq) {
                    bestDistSq = distSq;
                    bestStrongIdx = strongIdx;
                }
            }

            remapTable[weakIdx] = bestStrongIdx;

            mergeDetails.push({
                weakIndex: weakIdx,
                strongIndex: bestStrongIdx,
                weakColor: weakColor,
                strongColor: labPalette[bestStrongIdx],
                volume: volumes[weakIdx],
                pixelCount: colorCounts[weakIdx],
                deltaE: Math.sqrt(bestDistSq)
            });

        }

        // Keep strong colors unchanged
        for (const strongIdx of strongIndices) {
            remapTable[strongIdx] = strongIdx;
        }

        // 4. Reassign all pixels using remapTable
        const remappedIndices = new Uint8ClampedArray(colorIndices.length);
        for (let i = 0; i < colorIndices.length; i++) {
            const oldIdx = colorIndices[i];
            remappedIndices[i] = remapTable[oldIdx];
        }

        // 5. Build pruned palette (strong colors only) and create compact index mapping
        const prunedPalette = [];
        const compactMapping = new Array(labPalette.length); // oldIndex → newIndex

        for (let i = 0; i < strongIndices.length; i++) {
            const strongIdx = strongIndices[i];
            prunedPalette.push(labPalette[strongIdx]);
            compactMapping[strongIdx] = i;
        }

        // 6. Compact remapped indices to use new palette indices
        for (let i = 0; i < remappedIndices.length; i++) {
            remappedIndices[i] = compactMapping[remappedIndices[i]];
        }


        return {
            prunedPalette,
            remappedIndices,
            mergedCount: weakIndices.length,
            details: mergeDetails
        };
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

        if (!labPalette || labPalette.length === 0) {
            throw new Error("Separation requires a valid Lab Palette for perceptual accuracy.");
        }


        // Extract options (pass full options object to preserve all parameters)
        const onProgress = options.onProgress || null;
        const ditherType = options.ditherType || 'none';
        const distanceMetric = options.distanceMetric || 'cie76';

        const colorIndices = await this.mapPixelsToPaletteAsync(
            rawBytes,
            labPalette,
            onProgress,
            width,
            height,
            options  // Pass full options object to preserve all parameters
        );

        const layers = [];

        labPalette.forEach((labColor, index) => {
            const hex = hexColors[index];

            const mask = this.generateLayerMask(colorIndices, index, width, height);

            // Apply shadowClamp: Clamp barely-visible pixels to printable minimum
            if (options.shadowClamp !== undefined && options.shadowClamp > 0) {
                const clampThreshold = Math.round(options.shadowClamp * 255 / 100); // Convert % to 0-255
                let clampedCount = 0;

                for (let i = 0; i < mask.length; i++) {
                    const density = mask[i];

                    // If barely visible (0 < density < threshold), clamp to threshold
                    if (density > 0 && density < clampThreshold) {
                        mask[i] = clampThreshold;
                        clampedCount++;
                    }
                }

                if (clampedCount > 0) {
                }
            }

            // Apply speckleRescue: Remove isolated clusters below threshold (morphological despeckle)
            if (options.speckleRescue !== undefined && options.speckleRescue > 0) {
                const threshold = Math.round(options.speckleRescue); // Minimum cluster size (default: 4 pixels)
                const pruned = this._despeckleMask(mask, width, height, threshold);

                if (pruned.clustersRemoved > 0) {
                }
            }

            // Count opaque pixels in this layer
            let opaquePixelCount = 0;
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] === 255) opaquePixelCount++;
            }

            const coveragePercent = (opaquePixelCount / (width * height) * 100);

            // Skip empty or near-empty layers
            // Minimum threshold: 0.1% coverage (prevents artifacts from palette reduction, substrate detection, etc.)
            const MIN_COVERAGE_PERCENT = 0.1;
            if (opaquePixelCount === 0 || coveragePercent < MIN_COVERAGE_PERCENT) {
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

        return layers;
    }
}

module.exports = SeparationEngine;
