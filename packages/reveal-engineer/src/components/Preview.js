/**
 * Preview - Core scaling engine using pure CSS/DOM properties.
 *
 * This version uses a hybrid layout strategy to solve UXP scroll reach:
 * - Centered mode (Flexbox) for all views that fit within the viewport.
 * - Block mode (Top-Left pinned) for views that overflow, ensuring 100% reach.
 */

const jpeg = require("jpeg-js");
const { uint8ToBase64 } = require("../utils/base64");

const JPEG_QUALITY = 95;

class Preview {

    /**
     * @param {HTMLImageElement} imgElement
     * @param {HTMLElement} statusElement
     * @param {HTMLElement} placeholderElement
     * @param {import('../state/SessionState')} sessionState
     */
    constructor(imgElement, statusElement, placeholderElement, sessionState) {
        this._img = imgElement;
        this._status = statusElement;
        this._placeholder = placeholderElement;
        this._session = sessionState;

        this._dimensions = null;
        this._lastStatusText = '';
        this._zoomMode = 'fit';

        this._bindEvents();
        this._bindKeyboard();
        this._bindGestures();
    }

    _bindEvents() {
        this._session.on('proxyReady',      (d) => this._onProxyReady(d));
        this._session.on('previewUpdated',  (d) => this._onPreviewUpdated(d));
        this._session.on('scoringPreview',  (d) => this._onScoringPreview(d));
        this._session.on('processingStart', ()  => this._onProcessingStart());
        this._session.on('error',           (e) => this._onError(e));
        this._session.on('highlightChanged',(d) => this._onHighlightChanged(d));
    }

    _bindKeyboard() {
        const c = this._img ? this._img.parentElement : null;
        if (c) {
            c.addEventListener('click', () => {
                c.focus();
            });

            c.addEventListener('keydown', (e) => {
                // Only nudge if we have scrollbars (block mode)
                if (c.style.display === 'flex') return;
                
                const step = 60;
                switch (e.key) {
                    case 'ArrowUp':    c.scrollTop -= step; break;
                    case 'ArrowDown':  c.scrollTop += step; break;
                    case 'ArrowLeft':  c.scrollLeft -= step; break;
                    case 'ArrowRight': c.scrollLeft += step; break;
                    default: return;
                }
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            });
        }
    }

    _bindGestures() {
        const c = this._img ? this._img.parentElement : null;
        if (!c) return;

        // Aggressively capture wheel/trackpad events to prevent PS from stealing them
        c.addEventListener('wheel', (e) => {
            if (c.style.display === 'block') {
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        }, { passive: true });
    }

    setZoom(mode) {
        this._zoomMode = mode;
        this._applyZoom();
    }

    _applyZoom() {
        if (!this._img || !this._dimensions) return;

        const container = this._img.parentElement;
        if (!container) return;

        requestAnimationFrame(() => {
            const cw = container.clientWidth;
            const ch = container.clientHeight;
            
            // If UXP hasn't laid out the container yet, defer for one frame
            if (cw === 0 || ch === 0) {
                requestAnimationFrame(() => this._applyZoom());
                return;
            }

            const iw = this._dimensions.width;
            const ih = this._dimensions.height;

            if (this._zoomMode === 'fit') {
                container.style.display = 'flex';
                container.style.overflow = 'hidden';
                container.scrollLeft = 0;
                container.scrollTop = 0;

                this._img.style.width = 'auto';
                this._img.style.height = 'auto';
                this._img.style.maxWidth = '100%';
                this._img.style.maxHeight = '100%';
                this._img.style.objectFit = 'contain';
            } else {
                const scale = parseFloat(this._zoomMode);
                const targetW = iw * scale;
                const targetH = ih * scale;

                // Only switch to Block mode if the zoomed image actually exceeds the panel size
                // We add a 20px buffer to account for UI chrome and UXP measurement jitter.
                const overflows = targetW > (cw - 20) || targetH > (ch - 20);

                if (overflows) {
                    container.style.display = 'block';
                    container.style.overflow = 'auto';
                } else {
                    // Small zoomed views stay centered like "Fit"
                    container.style.display = 'flex';
                    container.style.overflow = 'hidden';
                    container.scrollLeft = 0;
                    container.scrollTop = 0;
                }

                this._img.style.maxWidth = 'none';
                this._img.style.maxHeight = 'none';
                this._img.style.width = targetW + 'px';
                this._img.style.height = targetH + 'px';
            }

            this._updateStatus();
        });
    }

    _updateStatus() {
        let zoomLabel = this._zoomMode === 'fit' ? 'Fit' : (parseFloat(this._zoomMode) * 100) + '%';
        const dims = this._dimensions ? `${this._dimensions.width}×${this._dimensions.height}` : '';
        const statusText = this._lastStatusText ? ` | ${this._lastStatusText}` : '';
        this._setStatus(`${dims} | Zoom: ${zoomLabel}${statusText}`);
    }

    _setStatus(text) {
        if (this._status) this._status.textContent = text;
    }

    _renderBuffer(rgbaBuffer, width, height) {
        if (!rgbaBuffer || !width || !height) throw new Error('No preview data');

        let data = rgbaBuffer;
        if (data instanceof Uint8ClampedArray) {
            data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }

        const jpegData = jpeg.encode({ data, width, height }, JPEG_QUALITY);
        const base64 = `data:image/jpeg;base64,${uint8ToBase64(jpegData.data)}`;
        
        this._img.src = base64;

        this._dimensions = { width, height };
        this._applyZoom();
    }

    _showError(msg) {
        if (this._placeholder) {
            this._placeholder.textContent = msg;
            this._placeholder.style.display = 'block';
            this._placeholder.style.color = '#ff6b6b';
        }
        if (this._img) this._img.style.display = 'none';
    }

    _onScoringPreview(data) {
        if (!data.previewBuffer) return;
        this._renderBuffer(data.previewBuffer, data.width, data.height);
    }

    _onProxyReady(data) {
        this._dimensions = data.dimensions;
        this._renderBuffer(data.previewBuffer, data.dimensions.width, data.dimensions.height);
    }

    _onPreviewUpdated(data) {
        this._lastStatusText = `${data.elapsedMs.toFixed(0)}ms`;
        this._renderBuffer(data.previewBuffer, data.dimensions.width, data.dimensions.height);
    }

    _onHighlightChanged(data) {
        const buf = data.ghostBuffer || this._session.getPreview();
        if (buf && this._dimensions) {
            this._renderBuffer(buf, this._dimensions.width, this._dimensions.height);
        }
    }

    _onProcessingStart() { this._setStatus('Analyzing...'); }
    _onError(err)        { this._showError(err.message); }

    _resetToFit() { this.setZoom('fit'); }
}

module.exports = Preview;
