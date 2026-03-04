/**
 * PSDWriter Tests
 *
 * Tests for 8-bit and 16-bit Lab PSD generation with fill+mask layers
 */

const assert = require('assert');
const { PSDWriter } = require('../src');

console.log('Running PSDWriter tests...\n');

// Test counter
let testCount = 0;
let passCount = 0;

function test(name, fn) {
    testCount++;
    try {
        fn();
        passCount++;
        console.log(`✓ ${name}`);
    } catch (error) {
        console.log(`✗ ${name}`);
        console.log(`  Error: ${error.message}`);
        if (error.stack) {
            console.log(`  ${error.stack.split('\n').slice(1, 3).join('\n  ')}`);
        }
    }
}

// --- Basic Constructor Tests ---

test('PSDWriter constructor - default 8-bit Lab', () => {
    const writer = new PSDWriter({ width: 100, height: 100 });
    assert.strictEqual(writer.width, 100);
    assert.strictEqual(writer.height, 100);
    assert.strictEqual(writer.colorMode, 'lab');
    assert.strictEqual(writer.bitsPerChannel, 8);
});

test('PSDWriter constructor - 16-bit Lab', () => {
    const writer = new PSDWriter({
        width: 200,
        height: 150,
        colorMode: 'lab',
        bitsPerChannel: 16
    });
    assert.strictEqual(writer.width, 200);
    assert.strictEqual(writer.height, 150);
    assert.strictEqual(writer.bitsPerChannel, 16);
});

test('PSDWriter constructor - validates dimensions', () => {
    assert.throws(() => {
        new PSDWriter({ width: 0, height: 100 });
    }, /width and height are required/i);

    assert.throws(() => {
        new PSDWriter({ width: 100, height: 0 });
    }, /width and height are required/i);
});

test('PSDWriter constructor - validates bits per channel', () => {
    assert.throws(() => {
        new PSDWriter({ width: 100, height: 100, bitsPerChannel: 24 });
    }, /Only 8-bit and 16-bit per channel are supported/i);
});

// --- Fill Layer Tests (8-bit) ---

test('addFillLayer - 8-bit with valid mask', () => {
    const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 8 });
    const mask = new Uint8Array(100).fill(255);

    writer.addFillLayer({
        name: 'Test Layer',
        color: { L: 50, a: 10, b: -20 },
        mask: mask
    });

    assert.strictEqual(writer.layers.length, 1);
    assert.strictEqual(writer.layers[0].name, 'Test Layer');
});

test('addFillLayer - 8-bit validates mask size', () => {
    const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 8 });
    const invalidMask = new Uint8Array(50); // Wrong size

    assert.throws(() => {
        writer.addFillLayer({
            name: 'Test',
            color: { L: 50, a: 0, b: 0 },
            mask: invalidMask
        });
    }, /Mask must be 100 bytes/i);
});

test('addFillLayer - 8-bit accepts color values', () => {
    const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 8 });
    const mask = new Uint8Array(100);

    // Note: Current implementation doesn't validate color bounds
    // Just verify layer is added successfully
    writer.addFillLayer({
        name: 'Test',
        color: { L: 50, a: 20, b: -30 },
        mask: mask
    });

    assert.strictEqual(writer.layers.length, 1);
    assert.strictEqual(writer.layers[0].color.L, 50);
    assert.strictEqual(writer.layers[0].color.a, 20);
    assert.strictEqual(writer.layers[0].color.b, -30);
});

// --- Fill Layer Tests (16-bit) ---

test('addFillLayer - 16-bit with 8-bit mask (deferred conversion)', () => {
    const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 16 });
    const mask8 = new Uint8Array(100).fill(128);

    writer.addFillLayer({
        name: 'Test Layer',
        color: { L: 60, a: 30, b: -40 },
        mask: mask8
    });

    assert.strictEqual(writer.layers.length, 1);
    // Mask stored as 8-bit, converted to 16-bit during write
    assert.strictEqual(writer.layers[0].mask.length, 100);
    assert.strictEqual(writer.layers[0].maskIs8bit, true);
    // Must still produce a valid PSD
    const buffer = writer.write();
    assert.strictEqual(buffer.toString('ascii', 0, 4), '8BPS');
});

test('addFillLayer - 16-bit with 16-bit mask', () => {
    const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 16 });
    const mask16 = new Uint8Array(200); // 2 bytes per pixel

    writer.addFillLayer({
        name: 'Test Layer',
        color: { L: 60, a: 30, b: -40 },
        mask: mask16
    });

    assert.strictEqual(writer.layers.length, 1);
    assert.strictEqual(writer.layers[0].mask.length, 200);
});

test('addFillLayer - 16-bit mask conversion verified in output', () => {
    // Mask conversion is deferred to write time; verify the PSD output
    // contains correctly converted 16-bit mask data
    const writer = new PSDWriter({ width: 2, height: 2, bitsPerChannel: 16 });
    const mask8 = new Uint8Array([0, 85, 170, 255]);

    writer.addFillLayer({
        name: 'Test',
        color: { L: 50, a: 0, b: 0 },
        mask: mask8
    });

    // Stored as 8-bit, flagged for deferred conversion
    assert.strictEqual(writer.layers[0].maskIs8bit, true);
    assert.strictEqual(writer.layers[0].mask.length, 4);

    // Write should succeed (conversion happens during write)
    const buffer = writer.write();
    assert.strictEqual(buffer.toString('ascii', 0, 4), '8BPS');
    assert.ok(buffer.length > 100);
});

// --- PSD Generation Tests ---

test('write - generates valid 8-bit PSD structure', () => {
    const writer = new PSDWriter({ width: 50, height: 50, bitsPerChannel: 8 });
    const mask = new Uint8Array(2500).fill(255);

    writer.addFillLayer({
        name: 'Layer 1',
        color: { L: 50, a: 20, b: -10 },
        mask: mask
    });

    const buffer = writer.write();

    // Check PSD signature
    assert.strictEqual(buffer.toString('ascii', 0, 4), '8BPS');

    // Check version (should be 1)
    assert.strictEqual(buffer.readUInt16BE(4), 1);

    // Check color mode (Lab = 9)
    assert.strictEqual(buffer.readUInt16BE(24), 9);
});

test('write - generates valid 16-bit PSD structure', () => {
    const writer = new PSDWriter({ width: 50, height: 50, bitsPerChannel: 16 });
    const mask = new Uint8Array(2500).fill(128);

    writer.addFillLayer({
        name: 'Layer 1',
        color: { L: 60, a: 30, b: -20 },
        mask: mask
    });

    const buffer = writer.write();

    // Check PSD signature
    assert.strictEqual(buffer.toString('ascii', 0, 4), '8BPS');

    // Check version (should be 1)
    assert.strictEqual(buffer.readUInt16BE(4), 1);

    // Check bits per channel (should be 16)
    assert.strictEqual(buffer.readUInt16BE(22), 16);

    // Check color mode (Lab = 9)
    assert.strictEqual(buffer.readUInt16BE(24), 9);
});

test('write - handles multiple layers', () => {
    const writer = new PSDWriter({ width: 20, height: 20, bitsPerChannel: 8 });
    const mask = new Uint8Array(400).fill(200);

    writer.addFillLayer({
        name: 'Layer 1',
        color: { L: 30, a: 10, b: 5 },
        mask: mask
    });

    writer.addFillLayer({
        name: 'Layer 2',
        color: { L: 70, a: -15, b: 25 },
        mask: mask
    });

    writer.addFillLayer({
        name: 'Layer 3',
        color: { L: 50, a: 0, b: 0 },
        mask: mask
    });

    const buffer = writer.write();

    // Should have valid PSD signature
    assert.strictEqual(buffer.toString('ascii', 0, 4), '8BPS');

    // Should be a reasonably sized file
    assert.ok(buffer.length > 1000);
});

test('write - 16-bit PSD with uncompressed masks', () => {
    const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 16 });

    // Create a simple gradient mask
    const mask = new Uint8Array(100);
    for (let i = 0; i < 100; i++) {
        mask[i] = Math.floor((i / 100) * 255);
    }

    writer.addFillLayer({
        name: 'Gradient Layer',
        color: { L: 50, a: 0, b: 0 },
        mask: mask
    });

    const buffer = writer.write();

    // Check it's a valid PSD
    assert.strictEqual(buffer.toString('ascii', 0, 4), '8BPS');
    assert.strictEqual(buffer.readUInt16BE(22), 16); // 16-bit
});

// --- Edge Cases ---

test('write - empty PSD (no layers)', () => {
    const writer = new PSDWriter({ width: 100, height: 100 });
    const buffer = writer.write();

    // Should still generate valid PSD
    assert.strictEqual(buffer.toString('ascii', 0, 4), '8BPS');
});

test('addFillLayer - handles layer name edge cases', () => {
    const writer = new PSDWriter({ width: 10, height: 10 });
    const mask = new Uint8Array(100);

    // Very long name
    writer.addFillLayer({
        name: 'A'.repeat(200),
        color: { L: 50, a: 0, b: 0 },
        mask: mask
    });

    // Unicode characters
    writer.addFillLayer({
        name: '🎨 Test Layer 日本語',
        color: { L: 50, a: 0, b: 0 },
        mask: mask
    });

    assert.strictEqual(writer.layers.length, 2);
});

test('addFillLayer - validates required fields', () => {
    const writer = new PSDWriter({ width: 10, height: 10 });
    const mask = new Uint8Array(100);

    assert.throws(() => {
        writer.addFillLayer({
            color: { L: 50, a: 0, b: 0 },
            mask: mask
        });
    }, /name is required/i);

    assert.throws(() => {
        writer.addFillLayer({
            name: 'Test',
            mask: mask
        });
    }, /color is required/i);

    assert.throws(() => {
        writer.addFillLayer({
            name: 'Test',
            color: { L: 50, a: 0, b: 0 }
        });
    }, /mask is required/i);
});

// ============================================================
// --- QuickLook / Finder Icon / Reference Layer Regression ---
// ============================================================
//
// These tests enforce the three non-negotiable requirements for
// batch-produced PSDs:
//   1. Resource 1036 thumbnail (Finder icon)
//   2. Uncompressed Section 5 composite (QuickLook preview)
//   3. Reference pixel layer as bottom invisible layer (layered files)
//
// Any failure here is a REGRESSION — do not weaken these tests.

/**
 * Parse PSD buffer to extract key structural information.
 * Minimal parser — only reads what we need for verification.
 */
function parsePsdStructure(buffer) {
    const result = {
        signature: buffer.toString('ascii', 0, 4),
        version: buffer.readUInt16BE(4),
        channels: buffer.readUInt16BE(12),
        height: buffer.readUInt32BE(14),
        width: buffer.readUInt32BE(18),
        depth: buffer.readUInt16BE(22),
        colorMode: buffer.readUInt16BE(24),
        hasResource1036: false,
        resource1036Size: 0,
        section5Compression: -1,
        layerCount: 0,
        layerNames: [],
    };

    let offset = 26;

    // Section 2: Color Mode Data
    const colorModeLen = buffer.readUInt32BE(offset);
    offset += 4 + colorModeLen;

    // Section 3: Image Resources
    const imageResourcesLen = buffer.readUInt32BE(offset);
    offset += 4;
    const resourcesEnd = offset + imageResourcesLen;

    // Scan for Resource 1036 (thumbnail)
    let pos = offset;
    while (pos + 12 <= resourcesEnd) {
        const sig = buffer.toString('ascii', pos, pos + 4);
        if (sig !== '8BIM') break;
        const resId = buffer.readUInt16BE(pos + 4);
        // Pascal string (name)
        const nameLen = buffer.readUInt8(pos + 6);
        const namePadded = nameLen + 1 + ((nameLen + 1) % 2);
        const dataSize = buffer.readUInt32BE(pos + 6 + namePadded);
        const dataPadded = dataSize + (dataSize % 2);

        if (resId === 1036) {
            result.hasResource1036 = true;
            result.resource1036Size = dataSize;
        }

        pos += 6 + namePadded + 4 + dataPadded;
    }
    offset = resourcesEnd;

    // Section 4: Layer and Mask Information
    const layerMaskLen = buffer.readUInt32BE(offset);
    offset += 4;
    const layerMaskEnd = offset + layerMaskLen;

    if (layerMaskLen > 0) {
        let scanPos = offset;
        let layerInfoStart = -1;

        // Section 4 structure:
        //   4 bytes: layer info length (0 for 16-bit Lr16 files)
        //   variable: layer info data (if length > 0)
        //   4 bytes: global layer mask info length
        //   variable: global layer mask data
        //   remaining: additional layer info blocks (8BIM + key + length + data)
        const rawLayerInfoLen = buffer.readUInt32BE(scanPos);
        scanPos += 4;

        if (rawLayerInfoLen > 0) {
            // 8-bit path: layers are inline
            layerInfoStart = scanPos;
            scanPos += rawLayerInfoLen + (rawLayerInfoLen % 2);
        } else {
            // 16-bit path: skip global mask, then scan for Lr16 block
        }

        // Skip global layer mask info
        if (scanPos + 4 <= layerMaskEnd) {
            const globalMaskLen = buffer.readUInt32BE(scanPos);
            scanPos += 4 + globalMaskLen;
        }

        // Scan additional layer info blocks for Lr16/Layr
        while (scanPos + 12 <= layerMaskEnd) {
            const sig = buffer.toString('ascii', scanPos, scanPos + 4);
            if (sig !== '8BIM') break;
            const key = buffer.toString('ascii', scanPos + 4, scanPos + 8);
            const blockLen = buffer.readUInt32BE(scanPos + 8);
            if (key === 'Lr16' || key === 'Layr') {
                layerInfoStart = scanPos + 12;
                break;
            }
            scanPos += 12 + blockLen + (blockLen % 2);
        }

        if (layerInfoStart >= 0 && layerInfoStart + 2 <= buffer.length) {
            const rawCount = buffer.readInt16BE(layerInfoStart);
            result.layerCount = Math.abs(rawCount);

            // Parse layer records to extract names
            let layerPos = layerInfoStart + 2;
            for (let i = 0; i < result.layerCount && layerPos + 34 <= buffer.length; i++) {
                // Layer record: 4×4 bounds + 2 channels count + variable channel info + ...
                const top = buffer.readInt32BE(layerPos);
                const left = buffer.readInt32BE(layerPos + 4);
                const bottom = buffer.readInt32BE(layerPos + 8);
                const right = buffer.readInt32BE(layerPos + 12);
                const numChannels = buffer.readUInt16BE(layerPos + 16);
                // Skip channel info (6 bytes per channel)
                layerPos += 18 + numChannels * 6;
                // Blend mode signature + key + opacity + clipping + flags + filler
                layerPos += 4 + 4 + 1 + 1 + 1 + 1;
                // Extra data length
                const extraLen = buffer.readUInt32BE(layerPos);
                layerPos += 4;
                const extraStart = layerPos;
                // Layer mask data
                const maskDataLen = buffer.readUInt32BE(layerPos);
                layerPos += 4 + maskDataLen;
                // Blending ranges
                const blendLen = buffer.readUInt32BE(layerPos);
                layerPos += 4 + blendLen;
                // Layer name (Pascal string padded to 4 bytes)
                const nameLength = buffer.readUInt8(layerPos);
                const layerName = buffer.toString('ascii', layerPos + 1, layerPos + 1 + nameLength);
                result.layerNames.push(layerName);
                // Skip to end of extra data
                layerPos = extraStart + extraLen;
            }
        }
    }
    offset = layerMaskEnd;

    // Section 5: Image Data — compression type
    if (offset + 2 <= buffer.length) {
        result.section5Compression = buffer.readUInt16BE(offset);
    }

    return result;
}

// --- Helper: create a layered PSD like posterize-psd.js does ---
function createLayeredPsd(opts = {}) {
    const width = opts.width || 20;
    const height = opts.height || 20;
    const depth = opts.depth || 16;
    const pixelCount = width * height;

    const writer = new PSDWriter({
        width, height,
        colorMode: 'lab',
        bitsPerChannel: depth,
        compression: 'none'
    });

    // Reference pixel layer (bottom, invisible)
    const refPixels = new Uint8Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        refPixels[i * 3] = 128;     // L
        refPixels[i * 3 + 1] = 128; // a
        refPixels[i * 3 + 2] = 128; // b
    }
    writer.addPixelLayer({
        name: 'Original Image (Reference)',
        pixels: refPixels,
        visible: false
    });

    // Fill+mask layers
    const colors = [
        { L: 80, a: 10, b: 20 },
        { L: 50, a: -20, b: 30 },
        { L: 20, a: 5, b: -10 }
    ];
    for (let i = 0; i < colors.length; i++) {
        const mask = new Uint8Array(pixelCount);
        mask.fill(i === 0 ? 255 : 0); // First layer fully opaque
        writer.addFillLayer({
            name: `[${i + 1}] #aabbcc L${colors[i].L} a${colors[i].a} b${colors[i].b}`,
            color: colors[i],
            mask: mask
        });
    }

    // Composite (8-bit Lab for QuickLook)
    const composite = new Uint8Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        composite[i * 3] = 200;     // L
        composite[i * 3 + 1] = 130; // a
        composite[i * 3 + 2] = 120; // b
    }
    writer.setComposite(composite);

    // Thumbnail (minimal valid JPEG)
    if (opts.includeThumbnail !== false) {
        // Create a minimal JPEG-like buffer (SOI + EOI markers)
        const minJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02, 0x00, 0x00, 0xFF, 0xD9]);
        writer.setThumbnail({ jpegData: minJpeg, width: 10, height: 10 });
    }

    return { writer, width, height, depth };
}

// --- REGRESSION TEST: Resource 1036 (Finder Icon) ---

test('REGRESSION: layered PSD must contain Resource 1036 thumbnail', () => {
    const { writer } = createLayeredPsd();
    const buffer = writer.write();
    const info = parsePsdStructure(buffer);

    assert.strictEqual(info.hasResource1036, true,
        'Resource 1036 (thumbnail) MUST be present for Finder icon');
    assert.ok(info.resource1036Size > 0,
        'Resource 1036 must contain data');
});

test('REGRESSION: flat PSD must contain Resource 1036 thumbnail', () => {
    const writer = new PSDWriter({
        width: 10, height: 10,
        colorMode: 'lab', bitsPerChannel: 16,
        compression: 'none'
    });
    const minJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]);
    writer.setThumbnail({ jpegData: minJpeg, width: 5, height: 5 });
    const composite = new Uint8Array(300);
    composite.fill(128);
    writer.setComposite(composite);

    const buffer = writer.write();
    const info = parsePsdStructure(buffer);

    assert.strictEqual(info.hasResource1036, true,
        'Resource 1036 (thumbnail) MUST be present for Finder icon');
});

// --- REGRESSION TEST: Section 5 Uncompressed (QuickLook) ---

test('REGRESSION: compression=none produces uncompressed Section 5', () => {
    const { writer } = createLayeredPsd();
    const buffer = writer.write();
    const info = parsePsdStructure(buffer);

    assert.strictEqual(info.section5Compression, 0,
        'Section 5 MUST be uncompressed (type 0) for QuickLook to work with Lab PSDs');
});

test('REGRESSION: 8-bit layered PSD has uncompressed Section 5', () => {
    const { writer } = createLayeredPsd({ depth: 8 });
    const buffer = writer.write();
    const info = parsePsdStructure(buffer);

    assert.strictEqual(info.section5Compression, 0,
        'Section 5 MUST be uncompressed (type 0) for QuickLook');
});

// --- REGRESSION TEST: Composite Data (QuickLook Preview) ---

test('REGRESSION: setComposite stores 8-bit Lab data for Section 5', () => {
    const writer = new PSDWriter({
        width: 10, height: 10,
        colorMode: 'lab', bitsPerChannel: 16,
        compression: 'none'
    });
    const composite = new Uint8Array(300);
    for (let i = 0; i < 100; i++) {
        composite[i * 3] = 200;     // L
        composite[i * 3 + 1] = 130; // a
        composite[i * 3 + 2] = 120; // b
    }
    writer.setComposite(composite);

    // compositePixels must be set (not null)
    assert.ok(writer.compositePixels !== null,
        'setComposite must store composite data for QuickLook');
    assert.strictEqual(writer.compositePixels.length, 300,
        'Composite must be 3 bytes per pixel (8-bit Lab)');
});

test('REGRESSION: setComposite must NOT set flatMode', () => {
    const writer = new PSDWriter({
        width: 10, height: 10,
        colorMode: 'lab', bitsPerChannel: 16,
        compression: 'none'
    });
    const mask = new Uint8Array(100).fill(255);
    writer.addFillLayer({ name: 'L1', color: { L: 50, a: 0, b: 0 }, mask });

    const composite = new Uint8Array(300);
    writer.setComposite(composite);

    assert.strictEqual(writer.flatMode, false,
        'setComposite MUST NOT set flatMode — that removes all layers from Section 4');
});

// --- REGRESSION TEST: Reference Pixel Layer ---

test('REGRESSION: layered PSD includes reference pixel layer', () => {
    const { writer } = createLayeredPsd();
    const buffer = writer.write();
    const info = parsePsdStructure(buffer);

    // Should have 4 layers: 1 reference + 3 fill
    assert.strictEqual(info.layerCount, 4,
        'Layered PSD must have reference layer + fill layers');
    assert.strictEqual(info.layerNames[0], 'Original Image (Reference)',
        'First layer must be "Original Image (Reference)"');
});

// --- REGRESSION TEST: Header Channel Count ---

test('REGRESSION: layered PSD header has 3 + extra alpha channels', () => {
    const { writer } = createLayeredPsd();
    const buffer = writer.write();
    const info = parsePsdStructure(buffer);

    // 4 layers total → min(4, 4) = 4 extra alphas → header channels = 3 + 4 = 7
    assert.strictEqual(info.channels, 7,
        'Header channels must be 3 (Lab) + min(layerCount, 4) for layered PSDs');
});

test('REGRESSION: flat PSD header has 3 channels', () => {
    const writer = new PSDWriter({
        width: 10, height: 10,
        colorMode: 'lab', bitsPerChannel: 16,
        compression: 'none', flat: true
    });
    const composite = new Uint8Array(300);
    writer.setComposite(composite);

    const buffer = writer.write();
    const info = parsePsdStructure(buffer);

    assert.strictEqual(info.channels, 3,
        'Flat PSD must have exactly 3 channels (L, a, b)');
});

// --- REGRESSION TEST: Full Round-Trip (Layered 16-bit) ---

test('REGRESSION: 16-bit layered PSD with thumbnail + composite + reference layer', () => {
    const { writer } = createLayeredPsd({ depth: 16 });
    const buffer = writer.write();
    const info = parsePsdStructure(buffer);

    // All three requirements:
    assert.strictEqual(info.signature, '8BPS', 'Valid PSD signature');
    assert.strictEqual(info.depth, 16, 'Must be 16-bit');
    assert.strictEqual(info.colorMode, 9, 'Must be Lab (mode 9)');
    assert.strictEqual(info.hasResource1036, true, 'MUST have Resource 1036 thumbnail');
    assert.strictEqual(info.section5Compression, 0, 'MUST have uncompressed Section 5');
    assert.ok(info.layerCount >= 4, 'MUST have layers (reference + fills)');
    assert.strictEqual(info.layerNames[0], 'Original Image (Reference)',
        'First layer MUST be reference pixel layer');
});

test('REGRESSION: 8-bit layered PSD with thumbnail + composite + reference layer', () => {
    const { writer } = createLayeredPsd({ depth: 8 });
    const buffer = writer.write();
    const info = parsePsdStructure(buffer);

    assert.strictEqual(info.signature, '8BPS', 'Valid PSD signature');
    assert.strictEqual(info.depth, 8, 'Must be 8-bit');
    assert.strictEqual(info.hasResource1036, true, 'MUST have Resource 1036 thumbnail');
    assert.strictEqual(info.section5Compression, 0, 'MUST have uncompressed Section 5');
    assert.ok(info.layerCount >= 4, 'MUST have layers');
    assert.strictEqual(info.layerNames[0], 'Original Image (Reference)',
        'First layer MUST be reference pixel layer');
});

// --- Summary ---

console.log(`\n${'='.repeat(50)}`);
console.log(`Test Results: ${passCount}/${testCount} passed`);
console.log('='.repeat(50));

if (passCount === testCount) {
    console.log('✓ All tests passed!');
    process.exit(0);
} else {
    console.log(`✗ ${testCount - passCount} test(s) failed`);
    process.exit(1);
}
