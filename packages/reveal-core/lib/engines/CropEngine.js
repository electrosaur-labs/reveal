/**
 * CropEngine - High-resolution crop extraction for 1:1 viewport
 *
 * Replaces ProxyEngine's downsampling approach with on-demand crop processing.
 *
 * Key differences from ProxyEngine:
 * - NO downsampling (true 1:1 pixel-perfect display)
 * - Processes crops on demand (800x800 windows)
 * - Maintains full separation state for entire image
 * - Applies mechanical knobs to crop only for 60fps scrubbing
 *
 * Architecture:
 * - Full-res source image stored in memory
 * - Full posterization/separation performed once
 * - Crops extracted and processed on pan/zoom
 * - 800x800 = 800,000 pixels (fast enough for real-time)
 *
 * @module CropEngine
 */

const PosterizationEngine = require('./PosterizationEngine');
const SeparationEngine = require('./SeparationEngine');
const ColorSpace = require('./ColorSpace');

class CropEngine {
    // No longer fixed - Elastic Portal architecture
    // Viewport dimensions are dynamic based on container size

    constructor() {
        this.sourceBuffer = null;        // Full-res 16-bit LAB buffer
        this.sourceWidth = 0;
        this.sourceHeight = 0;

        this.separationState = null;     // Full-res separation state
        this.sourceMetadata = null;

        // Viewport state (Elastic Portal)
        this.viewportX = 0;              // Top-left corner of current crop
        this.viewportY = 0;
        this.viewportWidth = 800;        // Dynamic - set by container
        this.viewportHeight = 800;       // Dynamic - set by container
        this.viewMode = 'fit';           // 'fit' or '1:1'
    }

    /**
     * Set viewport dimensions (called by ResizeObserver)
     * @param {number} width - New viewport width
     * @param {number} height - New viewport height
     */
    setViewportDimensions(width, height) {
        this.viewportWidth = Math.floor(width);
        this.viewportHeight = Math.floor(height);
    }

    /**
     * Initialize from pre-computed separation state (PREFERRED)
     * Uses the SAME palette and colorIndices as the main pipeline,
     * ensuring Navigator Map thumbnail matches the main preview exactly.
     *
     * @param {Uint16Array} labPixels - Source 16-bit LAB data (for high-res crop extraction)
     * @param {number} width - Source width
     * @param {number} height - Source height
     * @param {Object} separationResult - Pre-computed results from main pipeline
     * @param {Array<Object>} separationResult.paletteLab - Lab palette [{L, a, b}, ...]
     * @param {Array<Object>} separationResult.rgbPalette - RGB palette [{r, g, b}, ...]
     * @param {Uint8Array} separationResult.colorIndices - Pixel→palette index mapping
     * @param {Object} config - Additional config (actualDocumentWidth/Height, bitDepth)
     * @returns {Promise<Object>} Initial state
     */
    async initializeWithSeparation(labPixels, width, height, separationResult, config) {
        const startTime = performance.now();

        // Store source buffer (for high-res crop extraction)
        this.sourceBuffer = labPixels;
        this.sourceWidth = width;
        this.sourceHeight = height;

        // Store ACTUAL document dimensions for Navigator Map
        this.actualDocWidth = config.actualDocumentWidth || width;
        this.actualDocHeight = config.actualDocumentHeight || height;

        // Use pre-computed palette and colorIndices (SAME as main pipeline)
        const labPalette = separationResult.paletteLab;
        const rgbPalette = separationResult.rgbPalette;
        const colorIndices = separationResult.colorIndices;

        // Generate masks from pre-computed colorIndices
        const masks = [];
        for (let i = 0; i < labPalette.length; i++) {
            const mask = SeparationEngine.generateLayerMask(colorIndices, i, width, height);
            masks.push(mask);
        }

        // Cache separation state (matches main pipeline exactly)
        this.separationState = {
            palette: labPalette,
            rgbPalette: rgbPalette,
            colorIndices: colorIndices,
            masks: masks,
            width: width,
            height: height,
            statistics: {}
        };

        // Store metadata
        this.sourceMetadata = {
            originalWidth: width,
            originalHeight: height,
            bitDepth: config.bitDepth || 16
        };

        // Center viewport initially
        this.centerViewport();

        const elapsed = performance.now() - startTime;

        return {
            palette: this.separationState.palette,
            rgbPalette: this.separationState.rgbPalette,
            statistics: this.separationState.statistics,
            dimensions: { width, height },
            viewportX: this.viewportX,
            viewportY: this.viewportY,
            viewMode: this.viewMode,
            elapsedMs: elapsed
        };
    }

    /**
     * Initialize from full-resolution source image (LEGACY)
     * Performs full posterization/separation ONCE - may produce different palette than main pipeline!
     * Prefer initializeWithSeparation() for Navigator Map accuracy.
     *
     * @param {Uint16Array} labPixels - Full-res 16-bit LAB data
     * @param {number} width - Source width
     * @param {number} height - Source height
     * @param {Object} config - Posterization config
     * @returns {Promise<Object>} Initial state
     */
    async initialize(labPixels, width, height, config) {
        const startTime = performance.now();

        // Store source buffer (may be downsampled preview)
        this.sourceBuffer = labPixels;
        this.sourceWidth = width;
        this.sourceHeight = height;

        // Store ACTUAL document dimensions for Navigator Map
        this.actualDocWidth = config.actualDocumentWidth || width;
        this.actualDocHeight = config.actualDocumentHeight || height;

        // 1. Run posterization on FULL resolution
        const posterizeResult = await PosterizationEngine.posterize(
            labPixels,
            width,
            height,
            config.targetColors,
            config
        );


        // 2. Run separation - get color indices for FULL image
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            labPixels,
            posterizeResult.paletteLab,
            null,  // onProgress
            width,
            height,
            {
                ditherType: config.ditherType || 'none',
                distanceMetric: config.distanceMetric || 'cie76'
            }
        );

        // 3. Generate masks from color indices
        const masks = [];
        for (let i = 0; i < posterizeResult.paletteLab.length; i++) {
            const mask = SeparationEngine.generateLayerMask(colorIndices, i, width, height);
            masks.push(mask);
        }

        // 4. Log palette data for debugging

        // 5. Ensure RGB palette is properly converted from Lab
        let rgbPalette;
        if (posterizeResult.palette && posterizeResult.palette.length > 0) {
            const firstColor = posterizeResult.palette[0];
            // Check if it's already RGB (has .r property) or Lab (has .L property)
            if ('r' in firstColor) {
                // Already RGB, use as-is
                rgbPalette = posterizeResult.palette;
            } else if ('L' in firstColor) {
                // Contains Lab values, convert to RGB
                rgbPalette = posterizeResult.palette.map(lab => ColorSpace.labToRgb(lab));
            } else {
                // Unknown format, convert from paletteLab as fallback
                rgbPalette = posterizeResult.paletteLab.map(lab => ColorSpace.labToRgb(lab));
            }
        } else {
            // No RGB palette provided, convert from Lab palette
            rgbPalette = posterizeResult.paletteLab.map(lab => ColorSpace.labToRgb(lab));
        }


        // 6. Cache full separation state
        this.separationState = {
            palette: posterizeResult.paletteLab,
            rgbPalette: rgbPalette,
            colorIndices: colorIndices,
            masks: masks,
            width: width,
            height: height,
            statistics: posterizeResult.statistics || {}
        };

        // 6. Store metadata
        this.sourceMetadata = {
            originalWidth: width,
            originalHeight: height,
            dna: posterizeResult.dna,
            bitDepth: config.bitDepth || 16
        };

        // 6. Center viewport initially
        this.centerViewport();

        const elapsed = performance.now() - startTime;

        // Return initial fit-mode view (entire image downsampled)
        return {
            palette: this.separationState.palette,
            rgbPalette: this.separationState.rgbPalette,
            statistics: this.separationState.statistics,
            dimensions: { width, height },
            viewportX: this.viewportX,
            viewportY: this.viewportY,
            viewMode: this.viewMode,
            elapsedMs: elapsed
        };
    }

    /**
     * Extract and process high-res crop at current viewport position
     * Applies mechanical knobs to crop only
     *
     * @param {Object} mechanicalParams - { minVolume, speckleRescue, shadowClamp }
     * @returns {Promise<Object>} Crop preview data
     */
    async extractCrop(mechanicalParams = {}) {
        if (!this.separationState) {
            throw new Error('CropEngine not initialized');
        }

        const startTime = performance.now();

        // Calculate crop bounds (constrained to image)
        const cropWidth = Math.min(this.viewportWidth, this.sourceWidth - this.viewportX);
        const cropHeight = Math.min(this.viewportHeight, this.sourceHeight - this.viewportY);


        // Extract crop from full-res color indices
        const cropIndices = this._extractCropIndices(
            this.separationState.colorIndices,
            this.viewportX,
            this.viewportY,
            cropWidth,
            cropHeight
        );

        // Extract crop from masks
        const cropMasks = this._extractCropMasks(
            this.separationState.masks,
            this.viewportX,
            this.viewportY,
            cropWidth,
            cropHeight
        );

        // Apply mechanical knobs to crop
        let processedIndices = cropIndices;
        let processedMasks = cropMasks;

        if (mechanicalParams.minVolume > 0) {
            processedIndices = await this._applyMinVolumeToCrop(
                cropIndices,
                mechanicalParams.minVolume,
                cropWidth,
                cropHeight
            );
        }

        if (mechanicalParams.speckleRescue > 0) {
            processedMasks = await this._applySpeckleRescueToCrop(
                processedMasks,
                mechanicalParams.speckleRescue,
                cropWidth,
                cropHeight
            );
        }

        if (mechanicalParams.shadowClamp > 0) {
            processedMasks = await this._applyShadowClampToCrop(
                processedMasks,
                mechanicalParams.shadowClamp
            );
        }

        // Generate preview from processed crop
        const previewBuffer = this._generateCropPreview(
            processedIndices,
            processedMasks,
            this.separationState.rgbPalette,
            cropWidth,
            cropHeight
        );

        const elapsed = performance.now() - startTime;

        return {
            previewBuffer,
            cropX: this.viewportX,
            cropY: this.viewportY,
            cropWidth,
            cropHeight,
            elapsedMs: elapsed
        };
    }

    /**
     * Pan viewport to new position
     * @param {number} deltaX - Horizontal movement
     * @param {number} deltaY - Vertical movement
     */
    panViewport(deltaX, deltaY) {
        // Constrain to image bounds
        this.viewportX = Math.max(0, Math.min(
            this.sourceWidth - this.viewportWidth,
            this.viewportX + deltaX
        ));

        this.viewportY = Math.max(0, Math.min(
            this.sourceHeight - this.viewportHeight,
            this.viewportY + deltaY
        ));

    }

    /**
     * Jump viewport to specific coordinates (from Navigator Map click)
     * @param {number} x - Target X coordinate
     * @param {number} y - Target Y coordinate
     */
    jumpToPosition(x, y) {
        // Center viewport on clicked position
        this.viewportX = Math.max(0, Math.min(
            this.sourceWidth - this.viewportWidth,
            x - this.viewportWidth / 2
        ));

        this.viewportY = Math.max(0, Math.min(
            this.sourceHeight - this.viewportHeight,
            y - this.viewportHeight / 2
        ));

    }

    /**
     * Center viewport on image
     */
    centerViewport() {
        this.viewportX = Math.max(0, Math.floor((this.sourceWidth - this.viewportWidth) / 2));
        this.viewportY = Math.max(0, Math.floor((this.sourceHeight - this.viewportHeight) / 2));
    }

    /**
     * Toggle between 1:1 and fit modes
     */
    toggleViewMode() {
        this.viewMode = this.viewMode === '1:1' ? 'fit' : '1:1';
        return this.viewMode;
    }

    /**
     * Get navigator map data (downsampled thumbnail for overview)
     * @returns {Object} { thumbnailBuffer, thumbnailWidth, thumbnailHeight, viewportBounds }
     */
    getNavigatorMap(thumbnailSize = 200) {

        // Calculate scale based on ACTUAL document dimensions
        const scale = Math.min(thumbnailSize / this.actualDocWidth, thumbnailSize / this.actualDocHeight);
        const thumbWidth = Math.round(this.actualDocWidth * scale);
        const thumbHeight = Math.round(this.actualDocHeight * scale);


        // Generate thumbnail from color indices (using source buffer dimensions)
        const thumbnailBuffer = this._downsampleColorIndices(
            this.separationState.colorIndices,
            this.sourceWidth,
            this.sourceHeight,
            thumbWidth,
            thumbHeight
        );

        // Calculate viewport bounding box in thumbnail coordinates (relative to actual document)
        const viewportBounds = {
            x: Math.round(this.viewportX * scale),
            y: Math.round(this.viewportY * scale),
            width: Math.round(this.viewportWidth * scale),
            height: Math.round(this.viewportHeight * scale)
        };


        return {
            thumbnailBuffer,
            thumbnailWidth: thumbWidth,
            thumbnailHeight: thumbHeight,
            viewportBounds
        };
    }

    // ============================================================================
    // PRIVATE METHODS - Crop Extraction
    // ============================================================================

    /**
     * Extracts a specific window from the single-channel color indices.
     * Note: colorIndices is [height * width], NOT interleaved like LAB source.
     */
    _extractCropIndices(colorIndices, x, y, cropWidth, cropHeight) {
        const cropIndices = new Uint8Array(cropWidth * cropHeight);

        for (let dy = 0; dy < cropHeight; dy++) {
            // Source row start: Absolute Y + current Delta Y
            const srcRowStart = (y + dy) * this.sourceWidth;
            // Target row start: Current Delta Y
            const dstRowStart = dy * cropWidth;

            for (let dx = 0; dx < cropWidth; dx++) {
                // Single-channel index: No * 3 multiplier here
                cropIndices[dstRowStart + dx] = colorIndices[srcRowStart + (x + dx)];
            }
        }

        return cropIndices;
    }

    /**
     * Extracts a specific window from the single-channel layer masks.
     * Note: Masks are [height * width], unlike the interleaved LAB source [height * width * 3].
     */
    _extractCropMasks(masks, x, y, cropWidth, cropHeight) {
        const cropMasks = [];

        for (let colorIdx = 0; colorIdx < masks.length; colorIdx++) {
            const sourceMask = masks[colorIdx];
            // Uint8ClampedArray is correct for 0-255 mask data
            const cropMask = new Uint8ClampedArray(cropWidth * cropHeight);

            for (let dy = 0; dy < cropHeight; dy++) {
                // Source row start: Absolute Y + current Delta Y
                const srcRowStart = (y + dy) * this.sourceWidth;
                // Target row start: Current Delta Y
                const dstRowStart = dy * cropWidth;

                for (let dx = 0; dx < cropWidth; dx++) {
                    // Single-channel index: No * 3 multiplier here
                    const srcIdx = srcRowStart + (x + dx);
                    const dstIdx = dstRowStart + dx;

                    cropMask[dstIdx] = sourceMask[srcIdx];
                }
            }

            cropMasks.push(cropMask);
        }

        return cropMasks;
    }

    // ============================================================================
    // PRIVATE METHODS - Mechanical Knobs (Applied to Crop)
    // ============================================================================

    async _applyMinVolumeToCrop(cropIndices, minVolumePercent, width, height) {
        // Count pixels per color in crop
        const colorCounts = new Array(this.separationState.palette.length).fill(0);
        for (let i = 0; i < cropIndices.length; i++) {
            colorCounts[cropIndices[i]]++;
        }

        // Calculate threshold
        const totalPixels = width * height;
        const minPixels = Math.round(totalPixels * minVolumePercent / 100);

        // Identify weak colors
        const weakIndices = [];
        colorCounts.forEach((count, idx) => {
            if (count < minPixels && count > 0) {
                weakIndices.push(idx);
            }
        });

        if (weakIndices.length === 0) {
            return cropIndices;
        }


        // Remap weak colors to nearest strong colors
        const newCropIndices = new Uint8Array(cropIndices.length);
        for (let i = 0; i < cropIndices.length; i++) {
            const currentColor = cropIndices[i];

            if (weakIndices.includes(currentColor)) {
                // Find nearest strong color
                let minDist = Infinity;
                let nearestStrong = 0;

                for (let strongIdx = 0; strongIdx < this.separationState.palette.length; strongIdx++) {
                    if (!weakIndices.includes(strongIdx)) {
                        const dist = this._labDistance(
                            this.separationState.palette[currentColor],
                            this.separationState.palette[strongIdx]
                        );

                        if (dist < minDist) {
                            minDist = dist;
                            nearestStrong = strongIdx;
                        }
                    }
                }

                newCropIndices[i] = nearestStrong;
            } else {
                newCropIndices[i] = currentColor;
            }
        }

        return newCropIndices;
    }

    async _applySpeckleRescueToCrop(cropMasks, radiusPixels, width, height) {
        // Apply morphological erosion to masks
        const erodedMasks = [];

        for (let colorIdx = 0; colorIdx < cropMasks.length; colorIdx++) {
            const mask = cropMasks[colorIdx];
            const eroded = this._erodeMask(mask, width, height, radiusPixels);
            erodedMasks.push(eroded);
        }


        return erodedMasks;
    }

    async _applyShadowClampToCrop(cropMasks, clampPercent) {
        // Clamp mask values below threshold
        const clampValue = Math.round(clampPercent * 255 / 100);
        const clampedMasks = [];

        for (let colorIdx = 0; colorIdx < cropMasks.length; colorIdx++) {
            const mask = cropMasks[colorIdx];
            const clamped = new Uint8ClampedArray(mask.length);

            for (let i = 0; i < mask.length; i++) {
                const val = mask[i];
                if (val > 0 && val < clampValue) {
                    clamped[i] = clampValue;
                } else {
                    clamped[i] = val;
                }
            }

            clampedMasks.push(clamped);
        }


        return clampedMasks;
    }

    // ============================================================================
    // PRIVATE METHODS - Preview Generation
    // ============================================================================

    /**
     * Generates an RGBA preview buffer for the extracted crop.
     * Optimized for real-time 1:1 scrubbing with Winner-Take-All rendering.
     *
     * Performance: O(N) instead of O(N×Colors) - ~90% faster for 10-color separations
     *
     * @param {Uint8Array} cropIndices - Color index per pixel (winner-take-all)
     * @param {Array<Uint8ClampedArray>} cropMasks - Mask per color (for alpha)
     * @param {Array<Object>} rgbPalette - RGB colors [{r, g, b}, ...]
     * @param {number} width - Crop width
     * @param {number} height - Crop height
     * @returns {Uint8ClampedArray} RGBA buffer for display
     */
    _generateCropPreview(cropIndices, cropMasks, rgbPalette, width, height) {
        const pixelCount = width * height;
        // Standard 4-byte RGBA buffer for display
        const previewBuffer = new Uint8ClampedArray(pixelCount * 4);

        for (let i = 0; i < pixelCount; i++) {
            const colorIdx = cropIndices[i];
            const color = rgbPalette[colorIdx];
            const dstIdx = i * 4;

            // Core RGB Assignment (direct index lookup)
            previewBuffer[dstIdx] = color.r;
            previewBuffer[dstIdx + 1] = color.g;
            previewBuffer[dstIdx + 2] = color.b;

            // Alpha Logic:
            // Use the mask value for the specific color index to determine opacity.
            // This ensures shadowClamp and speckleRescue results are visible!
            if (cropMasks && cropMasks[colorIdx]) {
                previewBuffer[dstIdx + 3] = cropMasks[colorIdx][i];
            } else {
                previewBuffer[dstIdx + 3] = 255; // Opaque fallback
            }
        }

        return previewBuffer;
    }

    _downsampleColorIndices(colorIndices, srcWidth, srcHeight, dstWidth, dstHeight) {
        const scale = srcWidth / dstWidth;
        const thumbnailIndices = new Uint8Array(dstWidth * dstHeight);

        // Nearest neighbor downsampling (fast for thumbnail)
        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                const srcX = Math.floor(x * scale);
                const srcY = Math.floor(y * scale);
                const srcIdx = srcY * srcWidth + srcX;
                const dstIdx = y * dstWidth + x;
                thumbnailIndices[dstIdx] = colorIndices[srcIdx];
            }
        }

        // Convert to RGBA preview
        const thumbnailBuffer = new Uint8ClampedArray(dstWidth * dstHeight * 4);

        // Debug: Log palette info (once)

        for (let i = 0; i < thumbnailIndices.length; i++) {
            const colorIdx = thumbnailIndices[i];
            const color = this.separationState.rgbPalette[colorIdx];

            const idx = i * 4;

            // Defensive: Handle undefined color
            if (!color) {
                console.error(`[CropEngine._downsampleColorIndices] Color at index ${colorIdx} is undefined!`);
                thumbnailBuffer[idx] = 255;      // White fallback
                thumbnailBuffer[idx + 1] = 255;
                thumbnailBuffer[idx + 2] = 255;
                thumbnailBuffer[idx + 3] = 255;
                continue;
            }

            thumbnailBuffer[idx] = color.r || 0;
            thumbnailBuffer[idx + 1] = color.g || 0;
            thumbnailBuffer[idx + 2] = color.b || 0;
            thumbnailBuffer[idx + 3] = 255;
        }

        return thumbnailBuffer;
    }

    // ============================================================================
    // PRIVATE METHODS - Utilities
    // ============================================================================

    _labDistance(lab1, lab2) {
        const dL = lab1.L - lab2.L;
        const da = lab1.a - lab2.a;
        const db = lab1.b - lab2.b;
        return Math.sqrt(dL * dL + da * da + db * db);
    }

    _erodeMask(mask, width, height, radius) {
        if (radius === 0) return mask;

        const eroded = new Uint8ClampedArray(mask.length);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;

                if (mask[idx] === 0) {
                    eroded[idx] = 0;
                    continue;
                }

                // Check if all neighbors within radius are non-zero
                let allNeighborsActive = true;

                for (let dy = -radius; dy <= radius && allNeighborsActive; dy++) {
                    for (let dx = -radius; dx <= radius && allNeighborsActive; dx++) {
                        const ny = y + dy;
                        const nx = x + dx;

                        if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
                            const nIdx = ny * width + nx;
                            if (mask[nIdx] === 0) {
                                allNeighborsActive = false;
                            }
                        }
                    }
                }

                eroded[idx] = allNeighborsActive ? mask[idx] : 0;
            }
        }

        return eroded;
    }

    getProductionConfig() {
        return {
            ...this.sourceMetadata,
            palette: this.separationState.palette,
            targetColors: this.separationState.palette.length
        };
    }
}

module.exports = CropEngine;
