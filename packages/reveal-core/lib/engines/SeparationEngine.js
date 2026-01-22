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
     * @param {Uint8ClampedArray} rawBytes - Raw Lab bytes (0-255 encoding: L, a+128, b+128)
     * @param {Array} labPalette - Array of {L, a, b} objects (perceptual ranges)
     * @param {Function} onProgress - Progress callback (0-100)
     * @param {number} width - Image width (required for dithering)
     * @param {number} height - Image height (required for dithering)
     * @param {Object} options - Options object:
     *   - ditherType: 'none'|'floyd-steinberg'|'blue-noise'|'bayer'|'atkinson'|'stucki'
     *   - meshCount: Screen mesh TPI (e.g., 230, 305) - enables LPI-aware Macro-Cell clustering
     *   - dpi: Image DPI (default: 300) - used with meshCount for scale calculation
     * @returns {Promise<Uint8Array>} - Array of palette indices per pixel
     */
    static async mapPixelsToPaletteAsync(rawBytes, labPalette, onProgress, width = null, height = null, options = {}) {
        const ditherType = options.ditherType || 'none';
        const meshCount = options.meshCount || null;
        const dpi = options.dpi || 300;

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
            return this._mapPixelsNearestNeighbor(rawBytes, labPalette, onProgress);
        }

        // Dithering path (Floyd-Steinberg, Blue Noise, Bayer, Atkinson, or Stucki)
        if (ditherType === 'floyd-steinberg') {
            return this._mapPixelsFloydSteinberg(rawBytes, labPalette, width, height, onProgress);
        } else if (ditherType === 'blue-noise') {
            return this._mapPixelsBlueNoise(rawBytes, labPalette, width, height, onProgress, scale);
        } else if (ditherType === 'bayer') {
            return this._mapPixelsBayer(rawBytes, labPalette, width, height, onProgress, scale);
        } else if (ditherType === 'atkinson') {
            return this._mapPixelsAtkinson(rawBytes, labPalette, width, height, onProgress);
        } else if (ditherType === 'stucki') {
            return this._mapPixelsStucki(rawBytes, labPalette, width, height, onProgress);
        }

        // Fallback to nearest-neighbor for unknown types
        logger.log(`Unknown dithering type: ${ditherType}, falling back to nearest-neighbor`);
        return this._mapPixelsNearestNeighbor(rawBytes, labPalette, onProgress);
    }

    /**
     * Nearest-neighbor mapping (no dithering)
     * Fast hard-snap to closest palette color in Lab space
     *
     * @param {Uint8ClampedArray} rawBytes - Raw Lab bytes (0-255 encoding)
     * @param {Array} labPalette - Array of {L, a, b} objects (perceptual ranges)
     * @param {Function} onProgress - Progress callback (0-100)
     * @returns {Promise<Uint8Array>} - Array of palette indices per pixel
     */
    static async _mapPixelsNearestNeighbor(rawBytes, labPalette, onProgress) {
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
     * Floyd-Steinberg Error Diffusion in CIELAB space
     * Propagates quantization error to neighboring pixels for smooth gradients
     *
     * @param {Uint8ClampedArray} rawBytes - Lab bytes (0-255 encoding)
     * @param {Array<{L,a,b}>} labPalette - Palette in perceptual Lab ranges
     * @param {number} width - Image width (required for error diffusion)
     * @param {number} height - Image height (required for error diffusion)
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Uint8Array>} - Palette indices
     */
    static async _mapPixelsFloydSteinberg(rawBytes, labPalette, width, height, onProgress) {
        const pixelCount = rawBytes.length / 3;
        const colorIndices = new Uint8Array(pixelCount);

        // Handle empty palette gracefully
        if (!labPalette || labPalette.length === 0) {
            logger.log('Floyd-Steinberg: Empty palette, returning zeros');
            return colorIndices;
        }

        // Error buffer: L, a, b errors for each pixel (Float32 for fractional accuracy)
        const errorBuf = new Float32Array(rawBytes.length);

        const CHUNK_SIZE = 32768; // Smaller chunk for dithering overhead (181 rows of 1024px)

        logger.log(`Floyd-Steinberg dithering: ${width}x${height} (${pixelCount} pixels)`);

        // CRITICAL: Process row-by-row, left-to-right for error propagation
        // Cannot use random-access chunking like nearest-neighbor
        for (let i = 0; i < pixelCount; i++) {
            const pxIdx = i * 3;
            const y = Math.floor(i / width);
            const x = i % width;

            // 1. Get original Lab + accumulated error from neighbors
            let L = (rawBytes[pxIdx] / 255) * 100 + errorBuf[pxIdx];
            let a = (rawBytes[pxIdx + 1] - 128) + errorBuf[pxIdx + 1];
            let b = (rawBytes[pxIdx + 2] - 128) + errorBuf[pxIdx + 2];

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
            this._distributeError(errorBuf, x, y, width, height, errL, errA, errB);

            // UI Yielding (every CHUNK_SIZE pixels)
            if (i % CHUNK_SIZE === 0 && onProgress) {
                onProgress(Math.round((i / pixelCount) * 100));
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        if (onProgress) onProgress(100);
        logger.log(`✓ Floyd-Steinberg dithering complete`);
        return colorIndices;
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
    static _distributeError(buf, x, y, w, h, eL, eA, eB) {
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
     * Finds the two nearest palette colors to a given Lab pixel
     * Uses squared distances for performance (avoids sqrt)
     *
     * @param {number} L - Lightness (0-100)
     * @param {number} a - Green-red axis (-128 to 127)
     * @param {number} b - Blue-yellow axis (-128 to 127)
     * @param {Array<{L,a,b}>} labPalette - Palette colors
     * @returns {{i1: number, i2: number, d1: number, d2: number}} - Indices and squared distances
     */
    static _getTwoNearest(L, a, b, labPalette) {
        let d1 = Infinity, d2 = Infinity;
        let i1 = 0, i2 = 0;

        for (let j = 0; j < labPalette.length; j++) {
            const p = labPalette[j];
            // Squared distance (faster - no sqrt needed)
            const distSq = (L - p.L)**2 + (a - p.a)**2 + (b - p.b)**2;

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
     * Finds the nearest palette color to a given Lab pixel
     * Uses squared distances for performance (avoids sqrt)
     *
     * @param {number} L - Lightness (0-100)
     * @param {number} a - Green-red axis (-128 to 127)
     * @param {number} b - Blue-yellow axis (-128 to 127)
     * @param {Array<{L,a,b}>} labPalette - Palette colors
     * @returns {number} - Index of nearest color
     */
    static _getNearest(L, a, b, labPalette) {
        let minDistSq = Infinity;
        let bestIdx = 0;

        for (let j = 0; j < labPalette.length; j++) {
            const p = labPalette[j];
            const distSq = (L - p.L)**2 + (a - p.a)**2 + (b - p.b)**2;

            if (distSq < minDistSq) {
                minDistSq = distSq;
                bestIdx = j;
            }
        }

        return bestIdx;
    }

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
    static _getBlueNoiseLUT() {
        // Cache the LUT to avoid regenerating it every time
        if (this._cachedBlueNoiseLUT) {
            return this._cachedBlueNoiseLUT;
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

        this._cachedBlueNoiseLUT = lut;
        return lut;
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
     * Ideal for fine art oil paintings (SP100 set) printed on screen mesh.
     *
     * Algorithm:
     * - Finds TWO nearest palette colors per pixel
     * - Uses distance ratio compared to blue noise threshold
     * - Creates stochastic, dispersed dot patterns
     * - With scale > 1: Clusters dots into Macro-Cells
     *
     * @param {Uint8ClampedArray} rawBytes - Lab bytes (0-255 encoding)
     * @param {Array<{L,a,b}>} labPalette - Palette in perceptual Lab ranges
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Function} onProgress - Progress callback
     * @param {number} scale - Macro-Cell size in pixels (1 = no clustering, >1 = LPI-aware)
     * @returns {Promise<Uint8Array>} - Palette indices
     */
    static async _mapPixelsBlueNoise(rawBytes, labPalette, width, height, onProgress, scale = 1) {
        const pixelCount = rawBytes.length / 3;
        const colorIndices = new Uint8Array(pixelCount);

        // Handle empty palette gracefully
        if (!labPalette || labPalette.length === 0) {
            logger.log('Blue Noise: Empty palette, returning zeros');
            return colorIndices;
        }

        // Handle single-color palette (no dithering needed)
        if (labPalette.length === 1) {
            logger.log('Blue Noise: Single color palette, all pixels map to index 0');
            return colorIndices; // Already filled with zeros
        }

        // Get the 64x64 Blue Noise Threshold Mask
        const blueNoise = this._getBlueNoiseLUT();
        const maskSize = 64;
        const CHUNK_SIZE = 65536; // 64k pixels per UI yield

        logger.log(`Blue Noise dithering: ${width}x${height} (${pixelCount} pixels, scale=${scale})`);

        for (let i = 0; i < pixelCount; i++) {
            const pxIdx = i * 3;
            const x = i % width;
            const y = Math.floor(i / width);

            // Unpack Lab from 0-255 encoding
            const L = (rawBytes[pxIdx] / 255) * 100;
            const a = rawBytes[pxIdx + 1] - 128;
            const b = rawBytes[pxIdx + 2] - 128;

            // Find the TWO closest palette colors using SQUARED distances (faster)
            const { i1, i2, d1, d2 } = this._getTwoNearest(L, a, b, labPalette);

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
            const threshold = blueNoise[(cellY % maskSize) * maskSize + (cellX % maskSize)] / 255;

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
        logger.log(`✓ Blue Noise dithering complete (Macro-Cell scale: ${scale}px)`);
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
     * Algorithm:
     * - Finds TWO nearest palette colors per pixel
     * - Uses 8x8 Bayer matrix threshold for decision
     * - Creates regular, predictable crosshatch pattern
     * - With scale > 1: Creates Macro-Cells of uniform threshold
     *
     * @param {Uint8ClampedArray} rawBytes - Lab bytes (0-255 encoding)
     * @param {Array<{L,a,b}>} labPalette - Palette in perceptual Lab ranges
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Function} onProgress - Progress callback
     * @param {number} scale - Macro-Cell size in pixels (1 = no clustering, >1 = LPI-aware)
     * @returns {Promise<Uint8Array>} - Palette indices
     */
    static async _mapPixelsBayer(rawBytes, labPalette, width, height, onProgress, scale = 1) {
        const pixelCount = rawBytes.length / 3;
        const colorIndices = new Uint8Array(pixelCount);

        // Handle empty palette gracefully
        if (!labPalette || labPalette.length === 0) {
            logger.log('Bayer: Empty palette, returning zeros');
            return colorIndices;
        }

        // Handle single-color palette (no dithering needed)
        if (labPalette.length === 1) {
            logger.log('Bayer: Single color palette, all pixels map to index 0');
            return colorIndices;
        }

        // Standard 8x8 Bayer Matrix (values 0-63)
        const bayer = [
            [ 0, 32,  8, 40,  2, 34, 10, 42],
            [48, 16, 56, 24, 50, 18, 58, 26],
            [12, 44,  4, 36, 14, 46,  6, 38],
            [60, 28, 52, 20, 62, 30, 54, 22],
            [ 3, 35, 11, 43,  1, 33,  9, 41],
            [51, 19, 59, 27, 49, 17, 57, 25],
            [15, 47,  7, 39, 13, 45,  5, 37],
            [63, 31, 55, 23, 61, 29, 53, 21]
        ];

        const CHUNK_SIZE = 65536; // 64k pixels per UI yield

        logger.log(`Bayer 8x8 dithering: ${width}x${height} (${pixelCount} pixels, scale=${scale})`);

        for (let i = 0; i < pixelCount; i++) {
            const pxIdx = i * 3;
            const x = i % width;
            const y = Math.floor(i / width);

            // Unpack Lab from 0-255 encoding
            const L = (rawBytes[pxIdx] / 255) * 100;
            const a = rawBytes[pxIdx + 1] - 128;
            const b = rawBytes[pxIdx + 2] - 128;

            // Find the TWO closest palette colors using SQUARED distances (faster)
            const { i1, i2, d1, d2 } = this._getTwoNearest(L, a, b, labPalette);

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
            const threshold = (bayer[cellY % 8][cellX % 8] + 0.5) / 64;

            // Decide which palette index to assign
            colorIndices[i] = (ratio > threshold) ? i2 : i1;

            // UI Yielding (every CHUNK_SIZE pixels)
            if (i % CHUNK_SIZE === 0 && onProgress) {
                onProgress(Math.round((i / pixelCount) * 100));
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        if (onProgress) onProgress(100);
        logger.log(`✓ Bayer 8x8 dithering complete (Macro-Cell scale: ${scale}px)`);
        return colorIndices;
    }

    /**
     * Atkinson Error Diffusion in CIELAB space
     * Classic algorithm from Bill Atkinson (original Macintosh)
     * Distributes only 75% of error for high-contrast, crisp output
     *
     * Pattern (each neighbor gets 1/8 of error):
     *          X   1/8  1/8
     *    1/8  1/8  1/8
     *          1/8
     * Total: 6/8 = 75% (25% discarded intentionally for high contrast)
     *
     * @param {Uint8ClampedArray} rawBytes - Lab bytes (0-255 encoding)
     * @param {Array<{L,a,b}>} labPalette - Palette in perceptual Lab ranges
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Uint8Array>} - Palette indices
     */
    static async _mapPixelsAtkinson(rawBytes, labPalette, width, height, onProgress) {
        const pixelCount = rawBytes.length / 3;
        const colorIndices = new Uint8Array(pixelCount);

        // Handle empty palette gracefully
        if (!labPalette || labPalette.length === 0) {
            logger.log('Atkinson: Empty palette, returning zeros');
            return colorIndices;
        }

        // Error buffer: L, a, b errors for each pixel (Float32 for fractional accuracy)
        const errorBuf = new Float32Array(rawBytes.length);

        const CHUNK_SIZE = 32768; // Smaller chunk for dithering overhead

        logger.log(`Atkinson dithering: ${width}x${height} (${pixelCount} pixels)`);

        // CRITICAL: Process row-by-row, left-to-right for error propagation
        for (let i = 0; i < pixelCount; i++) {
            const pxIdx = i * 3;
            const y = Math.floor(i / width);
            const x = i % width;

            // 1. Get original Lab + accumulated error from neighbors
            let L = (rawBytes[pxIdx] / 255) * 100 + errorBuf[pxIdx];
            let a = (rawBytes[pxIdx + 1] - 128) + errorBuf[pxIdx + 1];
            let b = (rawBytes[pxIdx + 2] - 128) + errorBuf[pxIdx + 2];

            // Clamp to valid Lab ranges
            L = Math.max(0, Math.min(100, L));
            a = Math.max(-128, Math.min(127, a));
            b = Math.max(-128, Math.min(127, b));

            // 2. Find nearest palette color
            const bestIdx = this._getNearest(L, a, b, labPalette);
            colorIndices[i] = bestIdx;

            // 3. Calculate quantization error
            const chosen = labPalette[bestIdx];
            const errL = L - chosen.L;
            const errA = a - chosen.a;
            const errB = b - chosen.b;

            // 4. Distribute error to 6 neighbors (Atkinson pattern)
            // Each neighbor gets 1/8 of the error
            const weight = 1 / 8;
            this._distributeAtkinsonError(errorBuf, x, y, width, height, errL, errA, errB, weight);

            // UI Yielding (every CHUNK_SIZE pixels)
            if (i % CHUNK_SIZE === 0 && onProgress) {
                onProgress(Math.round((i / pixelCount) * 100));
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        if (onProgress) onProgress(100);
        logger.log(`✓ Atkinson dithering complete`);
        return colorIndices;
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
    static _distributeAtkinsonError(buf, x, y, w, h, eL, eA, eB, weight) {
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
     * Stucki Error Diffusion in CIELAB space
     * Enhanced error diffusion algorithm with wider neighborhood
     * Distributes to 12 neighbors for high-fidelity photographic transitions
     *
     * Pattern (weights out of 42 denominator):
     *              X   8   4
     *        2  4  8  4  2
     *        1  2  4  2  1
     * Total: 42 (all error distributed, no discarding)
     *
     * @param {Uint8ClampedArray} rawBytes - Lab bytes (0-255 encoding)
     * @param {Array<{L,a,b}>} labPalette - Palette in perceptual Lab ranges
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Function} onProgress - Progress callback
     * @returns {Promise<Uint8Array>} - Palette indices
     */
    static async _mapPixelsStucki(rawBytes, labPalette, width, height, onProgress) {
        const pixelCount = rawBytes.length / 3;
        const colorIndices = new Uint8Array(pixelCount);

        // Handle empty palette gracefully
        if (!labPalette || labPalette.length === 0) {
            logger.log('Stucki: Empty palette, returning zeros');
            return colorIndices;
        }

        // Error buffer: L, a, b errors for each pixel (Float32 for fractional accuracy)
        const errorBuf = new Float32Array(rawBytes.length);

        const CHUNK_SIZE = 32768; // Smaller chunk for dithering overhead

        logger.log(`Stucki dithering: ${width}x${height} (${pixelCount} pixels)`);

        // CRITICAL: Process row-by-row, left-to-right for error propagation
        for (let i = 0; i < pixelCount; i++) {
            const pxIdx = i * 3;
            const y = Math.floor(i / width);
            const x = i % width;

            // 1. Get original Lab + accumulated error from neighbors
            let L = (rawBytes[pxIdx] / 255) * 100 + errorBuf[pxIdx];
            let a = (rawBytes[pxIdx + 1] - 128) + errorBuf[pxIdx + 1];
            let b = (rawBytes[pxIdx + 2] - 128) + errorBuf[pxIdx + 2];

            // Clamp to valid Lab ranges
            L = Math.max(0, Math.min(100, L));
            a = Math.max(-128, Math.min(127, a));
            b = Math.max(-128, Math.min(127, b));

            // 2. Find nearest palette color
            const bestIdx = this._getNearest(L, a, b, labPalette);
            colorIndices[i] = bestIdx;

            // 3. Calculate quantization error
            const chosen = labPalette[bestIdx];
            const errL = L - chosen.L;
            const errA = a - chosen.a;
            const errB = b - chosen.b;

            // 4. Distribute error to 12 neighbors (Stucki pattern)
            // Stucki uses 42 as denominator (all error distributed)
            this._distributeStuckiError(errorBuf, x, y, width, height, errL, errA, errB);

            // UI Yielding (every CHUNK_SIZE pixels)
            if (i % CHUNK_SIZE === 0 && onProgress) {
                onProgress(Math.round((i / pixelCount) * 100));
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        if (onProgress) onProgress(100);
        logger.log(`✓ Stucki dithering complete`);
        return colorIndices;
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
    static _distributeStuckiError(buf, x, y, w, h, eL, eA, eB) {
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
     * Map Lab pixels to nearest colors in the custom Lab palette (synchronous version).
     *
     * CRITICAL FIX: This uses normalized perceptual ranges (L:0-100, a/b:-128 to 127)
     * and performs distance checks without converting to RGB.
     *
     * @param {Uint8ClampedArray} rawBytes - Raw 3-channel Lab bytes from imaging.getPixels()
     * @param {Array} labPalette - Array of {L, a, b} objects from PosterizationEngine
     * @param {number} width - Image width (optional, for future dithering support)
     * @param {number} height - Image height (optional, for future dithering support)
     * @param {Object} options - Options object (optional, for future dithering support)
     * @returns {Uint8Array} - Array of palette indices per pixel
     */
    static mapPixelsToPalette(rawBytes, labPalette, width = null, height = null, options = {}) {
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
        const ditherType = options.ditherType || 'none';
        logger.log(`Dithering type: ${ditherType}`);

        const colorIndices = await this.mapPixelsToPaletteAsync(
            rawBytes,
            labPalette,
            onProgress,
            width,
            height,
            { ditherType }
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
