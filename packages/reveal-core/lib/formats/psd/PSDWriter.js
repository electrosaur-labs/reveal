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

        // Validate constraints
        if (this.colorMode !== 'lab') {
            throw new Error('Only Lab color mode is currently supported');
        }
        if (this.bitsPerChannel !== 8 && this.bitsPerChannel !== 16) {
            throw new Error('Only 8-bit and 16-bit per channel are supported');
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
        const expectedSize = pixelCount * 3;  // L, a, b

        if (options.pixels.length !== expectedSize) {
            throw new Error(
                `Pixel data must be ${expectedSize} bytes (${this.width}×${this.height}×3), ` +
                `got ${options.pixels.length} bytes`
            );
        }

        this.layers.push({
            id: this.nextLayerID++,
            name: options.name,
            type: 'pixel',
            pixels: Buffer.from(options.pixels),
            visible: options.visible !== undefined ? options.visible : true
        });
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

        // Channels: 3 Lab (L,a,b) + transparency/alpha channels
        // Reference files have 7 channels total (3 Lab + 4 extra)
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

        // Update section length
        const length = writer.tell() - startPos - 4;
        updateLength(length);
    }

    /**
     * Section 4: Layer and Mask Information
     *
     * This is the most complex section, containing all layer data
     */
    _writeLayerAndMaskInfo(writer) {
        const startPos = writer.tell();
        const updateSectionLength = writer.reserveUint32();

        if (this.bitsPerChannel === 16) {
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

        // Channel data sizes
        let transparencySize, labChannelSize, maskSize;
        const pixelCount = this.width * this.height;

        if (this.bitsPerChannel === 16) {
            if (isPixelLayer) {
                // 16-bit pixel layer: all channels have actual pixel data
                transparencySize = 2 + (pixelCount * 2);  // Compression + 16-bit pixels
                labChannelSize = 2 + (pixelCount * 2);    // Compression + 16-bit pixels
            } else {
                // 16-bit fill layer: L/a/b have no pixel data, just compression header
                transparencySize = 2;  // Just compression header
                labChannelSize = 2;    // Just compression header
                // Mask: compression header (2 bytes) + raw uncompressed mask data
                maskSize = 2 + layer.mask.length;
            }
        } else {
            // 8-bit: all channels have pixel data
            transparencySize = 2 + pixelCount;
            labChannelSize = 2 + pixelCount;
            maskSize = 2 + pixelCount;
        }

        // Channel information
        // Format: Channel ID (2 bytes) + Length (4 bytes)
        // NOTE: 8-byte Uint64 lengths only apply to PSB format, not regular 16-bit PSDs

        // Transparency mask (ID = -1)
        writer.writeInt16(-1);
        writer.writeUint32(transparencySize);

        // L channel (ID = 0)
        writer.writeInt16(0);
        writer.writeUint32(labChannelSize);

        // a channel (ID = 1)
        writer.writeInt16(1);
        writer.writeUint32(labChannelSize);

        // b channel (ID = 2)
        writer.writeInt16(2);
        writer.writeUint32(labChannelSize);

        // User mask (ID = -2) - only for fill layers
        if (!isPixelLayer) {
            writer.writeInt16(-2);
            writer.writeUint32(maskSize);
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
     * Write channel image data for a layer
     */
    _writeLayerChannelData(writer, layer) {
        const { color, mask, type, pixels } = layer;

        // Compression type: 0 = raw (uncompressed)
        const noCompression = 0;

        if (this.bitsPerChannel === 16) {
            if (type === 'pixel') {
                // 16-bit pixel layer: write actual Lab pixel data
                const pixelCount = this.width * this.height;

                // Transparency channel (ID=-1) - all fully opaque
                writer.writeUint16(noCompression);
                for (let i = 0; i < pixelCount; i++) {
                    writer.writeUint16(65535);  // Fully opaque
                }

                // L channel - actual pixel data (convert byte encoding to 16-bit)
                writer.writeUint16(noCompression);
                for (let i = 0; i < pixelCount; i++) {
                    const L_byte = pixels[i * 3];  // 0-255
                    const L_16 = Math.round((L_byte / 255) * 65535);
                    writer.writeUint16(L_16);
                }

                // a channel - actual pixel data
                writer.writeUint16(noCompression);
                for (let i = 0; i < pixelCount; i++) {
                    const a_byte = pixels[i * 3 + 1];  // 0-255 (128 is neutral)
                    const a_16 = Math.round((a_byte / 255) * 65535);
                    writer.writeUint16(a_16);
                }

                // b channel - actual pixel data
                writer.writeUint16(noCompression);
                for (let i = 0; i < pixelCount; i++) {
                    const b_byte = pixels[i * 3 + 2];  // 0-255 (128 is neutral)
                    const b_16 = Math.round((b_byte / 255) * 65535);
                    writer.writeUint16(b_16);
                }
            } else {
                // 16-bit fill layers: L/a/b channels have NO pixel data
                // Transparency channel (ID=-1) - just compression header
                writer.writeUint16(noCompression);

                // L channel - just compression header
                writer.writeUint16(noCompression);

                // a channel - just compression header
                writer.writeUint16(noCompression);

                // b channel - just compression header
                writer.writeUint16(noCompression);

                // User mask channel (ID=-2) - actual mask data (16-bit for 16-bit files!)
                // Write raw uncompressed mask data
                writer.writeUint16(noCompression);
                writer.writeBytes(mask);
            }
        } else {
            // 8-bit fill layers: write solid pixel data
            // Transparency channel (ID=-1) - all 255 (fully opaque)
            writer.writeUint16(noCompression);
            for (let i = 0; i < this.width * this.height; i++) {
                writer.writeUint8(255);
            }

            // L channel - solid fill with L value
            writer.writeUint16(noCompression);
            const L_byte = Math.round((color.L / 100) * 255);
            for (let i = 0; i < this.width * this.height; i++) {
                writer.writeUint8(L_byte);
            }

            // a channel - solid fill with a value
            writer.writeUint16(noCompression);
            const a_byte = Math.round(color.a + 128);
            for (let i = 0; i < this.width * this.height; i++) {
                writer.writeUint8(a_byte);
            }

            // b channel - solid fill with b value
            writer.writeUint16(noCompression);
            const b_byte = Math.round(color.b + 128);
            for (let i = 0; i < this.width * this.height; i++) {
                writer.writeUint8(b_byte);
            }

            // User mask channel (ID=-2) - actual mask data
            writer.writeUint16(noCompression);
            writer.writeBytes(mask);
        }
    }

    /**
     * Section 5: Image Data (composite preview)
     *
     * For now, write empty/black composite
     * Photoshop will generate preview on first open
     */
    _writeImageData(writer) {
        // Compression: 0 = raw
        writer.writeUint16(0);

        const pixelCount = this.width * this.height;
        const channelCount = this.layers.length > 0 ? 3 + Math.min(this.layers.length, 4) : 3;

        if (this.bitsPerChannel === 16) {
            // 16-bit: 2 bytes per pixel
            // Composite image uses different scaling than layer data:
            // - Lab channels: L=white is 0xFFFF, a/b neutral is 0x8000 (32768)
            // - Layer data uses: L=100 → 32768, a/b neutral=16384

            // Channel 0: L channel (white) = 0xFFFF
            for (let i = 0; i < pixelCount; i++) {
                writer.writeUint16(65535);
            }

            // Channel 1: a channel (neutral) = 0x8000 = 32768
            for (let i = 0; i < pixelCount; i++) {
                writer.writeUint16(32768);
            }

            // Channel 2: b channel (neutral) = 0x8000 = 32768
            for (let i = 0; i < pixelCount; i++) {
                writer.writeUint16(32768);
            }

            // Additional alpha/transparency channels (if any)
            // For now, write zeros for extra channels
            for (let ch = 3; ch < channelCount; ch++) {
                for (let i = 0; i < pixelCount; i++) {
                    writer.writeUint16(0);
                }
            }
        } else {
            // 8-bit: 1 byte per pixel
            // L channel: 0 (black)
            for (let i = 0; i < pixelCount; i++) {
                writer.writeUint8(0);
            }

            // a channel: 128 (neutral)
            for (let i = 0; i < pixelCount; i++) {
                writer.writeUint8(128);
            }

            // b channel: 128 (neutral)
            for (let i = 0; i < pixelCount; i++) {
                writer.writeUint8(128);
            }
        }
    }
}

module.exports = PSDWriter;
