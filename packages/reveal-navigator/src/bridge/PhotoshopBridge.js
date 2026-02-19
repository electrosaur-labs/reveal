/**
 * PhotoshopBridge - Image ingest from active Photoshop document
 *
 * Reads Lab pixels via imaging.getPixels() with componentSize: 16.
 * Returns native 16-bit Lab encoding (L: 0-32768, a/b: 0-32768, 16384=neutral).
 *
 * History: Previously forced componentSize:8 due to suspected UXP bug where
 * 16-bit reads returned neutral a/b channels. Diagnostic testing (2026-02-16)
 * confirmed componentSize:16 returns correct chroma — switched to native 16-bit.
 *
 * Requirements:
 *   - Document must be in Lab color mode
 *   - Returns 3-channel Lab data (no alpha)
 *   - Always outputs 16-bit encoding (Photoshop standard: 0-32768)
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
            height: doc.height,
            layerCount: doc.layers ? doc.layers.length : 1
        };
    }

    /**
     * Read the active document's pixels as 16-bit Lab.
     *
     * Uses native componentSize: 16 — returns Photoshop standard encoding
     * (L: 0-32768, a/b: 0-32768, 16384=neutral) directly as Uint16Array.
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

        // Build getPixels args — native 16-bit Lab read
        const getPixelsArgs = {
            documentID: doc.id,
            componentSize: 16,
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

        // rawPixels is already native 16-bit Lab (Uint16Array, 0-32768 encoding)
        return {
            labPixels: rawPixels,
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
    static async getTileLab(rect, targetSize) {
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
            componentSize: 16,
            targetComponentCount: 3,
            colorSpace: "Lab",
            sourceBounds: { left, top, right, bottom }
        };

        // Optional PS-side downsampling (used by loupe zoom > 1:1)
        if (targetSize) {
            getPixelsArgs.targetSize = targetSize;
        }

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
            // When targetSize is used, PS returns downsampled dimensions
            actualWidth = targetSize ? targetSize.width : (right - left);
            actualHeight = targetSize ? targetSize.height : (bottom - top);
            rawPixels = pixelData.pixels;
        } else {
            throw new Error('Unexpected pixel data format from imaging.getPixels');
        }

        // rawPixels is already native 16-bit Lab (Uint16Array, 0-32768 encoding)
        return {
            labPixels: rawPixels,
            width: actualWidth,
            height: actualHeight
        };
    }

    /**
     * Embed a separation manifest into the active document's metadata.
     *
     * Tier 1: Writes multiple IPTC fields via batchPlay fileInfo —
     *   headline, instructions, author, keywords, caption (JSON payload).
     *   These are human-readable in File > File Info.
     *
     * Must be called inside executeAsModal.
     *
     * @param {Object} manifest - Manifest object from SessionState.buildManifest()
     */
    static async writeManifestXMP(manifest) {
        // ── Build human-readable IPTC fields ──

        // Headline: archetype name + color count
        const archetypeName = (manifest.archetype && manifest.archetype.name) || 'Unknown';
        const layerCount = (manifest.metrics && manifest.metrics.layerCount) || 0;
        const headline = `Reveal: ${archetypeName} — ${layerCount} colors`;

        // Instructions: multi-line summary of archetype, palette, metric, knobs
        const instrLines = [];
        if (manifest.archetype) {
            instrLines.push(`Archetype: ${archetypeName} (score: ${manifest.archetype.score})`);
        }
        if (manifest.palette && manifest.palette.length > 0) {
            const hexList = manifest.palette.map(c => c.hex).join(', ');
            instrLines.push(`Palette: ${hexList}`);
        }
        if (manifest.config) {
            instrLines.push(`Metric: ${manifest.config.distanceMetric || 'cie76'}, Dither: ${manifest.config.ditherType || 'none'}`);
        }
        if (manifest.metrics && manifest.metrics.avgDeltaE != null) {
            instrLines.push(`Avg ΔE: ${manifest.metrics.avgDeltaE.toFixed(2)}`);
        }
        if (manifest.knobs) {
            const k = manifest.knobs;
            const parts = [];
            if (k.minVolume != null) parts.push(`minVol=${k.minVolume}`);
            if (k.speckleRescue != null) parts.push(`speckle=${k.speckleRescue}`);
            if (k.shadowClamp != null) parts.push(`shadow=${k.shadowClamp}`);
            if (k.trapSize != null) parts.push(`trap=${k.trapSize}`);
            if (parts.length > 0) instrLines.push(`Knobs: ${parts.join(', ')}`);
        }
        const instructions = instrLines.join('\n');

        // Author
        const author = (manifest.meta && manifest.meta.generator) || 'Reveal Navigator v1.0.0';

        // Keywords: archetype name + hex codes
        const keywords = [archetypeName];
        if (manifest.palette) {
            for (const c of manifest.palette) {
                if (c.hex) keywords.push(c.hex);
            }
        }

        // Build the fileInfo descriptor
        const fileInfoDesc = {
            _obj: "fileInfo",
            caption: "REVEAL:" + JSON.stringify(manifest),
            headline: headline,
            instructions: instructions,
            byline: author
        };

        // Keywords need a special list descriptor format
        if (keywords.length > 0) {
            fileInfoDesc.keywords = keywords;
        }

        await action.batchPlay([{
            _obj: "set",
            _target: [
                { _ref: "property", _property: "fileInfo" },
                { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
            ],
            to: fileInfoDesc
        }], {});
    }

    /**
     * Tier 2: Write structured XMP with custom reveal: namespace.
     * Uses require('uxp').xmp for proper XMP serialization.
     *
     * Experimental — may fail on some UXP versions. Caller should
     * wrap in try/catch and treat failure as non-fatal.
     *
     * Must be called inside executeAsModal.
     *
     * @param {Object} manifest - Manifest object from SessionState.buildManifest()
     * @returns {Promise<boolean>} true if structured XMP was written and verified
     */
    static async writeStructuredXMP(manifest) {
        // ── Step 1: Load XMP module ──
        const xmpModule = require('uxp').xmp;
        if (!xmpModule || !xmpModule.XMPMeta) {
            throw new Error('uxp.xmp module not available');
        }
        const { XMPMeta, XMPConst } = xmpModule;

        // ── Step 2: Read existing XMP from document ──
        const getResult = await action.batchPlay([{
            _obj: "get",
            _target: [
                { _ref: "property", _property: "XMPMetadataAsUTF8" },
                { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
            ]
        }], {});

        const existingXMP = (getResult && getResult[0] && getResult[0].XMPMetadataAsUTF8)
            ? getResult[0].XMPMetadataAsUTF8
            : '';

        // ── Step 3: Parse and modify XMP ──
        const xmp = existingXMP ? new XMPMeta(existingXMP) : new XMPMeta();

        const NS = 'http://electrosaur.org/reveal/1.0/';
        XMPMeta.registerNamespace(NS, 'reveal');

        // Simple property helper
        const setProp = (name, value) => {
            if (value != null) {
                xmp.setProperty(NS, name, String(value));
            }
        };

        // ── Step 4: Write structured properties ──
        setProp('version', '2.0');

        // Archetype info
        if (manifest.archetype) {
            setProp('archetype', manifest.archetype.id);
            setProp('archetypeName', manifest.archetype.name);
            setProp('archetypeScore', manifest.archetype.score);
        }

        // Config
        if (manifest.config) {
            setProp('targetColors', manifest.config.targetColors);
            setProp('distanceMetric', manifest.config.distanceMetric);
            setProp('ditherType', manifest.config.ditherType);
        }

        // Metrics
        if (manifest.metrics) {
            setProp('avgDeltaE', manifest.metrics.avgDeltaE != null
                ? manifest.metrics.avgDeltaE.toFixed(2) : null);
            setProp('layerCount', manifest.metrics.layerCount);
        }

        // DNA signature values
        if (manifest.dna && manifest.dna.signature) {
            const sig = manifest.dna.signature;
            setProp('dna_l', sig.meanL != null ? sig.meanL.toFixed(1) : null);
            setProp('dna_c', sig.meanC != null ? sig.meanC.toFixed(1) : null);
            setProp('dna_k', sig.blackness != null ? sig.blackness.toFixed(3) : null);
            setProp('dna_entropy', sig.entropy != null ? sig.entropy.toFixed(2) : null);
            setProp('dna_temperature', sig.temperature != null ? sig.temperature.toFixed(0) : null);
        }
        if (manifest.dna && manifest.dna.statistics) {
            setProp('dominant_sector', manifest.dna.statistics.dominantSector);
        }

        // Knobs
        if (manifest.knobs) {
            setProp('speckleRescue', manifest.knobs.speckleRescue);
            setProp('shadowClamp', manifest.knobs.shadowClamp);
            setProp('minVolume', manifest.knobs.minVolume);
            setProp('trapSize', manifest.knobs.trapSize);
        }

        // Palette as ordered array
        if (manifest.palette && manifest.palette.length > 0) {
            // Delete existing array if present
            try { xmp.deleteProperty(NS, 'palette'); } catch (_) {}
            xmp.setProperty(NS, 'palette', null, XMPConst.PROP_IS_ARRAY | XMPConst.ARRAY_IS_ORDERED);
            for (let i = 0; i < manifest.palette.length; i++) {
                const c = manifest.palette[i];
                const entry = `${c.hex} L=${c.L} a=${c.a} b=${c.b} ${c.coverage}`;
                xmp.appendArrayItem(NS, 'palette', entry);
            }
        }

        // Rankings — top 5 archetype scores
        if (manifest.archetype && manifest.archetype.rankings) {
            try { xmp.deleteProperty(NS, 'rankings'); } catch (_) {}
            xmp.setProperty(NS, 'rankings', null, XMPConst.PROP_IS_ARRAY | XMPConst.ARRAY_IS_ORDERED);
            const top5 = manifest.archetype.rankings.slice(0, 5);
            for (const r of top5) {
                const entry = `${r.name}: ${r.score}`;
                xmp.appendArrayItem(NS, 'rankings', entry);
            }
        }

        // ── Step 5: Serialize and write back ──
        const serialized = xmp.serialize(XMPConst.SERIALIZE_USE_COMPACT_FORMAT);

        await action.batchPlay([{
            _obj: "set",
            _target: [
                { _ref: "property", _property: "XMPMetadataAsUTF8" },
                { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
            ],
            to: {
                _obj: "document",
                XMPMetadataAsUTF8: serialized
            }
        }], {});

        // ── Step 6: Verify round-trip ──
        const verifyResult = await action.batchPlay([{
            _obj: "get",
            _target: [
                { _ref: "property", _property: "XMPMetadataAsUTF8" },
                { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
            ]
        }], {});

        const verifyXMP = (verifyResult && verifyResult[0] && verifyResult[0].XMPMetadataAsUTF8) || '';
        if (!verifyXMP.includes('electrosaur.org/reveal')) {
            throw new Error('Structured XMP did not persist after round-trip');
        }

        return true;
    }

    /**
     * Convert 8-bit Lab encoding to 16-bit Lab encoding (legacy utility).
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
