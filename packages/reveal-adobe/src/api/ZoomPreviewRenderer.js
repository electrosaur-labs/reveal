/**
 * ZoomPreviewRenderer - 1:1 viewport into source image
 *
 * Fetches a region from the source at 1:1 scale (no scaling).
 * The zoom window is a viewport showing a portion of the source at original resolution.
 */

const { imaging } = require('photoshop');
const jpeg = require('jpeg-js');

class ZoomPreviewRenderer {
    constructor(container, imageEl, documentID, layerID, docWidth, docHeight, bitDepth, separationData, storedPixelsData = null) {
        this.container = container;
        this.imageEl = imageEl;
        this.documentID = documentID;
        this.layerID = layerID;
        this.docWidth = docWidth;
        this.docHeight = docHeight;
        this.bitDepth = bitDepth;
        this.separationData = separationData;
        this.storedPixelsData = storedPixelsData;
        this.mode = 'reveal'; // Always show revealed/palette version

        // Get container size (viewport)
        this.width = container.clientWidth || container.offsetWidth || 800;
        this.height = container.clientHeight || container.offsetHeight || 600;

        // Full image pixels (fetched once from Photoshop)
        this.fullImagePixels = null;
        this.fullImageWidth = 0;
        this.fullImageHeight = 0;

        // Viewport state (pan position)
        this.viewportX = 0;  // Top-left X coordinate in source image
        this.viewportY = 0;  // Top-left Y coordinate in source image
        this.resolution = 1; // Resolution scale: 1=1:1, 2=1:2, 4=1:4, 8=1:8

        // 3D LUT for O(1) palette lookups (32×32×32 = ~96 KB)
        this.lutSize = 32;
        this.lut = null; // Generated on first render
        this.lutReady = false;

        console.log(`[ZoomRenderer] Viewport size: ${this.width}×${this.height}`);
        console.log(`[ZoomRenderer] Document size: ${docWidth}×${docHeight}`);
    }

    async init() {
        // For 1:1 zoom, we need to fetch at FULL RESOLUTION from the source PSD
        // Calculate how much source area to fetch based on viewport size and resolution
        // At 1:1: fetch viewport size (e.g., 1200×601)
        // At 1:2: fetch 2× viewport size (e.g., 2400×1202)
        // At 1:4: fetch 4× viewport size (e.g., 4800×2404)

        await this.fetchRegion();
    }

    async fetchRegion() {
        // Fetch entire document at the selected resolution to allow full panning
        // At 1:1: fetch min(viewport × 10, full document) for memory safety
        // At 1:2+: fetch entire document since it's scaled down

        let fetchWidth, fetchHeight;
        if (this.resolution === 1) {
            // At 1:1, limit to avoid memory issues (10× viewport area)
            const maxFetch = 10;
            fetchWidth = Math.min(this.width * maxFetch, this.docWidth);
            fetchHeight = Math.min(this.height * maxFetch, this.docHeight);
        } else {
            // At 1:2+, fetch entire document (it's scaled down so manageable)
            fetchWidth = this.docWidth;
            fetchHeight = this.docHeight;
        }

        // Calculate source bounds for the region (centered on document)
        const centerX = Math.floor(this.docWidth / 2);
        const centerY = Math.floor(this.docHeight / 2);
        const left = Math.max(0, centerX - Math.floor(fetchWidth / 2));
        const top = Math.max(0, centerY - Math.floor(fetchHeight / 2));
        const right = Math.min(this.docWidth, left + fetchWidth);
        const bottom = Math.min(this.docHeight, top + fetchHeight);

        console.log(`[ZoomRenderer] Fetching region from FULL-RES PSD...`);
        console.log(`[ZoomRenderer] Resolution: 1:${this.resolution} (scale: ${1/this.resolution})`);
        console.log(`[ZoomRenderer] Source bounds: (${left}, ${top}) to (${right}, ${bottom})`);
        console.log(`[ZoomRenderer] Fetch size: ${right - left}×${bottom - top} pixels`);

        let pixelData;
        try {
            pixelData = await imaging.getPixels({
                documentID: this.documentID,
                sourceBounds: {
                    left: left,
                    top: top,
                    right: right,
                    bottom: bottom
                },
                componentSize: 16,
                targetComponentCount: 3,
                colorSpace: "Lab"
            });
            console.log(`[ZoomRenderer] ✓ Got pixel data from Photoshop`);
        } catch (error) {
            console.error(`[ZoomRenderer] ❌ Failed to fetch pixels:`, error);
            throw error;
        }

        // Extract Lab data
        let labData;
        if (pixelData.imageData) {
            this.fullImageWidth = pixelData.imageData.width;
            this.fullImageHeight = pixelData.imageData.height;
            labData = await pixelData.imageData.getData({ chunky: true });
        } else if (pixelData.pixels) {
            this.fullImageWidth = right - left;
            this.fullImageHeight = bottom - top;
            labData = pixelData.pixels;
        }

        // Store region in memory
        this.fullImagePixels = new Uint16Array(labData);

        // Calculate display dimensions (accounting for resolution scale)
        const displayScale = 1 / this.resolution;
        this.displayWidth = Math.round(this.fullImageWidth * displayScale);
        this.displayHeight = Math.round(this.fullImageHeight * displayScale);

        // Center viewport on fetched region
        this.viewportX = Math.max(0, Math.floor((this.displayWidth - this.width) / 2));
        this.viewportY = Math.max(0, Math.floor((this.displayHeight - this.height) / 2));

        console.log(`[ZoomRenderer] Stored region: ${this.fullImageWidth}×${this.fullImageHeight} at TRUE 1:1 scale`);
        console.log(`[ZoomRenderer] Display size: ${this.displayWidth}×${this.displayHeight} (scale: ${displayScale})`);
        console.log(`[ZoomRenderer] Viewport centered at: (${this.viewportX}, ${this.viewportY})`);
        console.log(`[ZoomRenderer] First pixel: L=${this.fullImagePixels[0]} a=${this.fullImagePixels[1]} b=${this.fullImagePixels[2]}`);
    }

    /**
     * Generate 3D LUT for O(1) palette lookups
     * Maps every possible Lab coordinate to nearest palette color (pre-converted to RGB)
     * Memory: 32×32×32 × 3 bytes = ~96 KB
     */
    generateLUT() {
        const palette = this.separationData.palette;
        const size = this.lutSize;
        const palLen = palette.length;

        console.log(`[ZoomRenderer] Generating ${size}×${size}×${size} LUT for ${palLen} colors...`);
        const startTime = performance.now();

        this.lut = new Uint8Array(size * size * size * 3);

        for (let l = 0; l < size; l++) {
            for (let a = 0; a < size; a++) {  // Fixed: was incrementing 'l' instead of 'a'
                for (let b = 0; b < size; b++) {
                    // Map LUT index back to Lab values
                    const L = (l / (size - 1)) * 100;          // 0-100
                    const aa = (a / (size - 1)) * 255 - 128;   // -128 to +127
                    const bb = (b / (size - 1)) * 255 - 128;   // -128 to +127

                    // Find nearest palette color (O(N) search, done once)
                    let minDist = Infinity;
                    let bestColor = { r: 0, g: 0, b: 0 };

                    for (let p = 0; p < palLen; p++) {
                        const dL = L - palette[p].L;
                        const da = aa - palette[p].a;
                        const db = bb - palette[p].b;
                        const dist = dL * dL + da * da + db * db;
                        if (dist < minDist) {
                            minDist = dist;
                            // Pre-convert nearest palette color to RGB
                            bestColor = this.labToRgbFast(palette[p].L, palette[p].a, palette[p].b);
                        }
                    }

                    const lutIdx = (l * size * size + a * size + b) * 3;
                    this.lut[lutIdx] = bestColor.r;
                    this.lut[lutIdx + 1] = bestColor.g;
                    this.lut[lutIdx + 2] = bestColor.b;
                }
            }
        }

        this.lutReady = true;
        const elapsed = performance.now() - startTime;
        console.log(`[ZoomRenderer] ✓ LUT generated in ${elapsed.toFixed(1)}ms`);
    }

    async renderTile() {
        console.log(`[ZoomRenderer] Rendering viewport at (${this.viewportX}, ${this.viewportY})`);

        try {
            const srcWidth = this.fullImageWidth;
            const srcHeight = this.fullImageHeight;

            // 1. Prepare RGBA buffer
            const rgbaBuffer = new Uint8Array(srcWidth * srcHeight * 4);

            const labData = this.fullImagePixels;
            const palette = this.separationData.palette;
            const showPalette = this.mode === 'reveal' && palette;

            // 2. Generate LUT if needed (once per palette)
            if (showPalette && !this.lutReady) {
                this.generateLUT();
            }

            // 3. Ultra-Fast Pixel Loop with LUT
            if (showPalette) {
                const size = this.lutSize;
                const sizeMinusOne = size - 1;

                for (let i = 0; i < srcWidth * srcHeight; i++) {
                    const labIdx = i * 3;
                    const rgbaIdx = i * 4;

                    // Normalize 16-bit Photoshop Lab to LUT coordinates (0 to size-1)
                    const lNorm = Math.round((labData[labIdx] / 32768) * sizeMinusOne);
                    const aNorm = Math.round(((labData[labIdx + 1] - 16384) / 32768 + 0.5) * sizeMinusOne);
                    const bNorm = Math.round(((labData[labIdx + 2] - 16384) / 32768 + 0.5) * sizeMinusOne);

                    // O(1) LUT Lookup
                    const lutIdx = (lNorm * size * size + aNorm * size + bNorm) * 3;

                    rgbaBuffer[rgbaIdx] = this.lut[lutIdx];
                    rgbaBuffer[rgbaIdx + 1] = this.lut[lutIdx + 1];
                    rgbaBuffer[rgbaIdx + 2] = this.lut[lutIdx + 2];
                    rgbaBuffer[rgbaIdx + 3] = 255;
                }
            } else {
                // Non-palette mode: direct Lab→RGB conversion
                for (let i = 0; i < srcWidth * srcHeight; i++) {
                    const labIdx = i * 3;
                    const rgbaIdx = i * 4;

                    // Normalize 16-bit to 8-bit Lab space
                    const L8 = (labData[labIdx] / 32768) * 100;
                    const a8 = (labData[labIdx + 1] - 16384) / 128;
                    const b8 = (labData[labIdx + 2] - 16384) / 128;

                    const rgb = this.labToRgbFast(L8, a8, b8);
                    rgbaBuffer[rgbaIdx] = rgb.r;
                    rgbaBuffer[rgbaIdx + 1] = rgb.g;
                    rgbaBuffer[rgbaIdx + 2] = rgb.b;
                    rgbaBuffer[rgbaIdx + 3] = 255;
                }
            }

            // 4. Encode to JPEG (quality 70% for speed)
            const jpegData = jpeg.encode({
                data: rgbaBuffer,
                width: srcWidth,
                height: srcHeight
            }, 70);

            // 5. Convert to data URL
            const base64 = this.bufferToBase64(jpegData.data);
            const dataUrl = `data:image/jpeg;base64,${base64}`;

            // 6. Update image and CSS
            this.imageEl.src = dataUrl;
            const displayScale = 1 / this.resolution;
            this.imageEl.style.width = `${Math.round(srcWidth * displayScale)}px`;
            this.imageEl.style.height = `${Math.round(srcHeight * displayScale)}px`;
            this.imageEl.style.left = `${-this.viewportX}px`;
            this.imageEl.style.top = `${-this.viewportY}px`;

            console.log(`[ZoomRenderer] ✓ Rendered ${srcWidth}×${srcHeight}, viewport at (${this.viewportX}, ${this.viewportY})`);
        } catch (error) {
            console.error(`[ZoomRenderer] ❌ Failed:`, error);
            throw error;
        }
    }

    bufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Inlined Lab -> RGB math (Standard D65/sRGB)
     * Keeps calculations on the stack to avoid GC overhead
     */
    labToRgbFast(L, a, b) {
        let y = (L + 16) / 116;
        let x = a / 500 + y;
        let z = y - b / 200;

        x = 0.95047 * ((x * x * x > 0.008856) ? x * x * x : (x - 16/116) / 7.787);
        y = 1.00000 * ((y * y * y > 0.008856) ? y * y * y : (y - 16/116) / 7.787);
        z = 1.08883 * ((z * z * z > 0.008856) ? z * z * z : (z - 16/116) / 7.787);

        let r = x * 3.2406 + y * -1.5372 + z * -0.4986;
        let g = x * -0.9689 + y * 1.8758 + z * 0.0415;
        let b_ = x * 0.0557 + y * -0.2040 + z * 1.0570;

        r = (r > 0.0031308) ? (1.055 * Math.pow(r, 1/2.4) - 0.055) : r * 12.92;
        g = (g > 0.0031308) ? (1.055 * Math.pow(g, 1/2.4) - 0.055) : g * 12.92;
        b_ = (b_ > 0.0031308) ? (1.055 * Math.pow(b_, 1/2.4) - 0.055) : b_ * 12.92;

        return {
            r: Math.max(0, Math.min(255, Math.round(r * 255))),
            g: Math.max(0, Math.min(255, Math.round(g * 255))),
            b: Math.max(0, Math.min(255, Math.round(b_ * 255)))
        };
    }

    // Pan the viewport
    pan(deltaX, deltaY) {
        // Update viewport position with bounds checking (use display dimensions, not source dimensions)
        const maxX = Math.max(0, this.displayWidth - this.width);
        const maxY = Math.max(0, this.displayHeight - this.height);

        this.viewportX = Math.max(0, Math.min(maxX, this.viewportX + deltaX));
        this.viewportY = Math.max(0, Math.min(maxY, this.viewportY + deltaY));

        // Update image position
        this.imageEl.style.left = `${-this.viewportX}px`;
        this.imageEl.style.top = `${-this.viewportY}px`;

        console.log(`[ZoomRenderer] Panned to (${this.viewportX}, ${this.viewportY}) - bounds: ${maxX}×${maxY}`);
    }

    // Set resolution scale (1=1:1, 2=1:2, 4=1:4, 8=1:8)
    async setResolution(resolution) {
        this.resolution = resolution;
        console.log(`[ZoomRenderer] Resolution set to 1:${resolution}`);

        try {
            // Re-fetch region at new resolution
            await this.fetchRegion();
            await this.renderTile();
            console.log(`[ZoomRenderer] ✓ Resolution change complete`);
        } catch (error) {
            console.error(`[ZoomRenderer] ❌ Resolution change failed:`, error);
            throw error;
        }
    }

    async setMode(mode) {
        this.mode = mode;
        console.log(`[ZoomRenderer] Mode changed to: ${mode}`);
        await this.renderTile();
    }

    // Find nearest palette color using simple Euclidean distance in Lab space
    // Note: palette colors are in 8-bit format {L, a, b}, source pixels are in 16-bit format
    findNearestPaletteColor(L16, a16, b16, palette) {
        // Convert 16-bit source pixel to 8-bit for comparison
        const L8 = (L16 / 32768) * 100;  // 0-32768 → 0-100
        const a8 = ((a16 - 16384) / 128); // 0-32768 → -128 to +127 (16384=neutral)
        const b8 = ((b16 - 16384) / 128); // 0-32768 → -128 to +127

        let minDist = Infinity;
        let nearest = palette[0];

        for (let i = 0; i < palette.length; i++) {
            const pL = palette[i].L;  // Access as object property
            const pa = palette[i].a;
            const pb = palette[i].b;

            // Simple squared Euclidean distance (fast)
            const dL = L8 - pL;
            const da = a8 - pa;
            const db = b8 - pb;
            const dist = dL * dL + da * da + db * db;

            if (dist < minDist) {
                minDist = dist;
                nearest = palette[i];
            }
        }

        return nearest;
    }
}

module.exports = ZoomPreviewRenderer;
