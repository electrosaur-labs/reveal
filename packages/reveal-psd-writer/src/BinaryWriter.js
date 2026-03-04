/**
 * BinaryWriter - Helper class for writing binary PSD data
 *
 * PSD format uses big-endian byte order for all multi-byte values.
 */

class BinaryWriter {
    constructor() {
        this.buffers = [];
        this.length = 0;
    }

    /**
     * Write a single byte (8-bit unsigned integer)
     */
    writeUint8(value) {
        const buf = Buffer.allocUnsafe(1);
        buf.writeUInt8(value, 0);
        this.buffers.push(buf);
        this.length += 1;
    }

    /**
     * Write a 16-bit unsigned integer (big-endian)
     */
    writeUint16(value) {
        const buf = Buffer.allocUnsafe(2);
        buf.writeUInt16BE(value, 0);
        this.buffers.push(buf);
        this.length += 2;
    }

    /**
     * Write a 32-bit unsigned integer (big-endian)
     */
    writeUint32(value) {
        const buf = Buffer.allocUnsafe(4);
        buf.writeUInt32BE(value, 0);
        this.buffers.push(buf);
        this.length += 4;
    }

    /**
     * Write a 16-bit signed integer (big-endian)
     */
    writeInt16(value) {
        const buf = Buffer.allocUnsafe(2);
        buf.writeInt16BE(value, 0);
        this.buffers.push(buf);
        this.length += 2;
    }

    /**
     * Write a 32-bit signed integer (big-endian)
     */
    writeInt32(value) {
        const buf = Buffer.allocUnsafe(4);
        buf.writeInt32BE(value, 0);
        this.buffers.push(buf);
        this.length += 4;
    }

    /**
     * Write a string (ASCII, no null terminator)
     */
    writeString(str) {
        const buf = Buffer.from(str, 'ascii');
        this.buffers.push(buf);
        this.length += buf.length;
    }

    /**
     * Write a Pascal string (length byte + string, padded to multiple of 4 bytes)
     * PSD uses Pascal strings for layer names, etc.
     * Layer names specifically must be padded to 4-byte boundary
     */
    writePascalString(str, padTo = 4) {
        const len = Math.min(str.length, 255);
        this.writeUint8(len);

        if (len > 0) {
            this.writeString(str.substring(0, len));
        }

        // Pad to specified boundary (including length byte)
        const totalLen = 1 + len;
        const remainder = totalLen % padTo;
        if (remainder !== 0) {
            const padding = padTo - remainder;
            for (let i = 0; i < padding; i++) {
                this.writeUint8(0);
            }
        }
    }

    /**
     * Write raw bytes from Buffer or Uint8Array
     */
    writeBytes(data) {
        // Accept Buffer by reference to avoid copying
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.buffers.push(buf);
        this.length += buf.length;
    }

    /**
     * Write padding bytes to align to specified boundary
     */
    writePadding(boundary) {
        const remainder = this.length % boundary;
        if (remainder !== 0) {
            const padding = boundary - remainder;
            for (let i = 0; i < padding; i++) {
                this.writeUint8(0);
            }
        }
    }

    /**
     * Get current write position
     */
    tell() {
        return this.length;
    }

    /**
     * Reserve space for a 32-bit value and return a function to update it later
     * This allows writing lengths after the data is written
     */
    reserveUint32() {
        const position = this.length;
        this.writeUint32(0);  // Placeholder
        return (value) => {
            // Find the buffer containing this position
            let offset = 0;
            for (const buf of this.buffers) {
                if (offset + buf.length > position) {
                    const bufOffset = position - offset;
                    buf.writeUInt32BE(value, bufOffset);
                    return;
                }
                offset += buf.length;
            }
        };
    }

    /**
     * Get final buffer
     */
    toBuffer() {
        return Buffer.concat(this.buffers, this.length);
    }
}

module.exports = BinaryWriter;
