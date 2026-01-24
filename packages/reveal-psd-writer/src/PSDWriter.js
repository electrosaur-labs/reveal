/**
 * PSDWriter - Minimal PSD file writer for 8-bit Lab documents with fill+mask layers
 *
 * Implements Adobe PSD specification for screen printing color separations.
 * Only supports: 8-bit Lab color mode, solid fill layers with masks.
 *
 * References:
 * - https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/
 * - https://www.fileformat.info/format/psd/egff.htm
 */

const BinaryWriter = require('./BinaryWriter');
const DescriptorWriter = require('./DescriptorWriter');

class PSDWriter {
    constructor(options = {}) {
        // Validate required options
        if (!options.width || !options.height) {
            throw new Error('width and height are required');
        }

        this.width = options.width;
        this.height = options.height;
        this.colorMode = options.colorMode || 'lab';
        this.bitsPerChannel = options.bitsPerChannel || 8;
        this.layers = [];
        this.nextLayerID = 1;  // Counter for unique layer IDs
        this.thumbnail = null;  // Optional JPEG thumbnail for Resource 1036
        this.compression = options.compression !== undefined ? options.compression : 'rle';  // 'none' or 'rle'
        this.flatMode = options.flat || false;  // Flat mode: 3 channels, minimal layers, better QuickLook support
        this.compositePixels = null;  // For flat mode: store composite pixels directly

        // Validate constraints
        if (this.colorMode !== 'lab') {
            throw new Error('Only Lab color mode is currently supported');
        }
        if (this.bitsPerChannel !== 8 && this.bitsPerChannel !== 16) {
            throw new Error('Only 8-bit and 16-bit per channel are supported');
        }
    }

    /**
     * PackBits RLE compression (PSD compression type 1)
     *
     * Encodes a single row of data using the PackBits algorithm.
     * Returns a Buffer with the compressed row data.
     *
     * PackBits encoding:
     * - n = -1 to -127: copy the next byte (-n + 1) times (run of identical bytes)
     * - n = 0 to 127: copy the next (n + 1) bytes verbatim (literal run)
     * - n = -128: NOP (skip)
     *
     * @param {Buffer|Uint8Array} row - Raw row data
     * @returns {Buffer} Compressed row data
     */
    _packBitsEncode(row) {
        const output = [];
        let pos = 0;
        const len = row.length;

        while (pos < len) {
            // Look for runs of identical bytes
            let runStart = pos;
            let runByte = row[pos];
            let runLen = 1;

            while (pos + runLen < len && row[pos + runLen] === runByte && runLen < 128) {
                runLen++;
            }

            if (runLen >= 3) {
                // Emit a run (replicate)
                output.push(-(runLen - 1));  // n = -(count - 1), so -n + 1 = count
                output.push(runByte);
                pos += runLen;
            } else {
                // Look for literal (non-run) sequence
                let literalStart = pos;
                let literalLen = 0;

                while (pos + literalLen < len && literalLen < 128) {
                    // Check if a run of 3+ starts here
                    let byte = row[pos + literalLen];
                    let ahead = 1;
                    while (pos + literalLen + ahead < len &&
                           row[pos + literalLen + ahead] === byte &&
                           ahead < 3) {
                        ahead++;
                    }

                    if (ahead >= 3) {
                        // A run starts here - stop the literal
                        break;
                    }

                    literalLen++;
                }

                if (literalLen === 0) literalLen = 1;

                // Emit a literal
                output.push(literalLen - 1);  // n = count - 1, so n + 1 = count
                for (let i = 0; i < literalLen; i++) {
                    output.push(row[pos + i]);
                }
                pos += literalLen;
            }
        }

        return Buffer.from(output);
    }

    /**
     * Compress a channel using RLE (PackBits) compression
     * Returns the compressed data with row byte counts prefix
     *
     * @param {Buffer|Uint8Array} channelData - Planar channel data (width × height bytes for 8-bit, or width × height × 2 for 16-bit)
     * @param {number} bytesPerPixel - 1 for 8-bit, 2 for 16-bit
     * @returns {Object} { rowByteCounts: Uint16Array, compressedData: Buffer, totalSize: number }
     */
    _compressChannelRLE(channelData, bytesPerPixel) {
        const rowByteCounts = new Uint16Array(this.height);
        const compressedRows = [];

        const rowBytes = this.width * bytesPerPixel;

        for (let y = 0; y < this.height; y++) {
            const rowStart = y * rowBytes;
            const rowEnd = rowStart + rowBytes;
            const row = channelData.slice(rowStart, rowEnd);

            const compressedRow = this._packBitsEncode(row);
            rowByteCounts[y] = compressedRow.length;
            compressedRows.push(compressedRow);
        }

        const compressedData = Buffer.concat(compressedRows);
        // Total size: 2 (compression type) + height*2 (row counts) + compressed data
        const totalSize = 2 + (this.height * 2) + compressedData.length;

        return {
            rowByteCounts,
            compressedData,
            totalSize
        };
    }

    /**
     * Pre-compute compressed channel data for all layers
     * This is needed because layer records must contain channel sizes before the data is written
     */
    _prepareLayerChannelData() {
        const pixelCount = this.width * this.height;
        const bytesPerPixel = this.bitsPerChannel === 16 ? 2 : 1;
        const useRLE = this.compression === 'rle';

        for (const layer of this.layers) {
            const isPixelLayer = layer.type === 'pixel';
            layer._channelData = [];

            if (this.bitsPerChannel === 16) {
                if (isPixelLayer) {
                    // Build planar channel buffers for pixel layer
                    const transparency = Buffer.alloc(pixelCount * 2);
                    const L_channel = Buffer.alloc(pixelCount * 2);
                    const a_channel = Buffer.alloc(pixelCount * 2);
                    const b_channel = Buffer.alloc(pixelCount * 2);

                    if (layer.pixels16bit) {
                        // Native 16-bit format: pixels are already in 16-bit big-endian (L, a, b interleaved)
                        for (let i = 0; i < pixelCount; i++) {
                            transparency.writeUInt16BE(65535, i * 2);
                            // Copy 16-bit values directly (6 bytes per pixel: L(2) + a(2) + b(2))
                            L_channel[i * 2] = layer.pixels[i * 6];
                            L_channel[i * 2 + 1] = layer.pixels[i * 6 + 1];
                            a_channel[i * 2] = layer.pixels[i * 6 + 2];
                            a_channel[i * 2 + 1] = layer.pixels[i * 6 + 3];
                            b_channel[i * 2] = layer.pixels[i * 6 + 4];
                            b_channel[i * 2 + 1] = layer.pixels[i * 6 + 5];
                        }
                    } else {
                        // 8-bit encoding: scale to 16-bit
                        for (let i = 0; i < pixelCount; i++) {
                            transparency.writeUInt16BE(65535, i * 2);
                            L_channel.writeUInt16BE(Math.round((layer.pixels[i * 3] / 255) * 65535), i * 2);
                            a_channel.writeUInt16BE(Math.round((layer.pixels[i * 3 + 1] / 255) * 65535), i * 2);
                            b_channel.writeUInt16BE(Math.round((layer.pixels[i * 3 + 2] / 255) * 65535), i * 2);
                        }
                    }

                    if (useRLE) {
                        layer._channelData.push(this._compressChannelRLE(transparency, 2));
                        layer._channelData.push(this._compressChannelRLE(L_channel, 2));
                        layer._channelData.push(this._compressChannelRLE(a_channel, 2));
                        layer._channelData.push(this._compressChannelRLE(b_channel, 2));
                    } else {
                        // Uncompressed: size = 2 (compression) + data length
                        layer._channelData.push({ totalSize: 2 + transparency.length, raw: transparency });
                        layer._channelData.push({ totalSize: 2 + L_channel.length, raw: L_channel });
                        layer._channelData.push({ totalSize: 2 + a_channel.length, raw: a_channel });
                        layer._channelData.push({ totalSize: 2 + b_channel.length, raw: b_channel });
                    }
                } else {
                    // 16-bit fill layer: transparency/L/a/b have no pixel data (size 2 each)
                    layer._channelData.push({ totalSize: 2, empty: true });
                    layer._channelData.push({ totalSize: 2, empty: true });
                    layer._channelData.push({ totalSize: 2, empty: true });
                    layer._channelData.push({ totalSize: 2, empty: true });

                    // Mask channel
                    if (useRLE) {
                        layer._channelData.push(this._compressChannelRLE(layer.mask, 2));
                    } else {
                        layer._channelData.push({ totalSize: 2 + layer.mask.length, raw: layer.mask });
                    }
                }
            } else {
                // 8-bit mode
                if (isPixelLayer) {
                    // 8-bit pixel layer: extract planar channels from interleaved Lab pixels
                    const transparency = Buffer.alloc(pixelCount, 255);
                    const L_channel = Buffer.alloc(pixelCount);
                    const a_channel = Buffer.alloc(pixelCount);
                    const b_channel = Buffer.alloc(pixelCount);

                    for (let i = 0; i < pixelCount; i++) {
                        L_channel[i] = layer.pixels[i * 3];
                        a_channel[i] = layer.pixels[i * 3 + 1];
                        b_channel[i] = layer.pixels[i * 3 + 2];
                    }

                    if (useRLE) {
                        layer._channelData.push(this._compressChannelRLE(transparency, 1));
                        layer._channelData.push(this._compressChannelRLE(L_channel, 1));
                        layer._channelData.push(this._compressChannelRLE(a_channel, 1));
                        layer._channelData.push(this._compressChannelRLE(b_channel, 1));
                    } else {
                        layer._channelData.push({ totalSize: 2 + transparency.length, raw: transparency });
                        layer._channelData.push({ totalSize: 2 + L_channel.length, raw: L_channel });
                        layer._channelData.push({ totalSize: 2 + a_channel.length, raw: a_channel });
                        layer._channelData.push({ totalSize: 2 + b_channel.length, raw: b_channel });
                    }
                } else {
                    // 8-bit fill layer: solid color channels + mask
                    const transparency = Buffer.alloc(pixelCount, 255);
                    const L_channel = Buffer.alloc(pixelCount, Math.round((layer.color.L / 100) * 255));
                    const a_channel = Buffer.alloc(pixelCount, Math.round(layer.color.a + 128));
                    const b_channel = Buffer.alloc(pixelCount, Math.round(layer.color.b + 128));

                    if (useRLE) {
                        layer._channelData.push(this._compressChannelRLE(transparency, 1));
                        layer._channelData.push(this._compressChannelRLE(L_channel, 1));
                        layer._channelData.push(this._compressChannelRLE(a_channel, 1));
                        layer._channelData.push(this._compressChannelRLE(b_channel, 1));
                        layer._channelData.push(this._compressChannelRLE(layer.mask, 1));
                    } else {
                        layer._channelData.push({ totalSize: 2 + transparency.length, raw: transparency });
                        layer._channelData.push({ totalSize: 2 + L_channel.length, raw: L_channel });
                        layer._channelData.push({ totalSize: 2 + a_channel.length, raw: a_channel });
                        layer._channelData.push({ totalSize: 2 + b_channel.length, raw: b_channel });
                        layer._channelData.push({ totalSize: 2 + layer.mask.length, raw: layer.mask });
                    }
                }
            }
        }
    }

    /**
     * Add a solid color fill layer with mask
     *
     * @param {Object} options - Layer options
     * @param {string} options.name - Layer name
     * @param {Object} options.color - Lab color { L, a, b }
     * @param {Uint8Array} options.mask - Layer mask (8-bit: width×height bytes, 16-bit: width×height×2 bytes)
     */
    addFillLayer(options) {
        if (!options.name) {
            throw new Error('Layer name is required');
        }
        if (!options.color || typeof options.color.L === 'undefined') {
            throw new Error('Lab color is required');
        }
        // Validate mask size: 8-bit (1 byte/pixel) or 16-bit (2 bytes/pixel)
        const pixelCount = this.width * this.height;
        const expectedSize8 = pixelCount;
        const expectedSize16 = pixelCount * 2;

        if (!options.mask) {
            throw new Error('Mask is required');
        }
        if (options.mask.length !== expectedSize8 && options.mask.length !== expectedSize16) {
            throw new Error(`Mask must be ${expectedSize8} bytes (8-bit) or ${expectedSize16} bytes (16-bit)`);
        }

        // Convert 8-bit mask to 16-bit if needed
        let mask = options.mask;
        if (this.bitsPerChannel === 16 && mask.length === expectedSize8) {
            // Convert 8-bit mask (1 byte/pixel) to 16-bit (2 bytes/pixel)
            // Standard conversion: value8 * 257 gives value16
            const mask16 = new Uint8Array(expectedSize16);

            for (let i = 0; i < pixelCount; i++) {
                const value8 = mask[i];
                const value16 = value8 * 257;

                mask16[i * 2] = (value16 >> 8) & 0xFF;      // High byte
                mask16[i * 2 + 1] = value16 & 0xFF;          // Low byte
            }
            mask = mask16;
        }

        this.layers.push({
            id: this.nextLayerID++,
            name: options.name,
            type: 'fill',
            color: options.color,
            mask: mask
        });
    }

    /**
     * Add a pixel layer with actual Lab image data
     *
     * @param {Object} options - Layer options
     * @param {string} options.name - Layer name
     * @param {Uint8Array} options.pixels - Lab pixel data (3 bytes per pixel: L, a, b in byte encoding)
     * @param {boolean} [options.visible=true] - Layer visibility
     */
    addPixelLayer(options) {
        if (!options.name) {
            throw new Error('Layer name is required');
        }
        if (!options.pixels) {
            throw new Error('Pixel data is required');
        }

        const pixelCount = this.width * this.height;
        const expectedSize8 = pixelCount * 3;  // L, a, b (8-bit encoding)
        const expectedSize16 = pixelCount * 6; // L, a, b (native 16-bit: 2 bytes each)

        // Detect pixel format: 8-bit encoding (3 bytes) or native 16-bit (6 bytes)
        let pixels16bit = null;
        if (options.pixels.length === expectedSize16 && this.bitsPerChannel === 16) {
            // Native 16-bit format: store directly
            pixels16bit = Buffer.from(options.pixels);
        } else if (options.pixels.length === expectedSize8) {
            // 8-bit encoding: will be scaled to 16-bit during write if needed
        } else {
            throw new Error(
                `Pixel data must be ${expectedSize8} bytes (${this.width}×${this.height}×3 8-bit) ` +
                `or ${expectedSize16} bytes (${this.width}×${this.height}×6 native 16-bit), ` +
                `got ${options.pixels.length} bytes`
            );
        }

        this.layers.push({
            id: this.nextLayerID++,
            name: options.name,
            type: 'pixel',
            pixels: pixels16bit || Buffer.from(options.pixels),
            pixels16bit: pixels16bit !== null,  // Flag indicating native 16-bit format
            visible: options.visible !== undefined ? options.visible : true
        });
    }

    /**
     * Set thumbnail for Resource 1036 (Adobe dialogs) and Finder preview
     *
     * @param {Object} options - Thumbnail options
     * @param {Buffer} options.jpegData - JPEG-encoded thumbnail image (RGB)
     * @param {number} options.width - Thumbnail width in pixels
     * @param {number} options.height - Thumbnail height in pixels
     */
    setThumbnail(options) {
        if (!options.jpegData || !options.width || !options.height) {
            throw new Error('jpegData, width, and height are required');
        }
        this.thumbnail = {
            jpegData: Buffer.from(options.jpegData),
            width: options.width,
            height: options.height
        };
    }

    /**
     * Set composite pixels for flat mode (no layers, just merged image)
     * This creates PSDs that work well with QuickLook.
     *
     * @param {Uint8Array} pixels - Lab pixel data (3 bytes per pixel: L, a, b in byte encoding)
     */
    setComposite(pixels) {
        const expectedSize = this.width * this.height * 3;
        if (pixels.length !== expectedSize) {
            throw new Error(`Composite must be ${expectedSize} bytes (${this.width}×${this.height}×3), got ${pixels.length}`);
        }
        this.compositePixels = Buffer.from(pixels);
        this.flatMode = true;
    }

    /**
     * Write complete PSD file
     *
     * @returns {Buffer} Complete PSD file data
     */
    write() {
        const writer = new BinaryWriter();

        // PSD file has 5 sections:
        this._writeHeader(writer);
        this._writeColorModeData(writer);
        this._writeImageResources(writer);
        this._writeLayerAndMaskInfo(writer);
        this._writeImageData(writer);

        return writer.toBuffer();
    }

    /**
     * Section 1: File Header (26 bytes)
     *
     * Signature: '8BPS' (4 bytes)
     * Version: 1 (2 bytes)
     * Reserved: zeros (6 bytes)
     * Channels: 3 for Lab (2 bytes)
     * Height: (4 bytes)
     * Width: (4 bytes)
     * Depth: 8 (2 bytes)
     * Mode: 9 for Lab (2 bytes)
     */
    _writeHeader(writer) {
        writer.writeString('8BPS');  // Signature
        writer.writeUint16(1);        // Version (always 1 for PSD)

        // Reserved: 6 bytes of zeros
        for (let i = 0; i < 6; i++) {
            writer.writeUint8(0);
        }

        // Channels: 3 for Lab (L,a,b) + alpha channels for layer masks (up to 4)
        // Photoshop requires extra channels in header and Section 5 for layered documents
        const channelCount = this.layers.length > 0 ? 3 + Math.min(this.layers.length, 4) : 3;
        writer.writeUint16(channelCount);
        writer.writeUint32(this.height);
        writer.writeUint32(this.width);
        writer.writeUint16(this.bitsPerChannel);  // Depth
        writer.writeUint16(9);        // Mode: 9 = Lab
    }

    /**
     * Section 2: Color Mode Data
     *
     * For Lab mode, this section is empty (just length field = 0)
     */
    _writeColorModeData(writer) {
        writer.writeUint32(0);  // Length = 0 for Lab mode
    }

    /**
     * Section 3: Image Resources
     *
     * Write resolution info (required by Photoshop)
     */
    _writeImageResources(writer) {
        const startPos = writer.tell();
        const updateLength = writer.reserveUint32();

        // Resource 1005: ResolutionInfo
        writer.writeString('8BIM');     // Signature
        writer.writeUint16(1005);       // ID: ResolutionInfo
        writer.writeUint8(0);           // Name length (0 = no name)
        writer.writeUint8(0);           // Padding

        // Data length: 16 bytes
        writer.writeUint32(16);

        // Resolution: 300 DPI (fixed-point 16.16 format)
        // Horizontal resolution
        writer.writeUint32(0x012c0000); // 300.0 DPI (300 << 16)
        writer.writeUint16(1);          // Unit: 1 = pixels/inch
        writer.writeUint16(1);          // Width unit: 1 = inches

        // Vertical resolution
        writer.writeUint32(0x012c0000); // 300.0 DPI (300 << 16)
        writer.writeUint16(1);          // Unit: 1 = pixels/inch
        writer.writeUint16(1);          // Height unit: 1 = inches

        // Resource 1077: DisplayInfo (copy exact format from reference 16-bit file)
        writer.writeString('8BIM');     // Signature
        writer.writeUint16(1077);       // ID: DisplayInfo
        writer.writeUint8(0);           // Name length
        writer.writeUint8(0);           // Padding
        writer.writeUint32(56);         // Data length

        // Write exact DisplayInfo structure from reference (56 bytes)
        const displayInfo = Buffer.from(
            '000000010000ffff0000000000000064' +
            '010000ffff0000000000000032' +
            '010000ffff0000000000000032' +
            '010000ffff000000000000003201',
            'hex'
        );
        writer.writeBytes(displayInfo);

        // Resource 1036: Thumbnail (JPEG) - for Adobe dialogs and Finder preview
        if (this.thumbnail) {
            this._writeThumbnailResource(writer);
        }

        // Update section length
        const length = writer.tell() - startPos - 4;
        updateLength(length);
    }

    /**
     * Write Resource 1036: Thumbnail Resource
     *
     * Format: 28-byte header + JPEG data
     * This provides thumbnails for Adobe "Open" dialogs and macOS Finder
     */
    _writeThumbnailResource(writer) {
        const { jpegData, width, height } = this.thumbnail;

        // Build 28-byte thumbnail header
        const header = Buffer.alloc(28);
        const headerView = new DataView(header.buffer);

        // Format: 1 = kJpegRGB
        headerView.setUint32(0, 1, false);
        // Width & Height
        headerView.setUint32(4, width, false);
        headerView.setUint32(8, height, false);
        // WidthBytes: Padded row stride (width * 3 bytes RGB, padded to 4-byte boundary)
        const widthBytes = Math.floor((width * 24 + 31) / 32) * 4;
        headerView.setUint32(12, widthBytes, false);
        // Total Size (uncompressed RGB data size)
        headerView.setUint32(16, widthBytes * height, false);
        // Compressed Size (JPEG size)
        headerView.setUint32(20, jpegData.length, false);
        // BPP (24 = RGB) and Planes (1)
        headerView.setUint16(24, 24, false);
        headerView.setUint16(26, 1, false);

        // Total resource data = header + JPEG
        const resourceData = Buffer.concat([header, jpegData]);

        // Write 8BIM resource block
        writer.writeString('8BIM');     // Signature
        writer.writeUint16(1036);       // ID: Thumbnail Resource
        writer.writeUint8(0);           // Name length (0 = no name)
        writer.writeUint8(0);           // Padding

        // Data length
        writer.writeUint32(resourceData.length);

        // Resource data (header + JPEG)
        writer.writeBytes(resourceData);

        // Pad to even length if necessary
        if (resourceData.length % 2 !== 0) {
            writer.writeUint8(0);
        }
    }

    /**
     * Section 4: Layer and Mask Information
     *
     * This is the most complex section, containing all layer data
     */
    _writeLayerAndMaskInfo(writer) {
        const startPos = writer.tell();
        const updateSectionLength = writer.reserveUint32();

        if (this.flatMode) {
            // Flat mode: minimal layer/mask section for QuickLook compatibility
            // Just write empty layer info and global mask
            writer.writeUint32(0);  // Layer info length = 0
            writer.writeUint32(0);  // Global layer mask length = 0
        } else if (this.bitsPerChannel === 16) {
            // 16-bit format: empty layer info, use Lr16 block
            writer.writeUint32(0);  // Layer info length = 0
            writer.writeUint32(0);  // Global mask length = 0

            // Mt16 block (empty marker)
            writer.writeString('8BIM');
            writer.writeString('Mt16');
            writer.writeUint32(0);  // Length = 0

            // Lr16 block with actual layer data
            this._writeLr16Block(writer);

            // Global layer mask info (LMsk block) - required for 16-bit files
            this._writeGlobalLayerMask(writer);
        } else {
            // 8-bit format: traditional layer info section
            this._writeLayerInfo(writer);
            writer.writeUint32(0);  // Global mask length = 0
        }

        // Update section length (total bytes after the length field)
        const sectionLength = writer.tell() - startPos - 4;
        updateSectionLength(sectionLength);
    }

    /**
     * Write Lr16 block (16-bit layer data)
     */
    _writeLr16Block(writer) {
        writer.writeString('8BIM');
        writer.writeString('Lr16');

        // Pre-compute all channel data (needed for sizes in layer records)
        this._prepareLayerChannelData();

        // Write Lr16 data to separate buffer to calculate length
        const lr16Writer = new BinaryWriter();

        // Layer count (negative indicates transparency data)
        lr16Writer.writeInt16(-this.layers.length);

        // Write each layer record
        for (const layer of this.layers) {
            this._writeLayerRecord(lr16Writer, layer);
        }

        // Write channel image data for each layer
        for (const layer of this.layers) {
            this._writeLayerChannelData(lr16Writer, layer);
        }

        const lr16Data = lr16Writer.toBuffer();

        // Write Lr16 length and data
        writer.writeUint32(lr16Data.length);
        writer.writeBytes(lr16Data);

        // Add padding for 4-byte alignment (PSD spec requirement for tagged blocks)
        const padding = (4 - (lr16Data.length % 4)) % 4;
        for (let i = 0; i < padding; i++) {
            writer.writeUint8(0);
        }
    }

    /**
     * Write global layer mask info block (LMsk) for 16-bit files
     * This block is expected by Photoshop and prevents "corrupt layers" warning
     */
    _writeGlobalLayerMask(writer) {
        // LMsk tagged block
        writer.writeString('8BIM');
        writer.writeString('LMsk');
        writer.writeUint32(14);  // Length: 14 bytes

        // Global layer mask data (14 bytes) - values from reference file
        writer.writeUint16(0);     // Overlay color space (0 = no color selected)
        writer.writeUint16(0xFFFF);  // Color component 1 (red)
        writer.writeUint16(0);     // Color component 2 (green)
        writer.writeUint16(0);     // Color component 3 (blue)
        writer.writeUint16(0);     // Color component 4 (alpha)
        writer.writeUint16(50);    // Opacity (50)
        writer.writeUint8(128);    // Kind (128 = 0x80)
        writer.writeUint8(0);      // Reserved

        // Padding to 4-byte boundary (block is 26 bytes, needs 2 bytes padding)
        writer.writeUint8(0);
        writer.writeUint8(0);
    }

    /**
     * Write layer info subsection
     */
    _writeLayerInfo(writer) {
        const startPos = writer.tell();
        const updateLayerInfoLength = writer.reserveUint32();

        // Pre-compute all channel data (needed for sizes in layer records)
        this._prepareLayerChannelData();

        // Layer count (negative indicates transparency data)
        writer.writeInt16(-this.layers.length);

        // Write each layer record
        for (const layer of this.layers) {
            this._writeLayerRecord(writer, layer);
        }

        // Write channel image data for each layer
        for (const layer of this.layers) {
            this._writeLayerChannelData(writer, layer);
        }

        // Update layer info length (total bytes after the length field)
        const layerInfoLength = writer.tell() - startPos - 4;
        updateLayerInfoLength(layerInfoLength);
    }

    /**
     * Write a single layer record
     */
    _writeLayerRecord(writer, layer) {
        const isPixelLayer = layer.type === 'pixel';

        // Bounding rectangle
        if (this.bitsPerChannel === 16 && !isPixelLayer) {
            // 16-bit fill layers: zero-size bounds
            writer.writeInt32(0);  // Top
            writer.writeInt32(0);  // Left
            writer.writeInt32(0);  // Bottom
            writer.writeInt32(0);  // Right
        } else {
            // Pixel layers and 8-bit layers: full canvas bounds
            writer.writeInt32(0);              // Top
            writer.writeInt32(0);              // Left
            writer.writeInt32(this.height);   // Bottom
            writer.writeInt32(this.width);    // Right
        }

        // Number of channels
        // Pixel layers: 1 transparency + 3 Lab channels (no mask)
        // Fill layers: 1 transparency + 3 Lab channels + 1 user mask
        const channelCount = isPixelLayer ? 4 : 5;
        writer.writeUint16(channelCount);

        // Get pre-computed channel sizes from _prepareLayerChannelData
        const channelData = layer._channelData;

        // Channel information
        // Format: Channel ID (2 bytes) + Length (4 bytes)

        // Transparency mask (ID = -1)
        writer.writeInt16(-1);
        writer.writeUint32(channelData[0].totalSize);

        // L channel (ID = 0)
        writer.writeInt16(0);
        writer.writeUint32(channelData[1].totalSize);

        // a channel (ID = 1)
        writer.writeInt16(1);
        writer.writeUint32(channelData[2].totalSize);

        // b channel (ID = 2)
        writer.writeInt16(2);
        writer.writeUint32(channelData[3].totalSize);

        // User mask (ID = -2) - only for fill layers
        if (!isPixelLayer) {
            writer.writeInt16(-2);
            writer.writeUint32(channelData[4].totalSize);
        }

        // Blend mode signature
        writer.writeString('8BIM');
        writer.writeString('norm');  // Normal blend mode

        // Opacity (0-255)
        // NOTE: Opacity controls transparency (0=transparent, 255=opaque)
        // Visibility is controlled by bit 1 in flags, NOT opacity!
        writer.writeUint8(255);  // Always fully opaque

        // Clipping (0 = base)
        writer.writeUint8(0);

        // Flags:
        // bit 0: transparency protected
        // bit 1: HIDDEN (0 = visible, 1 = hidden) - NOTE: inverted logic!
        // bit 2: obsolete
        // bit 3: pixel data irrelevant to appearance (for fill layers)
        // bit 4: pixel data irrelevant (for fill layers)
        let flags = 0x00;

        // Set visibility bit (bit 1) - NOTE: bit 1 is a "hidden" flag, not "visible"!
        if (layer.visible === false) {
            flags |= 0x02;  // bit 1 = hidden
        }

        // Set pixel data irrelevance bits for fill layers
        if (!isPixelLayer) {
            flags |= 0x18;  // bits 3 and 4 set
        }

        writer.writeUint8(flags);

        // Filler
        writer.writeUint8(0);

        // Extra data section
        const extraStartPos = writer.tell();
        const updateExtraLength = writer.reserveUint32();

        // Layer mask data
        this._writeLayerMask(writer);

        // Layer blending ranges (40 bytes for Lab mode)
        writer.writeUint32(40);  // Length

        // Gray blend ranges (8 bytes): source and dest, black and white
        writer.writeUint8(0);    // Source black low
        writer.writeUint8(0);    // Source black high
        writer.writeUint8(255);  // Source white low
        writer.writeUint8(255);  // Source white high
        writer.writeUint8(0);    // Dest black low
        writer.writeUint8(0);    // Dest black high
        writer.writeUint8(255);  // Dest white low
        writer.writeUint8(255);  // Dest white high

        // Channel blend ranges: 4 ranges × 8 bytes (Lab has 3 channels, but format uses 4)
        for (let i = 0; i < 4; i++) {
            writer.writeUint8(0);    // Source black low
            writer.writeUint8(0);    // Source black high
            writer.writeUint8(255);  // Source white low
            writer.writeUint8(255);  // Source white high
            writer.writeUint8(0);    // Dest black low
            writer.writeUint8(0);    // Dest black high
            writer.writeUint8(255);  // Dest white low
            writer.writeUint8(255);  // Dest white high
        }

        // Layer name (Pascal string)
        writer.writePascalString(layer.name);

        // Additional layer information: Solid Color (SoCo) - only for fill layers
        if (!isPixelLayer) {
            this._writeSolidColorInfo(writer, layer.color);
        }

        // Additional layer information: Unicode layer name (luni)
        this._writeUnicodeLayerName(writer, layer.name);

        // Additional layer information: Layer ID (lyid) - required for 16-bit
        this._writeLayerID(writer, layer.id);

        // Note: Omitting optional metadata blocks (clbl, infx, knko, lspf, lclr, shmd, fxrp)
        // These are not strictly required and may cause validation warnings if not perfect

        // Update extra data length (total bytes after the length field)
        const extraLength = writer.tell() - extraStartPos - 4;
        updateExtraLength(extraLength);
    }

    /**
     * Write solid color fill layer information ('SoCo')
     */
    _writeSolidColorInfo(writer, color) {
        // Signature
        writer.writeString('8BIM');

        // Key: 'SoCo' = Solid Color
        writer.writeString('SoCo');

        // Write descriptor
        const descriptorData = DescriptorWriter.writeSolidColorLab(color);

        // Length
        writer.writeUint32(descriptorData.length);

        // Descriptor data
        writer.writeBytes(descriptorData);

        // Note: No padding for per-layer blocks (only global blocks need padding)
    }

    /**
     * Write Unicode layer name ('luni')
     */
    _writeUnicodeLayerName(writer, name) {
        // Signature
        writer.writeString('8BIM');

        // Key: 'luni' = Unicode layer name
        writer.writeString('luni');

        // Calculate data length: 4 (length) + 2 * charCount + 2 (null terminator)
        const dataLength = 4 + (name.length * 2) + 2;

        // Length
        writer.writeUint32(dataLength);

        // String length (in characters)
        writer.writeUint32(name.length);

        // Unicode characters (UTF-16 BE)
        for (let i = 0; i < name.length; i++) {
            writer.writeUint16(name.charCodeAt(i));
        }

        // Null terminator
        writer.writeUint16(0);

        // Note: No padding for per-layer blocks (only global blocks need padding)
    }

    /**
     * Write layer ID ('lyid')
     */
    _writeLayerID(writer, id) {
        writer.writeString('8BIM');
        writer.writeString('lyid');
        writer.writeUint32(4);  // Length: 4 bytes
        writer.writeUint32(id);
    }

    /**
     * Write blend clipping ('clbl')
     */
    _writeLayerBlendClipping(writer) {
        writer.writeString('8BIM');
        writer.writeString('clbl');
        writer.writeUint32(4);  // Length: 4 bytes
        writer.writeUint8(0);   // Blend clipped layers as a group: base
        writer.writeUint8(0);   // Padding
        writer.writeUint8(0);   // Padding
        writer.writeUint8(0);   // Padding
    }

    /**
     * Write blend interior elements ('infx')
     */
    _writeLayerBlendInterior(writer) {
        writer.writeString('8BIM');
        writer.writeString('infx');
        writer.writeUint32(4);  // Length: 4 bytes
        writer.writeUint8(0);   // Blend interior elements: disabled
        writer.writeUint8(0);   // Padding
        writer.writeUint8(0);   // Padding
        writer.writeUint8(0);   // Padding
    }

    /**
     * Write knockout ('knko')
     */
    _writeLayerKnockout(writer) {
        writer.writeString('8BIM');
        writer.writeString('knko');
        writer.writeUint32(4);  // Length: 4 bytes
        writer.writeUint8(0);   // Knockout: none
        writer.writeUint8(0);   // Padding
        writer.writeUint8(0);   // Padding
        writer.writeUint8(0);   // Padding
    }

    /**
     * Write layer protected ('lspf')
     */
    _writeLayerProtected(writer) {
        writer.writeString('8BIM');
        writer.writeString('lspf');
        writer.writeUint32(4);  // Length: 4 bytes
        writer.writeUint8(0);   // Protection flags: none
        writer.writeUint8(0);   // Padding
        writer.writeUint8(0);   // Padding
        writer.writeUint8(0);   // Padding
    }

    /**
     * Write sheet color setting ('lclr')
     */
    _writeLayerSheetColor(writer) {
        writer.writeString('8BIM');
        writer.writeString('lclr');
        writer.writeUint32(8);  // Length: 8 bytes
        writer.writeUint16(0);  // Color: none
        writer.writeUint16(0);  // Padding
        writer.writeUint16(0);  // Padding
        writer.writeUint16(0);  // Padding
    }

    /**
     * Write metadata setting ('shmd')
     */
    _writeLayerMetadata(writer) {
        writer.writeString('8BIM');
        writer.writeString('shmd');
        writer.writeUint32(72); // Length: 72 bytes

        // Use exact shmd content from reference file
        const shmdData = Buffer.from(
            '000000013842494d6375737400000000' +
            '00000034000000100000000100000000' +
            '00086d65746164617461000000010000' +
            '00096c6179657254696d65646f756241' +
            'da5b6f2950834d00',
            'hex'
        );
        writer.writeBytes(shmdData);
    }

    /**
     * Write reference point ('fxrp')
     */
    _writeLayerReferencePoint(writer) {
        writer.writeString('8BIM');
        writer.writeString('fxrp');
        writer.writeUint32(16); // Length: 16 bytes
        writer.writeUint32(0);  // X: 0.0 (double, first half)
        writer.writeUint32(0);  // X: 0.0 (double, second half)
        writer.writeUint32(0);  // Y: 0.0 (double, first half)
        writer.writeUint32(0);  // Y: 0.0 (double, second half)
    }

    /**
     * Write layer mask data
     */
    _writeLayerMask(writer) {
        const startPos = writer.tell();
        const updateMaskLength = writer.reserveUint32();

        // Mask bounding rectangle (covers entire layer)
        writer.writeInt32(0);              // Top
        writer.writeInt32(0);              // Left
        writer.writeInt32(this.height);   // Bottom
        writer.writeInt32(this.width);    // Right

        // Default color (0 = white/transparent, 255 = black/opaque)
        // 0 means areas outside the mask bounds are transparent
        writer.writeUint8(0);

        // Flags: bit 0=position relative to layer, bit 1=disabled, bit 2=invert
        // All zeros = position absolute, mask enabled, not inverted
        writer.writeUint8(0);

        // Padding to make mask data size even (required by spec)
        writer.writeUint16(0);

        // Update mask data length (total bytes after the length field)
        const maskLength = writer.tell() - startPos - 4;
        updateMaskLength(maskLength);
    }

    /**
     * Write pre-computed channel data
     */
    _writePrecomputedChannel(writer, channelInfo) {
        if (channelInfo.empty) {
            // Empty channel (just compression header)
            writer.writeUint16(0);
        } else if (channelInfo.rowByteCounts) {
            // RLE compressed
            writer.writeUint16(1);  // RLE compression
            for (let y = 0; y < this.height; y++) {
                writer.writeUint16(channelInfo.rowByteCounts[y]);
            }
            writer.writeBytes(channelInfo.compressedData);
        } else {
            // Raw uncompressed
            writer.writeUint16(0);
            writer.writeBytes(channelInfo.raw);
        }
    }

    /**
     * Write channel image data for a layer (using pre-computed data)
     */
    _writeLayerChannelData(writer, layer) {
        const channelData = layer._channelData;

        // Write all pre-computed channels
        for (const channelInfo of channelData) {
            this._writePrecomputedChannel(writer, channelInfo);
        }
    }

    /**
     * Section 5: Image Data (composite/merged preview)
     *
     * This is what macOS Finder/QuickLook uses to render previews.
     * Must contain actual flattened image data, not neutral values.
     *
     * IMPORTANT: The number of channels written here must match the
     * channel count declared in the header (Section 1).
     */
    _writeImageData(writer) {
        const pixelCount = this.width * this.height;

        // Calculate how many extra alpha channels we need (same formula as header)
        const extraAlphaCount = this.layers.length > 0 ? Math.min(this.layers.length, 4) : 0;

        // Find the pixel source: compositePixels (flat mode) or first pixel layer
        const pixelLayer = this.flatMode ? null : this.layers.find(layer => layer.type === 'pixel');
        const pixelSource = this.flatMode ? this.compositePixels : (pixelLayer ? pixelLayer.pixels : null);

        const useRLE = this.compression === 'rle';

        if (useRLE) {
            // RLE compression (type 1)
            writer.writeUint16(1);

            // Build channel data arrays
            const channels = [];
            const bytesPerPixel = this.bitsPerChannel === 16 ? 2 : 1;

            if (this.bitsPerChannel === 16) {
                if (pixelSource) {
                    // L channel
                    const L_channel = Buffer.alloc(pixelCount * 2);
                    // a channel
                    const a_channel = Buffer.alloc(pixelCount * 2);
                    // b channel
                    const b_channel = Buffer.alloc(pixelCount * 2);

                    if (pixelLayer && pixelLayer.pixels16bit) {
                        // Native 16-bit: copy directly (6 bytes per pixel)
                        for (let i = 0; i < pixelCount; i++) {
                            L_channel[i * 2] = pixelSource[i * 6];
                            L_channel[i * 2 + 1] = pixelSource[i * 6 + 1];
                            a_channel[i * 2] = pixelSource[i * 6 + 2];
                            a_channel[i * 2 + 1] = pixelSource[i * 6 + 3];
                            b_channel[i * 2] = pixelSource[i * 6 + 4];
                            b_channel[i * 2 + 1] = pixelSource[i * 6 + 5];
                        }
                    } else {
                        // 8-bit encoding: scale to 16-bit
                        for (let i = 0; i < pixelCount; i++) {
                            L_channel.writeUInt16BE(pixelSource[i * 3] * 257, i * 2);
                            a_channel.writeUInt16BE(pixelSource[i * 3 + 1] * 257, i * 2);
                            b_channel.writeUInt16BE(pixelSource[i * 3 + 2] * 257, i * 2);
                        }
                    }

                    channels.push(L_channel);
                    channels.push(a_channel);
                    channels.push(b_channel);
                } else {
                    // Neutral white
                    const L_channel = Buffer.alloc(pixelCount * 2);
                    const ab_channel = Buffer.alloc(pixelCount * 2);
                    for (let i = 0; i < pixelCount; i++) {
                        L_channel.writeUInt16BE(65535, i * 2);
                        ab_channel.writeUInt16BE(32768, i * 2);
                    }
                    channels.push(L_channel);
                    channels.push(ab_channel);  // a
                    channels.push(Buffer.from(ab_channel));  // b (copy)
                }

                // Add extra alpha channels for layer masks (16-bit)
                for (let a = 0; a < extraAlphaCount; a++) {
                    const alpha_channel = Buffer.alloc(pixelCount * 2);
                    for (let i = 0; i < pixelCount; i++) {
                        alpha_channel.writeUInt16BE(65535, i * 2);  // Fully opaque
                    }
                    channels.push(alpha_channel);
                }
            } else {
                // 8-bit mode
                if (pixelSource) {
                    const L_channel = Buffer.alloc(pixelCount);
                    const a_channel = Buffer.alloc(pixelCount);
                    const b_channel = Buffer.alloc(pixelCount);
                    for (let i = 0; i < pixelCount; i++) {
                        L_channel[i] = pixelSource[i * 3];
                        a_channel[i] = pixelSource[i * 3 + 1];
                        b_channel[i] = pixelSource[i * 3 + 2];
                    }
                    channels.push(L_channel, a_channel, b_channel);
                } else {
                    const neutral = Buffer.alloc(pixelCount, 128);
                    channels.push(Buffer.from(neutral), Buffer.from(neutral), Buffer.from(neutral));
                }

                // Add extra alpha channels for layer masks (8-bit)
                for (let a = 0; a < extraAlphaCount; a++) {
                    const alpha_channel = Buffer.alloc(pixelCount, 255);  // Fully opaque
                    channels.push(alpha_channel);
                }
            }

            // Compress each channel and collect row byte counts
            const allRowByteCounts = [];
            const allCompressedData = [];

            for (const channelData of channels) {
                const { rowByteCounts, compressedData } = this._compressChannelRLE(channelData, bytesPerPixel);
                allRowByteCounts.push(rowByteCounts);
                allCompressedData.push(compressedData);
            }

            // Write all row byte counts first (for all channels)
            for (const rowByteCounts of allRowByteCounts) {
                for (let y = 0; y < this.height; y++) {
                    writer.writeUint16(rowByteCounts[y]);
                }
            }

            // Write all compressed data
            for (const compressedData of allCompressedData) {
                writer.writeBytes(compressedData);
            }
        } else {
            // Uncompressed (type 0)
            writer.writeUint16(0);

            if (this.bitsPerChannel === 16) {
                if (pixelSource) {
                    if (pixelLayer && pixelLayer.pixels16bit) {
                        // Native 16-bit: write directly (6 bytes per pixel)
                        // L channel (planar)
                        for (let i = 0; i < pixelCount; i++) {
                            writer.writeUint8(pixelSource[i * 6]);
                            writer.writeUint8(pixelSource[i * 6 + 1]);
                        }
                        // a channel (planar)
                        for (let i = 0; i < pixelCount; i++) {
                            writer.writeUint8(pixelSource[i * 6 + 2]);
                            writer.writeUint8(pixelSource[i * 6 + 3]);
                        }
                        // b channel (planar)
                        for (let i = 0; i < pixelCount; i++) {
                            writer.writeUint8(pixelSource[i * 6 + 4]);
                            writer.writeUint8(pixelSource[i * 6 + 5]);
                        }
                    } else {
                        // 8-bit encoding: scale to 16-bit
                        for (let i = 0; i < pixelCount; i++) {
                            writer.writeUint16(pixelSource[i * 3] * 257);
                        }
                        for (let i = 0; i < pixelCount; i++) {
                            writer.writeUint16(pixelSource[i * 3 + 1] * 257);
                        }
                        for (let i = 0; i < pixelCount; i++) {
                            writer.writeUint16(pixelSource[i * 3 + 2] * 257);
                        }
                    }
                } else {
                    for (let i = 0; i < pixelCount; i++) writer.writeUint16(65535);
                    for (let i = 0; i < pixelCount; i++) writer.writeUint16(32768);
                    for (let i = 0; i < pixelCount; i++) writer.writeUint16(32768);
                }

                // Extra alpha channels for layer masks (16-bit uncompressed)
                for (let a = 0; a < extraAlphaCount; a++) {
                    for (let i = 0; i < pixelCount; i++) {
                        writer.writeUint16(65535);  // Fully opaque
                    }
                }
            } else {
                if (pixelSource) {
                    for (let i = 0; i < pixelCount; i++) writer.writeUint8(pixelSource[i * 3]);
                    for (let i = 0; i < pixelCount; i++) writer.writeUint8(pixelSource[i * 3 + 1]);
                    for (let i = 0; i < pixelCount; i++) writer.writeUint8(pixelSource[i * 3 + 2]);
                } else {
                    for (let i = 0; i < pixelCount; i++) writer.writeUint8(128);
                    for (let i = 0; i < pixelCount; i++) writer.writeUint8(128);
                    for (let i = 0; i < pixelCount; i++) writer.writeUint8(128);
                }

                // Extra alpha channels for layer masks (8-bit uncompressed)
                for (let a = 0; a < extraAlphaCount; a++) {
                    for (let i = 0; i < pixelCount; i++) {
                        writer.writeUint8(255);  // Fully opaque
                    }
                }
            }
        }
    }
}

module.exports = PSDWriter;
