/**
 * ProductionWorker - Full-Resolution Production Render
 *
 * Transforms the 512px reactive navigation state into full-resolution
 * Photoshop separation layers. Reads the active document at native resolution,
 * maps every pixel to the locked palette (with overrides baked in),
 * generates per-ink masks with mechanical knobs, and creates Lab
 * solid-color fill layers with masks in Photoshop.
 *
 * Key design: Uses the LOCKED palette from Surgery Mode (no re-posterize).
 * The palette was curated by the user — re-posterizing at full resolution
 * would produce different centroids, invalidating palette overrides.
 *
 * PERFORMANCE: Inline 16-bit CIE76 nearest-neighbor (no async yields,
 * no string hashing). Spatial locality snaps adjacent pixels to last
 * winner. Full-res 20MP image separates in <2s.
 */

const { app, core, action } = require("photoshop");
const { imaging } = require("photoshop");
const Reveal = require("@reveal/core");
const PhotoshopBridge = require("./PhotoshopBridge");

const logger = Reveal.logger;
const SeparationEngine = Reveal.engines.SeparationEngine;

class ProductionWorker {

    /**
     * @param {SessionState} sessionState - Current session with locked palette
     * @param {Function} onProgress - (step, total, message) callback
     */
    constructor(sessionState, onProgress) {
        this._sessionState = sessionState;
        this._onProgress = onProgress || (() => {});
    }

    /**
     * Execute full-resolution production render.
     * @returns {Promise<{layerCount: number, elapsedMs: number}>}
     */
    async execute() {
        const t0 = Date.now();

        // ── Step 1: Read full-res pixels ──
        this._onProgress(1, 4, 'Reading full-res pixels...');
        logger.log('[ProductionWorker] Reading full-res document...');

        const { labPixels, width, height } = await PhotoshopBridge.getDocumentLab();
        const pixelCount = width * height;

        logger.log(`[ProductionWorker] Got ${width}x${height} (${pixelCount} pixels)`);

        // ── Step 2: Build production palette ──
        this._onProgress(2, 4, 'Building palette...');

        const labPalette = this._sessionState.getPalette();
        if (!labPalette || labPalette.length === 0) {
            throw new Error('No palette available — run navigation first');
        }

        // Convert Lab→RGB for hex naming
        const PosterizationEngine = Reveal.engines.PosterizationEngine;
        const hexColors = labPalette.map(c => {
            const rgb = PosterizationEngine.labToRgb({ L: c.L, a: c.a, b: c.b });
            const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
            return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toUpperCase();
        });

        logger.log(`[ProductionWorker] Palette: ${labPalette.length} colors`);

        // ── Step 3: Fast inline separation ──
        this._onProgress(3, 4, 'Separating image...');

        const state = this._sessionState.getState();
        const tSep = Date.now();

        // Fast synchronous nearest-neighbor in native 16-bit space
        const colorIndices = this._mapPixelsFast(labPixels, labPalette, pixelCount);

        logger.log(`[ProductionWorker] Mapped ${pixelCount} pixels in ${Date.now() - tSep}ms`);

        // Generate layers: mask per color + shadowClamp + speckleRescue + skip empty
        const layers = this._buildLayers(
            colorIndices, labPalette, hexColors,
            width, height,
            state.shadowClamp, state.speckleRescue
        );

        logger.log(`[ProductionWorker] Separation complete: ${layers.length} layers`);

        if (layers.length === 0) {
            throw new Error('Separation produced no layers — check palette');
        }

        // ── Step 4: Create Photoshop layers ──
        const doc = app.activeDocument;
        const is16bit = String(doc.bitsPerChannel).toLowerCase().includes('16') || doc.bitsPerChannel === 16;

        await core.executeAsModal(async (executionContext) => {
            // Suspend history so all layer operations collapse into one undo step
            let suspensionID = null;
            try {
                suspensionID = await executionContext.hostControl.suspendHistory({
                    documentID: doc.id,
                    name: "Reveal"
                });
            } catch (err) {
                logger.log('[ProductionWorker] Could not suspend history: ' + err.message);
            }

            try {
                for (let i = 0; i < layers.length; i++) {
                    this._onProgress(4, 4, `Creating layer ${i + 1}/${layers.length}...`);
                    logger.log(`[ProductionWorker] Creating layer ${i + 1}/${layers.length}: ${layers[i].name}`);

                    if (is16bit) {
                        await this._createLayer16bit(layers[i]);
                    } else {
                        await this._createLayer8bit(layers[i]);
                    }
                }

                // Hide the original image (bottom layer)
                const allLayers = doc.layers;
                if (allLayers.length > 0) {
                    allLayers[allLayers.length - 1].visible = false;
                }

                if (suspensionID !== null) {
                    await executionContext.hostControl.resumeHistory(suspensionID);
                }
            } catch (err) {
                if (suspensionID !== null) {
                    await executionContext.hostControl.resumeHistory(suspensionID, false);
                }
                throw err;
            }
        }, {
            commandName: "Reveal"
        });

        const elapsedMs = Date.now() - t0;
        logger.log(`[ProductionWorker] Done: ${layers.length} layers in ${elapsedMs}ms`);

        return { layerCount: layers.length, elapsedMs };
    }

    // ─── Fast Pixel Mapping ──────────────────────────────────────
    // Inline CIE76 in native 16-bit space. No async, no string hash,
    // no per-pixel conversion. Spatial locality + early exit.

    _mapPixelsFast(labPixels, labPalette, pixelCount) {
        const paletteSize = labPalette.length;
        const colorIndices = new Uint8Array(pixelCount);

        // Pre-convert palette to 16-bit integer space once
        const palL = new Int32Array(paletteSize);
        const palA = new Int32Array(paletteSize);
        const palB = new Int32Array(paletteSize);
        for (let j = 0; j < paletteSize; j++) {
            palL[j] = Math.round((labPalette[j].L / 100) * 32768);
            palA[j] = Math.round((labPalette[j].a / 128) * 16384 + 16384);
            palB[j] = Math.round((labPalette[j].b / 128) * 16384 + 16384);
        }

        // Snap threshold: ~ΔE 1.3 in 16-bit CIE76 space
        const SNAP = 180000;
        let lastBest = 0;

        for (let p = 0; p < pixelCount; p++) {
            const off = p * 3;
            const pL = labPixels[off];
            const pA = labPixels[off + 1];
            const pB = labPixels[off + 2];

            // Check last winner first (spatial locality)
            const dL0 = pL - palL[lastBest];
            const dA0 = pA - palA[lastBest];
            const dB0 = pB - palB[lastBest];
            let minDist = dL0 * dL0 + dA0 * dA0 + dB0 * dB0;

            if (minDist > SNAP) {
                let best = lastBest;
                for (let c = 0; c < paletteSize; c++) {
                    const dL = pL - palL[c];
                    const dA = pA - palA[c];
                    const dB = pB - palB[c];
                    const dist = dL * dL + dA * dA + dB * dB;
                    if (dist < minDist) {
                        minDist = dist;
                        best = c;
                        if (dist < SNAP) break;
                    }
                }
                lastBest = best;
            }
            colorIndices[p] = lastBest;
        }

        return colorIndices;
    }

    // ─── Build Layer Objects ─────────────────────────────────────
    // Generates masks, applies knobs, skips empty layers.

    _buildLayers(colorIndices, labPalette, hexColors, width, height, shadowClamp, speckleRescue) {
        const layers = [];
        const pixelCount = width * height;
        const MIN_COVERAGE = 0.001; // 0.1%

        for (let idx = 0; idx < labPalette.length; idx++) {
            // Generate binary mask
            const mask = SeparationEngine.generateLayerMask(colorIndices, idx, width, height);

            // Apply shadowClamp
            if (shadowClamp > 0) {
                const clampThreshold = Math.round(shadowClamp * 255 / 100);
                for (let i = 0; i < mask.length; i++) {
                    if (mask[i] > 0 && mask[i] < clampThreshold) {
                        mask[i] = clampThreshold;
                    }
                }
            }

            // Apply speckleRescue (morphological despeckle)
            if (speckleRescue > 0) {
                SeparationEngine._despeckleMask(mask, width, height, Math.round(speckleRescue));
            }

            // Count coverage
            let opaqueCount = 0;
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] === 255) opaqueCount++;
            }

            const coverage = opaqueCount / pixelCount;
            if (opaqueCount === 0 || coverage < MIN_COVERAGE) continue;

            layers.push({
                name: `[${layers.length + 1}] ${hexColors[idx]}`,
                labColor: labPalette[idx],
                hex: hexColors[idx],
                mask,
                width,
                height
            });
        }

        return layers;
    }

    // ─── 8-bit Layer Creation ────────────────────────────────────
    // Ported from PhotoshopAPI.createLabSeparationLayer()

    async _createLayer8bit(layerData) {
        const { name, labColor, mask, width, height } = layerData;
        const doc = app.activeDocument;

        // STEP 1: Create protective layer (prevents background corruption)
        await action.batchPlay([{
            "_obj": "make",
            "_target": [{ "_ref": "layer" }],
            "name": "__PROTECTIVE__"
        }], {});

        // STEP 2: Create temporary raster layer to hold mask data
        await action.batchPlay([{
            "_obj": "make",
            "_target": [{ "_ref": "layer" }],
            "name": "__TEMP_MASK__"
        }], {});

        const tempLayer = doc.activeLayers[0];
        const tempLayerID = tempLayer.id;

        // STEP 3: Write RGBA mask data to temp layer (alpha channel = mask)
        const rgbaData = new Uint8Array(width * height * 4);
        for (let i = 0; i < mask.length; i++) {
            const idx = i * 4;
            rgbaData[idx] = 255;           // R = white
            rgbaData[idx + 1] = 255;       // G = white
            rgbaData[idx + 2] = 255;       // B = white
            rgbaData[idx + 3] = mask[i];   // A = mask value
        }

        const imageData = await imaging.createImageDataFromBuffer(rgbaData, {
            width, height,
            components: 4,
            componentSize: 8,
            chunky: true,
            colorSpace: "RGB",
            colorProfile: "sRGB IEC61966-2.1"
        });

        await imaging.putPixels({
            layerID: tempLayer.id,
            imageData: imageData,
            replace: true
        });

        imageData.dispose();

        // STEP 4: Load temp layer's TRANSPARENCY as selection
        await action.batchPlay([{
            "_obj": "set",
            "_target": [{ "_ref": "channel", "_property": "selection" }],
            "to": {
                "_ref": "channel",
                "_enum": "channel",
                "_value": "transparencyEnum"
            }
        }], {});

        // STEP 5: Delete temp layer and protective layer
        await action.batchPlay([
            { "_obj": "delete", "_target": [{ "_ref": "layer", "_id": tempLayerID }] },
            { "_obj": "delete", "_target": [{ "_ref": "layer", "_name": "__PROTECTIVE__" }] }
        ], {});

        // STEP 6: Create Fill Layer + mask using revealSelection
        await action.batchPlay([
            {
                "_obj": "make",
                "target": { "_ref": "contentLayer" },
                "using": {
                    "_obj": "contentLayer",
                    "type": {
                        "_obj": "solidColorLayer",
                        "color": {
                            "_obj": "labColor",
                            "luminance": labColor.L,
                            "a": labColor.a,
                            "b": labColor.b
                        }
                    }
                }
            },
            {
                "_obj": "make",
                "new": { "_class": "mask" },
                "at": { "_ref": "layer", "_enum": "ordinal", "_value": "targetEnum" },
                "using": { "_enum": "userMaskEnabled", "_value": "revealSelection" }
            }
        ], { "synchronousExecution": true });

        const createdLayer = doc.activeLayers[0];
        createdLayer.name = name;

        // STEP 7: Clear selection
        await doc.selection.deselect();

        return createdLayer;
    }

    // ─── 16-bit Layer Creation ───────────────────────────────────
    // Ported from PhotoshopAPI.createLabSeparationLayer16Bit()

    async _createLayer16bit(layerData) {
        const { name, labColor, mask, width, height } = layerData;
        const doc = app.activeDocument;

        // STEP 1: Create temp layer
        await action.batchPlay([{
            "_obj": "make",
            "_target": [{ "_ref": "layer" }],
            "name": `__TEMP_${name}__`
        }], {});

        const tempLayer = doc.activeLayers[0];

        // STEP 2: Write RGBA data with mask as alpha (16-bit scaled)
        const rgbaData = new Uint16Array(width * height * 4);
        for (let i = 0; i < width * height; i++) {
            const idx = i * 4;
            rgbaData[idx] = 32768;         // R = white
            rgbaData[idx + 1] = 32768;     // G = white
            rgbaData[idx + 2] = 32768;     // B = white
            rgbaData[idx + 3] = mask[i] * 128; // Scale 0-255 → 0-32768
        }

        const imageData = await imaging.createImageDataFromBuffer(rgbaData, {
            width, height,
            components: 4,
            componentSize: 16,
            chunky: true,
            colorSpace: "RGB",
            colorProfile: "sRGB IEC61966-2.1"
        });

        await imaging.putPixels({
            layerID: tempLayer.id,
            imageData: imageData,
            replace: true
        });

        imageData.dispose();

        // STEP 3: Load transparency as selection
        await action.batchPlay([{
            "_obj": "set",
            "_target": [{ "_ref": "channel", "_property": "selection" }],
            "to": {
                "_ref": "channel",
                "_enum": "channel",
                "_value": "transparencyEnum"
            }
        }], {});

        // STEP 4: Create fill layer AND mask in SINGLE batchPlay
        await action.batchPlay([
            {
                "_obj": "make",
                "_target": [{ "_ref": "contentLayer" }],
                "using": {
                    "_obj": "contentLayer",
                    "type": {
                        "_obj": "solidColorLayer",
                        "color": {
                            "_obj": "labColor",
                            "luminance": labColor.L,
                            "a": labColor.a,
                            "b": labColor.b
                        }
                    }
                }
            },
            {
                "_obj": "make",
                "_target": [{ "_ref": "channel", "_enum": "channel", "_value": "mask" }],
                "new": { "_class": "channel" },
                "at": { "_ref": "layer", "_enum": "ordinal", "_value": "targetEnum" },
                "using": { "_enum": "userMaskEnabled", "_value": "revealSelection" }
            }
        ], {});

        const createdLayer = doc.activeLayers[0];
        createdLayer.name = name;

        // STEP 5: Delete temp layer
        await tempLayer.delete();

        // STEP 6: Clear selection
        await action.batchPlay([{
            "_obj": "set",
            "_target": [{ "_ref": "channel", "_property": "selection" }],
            "to": { "_enum": "ordinal", "_value": "none" }
        }], {});

        return createdLayer;
    }
}

module.exports = ProductionWorker;
