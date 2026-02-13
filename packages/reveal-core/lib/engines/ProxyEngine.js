/**
 * ProxyEngine - Low-resolution proxy for real-time parameter updates
 *
 * Maintains a 512px "digital twin" for <30ms response time during UI scrubbing.
 * Architecture:
 * - Fixed 512px resolution (long edge)
 * - 16-bit LAB buffer (maintains full tonal range)
 * - Bilinear downsampling from source
 * - State persistence: holds current separation state in memory
 * - Incremental updates: re-runs only affected steps
 *
 * @module ProxyEngine
 */

const PosterizationEngine = require('./PosterizationEngine');
const SeparationEngine = require('./SeparationEngine');
const PreviewEngine = require('./PreviewEngine');

class ProxyEngine {
    static PROXY_SIZE = 512; // Fixed resolution for long edge

    constructor() {
        this.proxyBuffer = null;        // 512px 16-bit LAB buffer
        this.separationState = null;    // Cached palette + indices + masks (may be mutated by knobs)
        this._baselineState = null;     // Clean snapshot from last posterize (never mutated by knobs)
        this.sourceMetadata = null;     // Original dimensions, DNA
    }

    /**
     * Initialize proxy from source image
     * @param {Uint16Array} labPixels - Source 16-bit LAB data
     * @param {number} width - Source width
     * @param {number} height - Source height
     * @param {Object} initialConfig - Posterization config
     * @returns {Promise<Object>} Proxy state
     */
    async initializeProxy(labPixels, width, height, initialConfig) {
        const startTime = performance.now();

        // 1. Bilinear downsample to 512px
        const { buffer: proxyBuffer, width: proxyW, height: proxyH } =
            this._downsampleBilinear(labPixels, width, height);

        this.proxyBuffer = proxyBuffer;

        // Proxy-safe config:
        // - format: 'lab' — CRITICAL: input is 16-bit Lab, not RGB
        // - Disable aggressive merging that collapses palette at 512px
        const proxyConfig = {
            ...initialConfig,
            format: 'lab',
            snapThreshold: 0,
            enablePaletteReduction: false,
            densityFloor: 0,
            preservedUnifyThreshold: 0.5
        };

        // 2. Run initial posterization (full pipeline)
        const posterizeResult = await PosterizationEngine.posterize(
            proxyBuffer,
            proxyW,
            proxyH,
            proxyConfig.targetColors,
            proxyConfig
        );


        // 3. Run separation - get color indices
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            proxyBuffer,                // rawBytes
            posterizeResult.paletteLab, // labPalette
            null,                       // onProgress
            proxyW,                     // width
            proxyH,                     // height
            {
                ditherType: initialConfig.ditherType || 'none',
                distanceMetric: initialConfig.distanceMetric || 'cie76'
            }
        );

        // 4. Generate masks from color indices
        const masks = [];
        for (let i = 0; i < posterizeResult.paletteLab.length; i++) {
            const mask = SeparationEngine.generateLayerMask(colorIndices, i, proxyW, proxyH);
            masks.push(mask);
        }

        // 5. Cache separation state
        this.separationState = {
            palette: posterizeResult.paletteLab,
            rgbPalette: posterizeResult.palette,
            colorIndices: colorIndices,
            masks: masks,
            width: proxyW,
            height: proxyH,
            statistics: posterizeResult.statistics || {}
        };

        // Snapshot baseline so mechanical knobs can restore from clean state
        this._snapshotBaseline();

        // 5. Store source metadata
        this.sourceMetadata = {
            originalWidth: width,
            originalHeight: height,
            dna: posterizeResult.dna,
            bitDepth: initialConfig.bitDepth || 16
        };

        // 6. Generate initial preview from color indices
        const previewBuffer = this._generatePreviewFromIndices(
            this.separationState.colorIndices,
            this.separationState.rgbPalette,
            proxyW,
            proxyH
        );

        const elapsed = performance.now() - startTime;

        return {
            previewBuffer,
            palette: this.separationState.palette,
            dimensions: { width: proxyW, height: proxyH },
            statistics: this.separationState.statistics,
            elapsedMs: elapsed
        };
    }

    /**
     * Re-posterize the existing proxyBuffer with a new config.
     * Skips downsampling — uses the stored 512px buffer directly.
     * Used for archetype swaps where the source pixels haven't changed.
     *
     * @param {Object} config - New posterization config
     * @returns {Promise<Object>} Updated proxy state
     */
    async rePosterize(config) {
        if (!this.proxyBuffer || !this.separationState) {
            throw new Error('Proxy not initialized — call initializeProxy first');
        }

        const startTime = performance.now();
        const proxyW = this.separationState.width;
        const proxyH = this.separationState.height;

        // Proxy-safe config:
        // - format: 'lab' — CRITICAL: input is 16-bit Lab, not RGB
        // - Disable aggressive merging that collapses palette at 512px
        const proxyConfig = {
            ...config,
            format: 'lab',
            snapThreshold: 0,
            enablePaletteReduction: false,
            densityFloor: 0,
            preservedUnifyThreshold: 0.5
        };

        // 1. Posterize existing proxyBuffer with proxy-safe config
        const posterizeResult = await PosterizationEngine.posterize(
            this.proxyBuffer,
            proxyW,
            proxyH,
            proxyConfig.targetColors,
            proxyConfig
        );

        // 2. Separation
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            this.proxyBuffer,
            posterizeResult.paletteLab,
            null,
            proxyW,
            proxyH,
            {
                ditherType: config.ditherType || 'none',
                distanceMetric: config.distanceMetric || 'cie76'
            }
        );

        // 3. Masks
        const masks = [];
        for (let i = 0; i < posterizeResult.paletteLab.length; i++) {
            masks.push(SeparationEngine.generateLayerMask(colorIndices, i, proxyW, proxyH));
        }

        // 4. Update cached state (proxyBuffer unchanged)
        this.separationState = {
            palette: posterizeResult.paletteLab,
            rgbPalette: posterizeResult.palette,
            colorIndices,
            masks,
            width: proxyW,
            height: proxyH,
            statistics: posterizeResult.statistics || {}
        };

        // Snapshot baseline so mechanical knobs can restore from clean state
        this._snapshotBaseline();

        // 5. Generate preview
        const previewBuffer = this._generatePreviewFromIndices(
            colorIndices,
            posterizeResult.palette,
            proxyW,
            proxyH
        );

        const elapsed = performance.now() - startTime;

        return {
            previewBuffer,
            palette: this.separationState.palette,
            dimensions: { width: proxyW, height: proxyH },
            statistics: this.separationState.statistics,
            elapsedMs: elapsed
        };
    }

    /**
     * Update proxy with new parameters (FAST PATH)
     *
     * Restores from baseline before applying knobs so that changes are
     * always relative to the clean posterization output — not accumulated
     * on top of previous knob mutations. This makes slider changes fully
     * reversible.
     *
     * @param {Object} paramChanges - Only changed parameters
     * @returns {Promise<Object>} Updated preview data
     */
    async updateProxy(paramChanges) {
        if (!this.separationState) {
            throw new Error('Proxy not initialized');
        }

        const startTime = performance.now();

        // Restore clean baseline before applying any knobs.
        // Without this, knob effects accumulate destructively
        // (e.g. pruned colors can never come back).
        if (this._baselineState) {
            this._restoreFromBaseline();
        }

        // Apply knobs on top of clean baseline
        if ('minVolume' in paramChanges) {
            await this._applyMinVolume(paramChanges.minVolume);
        }

        if ('speckleRescue' in paramChanges) {
            await this._applySpeckleRescue(paramChanges.speckleRescue);
        }

        if ('shadowClamp' in paramChanges) {
            await this._applyShadowClamp(paramChanges.shadowClamp);
        }

        if ('paletteOverride' in paramChanges) {
            this.separationState.palette = paramChanges.paletteOverride;
            // Re-run separation with new palette
            await this._recomputeSeparation();
        }

        // Generate updated preview from color indices
        const previewBuffer = this._generatePreviewFromIndices(
            this.separationState.colorIndices,
            this.separationState.rgbPalette,
            this.separationState.width,
            this.separationState.height
        );

        const elapsed = performance.now() - startTime;

        return {
            previewBuffer,
            palette: this.separationState.palette,
            statistics: this.separationState.statistics,
            elapsedMs: elapsed
        };
    }

    /**
     * Get full-res parameters for production render
     * @returns {Object} Parameters for high-res posterization
     */
    getProductionConfig() {
        return {
            ...this.sourceMetadata,
            palette: this.separationState.palette,
            targetColors: this.separationState.palette.length
        };
    }

    /**
     * Deep-copy current separationState as the clean baseline.
     * Called after initializeProxy and rePosterize — never after knob application.
     * @private
     */
    _snapshotBaseline() {
        const s = this.separationState;
        this._baselineState = {
            palette: s.palette.map(c => ({ ...c })),
            rgbPalette: s.rgbPalette ? s.rgbPalette.map(c =>
                typeof c === 'string' ? c : { ...c }
            ) : null,
            colorIndices: new Uint8Array(s.colorIndices),
            masks: s.masks.map(m => new Uint8Array(m)),
            width: s.width,
            height: s.height,
            statistics: { ...s.statistics }
        };
    }

    /**
     * Restore separationState from the clean baseline snapshot.
     * @private
     */
    _restoreFromBaseline() {
        const b = this._baselineState;
        this.separationState = {
            palette: b.palette.map(c => ({ ...c })),
            rgbPalette: b.rgbPalette ? b.rgbPalette.map(c =>
                typeof c === 'string' ? c : { ...c }
            ) : null,
            colorIndices: new Uint8Array(b.colorIndices),
            masks: b.masks.map(m => new Uint8Array(m)),
            width: b.width,
            height: b.height,
            statistics: { ...b.statistics }
        };
    }

    /**
     * Bilinear downsample to 512px (long edge)
     * @private
     */
    _downsampleBilinear(labPixels, srcWidth, srcHeight) {
        // Calculate target dimensions (512px on long edge)
        const longEdge = Math.max(srcWidth, srcHeight);
        const scale = ProxyEngine.PROXY_SIZE / longEdge;

        const dstWidth = Math.round(srcWidth * scale);
        const dstHeight = Math.round(srcHeight * scale);

        const dstBuffer = new Uint16Array(dstWidth * dstHeight * 3);

        // Bilinear interpolation
        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                const srcX = x / scale;
                const srcY = y / scale;

                const x0 = Math.floor(srcX);
                const y0 = Math.floor(srcY);
                const x1 = Math.min(x0 + 1, srcWidth - 1);
                const y1 = Math.min(y0 + 1, srcHeight - 1);

                const fx = srcX - x0;
                const fy = srcY - y0;

                // Interpolate L, a, b channels
                for (let c = 0; c < 3; c++) {
                    const v00 = labPixels[(y0 * srcWidth + x0) * 3 + c];
                    const v10 = labPixels[(y0 * srcWidth + x1) * 3 + c];
                    const v01 = labPixels[(y1 * srcWidth + x0) * 3 + c];
                    const v11 = labPixels[(y1 * srcWidth + x1) * 3 + c];

                    const v0 = v00 * (1 - fx) + v10 * fx;
                    const v1 = v01 * (1 - fx) + v11 * fx;
                    const v = v0 * (1 - fy) + v1 * fy;

                    dstBuffer[(y * dstWidth + x) * 3 + c] = Math.round(v);
                }
            }
        }

        return {
            buffer: dstBuffer,
            width: dstWidth,
            height: dstHeight
        };
    }

    /**
     * Apply minVolume pruning (palette reduction)
     * @private
     */
    async _applyMinVolume(minVolumePercent) {
        const totalPixels = this.separationState.width * this.separationState.height;
        const minPixels = Math.round(totalPixels * minVolumePercent / 100);

        // Count pixels per color
        const colorCounts = new Array(this.separationState.palette.length).fill(0);
        for (let i = 0; i < this.separationState.colorIndices.length; i++) {
            colorCounts[this.separationState.colorIndices[i]]++;
        }

        // Identify colors below threshold
        const weakIndices = [];
        colorCounts.forEach((count, idx) => {
            if (count < minPixels && count > 0) {
                weakIndices.push(idx);
            }
        });

        if (weakIndices.length === 0) {
            return;
        }


        // Remap weak colors to nearest strong colors
        const strongIndices = [];
        for (let i = 0; i < this.separationState.palette.length; i++) {
            if (!weakIndices.includes(i) && colorCounts[i] > 0) {
                strongIndices.push(i);
            }
        }

        // Build remapping table
        const remapTable = new Array(this.separationState.palette.length);
        for (let i = 0; i < remapTable.length; i++) {
            remapTable[i] = i; // Identity by default
        }

        // Remap weak to nearest strong
        for (const weakIdx of weakIndices) {
            const weakColor = this.separationState.palette[weakIdx];
            let nearestStrongIdx = strongIndices[0];
            let minDist = Infinity;

            for (const strongIdx of strongIndices) {
                const strongColor = this.separationState.palette[strongIdx];
                const dL = weakColor.L - strongColor.L;
                const da = weakColor.a - strongColor.a;
                const db = weakColor.b - strongColor.b;
                const dist = Math.sqrt(dL * dL + da * da + db * db);

                if (dist < minDist) {
                    minDist = dist;
                    nearestStrongIdx = strongIdx;
                }
            }

            remapTable[weakIdx] = nearestStrongIdx;
        }

        // Apply remapping to color indices
        for (let i = 0; i < this.separationState.colorIndices.length; i++) {
            const oldIdx = this.separationState.colorIndices[i];
            this.separationState.colorIndices[i] = remapTable[oldIdx];
        }

        // Rebuild palette (remove weak colors)
        const newPalette = [];
        const newRgbPalette = [];
        const indexMapping = new Map();

        for (let i = 0; i < this.separationState.palette.length; i++) {
            if (!weakIndices.includes(i)) {
                indexMapping.set(i, newPalette.length);
                newPalette.push(this.separationState.palette[i]);
                if (this.separationState.rgbPalette) {
                    newRgbPalette.push(this.separationState.rgbPalette[i]);
                }
            }
        }

        // Remap color indices to new palette
        for (let i = 0; i < this.separationState.colorIndices.length; i++) {
            const oldIdx = this.separationState.colorIndices[i];
            this.separationState.colorIndices[i] = indexMapping.get(oldIdx);
        }

        this.separationState.palette = newPalette;
        this.separationState.rgbPalette = newRgbPalette;

        // Rebuild masks
        await this._rebuildMasks();

    }

    /**
     * Apply speckle rescue (morphological erosion)
     * @private
     */
    async _applySpeckleRescue(radiusPixels) {
        if (radiusPixels === 0) {
            return;
        }


        const { width, height } = this.separationState;

        // Apply erosion to each mask
        for (let colorIdx = 0; colorIdx < this.separationState.masks.length; colorIdx++) {
            const mask = this.separationState.masks[colorIdx];
            const eroded = this._erodeMask(mask, width, height, radiusPixels);
            this.separationState.masks[colorIdx] = eroded;
        }

    }

    /**
     * Apply shadow clamp (minimum ink density)
     * @private
     */
    async _applyShadowClamp(clampPercent) {
        if (clampPercent === 0) {
            return;
        }

        const clampValue = Math.round(clampPercent * 255 / 100);


        // Clamp mask values below threshold to threshold
        this.separationState.masks.forEach(mask => {
            for (let i = 0; i < mask.length; i++) {
                const val = mask[i];
                if (val > 0 && val < clampValue) {
                    mask[i] = clampValue;
                }
            }
        });

    }

    /**
     * Re-run separation with updated palette
     * @private
     */
    async _recomputeSeparation() {

        // Get new color indices
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            this.proxyBuffer,
            this.separationState.palette,
            null,
            this.separationState.width,
            this.separationState.height,
            { ditherType: 'none', distanceMetric: 'cie76' }
        );

        // Generate new masks
        const masks = [];
        for (let i = 0; i < this.separationState.palette.length; i++) {
            const mask = SeparationEngine.generateLayerMask(
                colorIndices,
                i,
                this.separationState.width,
                this.separationState.height
            );
            masks.push(mask);
        }

        this.separationState.colorIndices = colorIndices;
        this.separationState.masks = masks;

    }

    /**
     * Rebuild masks from color indices
     * @private
     */
    async _rebuildMasks() {
        const { width, height, colorIndices, palette } = this.separationState;
        const numColors = palette.length;
        const totalPixels = width * height;

        // Create new masks
        const masks = [];
        for (let i = 0; i < numColors; i++) {
            masks.push(new Uint8Array(totalPixels));
        }

        // Populate masks
        for (let i = 0; i < totalPixels; i++) {
            const colorIdx = colorIndices[i];
            masks[colorIdx][i] = 255;
        }

        this.separationState.masks = masks;
    }

    /**
     * Erode mask using simple box kernel
     * @private
     */
    _erodeMask(mask, width, height, radius) {
        const eroded = new Uint8Array(mask.length);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;

                if (mask[idx] === 0) {
                    eroded[idx] = 0;
                    continue;
                }

                // Check if all neighbors within radius are non-zero
                let allNeighborsSet = true;

                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;

                        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                            allNeighborsSet = false;
                            break;
                        }

                        const nIdx = ny * width + nx;
                        if (mask[nIdx] === 0) {
                            allNeighborsSet = false;
                            break;
                        }
                    }
                    if (!allNeighborsSet) break;
                }

                eroded[idx] = allNeighborsSet ? 255 : 0;
            }
        }

        return eroded;
    }

    /**
     * Generate RGBA preview buffer from color indices
     * @private
     */
    _generatePreviewFromIndices(colorIndices, rgbPalette, width, height) {
        if (!rgbPalette || !colorIndices) {
            throw new Error('Missing rgbPalette or colorIndices');
        }

        const pixelCount = width * height;
        const previewBuffer = new Uint8ClampedArray(pixelCount * 4);

        for (let i = 0; i < pixelCount; i++) {
            const colorIdx = colorIndices[i];

            if (colorIdx >= rgbPalette.length) {
                console.error(`[ProxyEngine] Color index ${colorIdx} out of bounds (palette size: ${rgbPalette.length})`);
                continue;
            }

            const colorEntry = rgbPalette[colorIdx];

            if (!colorEntry) {
                console.error(`[ProxyEngine] Undefined color at index ${colorIdx}`);
                continue;
            }

            // Handle both hex strings and {r, g, b} objects
            let color;
            if (typeof colorEntry === 'string') {
                // It's a hex string, convert it
                color = this._hexToRgb(colorEntry);
            } else {
                // It's already an {r, g, b} object
                color = colorEntry;
            }

            const idx = i * 4;
            previewBuffer[idx] = color.r;
            previewBuffer[idx + 1] = color.g;
            previewBuffer[idx + 2] = color.b;
            previewBuffer[idx + 3] = 255; // Alpha
        }

        return previewBuffer;
    }

    /**
     * Convert hex color string to RGB object
     * @private
     */
    _hexToRgb(hex) {
        // Remove # if present
        hex = hex.replace(/^#/, '');

        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);

        return { r, g, b };
    }
}

// CommonJS export
module.exports = ProxyEngine;
