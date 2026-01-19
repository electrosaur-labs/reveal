/**
 * DescriptorWriter - Minimal descriptor format writer for PSD
 *
 * Descriptors are used for adjustment layers, fill layers, etc.
 * This implements just enough to write a Lab solid color descriptor.
 */

const BinaryWriter = require('./BinaryWriter');

class DescriptorWriter {
    /**
     * Write a solid color fill descriptor (Lab color)
     *
     * @param {Object} color - Lab color { L, a, b }
     * @returns {Buffer} Descriptor data
     */
    static writeSolidColorLab(color) {
        const writer = new BinaryWriter();

        // Version (always 16 for Photoshop 6.0+)
        writer.writeUint32(16);

        // Write descriptor
        this._writeDescriptor(writer, {
            name: '',  // Empty Unicode string
            classID: 'null',  // Class ID for solid color
            items: [
                {
                    key: 'Clr ',  // Color key
                    type: 'Objc',  // Object
                    value: {
                        name: '',
                        classID: 'LbCl',  // Lab Color class
                        items: [
                            { key: 'Lmnc', type: 'doub', value: color.L },  // Luminance
                            { key: 'A   ', type: 'doub', value: color.a },  // A channel
                            { key: 'B   ', type: 'doub', value: color.b }   // B channel
                        ]
                    }
                }
            ]
        });

        return writer.toBuffer();
    }

    /**
     * Write a descriptor structure
     */
    static _writeDescriptor(writer, desc) {
        // Unicode string name (empty for solid color)
        this._writeUnicodeString(writer, desc.name);

        // Class ID (4-byte string or variable length)
        this._writeClassID(writer, desc.classID);

        // Item count
        writer.writeUint32(desc.items.length);

        // Write each item
        for (const item of desc.items) {
            this._writeDescriptorItem(writer, item);
        }
    }

    /**
     * Write a single descriptor item
     */
    static _writeDescriptorItem(writer, item) {
        // Key (with length field - use 0 for 4-byte keys)
        this._writeKey(writer, item.key);

        // Type (4-byte string: 'Objc', 'doub', 'long', 'bool', etc.)
        writer.writeString(item.type);

        // Value (depends on type)
        switch (item.type) {
            case 'Objc':  // Object reference
                this._writeDescriptor(writer, item.value);
                break;

            case 'doub':  // Double
                this._writeDouble(writer, item.value);
                break;

            case 'long':  // Integer
                writer.writeInt32(item.value);
                break;

            case 'bool':  // Boolean
                writer.writeUint8(item.value ? 1 : 0);
                break;

            default:
                throw new Error(`Unsupported descriptor type: ${item.type}`);
        }
    }

    /**
     * Write Unicode string (length + UTF-16 chars)
     *
     * Note: Photoshop uses length=1 with null char for empty strings
     */
    static _writeUnicodeString(writer, str) {
        if (str.length === 0) {
            // Empty string: write length=1 with null character
            writer.writeUint32(1);
            writer.writeUint16(0);  // Null character U+0000
        } else {
            // Normal string
            writer.writeUint32(str.length);
            for (let i = 0; i < str.length; i++) {
                writer.writeUint16(str.charCodeAt(i));
            }
        }
    }

    /**
     * Write class ID (length + ASCII chars, or 4-byte string if length=0)
     */
    static _writeClassID(writer, classID) {
        if (classID.length === 4) {
            // Short form: length=0, then 4-byte string
            writer.writeUint32(0);
            writer.writeString(classID);
        } else {
            // Long form: length + string
            writer.writeUint32(classID.length);
            writer.writeString(classID);
        }
    }

    /**
     * Write key (same format as class ID)
     */
    static _writeKey(writer, key) {
        if (key.length === 4) {
            // Short form: length=0, then 4-byte string
            writer.writeUint32(0);
            writer.writeString(key);
        } else {
            // Long form: length + string
            writer.writeUint32(key.length);
            writer.writeString(key);
        }
    }

    /**
     * Write double (8 bytes, big-endian)
     */
    static _writeDouble(writer, value) {
        const buffer = Buffer.allocUnsafe(8);
        buffer.writeDoubleBE(value, 0);
        writer.writeBytes(buffer);
    }
}

module.exports = DescriptorWriter;
