/**
 * Preview - Renders the 512px proxy buffer into an <img> element.
 *
 * UXP does NOT support ImageData or canvas putImageData.
 * Uses jpeg-js to encode RGBA -> JPEG -> base64 data URL -> img.src.
 *
 * Base64 encoding uses btoa() + String.fromCharCode() — the same pattern
 * proven in the working reveal-adobe plugin. Do NOT use Buffer polyfill.
 */

const jpeg = require("jpeg-js");
const { uint8ToBase64 } = require("../utils/base64");

const JPEG_QUALITY = 95;

class Preview {

    /**
     * @param {HTMLImageElement} imgElement - The <img> to render into
     * @param {HTMLElement} statusElement - Element for timing display
     * @param {HTMLElement} accuracyElement - Element for Delta-E readout
     * @param {HTMLElement} placeholderElement - Placeholder text element (for error display)
     * @param {import('../state/SessionState')} sessionState
     */
    constructor(imgElement, statusElement, accuracyElement, placeholderElement, sessionState) {
        this._img = imgElement;
        this._status = statusElement;
        this._accuracy = accuracyElement;
        this._placeholder = placeholderElement;
        this._session = sessionState;
        this._dimensions = null;

        // Blink comparator state
        this._showingOriginal = false;
        this._holdTimer = null;
        this._blinkInterval = null;
        this._blinkMode = false;

        // Corner label for "ORIGINAL" indicator
        this._originalLabel = this._createOriginalLabel();

        this._bindEvents();
        this._bindBlinkComparator();
    }

    _bindEvents() {
        this._session.on('proxyReady', (data) => this._onProxyReady(data));
        this._session.on('previewUpdated', (data) => this._onPreviewUpdated(data));
        this._session.on('scoringPreview', (data) => this._onScoringPreview(data));
        this._session.on('processingStart', () => this._onProcessingStart());
        this._session.on('error', (err) => this._onError(err));
        this._session.on('highlightChanged', (data) => this._onHighlightChanged(data));
    }

    /**
     * Blink comparator: click preview to toggle original/posterized.
     * Hold click > 300ms to enter blink mode (alternates every 400ms).
     * Release from blink snaps back to posterized.
     */
    _bindBlinkComparator() {
        if (!this._img) return;

        this._img.addEventListener('pointerdown', (e) => {
            // Skip if highlight active or no preview ready
            if (this._session.state.highlightColorIndex >= 0) return;
            if (!this._session.state.proxyBufferReady) return;

            // Immediate: show original
            this.showOriginal();

            // After 300ms, enter blink mode
            this._holdTimer = setTimeout(() => {
                this._blinkMode = true;
                this._blinkInterval = setInterval(() => {
                    if (this._showingOriginal) {
                        this.showPosterized();
                    } else {
                        this.showOriginal();
                    }
                }, 400);
            }, 300);
        });

        this._img.addEventListener('pointerup', () => {
            this._clearBlinkTimers();

            if (this._blinkMode) {
                // Was holding — snap back to posterized
                this._blinkMode = false;
                this.showPosterized();
            }
            // Tap: leave toggled (tap again to swap back)
        });

        this._img.addEventListener('pointerleave', () => {
            // If pointer leaves the image while held, cancel blink
            if (this._holdTimer || this._blinkInterval) {
                this._clearBlinkTimers();
                this._blinkMode = false;
                this.showPosterized();
            }
        });
    }

    /** @private */
    _clearBlinkTimers() {
        if (this._holdTimer) { clearTimeout(this._holdTimer); this._holdTimer = null; }
        if (this._blinkInterval) { clearInterval(this._blinkInterval); this._blinkInterval = null; }
    }

    _onScoringPreview(data) {
        try {
            if (!this._dimensions || !data.previewBuffer) return;
            this._renderBuffer(data.previewBuffer, this._dimensions.width, this._dimensions.height);
        } catch (_) {
            // Non-critical — scoring continues even if preview render fails
        }
    }

    _onProxyReady(data) {
        try {
            this._dimensions = data.dimensions;
            this._renderBuffer(data.previewBuffer, data.dimensions.width, data.dimensions.height);
            this._setStatus(`${data.dimensions.width}\u00d7${data.dimensions.height} proxy | ${data.elapsedMs.toFixed(0)}ms`);
        } catch (err) {
            this._showError('Preview render failed: ' + err.message);
        }
    }

    _onPreviewUpdated(data) {
        try {
            if (!this._dimensions) return;

            // Snap back from original view — the posterized data just changed
            this._showingOriginal = false;
            if (this._originalLabel) this._originalLabel.setAttribute('style',
                'position: absolute; top: 8px; left: 8px; ' +
                'font-size: 11px; font-weight: bold; color: #e0a030; ' +
                'background: rgba(0,0,0,0.6); padding: 2px 6px; border-radius: 3px; ' +
                'pointer-events: none; z-index: 10; display: none;'
            );

            // If a color is highlighted, regenerate isolation preview from updated separation
            const highlightIdx = this._session.state.highlightColorIndex;
            if (highlightIdx >= 0) {
                const hlBuf = this._session.generateHighlightPreview(highlightIdx);
                if (hlBuf) {
                    this._renderBuffer(hlBuf, this._dimensions.width, this._dimensions.height);
                } else {
                    this._renderBuffer(data.previewBuffer, this._dimensions.width, this._dimensions.height);
                }
            } else {
                this._renderBuffer(data.previewBuffer, this._dimensions.width, this._dimensions.height);
            }

            this._setStatus(`${data.elapsedMs.toFixed(0)}ms`);
            this._setAccuracy(data.accuracyDeltaE);
        } catch (err) {
            this._showError('Update failed: ' + err.message);
        }
    }

    _onHighlightChanged(data) {
        try {
            if (!this._dimensions) return;

            if (data.colorIndex >= 0) {
                const hlBuf = this._session.generateHighlightPreview(data.colorIndex);
                if (hlBuf) {
                    this._renderBuffer(hlBuf, this._dimensions.width, this._dimensions.height);
                }
            } else {
                // Restore normal preview
                const normalBuf = this._session.getPreview();
                if (normalBuf) {
                    this._renderBuffer(normalBuf, this._dimensions.width, this._dimensions.height);
                }
            }
        } catch (err) {
            this._showError('Highlight failed: ' + err.message);
        }
    }

    _onProcessingStart() {
        this._setStatus('Analyzing...');
    }

    _onError(err) {
        this._showError(err.message);
    }

    /**
     * Show error prominently in the preview area (not just status bar).
     */
    _showError(msg) {
        this._setStatus('Error');
        this._setAccuracy(null);
        // Show error in the placeholder area so it's impossible to miss
        if (this._placeholder) {
            this._placeholder.textContent = msg;
            this._placeholder.style.display = 'block';
            this._placeholder.style.color = '#ff6b6b';
        }
        if (this._img) {
            this._img.style.display = 'none';
        }
    }

    // ─── Blink Comparator ─────────────────────────────────────

    /**
     * Create the "ORIGINAL" corner label overlay.
     * @returns {HTMLElement}
     * @private
     */
    _createOriginalLabel() {
        const label = document.createElement('span');
        label.textContent = 'ORIGINAL';
        label.setAttribute('style',
            'position: absolute; top: 8px; left: 8px; ' +
            'font-size: 11px; font-weight: bold; color: #e0a030; ' +
            'background: rgba(0,0,0,0.6); padding: 2px 6px; border-radius: 3px; ' +
            'pointer-events: none; z-index: 10; display: none;'
        );
        // Insert label next to the preview image
        if (this._img && this._img.parentElement) {
            this._img.parentElement.appendChild(label);
        }
        return label;
    }

    /**
     * Show the original (pre-posterization) proxy image.
     * No-op if highlight is active or no preview available.
     */
    showOriginal() {
        if (!this._dimensions) return;
        if (this._session.state.highlightColorIndex >= 0) return;

        const original = this._session.getOriginalPreviewBuffer();
        if (!original) return;

        this._renderBuffer(original.buffer, original.width, original.height);
        this._showingOriginal = true;
        if (this._originalLabel) this._originalLabel.setAttribute('style',
            'position: absolute; top: 8px; left: 8px; ' +
            'font-size: 11px; font-weight: bold; color: #e0a030; ' +
            'background: rgba(0,0,0,0.6); padding: 2px 6px; border-radius: 3px; ' +
            'pointer-events: none; z-index: 10; display: block;'
        );
    }

    /**
     * Show the posterized preview (normal view).
     */
    showPosterized() {
        if (!this._dimensions) return;

        const buf = this._session.getPreview();
        if (!buf) return;

        this._renderBuffer(buf, this._dimensions.width, this._dimensions.height);
        this._showingOriginal = false;
        if (this._originalLabel) this._originalLabel.setAttribute('style',
            'position: absolute; top: 8px; left: 8px; ' +
            'font-size: 11px; font-weight: bold; color: #e0a030; ' +
            'background: rgba(0,0,0,0.6); padding: 2px 6px; border-radius: 3px; ' +
            'pointer-events: none; z-index: 10; display: none;'
        );
    }

    /** @returns {boolean} Whether the original image is currently displayed */
    isShowingOriginal() {
        return this._showingOriginal;
    }

    /**
     * Encode RGBA buffer to JPEG and display via base64 data URL.
     * Uses the exact same btoa() pattern proven in reveal-adobe.
     */
    _renderBuffer(rgbaBuffer, width, height) {
        if (!rgbaBuffer || !width || !height) {
            throw new Error('No preview data');
        }

        // Ensure the buffer is Uint8Array for jpeg-js
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

        // Make image visible, hide placeholder
        this._img.style.display = 'block';
        if (this._placeholder) {
            this._placeholder.style.display = 'none';
        }
    }

    _setStatus(text) {
        if (this._status) this._status.textContent = text;
    }

    _setAccuracy(deltaE) {
        if (!this._accuracy) return;
        this._accuracy.textContent = deltaE !== null && deltaE !== undefined
            ? `\u0394E ${deltaE.toFixed(1)}`
            : '';
    }

}

module.exports = Preview;
