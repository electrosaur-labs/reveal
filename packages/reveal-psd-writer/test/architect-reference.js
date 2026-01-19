/**
 * generate16bitLab.js
 * Generates a valid 16-bit Lab PSD with 2 Fill Layers + Intersecting Masks.
 * Architecturally compliant with Adobe "Lr16" Deep Depth specifications.
 *
 * PROVIDED BY ARCHITECT - Reference implementation for comparison
 */

const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const WIDTH = 400;
const HEIGHT = 400;
const FILENAME = path.join(__dirname, 'output', 'architect-16bit-intersect.psd');

// --- HELPERS ---
function writeString(buf, offset, str) {
    buf.write(str, offset);
    return offset + str.length;
}

function writeUint16(buf, offset, val) {
    buf.writeUInt16BE(val, offset);
    return offset + 2;
}

function writeInt16(buf, offset, val) {
    buf.writeInt16BE(val, offset);
    return offset + 2;
}

function writeUint32(buf, offset, val) {
    buf.writeUInt32BE(val, offset);
    return offset + 4;
}

// 64-bit Write (Big Endian) - Split into two 32-bit words
function writeUint64(buf, offset, val) {
    // JavaScript numbers are doubles (53-bit integer safety).
    // For file sizes < 4GB, the high 32 bits are 0.
    const high = Math.floor(val / 0xFFFFFFFF);
    const low = val % 0xFFFFFFFF; // Simple modulo for typical sizes

    buf.writeUInt32BE(0, offset); // High 32 bits (always 0 for this test)
    buf.writeUInt32BE(val, offset + 4); // Low 32 bits
    return offset + 8;
}

// --- 1. GENERATE DATA ---

// Create two 8-bit masks (Intersecting Circles)
const maskSize = WIDTH * HEIGHT;
const maskRed = Buffer.alloc(maskSize);
const maskBlue = Buffer.alloc(maskSize);

for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
        const idx = y * WIDTH + x;

        // Red Circle (Left)
        const dx1 = x - 150;
        const dy1 = y - 200;
        const dist1 = Math.sqrt(dx1*dx1 + dy1*dy1);
        if (dist1 < 100) maskRed[idx] = 255;

        // Blue Circle (Right)
        const dx2 = x - 250;
        const dy2 = y - 200;
        const dist2 = Math.sqrt(dx2*dx2 + dy2*dy2);
        if (dist2 < 100) maskBlue[idx] = 255;
    }
}

// Helper to create a 16-bit solid color channel buffer (Raw Compression)
function createSolidChannel(val16bit) {
    // 2 byte compression (0) + Data
    const buf = Buffer.alloc(2 + (WIDTH * HEIGHT * 2));
    writeUint16(buf, 0, 0); // Raw
    for(let i=0; i < WIDTH*HEIGHT; i++) {
        buf.writeUInt16BE(val16bit, 2 + (i*2));
    }
    return buf;
}

// Helper to create Mask channel (8-bit)
function createMaskChannel(maskBytes) {
    // 2 byte compression (0) + Data
    const buf = Buffer.alloc(2 + (WIDTH * HEIGHT));
    writeUint16(buf, 0, 0); // Raw
    for(let i=0; i < WIDTH*HEIGHT; i++) {
        buf.writeUInt8(maskBytes[i], 2 + i);
    }
    return buf;
}

// Prepare Data
// Red in Lab 16bit: L=53 (17367), a=80 (26624), b=67 (24960) approx
const layer1_L = createSolidChannel(17367);
const layer1_a = createSolidChannel(26624);
const layer1_b = createSolidChannel(24960);
const layer1_mask = createMaskChannel(maskRed);

// Blue in Lab 16bit: L=32 (10485), a=79 (26496), b=-107 (2688) approx
const layer2_L = createSolidChannel(10485);
const layer2_a = createSolidChannel(26496);
const layer2_b = createSolidChannel(2688);
const layer2_mask = createMaskChannel(maskBlue);

// Build Layer Record
function buildLayerRecord(name, channels, maskBuf) {
    // channels is array of {id: int, data: buffer}

    // Header
    const head = Buffer.alloc(16 + 2);
    let o = 0;
    writeUint32(head, 0, 0);      // Top
    writeUint32(head, 4, 0);      // Left
    writeUint32(head, 8, HEIGHT); // Bottom
    writeUint32(head, 12, WIDTH); // Right
    writeUint16(head, 16, channels.length); // Count

    // Channel Info (The 64-bit Fix!)
    const chanInfo = Buffer.alloc(channels.length * 10); // 2 + 8 bytes
    let cOff = 0;
    channels.forEach(ch => {
        writeInt16(chanInfo, cOff, ch.id);  // Use writeInt16 for channel ID (can be negative)
        writeUint64(chanInfo, cOff+2, ch.data.length); // 64-bit Length
        cOff += 10;
    });

    // Blend Mode
    const blend = Buffer.alloc(12);
    writeString(blend, 0, '8BIM');
    writeString(blend, 4, 'norm'); // Normal
    blend[8] = 255; // Opacity
    blend[9] = 0;   // Clipping
    blend[10] = 0;  // Flags
    blend[11] = 0;  // Filler

    // Extra Data (Mask info + Name)
    // Name (Pascal string padded to 4)
    const nameBuf = Buffer.alloc(name.length + 1 + 3); // Padding safety
    nameBuf.writeUInt8(name.length, 0);
    nameBuf.write(name, 1);
    // Pad name to 4 bytes
    let nameLen = 1 + name.length;
    while(nameLen % 4 !== 0) nameLen++;

    const extraLen = 4 + nameLen; // 4 bytes for Mask Data Length (0) + Name
    const extra = Buffer.alloc(4 + nameLen);
    writeUint32(extra, 0, 0); // No Layer Mask Info block (different from Channel Mask)
    extra.set(nameBuf.slice(0, nameLen), 4);

    return {
        record: Buffer.concat([head, chanInfo, blend, extra]),
        pixelData: channels.map(c => c.data)
    };
}

// Assemble Records
const recBlue = buildLayerRecord('Blue Circle', [
    {id: 0, data: layer2_L},
    {id: 1, data: layer2_a},
    {id: 2, data: layer2_b},
    {id: -2, data: layer2_mask} // Mask ID is -2
], layer2_mask);

const recRed = buildLayerRecord('Red Circle', [
    {id: 0, data: layer1_L},
    {id: 1, data: layer1_a},
    {id: 2, data: layer1_b},
    {id: -2, data: layer1_mask}
], layer1_mask);

// --- 3. CONSTRUCT THE FILE ---

const parts = [];

// A. HEADER (26 Bytes)
const header = Buffer.alloc(26);
writeString(header, 0, '8BPS');
writeUint16(header, 4, 1);       // Version 1
// Reserved 6 bytes are 0
writeUint16(header, 12, 3);      // Channels (L, a, b)
writeUint32(header, 14, HEIGHT);
writeUint32(header, 18, WIDTH);
writeUint16(header, 22, 16);     // Depth 16 (The key!)
writeUint16(header, 24, 9);      // Mode Lab
parts.push(header);

// B. COLOR MODE (4 Bytes)
parts.push(Buffer.from([0,0,0,0]));

// C. IMAGE RESOURCES (Variable)
const resBlock = Buffer.alloc(28);
let r = 0;
r = writeString(resBlock, r, '8BIM');
r = writeUint16(resBlock, r, 1005); // Resolution Info
r = writeUint16(resBlock, r, 0);    // Name length
r = writeUint32(resBlock, r, 16);   // Length
// 72 DPI fixed point (0x00480000)
writeUint32(resBlock, 12, 0x00480000); // H Res
writeUint16(resBlock, 16, 1);          // H Unit
writeUint16(resBlock, 18, 1);          // Width Unit
writeUint32(resBlock, 20, 0x00480000); // V Res
writeUint16(resBlock, 24, 1);          // V Unit
writeUint16(resBlock, 26, 1);          // Height Unit
parts.push(resBlock);

// D. LAYER AND MASK INFO

// Build The Lr16 Block Content
const layerCountBuf = Buffer.alloc(2);
writeUint16(layerCountBuf, 0, 2);

const recordsOrdered = Buffer.concat([recRed.record, recBlue.record]);

const allPixelData = Buffer.concat([
    ...recRed.pixelData,
    ...recBlue.pixelData
]);

const lr16Content = Buffer.concat([
    layerCountBuf,
    recordsOrdered,
    allPixelData
]);

// Wrap in "8BIM" "Lr16"
const lr16Header = Buffer.alloc(12 + 8); // Sig(4) + Key(4) + Len(8)
let lh = 0;
lh = writeString(lr16Header, lh, '8BIM');
lh = writeString(lr16Header, lh, 'Lr16');
lh = writeUint64(lr16Header, lh, lr16Content.length);

const fullLr16 = Buffer.concat([lr16Header, lr16Content]);

// Wrap in Section Length
const layerSectionLen = Buffer.alloc(4);
writeUint32(layerSectionLen, 0, fullLr16.length);

parts.push(layerSectionLen);
parts.push(fullLr16);

// E. MERGED IMAGE DATA (Planar 16-bit Lab)
const mergedChanSize = 2 + (WIDTH * HEIGHT * 2);
const mergedL = Buffer.alloc(mergedChanSize);
const mergedA = Buffer.alloc(mergedChanSize);
const mergedB = Buffer.alloc(mergedChanSize);

writeUint16(mergedL, 0, 0); // Raw
writeUint16(mergedA, 0, 0);
writeUint16(mergedB, 0, 0);

for(let i=0; i<WIDTH*HEIGHT; i++) {
    mergedL.writeUInt16BE(0x4000, 2 + i*2);
    mergedA.writeUInt16BE(0x4000, 2 + i*2);
    mergedB.writeUInt16BE(0x4000, 2 + i*2);
}

parts.push(mergedL);
parts.push(mergedA);
parts.push(mergedB);

// --- WRITE FILE ---
const finalBuffer = Buffer.concat(parts);

// Ensure output directory exists
const outputDir = path.dirname(FILENAME);
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(FILENAME, finalBuffer);

console.log(`✅ Success! Wrote ${FILENAME} (${finalBuffer.length} bytes)`);
console.log(`   - Header: 16-bit Lab`);
console.log(`   - Layers: 2 (Red, Blue)`);
console.log(`   - Masks:  Intersecting Circles`);
console.log(`   - Format: Lr16 deep structure`);
console.log(`   - Channel lengths: 64-bit (8 bytes)`);
