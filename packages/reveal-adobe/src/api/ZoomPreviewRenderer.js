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
        // No more "fetching regions" ahead of time.
        // Just render the current view immediately with on-demand tiling.
        await this.renderTile();
    }

    // fetchRegion removed - now using on-demand tiling in renderTile()

    async renderTile() {
        console.log(`[ZoomRenderer] Rendering viewport at (${this.viewportX}, ${this.viewportY})`);

        try {
            // 1. Fetch ONLY the pixels in the current viewport (on-demand tiling)
            const pixelData = await imaging.getPixels({
                documentID: this.documentID,
                sourceBounds: {
                    left: Math.round(this.viewportX),
                    top: Math.round(this.viewportY),
                    right: Math.round(this.viewportX + this.width),
                    bottom: Math.round(this.viewportY + this.height)
                },
                componentSize: 16,
                targetComponentCount: 3,
                colorSpace: "Lab"
            });

            const srcWidth = pixelData.imageData.width;
            const srcHeight = pixelData.imageData.height;
            const labData = await pixelData.imageData.getData({ chunky: true });

            console.log(`[ZoomRenderer] Fetched tile: ${srcWidth}×${srcHeight} (~${(labData.length * 2 / 1024 / 1024).toFixed(1)}MB)`);

            // 2. Process only this small tile
            const pixelRgba = this.processLabPixels(labData, srcWidth, srcHeight);

            // 3. Encode and Display
            const jpegData = jpeg.encode({
                data: pixelRgba,
                width: srcWidth,
                height: srcHeight
            }, 95);

            const base64 = bufferToBase64(jpegData.data);
            const dataUrl = `data:image/jpeg;base64,${base64}`;

            this.tileImg.width = srcWidth;
            this.tileImg.height = srcHeight;
            this.tileImg.style.width = `${srcWidth}px`;
            this.tileImg.style.height = `${srcHeight}px`;

            // Reset offsets because the image is now exactly the size of the viewport
            this.tileImg.style.left = "0px";
            this.tileImg.style.top = "0px";

            this.tileImg.src = dataUrl;

            console.log(`[ZoomRenderer] ✓ Rendered ${srcWidth}×${srcHeight} tile`);
        } catch (error) {
            console.error(`[ZoomRenderer] ❌ Failed:`, error);
            throw error;
        }
    }

    // Process Lab pixels to RGBA (extracted for clarity)
    processLabPixels(labData, width, height) {
        const pixelRgba = new Uint8ClampedArray(width * height * 4);
        const showPalette = this.mode === 'reveal';
        const palette = showPalette ? this.separationData.palette : null;

        for (let i = 0; i < width * height; i++) {
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
                const pa16 = (paletteColor.a * 256) + 32768;  // FIXED: 32768 midpoint, not 16384
                const pb16 = (paletteColor.b * 256) + 32768;  // FIXED: 32768 midpoint, not 16384

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

        return pixelRgba;
    }

    // Pan the viewport
    async pan(deltaX, deltaY) {
        // Update viewport position with bounds checking
        const maxX = Math.max(0, this.docWidth - this.width);
        const maxY = Math.max(0, this.docHeight - this.height);

        this.viewportX = Math.max(0, Math.min(maxX, this.viewportX + deltaX));
        this.viewportY = Math.max(0, Math.min(maxY, this.viewportY + deltaY));

        console.log(`[ZoomRenderer] Panned to (${this.viewportX}, ${this.viewportY}) - bounds: ${maxX}×${maxY}`);

        // Re-render the tile at the new viewport position (on-demand tiling)
        await this.renderTile();
    }

    // Set resolution scale (1=1:1, 2=1:2, 4=1:4, 8=1:8)
    async setResolution(resolution) {
        this.resolution = resolution;
        console.log(`[ZoomRenderer] Resolution set to 1:${resolution}`);

        // Just re-render the current tile at new resolution (on-demand)
        await this.renderTile();
        console.log(`[ZoomRenderer] ✓ Resolution changed to 1:${resolution}`);
    }

    async setMode(mode) {
        this.mode = mode;
        console.log(`[ZoomRenderer] Mode changed to: ${mode}`);
        await this.renderTile();
    }

    // Find nearest palette color with corrected Lab math and weighted distance
    // Note: palette colors are in 8-bit format {L, a, b}, source pixels are in 16-bit format
    findNearestPaletteColor(L16, a16, b16, palette) {
        // CORRECTED Lab Midpoints:
        // - L is 0-32768 → 0-100
        // - a/b are 0-65535 centered at 32768 → -128 to +127
        const L8 = (L16 / 32768) * 100;
        const a8 = (a16 - 32768) / 256;  // FIXED: 32768 midpoint, not 16384
        const b8 = (b16 - 32768) / 256;  // FIXED: 32768 midpoint, not 16384

        // Apply Archetype Weights (from Architect's guidance)
        const wL = 2.2;  // The AIC Secret Sauce
        const wa = 1.0;
        const wb = 1.0;

        let minDist = Infinity;
        let nearest = palette[0];

        for (let i = 0; i < palette.length; i++) {
            const dL = (L8 - palette[i].L) * wL;
            const da = (a8 - palette[i].a) * wa;
            const db = (b8 - palette[i].b) * wb;
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
