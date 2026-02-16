/**
 * Loupe - 1:1 native-resolution tile inspector overlay
 *
 * Renders a floating circular magnifier on top of the preview image.
 * On mouse movement over the preview, reads a small native-res tile
 * from Photoshop, runs the locked-palette separation pipeline with
 * current knobs, and displays the result in the loupe viewport.
 *
 * Key features:
 *   - True 1:1 pixel mapping: 256px tile → 256px loupe (one doc pixel = one screen pixel)
 *   - Respects highlight mode: when a swatch is selected, loupe shows isolated view
 *   - Bilateral filter on tile matches proxy pipeline (cleaner color boundaries)
 *   - Generation counter cancels stale in-flight fetches
 *
 * UXP constraints:
 *   - No ImageData / ctx.putImageData (use jpeg-js → base64 → img.src)
 *   - No CSS transform: rotate (use translate only)
 *   - Canvas invisible in DOM (use <img> element)
 */

const jpeg = require("jpeg-js");
const Reveal = require("@reveal/core");
const ProductionWorker = require("../bridge/ProductionWorker");

const JPEG_QUALITY = 92;
const CHUNK_SIZE = 0x8000;
const LOUPE_TILE_SIZE = 256;       // Native-res tile: 256px = true 1:1 in 256px loupe
const DEBOUNCE_MS = 80;            // Fast debounce for responsive feel

class Loupe {

    /**
     * @param {HTMLElement} container - #loupe-container element
     * @param {HTMLImageElement} loupeImg - #loupe-img element
     * @param {HTMLElement} coordsLabel - #loupe-coords element
     * @param {HTMLImageElement} previewImg - The main preview <img> for mouse tracking
     * @param {import('../state/SessionState')} sessionState
     */
    constructor(container, loupeImg, coordsLabel, previewImg, sessionState) {
        this._container = container;
        this._img = loupeImg;
        this._coords = coordsLabel;
        this._previewImg = previewImg;
        this._session = sessionState;
        this._active = false;
        this._debounceTimer = null;
        this._worker = null;
        this._fetchGeneration = 0;  // Cancellation counter — stale fetches are discarded
        this._lastProxyX = null;
        this._lastProxyY = null;

        // Bind handlers for clean add/remove
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseLeave = this._handleMouseLeave.bind(this);

        // Re-render current loupe tile when knobs/palette/highlight changes
        this._session.on('previewUpdated', () => {
            if (this._active && this._lastProxyX != null) {
                this._fetchAndRender(this._lastProxyX, this._lastProxyY);
            }
        });
        this._session.on('highlightChanged', () => {
            if (this._active && this._lastProxyX != null) {
                this._fetchAndRender(this._lastProxyX, this._lastProxyY);
            }
        });
    }

    /** Is loupe mode currently active? */
    get isActive() { return this._active; }

    /** Toggle loupe on/off. */
    toggle() {
        if (this._active) this.deactivate();
        else this.activate();
    }

    /** Enter loupe mode. */
    activate() {
        if (this._active) return;
        this._active = true;
        this._worker = new ProductionWorker(this._session, () => {});
        // Don't show container until mouse enters preview
        this._previewImg.addEventListener('mousemove', this._onMouseMove);
        this._previewImg.addEventListener('mouseleave', this._onMouseLeave);
        this._previewImg.style.cursor = 'crosshair';
    }

    /** Exit loupe mode. */
    deactivate() {
        if (!this._active) return;
        this._active = false;
        this._worker = null;
        this._fetchGeneration++;  // Cancel any in-flight fetch
        this._container.style.display = 'none';
        this._previewImg.removeEventListener('mousemove', this._onMouseMove);
        this._previewImg.removeEventListener('mouseleave', this._onMouseLeave);
        this._previewImg.style.cursor = '';
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        this._lastProxyX = null;
        this._lastProxyY = null;
    }

    /** Clean up on dialog close. */
    destroy() {
        this.deactivate();
    }

    // ─── Internal ─────────────────────────────────────────────

    _handleMouseMove(e) {
        if (!this._active) return;

        const imgRect = this._previewImg.getBoundingClientRect();
        const proxy = this._session.proxyEngine;
        if (!proxy || !proxy.separationState) return;

        const proxyW = proxy.separationState.width;
        const proxyH = proxy.separationState.height;

        // Account for object-fit:contain letterboxing/pillarboxing
        const imgAspect = proxyW / proxyH;
        const boxAspect = imgRect.width / imgRect.height;

        let displayW, displayH, offsetX, offsetY;
        if (imgAspect > boxAspect) {
            displayW = imgRect.width;
            displayH = imgRect.width / imgAspect;
            offsetX = 0;
            offsetY = (imgRect.height - displayH) / 2;
        } else {
            displayH = imgRect.height;
            displayW = imgRect.height * imgAspect;
            offsetX = (imgRect.width - displayW) / 2;
            offsetY = 0;
        }

        const mouseX = e.clientX - imgRect.left;
        const mouseY = e.clientY - imgRect.top;

        const proxyX = Math.round(((mouseX - offsetX) / displayW) * proxyW);
        const proxyY = Math.round(((mouseY - offsetY) / displayH) * proxyH);

        // Bounds check — hide loupe when cursor outside image area
        if (proxyX < 0 || proxyX >= proxyW || proxyY < 0 || proxyY >= proxyH) {
            this._container.style.display = 'none';
            return;
        }

        this._container.style.display = 'block';

        // Position loupe centered on cursor, relative to preview container
        const containerRect = this._previewImg.parentElement.getBoundingClientRect();
        const loupeSize = this._container.offsetWidth;
        const cx = mouseX + (imgRect.left - containerRect.left) - loupeSize / 2;
        const cy = mouseY + (imgRect.top - containerRect.top) - loupeSize / 2;
        this._container.style.left = `${cx}px`;
        this._container.style.top = `${cy}px`;

        // Coordinates label
        const docCoords = this._session.getDocumentCoords(proxyX, proxyY);
        if (this._coords) {
            this._coords.textContent = `${docCoords.x}, ${docCoords.y}`;
        }

        // Debounced tile fetch — position updates instantly, content follows
        this._lastProxyX = proxyX;
        this._lastProxyY = proxyY;
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            this._fetchAndRender(proxyX, proxyY);
        }, DEBOUNCE_MS);
    }

    _handleMouseLeave() {
        this._container.style.display = 'none';
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
    }

    async _fetchAndRender(proxyX, proxyY) {
        if (!this._active || !this._worker) return;

        // Generation counter: bump on every new request, stale fetches discard themselves
        const gen = ++this._fetchGeneration;

        const docCoords = this._session.getDocumentCoords(proxyX, proxyY);
        const halfTile = Math.round(LOUPE_TILE_SIZE / 2);
        const rect = {
            left: docCoords.x - halfTile,
            top: docCoords.y - halfTile,
            right: docCoords.x + halfTile,
            bottom: docCoords.y + halfTile
        };

        try {
            const { buffer, width, height } = await this._worker.renderLoupeTile(rect);

            // Discard if a newer fetch has started or loupe was deactivated
            if (gen !== this._fetchGeneration || !this._active) return;

            // Apply highlight isolation if a swatch is selected
            const highlightIdx = this._session.state.highlightColorIndex;
            if (highlightIdx >= 0) {
                this._applyHighlight(buffer, width, height, highlightIdx);
            }

            this._renderBuffer(buffer, width, height);
        } catch (err) {
            // Silently ignore (cursor near edge, document closed, etc.)
            if (gen === this._fetchGeneration) {
                console.error('[Loupe] Tile fetch failed:', err.message);
            }
        }
    }

    /**
     * Apply swatch isolation to RGBA buffer in-place.
     * Pixels NOT assigned to highlightIdx are dimmed to #282828.
     * Matches SessionState.generateHighlightPreview() behavior.
     *
     * @param {Uint8ClampedArray} rgba - RGBA buffer (mutated in place)
     * @param {number} width
     * @param {number} height
     * @param {number} highlightIdx - Palette index to isolate
     */
    _applyHighlight(rgba, width, height, highlightIdx) {
        // We need colorIndices to know which palette color each pixel maps to.
        // The RGBA buffer only has rendered colors — we can't recover the index.
        // Instead, compare each pixel to the highlight palette color's RGB.
        const proxy = this._session.proxyEngine;
        if (!proxy || !proxy.separationState) return;

        const palette = proxy.separationState.rgbPalette;
        if (!palette || highlightIdx >= palette.length) return;

        const targetColor = typeof palette[highlightIdx] === 'string'
            ? null  // hex string — skip (shouldn't happen)
            : palette[highlightIdx];
        if (!targetColor) return;

        const DIM = 0x28;
        const pixelCount = width * height;

        for (let i = 0; i < pixelCount; i++) {
            const off = i * 4;
            const r = rgba[off], g = rgba[off + 1], b = rgba[off + 2];

            // Check if this pixel matches the highlight color (exact match since
            // the buffer was rendered from the palette — colors are quantized)
            if (r !== targetColor.r || g !== targetColor.g || b !== targetColor.b) {
                rgba[off] = DIM;
                rgba[off + 1] = DIM;
                rgba[off + 2] = DIM;
            }
        }
    }

    /**
     * Encode RGBA buffer to JPEG and display via base64 data URL.
     * Same UXP-safe pattern as Preview.js.
     */
    _renderBuffer(rgbaBuffer, width, height) {
        let data = rgbaBuffer;
        if (data instanceof Uint8ClampedArray) {
            data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }

        const jpegData = jpeg.encode({
            data: data,
            width: width,
            height: height
        }, JPEG_QUALITY);

        const base64 = Loupe._uint8ToBase64(jpegData.data);
        this._img.src = `data:image/jpeg;base64,${base64}`;
    }

    static _uint8ToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
        }
        return btoa(binary);
    }
}

module.exports = Loupe;
