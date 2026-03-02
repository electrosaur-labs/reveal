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
const { uint8ToBase64 } = require("../utils/base64");
const logger = Reveal.logger;

const JPEG_QUALITY = 92;
const LOUPE_TILE_SIZE = 256;       // Native-res tile: 256px = true 1:1 in 256px loupe
const DEBOUNCE_MS = 80;            // Fast debounce for responsive feel

class Loupe {

    /**
     * @param {HTMLElement} container - #loupe-container element
     * @param {HTMLImageElement} loupeImg - #loupe-img element
     * @param {HTMLElement} coordsLabel - #loupe-coords element
     * @param {HTMLImageElement} previewImg - The main preview <img> for mouse tracking
     * @param {import('../state/SessionState')} sessionState
     * @param {HTMLElement} [erevLabel] - #loupe-erev element (optional)
     */
    constructor(container, loupeImg, coordsLabel, previewImg, sessionState, erevLabel) {
        this._container = container;
        this._img = loupeImg;
        this._coords = coordsLabel;
        this._erevLabel = erevLabel || null;
        this._previewImg = previewImg;
        this._session = sessionState;
        this._active = false;
        this._zoomFactor = 1;       // 1 = 1:1, 2 = 1:2, 4 = 1:4, 8 = 1:8
        this._debounceTimer = null;
        this._worker = null;
        this._isFetching = false;   // Serialize fetches — only one in flight at a time
        this._pendingFetch = null;  // Queued {proxyX, proxyY} while fetch is in flight
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

    /** Set zoom factor (1, 2, 4, 8). Tile covers factor × 256 native pixels. */
    setZoom(factor) {
        this._zoomFactor = factor;
        // Re-render current tile at new zoom if active
        if (this._active && this._lastProxyX != null) {
            this._fetchAndRender(this._lastProxyX, this._lastProxyY);
        }
    }

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
        this._pendingFetch = null;  // Drop any queued fetch
        this._container.style.display = 'none';
        if (this._erevLabel) this._erevLabel.setAttribute('style', 'display: none');
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
        const sep = this._session.getSeparationState();
        if (!sep) return;

        const proxyW = sep.width;
        const proxyH = sep.height;

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

        // Debounced tile fetch — position updates instantly, content follows.
        // Scale debounce with zoom: higher zoom = larger PS read = longer fetch.
        this._lastProxyX = proxyX;
        this._lastProxyY = proxyY;
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        const debounce = this._zoomFactor > 1 ? DEBOUNCE_MS * 2 : DEBOUNCE_MS;
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            this._fetchAndRender(proxyX, proxyY);
        }, debounce);
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

        // Serialize fetches: only one in flight at a time.
        // At zoom > 1:1, PS getPixels with targetSize takes longer; concurrent
        // modal calls congest the UXP queue causing intermittent failures/white frames.
        if (this._isFetching) {
            this._pendingFetch = { proxyX, proxyY };
            return;
        }

        this._isFetching = true;
        this._pendingFetch = null;

        const docCoords = this._session.getDocumentCoords(proxyX, proxyY);
        const halfTile = Math.round((LOUPE_TILE_SIZE * this._zoomFactor) / 2);
        const rect = {
            left: docCoords.x - halfTile,
            top: docCoords.y - halfTile,
            right: docCoords.x + halfTile,
            bottom: docCoords.y + halfTile
        };

        // When zoomed out (>1:1), pass the downsample factor so renderLoupeTile
        // reads native-res pixels and box-filter downsamples before separation.
        // (PS getPixels sourceBounds + targetSize produces wrong crops.)
        const downsampleFactor = this._zoomFactor > 1 ? this._zoomFactor : undefined;

        try {
            const result = await this._worker.renderLoupeTile(rect, downsampleFactor);
            const { buffer, width, height, eRev } = result;

            // Only render if loupe is still active (may have been deactivated during fetch)
            if (!this._active) return;

            // Update E_rev display
            if (this._erevLabel) {
                if (eRev != null) {
                    this._erevLabel.textContent = `\u0394E ${eRev.toFixed(1)}`;
                    const color = eRev < 5 ? '#6fcf6f' : eRev < 10 ? '#e0a030' : '#e05050';
                    this._erevLabel.setAttribute('style',
                        `display: inline; color: ${color}`);
                } else {
                    this._erevLabel.setAttribute('style', 'display: none');
                }
            }

            // Apply highlight isolation if a swatch is selected
            const highlightIdx = this._session.state.highlightColorIndex;
            if (highlightIdx >= 0) {
                this._applyHighlight(buffer, width, height, highlightIdx);
            } else if (highlightIdx === -2 && this._session._ghostLabColor) {
                this._applySuggestionGhost(buffer, width, height, this._session._ghostLabColor, result, this._session._ghostMode);
            }

            this._renderBuffer(buffer, width, height);
        } catch (err) {
            if (this._active) {
                logger.log('[Loupe] Tile fetch failed:', err.message);
            }
        } finally {
            this._isFetching = false;

            // If a newer position was requested while we were fetching, use the
            // LATEST cursor position (not the stale queued one) so the tile
            // always matches where the loupe circle currently sits.
            if (this._active && this._pendingFetch) {
                this._pendingFetch = null;
                if (this._lastProxyX != null) {
                    this._fetchAndRender(this._lastProxyX, this._lastProxyY);
                }
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
        const sep = this._session.getSeparationState();
        if (!sep) return;

        const palette = sep.rgbPalette;
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
     * Apply suggestion ghost to RGBA buffer in-place.
     * Pixels closer to the suggested color than their current palette assignment
     * are recolored to the suggestion's RGB. Others keep their palette color.
     * Matches SessionState.generateSuggestionGhostPreview() behavior.
     */
    _applySuggestionGhost(rgba, width, height, ghostLab, tileResult, mode) {
        if (!tileResult || !tileResult.labPixels || !tileResult.colorIndices || !tileResult.labPalette) return;

        const { labPixels, colorIndices, labPalette } = tileResult;
        const sugRgb = Reveal.labToRgbD50(ghostLab);
        const pixelCount = width * height;
        const solo = (mode === 'solo');

        // 16-bit Lab encoding constants
        const L_SCALE = 327.68;
        const AB_NEUTRAL = 16384;
        const AB_SCALE = 128;

        for (let i = 0; i < pixelCount; i++) {
            const off3 = i * 3;
            const off4 = i * 4;

            const pL = labPixels[off3] / L_SCALE;
            const pa = (labPixels[off3 + 1] - AB_NEUTRAL) / AB_SCALE;
            const pb = (labPixels[off3 + 2] - AB_NEUTRAL) / AB_SCALE;

            // Distance to suggestion
            const dSL = pL - ghostLab.L;
            const dSA = pa - ghostLab.a;
            const dSB = pb - ghostLab.b;
            const distSug = dSL * dSL + dSA * dSA + dSB * dSB;

            // Distance to current palette assignment
            const ci = colorIndices[i];
            const assigned = labPalette[ci];
            if (!assigned) continue;
            const dAL = pL - assigned.L;
            const dAA = pa - assigned.a;
            const dAB = pb - assigned.b;
            const distPal = dAL * dAL + dAA * dAA + dAB * dAB;

            if (distSug < distPal) {
                rgba[off4]     = sugRgb.r;
                rgba[off4 + 1] = sugRgb.g;
                rgba[off4 + 2] = sugRgb.b;
            } else if (solo) {
                rgba[off4]     = 0x28;
                rgba[off4 + 1] = 0x28;
                rgba[off4 + 2] = 0x28;
            }
            // else: keep existing palette RGB (already in buffer)
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

        const base64 = uint8ToBase64(jpegData.data);
        this._img.src = `data:image/jpeg;base64,${base64}`;
    }

}

module.exports = Loupe;
