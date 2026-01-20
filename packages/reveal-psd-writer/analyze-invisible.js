const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'examples/test-invisible-layer.psd');
const buffer = fs.readFileSync(filePath);

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

let pos = lr16Pos + 4 + 4 + 2;  // Skip "Lr16" + length + layer count

// Skip rectangle and channel count
pos += 16 + 2;

// Skip channel info (4 channels * 6 bytes)
pos += 4 * 6;

// Skip blend mode sig + key
pos += 8;

// Read opacity
const opacity = buffer.readUInt8(pos);
console.log(`Opacity: ${opacity} (should be 255)`);
pos += 1;

pos += 1; // clipping

// Read flags
const flags = buffer.readUInt8(pos);
console.log(`Flags: 0x${flags.toString(16).padStart(2, '0')}`);
console.log(`  Bit 1 (hidden): ${(flags & 0x02) ? 'SET (hidden)' : 'CLEAR (visible)'}`);
console.log(`  Bits 3-4 (pixel data irrelevant): ${(flags & 0x18) ? 'SET (fill layer)' : 'CLEAR (pixel layer)'}`);

console.log(`\n${(flags & 0x02) !== 0 && opacity === 255 ? '✓ CORRECT' : '✗ WRONG'}: Layer should be HIDDEN (eye off) but OPAQUE (255)`);
