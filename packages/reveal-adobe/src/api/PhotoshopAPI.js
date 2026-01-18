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
     * Returns 3 bytes per pixel: L (0-255), a (0-255), b (0-255).
     *
     * @param {number} maxWidth - Maximum width for preview (scales down if needed)
     * @param {number} maxHeight - Maximum height for preview (scales down if needed)
     * @returns {Promise<Object>} - {pixels: Uint8ClampedArray, width, height, format: 'lab', originalWidth, originalHeight}
     */
    static async getDocumentPixels(maxWidth = 800, maxHeight = 800) {
        const doc = this.getActiveDocument();
        if (!doc) {
            throw new Error("No active document");
        }

        logger.log(`Reading document: ${doc.name} (${doc.width}x${doc.height})`);

        // Calculate scale to fit within maxWidth x maxHeight
        const scale = Math.min(1.0, maxWidth / doc.width, maxHeight / doc.height);
        const scaledWidth = Math.round(doc.width * scale);
        const scaledHeight = Math.round(doc.height * scale);

        logger.log(`Scaling to ${scaledWidth}x${scaledHeight} (${(scale * 100).toFixed(1)}%)`);

        // Get pixels from document
        // Note: This gets the composite (all visible layers merged)
        // CRITICAL: Pure Lab Stream - all 3 parameters required to prevent conversion
        // Without these, Photoshop converts Lab→RGB→sRGB, clipping colors and destroying perceptual data
        // Lab documents have NO alpha channel - Lab is always 3 channels (L, a, b) only
        let pixelData;
        try {
            logger.log('STEP 1: About to call imaging.getPixels()...');
            logger.log(`  documentID: ${doc.id}`);
            logger.log(`  targetSize: ${scaledWidth}x${scaledHeight}`);
            logger.log(`  componentSize: 8`);
            logger.log(`  targetComponentCount: 3`);
            logger.log(`  colorSpace: Lab`);

            pixelData = await imaging.getPixels({
                documentID: doc.id,
                targetSize: {
                    width: scaledWidth,
                    height: scaledHeight
                },
                componentSize: 8,           // 8-bit per channel
                targetComponentCount: 3,    // 3 channels: L, a, b (Lab has NO alpha)
                colorSpace: "Lab"           // THE CRITICAL PARAMETER: Request raw Lab channels (no conversion)
            });

            logger.log('STEP 2: imaging.getPixels() returned successfully');
        } catch (error) {
            logger.error('STEP 2 FAILED: imaging.getPixels() threw error:', error);
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

        if (pixelData.imageData) {
            // ImageData has width and height properties
            actualWidth = pixelData.imageData.width;
            actualHeight = pixelData.imageData.height;
            rgbaData = await pixelData.imageData.getData({ chunky: true });
        } else if (pixelData.pixels) {
            // Already Uint8ClampedArray - use calculated dimensions
            actualWidth = scaledWidth;
            actualHeight = scaledHeight;
            rgbaData = pixelData.pixels;
        } else {
            throw new Error("Could not extract pixel data from imaging.getPixels() result");
        }

        logger.log(`Got ${rgbaData.length} bytes of pixel data`);
        logger.log(`Actual dimensions: ${actualWidth}x${actualHeight} (expected ${scaledWidth}x${scaledHeight})`);
        logger.log(`Expected bytes (RGBA): ${actualWidth * actualHeight * 4}, got: ${rgbaData.length}`);

        // Check document mode
        const docMode = String(doc.mode);
        logger.log(`Document mode: ${docMode}`);

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
        // L: 0-100, a: -128 to 127, b: -128 to 127
        // NOTE: Lab has NO alpha channel - all pixels are opaque
        const expectedLab = actualWidth * actualHeight * 3;

        if (rgbaData.length !== expectedLab) {
            throw new Error(
                `Unexpected Lab pixel data size: got ${rgbaData.length} bytes, ` +
                `expected ${expectedLab} (Lab 3 channels) for ${actualWidth}x${actualHeight}`
            );
        }

        logger.log(`✓ Got Lab data (3 channels/pixel)`);

        // DIAGNOSTIC: Check Lab uniformity in specific regions
        if (doc.name.includes('luma-stress')) {
            logger.log(`\n=== LAB UNIFORMITY DIAGNOSTIC ===`);
            const scaleFactor = actualHeight / doc.height;
            const startY = Math.floor(1800 * scaleFactor);
            const endY = Math.floor(2100 * scaleFactor);

            logger.log(`Checking y=${startY}-${endY} band (scaled from 1800-2100)`);

            const labColors = new Set();
            const sampleSize = Math.min(100, actualWidth); // Sample up to 100 pixels per row

            for (let y = startY; y < endY && y < actualHeight; y += 10) { // Every 10th row
                for (let x = 0; x < sampleSize; x++) {
                    const idx = (y * actualWidth + x) * 3;
                    const L = rgbaData[idx];
                    const a = rgbaData[idx + 1];
                    const b = rgbaData[idx + 2];
                    labColors.add(`${L},${a},${b}`);
                }
            }

            logger.log(`Unique Lab values in band: ${labColors.size}`);
            if (labColors.size === 1) {
                logger.log(`✓ UNIFORM! All pixels have same Lab value`);
                logger.log(`Lab value: ${Array.from(labColors)[0]}`);
            } else {
                logger.log(`⚠️ NOT UNIFORM! Found ${labColors.size} different Lab values:`);
                const values = Array.from(labColors).slice(0, 10);
                values.forEach(v => logger.log(`  ${v}`));
                if (labColors.size > 10) {
                    logger.log(`  ... and ${labColors.size - 10} more`);
                }
            }
            logger.log(`=== END DIAGNOSTIC ===\n`);
        }

        return {
            pixels: rgbaData,  // Lab values (L, a, b) as bytes
            width: actualWidth,
            height: actualHeight,
            format: 'lab',
            originalWidth: doc.width,
            originalHeight: doc.height,
            scale: Math.min(actualWidth / doc.width, actualHeight / doc.height)
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

        // Debug logging
        if (doc) {
            logger.log("Document validation:");
            logger.log(`  mode: ${doc.mode} (type: ${typeof doc.mode})`);
            logger.log(`  bitsPerChannel: ${doc.bitsPerChannel} (type: ${typeof doc.bitsPerChannel})`);
            logger.log(`  dimensions: ${doc.width}x${doc.height}`);
        }

        // Use pure validation logic (testable without UXP)
        const result = DocumentValidator.validate(doc);

        // Dump full validation result JSON
        logger.log("Validation result JSON:", JSON.stringify(result, null, 2));

        // Debug logging
        logger.log(`  Total errors: ${result.errors.length}`);
        logger.log(`  Total warnings: ${result.warnings.length}`);

        if (result.errors.length > 0) {
            logger.log(`  ❌ Validation failed`);
            result.errors.forEach((err, i) => logger.log(`    Error ${i + 1}: ${err}`));
        } else {
            logger.log(`  ✓ Validation passed`);
        }

        if (result.warnings.length > 0) {
            result.warnings.forEach((warn, i) => logger.log(`    Warning ${i + 1}: ${warn}`));
        }

        return result;
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
            bitDepth: doc.bitsPerChannel
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

        logger.log(`Creating layer "${name}" (${width}x${height})`);
        logger.log(`Document mode: ${doc.mode}`);

        // Create new layer
        const layer = await doc.createLayer({ name });

        // Check if document is in Lab mode (Photoshop returns 'labColorMode')
        const isLabMode = doc.mode === 'labColorMode';

        let imageData;

        if (isLabMode) {
            // Lab mode document: Use Lab pixel data
            logger.log(`Creating Lab layer data...`);

            const labPixels = new Uint8Array((width * height * 3));

            // Three paths for Lab pixel data:

            if (options.labColor) {
                // Path 1: Fill entire layer with single Lab color (solid fill)
                logger.log(`✓ Using provided Lab color directly (NO RGB→Lab conversion)`);
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
                logger.log(`✓ Using pre-encoded Lab pixel data (direct copy, no conversion)`);

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
                logger.log(`✓ Creating Lab+Alpha layer with built-in transparency`);

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

                logger.log(`✓ Created Lab+Alpha ImageData: ${labAlphaPixels.length} bytes (with transparency)`);

                // Write pixels and return early (skip the normal Lab path below)
                await imaging.putPixels({
                    layerID: layer.id,
                    imageData: imageData
                });

                imageData.dispose();
                logger.log(`✓ Created layer "${name}" with Lab+Alpha transparency`);
                return layer;

            } else {
                // Path 3: Legacy RGB→Lab conversion (4 bytes/pixel RGBA → 3 bytes/pixel Lab)
                logger.log(`⚠ Converting RGBA layer data to Lab format (consider passing isLabPixels option)...`);

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

            logger.log(`✓ Created Lab ImageData: ${labPixels.length} bytes`);
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

        logger.log(`Created PhotoshopImageData: ${imageData.width}x${imageData.height}`);

        // Write pixels to layer
        await imaging.putPixels({
            layerID: layer.id,
            imageData: imageData
        });

        // Clean up - release memory
        imageData.dispose();

        logger.log(`✓ Created layer "${name}"`);
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
        const doc = this.getActiveDocument();

        logger.log(`Creating Lab Fill Layer "${name}" with mask...`);
        logger.log(`  Input: ${width}x${height}, mask: ${mask.length} bytes`);
        logger.log(`  Lab color: L=${labColor.L}, a=${labColor.a}, b=${labColor.b}`);

        try {
            localStorage.setItem('reveal_checkpoint', 'createLabSep_before_protective');

            // STEP 1: Create protective layer (prevents background corruption)
            logger.log(`  Step 1: Creating protective layer...`);
            await action.batchPlay([{
                "_obj": "make",
                "_target": [{ "_ref": "layer" }],
                "name": "__PROTECTIVE__"
            }], {});

            localStorage.setItem('reveal_checkpoint', 'createLabSep_after_protective');

            // STEP 2: Create temporary raster layer to hold mask data
            logger.log(`  Step 2: Creating temp layer with mask data...`);
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
            logger.log(`  Step 3: Writing RGBA data (alpha = mask transparency)...`);
            const rgbaData = new Uint8Array(width * height * 4);
            for (let i = 0; i < mask.length; i++) {
                const idx = i * 4;
                rgbaData[idx] = 255;           // R = white
                rgbaData[idx + 1] = 255;       // G = white
                rgbaData[idx + 2] = 255;       // B = white
                rgbaData[idx + 3] = mask[i];   // A = mask value (0=transparent, 255=opaque)
            }

            localStorage.setItem('reveal_checkpoint', 'createLabSep_after_rgba_build');

            const imageData = await imaging.createImageDataFromBuffer(rgbaData, {
                width, height, components: 4, chunky: true,
                colorSpace: "RGB",
                colorProfile: "sRGB IEC61966-2.1"
            });

            localStorage.setItem('reveal_checkpoint', 'createLabSep_after_imageData_create');

            await imaging.putPixels({
                layerID: tempLayer.id,
                imageData: imageData,
                replace: true
            });

            localStorage.setItem('reveal_checkpoint', 'createLabSep_after_putPixels');

            imageData.dispose();
            logger.log(`  ✓ RGBA data written to temp layer`);

            localStorage.setItem('reveal_checkpoint', 'createLabSep_before_transparency_select');

            // STEP 4: Load temp layer's TRANSPARENCY as selection
            logger.log(`  Step 4: Loading transparency as selection...`);
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
            logger.log(`  Step 5: Deleting temp layers...`);
            await action.batchPlay([
                { "_obj": "delete", "_target": [{ "_ref": "layer", "_id": tempLayerID }] },
                { "_obj": "delete", "_target": [{ "_ref": "layer", "_name": "__PROTECTIVE__" }] }
            ], {});

            // STEP 6: Create Fill Layer + mask using revealSelection (CRITICAL: Single batchPlay call)
            logger.log(`  Step 6: Creating Fill Layer with revealSelection mask...`);
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
                    "using": { "_enum": "userMaskEnabled", "_value": "hideSelection" }
                }
            ], { "synchronousExecution": true });

            const createdLayer = doc.activeLayers[0];
            createdLayer.name = name;
            logger.log(`  ✓ Fill Layer + mask created: ID ${createdLayer.id}`);

            // STEP 7: Clear selection
            logger.log(`  Step 7: Clearing selection...`);
            await doc.selection.deselect();

            logger.log(`✓ Lab Fill Layer "${name}" created successfully`);
            return createdLayer;

        } catch (error) {
            logger.error(`Failed to create layer ${name}:`, error);
            logger.error(`Error details:`, error.message, error.stack);

            // CLEANUP: Try to delete any temp layers that might have been created
            logger.log(`  Cleaning up temp layers after error...`);
            try {
                const tempLayers = doc.layers.filter(l =>
                    l.name === '__TEMP_MASK__' || l.name === '__PROTECTIVE__'
                );
                for (const layer of tempLayers) {
                    logger.log(`  Deleting orphaned temp layer: ${layer.name}`);
                    await layer.delete();
                }
            } catch (cleanupErr) {
                logger.warn(`  Could not clean up temp layers: ${cleanupErr.message}`);
            }

            throw new Error(`Failed to create Lab separation layer: ${error.message}`);
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
        logger.log(`Adding layer mask (${width}x${height}) to layer ${layerID}...`);

        try {
            // STEP 1: Use BatchPlay to create empty mask channel
            logger.log(`Creating mask channel via BatchPlay...`);
            const result = await action.batchPlay([
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

            logger.log(`BatchPlay result:`, result);

            // STEP 3: Mask channels are GRAYSCALE (1 component), not Lab
            // Even though document is Lab mode, mask is single-channel 0-255
            logger.log(`Using grayscale mask data (1 component)...`);
            const pixelCount = width * height;

            // maskData is already grayscale Uint8Array (0-255)
            // No conversion needed!

            // STEP 4: Create Grayscale ImageData for the mask
            logger.log(`Creating Grayscale mask ImageData...`);
            const maskImageData = await imaging.createImageDataFromBuffer(maskData, {
                width: width,
                height: height,
                components: 1,  // Grayscale (1 channel)
                chunky: true,
                colorSpace: "Grayscale",
                colorProfile: "Gray Gamma 2.2"  // Hard edges for screen printing
            });

            // STEP 5: Write mask data to the mask channel
            logger.log(`Writing mask pixels with targetMask: true...`);
            await imaging.putPixels({
                layerID: layerID,
                imageData: maskImageData,
                targetMask: true  // CRITICAL: Write to mask channel, not layer pixels
            });

            // Clean up
            maskImageData.dispose();

            logger.log(`✓ Layer mask applied successfully`);
        } catch (error) {
            logger.error(`Failed to add layer mask:`, error);
            logger.error(`Error details:`, error.message, error.stack);
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

        logger.log(`Deleting all layers except background (total layers: ${doc.layers.length})...`);

        // CLEANUP: First, find and delete any orphaned temp layers from failed runs
        const orphanedTempLayers = doc.layers.filter(l =>
            l.name === '__TEMP_MASK__' || l.name === '__PROTECTIVE__'
        );
        if (orphanedTempLayers.length > 0) {
            logger.log(`  Found ${orphanedTempLayers.length} orphaned temp layer(s), deleting...`);
            for (const layer of orphanedTempLayers) {
                try {
                    logger.log(`  Deleting orphaned: "${layer.name}"`);
                    await layer.delete();
                } catch (err) {
                    logger.error(`  Failed to delete orphan: ${err.message}`);
                }
            }
        }

        // Get all remaining non-background layers
        const layersToDelete = doc.layers.filter(layer => !layer.isBackgroundLayer);
        logger.log(`  Found ${layersToDelete.length} non-background layer(s) to delete`);

        if (layersToDelete.length === 0) {
            logger.log(`  No layers to delete`);
            return;
        }

        // Delete in reverse order (top to bottom) to avoid index issues
        for (let i = layersToDelete.length - 1; i >= 0; i--) {
            const layer = layersToDelete[i];
            logger.log(`  Deleting layer ${i + 1}/${layersToDelete.length}: "${layer.name}" (ID: ${layer.id})`);
            try {
                await layer.delete();
            } catch (err) {
                logger.error(`  ✗ Failed to delete layer "${layer.name}": ${err.message}`);
            }
        }

        logger.log(`✓ Deleted ${layersToDelete.length} layers (remaining: ${doc.layers.length})`);
    }
}

// Export for use in plugin
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PhotoshopAPI;
}
