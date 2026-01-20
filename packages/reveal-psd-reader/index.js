/**
 * Minimal PSD Reader for Lab Color Mode
 *
 * Reads Lab PSDs and extracts the first pixel layer's image data.
 * Supports 16-bit PSDs with Lr16 layer format.
 */

/**
 * Read a Lab PSD file and extract the first pixel layer's image data
 * @param {Buffer} buffer - PSD file buffer
 * @returns {Object} - { width, height, colorMode, depth, channels, data: Uint8Array }
 */
function readPsd(buffer) {
    let offset = 0;

    // Helper functions
    const readUInt16BE = () => { const v = buffer.readUInt16BE(offset); offset += 2; return v; };
    const readInt16BE = () => { const v = buffer.readInt16BE(offset); offset += 2; return v; };
    const readUInt32BE = () => { const v = buffer.readUInt32BE(offset); offset += 4; return v; };
    const readInt32BE = () => { const v = buffer.readInt32BE(offset); offset += 4; return v; };
    const readBytes = (count) => { const bytes = buffer.slice(offset, offset + count); offset += count; return bytes; };
    const skip = (count) => { offset += count; };

    // ===== FILE HEADER (26 bytes) =====
    const signature = readBytes(4).toString('ascii');
    if (signature !== '8BPS') {
        throw new Error(`Invalid PSD signature: ${signature}`);
    }

    const version = readUInt16BE();
    if (version !== 1) {
        throw new Error(`Unsupported PSD version: ${version}`);
    }

    skip(6); // Reserved

    const headerChannels = readUInt16BE();
    const height = readUInt32BE();
    const width = readUInt32BE();
    const depth = readUInt16BE();
    const colorMode = readUInt16BE();

    if (colorMode !== 9) {
        throw new Error(`Only Lab color mode (9) supported, got: ${colorMode}`);
    }

    if (depth !== 8 && depth !== 16) {
        throw new Error(`Only 8-bit or 16-bit depth supported, got: ${depth}`);
    }

    // ===== COLOR MODE DATA SECTION =====
    const colorModeDataLength = readUInt32BE();
    skip(colorModeDataLength);

    // ===== IMAGE RESOURCES SECTION =====
    const imageResourcesLength = readUInt32BE();
    skip(imageResourcesLength);

    // ===== LAYER AND MASK INFORMATION SECTION =====
    const layerMaskLength = readUInt32BE();
    const layerSectionStart = offset;
    const layerSectionEnd = offset + layerMaskLength;

    let layerPixelData = null;
    let layerWidth = width;
    let layerHeight = height;

    if (layerMaskLength > 0) {
        // For 16-bit PSDs, look for Lr16 block
        // For 8-bit PSDs, read standard layer info

        // First, check for standard layer info
        const standardLayerInfoLen = readUInt32BE();

        if (standardLayerInfoLen === 0 && depth === 16) {
            // 16-bit PSD: search for Lr16 block in additional layer info
            while (offset < layerSectionEnd - 12) {
                const sig = buffer.slice(offset, offset + 4).toString('ascii');
                if (sig !== '8BIM' && sig !== '8B64') {
                    offset++;
                    continue;
                }

                const key = buffer.slice(offset + 4, offset + 8).toString('ascii');
                offset += 8;
                const blockLen = readUInt32BE();

                if (key === 'Lr16') {
                    // Parse Lr16 layer info
                    layerPixelData = parseLayers(buffer, offset, depth, width, height);
                    break;
                } else {
                    // Skip this block (pad to even)
                    offset += blockLen;
                    if (blockLen % 2) offset++;
                }
            }
        } else if (standardLayerInfoLen > 0) {
            // Standard layer info present
            layerPixelData = parseLayers(buffer, offset, depth, width, height);
        }
    }

    // Skip to end of layer section
    offset = layerSectionEnd;

    // If we got layer data, use it; otherwise read composite
    let channelData;
    const pixelCount = width * height;

    if (layerPixelData && layerPixelData[0] && layerPixelData[1] && layerPixelData[2]) {
        channelData = [layerPixelData[0], layerPixelData[1], layerPixelData[2]];
    } else {
        // Fall back to composite image data
        channelData = readComposite(buffer, offset, width, height, depth, headerChannels);
    }

    // Convert planar Lab data to interleaved format
    const data = new Uint8Array(pixelCount * 3);

    if (depth === 8) {
        for (let i = 0; i < pixelCount; i++) {
            data[i * 3 + 0] = channelData[0][i];
            data[i * 3 + 1] = channelData[1][i];
            data[i * 3 + 2] = channelData[2][i];
        }
    } else {
        // 16-bit: take high byte only
        for (let i = 0; i < pixelCount; i++) {
            data[i * 3 + 0] = channelData[0][i * 2];
            data[i * 3 + 1] = channelData[1][i * 2];
            data[i * 3 + 2] = channelData[2][i * 2];
        }
    }

    return { width, height, colorMode, depth, channels: 3, data };
}

/**
 * Parse layer records and extract first pixel layer's data
 */
function parseLayers(buffer, startOffset, depth, docWidth, docHeight) {
    let offset = startOffset;

    const readInt16BE = () => { const v = buffer.readInt16BE(offset); offset += 2; return v; };
    const readUInt16BE = () => { const v = buffer.readUInt16BE(offset); offset += 2; return v; };
    const readInt32BE = () => { const v = buffer.readInt32BE(offset); offset += 4; return v; };
    const readUInt32BE = () => { const v = buffer.readUInt32BE(offset); offset += 4; return v; };

    const layerCount = readInt16BE();
    const absLayerCount = Math.abs(layerCount);

    if (absLayerCount === 0) return null;

    // Read all layer records to find the first pixel layer
    const layerRecords = [];

    for (let i = 0; i < absLayerCount; i++) {
        const top = readInt32BE();
        const left = readInt32BE();
        const bottom = readInt32BE();
        const right = readInt32BE();

        const layerWidth = right - left;
        const layerHeight = bottom - top;

        const numChannels = readUInt16BE();

        const channelInfo = [];
        for (let j = 0; j < numChannels; j++) {
            const channelID = readInt16BE();
            const dataLen = readUInt32BE();
            channelInfo.push({ channelID, dataLen });
        }

        // Skip blend mode signature (4) + blend mode (4) + opacity (1) + clipping (1) + flags (1) + filler (1)
        offset += 12;

        // Extra data
        const extraLen = readUInt32BE();
        offset += extraLen;

        layerRecords.push({
            width: layerWidth,
            height: layerHeight,
            channelInfo,
            isPixelLayer: layerWidth > 0 && layerHeight > 0
        });
    }

    // Now read channel data for all layers
    // Find the first pixel layer
    let targetLayerIdx = -1;
    for (let i = 0; i < layerRecords.length; i++) {
        if (layerRecords[i].isPixelLayer) {
            targetLayerIdx = i;
            break;
        }
    }

    if (targetLayerIdx < 0) return null;

    // Skip channel data for layers before our target
    for (let i = 0; i < targetLayerIdx; i++) {
        for (const ch of layerRecords[i].channelInfo) {
            offset += ch.dataLen;
        }
    }

    // Read target layer's channel data
    const targetLayer = layerRecords[targetLayerIdx];
    const layerPixelData = {};
    const bytesPerPixel = depth === 16 ? 2 : 1;
    const expectedSize = targetLayer.width * targetLayer.height * bytesPerPixel;

    for (const { channelID, dataLen } of targetLayer.channelInfo) {
        // Only read Lab channels (0=L, 1=a, 2=b), skip alpha (-1) and mask (-2)
        if (channelID >= 0 && channelID <= 2) {
            const compression = readUInt16BE();
            const dataAfterCompression = dataLen - 2;

            let channelBytes;
            if (compression === 0) {
                // Raw data
                channelBytes = buffer.slice(offset, offset + dataAfterCompression);
                offset += dataAfterCompression;
            } else if (compression === 1) {
                // RLE decompression
                channelBytes = decompressRLE(buffer, offset, targetLayer.height, expectedSize);
                offset += dataAfterCompression;
            } else {
                throw new Error(`Unsupported compression: ${compression}`);
            }

            layerPixelData[channelID] = channelBytes;
        } else {
            // Skip non-Lab channels
            offset += dataLen;
        }
    }

    return layerPixelData;
}

/**
 * Decompress RLE (PackBits) data
 */
function decompressRLE(buffer, startOffset, numRows, expectedSize) {
    let offset = startOffset;

    // Read row byte counts
    const rowByteCounts = [];
    for (let row = 0; row < numRows; row++) {
        rowByteCounts.push(buffer.readUInt16BE(offset));
        offset += 2;
    }

    // Decompress
    const result = Buffer.alloc(expectedSize);
    let writePos = 0;

    for (let row = 0; row < numRows; row++) {
        const rowEnd = offset + rowByteCounts[row];

        while (offset < rowEnd && writePos < expectedSize) {
            const header = buffer.readInt8(offset++);

            if (header >= 0) {
                const count = header + 1;
                buffer.copy(result, writePos, offset, offset + count);
                offset += count;
                writePos += count;
            } else if (header !== -128) {
                const count = 1 - header;
                const value = buffer[offset++];
                result.fill(value, writePos, writePos + count);
                writePos += count;
            }
        }
    }

    return result;
}

/**
 * Read composite image data (fallback)
 */
function readComposite(buffer, startOffset, width, height, depth, channels) {
    let offset = startOffset;

    const compression = buffer.readUInt16BE(offset);
    offset += 2;

    const channelData = [];
    const bytesPerChannel = width * height * (depth === 16 ? 2 : 1);

    for (let c = 0; c < Math.min(channels, 3); c++) {
        let channelBytes;

        if (compression === 0) {
            channelBytes = buffer.slice(offset, offset + bytesPerChannel);
            offset += bytesPerChannel;
        } else if (compression === 1) {
            // RLE - read scanline byte counts for ALL channels first
            // Then decompress channel by channel
            const rowCountsStart = offset;
            const totalRows = height * channels;

            // Skip to this channel's data
            let dataOffset = rowCountsStart + (totalRows * 2);

            // Sum up sizes of previous channels
            for (let prevC = 0; prevC < c; prevC++) {
                for (let row = 0; row < height; row++) {
                    dataOffset += buffer.readUInt16BE(rowCountsStart + (prevC * height + row) * 2);
                }
            }

            channelBytes = decompressRLEComposite(buffer, rowCountsStart + c * height * 2, dataOffset, height, bytesPerChannel);
        }

        channelData.push(channelBytes);
    }

    return channelData;
}

/**
 * Decompress RLE for composite section
 */
function decompressRLEComposite(buffer, rowCountOffset, dataOffset, numRows, expectedSize) {
    let offset = dataOffset;

    const result = Buffer.alloc(expectedSize);
    let writePos = 0;

    for (let row = 0; row < numRows; row++) {
        const rowByteCount = buffer.readUInt16BE(rowCountOffset + row * 2);
        const rowEnd = offset + rowByteCount;

        while (offset < rowEnd && writePos < expectedSize) {
            const header = buffer.readInt8(offset++);

            if (header >= 0) {
                const count = header + 1;
                buffer.copy(result, writePos, offset, offset + count);
                offset += count;
                writePos += count;
            } else if (header !== -128) {
                const count = 1 - header;
                const value = buffer[offset++];
                result.fill(value, writePos, writePos + count);
                writePos += count;
            }
        }
    }

    return result;
}

module.exports = { readPsd };
