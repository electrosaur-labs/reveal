/**
 * psd-inspector.js — Ground-Truth PSD Parser for Pre-Flight Separation Verification
 *
 * Extracts document geometry, DPI, embedded Manifest v2.1 XMP, and individual
 * plate layer masks directly from the binary PSD file. Zero external dependencies.
 */

'use strict';

/**
 * Parse ResolutionInfo (Resource ID 1005 / 0x03ED)
 */
function parseResolutionInfo(buffer, start, length) {
    const end = start + length;
    let offset = start;

    while (offset < end - 10) {
        const sig = buffer.toString('ascii', offset, offset + 4);
        if (sig !== '8BIM') break;

        const resourceId = buffer.readUInt16BE(offset + 4);
        offset += 6;

        const nameLen = buffer.readUInt8(offset);
        let nameBlock = 1 + nameLen;
        if (nameBlock % 2 !== 0) nameBlock++;
        offset += nameBlock;

        const dataSize = buffer.readUInt32BE(offset);
        offset += 4;

        if (resourceId === 1005 && dataSize >= 6) {
            const hResFixed = buffer.readInt32BE(offset);
            const hResUnit = buffer.readUInt16BE(offset + 4);
            let dpi = hResFixed / 65536;
            if (hResUnit === 2) dpi *= 2.54;
            return dpi > 0 ? Math.round(dpi) : null;
        }

        offset += dataSize;
        if (dataSize % 2 !== 0) offset++;
    }

    return null;
}

/**
 * Parse XMP Metadata (Resource ID 1060 / 0x0424)
 */
function parseXmpMetadata(buffer, start, length) {
    const end = start + length;
    let offset = start;

    while (offset < end - 10) {
        const sig = buffer.toString('ascii', offset, offset + 4);
        if (sig !== '8BIM') break;

        const resourceId = buffer.readUInt16BE(offset + 4);
        offset += 6;

        const nameLen = buffer.readUInt8(offset);
        let nameBlock = 1 + nameLen;
        if (nameBlock % 2 !== 0) nameBlock++;
        offset += nameBlock;

        const dataSize = buffer.readUInt32BE(offset);
        offset += 4;

        if (resourceId === 1060 && dataSize > 0) {
            return buffer.toString('utf8', offset, offset + dataSize);
        }

        offset += dataSize;
        if (dataSize % 2 !== 0) offset++;
    }

    return null;
}

/**
 * Extract Reveal Manifest v2.1 fields from raw XMP string
 */
function parseRevealManifest(xmpString) {
    if (!xmpString || !xmpString.includes('reveal:')) {
        return null;
    }

    const getTag = (name) => {
        const regex = new RegExp(`<reveal:${name}>([\\s\\S]*?)<\\/reveal:${name}>`, 'i');
        const match = xmpString.match(regex);
        return match ? match[1].trim() : null;
    };

    const getNum = (name, fallback = null) => {
        const val = getTag(name);
        if (val === null) return fallback;
        const n = parseFloat(val);
        return isNaN(n) ? fallback : n;
    };

    const manifestVersion = getTag('manifestVersion') || '1.0';
    const dpi = getNum('dpi', 300);
    const meshSize = getNum('meshSize', 0);
    const ruleOfN = getNum('ruleOfN', 7.0);
    const minDotPx = getNum('minDotPx', 0);
    const trapSize = getNum('trapSize', 0);
    const trapPx = getNum('trapPx', 0);
    const dualScale = getTag('dualScale') === 'true';
    const minVolume = getNum('minVolume', 0);
    const shadowClamp = getNum('shadowClamp', 0);
    const plateCount = getNum('plateCount', 0);
    const archetype = getTag('archetype');
    const generator = getTag('generator');

    // Parse palette items
    const palette = [];
    const seqMatch = xmpString.match(/<reveal:palette>[\s\S]*?<rdf:Seq>([\s\S]*?)<\/rdf:Seq>[\s\S]*?<\/reveal:palette>/i);
    if (seqMatch) {
        const itemRegex = /<rdf:li>([^<]+)<\/rdf:li>/gi;
        let itemMatch;
        while ((itemMatch = itemRegex.exec(seqMatch[1])) !== null) {
            const raw = itemMatch[1].trim();
            // Format: #HEX L=XX a=YY b=ZZ (or with coverage)
            const parts = raw.split(/\s+/);
            const hex = parts[0];
            let L = 0, a = 0, b = 0, coverage = '';
            for (let i = 1; i < parts.length; i++) {
                if (parts[i].startsWith('L=')) L = parseFloat(parts[i].slice(2));
                else if (parts[i].startsWith('a=')) a = parseFloat(parts[i].slice(2));
                else if (parts[i].startsWith('b=')) b = parseFloat(parts[i].slice(2));
                else if (parts[i].endsWith('%')) coverage = parts[i];
            }
            palette.push({ hex, L, a, b, coverage, raw });
        }
    }

    return {
        manifestVersion,
        dpi,
        meshSize,
        ruleOfN,
        minDotPx,
        trapSize,
        trapPx,
        dualScale,
        minVolume,
        shadowClamp,
        plateCount: plateCount || palette.length,
        archetype,
        generator,
        palette
    };
}

/**
 * Decompress PackBits RLE scanlines
 */
function decompressPackBits(buffer, offset, rowByteCounts, rowWidth, is16Bit = false) {
    const bytesPerRow = is16Bit ? rowWidth * 2 : rowWidth;
    const totalBytes = bytesPerRow * rowByteCounts.length;
    const result = Buffer.alloc(totalBytes);
    let readPos = offset;
    let writePos = 0;

    for (let row = 0; row < rowByteCounts.length; row++) {
        const rowEnd = readPos + rowByteCounts[row];
        const rowTargetEnd = writePos + bytesPerRow;

        while (readPos < rowEnd && writePos < rowTargetEnd) {
            const header = buffer.readInt8(readPos++);
            if (header >= 0) {
                const count = header + 1;
                buffer.copy(result, writePos, readPos, readPos + count);
                readPos += count;
                writePos += count;
            } else if (header !== -128) {
                const count = 1 - header;
                const value = buffer[readPos++];
                result.fill(value, writePos, writePos + count);
                writePos += count;
            }
        }
        readPos = rowEnd;
    }

    return result;
}

/**
 * Parse full PSD file structure and extract separation plates
 *
 * @param {Buffer} buffer - Binary PSD buffer
 * @returns {Object} { width, height, dpi, manifest, plates: Array<{ name, color: {L,a,b}, mask: Uint8Array }> }
 */
function inspectPsd(buffer) {
    if (buffer.length < 26) {
        throw new Error('Buffer too small to be a valid PSD');
    }

    const signature = buffer.toString('ascii', 0, 4);
    if (signature !== '8BPS') {
        throw new Error(`Invalid PSD signature: ${signature}`);
    }

    const version = buffer.readUInt16BE(4);
    if (version !== 1) {
        throw new Error(`Unsupported PSD version: ${version}`);
    }

    const channels = buffer.readUInt16BE(12);
    const height = buffer.readUInt32BE(14);
    const width = buffer.readUInt32BE(18);
    const depth = buffer.readUInt16BE(22);
    const colorMode = buffer.readUInt16BE(24);

    let offset = 26;

    // Section 2: Color Mode Data
    const colorModeLen = buffer.readUInt32BE(offset);
    offset += 4 + colorModeLen;

    // Section 3: Image Resources
    const imgResLen = buffer.readUInt32BE(offset);
    offset += 4;
    const imgResStart = offset;

    const dpi = parseResolutionInfo(buffer, imgResStart, imgResLen);
    const xmpString = parseXmpMetadata(buffer, imgResStart, imgResLen);
    const manifest = parseRevealManifest(xmpString);

    offset = imgResStart + imgResLen;

    // Section 4: Layer and Mask Information
    if (offset >= buffer.length) {
        return { width, height, depth, colorMode, dpi, xmpString, manifest, plates: [] };
    }

    const layerAndMaskSectionLen = buffer.readUInt32BE(offset);
    offset += 4;
    const layerSectionEnd = offset + layerAndMaskSectionLen;

    const layerInfoLen = buffer.readUInt32BE(offset);
    offset += 4;
    const layerInfoStart = offset;

    let layerCount = 0;
    let layers = [];

    // If standard layerInfo length > 0, parse 8-bit layers
    if (layerInfoLen > 0) {
        layerCount = buffer.readInt16BE(offset);
        offset += 2;
        const actualCount = Math.abs(layerCount);

        for (let i = 0; i < actualCount; i++) {
            layers.push(parseLayerRecord(buffer, offset));
            offset = layers[layers.length - 1].nextOffset;
        }

        // Read channel data
        for (let i = 0; i < layers.length; i++) {
            offset = readLayerChannelImages(buffer, offset, layers[i], width, height, depth === 16);
        }
    } else {
        // Look for 16-bit layers in Lr16 tagged block
        offset = layerInfoStart + layerInfoLen;
        const globalMaskLen = buffer.readUInt32BE(offset);
        offset += 4 + globalMaskLen;

        while (offset < layerSectionEnd - 12) {
            const tagSig = buffer.toString('ascii', offset, offset + 4);
            if (tagSig !== '8BIM') break;
            const tagKey = buffer.toString('ascii', offset + 4, offset + 8);
            const tagLen = buffer.readUInt32BE(offset + 8);
            offset += 12;

            if (tagKey === 'Lr16' && tagLen > 2) {
                const lr16Start = offset;
                const lr16Count = buffer.readInt16BE(offset);
                offset += 2;
                const actualCount = Math.abs(lr16Count);

                for (let i = 0; i < actualCount; i++) {
                    layers.push(parseLayerRecord(buffer, offset));
                    offset = layers[layers.length - 1].nextOffset;
                }

                for (let i = 0; i < layers.length; i++) {
                    offset = readLayerChannelImages(buffer, offset, layers[i], width, height, true);
                }
                break;
            }

            offset += tagLen;
            if (tagLen % 2 !== 0) offset++;
        }
    }

    // Convert raw layers into plate definitions
    const plates = [];
    const totalPixels = width * height;

    for (let li = 0; li < layers.length; li++) {
        const lyr = layers[li];
        if (!lyr.maskChannel) continue;

        // Parse Lab color from layer name: e.g. "[1] #FFFFFF L100 a+0 b+0" or fallback to manifest
        let L = null, a = 0, b = 0;
        const labMatch = lyr.name.match(/L(-?\d+(?:\.\d+)?)\s+a([+-]?\d+(?:\.\d+)?)\s+b([+-]?\d+(?:\.\d+)?)/i);
        if (labMatch) {
            L = parseFloat(labMatch[1]);
            a = parseFloat(labMatch[2]);
            b = parseFloat(labMatch[3]);
        } else if (manifest && manifest.palette && manifest.palette[li]) {
            L = manifest.palette[li].L;
            a = manifest.palette[li].a;
            b = manifest.palette[li].b;
        }

        // Build full-size binary mask (1 for foreground, 0 for background)
        const binaryMask = new Uint8Array(totalPixels);
        const decomp = lyr.maskChannel.decompressedData;

        if (lyr.maskBounds && decomp) {
            const { top, left, bottom, right } = lyr.maskBounds;
            const maskW = right - left;
            const maskH = bottom - top;
            const bytesPerPixel = lyr.is16Bit ? 2 : 1;

            for (let y = 0; y < maskH; y++) {
                const docY = top + y;
                if (docY < 0 || docY >= height) continue;

                for (let x = 0; x < maskW; x++) {
                    const docX = left + x;
                    if (docX < 0 || docX >= width) continue;

                    const srcIdx = (y * maskW + x) * bytesPerPixel;
                    const val = decomp[srcIdx]; // high byte for 16-bit
                    if (val > 127) {
                        binaryMask[docY * width + docX] = 1;
                    }
                }
            }
        }

        plates.push({
            name: lyr.name,
            color: { L: L != null ? L : 50, a, b },
            mask: binaryMask
        });
    }

    return {
        width,
        height,
        depth,
        colorMode,
        dpi: dpi || (manifest ? manifest.dpi : 300),
        xmpString,
        manifest,
        plates
    };
}

/**
 * Parse a single layer record structure
 */
function parseLayerRecord(buffer, offset) {
    let p = offset;
    const top = buffer.readInt32BE(p); p += 4;
    const left = buffer.readInt32BE(p); p += 4;
    const bottom = buffer.readInt32BE(p); p += 4;
    const right = buffer.readInt32BE(p); p += 4;
    const channelCount = buffer.readUInt16BE(p); p += 2;

    const channels = [];
    for (let c = 0; c < channelCount; c++) {
        const channelID = buffer.readInt16BE(p); p += 2;
        const dataLength = buffer.readUInt32BE(p); p += 4;
        channels.push({ channelID, dataLength });
    }

    p += 4; // blend sig '8BIM'
    const blendModeKey = buffer.toString('ascii', p, p + 4); p += 4;
    const opacity = buffer.readUInt8(p++);
    const clipping = buffer.readUInt8(p++);
    const flags = buffer.readUInt8(p++);
    p++; // filler

    const extraLen = buffer.readUInt32BE(p); p += 4;
    const extraEnd = p + extraLen;

    // Layer mask data
    const maskDataLen = buffer.readUInt32BE(p); p += 4;
    let maskBounds = null;
    if (maskDataLen >= 16) {
        maskBounds = {
            top: buffer.readInt32BE(p),
            left: buffer.readInt32BE(p + 4),
            bottom: buffer.readInt32BE(p + 8),
            right: buffer.readInt32BE(p + 12)
        };
    }
    p += maskDataLen;

    // Blending ranges
    const blendRangesLen = buffer.readUInt32BE(p); p += 4;
    p += blendRangesLen;

    // Pascal string name (padded to 4 bytes)
    const nameLen = buffer.readUInt8(p++);
    const name = nameLen > 0 ? buffer.toString('ascii', p, p + nameLen) : '';
    p += nameLen;
    const namePad = (4 - ((1 + nameLen) % 4)) % 4;
    p += namePad;

    p = extraEnd;

    return {
        top, left, bottom, right,
        width: right - left,
        height: bottom - top,
        channels,
        blendModeKey,
        opacity,
        name,
        maskBounds,
        nextOffset: p
    };
}

/**
 * Read and decompress channel image data for a layer
 */
function readLayerChannelImages(buffer, offset, layer, docWidth, docHeight, is16Bit) {
    let p = offset;

    for (let c = 0; c < layer.channels.length; c++) {
        const ch = layer.channels[c];
        const compression = buffer.readUInt16BE(p); p += 2;
        const payloadLen = ch.dataLength - 2;

        let maskH = layer.height;
        let maskW = layer.width;

        if (ch.channelID === -2 && layer.maskBounds) {
            maskH = layer.maskBounds.bottom - layer.maskBounds.top;
            maskW = layer.maskBounds.right - layer.maskBounds.left;
        }

        if (compression === 1 && maskH > 0 && maskW > 0) {
            // RLE (PackBits)
            const rowByteCounts = [];
            for (let r = 0; r < maskH; r++) {
                rowByteCounts.push(buffer.readUInt16BE(p)); p += 2;
            }
            const compBytes = rowByteCounts.reduce((a, b) => a + b, 0);
            const decompressed = decompressPackBits(buffer, p, rowByteCounts, maskW, is16Bit);
            p += compBytes;

            if (ch.channelID === -2) {
                layer.maskChannel = {
                    channelID: ch.channelID,
                    decompressedData: decompressed
                };
                layer.is16Bit = is16Bit;
            }
        } else {
            p += payloadLen;
        }
    }

    return p;
}

module.exports = {
    inspectPsd,
    parseRevealManifest,
    parseResolutionInfo,
    parseXmpMetadata
};
