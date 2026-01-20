const fs = require('fs');
const path = require('path');

// Compare two PSD files to find differences
const combined2Path = path.join(__dirname, '../reveal-psd-writer/examples/combined2-test.psd');
const batchPath = path.join(__dirname, 'data/CQ100_v4/output/psd/astronaut.psd');

const combined2 = fs.readFileSync(combined2Path);
const batch = fs.readFileSync(batchPath);

console.log('File sizes:');
console.log(`  combined2-test.psd: ${combined2.length.toLocaleString()} bytes`);
console.log(`  batch astronaut.psd: ${batch.length.toLocaleString()} bytes`);

// Find Lr16 section in both files
function findLr16(buffer) {
    const lr16 = Buffer.from('Lr16');
    for (let i = 0; i < buffer.length - 4; i++) {
        if (buffer[i] === lr16[0] &&
            buffer[i+1] === lr16[1] &&
            buffer[i+2] === lr16[2] &&
            buffer[i+3] === lr16[3]) {
            return i;
        }
    }
    return -1;
}

const lr16Pos1 = findLr16(combined2);
const lr16Pos2 = findLr16(batch);

console.log(`\nLr16 positions:`);
console.log(`  combined2: ${lr16Pos1}`);
console.log(`  batch:     ${lr16Pos2}`);

// Read layer count from both
function readLayerCount(buffer, lr16Pos) {
    // Skip "8BIMLr16" (8 bytes) + length (4 bytes) = 12 bytes
    const layerCountPos = lr16Pos + 12;
    const layerCount = buffer.readInt16BE(layerCountPos);
    return Math.abs(layerCount); // Negative means transparency
}

const layers1 = readLayerCount(combined2, lr16Pos1);
const layers2 = readLayerCount(batch, lr16Pos2);

console.log(`\nLayer counts:`);
console.log(`  combined2: ${layers1} layers`);
console.log(`  batch:     ${layers2} layers`);

// Compare first 200 bytes of Lr16 section
console.log(`\nFirst 100 bytes of Lr16 data (after "Lr16"):`);
console.log('combined2:');
console.log(combined2.slice(lr16Pos1, lr16Pos1 + 100).toString('hex').match(/.{1,32}/g).join('\n'));
console.log('\nbatch:');
console.log(batch.slice(lr16Pos2, lr16Pos2 + 100).toString('hex').match(/.{1,32}/g).join('\n'));

// Check if they differ
const lr16Section1 = combined2.slice(lr16Pos1, lr16Pos1 + 200);
const lr16Section2 = batch.slice(lr16Pos2, lr16Pos2 + 200);

if (lr16Section1.equals(lr16Section2)) {
    console.log('\n✓ Lr16 sections are IDENTICAL');
} else {
    console.log('\n✗ Lr16 sections DIFFER');

    // Find first difference
    for (let i = 0; i < Math.min(lr16Section1.length, lr16Section2.length); i++) {
        if (lr16Section1[i] !== lr16Section2[i]) {
            console.log(`  First difference at byte ${i}:`);
            console.log(`    combined2: 0x${lr16Section1[i].toString(16).padStart(2, '0')}`);
            console.log(`    batch:     0x${lr16Section2[i].toString(16).padStart(2, '0')}`);
            break;
        }
    }
}
