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

test('addFillLayer - 16-bit with 8-bit mask (auto-converts)', () => {
    const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 16 });
    const mask8 = new Uint8Array(100).fill(128);

    writer.addFillLayer({
        name: 'Test Layer',
        color: { L: 60, a: 30, b: -40 },
        mask: mask8
    });

    assert.strictEqual(writer.layers.length, 1);
    // Mask should be auto-converted to 16-bit (200 bytes)
    assert.strictEqual(writer.layers[0].mask.length, 200);
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

test('addFillLayer - 16-bit mask conversion (8→16)', () => {
    const writer = new PSDWriter({ width: 2, height: 2, bitsPerChannel: 16 });
    const mask8 = new Uint8Array([0, 85, 170, 255]); // Black, dark gray, light gray, white

    writer.addFillLayer({
        name: 'Test',
        color: { L: 50, a: 0, b: 0 },
        mask: mask8
    });

    const mask16 = writer.layers[0].mask;

    // Check conversion: value8 * 257 split into high/low bytes
    // 0 * 257 = 0 → 0x0000
    assert.strictEqual(mask16[0], 0x00);
    assert.strictEqual(mask16[1], 0x00);

    // 85 * 257 = 21845 → 0x5555
    assert.strictEqual(mask16[2], 0x55);
    assert.strictEqual(mask16[3], 0x55);

    // 170 * 257 = 43690 → 0xAAAA
    assert.strictEqual(mask16[4], 0xAA);
    assert.strictEqual(mask16[5], 0xAA);

    // 255 * 257 = 65535 → 0xFFFF
    assert.strictEqual(mask16[6], 0xFF);
    assert.strictEqual(mask16[7], 0xFF);
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
