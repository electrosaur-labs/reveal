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
 * PERFORMANCE: Uses SeparationEngine with L-weighted CIE76 distance
 * (matching batch pipeline). Yields every 64K pixels for Photoshop
 * responsiveness. Full-res 20MP image separates in <2s.
 */

const { app, core, action } = require("photoshop");
const { imaging } = require("photoshop");
const Reveal = require("@electrosaur-labs/core");
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
        const labPalette = prodConfig.palette;          // overridden colours → layer fill
        const separationPalette = prodConfig.separationPalette || labPalette; // baseline → NN search
        if (!labPalette || labPalette.length === 0) {
            throw new Error('No palette available — run navigation first');
        }

        // ── DIAGNOSTIC: dump archetype + metric + palette ──
        logger.log(`[ProductionWorker] ── FINALIZE CONFIG ──`);
        logger.log(`[ProductionWorker]   archetype: ${prodConfig.activeArchetypeId}`);
        logger.log(`[ProductionWorker]   distanceMetric: ${prodConfig.distanceMetric}`);
        logger.log(`[ProductionWorker]   targetColors: ${prodConfig.targetColors}`);
        logger.log(`[ProductionWorker]   preprocessing: ${prodConfig.preprocessingIntensity}, dither: ${prodConfig.ditherType}`);
        logger.log(`[ProductionWorker]   knobs: minVol=${prodConfig.minVolume} spkl=${prodConfig.speckleRescue} shd=${prodConfig.shadowClamp} trap=${prodConfig.trapSize || 0}`);
        logger.log(`[ProductionWorker]   separationPalette: ${prodConfig.separationPalette ? prodConfig.separationPalette.length + ' colors' : 'MISSING'}`);
        if (prodConfig.separationPalette) {
            for (let i = 0; i < prodConfig.separationPalette.length; i++) {
                const c = prodConfig.separationPalette[i];
                const p = labPalette[i];
                const match = p ? (c.L === p.L && c.a === p.a && c.b === p.b ? 'SAME' : 'DIFFERS') : 'no-fill';
                logger.log(`[ProductionWorker]   sepPal[${i}]: L=${c.L.toFixed(1)} a=${c.a.toFixed(1)} b=${c.b.toFixed(1)} vs fill: ${match}`);
            }
        }
        logger.log(`[ProductionWorker]   paletteOverrides: ${JSON.stringify(prodConfig.paletteOverrides)}`);
        for (let i = 0; i < labPalette.length; i++) {
            const c = labPalette[i];
            logger.log(`[ProductionWorker]   palette[${i}]: L=${c.L.toFixed(1)} a=${c.a.toFixed(1)} b=${c.b.toFixed(1)}`);
        }

        // Convert Lab→RGB for hex naming (D50 to match Photoshop rendering)
        const hexColors = labPalette.map(c => {
            const rgb = Reveal.labToRgbD50({ L: c.L, a: c.a, b: c.b });
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
            // componentSize:16 — native Photoshop 16-bit Lab encoding (confirmed working 2026-02-16).
            // sourceBounds — guards against smart object pixel shift (UXP known pitfall).
            const pixelData = await imaging.getPixels({
                documentID: doc.id,
                componentSize: 16,
                targetComponentCount: 3,
                colorSpace: "Lab",
                sourceBounds: { left: 0, top: 0, right: docWidth, bottom: docHeight }
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

            // rawPixels is already native 16-bit Lab (Uint16Array, 0-32768 encoding)
            // No upconversion needed — matches ProxyEngine's read path exactly.
            const labPixels = rawPixels;
            const pixelCount = actualWidth * actualHeight;

            logger.log(`[ProductionWorker] Got ${actualWidth}x${actualHeight} (${pixelCount} pixels)`);

            // ── Step 1b: Bilateral filter (matches proxy preprocessing) ──
            const preprocessing = prodConfig.preprocessingIntensity || 'off';
            if (preprocessing !== 'off' && preprocessing !== 'none') {
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

            // Separation uses BASELINE palette so palette overrides do not
            // deflect the nearest-neighbour search. Override colours are layer
            // fill colours only — they live in labPalette, not separationPalette.
            const meshCount = prodConfig.meshSize || null;
            logger.log(`[ProductionWorker] Separating: ${metric}, dither=${ditherType}, mesh=${meshCount || 'none'}`);
            const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
                labPixels, separationPalette, null, actualWidth, actualHeight,
                { ditherType, distanceMetric: metric, meshCount }
            );

            logger.log(`[ProductionWorker] Mapped ${pixelCount} pixels in ${Date.now() - tSep}ms (metric=${metric})`);

            // ── Remap merged/deleted colors to their merge targets ──
            // The overridden palette has duplicate Lab entries for merged colors.
            // Nearest-neighbor splits pixels arbitrarily between duplicates due
            // to spatial locality. Remap source indices → target indices so merged
            // colors collapse into a single layer.
            if (prodConfig.mergeRemap) {
                let remapped = 0;
                for (let i = 0; i < pixelCount; i++) {
                    const target = prodConfig.mergeRemap[colorIndices[i]];
                    if (target !== undefined) {
                        colorIndices[i] = target;
                        remapped++;
                    }
                }
                if (remapped > 0) {
                    logger.log(`[ProductionWorker] Merge remap: ${remapped} pixels reassigned`);
                }
            }

            // Diagnostic: per-color pixel counts
            const pixCounts = new Uint32Array(labPalette.length);
            for (let i = 0; i < pixelCount; i++) pixCounts[colorIndices[i]]++;
            for (let i = 0; i < labPalette.length; i++) {
                const pct = ((pixCounts[i] / pixelCount) * 100).toFixed(2);
                logger.log(`[ProductionWorker]   color[${i}] ${hexColors[i]}: ${pixCounts[i]} px (${pct}%)`);
            }

            // ── Step 3: Build masks ──
            self._onProgress(3, 4, 'Building masks...');

            const knobs = {
                minVolume: prodConfig.minVolume,
                speckleRescue: prodConfig.speckleRescue,
                shadowClamp: prodConfig.shadowClamp,
                trapSize: prodConfig.trapSize || 0,
            };
            const layers = self._buildLayers(
                colorIndices, labPalette, hexColors,
                actualWidth, actualHeight, knobs
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

            // ── Embed separation manifest ──
            // Written AFTER resumeHistory, still inside the same executeAsModal.
            // Only writeStructuredXMP (set XMPMetadataAsUTF8) — NOT writeManifestIPTC.
            // set fileInfo always creates a "File Info" history entry regardless of
            // modal context, and silently drops inside suspendHistory. The structured
            // reveal: XMP namespace contains all machine-readable data; IPTC is redundant.
            const elapsedSoFar = Date.now() - t0;
            let xmpError = null;
            try {
                const manifest = self._sessionState.buildManifest({
                    layerCount: layers.length,
                    elapsedMs: elapsedSoFar
                });
                // XMP: structured reveal: namespace (machine-readable, no history entry)
                await PhotoshopBridge.writeStructuredXMP(manifest);
                logger.log(`[ProductionWorker] Manifest embedded (reveal: XMP)`);
            } catch (xmpErr) {
                xmpError = xmpErr;
                logger.log(`[ProductionWorker] Manifest write failed (non-fatal): ${xmpErr && xmpErr.message || String(xmpErr)}`);
            }

            return { layerCount: layers.length, xmpError };
        }, {
            commandName: "Reveal"
        });

        const elapsedMs = Date.now() - t0;
        logger.log(`[ProductionWorker] Done: ${result.layerCount} layers in ${elapsedMs}ms`);

        return { layerCount: result.layerCount, elapsedMs, xmpError: result.xmpError || null };
    }

    // ─── Loupe Tile Rendering ─────────────────────────────────────
    // Renders a small native-resolution tile for 1:1 loupe inspection.
    // Uses the locked palette and current knobs — no re-posterization.

    /**
     * Render a high-res separation for a specific tile (loupe ROI).
     * Reads native-res pixels from PS, maps to locked palette, applies knobs,
     * returns RGBA preview buffer.
     *
     * For zoom > 1:1, reads the full native-res source rect and downsamples
     * ourselves (box filter) before separation. PS getPixels' sourceBounds +
     * targetSize combination produces incorrect crops, so we avoid combining them.
     *
     * @param {{left: number, top: number, right: number, bottom: number}} rect - Document bounds
     * @param {number} [downsampleFactor] - Box-filter downsample factor (2, 4, 8). Omit for 1:1.
     * @returns {Promise<{buffer: Uint8ClampedArray, width: number, height: number}>}
     */
    async renderLoupeTile(rect, downsampleFactor) {
        const labPalette = this._sessionState.getPalette();
        if (!labPalette || labPalette.length === 0) {
            throw new Error('No palette available for loupe');
        }

        const tile = await PhotoshopBridge.getTileLab(rect);

        let labPixels = tile.labPixels;
        let width = tile.width;
        let height = tile.height;

        // Box-filter downsample for zoom > 1:1 — reduces native-res tile
        // to ~256px before separation. Fast integer averaging in Lab space.
        if (downsampleFactor && downsampleFactor > 1) {
            const ds = ProductionWorker._downsampleLab(labPixels, width, height, downsampleFactor);
            labPixels = ds.labPixels;
            width = ds.width;
            height = ds.height;
        }

        const pixelCount = width * height;

        // Bilateral filter preprocessing — matches the proxy pipeline so loupe
        // colors look consistent with the main preview (no raw noise artifacts).
        // Skip when downsampled (zoom > 1:1): the box filter already averages
        // pixels, and bilateral on a downsampled tile doesn't match the proxy
        // pipeline (which filters at proxy resolution, not tile resolution).
        const BilateralFilter = Reveal.BilateralFilter;
        if (BilateralFilter && !downsampleFactor) {
            BilateralFilter.applyBilateralFilterLab(labPixels, width, height, 3, 5000);
        }

        // Map pixels using locked palette via SeparationEngine (L-weighted CIE76)
        const metric = this._sessionState.getState().distanceMetric || 'cie76';
        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
            labPixels, labPalette, null, width, height,
            { ditherType: 'none', distanceMetric: metric }
        );

        // Remap merged/deleted colors (same fix as production render)
        if (this._sessionState.mergeHistory.size > 0) {
            const remap = {};
            for (const [target, sources] of this._sessionState.mergeHistory) {
                for (const src of sources) remap[src] = target;
            }
            for (let i = 0; i < pixelCount; i++) {
                const t = remap[colorIndices[i]];
                if (t !== undefined) colorIndices[i] = t;
            }
        }

        // Apply knobs using shared MechanicalKnobs (same as _buildLayers and ProxyEngine)
        const knobs = this._sessionState.getMechanicalKnobs();

        if (knobs.minVolume > 0) {
            MechanicalKnobs.applyMinVolume(colorIndices, labPalette, pixelCount, knobs.minVolume);
        }

        // Build masks from (possibly remapped) color indices
        const masks = MechanicalKnobs.rebuildMasks(colorIndices, labPalette.length, pixelCount);

        // Loupe tiles are native resolution — no originalWidth scaling needed
        if (knobs.speckleRescue > 0) {
            MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, knobs.speckleRescue);
        }

        if (knobs.shadowClamp > 0) {
            MechanicalKnobs.applyShadowClamp(masks, colorIndices, labPalette, width, height, knobs.shadowClamp);
        }

        // Apply trapping — loupe is native resolution so trap pixels are correct
        if (knobs.trapSize > 0) {
            const TrapEngine = Reveal.TrapEngine;
            TrapEngine.applyTrapping(masks, labPalette, width, height, knobs.trapSize);
        }

        // Compute E_rev (Revelation Error) for this tile
        const RevelationError = Reveal.RevelationError;
        let eRev = 0;
        if (RevelationError) {
            const result = RevelationError.fromIndices(labPixels, colorIndices, labPalette, pixelCount);
            eRev = result.eRev;
        }

        // Generate RGBA preview from masks + colorIndices (D50 matches proxy preview)
        const rgbPalette = labPalette.map(c => Reveal.labToRgbD50(c));
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

        return { buffer, width, height, eRev, labPixels, colorIndices, labPalette };
    }

    // ─── Build Layer Objects ─────────────────────────────────────
    // Generates masks, applies knobs, skips empty layers.

    /**
     * Generate layer masks with mechanical knobs applied.
     * @param {Uint8Array} colorIndices - Palette index per pixel
     * @param {Array<{L,a,b}>} labPalette - Lab palette
     * @param {string[]} hexColors - Hex color strings for naming
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {{minVolume: number, speckleRescue: number, shadowClamp: number, trapSize: number}} knobs
     * @returns {Array<{labColor, hex, mask, width, height, name}>} Layer objects
     */
    _buildLayers(colorIndices, labPalette, hexColors, width, height, knobs) {
        const { minVolume, speckleRescue, shadowClamp, trapSize } = knobs;
        const layers = [];
        const pixelCount = width * height;
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

        // ── Apply trapping (production-only, after all other knobs) ──
        // Expands lighter colors under darker colors to prevent white gaps
        if (trapSize > 0) {
            const TrapEngine = Reveal.TrapEngine;
            const trapResult = TrapEngine.applyTrapping(masks, labPalette, width, height, trapSize);
            logger.log(`[ProductionWorker] Trapping: ${trapResult.trappedCount} colors trapped (max=${trapSize}px)`);
        }

        // Build layer objects — every palette color gets a layer.
        // "Once seen, there forever": the user approved this palette in the
        // preview. Production must honor it. Only truly empty masks (zero
        // pixels after knobs) are skipped. The user's only opt-out is
        // explicit deletion via PaletteSurgeon (Alt+click).
        for (let idx = 0; idx < labPalette.length; idx++) {
            const mask = masks[idx];

            let opaqueCount = 0;
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] === 255) opaqueCount++;
            }

            if (opaqueCount === 0) continue;

            layers.push({
                labColor: labPalette[idx],
                hex: hexColors[idx],
                mask,
                width,
                height
            });
        }

        // Sort layers by Lab L descending (lightest first).
        // Photoshop creates each new layer on top, so lightest ends up
        // at the bottom and darkest on top — correct for screen printing.
        layers.sort((a, b) => b.labColor.L - a.labColor.L);

        // Assign numbered names after sorting
        for (let i = 0; i < layers.length; i++) {
            const c = layers[i].labColor;
            const lab = `L${c.L.toFixed(0)} a${c.a >= 0 ? '+' : ''}${c.a.toFixed(0)} b${c.b >= 0 ? '+' : ''}${c.b.toFixed(0)}`;
            layers[i].name = `[${i + 1}] ${layers[i].hex} ${lab}`;
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

    // ─── Lab Downsample ──────────────────────────────────────
    // Box-filter downsample for loupe zoom > 1:1.
    // Averages factor×factor blocks in 16-bit Lab space.

    static _downsampleLab(labPixels, srcW, srcH, factor) {
        const dstW = Math.floor(srcW / factor);
        const dstH = Math.floor(srcH / factor);
        const out = new Uint16Array(dstW * dstH * 3);
        const area = factor * factor;

        for (let dy = 0; dy < dstH; dy++) {
            const srcRowBase = dy * factor;
            for (let dx = 0; dx < dstW; dx++) {
                const srcColBase = dx * factor;
                let sumL = 0, sumA = 0, sumB = 0;
                for (let iy = 0; iy < factor; iy++) {
                    const rowOff = (srcRowBase + iy) * srcW;
                    for (let ix = 0; ix < factor; ix++) {
                        const si = (rowOff + srcColBase + ix) * 3;
                        sumL += labPixels[si];
                        sumA += labPixels[si + 1];
                        sumB += labPixels[si + 2];
                    }
                }
                const di = (dy * dstW + dx) * 3;
                out[di]     = (sumL / area + 0.5) | 0;
                out[di + 1] = (sumA / area + 0.5) | 0;
                out[di + 2] = (sumB / area + 0.5) | 0;
            }
        }

        return { labPixels: out, width: dstW, height: dstH };
    }
}

module.exports = ProductionWorker;
