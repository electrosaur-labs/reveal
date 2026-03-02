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

        // DEBUG: probe encoding — compare raw values to expected Engine 16-bit
        const _bufType = rawPixels && rawPixels.constructor ? rawPixels.constructor.name : 'unknown';
        const _p0L = rawPixels[0], _p0a = rawPixels[1], _p0b = rawPixels[2];
        // Sample pixel at ~10% into image (likely non-white)
        const _off = Math.floor(actualWidth * actualHeight * 0.1) * 3;
        const _p1L = rawPixels[_off], _p1a = rawPixels[_off+1], _p1b = rawPixels[_off+2];
        // Decode using Engine 16-bit formula
        const _dec = (L16, a16, b16) => ({
            L: (L16/32768*100).toFixed(1),
            a: ((a16-16384)/128).toFixed(1),
            b: ((b16-16384)/128).toFixed(1)
        });
        const _d0 = _dec(_p0L, _p0a, _p0b);
        const _d1 = _dec(_p1L, _p1a, _p1b);
        // Also sample 50% through image (more likely to hit a colored pixel)
        const _off2 = Math.floor(actualWidth * actualHeight * 0.5) * 3;
        const _p2L = rawPixels[_off2], _p2a = rawPixels[_off2+1], _p2b = rawPixels[_off2+2];
        const _d2 = _dec(_p2L, _p2a, _p2b);
        console.log('[PhotoshopBridge] bufType=' + _bufType
            + ' len=' + rawPixels.length + ' expected=' + (actualWidth*actualHeight*3)
            + ' w=' + actualWidth + ' h=' + actualHeight);
        console.log('[PhotoshopBridge] px[0]   raw=(' + _p0L + ',' + _p0a + ',' + _p0b
            + ') → Lab(' + _d0.L + ',' + _d0.a + ',' + _d0.b + ')');
        console.log('[PhotoshopBridge] px[10%] raw=(' + _p1L + ',' + _p1a + ',' + _p1b
            + ') → Lab(' + _d1.L + ',' + _d1.a + ',' + _d1.b + ')');
        console.log('[PhotoshopBridge] px[50%] raw=(' + _p2L + ',' + _p2a + ',' + _p2b
            + ') → Lab(' + _d2.L + ',' + _d2.a + ',' + _d2.b + ')');

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
     * Write human-readable IPTC fields via batchPlay fileInfo.
     * These show up in Photoshop's File > File Info dialog:
     *   headline, instructions, author, keywords, caption.
     *
     * The structured machine-readable data lives in the reveal:
     * XMP namespace (written by writeStructuredXMP). This method
     * only writes the human-readable summary.
     *
     * Must be called inside executeAsModal.
     *
     * @param {Object} manifest - Manifest object from SessionState.buildManifest()
     */
    static async writeManifestIPTC(manifest) {
        const archetypeName = (manifest.archetype && manifest.archetype.name) || 'Unknown';
        const layerCount = (manifest.metrics && manifest.metrics.layerCount) || 0;

        // Headline: archetype name + color count
        const headline = `Reveal: ${archetypeName} — ${layerCount} colors`;

        // Caption: human-readable summary (replaces old JSON blob)
        const captionLines = [];
        captionLines.push(`Reveal Navigator v1.0.0 — Color Separation`);
        captionLines.push(`Archetype: ${archetypeName} (score: ${manifest.archetype ? manifest.archetype.score : 'n/a'})`);
        if (manifest.palette && manifest.palette.length > 0) {
            captionLines.push(`Palette: ${manifest.palette.map(c => c.hex).join(', ')}`);
        }
        if (manifest.config) {
            captionLines.push(`Metric: ${manifest.config.distanceMetric || 'cie76'}, Dither: ${manifest.config.ditherType || 'none'}`);
        }
        if (manifest.metrics && manifest.metrics.avgDeltaE != null) {
            captionLines.push(`Avg ΔE: ${manifest.metrics.avgDeltaE.toFixed(2)}`);
        }
        if (manifest.knobs) {
            const k = manifest.knobs;
            const parts = [];
            if (k.minVolume != null) parts.push(`minVol=${k.minVolume}`);
            if (k.speckleRescue != null) parts.push(`speckle=${k.speckleRescue}`);
            if (k.shadowClamp != null) parts.push(`shadow=${k.shadowClamp}`);
            if (k.trapSize != null) parts.push(`trap=${k.trapSize}`);
            if (parts.length > 0) captionLines.push(`Knobs: ${parts.join(', ')}`);
        }
        captionLines.push(`Full metadata in reveal: XMP namespace.`);

        // Keywords: archetype name + hex codes
        const keywords = [archetypeName];
        if (manifest.palette) {
            for (const c of manifest.palette) {
                if (c.hex) keywords.push(c.hex);
            }
        }

        const fileInfoDesc = {
            _obj: "fileInfo",
            caption: captionLines.join('\n'),
            headline: headline,
            instructions: captionLines.slice(1, -1).join('\n'), // same content minus header/footer
            byline: (manifest.meta && manifest.meta.generator) || 'Reveal Navigator v1.0.0'
        };
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
     *
     * Uses raw string injection into the existing XMP packet — avoids
     * XMPMeta.serialize() which changes padding and causes UXP to
     * reject the write with errors -1715/-25920.
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
        const REVEAL_NS = 'http://electrosaur.org/reveal/1.0/';

        // ── Step 1: Read existing XMP from document ──
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
        if (!existingXMP) throw new Error('No existing XMP packet to modify');

        // ── Step 2: Build reveal XML block ──
        const xml = PhotoshopBridge._buildRevealXML(manifest);

        // ── Step 3: Inject into existing XMP via string surgery ──
        let modified = existingXMP;

        // Strip any previous reveal block (idempotent re-write)
        modified = modified.replace(
            /\n? *<!-- REVEAL:BEGIN -->[\s\S]*?<!-- REVEAL:END -->\n?/g, ''
        );

        // Add namespace declaration to rdf:Description if missing
        if (!modified.includes('xmlns:reveal=')) {
            modified = modified.replace(
                /(<rdf:Description\b[^>]*?)(>)/,
                `$1\n            xmlns:reveal="${REVEAL_NS}"$2`
            );
        }

        // Insert our block before closing </rdf:Description>
        // (handle both self-closing and normal closing forms)
        if (modified.includes('</rdf:Description>')) {
            modified = modified.replace(
                '</rdf:Description>',
                xml + '\n         </rdf:Description>'
            );
        } else {
            // Self-closing <rdf:Description ... /> — open it
            modified = modified.replace(
                /(<rdf:Description\b[^>]*?)\s*\/>/,
                `$1>\n${xml}\n         </rdf:Description>`
            );
        }

        // ── Step 4: Write back ──
        await action.batchPlay([{
            _obj: "set",
            _target: [
                { _ref: "property", _property: "XMPMetadataAsUTF8" },
                { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
            ],
            to: {
                _obj: "document",
                XMPMetadataAsUTF8: modified
            }
        }], {});

        // ── Step 5: Verify round-trip ──
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
     * Build the reveal: namespace XML block from a manifest.
     * Returns a string suitable for injection into an rdf:Description element.
     *
     * @param {Object} manifest
     * @returns {string} XML fragment
     */
    static _buildRevealXML(manifest) {
        const I = '         '; // 9-space indent to match Photoshop XMP formatting
        const lines = [];
        lines.push(`${I}<!-- REVEAL:BEGIN -->`);

        const esc = (v) => String(v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        // ── Meta ──
        // reveal:version = plugin version; reveal:dnaVersion = DNA schema version
        const pluginVersion = (manifest.meta && manifest.meta.generator)
            ? manifest.meta.generator.replace(/.*v/i, '') : '1.0.0';
        lines.push(`${I}<reveal:version>${esc(pluginVersion)}</reveal:version>`);
        if (manifest.dna && manifest.dna.version) {
            lines.push(`${I}<reveal:dnaVersion>${esc(manifest.dna.version)}</reveal:dnaVersion>`);
        }
        if (manifest.meta) {
            lines.push(`${I}<reveal:generator>${esc(manifest.meta.generator)}</reveal:generator>`);
            lines.push(`${I}<reveal:timestamp>${esc(manifest.meta.timestamp)}</reveal:timestamp>`);
            lines.push(`${I}<reveal:filename>${esc(manifest.meta.filename)}</reveal:filename>`);
            lines.push(`${I}<reveal:width>${manifest.meta.width}</reveal:width>`);
            lines.push(`${I}<reveal:height>${manifest.meta.height}</reveal:height>`);
            lines.push(`${I}<reveal:bitDepth>${manifest.meta.bitDepth}</reveal:bitDepth>`);
        }

        // ── Archetype ──
        if (manifest.archetype) {
            const a = manifest.archetype;
            lines.push(`${I}<reveal:archetype>${esc(a.id)}</reveal:archetype>`);
            lines.push(`${I}<reveal:archetypeName>${esc(a.name)}</reveal:archetypeName>`);
            lines.push(`${I}<reveal:archetypeScore>${a.score}</reveal:archetypeScore>`);
            if (a.breakdown) {
                const b = a.breakdown;
                lines.push(`${I}<reveal:scoreStructural>${b.structural || 0}</reveal:scoreStructural>`);
                lines.push(`${I}<reveal:scoreSector>${b.sectorAffinity || 0}</reveal:scoreSector>`);
                lines.push(`${I}<reveal:scorePattern>${b.pattern || 0}</reveal:scorePattern>`);
            }
        }

        // ── Config ──
        if (manifest.config) {
            const c = manifest.config;
            if (c.targetColors != null) lines.push(`${I}<reveal:targetColors>${c.targetColors}</reveal:targetColors>`);
            if (c.distanceMetric) lines.push(`${I}<reveal:distanceMetric>${esc(c.distanceMetric)}</reveal:distanceMetric>`);
            if (c.ditherType) lines.push(`${I}<reveal:ditherType>${esc(c.ditherType)}</reveal:ditherType>`);
            if (c.engineType) lines.push(`${I}<reveal:engineType>${esc(c.engineType)}</reveal:engineType>`);
        }

        // ── Metrics ──
        if (manifest.metrics) {
            const m = manifest.metrics;
            if (m.avgDeltaE != null) lines.push(`${I}<reveal:avgDeltaE>${m.avgDeltaE.toFixed(2)}</reveal:avgDeltaE>`);
            lines.push(`${I}<reveal:layerCount>${m.layerCount || 0}</reveal:layerCount>`);
            lines.push(`${I}<reveal:elapsedMs>${m.elapsedMs || 0}</reveal:elapsedMs>`);
        }

        // ── DNA ──
        if (manifest.dna) {
            const g = manifest.dna.global || manifest.dna.signature || {};
            if (g.l != null || g.meanL != null) lines.push(`${I}<reveal:dnaL>${(g.l || g.meanL || 0).toFixed(1)}</reveal:dnaL>`);
            if (g.c != null || g.meanC != null) lines.push(`${I}<reveal:dnaC>${(g.c || g.meanC || 0).toFixed(1)}</reveal:dnaC>`);
            if (g.k != null || g.blackness != null) lines.push(`${I}<reveal:dnaK>${(g.k || g.blackness || 0).toFixed(3)}</reveal:dnaK>`);
            if (g.hue_entropy != null || g.entropy != null) lines.push(`${I}<reveal:dnaEntropy>${(g.hue_entropy || g.entropy || 0).toFixed(2)}</reveal:dnaEntropy>`);
            if (g.temperature_bias != null || g.temperature != null) lines.push(`${I}<reveal:dnaTemperature>${(g.temperature_bias || g.temperature || 0).toFixed(2)}</reveal:dnaTemperature>`);
            const ds = manifest.dna.dominant_sector || (manifest.dna.statistics && manifest.dna.statistics.dominantSector);
            if (ds) lines.push(`${I}<reveal:dominantSector>${esc(ds)}</reveal:dominantSector>`);
        }

        // ── Knobs ──
        if (manifest.knobs) {
            const k = manifest.knobs;
            lines.push(`${I}<reveal:minVolume>${k.minVolume || 0}</reveal:minVolume>`);
            lines.push(`${I}<reveal:speckleRescue>${k.speckleRescue || 0}</reveal:speckleRescue>`);
            lines.push(`${I}<reveal:shadowClamp>${k.shadowClamp || 0}</reveal:shadowClamp>`);
            lines.push(`${I}<reveal:trapSize>${k.trapSize || 0}</reveal:trapSize>`);
            if (k.meshSize) lines.push(`${I}<reveal:meshSize>${k.meshSize}</reveal:meshSize>`);
        }

        // ── Palette (ordered list) ──
        if (manifest.palette && manifest.palette.length > 0) {
            lines.push(`${I}<reveal:palette>`);
            lines.push(`${I} <rdf:Seq>`);
            for (const c of manifest.palette) {
                lines.push(`${I}  <rdf:li>${esc(c.hex)} L=${c.L} a=${c.a} b=${c.b} ${c.coverage}</rdf:li>`);
            }
            lines.push(`${I} </rdf:Seq>`);
            lines.push(`${I}</reveal:palette>`);
        }

        // ── Rankings (top 5) ──
        if (manifest.archetype && manifest.archetype.rankings) {
            const top5 = manifest.archetype.rankings.slice(0, 5);
            lines.push(`${I}<reveal:rankings>`);
            lines.push(`${I} <rdf:Seq>`);
            for (const r of top5) {
                lines.push(`${I}  <rdf:li>${esc(r.name)}: ${r.score}</rdf:li>`);
            }
            lines.push(`${I} </rdf:Seq>`);
            lines.push(`${I}</reveal:rankings>`);
        }

        // ── Surgery ──
        if (manifest.surgery) {
            const s = manifest.surgery;
            const hasOverrides = s.overrides && Object.keys(s.overrides).length > 0;
            const hasMerges = s.merges && Object.keys(s.merges).length > 0;
            const hasDeletions = s.deletions && s.deletions.length > 0;
            if (hasOverrides || hasMerges || hasDeletions) {
                if (hasOverrides) {
                    for (const [idx, lab] of Object.entries(s.overrides)) {
                        lines.push(`${I}<reveal:override_${idx}>L=${lab.L} a=${lab.a} b=${lab.b}</reveal:override_${idx}>`);
                    }
                }
                if (hasDeletions) {
                    lines.push(`${I}<reveal:deletions>${s.deletions.join(',')}</reveal:deletions>`);
                }
            }
        }

        lines.push(`${I}<!-- REVEAL:END -->`);
        return lines.join('\n');
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
