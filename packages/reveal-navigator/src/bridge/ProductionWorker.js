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
const MechanicalKnobs = Reveal.MechanicalKnobs;

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

        // Build production config BEFORE entering modal (no PS API needed)
        const prodConfig = this._sessionState.exportProductionConfig();
        const labPalette = prodConfig.palette;
        if (!labPalette || labPalette.length === 0) {
            throw new Error('No palette available — run navigation first');
        }

        // ── DIAGNOSTIC: dump archetype + metric + palette ──
        logger.log(`[ProductionWorker] ── FINALIZE CONFIG ──`);
        logger.log(`[ProductionWorker]   archetype: ${prodConfig.activeArchetypeId}`);
        logger.log(`[ProductionWorker]   distanceMetric: ${prodConfig.distanceMetric}`);
        logger.log(`[ProductionWorker]   targetColors: ${prodConfig.targetColors}`);
        logger.log(`[ProductionWorker]   preprocessing: ${prodConfig.preprocessingIntensity}, dither: ${prodConfig.ditherType}`);
        logger.log(`[ProductionWorker]   knobs: minVol=${prodConfig.minVolume} spkl=${prodConfig.speckleRescue} shd=${prodConfig.shadowClamp}`);
        logger.log(`[ProductionWorker]   paletteOverrides: ${JSON.stringify(prodConfig.paletteOverrides)}`);
        for (let i = 0; i < labPalette.length; i++) {
            const c = labPalette[i];
            logger.log(`[ProductionWorker]   palette[${i}]: L=${c.L.toFixed(1)} a=${c.a.toFixed(1)} b=${c.b.toFixed(1)}`);
        }

        // Convert Lab→RGB for hex naming
        const PosterizationEngine = Reveal.engines.PosterizationEngine;
        const hexColors = labPalette.map(c => {
            const rgb = PosterizationEngine.labToRgb({ L: c.L, a: c.a, b: c.b });
            const toHex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
            return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`.toUpperCase();
        });

        logger.log(`[ProductionWorker] Palette: ${labPalette.length} colors (${hexColors.join(', ')})`);

        const metric = prodConfig.distanceMetric || 'cie76';
        const self = this;

        // ── Single executeAsModal wraps the entire pipeline ──
        // Cursor goes busy immediately on "Separate" click.
        // Pixel read + separation + mask gen + layer creation all run inside.
        const result = await core.executeAsModal(async (executionContext) => {
            // ── Step 1: Read full-res pixels ──
            self._onProgress(1, 4, 'Reading full-res pixels...');
            logger.log('[ProductionWorker] Reading full-res document...');

            const doc = app.activeDocument;
            const docWidth = doc.width;
            const docHeight = doc.height;

            // Read pixels directly (no nested executeAsModal)
            const pixelData = await imaging.getPixels({
                documentID: doc.id,
                componentSize: 8,
                targetComponentCount: 3,
                colorSpace: "Lab"
            });

            let rawPixels, actualWidth, actualHeight;
            if (pixelData.imageData) {
                actualWidth = pixelData.imageData.width;
                actualHeight = pixelData.imageData.height;
                rawPixels = await pixelData.imageData.getData({ chunky: true });
            } else if (pixelData.pixels) {
                actualWidth = docWidth;
                actualHeight = docHeight;
                rawPixels = pixelData.pixels;
            } else {
                throw new Error('Unexpected pixel data format');
            }

            // Upconvert 8-bit Lab → 16-bit
            const labPixels = PhotoshopBridge.lab8to16(rawPixels);
            const pixelCount = actualWidth * actualHeight;

            logger.log(`[ProductionWorker] Got ${actualWidth}x${actualHeight} (${pixelCount} pixels)`);

            // ── Step 1b: Bilateral filter (matches proxy preprocessing) ──
            const preprocessing = prodConfig.preprocessingIntensity || 'off';
            if (preprocessing !== 'off') {
                const BilateralFilter = Reveal.BilateralFilter;
                const isHeavy = preprocessing === 'heavy';
                const radius = isHeavy ? 5 : 3;
                const sigmaR = 5000; // 16-bit Lab space
                const tBilateral = Date.now();
                BilateralFilter.applyBilateralFilterLab(labPixels, actualWidth, actualHeight, radius, sigmaR);
                logger.log(`[ProductionWorker] Bilateral filter (${preprocessing}, r=${radius}) in ${Date.now() - tBilateral}ms`);
            }

            // ── Step 2: Separate image ──
            self._onProgress(2, 4, 'Separating image...');
            const tSep = Date.now();
            const ditherType = prodConfig.ditherType || 'none';

            let colorIndices;
            if (metric === 'cie76' && ditherType === 'none') {
                colorIndices = self._mapPixelsFast(labPixels, labPalette, pixelCount);
            } else {
                logger.log(`[ProductionWorker] Using ${metric}, dither=${ditherType} (via SeparationEngine)`);
                colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
                    labPixels, labPalette, null, actualWidth, actualHeight,
                    { ditherType, distanceMetric: metric }
                );
            }

            logger.log(`[ProductionWorker] Mapped ${pixelCount} pixels in ${Date.now() - tSep}ms (metric=${metric})`);

            // Diagnostic: per-color pixel counts
            const pixCounts = new Uint32Array(labPalette.length);
            for (let i = 0; i < pixelCount; i++) pixCounts[colorIndices[i]]++;
            for (let i = 0; i < labPalette.length; i++) {
                const pct = ((pixCounts[i] / pixelCount) * 100).toFixed(2);
                logger.log(`[ProductionWorker]   color[${i}] ${hexColors[i]}: ${pixCounts[i]} px (${pct}%)`);
            }

            // ── Step 3: Build masks ──
            self._onProgress(3, 4, 'Building masks...');

            const layers = self._buildLayers(
                colorIndices, labPalette, hexColors,
                actualWidth, actualHeight,
                prodConfig.minVolume, prodConfig.shadowClamp, prodConfig.speckleRescue
            );

            logger.log(`[ProductionWorker] Separation complete: ${layers.length} layers`);

            if (layers.length === 0) {
                throw new Error('Separation produced no layers — check palette');
            }

            // ── Step 4: Create Photoshop layers ──
            const is16bit = String(doc.bitsPerChannel).toLowerCase().includes('16') || doc.bitsPerChannel === 16;

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
                    self._onProgress(4, 4, `Creating layer ${i + 1}/${layers.length}...`);
                    logger.log(`[ProductionWorker] Creating layer ${i + 1}/${layers.length}: ${layers[i].name}`);

                    if (is16bit) {
                        await self._createLayer16bit(layers[i]);
                    } else {
                        await self._createLayer8bit(layers[i]);
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

            return { layerCount: layers.length };
        }, {
            commandName: "Reveal"
        });

        const elapsedMs = Date.now() - t0;
        logger.log(`[ProductionWorker] Done: ${result.layerCount} layers in ${elapsedMs}ms`);

        const productionResult = { layerCount: result.layerCount, elapsedMs };

        // ── Embed separation manifest as XMP ──
        try {
            const manifest = this._sessionState.buildManifest(productionResult);
            await core.executeAsModal(async () => {
                await PhotoshopBridge.writeManifestXMP(manifest);
            }, { commandName: "Reveal: Write Manifest" });
            logger.log(`[ProductionWorker] Manifest embedded in XMP`);
        } catch (err) {
            logger.log(`[ProductionWorker] Manifest XMP failed (non-fatal): ${err && err.message || String(err)}`);
        }

        return productionResult;
    }

    // ─── Loupe Tile Rendering ─────────────────────────────────────
    // Renders a small native-resolution tile for 1:1 loupe inspection.
    // Uses the locked palette and current knobs — no re-posterization.

    /**
     * Render a high-res separation for a specific tile (loupe ROI).
     * Reads native-res pixels from PS, maps to locked palette, applies knobs,
     * returns RGBA preview buffer.
     *
     * @param {{left: number, top: number, right: number, bottom: number}} rect - Document bounds
     * @returns {Promise<{buffer: Uint8ClampedArray, width: number, height: number}>}
     */
    async renderLoupeTile(rect) {
        const labPalette = this._sessionState.getPalette();
        if (!labPalette || labPalette.length === 0) {
            throw new Error('No palette available for loupe');
        }

        const { labPixels, width, height } = await PhotoshopBridge.getTileLab(rect);
        const pixelCount = width * height;

        // Bilateral filter preprocessing — matches the proxy pipeline so loupe
        // colors look consistent with the main preview (no raw noise artifacts).
        // Uses the same radius=3, sigmaR=5000 as ProxyEngine.initializeProxy.
        const BilateralFilter = Reveal.BilateralFilter;
        if (BilateralFilter) {
            BilateralFilter.applyBilateralFilterLab(labPixels, width, height, 3, 5000);
        }

        // Map pixels using locked palette — fast CIE76 inline
        const metric = this._sessionState.getState().distanceMetric || 'cie76';
        let colorIndices;
        if (metric === 'cie76') {
            colorIndices = this._mapPixelsFast(labPixels, labPalette, pixelCount);
        } else {
            colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
                labPixels, labPalette, null, width, height,
                { ditherType: 'none', distanceMetric: metric }
            );
        }

        // Apply knobs using shared MechanicalKnobs (same as _buildLayers and ProxyEngine)
        const state = this._sessionState.getState();

        if (state.minVolume > 0) {
            MechanicalKnobs.applyMinVolume(colorIndices, labPalette, pixelCount, state.minVolume);
        }

        // Build masks from (possibly remapped) color indices
        const masks = MechanicalKnobs.rebuildMasks(colorIndices, labPalette.length, pixelCount);

        // Loupe tiles are native resolution — no originalWidth scaling needed
        if (state.speckleRescue > 0) {
            MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, state.speckleRescue);
        }

        if (state.shadowClamp > 0) {
            MechanicalKnobs.applyShadowClamp(masks, colorIndices, labPalette, width, height, state.shadowClamp);
        }

        // Generate RGBA preview from masks + colorIndices
        const PosterizationEngine = Reveal.engines.PosterizationEngine;
        const rgbPalette = labPalette.map(c => PosterizationEngine.labToRgb(c));
        const buffer = new Uint8ClampedArray(pixelCount * 4);
        for (let i = 0; i < pixelCount; i++) {
            const idx = i * 4;
            const ci = colorIndices[i];
            if (ci < rgbPalette.length) {
                buffer[idx]     = rgbPalette[ci].r;
                buffer[idx + 1] = rgbPalette[ci].g;
                buffer[idx + 2] = rgbPalette[ci].b;
            } else {
                buffer[idx] = buffer[idx+1] = buffer[idx+2] = 255;
            }
            buffer[idx + 3] = 255;
        }

        return { buffer, width, height };
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

    _buildLayers(colorIndices, labPalette, hexColors, width, height, minVolume, shadowClamp, speckleRescue) {
        const layers = [];
        const pixelCount = width * height;
        const MIN_COVERAGE = 0.001; // 0.1%

        // ── Apply minVolume (shared with ProxyEngine) ──
        if (minVolume > 0) {
            const result = MechanicalKnobs.applyMinVolume(colorIndices, labPalette, pixelCount, minVolume);
            if (result.remappedCount > 0) {
                logger.log(`[ProductionWorker] minVolume: remapped ${result.remappedCount} weak colors`);
            }
        }

        // Build masks from (possibly remapped) color indices
        const masks = MechanicalKnobs.rebuildMasks(colorIndices, labPalette.length, pixelCount);

        // ── Apply speckleRescue (shared with ProxyEngine) ──
        // No originalWidth scaling — production runs at full document resolution
        if (speckleRescue > 0) {
            MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, speckleRescue);
        }

        // ── Apply shadowClamp (shared with ProxyEngine) ──
        // Uses tonal-aware edge erosion (same algorithm as proxy preview)
        if (shadowClamp > 0) {
            MechanicalKnobs.applyShadowClamp(masks, colorIndices, labPalette, width, height, shadowClamp);
        }

        // Build layer objects, skipping empty layers
        for (let idx = 0; idx < labPalette.length; idx++) {
            const mask = masks[idx];

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
