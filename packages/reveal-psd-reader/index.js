/**
 * Minimal PSD Reader for Lab Color Mode
 *
 * Reads single-layer (flattened) Lab PSDs to extract composite image data.
 * Does NOT support layers, RGB, CMYK, or other advanced features.
 */

/**
 * Read a Lab PSD file and extract composite image data
 * @param {Buffer} buffer - PSD file buffer
 * @returns {Object} - { width, height, colorMode, depth, data: Uint8Array }
 */
function readPsd(buffer) {
    let offset = 0;

    // Helper to read big-endian values
    const readUInt16BE = () => {
        const val = buffer.readUInt16BE(offset);
        offset += 2;
        return val;
    };

    const readUInt32BE = () => {
        const val = buffer.readUInt32BE(offset);
        offset += 4;
        return val;
    };

    const readBytes = (count) => {
        const bytes = buffer.slice(offset, offset + count);
        offset += count;
        return bytes;
    };

    const skip = (count) => {
        offset += count;
    };

    // ===== FILE HEADER (26 bytes) =====
    const signature = readBytes(4).toString('ascii'); // "8BPS"
    if (signature !== '8BPS') {
        throw new Error(`Invalid PSD signature: ${signature}`);
    }

    const version = readUInt16BE(); // Always 1
    if (version !== 1) {
        throw new Error(`Unsupported PSD version: ${version}`);
    }

    skip(6); // Reserved (must be zero)

    const channels = readUInt16BE(); // Number of channels (3 for Lab)
    const height = readUInt32BE();
    const width = readUInt32BE();
    const depth = readUInt16BE(); // Bits per channel (8 or 16)
    const colorMode = readUInt16BE(); // 9 = Lab

    if (colorMode !== 9) {
        throw new Error(`Only Lab color mode (9) supported, got: ${colorMode}`);
    }

    if (channels !== 3 && channels !== 4) {
        throw new Error(`Expected 3 or 4 channels for Lab, got: ${channels}`);
    }

    const hasAlpha = channels === 4;

    if (depth !== 8 && depth !== 16) {
        throw new Error(`Only 8-bit or 16-bit depth supported, got: ${depth}`);
    }

    // ===== COLOR MODE DATA SECTION =====
    const colorModeDataLength = readUInt32BE();
    skip(colorModeDataLength); // Skip color mode data (empty for Lab)

    // ===== IMAGE RESOURCES SECTION =====
    const imageResourcesLength = readUInt32BE();
    skip(imageResourcesLength); // Skip image resources

    // ===== LAYER AND MASK INFORMATION SECTION =====
    const layerMaskLength = readUInt32BE();
    skip(layerMaskLength); // Skip layer info (we only read composite)

    // ===== IMAGE DATA SECTION =====
    const compression = readUInt16BE(); // 0 = Raw, 1 = RLE

    // Read channel data
    const channelData = [];
    const bytesPerChannel = width * height * (depth === 16 ? 2 : 1);

    for (let c = 0; c < channels; c++) {
        let channelBytes;

        if (compression === 0) {
            // Raw data
            channelBytes = readBytes(bytesPerChannel);
        } else if (compression === 1) {
            // RLE (PackBits) - read scanline byte counts first
            const scanlineByteCounts = [];
            for (let row = 0; row < height; row++) {
                scanlineByteCounts.push(readUInt16BE());
            }

            // Decompress RLE data
            const decompressed = Buffer.alloc(bytesPerChannel);
            let writePos = 0;

            for (let row = 0; row < height; row++) {
                const rowStart = offset;
                const rowEnd = offset + scanlineByteCounts[row];

                while (offset < rowEnd) {
                    const header = buffer.readInt8(offset++);

                    if (header >= 0) {
                        // Literal run: copy next (header + 1) bytes
                        const count = header + 1;
                        buffer.copy(decompressed, writePos, offset, offset + count);
                        offset += count;
                        writePos += count;
                    } else if (header !== -128) {
                        // RLE run: repeat next byte (1 - header) times
                        const count = 1 - header;
                        const value = buffer[offset++];
                        decompressed.fill(value, writePos, writePos + count);
                        writePos += count;
                    }
                    // header === -128 is a no-op
                }
            }

            channelBytes = decompressed;
        } else {
            throw new Error(`Unsupported compression: ${compression}`);
        }

        channelData.push(channelBytes);
    }

    // Convert planar data to interleaved Lab
    const pixelCount = width * height;
    const data = new Uint8Array(pixelCount * 3);

    if (depth === 8) {
        // 8-bit: direct copy
        for (let i = 0; i < pixelCount; i++) {
            data[i * 3 + 0] = channelData[0][i]; // L
            data[i * 3 + 1] = channelData[1][i]; // a
            data[i * 3 + 2] = channelData[2][i]; // b
        }
    } else {
        // 16-bit: convert to 8-bit by taking high byte
        for (let i = 0; i < pixelCount; i++) {
            data[i * 3 + 0] = channelData[0][i * 2]; // L (high byte)
            data[i * 3 + 1] = channelData[1][i * 2]; // a (high byte)
            data[i * 3 + 2] = channelData[2][i * 2]; // b (high byte)
        }
    }

    return {
        width,
        height,
        colorMode,
        depth,
        channels,
        data
    };
}

module.exports = { readPsd };
