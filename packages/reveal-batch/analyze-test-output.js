const fs = require('fs');
const path = require('path');

// Analyze the test-output astronaut.psd
const testOutputPath = path.join(__dirname, 'test-output/astronaut.psd');

function analyzeLr16(buffer, label) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`${label}`);
    console.log('='.repeat(60));

    // Find Lr16
    const lr16 = Buffer.from('Lr16');
    let lr16Pos = -1;
    for (let i = 0; i < buffer.length - 4; i++) {
        if (buffer[i] === lr16[0] &&
            buffer[i+1] === lr16[1] &&
            buffer[i+2] === lr16[2] &&
            buffer[i+3] === lr16[3]) {
            lr16Pos = i;
            break;
        }
    }

    if (lr16Pos === -1) {
        console.log('No Lr16 section found!');
        return;
    }

    console.log(`Lr16 position: ${lr16Pos}`);

    let pos = lr16Pos + 4; // Skip "Lr16"

    // Read Lr16 length (4 bytes)
    const lr16Length = buffer.readUInt32BE(pos);
    console.log(`Lr16 length: ${lr16Length} (0x${lr16Length.toString(16)})`);
    pos += 4;

    // Read layer count (2 bytes, signed)
    const layerCountRaw = buffer.readInt16BE(pos);
    const layerCount = Math.abs(layerCountRaw);
    console.log(`Layer count: ${layerCount} (raw: ${layerCountRaw})`);
    pos += 2;

    // Read just the first layer
    console.log(`\n--- Layer 1 (Pixel Layer) ---`);

    // Rectangle (16 bytes)
    const top = buffer.readInt32BE(pos);
    const left = buffer.readInt32BE(pos + 4);
    const bottom = buffer.readInt32BE(pos + 8);
    const right = buffer.readInt32BE(pos + 12);
    console.log(`Rectangle: (${left},${top})-(${right},${bottom})`);
    pos += 16;

    // Channel count (2 bytes)
    const channelCount = buffer.readUInt16BE(pos);
    console.log(`Channel count: ${channelCount}`);
    pos += 2;

    // Channel information
    console.log(`Channels:`);
    for (let ch = 0; ch < channelCount; ch++) {
        const channelId = buffer.readInt16BE(pos);
        pos += 2;
        const length32 = buffer.readUInt32BE(pos);
        console.log(`  Channel ID ${channelId}: length=0x${length32.toString(16)} (${length32} bytes)`);
        pos += 4;
    }

    // Blend mode signature (4 bytes)
    const blendSig = buffer.toString('ascii', pos, pos + 4);
    pos += 4;

    // Blend mode key (4 bytes)
    const blendKey = buffer.toString('ascii', pos, pos + 4);
    console.log(`Blend mode: ${blendKey}`);
    pos += 4;

    // Opacity (1 byte)
    const opacity = buffer.readUInt8(pos);
    console.log(`Opacity: ${opacity} ${opacity === 0 ? '❌ TRANSPARENT!' : opacity === 255 ? '✓ OPAQUE' : '⚠️  PARTIAL'}`);
    pos += 1;

    // Clipping (1 byte)
    const clipping = buffer.readUInt8(pos);
    pos += 1;

    // Flags (1 byte)
    const flags = buffer.readUInt8(pos);
    const isHidden = (flags & 0x02) !== 0;  // bit 1 = hidden flag (inverted logic!)
    const pixelDataIrrelevant = (flags & 0x18) !== 0;  // bits 3 and 4
    const layerType = pixelDataIrrelevant ? 'FILL LAYER' : 'PIXEL LAYER';
    const visibility = isHidden ? '✗ HIDDEN' : '✓ VISIBLE';
    console.log(`Flags: 0x${flags.toString(16).padStart(2, '0')} (${layerType}, ${visibility})`);
}

const testBuffer = fs.readFileSync(testOutputPath);
analyzeLr16(testBuffer, 'test-output/astronaut.psd');
