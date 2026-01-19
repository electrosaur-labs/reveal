/**
 * PSDReader - Minimal PSD file parser for analyzing fill+mask layer structure
 *
 * This reads and dumps PSD file structure to help us understand the exact
 * byte format Photoshop uses for fill layers with masks.
 */

class PSDReader {
    constructor(buffer) {
        this.buffer = buffer;
        this.offset = 0;
    }

    /**
     * Read the entire PSD file structure
     */
    read() {
        const result = {
            header: this.readHeader(),
            colorModeData: this.readColorModeData(),
            imageResources: this.readImageResources(),
            layerAndMaskInfo: this.readLayerAndMaskInfo(),
            // Skip image data for now
        };

        return result;
    }

    /**
     * Read file header (26 bytes)
     */
    readHeader() {
        const header = {
            signature: this.readString(4),
            version: this.readUint16(),
            reserved: this.readBytes(6),
            channels: this.readUint16(),
            height: this.readUint32(),
            width: this.readUint32(),
            depth: this.readUint16(),
            mode: this.readUint16()
        };

        return header;
    }

    /**
     * Read color mode data section
     */
    readColorModeData() {
        const length = this.readUint32();
        const data = this.readBytes(length);
        return { length, data };
    }

    /**
     * Read image resources section
     */
    readImageResources() {
        const length = this.readUint32();
        const startOffset = this.offset;
        const resources = [];

        while (this.offset < startOffset + length) {
            resources.push(this.readImageResource());
        }

        return { length, resources };
    }

    /**
     * Read a single image resource
     */
    readImageResource() {
        const signature = this.readString(4);
        const id = this.readUint16();
        const nameLength = this.readUint8();
        const name = nameLength > 0 ? this.readString(nameLength) : '';

        // Pad to even
        if ((nameLength + 1) % 2 !== 0) {
            this.offset++;
        }

        const dataLength = this.readUint32();
        const data = this.readBytes(dataLength);

        // Pad to even
        if (dataLength % 2 !== 0) {
            this.offset++;
        }

        return { signature, id, name, dataLength, data };
    }

    /**
     * Read layer and mask information section
     */
    readLayerAndMaskInfo() {
        const sectionLength = this.readUint32();
        const sectionStart = this.offset;

        const layerInfo = this.readLayerInfo();

        // Global layer mask info
        const globalMaskLength = this.readUint32();
        const globalMask = this.readBytes(globalMaskLength);

        return {
            sectionLength,
            layerInfo,
            globalMaskLength,
            globalMask
        };
    }

    /**
     * Read layer info subsection
     */
    readLayerInfo() {
        const length = this.readUint32();
        const startOffset = this.offset;

        const layerCount = this.readInt16();
        const actualCount = Math.abs(layerCount);
        const layers = [];

        console.log(`\nReading ${actualCount} layer records...`);

        for (let i = 0; i < actualCount; i++) {
            console.log(`\n=== Layer ${i + 1} ===`);
            layers.push(this.readLayerRecord());
        }

        console.log(`\n=== Reading channel image data for ${actualCount} layers ===`);

        // Read channel image data for each layer
        for (let i = 0; i < layers.length; i++) {
            console.log(`\nLayer ${i + 1} channel data:`);
            layers[i].channelData = this.readLayerChannelData(layers[i]);
        }

        return {
            length,
            layerCount,
            layers
        };
    }

    /**
     * Read a single layer record
     */
    readLayerRecord() {
        const layer = {
            top: this.readInt32(),
            left: this.readInt32(),
            bottom: this.readInt32(),
            right: this.readInt32()
        };

        layer.width = layer.right - layer.left;
        layer.height = layer.bottom - layer.top;

        const channelCount = this.readUint16();
        layer.channels = [];

        console.log(`  Bounds: (${layer.top}, ${layer.left}, ${layer.bottom}, ${layer.right}) = ${layer.width}x${layer.height}`);
        console.log(`  Channels: ${channelCount}`);

        for (let i = 0; i < channelCount; i++) {
            const channelID = this.readInt16();
            const dataLength = this.readUint32();
            layer.channels.push({ channelID, dataLength });
            console.log(`    Channel ${i}: ID=${channelID}, length=${dataLength} bytes`);
        }

        layer.blendModeSignature = this.readString(4);
        layer.blendModeKey = this.readString(4);
        layer.opacity = this.readUint8();
        layer.clipping = this.readUint8();
        layer.flags = this.readUint8();
        layer.filler = this.readUint8();

        console.log(`  Blend: ${layer.blendModeKey}, opacity=${layer.opacity}, flags=0x${layer.flags.toString(16)}`);

        const extraDataLength = this.readUint32();
        const extraDataStart = this.offset;

        console.log(`  Extra data: ${extraDataLength} bytes`);

        // Layer mask data
        layer.mask = this.readLayerMask();

        // Blending ranges
        layer.blendingRangesLength = this.readUint32();
        layer.blendingRanges = this.readBytes(layer.blendingRangesLength);
        console.log(`  Blending ranges: ${layer.blendingRangesLength} bytes`);

        // Layer name
        layer.name = this.readPascalString();
        console.log(`  Name: "${layer.name}"`);

        // Additional layer information
        layer.additionalInfo = [];
        while (this.offset < extraDataStart + extraDataLength) {
            const info = this.readAdditionalLayerInfo();
            layer.additionalInfo.push(info);
        }

        return layer;
    }

    /**
     * Read layer mask data
     */
    readLayerMask() {
        const length = this.readUint32();

        if (length === 0) {
            console.log(`  Mask: none`);
            return { length: 0 };
        }

        const mask = {
            length,
            top: this.readInt32(),
            left: this.readInt32(),
            bottom: this.readInt32(),
            right: this.readInt32(),
            defaultColor: this.readUint8(),
            flags: this.readUint8()
        };

        console.log(`  Mask: bounds=(${mask.top}, ${mask.left}, ${mask.bottom}, ${mask.right}), color=${mask.defaultColor}, flags=0x${mask.flags.toString(16)}`);

        // Read remaining bytes based on length
        const remaining = length - 18;  // 4*4 + 1 + 1 = 18 bytes read
        if (remaining > 0) {
            mask.extraData = this.readBytes(remaining);
            console.log(`  Mask extra data: ${remaining} bytes`);
        }

        return mask;
    }

    /**
     * Read Pascal string (length byte + string, padded to 4-byte boundary)
     */
    readPascalString() {
        const length = this.readUint8();
        const str = length > 0 ? this.readString(length) : '';

        // Pad to 4-byte boundary (including length byte)
        const totalLength = 1 + length;
        const padding = (4 - (totalLength % 4)) % 4;
        this.offset += padding;

        return str;
    }

    /**
     * Read additional layer information
     */
    readAdditionalLayerInfo() {
        const signature = this.readString(4);
        const key = this.readString(4);
        const length = this.readUint32();
        const data = this.readBytes(length);

        console.log(`  Additional info: sig="${signature}", key="${key}", length=${length} bytes`);

        // Try to parse known types
        let parsed = null;
        if (key === 'SoCo') {
            console.log(`    -> Solid Color fill layer detected!`);
            parsed = this.parseSolidColorDescriptor(data);
        }

        return { signature, key, length, data, parsed };
    }

    /**
     * Parse solid color descriptor
     */
    parseSolidColorDescriptor(data) {
        // This is complex - for now just dump hex
        const hex = Buffer.from(data).toString('hex');
        console.log(`    Descriptor hex (first 100 bytes): ${hex.substring(0, 200)}...`);
        return { hex };
    }

    /**
     * Read channel image data for a layer
     */
    readLayerChannelData(layer) {
        const channelData = [];

        for (const channel of layer.channels) {
            const compression = this.readUint16();
            const dataLength = channel.dataLength - 2;  // Minus compression bytes
            const data = this.readBytes(dataLength);

            console.log(`  Channel ID=${channel.channelID}: compression=${compression}, data=${dataLength} bytes`);

            channelData.push({ compression, data });
        }

        return channelData;
    }

    // ===== Low-level read methods =====

    readUint8() {
        return this.buffer.readUInt8(this.offset++);
    }

    readUint16() {
        const value = this.buffer.readUInt16BE(this.offset);
        this.offset += 2;
        return value;
    }

    readInt16() {
        const value = this.buffer.readInt16BE(this.offset);
        this.offset += 2;
        return value;
    }

    readUint32() {
        const value = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return value;
    }

    readInt32() {
        const value = this.buffer.readInt32BE(this.offset);
        this.offset += 4;
        return value;
    }

    readString(length) {
        const str = this.buffer.toString('ascii', this.offset, this.offset + length);
        this.offset += length;
        return str;
    }

    readBytes(length) {
        const bytes = this.buffer.slice(this.offset, this.offset + length);
        this.offset += length;
        return bytes;
    }
}

module.exports = PSDReader;
