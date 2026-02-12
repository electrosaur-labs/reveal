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

const JPEG_QUALITY = 95;
const CHUNK_SIZE = 0x8000; // 32KB chunks for String.fromCharCode.apply

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

        this._bindEvents();
    }

    _bindEvents() {
        this._session.on('proxyReady', (data) => this._onProxyReady(data));
        this._session.on('previewUpdated', (data) => this._onPreviewUpdated(data));
        this._session.on('processingStart', () => this._onProcessingStart());
        this._session.on('error', (err) => this._onError(err));
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
            this._renderBuffer(data.previewBuffer, this._dimensions.width, this._dimensions.height);
            this._setStatus(`${data.elapsedMs.toFixed(0)}ms`);
            this._setAccuracy(data.accuracyDeltaE);
        } catch (err) {
            this._showError('Update failed: ' + err.message);
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

        // Use btoa() + String.fromCharCode — proven pattern from reveal-adobe
        const base64 = Preview._uint8ToBase64(jpegData.data);
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

    /**
     * Convert Uint8Array to base64 using btoa() — same pattern as reveal-adobe.
     * Uses chunked String.fromCharCode.apply to avoid call stack overflow.
     */
    static _uint8ToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
        }
        return btoa(binary);
    }
}

module.exports = Preview;
