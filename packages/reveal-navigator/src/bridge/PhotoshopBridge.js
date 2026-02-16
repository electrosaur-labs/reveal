/**
 * PhotoshopBridge - Image ingest from active Photoshop document
 *
 * Follows the EXACT proven pattern from reveal-adobe's PhotoshopAPI:
 * - Always reads componentSize: 8 (UXP limitation — 16-bit reads lose chroma)
 * - Uses imaging.getPixels() with targetSize for proxy-size reads
 * - Extracts via imageData.getData() or pixelData.pixels
 * - Upconverts 8-bit Lab → 16-bit Lab for engine compatibility
 *
 * Requirements:
 *   - Document must be in Lab color mode
 *   - Returns 3-channel Lab data (no alpha)
 *   - Always outputs 16-bit encoding
 */

const { app, core, action } = require("photoshop");
const { imaging } = require("photoshop");

class PhotoshopBridge {

    /**
     * Get active document metadata (name, layer, mode).
     * Returns null if no document is open.
     */
    static getDocumentInfo() {
        const doc = app.activeDocument;
        if (!doc) return null;

        let layerName = '';
        try {
            if (doc.activeLayers && doc.activeLayers.length > 0) {
                layerName = doc.activeLayers[0].name;
            }
        } catch (_) { /* layer access can fail on locked backgrounds */ }

        return {
            name: doc.name || 'Untitled',
            layerName: layerName,
            mode: String(doc.mode),
            width: doc.width,
            height: doc.height
        };
    }

    /**
     * Read the active document's pixels as 16-bit Lab.
     *
     * CRITICAL: Always reads componentSize: 8. UXP's imaging.getPixels()
     * does not return correct a/b channels at componentSize: 16.
     * This matches the reveal-adobe proven pattern.
     *
     * @param {number} [maxSize] - Maximum dimension (long edge). Photoshop handles resize.
     * @returns {Promise<{labPixels: Uint16Array, width: number, height: number, originalWidth: number, originalHeight: number}>}
     */
    static async getDocumentLab(maxSize) {
        const doc = app.activeDocument;
        if (!doc) {
            throw new Error('No active document');
        }

        const docWidth = doc.width;
        const docHeight = doc.height;

        // Build getPixels args
        // ALWAYS componentSize: 8 — UXP limitation (reveal-adobe proven pattern)
        const getPixelsArgs = {
            documentID: doc.id,
            componentSize: 8,
            targetComponentCount: 3,
            colorSpace: "Lab"
        };

        // Use targetSize for proxy-size reads (let Photoshop handle downsampling)
        if (maxSize) {
            const scale = Math.min(1.0, maxSize / docWidth, maxSize / docHeight);
            getPixelsArgs.targetSize = {
                width: Math.round(docWidth * scale),
                height: Math.round(docHeight * scale)
            };
        }

        // Read pixels — exact reveal-adobe pattern
        const pixelData = await core.executeAsModal(async () => {
            return await imaging.getPixels(getPixelsArgs);
        }, { commandName: "Navigator: Read Document Pixels" });

        // Extract raw pixel buffer — same two-path pattern as reveal-adobe
        let rawPixels;
        let actualWidth, actualHeight;

        if (pixelData.imageData) {
            actualWidth = pixelData.imageData.width;
            actualHeight = pixelData.imageData.height;
            rawPixels = await core.executeAsModal(async () => {
                return await pixelData.imageData.getData({ chunky: true });
            }, { commandName: "Navigator: Extract Pixel Data" });
        } else if (pixelData.pixels) {
            actualWidth = maxSize ? getPixelsArgs.targetSize.width : docWidth;
            actualHeight = maxSize ? getPixelsArgs.targetSize.height : docHeight;
            rawPixels = pixelData.pixels;
        } else {
            throw new Error('Unexpected pixel data format from imaging.getPixels');
        }

        // Validate channel count (3 channels: L, a, b)
        const expectedPixels = actualWidth * actualHeight * 3;
        if (rawPixels.length !== expectedPixels) {
            throw new Error(
                `Unexpected pixel count: got ${rawPixels.length}, expected ${expectedPixels} ` +
                `(${actualWidth}x${actualHeight}x3)`
            );
        }

        // Upconvert 8-bit Lab → 16-bit Lab encoding for engine compatibility
        const lab16 = PhotoshopBridge.lab8to16(rawPixels);

        return {
            labPixels: lab16,
            width: actualWidth,
            height: actualHeight,
            originalWidth: docWidth,
            originalHeight: docHeight
        };
    }

    /**
     * Read a native-resolution tile from the active document.
     * Used by Loupe for 1:1 pixel inspection of a small region.
     *
     * @param {{left: number, top: number, right: number, bottom: number}} rect - Document pixel bounds
     * @returns {Promise<{labPixels: Uint16Array, width: number, height: number}>}
     */
    static async getTileLab(rect) {
        const doc = app.activeDocument;
        if (!doc) {
            throw new Error('No active document');
        }

        // Clamp to document bounds
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(doc.width, rect.right);
        const bottom = Math.min(doc.height, rect.bottom);

        if (right <= left || bottom <= top) {
            throw new Error('Tile rect is outside document bounds');
        }

        const getPixelsArgs = {
            documentID: doc.id,
            componentSize: 8,
            targetComponentCount: 3,
            colorSpace: "Lab",
            sourceBounds: { left, top, right, bottom }
        };

        const pixelData = await core.executeAsModal(async () => {
            return await imaging.getPixels(getPixelsArgs);
        }, { commandName: "Navigator: Read Tile Pixels" });

        let rawPixels, actualWidth, actualHeight;

        if (pixelData.imageData) {
            actualWidth = pixelData.imageData.width;
            actualHeight = pixelData.imageData.height;
            rawPixels = await core.executeAsModal(async () => {
                return await pixelData.imageData.getData({ chunky: true });
            }, { commandName: "Navigator: Extract Tile Data" });
        } else if (pixelData.pixels) {
            actualWidth = right - left;
            actualHeight = bottom - top;
            rawPixels = pixelData.pixels;
        } else {
            throw new Error('Unexpected pixel data format from imaging.getPixels');
        }

        const lab16 = PhotoshopBridge.lab8to16(rawPixels);

        return {
            labPixels: lab16,
            width: actualWidth,
            height: actualHeight
        };
    }

    /**
     * Embed a separation manifest into the active document's metadata.
     * Writes JSON to dc:description via batchPlay fileInfo.caption.
     * Prefixed with "REVEAL:" for identification.
     *
     * Note: UXP does not expose doc.xmpMetadata.rawData, and batchPlay
     * XMPMetadataAsUTF8 SET fails (-1715/-25920). fileInfo.caption is the
     * only reliable write path in UXP.
     *
     * Must be called inside executeAsModal.
     *
     * @param {Object} manifest - Manifest object from SessionState.buildManifest()
     */
    static async writeManifestXMP(manifest) {
        await action.batchPlay([{
            _obj: "set",
            _target: [
                { _ref: "property", _property: "fileInfo" },
                { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
            ],
            to: {
                _obj: "fileInfo",
                caption: "REVEAL:" + JSON.stringify(manifest)
            }
        }], {});
    }

    /**
     * Convert 8-bit Lab encoding to 16-bit Lab encoding.
     *
     * 8-bit:  L 0-255 (→0-100), a/b 0-255 (128=neutral, →-128..+127)
     * 16-bit: L 0-32768 (→0-100), a/b 0-32768 (16384=neutral, →-128..+128)
     */
    static lab8to16(lab8) {
        const lab16 = new Uint16Array(lab8.length);
        const lScale = 32768 / 255;
        const abScale = 16384 / 128;

        for (let i = 0; i < lab8.length; i += 3) {
            lab16[i]     = Math.round(lab8[i] * lScale);
            lab16[i + 1] = Math.round((lab8[i + 1] - 128) * abScale + 16384);
            lab16[i + 2] = Math.round((lab8[i + 2] - 128) * abScale + 16384);
        }

        return lab16;
    }
}

module.exports = PhotoshopBridge;
