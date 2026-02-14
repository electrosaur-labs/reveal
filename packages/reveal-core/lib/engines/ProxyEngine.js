/**
 * ProxyEngine - Low-resolution proxy for real-time parameter updates
 *
 * Maintains an 800px "digital twin" for fast response during UI scrubbing.
 * Architecture:
 * - Fixed 800px resolution (long edge)
 * - 16-bit LAB buffer (maintains full tonal range)
 * - Bilinear downsampling from source
 * - Bilateral filter preprocessing (matches reveal-adobe pipeline)
 * - State persistence: holds current separation state in memory
 * - Incremental updates: re-runs only affected steps
 *
 * @module ProxyEngine
 */

const PosterizationEngine = require('./PosterizationEngine');
const SeparationEngine = require('./SeparationEngine');
const PreviewEngine = require('./PreviewEngine');
const BilateralFilter = require('../preprocessing/BilateralFilter');

class ProxyEngine {
    static PROXY_SIZE = 800; // Fixed resolution for long edge

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

        // 1. Bilinear downsample to 800px
        const { buffer: proxyBuffer, width: proxyW, height: proxyH } =
            this._downsampleBilinear(labPixels, width, height);

        // 2. Bilateral filter preprocessing (matches reveal-adobe pipeline)
        const preprocessingIntensity = initialConfig.preprocessingIntensity || 'auto';
        if (preprocessingIntensity !== 'off') {
            const is16Bit = true; // ProxyEngine always uses 16-bit Lab
            const isHeavy = preprocessingIntensity === 'heavy';
            const radius = isHeavy ? 5 : 3;
            const sigmaR = is16Bit ? 5000 : 3000;
            BilateralFilter.applyBilateralFilterLab(proxyBuffer, proxyW, proxyH, radius, sigmaR);
        }

        this.proxyBuffer = proxyBuffer;

        // Proxy-safe config:
        // - format: 'lab' — CRITICAL: input is 16-bit Lab, not RGB
        // - Disable aggressive merging that collapses palette at 800px
        const proxyConfig = {
            ...initialConfig,
            format: 'lab',
            snapThreshold: 0,
            enablePaletteReduction: false,
            densityFloor: 0,
            preservedUnifyThreshold: 0.5
        };
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
            distanceMetric: initialConfig.distanceMetric || 'cie76',
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

        // 6. Generate clean preview (no knobs yet).
        // Caller (SessionState) follows up with updateProxy() to apply knobs.
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

        // Proxy-safe config (same rationale as initializeProxy)
        const proxyConfig = {
            ...config,
            format: 'lab',
            snapThreshold: 0,
            enablePaletteReduction: false,
            densityFloor: 0,
            preservedUnifyThreshold: 0.5
        };
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
            distanceMetric: config.distanceMetric || 'cie76',
            statistics: posterizeResult.statistics || {}
        };

        // Snapshot baseline so mechanical knobs can restore from clean state
        this._snapshotBaseline();

        // 5. Generate clean preview (no knobs yet).
        // Caller (SessionState) follows up with updateProxy() to apply knobs.
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

        // Restore clean baseline before applying any changes.
        // Without this, knob effects accumulate destructively
        // (e.g. pruned colors can never come back).
        if (this._baselineState) {
            this._restoreFromBaseline();
        }

        // Apply palette override — swap ink colors without re-separating.
        // In screen printing, "override" means "same plate, different ink."
        // Plate assignments (colorIndices + masks) stay fixed from baseline;
        // only the palette and rgbPalette update so the preview shows
        // the new ink color on the existing plate coverage.
        // DO NOT call _recomputeSeparation() — that would redistribute
        // every pixel to nearest color, causing cascade: swatches rearrange,
        // paper reassigns, coverage shifts, revert lands on wrong swatch.
        if ('paletteOverride' in paramChanges) {
            this.separationState.palette = paramChanges.paletteOverride;
            this.separationState.rgbPalette = paramChanges.paletteOverride.map(
                lab => PosterizationEngine.labToRgb(lab)
            );
        }

        // Apply knobs on top (may prune, despeckle, clamp)
        await this._applyKnobs(paramChanges);

        // Generate preview from masks (reflects despeckle + shadowClamp).
        // Pixels where all masks are 0 (isolated speckles removed) show as white.
        const previewBuffer = this._generatePreviewFromMasks(
            this.separationState.masks,
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
            distanceMetric: s.distanceMetric || 'cie76',
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
            distanceMetric: b.distanceMetric || 'cie76',
            statistics: { ...b.statistics }
        };
    }

    /**
     * Bilinear downsample to 800px (long edge)
     * @private
     */
    _downsampleBilinear(labPixels, srcWidth, srcHeight) {
        // Calculate target dimensions (800px on long edge)
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
     * Apply all mechanical knobs from a config/paramChanges object.
     * @private
     */
    async _applyKnobs(params) {
        if (params.minVolume !== undefined) {
            await this._applyMinVolume(params.minVolume);
        }
        if (params.speckleRescue !== undefined) {
            await this._applySpeckleRescue(params.speckleRescue);
        }
        if (params.shadowClamp !== undefined) {
            await this._applyShadowClamp(params.shadowClamp);
        }
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

        if (weakIndices.length === 0) return;

        // Remap weak colors to nearest strong colors
        const strongIndices = [];
        for (let i = 0; i < this.separationState.palette.length; i++) {
            if (!weakIndices.includes(i) && colorCounts[i] > 0) {
                strongIndices.push(i);
            }
        }

        if (strongIndices.length === 0) return;

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
                const dist = dL * dL + da * da + db * db;

                if (dist < minDist) {
                    minDist = dist;
                    nearestStrongIdx = strongIdx;
                }
            }

            remapTable[weakIdx] = nearestStrongIdx;
        }

        // Remap color indices — DON'T compact palette.
        // Palette array stays the same length with the same indices so that
        // palette overrides (keyed by baseline index) remain valid.
        // PaletteSurgeon already hides zero-coverage swatches.
        for (let i = 0; i < this.separationState.colorIndices.length; i++) {
            const oldIdx = this.separationState.colorIndices[i];
            this.separationState.colorIndices[i] = remapTable[oldIdx];
        }

        // Rebuild masks (pruned colors get all-zero masks)
        await this._rebuildMasks();
    }

    /**
     * Apply speckle rescue (connected component despeckle).
     * Removes isolated clusters smaller than threshold pixels.
     * Uses the same SeparationEngine._despeckleMask as production.
     * @private
     */
    async _applySpeckleRescue(thresholdPixels) {
        if (thresholdPixels === 0) {
            return;
        }

        const { width, height } = this.separationState;
        let threshold = Math.round(thresholdPixels);

        // Scale threshold for proxy resolution.
        // Despeckle removes connected components below a pixel-area threshold.
        // Area scales as linearScale², so linear scaling overshoots badly
        // (4px × 8 = 32px at proxy = 2048px equivalent at full-res).
        // Use sqrt(linearScale) instead — scales by perimeter dimension,
        // giving visible but non-destructive effect at proxy.
        if (this.sourceMetadata && this.sourceMetadata.originalWidth > width) {
            const linearScale = this.sourceMetadata.originalWidth / width;
            threshold = Math.round(threshold * Math.sqrt(linearScale));
        }

        for (let colorIdx = 0; colorIdx < this.separationState.masks.length; colorIdx++) {
            SeparationEngine._despeckleMask(
                this.separationState.masks[colorIdx],
                width, height, threshold
            );
        }

        // Heal orphaned pixels: despeckle zeroed out mask entries but
        // colorIndices still points to the old color, so the preview
        // falls back to the original — making despeckle invisible.
        // BFS-fill orphans from the nearest non-orphan neighbor so
        // despeckled pixels absorb into the surrounding color.
        this._healDespeckledPixels();
    }

    /**
     * BFS fill orphaned pixels (mask zeroed by despeckle) from surrounding colors.
     * O(pixelCount) — each pixel visited at most twice.
     * @private
     */
    _healDespeckledPixels() {
        const { masks, colorIndices, width, height } = this.separationState;
        const pixelCount = width * height;
        const numColors = masks.length;

        // Mark orphaned pixels (their assigned mask was zeroed)
        const isOrphan = new Uint8Array(pixelCount);
        let orphanCount = 0;

        for (let i = 0; i < pixelCount; i++) {
            const ci = colorIndices[i];
            if (ci >= numColors || masks[ci][i] === 0) {
                isOrphan[i] = 1;
                orphanCount++;
            }
        }

        if (orphanCount === 0) return;

        // Seed BFS queue with non-orphan pixels adjacent to at least one orphan
        const queue = new Uint32Array(pixelCount);
        let head = 0;
        let tail = 0;

        for (let i = 0; i < pixelCount; i++) {
            if (isOrphan[i]) continue;
            const x = i % width;
            const y = (i - x) / width;
            let adjacent = false;
            for (let dy = -1; dy <= 1 && !adjacent; dy++) {
                for (let dx = -1; dx <= 1 && !adjacent; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx, ny = y + dy;
                    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                        if (isOrphan[ny * width + nx]) adjacent = true;
                    }
                }
            }
            if (adjacent) queue[tail++] = i;
        }

        // BFS: spread non-orphan colors into orphan gaps
        while (head < tail) {
            const i = queue[head++];
            const ci = colorIndices[i];
            const x = i % width;
            const y = (i - x) / width;

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    const ni = ny * width + nx;
                    if (isOrphan[ni]) {
                        colorIndices[ni] = ci;
                        masks[ci][ni] = 255;
                        isOrphan[ni] = 0;
                        queue[tail++] = ni;
                    }
                }
            }
        }
    }

    /**
     * Apply shadow clamp as tonal-aware edge erosion.
     *
     * Binary masks (0/255) make traditional value-clamping a no-op.
     * Instead, reinterpret shadowClamp as: "pixels at thin edges below a
     * minimum local ink density can't hold on the screen mesh."
     *
     * For each mask pixel, compute the fraction of 8-connected neighbors
     * sharing the same mask. If below a per-ink threshold, zero the pixel.
     *
     * Tonal modulation: light inks (high L) are harder to hold on the
     * mesh and need more neighbor support. Dark inks (low L) grip better.
     *   - Black ink (L=0):   threshold = base × 0.5 (tolerant)
     *   - Mid ink (L=50):    threshold = base × 1.0 (normal)
     *   - Light ink (L=100): threshold = base × 1.5 (aggressive)
     *
     * shadowClamp=0%  → nothing removed
     * shadowClamp=10% → removes thin edges (light inks more aggressively)
     * shadowClamp=40% → erodes ~1-2px from all edges
     *
     * @private
     */
    async _applyShadowClamp(clampPercent) {
        if (clampPercent === 0) {
            return;
        }

        // Map 0-40% slider range onto 0-1.2 base neighbor fraction (3× scale)
        const baseThreshold = (clampPercent / 100) * 3;
        const { masks, palette, width, height } = this.separationState;

        for (let c = 0; c < masks.length; c++) {
            const mask = masks[c];

            // Tonal modulation: light inks erode more, dark inks less
            const inkL = (palette[c] && palette[c].L !== undefined) ? palette[c].L : 50;
            const lightnessBoost = inkL / 100;  // 0.0 (black) → 1.0 (white)
            const threshold = baseThreshold * (0.5 + lightnessBoost);

            const toRemove = [];

            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const i = y * width + x;
                    if (mask[i] === 0) continue;

                    let same = 0, total = 0;
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            if (dx === 0 && dy === 0) continue;
                            const nx = x + dx, ny = y + dy;
                            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                                total++;
                                if (mask[ny * width + nx] > 0) same++;
                            }
                        }
                    }

                    if (same / total < threshold) {
                        toRemove.push(i);
                    }
                }
            }

            for (const idx of toRemove) {
                mask[idx] = 0;
            }
        }

        // Heal orphaned pixels (absorb eroded edges into surrounding color)
        this._healDespeckledPixels();
    }

    /**
     * Re-run separation with updated palette
     * @private
     */
    async _recomputeSeparation() {

        // Get new color indices — use the archetype's metric (not hardcoded CIE76)
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            this.proxyBuffer,
            this.separationState.palette,
            null,
            this.separationState.width,
            this.separationState.height,
            { ditherType: 'none', distanceMetric: this.separationState.distanceMetric || 'cie76' }
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
     * Generate preview RGBA buffer from masks (post-knob).
     * Pixels where the assigned mask was removed (despeckled) are shown in
     * the color of whatever mask still covers them. If NO mask covers a pixel
     * (minVolume pruned the color entirely), fall back to colorIndices.
     * Speckle-removed pixels visually merge into their surroundings — they
     * don't show as white because in print they'd absorb into the adjacent ink.
     * @private
     */
    _generatePreviewFromMasks(masks, colorIndices, rgbPalette, width, height) {
        const pixelCount = width * height;
        const previewBuffer = new Uint8ClampedArray(pixelCount * 4);
        const numColors = masks.length;

        for (let i = 0; i < pixelCount; i++) {
            const idx = i * 4;
            const ci = colorIndices[i];
            let colorIdx = ci;

            // If assigned color's mask was eroded, find another active mask
            if (ci >= numColors || masks[ci][i] === 0) {
                let found = -1;
                for (let c = 0; c < numColors; c++) {
                    if (masks[c][i] > 0) {
                        found = c;
                        break;
                    }
                }
                // Fall back to original colorIndices if no mask active
                // (e.g. minVolume pruned the color — it remaps via colorIndices)
                colorIdx = found >= 0 ? found : ci;
            }

            if (colorIdx < rgbPalette.length) {
                const color = typeof rgbPalette[colorIdx] === 'string'
                    ? this._hexToRgb(rgbPalette[colorIdx])
                    : rgbPalette[colorIdx];
                previewBuffer[idx]     = color.r;
                previewBuffer[idx + 1] = color.g;
                previewBuffer[idx + 2] = color.b;
            } else {
                previewBuffer[idx]     = 255;
                previewBuffer[idx + 1] = 255;
                previewBuffer[idx + 2] = 255;
            }
            previewBuffer[idx + 3] = 255;
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
