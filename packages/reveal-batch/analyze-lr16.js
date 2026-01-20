const fs = require('fs');
const path = require('path');

// Analyze Lr16 section structure in detail
const combined2Path = path.join(__dirname, '../reveal-psd-writer/examples/combined2-test.psd');
const batchPath = path.join(__dirname, 'data/CQ100_v4/output/psd/astronaut.psd');

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

    // Read each layer record
    for (let layerIdx = 0; layerIdx < layerCount; layerIdx++) {
        console.log(`\n--- Layer ${layerIdx + 1} ---`);

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

        // Channel information (6 bytes per channel for 16-bit, or 6+4=10 bytes for 64-bit lengths)
        console.log(`Channels:`);
        for (let ch = 0; ch < channelCount; ch++) {
            const channelId = buffer.readInt16BE(pos);
            pos += 2;

            // Try to read as 32-bit first
            const length32 = buffer.readUInt32BE(pos);

            // Check if this looks like a 64-bit length (next 4 bytes would be the high part = 0)
            const maybeHigh32 = pos >= 4 ? buffer.readUInt32BE(pos - 4) : null;

            console.log(`  Channel ID ${channelId}: length32=0x${length32.toString(16)} (${length32})`);

            // For now, assume 32-bit lengths (current implementation)
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
        console.log(`Opacity: ${opacity}`);
        pos += 1;

        // Clipping (1 byte)
        const clipping = buffer.readUInt8(pos);
        pos += 1;

        // Flags (1 byte)
        const flags = buffer.readUInt8(pos);
        console.log(`Flags: 0x${flags.toString(16).padStart(2, '0')}`);
        pos += 1;

        // Filler (1 byte)
        pos += 1;

        // Extra data length (4 bytes)
        const extraLength = buffer.readUInt32BE(pos);
        console.log(`Extra data length: ${extraLength}`);
        pos += 4;

        // Skip extra data for now
        pos += extraLength;
    }
}

const combined2 = fs.readFileSync(combined2Path);
const batch = fs.readFileSync(batchPath);

analyzeLr16(combined2, 'combined2-test.psd (WORKING)');
analyzeLr16(batch, 'batch astronaut.psd (BROKEN)');
