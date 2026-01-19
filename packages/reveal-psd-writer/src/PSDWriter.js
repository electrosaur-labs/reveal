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

        // Validate constraints
        if (this.colorMode !== 'lab') {
            throw new Error('Only Lab color mode is currently supported');
        }
        if (this.bitsPerChannel !== 8) {
            throw new Error('Only 8-bit per channel is currently supported');
        }
    }

    /**
     * Add a solid color fill layer with mask
     *
     * @param {Object} options - Layer options
     * @param {string} options.name - Layer name
     * @param {Object} options.color - Lab color { L, a, b }
     * @param {Uint8Array} options.mask - Layer mask (width * height bytes, 255=visible)
     */
    addFillLayer(options) {
        if (!options.name) {
            throw new Error('Layer name is required');
        }
        if (!options.color || typeof options.color.L === 'undefined') {
            throw new Error('Lab color is required');
        }
        if (!options.mask || options.mask.length !== this.width * this.height) {
            throw new Error(`Mask must be ${this.width * this.height} bytes`);
        }

        this.layers.push({
            name: options.name,
            color: options.color,
            mask: options.mask
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

        writer.writeUint16(3);        // Channels: 3 (L, a, b)
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
     * Minimal implementation - just length field
     */
    _writeImageResources(writer) {
        writer.writeUint32(0);  // Length = 0 (no resources)
    }

    /**
     * Section 4: Layer and Mask Information
     *
     * This is the most complex section, containing all layer data
     */
    _writeLayerAndMaskInfo(writer) {
        const startPos = writer.tell();
        const updateSectionLength = writer.reserveUint32();

        // Write layer info subsection
        this._writeLayerInfo(writer);

        // Write global layer mask info (empty for now)
        writer.writeUint32(0);  // Length = 0

        // Update section length (total bytes after the length field)
        const sectionLength = writer.tell() - startPos - 4;
        updateSectionLength(sectionLength);
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
        // Bounding rectangle (layer covers entire canvas)
        writer.writeInt32(0);              // Top
        writer.writeInt32(0);              // Left
        writer.writeInt32(this.height);   // Bottom
        writer.writeInt32(this.width);    // Right

        // Number of channels (1 transparency + 3 Lab channels + 1 user mask)
        writer.writeUint16(5);

        // Channel data size: 2 bytes (compression) + pixel data
        const channelDataSize = 2 + (this.width * this.height);

        // Channel information
        // Transparency mask (ID = -1)
        writer.writeInt16(-1);
        writer.writeUint32(channelDataSize);

        // L channel (ID = 0)
        writer.writeInt16(0);
        writer.writeUint32(channelDataSize);

        // a channel (ID = 1)
        writer.writeInt16(1);
        writer.writeUint32(channelDataSize);

        // b channel (ID = 2)
        writer.writeInt16(2);
        writer.writeUint32(channelDataSize);

        // User mask (ID = -2)
        writer.writeInt16(-2);
        writer.writeUint32(channelDataSize);

        // Blend mode signature
        writer.writeString('8BIM');
        writer.writeString('norm');  // Normal blend mode

        // Opacity (0-255)
        writer.writeUint8(255);

        // Clipping (0 = base)
        writer.writeUint8(0);

        // Flags: Match real Photoshop files (0x18 = bits 3 and 4 set)
        // Bit 3 (0x08): Pixel data irrelevant to appearance (fill layers)
        // Bit 4 (0x10): Related to visibility/transparency
        writer.writeUint8(0x18);

        // Filler
        writer.writeUint8(0);

        // Extra data section
        const extraStartPos = writer.tell();
        const updateExtraLength = writer.reserveUint32();

        // Layer mask data
        this._writeLayerMask(writer);

        // Layer blending ranges (empty)
        writer.writeUint32(0);

        // Layer name (Pascal string)
        writer.writePascalString(layer.name);

        // Additional layer information: Solid Color (SoCo)
        this._writeSolidColorInfo(writer, layer.color);

        // Additional layer information: Unicode layer name (luni)
        this._writeUnicodeLayerName(writer, layer.name);

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
        const { color, mask } = layer;

        // Compression type: 0 = raw data (no compression)
        const compression = 0;

        // Transparency channel (ID=-1) - all 255 (fully opaque)
        writer.writeUint16(compression);
        for (let i = 0; i < this.width * this.height; i++) {
            writer.writeUint8(255);
        }

        // L channel - solid fill with L value
        writer.writeUint16(compression);
        const L_byte = Math.round((color.L / 100) * 255);
        for (let i = 0; i < this.width * this.height; i++) {
            writer.writeUint8(L_byte);
        }

        // a channel - solid fill with a value
        writer.writeUint16(compression);
        const a_byte = Math.round(color.a + 128);
        for (let i = 0; i < this.width * this.height; i++) {
            writer.writeUint8(a_byte);
        }

        // b channel - solid fill with b value
        writer.writeUint16(compression);
        const b_byte = Math.round(color.b + 128);
        for (let i = 0; i < this.width * this.height; i++) {
            writer.writeUint8(b_byte);
        }

        // User mask channel (ID=-2) - actual mask data
        writer.writeUint16(compression);
        writer.writeBytes(mask);
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

        // Write black Lab values for entire image (3 channels)
        const pixelCount = this.width * this.height;

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

module.exports = PSDWriter;
