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

        // Extract bit depth from document
        const bitDepthStr = String(doc.bitsPerChannel).toLowerCase();
        const docBitDepth = bitDepthStr.includes('16') || doc.bitsPerChannel === 16 ? 16 : 8;

        logger.log(`Reading document: ${doc.name} (${doc.width}x${doc.height})`);
        logger.log(`Document bit depth: ${doc.bitsPerChannel} (${docBitDepth}-bit)`);

        // Request matching bit depth for accurate Lab value extraction
        const componentSize = docBitDepth;
        logger.log(`Using componentSize: ${componentSize}`);

        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('reveal_checkpoint', 'getDocumentPixels_bitdepth_checked');
        }

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
        // IMPORTANT: imaging.getPixels() requires modal scope even when called from non-modal dialog
        let pixelData;
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('reveal_checkpoint', 'before_imaging_getPixels');
            }

            logger.log('STEP 1: About to call imaging.getPixels() in modal scope...');
            logger.log(`  documentID: ${doc.id}`);
            logger.log(`  targetSize: ${scaledWidth}x${scaledHeight}`);
            logger.log(`  componentSize: ${componentSize}`);
            logger.log(`  targetComponentCount: 3`);
            logger.log(`  colorSpace: Lab`);

            // Wrap in executeAsModal for document access from non-modal dialog
            pixelData = await core.executeAsModal(async () => {
                return await imaging.getPixels({
                    documentID: doc.id,
                    targetSize: {
                        width: scaledWidth,
                        height: scaledHeight
                    },
                    componentSize: componentSize,  // Always 8 for now (UXP limitation)
                    targetComponentCount: 3,       // 3 channels: L, a, b (Lab has NO alpha)
                    colorSpace: "Lab"              // THE CRITICAL PARAMETER: Request raw Lab channels (no conversion)
                });
            }, { commandName: "Get Document Pixels" });

            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('reveal_checkpoint', 'after_imaging_getPixels');
            }

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

        logger.log(`Got ${rgbaData.length} ${componentSize === 16 ? 'elements' : 'bytes'} of pixel data`);
        logger.log(`Data type: ${rgbaData.constructor.name}`);
        logger.log(`Actual dimensions: ${actualWidth}x${actualHeight} (expected ${scaledWidth}x${scaledHeight})`);

        // Verify and convert data type if needed
        if (componentSize === 16 && !(rgbaData instanceof Uint16Array)) {
            logger.log(`⚠️ Expected Uint16Array for 16-bit but got ${rgbaData.constructor.name}`);
            // Convert byte array to Uint16Array view
            // UXP returns bytes in platform-native order (little-endian on most systems)
            if (rgbaData instanceof Uint8Array || rgbaData instanceof Uint8ClampedArray) {
                logger.log(`Converting ${rgbaData.length} bytes to Uint16Array...`);
                // Create Uint16Array view from the underlying buffer
                rgbaData = new Uint16Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength / 2);
                logger.log(`✓ Converted to Uint16Array with ${rgbaData.length} elements`);
            }
        } else if (componentSize === 8 && !(rgbaData instanceof Uint8Array) && !(rgbaData instanceof Uint8ClampedArray)) {
            logger.error(`⚠️ Expected Uint8Array for 8-bit but got ${rgbaData.constructor.name}`);
        }

        const bytesPerElement = componentSize / 8;
        const expectedSize = actualWidth * actualHeight * 3;
        logger.log(`Expected ${expectedSize} elements (Lab ${componentSize}-bit), got: ${rgbaData.length}`);

        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('reveal_checkpoint', 'pixel_data_extracted');
        }

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

        logger.log(`✓ Got Lab data (3 channels/pixel, ${componentSize}-bit per channel)`);

        // DIAGNOSTIC: Sample some Lab values to verify correctness
        logger.log(`\n=== DIAGNOSTIC: LAB VALUE CHECK ===`);
        logger.log(`Sampling first 5 pixels:`);
        for (let i = 0; i < Math.min(5, actualWidth * actualHeight); i++) {
            const idx = i * 3;
            const L = rgbaData[idx];
            const a = rgbaData[idx + 1];
            const b = rgbaData[idx + 2];
            logger.log(`  Pixel ${i}: L=${L} a=${a} b=${b}`);
        }
        if (componentSize === 8) {
            logger.log(`Expected ranges: L[0-255], a[0-255], b[0-255]`);
        } else {
            logger.log(`Expected ranges: L[0-32768], a[0-32768 neutral=16384], b[0-32768 neutral=16384]`);
        }
        logger.log(`=== END DIAGNOSTIC ===\n`);

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

        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('reveal_checkpoint', 'getDocumentPixels_success');
        }

        // ALWAYS return 16-bit Lab data for engine processing
        // Engines only accept 16-bit internally; callers handle conversions
        // Track original bit depth for output decisions (downgrade 8-bit source → 8-bit output)
        let pixels16;
        if (componentSize === 8) {
            logger.log(`Converting 8-bit Lab → 16-bit Lab for engine processing...`);
            pixels16 = this.lab8to16(rgbaData);
            logger.log(`✓ Converted ${rgbaData.length} bytes → ${pixels16.length} 16-bit values`);
        } else {
            pixels16 = rgbaData;  // Already 16-bit
            logger.log(`Using native 16-bit Lab data (${pixels16.length} elements)`);
        }

        logger.log(`Returning 16-bit Lab data (original source: ${componentSize}-bit)`);

        return {
            pixels: pixels16,           // Lab values - ALWAYS 16-bit encoding (0-32768)
            width: actualWidth,
            height: actualHeight,
            format: 'lab',
            bitDepth: componentSize,    // ORIGINAL bit depth (8 or 16) - for output decisions
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

        logger.log(`[PhotoshopAPI] Fetching high-res crop: (${x}, ${y}) ${width}x${height}`);

        // Constrain crop to document bounds
        const cropX = Math.max(0, Math.min(x, doc.width - width));
        const cropY = Math.max(0, Math.min(y, doc.height - height));
        const cropWidth = Math.min(width, doc.width - cropX);
        const cropHeight = Math.min(height, doc.height - cropY);

        logger.log(`[PhotoshopAPI] Constrained crop: (${cropX}, ${cropY}) ${cropWidth}x${cropHeight}`);

        // Get bit depth
        const bitDepthStr = String(doc.bitsPerChannel).toLowerCase();
        const docBitDepth = bitDepthStr.includes('16') || doc.bitsPerChannel === 16 ? 16 : 8;
        const componentSize = docBitDepth;

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

            logger.log('[PhotoshopAPI] High-res crop fetched successfully');
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

        logger.log(`[PhotoshopAPI] Got ${rgbaData.length} ${componentSize === 16 ? 'elements' : 'bytes'} of crop data`);

        // Convert to Uint16Array if needed
        if (componentSize === 16 && !(rgbaData instanceof Uint16Array)) {
            if (rgbaData instanceof Uint8Array || rgbaData instanceof Uint8ClampedArray) {
                rgbaData = new Uint16Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength / 2);
            }
        }

        // Convert 8-bit to 16-bit if needed (always return 16-bit for engine)
        let pixels16;
        if (componentSize === 8) {
            pixels16 = this.lab8to16(rgbaData);
        } else {
            pixels16 = rgbaData;
        }

        logger.log(`[PhotoshopAPI] ✓ High-res crop ready: ${cropWidth}x${cropHeight} (16-bit LAB)`);

        return {
            pixels: pixels16,
            width: cropWidth,
            height: cropHeight,
            format: 'lab',
            bitDepth: componentSize,
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

        localStorage.setItem('reveal_checkpoint', 'createLabSep_after_destructure');

        const doc = this.getActiveDocument();

        localStorage.setItem('reveal_checkpoint', 'createLabSep_got_doc');

        logger.log(`Creating Lab Fill Layer "${name}" with mask...`);
        logger.log(`  Input: ${width}x${height}, mask: ${mask.length} bytes`);

        // DIAGNOSTIC: Verify mask data integrity
        logger.log(`\n=== MASK DATA VERIFICATION ===`);
        logger.log(`  Mask is Uint8Array: ${mask instanceof Uint8Array}`);
        logger.log(`  Mask constructor: ${mask.constructor.name}`);
        logger.log(`  Expected length: ${width * height}`);
        logger.log(`  Actual length: ${mask.length}`);
        logger.log(`  Length match: ${mask.length === width * height ? 'YES' : 'NO'}`);

        // Count values
        let count255 = 0;
        let count0 = 0;
        let countOther = 0;
        for (let i = 0; i < mask.length; i++) {
            if (mask[i] === 255) count255++;
            else if (mask[i] === 0) count0++;
            else countOther++;
        }
        logger.log(`  Pixels with value 255 (opaque): ${count255} (${(count255 / mask.length * 100).toFixed(1)}%)`);
        logger.log(`  Pixels with value 0 (transparent): ${count0} (${(count0 / mask.length * 100).toFixed(1)}%)`);
        logger.log(`  Pixels with other values: ${countOther}`);

        // Sample first 20 pixels
        const sampleSize = Math.min(20, mask.length);
        const sample = [];
        for (let i = 0; i < sampleSize; i++) {
            sample.push(mask[i]);
        }
        logger.log(`  First ${sampleSize} mask values: ${sample.join(', ')}`);
        logger.log(`=== END MASK VERIFICATION ===\n`);

        localStorage.setItem('reveal_checkpoint', 'createLabSep_logged_basic_info');

        logger.log(`  Lab color: L=${labColor.L}, a=${labColor.a}, b=${labColor.b}`);

        localStorage.setItem('reveal_checkpoint', 'createLabSep_logged_lab_color');

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
            logger.log(`  Document bit depth: ${doc.bitsPerChannel}`);

            // Count mask statistics
            let opaqueCount = 0;
            let transparentCount = 0;
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] === 255) opaqueCount++;
                else if (mask[i] === 0) transparentCount++;
            }
            logger.log(`  Mask stats: ${opaqueCount} opaque (255), ${transparentCount} transparent (0), ${mask.length - opaqueCount - transparentCount} partial`);

            // CRITICAL: Temp layer is RGB and only used for transparency selection
            // ALWAYS use 8-bit RGB regardless of document bit depth
            // The alpha channel carries the mask data - bit depth doesn't matter for this purpose
            logger.log(`  Creating 8-bit RGBA data (temp layer for selection)...`);

            const rgbaData = new Uint8Array(width * height * 4);
            for (let i = 0; i < mask.length; i++) {
                const idx = i * 4;
                rgbaData[idx] = 255;           // R = white
                rgbaData[idx + 1] = 255;       // G = white
                rgbaData[idx + 2] = 255;       // B = white
                rgbaData[idx + 3] = mask[i];   // A = mask value (0=transparent, 255=opaque)
            }

            logger.log(`  Created Uint8Array: ${rgbaData.length} bytes`);

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

            localStorage.setItem('reveal_checkpoint', 'createLabSep_after_imageData_create');
            localStorage.setItem('reveal_checkpoint', 'createLabSep_before_putPixels');

            await imaging.putPixels({
                layerID: tempLayer.id,
                imageData: imageData,
                replace: true
            });

            localStorage.setItem('reveal_checkpoint', 'createLabSep_after_putPixels');

            imageData.dispose();
            logger.log(`  ✓ RGBA data written to temp layer`);

            // DIAGNOSTIC: Check if temp layer has transparency
            logger.log(`  DIAGNOSTIC: Checking temp layer properties...`);
            logger.log(`    Temp layer ID: ${tempLayer.id}`);
            logger.log(`    Temp layer name: ${tempLayer.name}`);
            logger.log(`    Temp layer opacity: ${tempLayer.opacity}`);
            logger.log(`    Temp layer blendMode: ${tempLayer.blendMode}`);
            logger.log(`    Temp layer kind: ${tempLayer.kind}`);

            // Try to get layer bounds (indicates non-transparent content)
            try {
                logger.log(`    Temp layer bounds: ${JSON.stringify(tempLayer.bounds)}`);
            } catch (e) {
                logger.log(`    Could not read layer bounds: ${e.message}`);
            }

            localStorage.setItem('reveal_checkpoint', 'createLabSep_before_transparency_select');

            // STEP 4: Load temp layer's TRANSPARENCY as selection
            logger.log(`  Step 4: Loading transparency as selection...`);
            const selectResult = await action.batchPlay([{
                "_obj": "set",
                "_target": [{ "_ref": "channel", "_property": "selection" }],
                "to": {
                    "_ref": "channel",
                    "_enum": "channel",
                    "_value": "transparencyEnum"
                }
            }], {});
            logger.log(`  Selection command result: ${JSON.stringify(selectResult)}`);

            // DIAGNOSTIC: Check selection bounds
            try {
                const bounds = doc.selection.bounds;
                logger.log(`  Selection bounds: ${JSON.stringify(bounds)}`);
                const selWidth = bounds.right - bounds.left;
                const selHeight = bounds.bottom - bounds.top;
                logger.log(`  Selection size: ${selWidth}x${selHeight}`);
            } catch (e) {
                logger.log(`  No active selection or error reading bounds: ${e.message}`);
            }

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
                    "using": { "_enum": "userMaskEnabled", "_value": "revealSelection" }
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

        logger.log(`Creating Lab Fill Layer "${name}" with mask (16-bit transparency method)...`);
        logger.log(`  Input: ${width}x${height}, mask: ${mask.length} bytes`);
        logger.log(`  Lab color: L=${labColor.L}, a=${labColor.a}, b=${labColor.b}`);

        localStorage.setItem('reveal_checkpoint', 'createLabSep16_logged_info');

        const doc = this.getActiveDocument();
        const bitDepthStr = String(doc.bitsPerChannel).toLowerCase();
        const is16bit = bitDepthStr.includes('16') || doc.bitsPerChannel === 16;
        const componentSize = is16bit ? 16 : 8;
        const maxValue = is16bit ? 32768 : 255;

        try {
            // STEP 1: Create temp layer for transparency-based selection
            logger.log(`  Step 1: Creating temp layer with mask as alpha channel...`);
            localStorage.setItem('reveal_checkpoint', 'createLabSep16_before_temp_layer');

            await action.batchPlay([{
                "_obj": "make",
                "_target": [{ "_ref": "layer" }],
                "name": `__TEMP_${name}__`
            }], {});

            const tempLayer = doc.activeLayers[0];
            logger.log(`  ✓ Temp layer created: ID ${tempLayer.id}`);

            // STEP 2: Write RGBA data with mask as alpha channel
            logger.log(`  Step 2: Writing RGBA with mask as alpha (${componentSize}-bit)...`);
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
            logger.log(`  ✓ RGBA data written with mask as alpha`);

            // STEP 3: Load transparency as selection
            logger.log(`  Step 3: Loading transparency as selection...`);
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

            logger.log(`  ✓ Selection created from transparency`);

            // STEP 4: Create fill layer AND mask in SINGLE batchPlay (critical for 16-bit!)
            logger.log(`  Step 4: Creating fill layer with mask (combined command)...`);
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
            logger.log(`  ✓ Fill layer with mask created: ID ${createdLayer.id}`);

            // STEP 5: Delete temp layer
            logger.log(`  Step 5: Deleting temp layer...`);
            localStorage.setItem('reveal_checkpoint', 'createLabSep16_before_delete_temp');

            await tempLayer.delete();
            logger.log(`  ✓ Temp layer deleted`);

            // STEP 6: Clear selection
            logger.log(`  Step 6: Clearing selection...`);
            await action.batchPlay([{
                "_obj": "set",
                "_target": [{ "_ref": "channel", "_property": "selection" }],
                "to": { "_enum": "ordinal", "_value": "none" }
            }], {});

            localStorage.setItem('reveal_checkpoint', 'createLabSep16_complete');

            logger.log(`✓ Lab Fill Layer "${name}" created with mask (16-bit transparency method)`);
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

        logger.log(`Adding layer mask (16-bit method) (${width}x${height}) to layer ${layerID}...`);
        logger.log(`  Mimicking 8-bit structure with targetEnum...`);

        try {
            // NOTE: Layer should already be active from createLabSeparationLayer16Bit
            // Mimic 8-bit code structure: create mask on targetEnum (active layer)

            // STEP 1: Create mask channel on active layer (targetEnum pattern from 8-bit code)
            logger.log(`  Step 1: Creating mask channel on active layer...`);

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

            logger.log(`  ✓ Mask channel created`);

            // STEP 2: Write mask data using batchPlay "put" with rawData
            // Masks are always 8-bit, even in 16-bit documents
            logger.log(`  Step 2: Writing 8-bit mask data via batchPlay "put"...`);

            localStorage.setItem('reveal_checkpoint', 'addMask16_before_put');

            // Match the example code exactly - no synchronousExecution parameter
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

            logger.log(`✓ Layer mask applied successfully (16-bit via batchPlay "put")`);
        } catch (error) {
            logger.error(`Failed to add 16-bit layer mask:`, error);
            logger.error(`Error details:`, error.message, error.stack);
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
