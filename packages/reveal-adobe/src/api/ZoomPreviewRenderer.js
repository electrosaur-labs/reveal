/**
 * ZoomPreviewRenderer - 1:1 viewport into source image
 *
 * Fetches a region from the source at 1:1 scale (no scaling).
 * The zoom window is a viewport showing a portion of the source at original resolution.
 */

const { imaging } = require('photoshop');
const ColorSpace = require('../../../reveal-core/lib/engines/ColorSpace');
const jpeg = require('jpeg-js');

function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

class ZoomPreviewRenderer {
    constructor(container, tileImg, documentID, layerID, docWidth, docHeight, bitDepth, separationData, storedPixelsData = null) {
        this.container = container;
        this.tileImg = tileImg;
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

    async renderTile() {
        console.log(`[ZoomRenderer] Rendering viewport at (${this.viewportX}, ${this.viewportY})`);

        try {
            // Convert full image to RGB (do this once, cache if needed)
            const labData = this.fullImagePixels;
            const srcWidth = this.fullImageWidth;
            const srcHeight = this.fullImageHeight;

            const pixelRgba = new Uint8ClampedArray(srcWidth * srcHeight * 4);

            // Check if we should show original or palette-separated colors
            const showPalette = this.mode === 'reveal';
            const palette = showPalette ? this.separationData.palette : null;

            if (showPalette) {
                console.log(`[ZoomRenderer] Rendering in PALETTE mode`);
                console.log(`[ZoomRenderer] Palette:`, palette ? `${palette.length} colors` : 'NULL');
                if (palette && palette.length > 0) {
                    console.log(`[ZoomRenderer] First palette entry:`, palette[0]);
                    console.log(`[ZoomRenderer] First palette entry type:`, typeof palette[0]);
                    console.log(`[ZoomRenderer] First palette entry keys:`, palette[0] ? Object.keys(palette[0]) : 'N/A');
                }
            }

            for (let i = 0; i < srcWidth * srcHeight; i++) {
                const labIdx = i * 3;
                const rgbaIdx = i * 4;

                const L16 = labData[labIdx];
                const a16 = labData[labIdx + 1];
                const b16 = labData[labIdx + 2];

                let r, g, b;

                if (showPalette && palette) {
                    // Map to nearest palette color (returns 8-bit {L, a, b})
                    const paletteColor = this.findNearestPaletteColor(L16, a16, b16, palette);

                    // Convert 8-bit palette color to 16-bit for RGB conversion
                    const pL16 = (paletteColor.L / 100) * 32768;
                    const pa16 = (paletteColor.a * 128) + 16384;
                    const pb16 = (paletteColor.b * 128) + 16384;

                    [r, g, b] = ColorSpace.fastLabToRgb16(pL16, pa16, pb16);
                } else {
                    // Show original colors
                    [r, g, b] = ColorSpace.fastLabToRgb16(L16, a16, b16);
                }

                pixelRgba[rgbaIdx] = r;
                pixelRgba[rgbaIdx + 1] = g;
                pixelRgba[rgbaIdx + 2] = b;
                pixelRgba[rgbaIdx + 3] = 255;
            }

            // Encode to JPEG
            const jpegData = jpeg.encode({
                data: pixelRgba,
                width: srcWidth,
                height: srcHeight
            }, 95);

            const base64 = bufferToBase64(jpegData.data);
            const dataUrl = `data:image/jpeg;base64,${base64}`;

            // Calculate display size based on resolution scale
            // At 1:1, display at actual size (scale = 1.0)
            // At 1:2, display at half size (scale = 0.5)
            // At 1:4, display at quarter size (scale = 0.25)
            const displayScale = 1 / this.resolution;
            const displayWidth = Math.round(srcWidth * displayScale);
            const displayHeight = Math.round(srcHeight * displayScale);

            this.tileImg.width = srcWidth;
            this.tileImg.height = srcHeight;
            this.tileImg.style.width = `${displayWidth}px`;
            this.tileImg.style.height = `${displayHeight}px`;

            // Position image to show viewport region (negative offset)
            this.tileImg.style.left = `${-this.viewportX}px`;
            this.tileImg.style.top = `${-this.viewportY}px`;

            this.tileImg.src = dataUrl;

            console.log(`[ZoomRenderer] ✓ Rendered ${srcWidth}×${srcHeight}, viewport at (${this.viewportX}, ${this.viewportY})`);
        } catch (error) {
            console.error(`[ZoomRenderer] ❌ Failed:`, error);
            throw error;
        }
    }

    // Pan the viewport
    pan(deltaX, deltaY) {
        // Update viewport position with bounds checking (use display dimensions, not source dimensions)
        const maxX = Math.max(0, this.displayWidth - this.width);
        const maxY = Math.max(0, this.displayHeight - this.height);

        this.viewportX = Math.max(0, Math.min(maxX, this.viewportX + deltaX));
        this.viewportY = Math.max(0, Math.min(maxY, this.viewportY + deltaY));

        // Update image position
        this.tileImg.style.left = `${-this.viewportX}px`;
        this.tileImg.style.top = `${-this.viewportY}px`;

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
