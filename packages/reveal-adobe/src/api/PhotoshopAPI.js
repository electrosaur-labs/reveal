/**
 * PhotoshopAPI - Wrapper for Photoshop UXP API
 *
 * Simplifies common operations like reading documents, getting pixels, creating layers.
 * Phase 2.5: Posterization Engine & Preview UI
 */

const { app, action, core } = require("photoshop");
const { imaging } = require("photoshop");

// Import @reveal/core utilities
const Reveal = require("@reveal/core");
const DocumentValidator = Reveal.engines.DocumentValidator;
const logger = Reveal.logger;

class PhotoshopAPI {
    /**
     * Get the active document
     *
     * @returns {Document|null} - Active document or null if none open
     */
    static getActiveDocument() {
        try {
            return app.activeDocument;
        } catch (error) {
            logger.error("No active document:", error);
            return null;
        }
    }

    /**
     * Get Lab pixels from active document (full document, all layers flattened)
     *
     * Document must be in Lab color mode (validated at workflow start).
     * Returns Lab data matching document bit depth (8-bit or 16-bit).
     *
     * @param {number} maxWidth - Maximum width for preview (scales down if needed)
     * @param {number} maxHeight - Maximum height for preview (scales down if needed)
     * @returns {Promise<Object>} - {pixels: Uint8ClampedArray|Uint16Array, width, height, format: 'lab', originalWidth, originalHeight, bitDepth: 8|16}
     */
    static async getDocumentPixels(maxWidth = 800, maxHeight = 800) {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('reveal_checkpoint', 'getDocumentPixels_start');
        }

        const doc = this.getActiveDocument();
        if (!doc) {
            throw new Error("No active document");
        }

        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('reveal_checkpoint', 'getDocumentPixels_got_doc');
        }

        // Extract bit depth from document (for output decisions only)
        const bitDepthStr = String(doc.bitsPerChannel).toLowerCase();
        const docBitDepth = bitDepthStr.includes('16') || doc.bitsPerChannel === 16 ? 16 : 8;

        // Always request native 16-bit Lab from Photoshop — even for 8-bit docs,
        // PS upsamples internally with full precision. Eliminates manual lab8to16()
        // and matches reveal-navigator's approach (confirmed working 2026-02-16).
        const componentSize = 16;

        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('reveal_checkpoint', 'getDocumentPixels_bitdepth_checked');
        }

        // Calculate scale to fit within maxWidth x maxHeight
        const scale = Math.min(1.0, maxWidth / doc.width, maxHeight / doc.height);
        const scaledWidth = Math.round(doc.width * scale);
        const scaledHeight = Math.round(doc.height * scale);

        // Get pixels from document
        // Note: This gets the composite (all visible layers merged)
        // CRITICAL: Pure Lab Stream - all 3 parameters required to prevent conversion
        // Without these, Photoshop converts Lab→RGB→sRGB, clipping colors and destroying perceptual data
        // Lab documents have NO alpha channel - Lab is always 3 channels (L, a, b) only
        // IMPORTANT: imaging.getPixels() requires modal scope even when called from non-modal dialog
        let pixelData;
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('reveal_checkpoint', 'before_imaging_getPixels');
            }

            // Wrap in executeAsModal for document access from non-modal dialog
            pixelData = await core.executeAsModal(async () => {
                return await imaging.getPixels({
                    documentID: doc.id,
                    targetSize: {
                        width: scaledWidth,
                        height: scaledHeight
                    },
                    componentSize: componentSize,  // Always 16 — native 16-bit Lab reads (confirmed working 2026-02-16)
                    targetComponentCount: 3,       // 3 channels: L, a, b (Lab has NO alpha)
                    colorSpace: "Lab"              // THE CRITICAL PARAMETER: Request raw Lab channels (no conversion)
                });
            }, { commandName: "Get Document Pixels" });

            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('reveal_checkpoint', 'after_imaging_getPixels');
            }
        } catch (error) {
            logger.error('imaging.getPixels() failed:', error);
            // Handle smart object errors
            if (error.message && error.message.includes('-25010')) {
                throw new Error(
                    'Document contains smart objects that cannot be processed. ' +
                    'Please flatten or rasterize smart object layers before running Reveal. ' +
                    '(Layer > Smart Objects > Rasterize Layer)'
                );
            }
            throw error;
        }

        // Extract RGBA data and actual dimensions
        let rgbaData;
        let actualWidth, actualHeight;

        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('reveal_checkpoint', 'extracting_pixel_data');
        }

        if (pixelData.imageData) {
            // ImageData has width and height properties
            actualWidth = pixelData.imageData.width;
            actualHeight = pixelData.imageData.height;

            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('reveal_checkpoint', 'before_getData');
            }

            // getData() also requires modal scope
            rgbaData = await core.executeAsModal(async () => {
                return await pixelData.imageData.getData({ chunky: true });
            }, { commandName: "Get Image Data" });

            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('reveal_checkpoint', 'after_getData');
            }
        } else if (pixelData.pixels) {
            // Already Uint8ClampedArray - use calculated dimensions
            actualWidth = scaledWidth;
            actualHeight = scaledHeight;
            rgbaData = pixelData.pixels;

            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('reveal_checkpoint', 'got_pixels_directly');
            }
        } else {
            throw new Error("Could not extract pixel data from imaging.getPixels() result");
        }

        // Verify and convert data type if needed
        if (componentSize === 16 && !(rgbaData instanceof Uint16Array)) {
            // Convert byte array to Uint16Array view
            // UXP returns bytes in platform-native order (little-endian on most systems)
            if (rgbaData instanceof Uint8Array || rgbaData instanceof Uint8ClampedArray) {
                rgbaData = new Uint16Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength / 2);
            }
        } else if (componentSize === 8 && !(rgbaData instanceof Uint8Array) && !(rgbaData instanceof Uint8ClampedArray)) {
            logger.error(`Expected Uint8Array for 8-bit but got ${rgbaData.constructor.name}`);
        }

        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('reveal_checkpoint', 'pixel_data_extracted');
        }

        // Check document mode
        const docMode = String(doc.mode);

        // Lab mode special handling (Photoshop returns 'labColorMode')
        const isLabMode = docMode === 'labColorMode';

        // Lab mode check (validated at workflow start - should always be true)
        if (!isLabMode) {
            throw new Error(
                `Document must be in Lab color mode (currently: ${docMode}). ` +
                `This should have been caught by validation. Please report this bug.`
            );
        }

        // Lab mode: 3 channels (L, a, b)
        // 8-bit:  L: 0-255, a: 0-255, b: 0-255
        // 16-bit: L: 0-32768, a: 0-32768 (neutral=16384), b: 0-32768 (neutral=16384)
        // NOTE: Lab has NO alpha channel - all pixels are opaque
        const expectedLab = actualWidth * actualHeight * 3;

        if (rgbaData.length !== expectedLab) {
            throw new Error(
                `Unexpected Lab pixel data size: got ${rgbaData.length} elements, ` +
                `expected ${expectedLab} (Lab 3 channels) for ${actualWidth}x${actualHeight}`
            );
        }

        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('reveal_checkpoint', 'getDocumentPixels_success');
        }

        // Data is already native 16-bit Lab from Photoshop (no manual conversion needed)
        return {
            pixels: rgbaData,           // Lab values - native 16-bit encoding (0-32768)
            width: actualWidth,
            height: actualHeight,
            format: 'lab',
            bitDepth: docBitDepth,      // ORIGINAL doc bit depth (8 or 16) - for output decisions
            originalWidth: doc.width,
            originalHeight: doc.height,
            scale: Math.min(actualWidth / doc.width, actualHeight / doc.height)
        };
    }

    /**
     * Convert 8-bit Lab pixel data to 16-bit Lab encoding
     *
     * Photoshop Lab encoding:
     * - 8-bit:  L=0-255, a/b=0-255 (neutral=128)
     * - 16-bit: L=0-32768, a/b=0-32768 (neutral=16384)
     *
     * The conversion ensures consistent perceptual values:
     * - L: scale by 32768/255 (linear scale)
     * - a/b: convert to signed, scale, convert back to unsigned
     *
     * @param {Uint8Array|Uint8ClampedArray} lab8 - 8-bit Lab pixel data (L,a,b,L,a,b,...)
     * @returns {Uint16Array} - 16-bit Lab pixel data
     */
    static lab8to16(lab8) {
        const lab16 = new Uint16Array(lab8.length);
        const lScale = 32768 / 255;
        const abScale = 16384 / 128;  // Scale factor for a/b channels

        for (let i = 0; i < lab8.length; i += 3) {
            // L channel: direct scale (0-255 → 0-32768)
            lab16[i] = Math.round(lab8[i] * lScale);

            // a channel: convert to signed (-128 to +127), scale, convert to unsigned (0-32768)
            // 8-bit: 0=−128, 128=0, 255=+127
            // 16-bit: 0=−128, 16384=0, 32768=+128
            lab16[i + 1] = Math.round((lab8[i + 1] - 128) * abScale + 16384);

            // b channel: same as a channel
            lab16[i + 2] = Math.round((lab8[i + 2] - 128) * abScale + 16384);
        }

        return lab16;
    }

    /**
     * Convert 16-bit Lab pixel data to 8-bit Lab encoding
     *
     * Inverse of lab8to16(). Used when outputting to 8-bit documents.
     *
     * @param {Uint16Array} lab16 - 16-bit Lab pixel data
     * @returns {Uint8Array} - 8-bit Lab pixel data
     */
    static lab16to8(lab16) {
        const lab8 = new Uint8Array(lab16.length);
        const lScale = 255 / 32768;
        const abScale = 128 / 16384;  // Scale factor for a/b channels

        for (let i = 0; i < lab16.length; i += 3) {
            // L channel: direct scale (0-32768 → 0-255)
            lab8[i] = Math.round(Math.min(255, lab16[i] * lScale));

            // a channel: convert to signed, scale, convert to unsigned (0-255)
            lab8[i + 1] = Math.round(Math.max(0, Math.min(255, (lab16[i + 1] - 16384) * abScale + 128)));

            // b channel: same as a channel
            lab8[i + 2] = Math.round(Math.max(0, Math.min(255, (lab16[i + 2] - 16384) * abScale + 128)));
        }

        return lab8;
    }

    /**
     * Get high-resolution crop from specific document region (Option C: Smart Loading)
     * Fetches ONLY the viewport window at full resolution using batchPlay
     *
     * @param {number} x - Absolute X coordinate (in full document pixels)
     * @param {number} y - Absolute Y coordinate (in full document pixels)
     * @param {number} width - Crop width (e.g., 800 for viewport)
     * @param {number} height - Crop height (e.g., 800 for viewport)
     * @returns {Promise<Object>} - {pixels: Uint16Array (LAB), width, height, format: 'lab', bitDepth}
     */
    static async getHighResCrop(x, y, width, height) {
        const doc = this.getActiveDocument();
        if (!doc) {
            throw new Error("No active document");
        }

        // Constrain crop to document bounds
        const cropX = Math.max(0, Math.min(x, doc.width - width));
        const cropY = Math.max(0, Math.min(y, doc.height - height));
        const cropWidth = Math.min(width, doc.width - cropX);
        const cropHeight = Math.min(height, doc.height - cropY);

        // Always request native 16-bit Lab (PS upsamples 8-bit docs internally)
        const componentSize = 16;

        // Fetch pixels for specific region
        let pixelData;
        try {
            pixelData = await core.executeAsModal(async () => {
                return await imaging.getPixels({
                    documentID: doc.id,
                    sourceBounds: {
                        left: cropX,
                        top: cropY,
                        right: cropX + cropWidth,
                        bottom: cropY + cropHeight
                    },
                    componentSize: componentSize,
                    targetComponentCount: 3,
                    colorSpace: "Lab"
                });
            }, { commandName: "Get High-Res Crop" });
        } catch (error) {
            logger.error('[PhotoshopAPI] Failed to fetch high-res crop:', error);
            throw error;
        }

        // Extract RGBA data
        let rgbaData;
        if (pixelData.imageData) {
            rgbaData = await core.executeAsModal(async () => {
                return await pixelData.imageData.getData({ chunky: true });
            }, { commandName: "Get Crop Data" });
        } else if (pixelData.pixels) {
            rgbaData = pixelData.pixels;
        } else {
            throw new Error("Could not extract pixel data from high-res crop");
        }

        // Convert to Uint16Array if needed (native 16-bit)
        if (!(rgbaData instanceof Uint16Array)) {
            if (rgbaData instanceof Uint8Array || rgbaData instanceof Uint8ClampedArray) {
                rgbaData = new Uint16Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength / 2);
            }
        }

        return {
            pixels: rgbaData,
            width: cropWidth,
            height: cropHeight,
            format: 'lab',
            bitDepth: 16,
            cropX: cropX,
            cropY: cropY
        };
    }

    /**
     * Create a data URL from pixel data (for displaying in <img> tags)
     *
     * @param {Uint8ClampedArray} pixels - RGBA pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {string} - data:image/png;base64,... URL
     */
    static pixelsToDataURL(pixels, width, height) {
        // Create canvas element
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');

        // UXP canvas is limited - use optimized scanline drawing
        for (let y = 0; y < height; y++) {
            let x = 0;
            while (x < width) {
                const idx = (y * width + x) * 4;
                const r = pixels[idx];
                const g = pixels[idx + 1];
                const b = pixels[idx + 2];
                const a = pixels[idx + 3] / 255;

                // Find run length of same color
                let runLength = 1;
                while (x + runLength < width) {
                    const nextIdx = (y * width + (x + runLength)) * 4;
                    if (pixels[nextIdx] === r &&
                        pixels[nextIdx + 1] === g &&
                        pixels[nextIdx + 2] === b &&
                        pixels[nextIdx + 3] === pixels[idx + 3]) {
                        runLength++;
                    } else {
                        break;
                    }
                }

                // Draw horizontal run
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
                ctx.fillRect(x, y, runLength, 1);

                x += runLength;
            }
        }

        // Convert to data URL
        return canvas.toDataURL('image/png');
    }

    /**
     * Validate document is suitable for Reveal
     *
     * @param {Document} [doc] - Optional document to validate (defaults to active document)
     * @returns {Object} - {valid: boolean, errors: Array<string>, warnings: Array<string>}
     */
    static validateDocument(doc = null) {
        if (!doc) {
            doc = this.getActiveDocument();
        }

        // Use pure validation logic (testable without UXP)
        return DocumentValidator.validate(doc);
    }

    /**
     * Get document info for display
     *
     * @returns {Object|null} - {name, width, height, colorMode, bitDepth} or null
     */
    static getDocumentInfo() {
        const doc = this.getActiveDocument();
        if (!doc) return null;

        return {
            name: doc.name,
            width: doc.width,
            height: doc.height,
            colorMode: doc.mode,
            bitDepth: doc.bitsPerChannel,
            resolution: doc.resolution || 72  // PPI (pixels per inch), defaults to 72
        };
    }

    /**
     * Create a new layer with pixel data
     *
     * @param {string} name - Layer name
     * @param {Uint8ClampedArray} pixels - RGBA pixel data
     * @param {number} width - Layer width
     * @param {number} height - Layer height
     * @param {Object} options - Optional parameters
     * @param {Object} options.labColor - Optional Lab color {L, a, b} - if provided, skips RGB→Lab conversion
     * @returns {Promise<Layer>} - Created layer
     */
    static async createLayer(name, pixels, width, height, options = {}) {
        const doc = this.getActiveDocument();
        if (!doc) {
            throw new Error("No active document");
        }

        // Create new layer
        const layer = await doc.createLayer({ name });

        // Check if document is in Lab mode (Photoshop returns 'labColorMode')
        const isLabMode = doc.mode === 'labColorMode';

        let imageData;

        if (isLabMode) {
            // Lab mode document: Use Lab pixel data
            const labPixels = new Uint8Array((width * height * 3));

            // Three paths for Lab pixel data:

            if (options.labColor) {
                // Path 1: Fill entire layer with single Lab color (solid fill)
                const lab = options.labColor;

                // Convert Lab perceptual ranges to byte encoding:
                const L_byte = Math.max(0, Math.min(255, Math.round((lab.L / 100) * 255)));
                const a_byte = Math.max(0, Math.min(255, Math.round(lab.a + 128)));
                const b_byte = Math.max(0, Math.min(255, Math.round(lab.b + 128)));

                // Fill entire layer with this Lab color
                for (let i = 0; i < labPixels.length; i += 3) {
                    labPixels[i] = L_byte;
                    labPixels[i + 1] = a_byte;
                    labPixels[i + 2] = b_byte;
                }
            } else if (options.isLabPixels && !options.maskData) {
                // Path 2: Pixels are ALREADY Lab bytes (3 bytes/pixel) - just copy directly
                // CRITICAL FIX: This prevents coordinate drift from RGBA→Lab conversion

                if (pixels.length !== width * height * 3) {
                    throw new Error(
                        `Lab pixel data size mismatch: expected ${width * height * 3} bytes ` +
                        `(${width}×${height}×3), got ${pixels.length} bytes`
                    );
                }

                // Direct copy - pixels are already in Lab byte format
                labPixels.set(pixels);

            } else if (options.isLabPixels && options.maskData) {
                // Path 2b: Lab + Alpha (mask) - Create 4-component Lab+Alpha data
                // This creates transparency directly in the layer without separate mask channel

                if (pixels.length !== width * height * 3) {
                    throw new Error(
                        `Lab pixel data size mismatch: expected ${width * height * 3} bytes, got ${pixels.length} bytes`
                    );
                }

                if (options.maskData.length !== width * height) {
                    throw new Error(
                        `Mask data size mismatch: expected ${width * height} bytes, got ${options.maskData.length} bytes`
                    );
                }

                // Create Lab+Alpha data (4 bytes/pixel: L, a, b, alpha)
                const labAlphaPixels = new Uint8Array(width * height * 4);
                for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
                    labAlphaPixels[j] = pixels[i];         // L
                    labAlphaPixels[j + 1] = pixels[i + 1]; // a
                    labAlphaPixels[j + 2] = pixels[i + 2]; // b
                    labAlphaPixels[j + 3] = options.maskData[i / 3];  // alpha (from mask: 0-255)
                }

                // Create Lab+Alpha ImageData
                imageData = await imaging.createImageDataFromBuffer(labAlphaPixels, {
                    width: width,
                    height: height,
                    components: 4,  // Lab + Alpha
                    chunky: true,
                    colorSpace: "Lab",
                    pixelFormat: "Lab-A" // Lab with alpha channel
                });

                // Write pixels and return early (skip the normal Lab path below)
                await imaging.putPixels({
                    layerID: layer.id,
                    imageData: imageData
                });

                imageData.dispose();
                return layer;

            } else {
                // Path 3: Legacy RGB→Lab conversion (4 bytes/pixel RGBA → 3 bytes/pixel Lab)
                for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
                    const r = pixels[i];
                    const g = pixels[i + 1];
                    const b = pixels[i + 2];

                    const lab = Reveal.rgbToLab(r, g, b);

                    labPixels[j] = Math.max(0, Math.min(255, Math.round((lab.L / 100) * 255)));
                    labPixels[j + 1] = Math.max(0, Math.min(255, Math.round(lab.a + 128)));
                    labPixels[j + 2] = Math.max(0, Math.min(255, Math.round(lab.b + 128)));
                }
            }

            imageData = await imaging.createImageDataFromBuffer(labPixels, {
                width: width,
                height: height,
                components: 3,  // Lab (L, a, b)
                chunky: true,
                colorSpace: "Lab"
            });
        } else {
            // RGB/CMYK mode document: Use RGB pixels directly
            const pixelBuffer = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels);

            imageData = await imaging.createImageDataFromBuffer(pixelBuffer, {
                width: width,
                height: height,
                components: 4,  // RGBA
                chunky: true,
                colorSpace: "RGB"
            });
        }

        // Write pixels to layer
        await imaging.putPixels({
            layerID: layer.id,
            imageData: imageData
        });

        // Clean up - release memory
        imageData.dispose();

        return layer;
    }

    /**
     * Create Lab separation layer using the WORKING revealSelection approach
     *
     * Breakthrough solution: Creates Fill Layer with mask from arbitrary pixel data
     * by using transparency-based selection (no direct mask writes).
     *
     * @param {Object} layerData - Layer specification
     * @param {string} layerData.name - Layer name
     * @param {Object} layerData.labColor - Lab color {L, a, b}
     * @param {Uint8Array} layerData.mask - Grayscale mask (0-255, where 255=reveal, 0=hide)
     * @param {number} layerData.width - Layer width
     * @param {number} layerData.height - Layer height
     * @returns {Promise<Layer>} - Created layer
     */
    static async createLabSeparationLayer(layerData) {
        localStorage.setItem('reveal_checkpoint', 'createLabSep_start');

        const { name, labColor, mask, width, height } = layerData;

        localStorage.setItem('reveal_checkpoint', 'createLabSep_after_destructure');

        const doc = this.getActiveDocument();

        localStorage.setItem('reveal_checkpoint', 'createLabSep_got_doc');

        try {
            localStorage.setItem('reveal_checkpoint', 'createLabSep_before_protective');

            // STEP 1: Create protective layer (prevents background corruption)
            await action.batchPlay([{
                "_obj": "make",
                "_target": [{ "_ref": "layer" }],
                "name": "__PROTECTIVE__"
            }], {});

            localStorage.setItem('reveal_checkpoint', 'createLabSep_after_protective');

            // STEP 2: Create temporary raster layer to hold mask data
            await action.batchPlay([{
                "_obj": "make",
                "_target": [{ "_ref": "layer" }],
                "name": "__TEMP_MASK__"
            }], {});

            localStorage.setItem('reveal_checkpoint', 'createLabSep_after_temp_layer');

            const tempLayer = doc.activeLayers[0];
            const tempLayerID = tempLayer.id;

            localStorage.setItem('reveal_checkpoint', 'createLabSep_before_rgba_build');

            // STEP 3: Write RGBA mask data to temp layer (alpha channel = mask)
            // CRITICAL: Temp layer is RGB and only used for transparency selection
            // ALWAYS use 8-bit RGB regardless of document bit depth
            // The alpha channel carries the mask data - bit depth doesn't matter for this purpose
            const rgbaData = new Uint8Array(width * height * 4);
            for (let i = 0; i < mask.length; i++) {
                const idx = i * 4;
                rgbaData[idx] = 255;           // R = white
                rgbaData[idx + 1] = 255;       // G = white
                rgbaData[idx + 2] = 255;       // B = white
                rgbaData[idx + 3] = mask[i];   // A = mask value (0=transparent, 255=opaque)
            }

            localStorage.setItem('reveal_checkpoint', 'createLabSep_before_imageData');

            const imageData = await imaging.createImageDataFromBuffer(rgbaData, {
                width, height,
                components: 4,
                componentSize: 8,
                chunky: true,
                colorSpace: "RGB",
                colorProfile: "sRGB IEC61966-2.1"
            });

            localStorage.setItem('reveal_checkpoint', 'createLabSep_after_imageData');

            localStorage.setItem('reveal_checkpoint', 'createLabSep_before_putPixels');

            await imaging.putPixels({
                layerID: tempLayer.id,
                imageData: imageData,
                replace: true
            });

            localStorage.setItem('reveal_checkpoint', 'createLabSep_after_putPixels');

            imageData.dispose();

            localStorage.setItem('reveal_checkpoint', 'createLabSep_before_transparency_select');

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

            // STEP 6: Create Fill Layer + mask using revealSelection (CRITICAL: Single batchPlay call)
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

        } catch (error) {
            logger.error(`Failed to create layer ${name}:`, error);

            // CLEANUP: Try to delete any temp layers that might have been created
            try {
                const tempLayers = doc.layers.filter(l =>
                    l.name === '__TEMP_MASK__' || l.name === '__PROTECTIVE__'
                );
                for (const layer of tempLayers) {
                    await layer.delete();
                }
            } catch (cleanupErr) {
                logger.warn(`Could not clean up temp layers: ${cleanupErr.message}`);
            }

            throw new Error(`Failed to create Lab separation layer: ${error.message}`);
        }
    }

    /**
     * Create Lab separation layer for 16-BIT Lab documents
     *
     * 16-bit Lab documents do not support transparency-based selection (Photoshop error -25920).
     * This method uses direct mask writing instead of the 5-7 step transparency approach.
     *
     * DO NOT use for 8-bit documents - use createLabSeparationLayer instead.
     *
     * @param {Object} layerData - Layer specification
     * @param {string} layerData.name - Layer name
     * @param {Object} layerData.labColor - Lab color {L, a, b}
     * @param {Uint8Array} layerData.mask - Grayscale mask (0-255, where 255=reveal, 0=hide)
     * @param {number} layerData.width - Layer width
     * @param {number} layerData.height - Layer height
     * @returns {Promise<Layer>} - Created layer
     */
    static async createLabSeparationLayer16Bit(layerData) {
        localStorage.setItem('reveal_checkpoint', 'createLabSep16_start');

        const { name, labColor, mask, width, height } = layerData;

        localStorage.setItem('reveal_checkpoint', 'createLabSep16_destructured');

        const doc = this.getActiveDocument();
        const bitDepthStr = String(doc.bitsPerChannel).toLowerCase();
        const is16bit = bitDepthStr.includes('16') || doc.bitsPerChannel === 16;
        const componentSize = is16bit ? 16 : 8;
        const maxValue = is16bit ? 32768 : 255;

        try {
            // STEP 1: Create temp layer for transparency-based selection
            localStorage.setItem('reveal_checkpoint', 'createLabSep16_before_temp_layer');

            await action.batchPlay([{
                "_obj": "make",
                "_target": [{ "_ref": "layer" }],
                "name": `__TEMP_${name}__`
            }], {});

            const tempLayer = doc.activeLayers[0];

            // STEP 2: Write RGBA data with mask as alpha channel
            localStorage.setItem('reveal_checkpoint', 'createLabSep16_before_rgba');

            const rgbaData = is16bit
                ? new Uint16Array(width * height * 4)
                : new Uint8Array(width * height * 4);

            for (let i = 0; i < width * height; i++) {
                const idx = i * 4;
                rgbaData[idx] = maxValue;     // R = white
                rgbaData[idx + 1] = maxValue; // G = white
                rgbaData[idx + 2] = maxValue; // B = white
                // Alpha = mask value (255 or 32768 for visible, 0 for transparent)
                const maskValue = mask[i];
                rgbaData[idx + 3] = is16bit ? (maskValue * 128) : maskValue;  // Scale 0-255 to 0-32768 for 16-bit
            }

            const imageData = await imaging.createImageDataFromBuffer(rgbaData, {
                width, height,
                components: 4,
                componentSize: componentSize,
                chunky: true,
                colorSpace: "RGB",
                colorProfile: "sRGB IEC61966-2.1"
            });

            localStorage.setItem('reveal_checkpoint', 'createLabSep16_before_putPixels');

            await imaging.putPixels({
                layerID: tempLayer.id,
                imageData: imageData,
                replace: true
            });

            imageData.dispose();

            // STEP 3: Load transparency as selection
            localStorage.setItem('reveal_checkpoint', 'createLabSep16_before_selection');

            await action.batchPlay([{
                "_obj": "set",
                "_target": [{ "_ref": "channel", "_property": "selection" }],
                "to": {
                    "_ref": "channel",
                    "_enum": "channel",
                    "_value": "transparencyEnum"
                }
            }], {});

            // STEP 4: Create fill layer AND mask in SINGLE batchPlay (critical for 16-bit!)
            localStorage.setItem('reveal_checkpoint', 'createLabSep16_before_fill_and_mask');

            await action.batchPlay([
                // First: create the fill layer
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
                // Second: immediately add mask from selection (in same batch!)
                {
                    "_obj": "make",
                    "_target": [{ "_ref": "channel", "_enum": "channel", "_value": "mask" }],
                    "new": { "_class": "channel" },
                    "at": { "_ref": "layer", "_enum": "ordinal", "_value": "targetEnum" },
                    "using": { "_enum": "userMaskEnabled", "_value": "revealSelection" }
                }
            ], {});

            localStorage.setItem('reveal_checkpoint', 'createLabSep16_after_fill_and_mask');

            const createdLayer = doc.activeLayers[0];
            createdLayer.name = name;

            // STEP 5: Delete temp layer
            localStorage.setItem('reveal_checkpoint', 'createLabSep16_before_delete_temp');

            await tempLayer.delete();

            // STEP 6: Clear selection
            await action.batchPlay([{
                "_obj": "set",
                "_target": [{ "_ref": "channel", "_property": "selection" }],
                "to": { "_enum": "ordinal", "_value": "none" }
            }], {});

            localStorage.setItem('reveal_checkpoint', 'createLabSep16_complete');

            return createdLayer;

        } catch (error) {
            logger.error(`Failed to create 16-bit layer ${name}:`, error);
            // Try cleanup
            try {
                const tempLayers = doc.layers.filter(l => l.name.startsWith('__TEMP_'));
                for (const layer of tempLayers) {
                    await layer.delete();
                }
            } catch (cleanupErr) {
                logger.error(`Could not clean up temp layers: ${cleanupErr.message}`);
            }
            throw new Error(`Failed to create 16-bit Lab fill layer: ${error.message}`);
        }
    }

    /**
     * Add layer mask for 16-BIT Lab documents (direct mask writing)
     *
     * DO NOT use for 8-bit documents - use addLayerMask instead.
     *
     * @param {number} layerID - Layer ID to add mask to
     * @param {Uint8Array} maskData - Grayscale mask data (255 = visible, 0 = hidden)
     * @param {number} width - Mask width
     * @param {number} height - Mask height
     * @returns {Promise<void>}
     */
    static async addLayerMask16Bit(layerID, maskData, width, height) {
        localStorage.setItem('reveal_checkpoint', 'addMask16_start');

        try {
            // NOTE: Layer should already be active from createLabSeparationLayer16Bit

            // STEP 1: Create mask channel on active layer (targetEnum pattern from 8-bit code)
            localStorage.setItem('reveal_checkpoint', 'addMask16_before_create_mask');

            await action.batchPlay([{
                _obj: "make",
                _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }],
                new: { _class: "channel" },
                at: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }, // Active layer, like 8-bit code
                using: { _enum: "userMaskEnabled", _value: "revealAll" }
            }], {
                synchronousExecution: false,
                modalBehavior: "execute"
            });

            localStorage.setItem('reveal_checkpoint', 'addMask16_after_create_mask');

            // STEP 2: Write mask data using batchPlay "put" with rawData
            // Masks are always 8-bit, even in 16-bit documents
            localStorage.setItem('reveal_checkpoint', 'addMask16_before_put');

            await action.batchPlay([{
                _obj: "put",
                _target: {
                    _ref: "channel",
                    _enum: "channel",
                    _value: "mask" // Target the active layer's mask
                },
                using: {
                    _obj: "rawData",
                    data: maskData.buffer, // Use 8-bit mask data buffer
                    width: width,
                    height: height,
                    depth: 8 // Masks are always 8-bit
                }
            }], {});

            localStorage.setItem('reveal_checkpoint', 'addMask16_success');
        } catch (error) {
            logger.error(`Failed to add 16-bit layer mask:`, error);
            throw new Error(`Failed to add 16-bit layer mask: ${error.message}`);
        }
    }

    /**
     * Add a layer mask to control layer visibility (LEGACY METHOD - use createLabSeparationLayer instead)
     *
     * @param {number} layerID - Layer ID to add mask to
     * @param {Uint8Array} maskData - Grayscale mask data (255 = visible, 0 = hidden)
     * @param {number} width - Mask width
     * @param {number} height - Mask height
     * @returns {Promise<void>}
     */
    static async addLayerMask(layerID, maskData, width, height) {
        try {
            // STEP 1: Use BatchPlay to create empty mask channel
            await action.batchPlay([
                {
                    _obj: "make",
                    _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }],
                    new: { _class: "channel" },
                    at: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
                    using: { _enum: "userMaskEnabled", _value: "revealAll" }
                }
            ], {
                synchronousExecution: false,
                modalBehavior: "execute"
            });

            // STEP 3: Mask channels are GRAYSCALE (1 component), not Lab
            // Even though document is Lab mode, mask is single-channel 0-255
            const pixelCount = width * height;

            // maskData is already grayscale Uint8Array (0-255)
            // No conversion needed!

            // STEP 4: Create Grayscale ImageData for the mask
            const maskImageData = await imaging.createImageDataFromBuffer(maskData, {
                width: width,
                height: height,
                components: 1,  // Grayscale (1 channel)
                chunky: true,
                colorSpace: "Grayscale",
                colorProfile: "Gray Gamma 2.2"  // Hard edges for screen printing
            });

            // STEP 5: Write mask data to the mask channel
            await imaging.putPixels({
                layerID: layerID,
                imageData: maskImageData,
                targetMask: true  // CRITICAL: Write to mask channel, not layer pixels
            });

            // Clean up
            maskImageData.dispose();
        } catch (error) {
            logger.error(`Failed to add layer mask:`, error);
            throw new Error(`Failed to add layer mask: ${error.message}`);
        }
    }

    /**
     * Delete all layers except background (cleanup before separation)
     *
     * @returns {Promise<void>}
     */
    static async deleteAllLayersExceptBackground() {
        const doc = this.getActiveDocument();
        if (!doc) {
            throw new Error("No active document");
        }

        // CLEANUP: First, find and delete any orphaned temp layers from failed runs
        const orphanedTempLayers = doc.layers.filter(l =>
            l.name === '__TEMP_MASK__' || l.name === '__PROTECTIVE__'
        );
        if (orphanedTempLayers.length > 0) {
            for (const layer of orphanedTempLayers) {
                try {
                    await layer.delete();
                } catch (err) {
                    logger.error(`Failed to delete orphan: ${err.message}`);
                }
            }
        }

        // Get all remaining non-background layers
        const layersToDelete = doc.layers.filter(layer => !layer.isBackgroundLayer);

        if (layersToDelete.length === 0) {
            return;
        }

        // Delete in reverse order (top to bottom) to avoid index issues
        for (let i = layersToDelete.length - 1; i >= 0; i--) {
            const layer = layersToDelete[i];
            try {
                await layer.delete();
            } catch (err) {
                logger.error(`Failed to delete layer "${layer.name}": ${err.message}`);
            }
        }
    }
}

// Export for use in plugin
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PhotoshopAPI;
}
