/**
 * ZoomPreviewRenderer - High-Performance UXP Version
 *
 * Optimizations:
 * 1. Buffer Reuse: Avoids re-allocating RGBA buffers every frame to reduce GC jank.
 * 2. Optimized Lab Normalization: Uses bitwise operations for faster index calculation.
 * 3. Faster Base64: Uses a more efficient chunking strategy.
 * 4. CSS Transform Panning: Decouples visual movement from pixel rendering.
 */

const photoshop = require('photoshop');
const jpeg = require('jpeg-js');

class ZoomPreviewRenderer {
    constructor(container, imageEl1, imageEl2, documentID, layerID, docWidth, docHeight, bitDepth, separationData) {
        this.container = container;
        this.images = [imageEl1, imageEl2]; // Double buffer
        this.activeIndex = 0; // Track which image is currently visible
        this.documentID = documentID;
        this.docWidth = docWidth;
        this.docHeight = docHeight;
        this.separationData = separationData;

        this.width = container.clientWidth || 800;
        this.height = container.clientHeight || 600;

        this.viewportX = 0;
        this.viewportY = 0;
        this.resolution = 1;
        this.mode = 'reveal';

        this.activePixelData = null;
        this.isRendering = false;
        this._renderDirty = false; // Flag: viewport changed while rendering

        // Shared buffer to prevent GC pauses
        this.rgbaBuffer = new Uint8Array(this.width * this.height * 4);

        this.lutSize = 32;
        this.lut = null;
        this.lutReady = false;
        this.sm1 = this.lutSize - 1;

        // Debounced high-quality rendering
        this.qualityTimeout = null;

        // HQ badge for visual feedback
        this.hqBadge = document.getElementById('hqBadge');

        // Solo mode support (highlight only one color)
        this.soloColorIndex = null;
    }

    /**
     * Set solo mode to highlight only one color
     * @param {number|null} colorIndex - Palette index to highlight, or null for all colors
     */
    setSoloColor(colorIndex) {
        this.soloColorIndex = colorIndex;
    }

    /**
     * Get the currently visible image element
     */
    getActiveImage() {
        return this.images[this.activeIndex];
    }

    /**
     * Get the hidden image element (for background loading)
     */
    getNextImage() {
        return this.images[1 - this.activeIndex];
    }

    async init() {
        this.viewportX = (this.docWidth / this.resolution - this.width) / 2;
        this.viewportY = (this.docHeight / this.resolution - this.height) / 2;
        await this.fetchAndRender();
    }

    /**
     * Fetch and render viewport with optional high-quality pass
     * @param {boolean} highQuality - Use 16-bit Lab for better color accuracy (slower)
     */
    async fetchAndRender(highQuality = false) {
        if (this.isRendering) {
            // Mark dirty so current render triggers a follow-up when it completes
            this._renderDirty = true;
            return;
        }
        this.isRendering = true;
        this._renderDirty = false;

        // Show badge if starting a high-quality pass
        if (highQuality && this.hqBadge) {
            this.hqBadge.style.display = 'block';
            this.hqBadge.style.opacity = '0.5'; // Dim while processing
        }

        try {
            // Clear any pending quality upgrade
            if (!highQuality) {
                clearTimeout(this.qualityTimeout);
            }

            if (this.activePixelData && this.activePixelData.imageData) {
                this.activePixelData.imageData.dispose();
                this.activePixelData = null;
            }

            const left = Math.floor(this.viewportX * this.resolution);
            const top = Math.floor(this.viewportY * this.resolution);
            const right = Math.min(this.docWidth, left + Math.ceil(this.width * this.resolution));
            const bottom = Math.min(this.docHeight, top + Math.ceil(this.height * this.resolution));

            // Toggle bit depth: 8-bit for speed, 16-bit for color accuracy
            const componentSize = highQuality ? 16 : 8;
            const divisor = highQuality ? 32768 : 255; // Normalized Lab range

            this.activePixelData = await photoshop.core.executeAsModal(async () => {
                return await photoshop.imaging.getPixels({
                    documentID: this.documentID,
                    sourceBounds: { left, top, right, bottom },
                    componentSize: componentSize,
                    targetComponentCount: 3,
                    colorSpace: "Lab"
                });
            }, { commandName: highQuality ? 'HQ Render' : 'Fast Render' });

            const pixelBuffer = await this.activePixelData.imageData.getData({ chunky: true });
            const w = this.activePixelData.imageData.width;
            const h = this.activePixelData.imageData.height;

            if (!this.lutReady) this.generateLUT();

            // Reuse existing buffer or grow if necessary
            if (this.rgbaBuffer.length < w * h * 4) {
                this.rgbaBuffer = new Uint8Array(w * h * 4);
            }

            const rgba = this.rgbaBuffer;
            const lut = this.lut;
            const size = this.lutSize;
            const sm1 = this.sm1;
            const palette = this.separationData.palette;
            const soloMode = this.soloColorIndex !== null;

            // PERFORMANCE: Bitwise floor and pre-calculated constants
            for (let i = 0; i < w * h; i++) {
                const srcIdx = i * 3;
                const dstIdx = i * 4;

                // Get Lab values (normalized 0-100 for L, -128 to 127 for a/b)
                const L = pixelBuffer[srcIdx] / divisor * 100;
                const a = pixelBuffer[srcIdx + 1] / divisor * 255 - 128;
                const b = pixelBuffer[srcIdx + 2] / divisor * 255 - 128;

                // LUT lookup for RGB
                const lN = (pixelBuffer[srcIdx] * sm1 / divisor) | 0;
                const aN = (pixelBuffer[srcIdx + 1] * sm1 / divisor) | 0;
                const bN = (pixelBuffer[srcIdx + 2] * sm1 / divisor) | 0;
                const lIdx = (lN * size * size + aN * size + bN) * 3;

                // Solo mode: Check if this pixel matches the selected color
                let showPixel = true;
                if (soloMode) {
                    // Find closest palette color
                    let minDist = Infinity;
                    let closestIdx = 0;
                    for (let p = 0; p < palette.length; p++) {
                        const dL = L - palette[p].L;
                        const da = a - palette[p].a;
                        const db = b - palette[p].b;
                        const dist = dL * dL + da * da + db * db;
                        if (dist < minDist) {
                            minDist = dist;
                            closestIdx = p;
                        }
                    }
                    showPixel = (closestIdx === this.soloColorIndex);
                }

                if (showPixel) {
                    // Show actual color
                    rgba[dstIdx]     = lut[lIdx];
                    rgba[dstIdx + 1] = lut[lIdx + 1];
                    rgba[dstIdx + 2] = lut[lIdx + 2];
                    rgba[dstIdx + 3] = 255;
                } else {
                    // Checkered background for non-matching pixels
                    const x = (i % w);
                    const y = (i / w) | 0;
                    const checker = ((x >> 3) + (y >> 3)) & 1;
                    const gray = checker ? 200 : 230;
                    rgba[dstIdx]     = gray;
                    rgba[dstIdx + 1] = gray;
                    rgba[dstIdx + 2] = gray;
                    rgba[dstIdx + 3] = 255;
                }
            }

            // Higher JPEG quality for final high-quality pass
            const jpegQuality = highQuality ? 90 : 70;
            const jpegData = jpeg.encode({ data: rgba, width: w, height: h }, jpegQuality);
            const base64Data = `data:image/jpeg;base64,${this.uint8ToBase64(jpegData.data)}`;

            const cssScale = 1 / this.resolution;
            const imgWidth = `${(w * cssScale) | 0}px`;
            const imgHeight = `${(h * cssScale) | 0}px`;

            // DOUBLE BUFFERING: Load into hidden image, then swap when ready
            const nextImg = this.getNextImage();
            const activeImg = this.getActiveImage();

            // Return promise that resolves when swap is complete
            return new Promise((resolve, reject) => {
                nextImg.onload = () => {
                    try {
                        // Set dimensions for the new image
                        nextImg.style.width = imgWidth;
                        nextImg.style.height = imgHeight;
                        nextImg.style.transform = 'translate3d(0, 0, 0)';
                        nextImg.style.left = '0px';
                        nextImg.style.top = '0px';

                        // SWAP: Show new, hide old (using opacity for faster rendering)
                        nextImg.style.opacity = '1';
                        nextImg.style.pointerEvents = 'auto';
                        activeImg.style.opacity = '0';
                        activeImg.style.pointerEvents = 'none';

                        // Flip the active index
                        this.activeIndex = 1 - this.activeIndex;

                        // If HQ pass finished, brighten badge then fade out
                        if (highQuality && this.hqBadge) {
                            this.hqBadge.style.opacity = '1';
                            setTimeout(() => {
                                if (this.hqBadge) {
                                    this.hqBadge.style.display = 'none';
                                }
                            }, 1000);
                        }

                        this.isRendering = false;

                        // If viewport changed while we were rendering, re-render at new position
                        if (this._renderDirty) {
                            this._renderDirty = false;
                            this.fetchAndRender(false).catch(err => {
                                console.error('[ZoomRenderer] Dirty re-render failed:', err);
                            });
                        } else if (!highQuality) {
                            // Schedule high-quality upgrade only if viewport is stable
                            this.qualityTimeout = setTimeout(() => {
                                this.fetchAndRender(true);
                            }, 500);
                        }

                        resolve();
                    } catch (err) {
                        console.error('[ZoomRenderer] Error in onload callback:', err);
                        this.isRendering = false;
                        this._renderDirty = false;
                        reject(err);
                    }
                };

                nextImg.onerror = (err) => {
                    console.error('[ZoomRenderer] Image load error:', err);
                    this.isRendering = false;
                    this._renderDirty = false;
                    reject(new Error('Image failed to load'));
                };

                // Trigger the load into hidden image
                nextImg.src = base64Data;
            });

        } catch (error) {
            console.error("[ZoomRenderer] Render failed:", error);
            // Hide badge on error
            if (this.hqBadge) {
                this.hqBadge.style.display = 'none';
            }
            this.isRendering = false;
            this._renderDirty = false;
            return Promise.reject(error);
        }
    }

    generateLUT() {
        const palette = this.separationData.palette;
        const size = this.lutSize;
        const palLen = palette.length;

        this.lut = new Uint8Array(size * size * size * 3);

        for (let l = 0; l < size; l++) {
            const L = (l / (size - 1)) * 100;
            for (let a = 0; a < size; a++) {
                const aa = (a / (size - 1)) * 255 - 128;
                for (let b = 0; b < size; b++) {
                    const bb = (b / (size - 1)) * 255 - 128;
                    let minDist = Infinity;
                    let bestIdx = 0;

                    for (let p = 0; p < palLen; p++) {
                        const dL = L - palette[p].L;
                        const da = aa - palette[p].a;
                        const db = bb - palette[p].b;
                        const dist = dL * dL + da * da + db * db;
                        if (dist < minDist) {
                            minDist = dist;
                            bestIdx = p;
                        }
                    }

                    const rgb = this.labToRgbFast(palette[bestIdx].L, palette[bestIdx].a, palette[bestIdx].b);
                    const lutIdx = (l * size * size + a * size + b) * 3;
                    this.lut[lutIdx] = rgb.r;
                    this.lut[lutIdx + 1] = rgb.g;
                    this.lut[lutIdx + 2] = rgb.b;
                }
            }
        }

        this.lutReady = true;
    }

    async setResolutionAtPoint(newRes, mouseX, mouseY) {
        // Clear any pending quality upgrade to avoid race conditions
        clearTimeout(this.qualityTimeout);

        const imagePointX = (this.viewportX + mouseX) * this.resolution;
        const imagePointY = (this.viewportY + mouseY) * this.resolution;

        this.resolution = newRes;

        this.viewportX = (imagePointX / this.resolution) - mouseX;
        this.viewportY = (imagePointY / this.resolution) - mouseY;

        this.applyBounds();
        await this.fetchAndRender();
    }

    applyBounds() {
        const maxX = Math.max(0, (this.docWidth / this.resolution) - this.width);
        const maxY = Math.max(0, (this.docHeight / this.resolution) - this.height);
        this.viewportX = Math.max(0, Math.min(maxX, this.viewportX));
        this.viewportY = Math.max(0, Math.min(maxY, this.viewportY));
    }

    pan(deltaX, deltaY) {
        // Cancel any pending HQ upgrade - user is actively panning
        clearTimeout(this.qualityTimeout);
        this.viewportX += deltaX;
        this.viewportY += deltaY;
        this.applyBounds();
    }

    /**
     * Optimized Base64 chunking
     */
    uint8ToBase64(buffer) {
        const CHUNK_SIZE = 0x8000;
        let binary = '';
        for (let i = 0; i < buffer.length; i += CHUNK_SIZE) {
            binary += String.fromCharCode.apply(null, buffer.subarray(i, i + CHUNK_SIZE));
        }
        return btoa(binary);
    }

    labToRgbFast(L, a, b) {
        let y = (L + 16) / 116;
        let x = a / 500 + y;
        let z = y - b / 200;

        x = 0.95047 * ((x * x * x > 0.008856) ? x * x * x : (x - 16 / 116) / 7.787);
        y = 1.00000 * ((y * y * y > 0.008856) ? y * y * y : (y - 16 / 116) / 7.787);
        z = 1.08883 * ((z * z * z > 0.008856) ? z * z * z : (z - 16 / 116) / 7.787);

        let r = x * 3.2406 + y * -1.5372 + z * -0.4986;
        let g = x * -0.9689 + y * 1.8758 + z * 0.0415;
        let b_ = x * 0.0557 + y * -0.2040 + z * 1.0570;

        const f = (c) => (c > 0.0031308) ? (1.055 * Math.pow(c, 1 / 2.4) - 0.055) : c * 12.92;

        return {
            r: Math.max(0, Math.min(255, (f(r) * 255) | 0)),
            g: Math.max(0, Math.min(255, (f(g) * 255) | 0)),
            b: Math.max(0, Math.min(255, (f(b_) * 255) | 0))
        };
    }
}

module.exports = ZoomPreviewRenderer;
