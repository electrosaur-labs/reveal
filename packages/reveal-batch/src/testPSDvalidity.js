/**
 * Test PSD file validity by checking basic structure
 */

const fs = require('fs');
const path = require('path');

const TEST_FILE = '/workspaces/electrosaur/reveal-project/packages/reveal-batch/data/CQ100_v4/output/psd/crepe_paper.psd';

function testPSDValidity() {
    console.log(`🔍 Testing PSD file validity: ${path.basename(TEST_FILE)}\n`);

    // Read the file
    const buffer = fs.readFileSync(TEST_FILE);
    console.log(`📦 File size: ${(buffer.length / 1024).toFixed(2)} KB\n`);

    let offset = 0;

    // Check signature (should be "8BPS")
    const signature = buffer.toString('ascii', offset, offset + 4);
    console.log(`Signature: "${signature}" ${signature === '8BPS' ? '✅' : '❌ INVALID!'}`);
    offset += 4;

    // Check version (should be 1 for PSD)
    const version = buffer.readUInt16BE(offset);
    console.log(`Version: ${version} ${version === 1 ? '✅' : '❌ INVALID!'}`);
    offset += 2;

    // Skip reserved (6 bytes)
    offset += 6;

    // Read channels
    const channels = buffer.readUInt16BE(offset);
    console.log(`Channels: ${channels} ${channels === 3 || channels === 4 || channels === 7 ? '✅' : '⚠️'}`);
    offset += 2;

    // Read dimensions
    const height = buffer.readUInt32BE(offset);
    offset += 4;
    const width = buffer.readUInt32BE(offset);
    offset += 4;
    console.log(`Dimensions: ${width}×${height} ✅`);

    // Read bit depth
    const depth = buffer.readUInt16BE(offset);
    console.log(`Bit Depth: ${depth} ${depth === 8 || depth === 16 ? '✅' : '❌ INVALID!'}`);
    offset += 2;

    // Read color mode
    const mode = buffer.readUInt16BE(offset);
    const modeNames = {
        0: 'Bitmap',
        1: 'Grayscale',
        2: 'Indexed',
        3: 'RGB',
        4: 'CMYK',
        7: 'Multichannel',
        8: 'Duotone',
        9: 'Lab'
    };
    console.log(`Color Mode: ${modeNames[mode] || `Unknown (${mode})`} ${mode === 9 ? '✅' : '❌ INVALID!'}`);
    offset += 2;

    console.log(`\n✅ File header is valid PSD structure`);

    // Check Color Mode Data section
    const colorModeLength = buffer.readUInt32BE(offset);
    console.log(`\nColor Mode Data Length: ${colorModeLength} bytes ${colorModeLength === 0 ? '✅ (correct for Lab)' : '⚠️'}`);
    offset += 4 + colorModeLength;

    // Check Image Resources section
    const imageResourcesLength = buffer.readUInt32BE(offset);
    console.log(`Image Resources Length: ${imageResourcesLength} bytes ${imageResourcesLength > 0 ? '✅' : '⚠️ (empty)'}`);
    offset += 4;

    // Parse image resources to find thumbnails
    const resourcesStart = offset;
    const resourcesEnd = offset + imageResourcesLength;
    let foundResolution = false;
    let foundThumbnail = false;
    let foundDisplayInfo = false;

    while (offset < resourcesEnd) {
        const resSig = buffer.toString('ascii', offset, offset + 4);
        offset += 4;

        const resId = buffer.readUInt16BE(offset);
        offset += 2;

        const nameLen = buffer.readUInt8(offset);
        offset += 1 + nameLen;

        // Pad to even
        if ((nameLen + 1) % 2 !== 0) offset++;

        const dataLen = buffer.readUInt32BE(offset);
        offset += 4;

        if (resId === 1005) {
            console.log(`  ✅ Found Resource 1005 (ResolutionInfo) - ${dataLen} bytes`);
            foundResolution = true;
        } else if (resId === 1036) {
            console.log(`  ✅ Found Resource 1036 (Thumbnail) - ${dataLen} bytes`);
            foundThumbnail = true;
        } else if (resId === 1077) {
            console.log(`  ✅ Found Resource 1077 (DisplayInfo) - ${dataLen} bytes`);
            foundDisplayInfo = true;
        }

        offset += dataLen;

        // Pad to even
        if (dataLen % 2 !== 0) offset++;
    }

    if (!foundResolution) console.log(`  ⚠️ Missing Resource 1005 (ResolutionInfo)`);
    if (!foundThumbnail) console.log(`  ⚠️ Missing Resource 1036 (Thumbnail)`);
    if (!foundDisplayInfo) console.log(`  ⚠️ Missing Resource 1077 (DisplayInfo)`);

    // Check Layer and Mask Info section
    const layerMaskLength = buffer.readUInt32BE(offset);
    console.log(`\nLayer and Mask Info Length: ${layerMaskLength} bytes ${layerMaskLength > 0 ? '✅' : '❌ INVALID (no layers)!'}`);
    offset += 4;

    if (layerMaskLength > 0) {
        // Check if this is 16-bit format (has Lr16 block)
        const layerInfoLength = buffer.readUInt32BE(offset);
        console.log(`  Layer Info Length: ${layerInfoLength} bytes`);

        if (layerInfoLength === 0) {
            console.log(`  📌 16-bit format detected (layer info = 0, expecting Lr16 block)`);
            offset += 4;

            // Skip global layer mask
            const globalLayerMaskLength = buffer.readUInt32BE(offset);
            console.log(`  Global Layer Mask Length: ${globalLayerMaskLength} bytes`);
            offset += 4 + globalLayerMaskLength;

            // Look for Mt16 and Lr16 blocks
            let foundMt16 = false;
            let foundLr16 = false;
            let foundLMsk = false;

            const layerMaskEnd = offset + layerMaskLength - 4 - 4 - globalLayerMaskLength;

            while (offset < layerMaskEnd) {
                const blockSig = buffer.toString('ascii', offset, offset + 4);
                offset += 4;
                const blockKey = buffer.toString('ascii', offset, offset + 4);
                offset += 4;
                const blockLen = buffer.readUInt32BE(offset);
                offset += 4;

                if (blockKey === 'Mt16') {
                    console.log(`  ✅ Found Mt16 block - ${blockLen} bytes`);
                    foundMt16 = true;
                } else if (blockKey === 'Lr16') {
                    console.log(`  ✅ Found Lr16 block - ${blockLen} bytes`);
                    foundLr16 = true;

                    // Peek into Lr16 to count layers
                    const lr16Start = offset;
                    const layerCount = Math.abs(buffer.readInt16BE(offset));
                    console.log(`    Layer count: ${layerCount}`);
                    offset = lr16Start;  // Reset to skip past Lr16 data
                } else if (blockKey === 'LMsk') {
                    console.log(`  ✅ Found LMsk block - ${blockLen} bytes`);
                    foundLMsk = true;
                }

                offset += blockLen;

                // Pad to 4-byte boundary
                const padding = (4 - (blockLen % 4)) % 4;
                offset += padding;
            }

            if (!foundMt16) console.log(`  ❌ Missing Mt16 block (required for 16-bit)`);
            if (!foundLr16) console.log(`  ❌ Missing Lr16 block (required for 16-bit)`);
            if (!foundLMsk) console.log(`  ⚠️ Missing LMsk block (may cause warnings)`);
        } else {
            console.log(`  📌 8-bit format detected (traditional layer info)`);
            offset += 4;
            const layerCount = Math.abs(buffer.readInt16BE(offset));
            console.log(`  Layer count: ${layerCount}`);
        }
    }

    console.log(`\n✅ Basic PSD structure appears valid`);
    console.log(`\nNext step: Try opening in Photoshop to see specific error`);
}

testPSDValidity();
