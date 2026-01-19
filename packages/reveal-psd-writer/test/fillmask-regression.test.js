/**
 * Automated tests for fill+mask layer writing
 * Prevents regressions in mask data format
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PSDWriter } = require('../src');
const PSDReader = require('../src/PSDReader');

describe('Fill+Mask Layer Writing', () => {
    const testOutputDir = path.join(__dirname, '../test-output');

    beforeAll(() => {
        if (!fs.existsSync(testOutputDir)) {
            fs.mkdirSync(testOutputDir, { recursive: true });
        }
    });

    test('16-bit masks use byte duplication format', () => {
        // Create a simple test mask: checkerboard pattern
        const width = 4;
        const height = 4;
        const mask8 = new Uint8Array([
            255, 0, 255, 0,
            0, 255, 0, 255,
            255, 0, 255, 0,
            0, 255, 0, 255
        ]);

        // Convert to 16-bit using the correct byte duplication method
        const mask16 = new Uint8Array(width * height * 2);
        for (let i = 0; i < mask8.length; i++) {
            mask16[i * 2] = mask8[i];       // High byte
            mask16[i * 2 + 1] = mask8[i];   // Low byte (duplicate)
        }

        // Write PSD
        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        writer.addFillLayer({
            name: 'Test Layer',
            color: { L: 50, a: 0, b: 0 },
            mask: mask16
        });

        const psdBuffer = writer.write();
        const outputPath = path.join(testOutputDir, 'test-mask-format.psd');
        fs.writeFileSync(outputPath, psdBuffer);

        // Read back and verify mask format
        const reader = new PSDReader(psdBuffer);
        const psd = reader.read();

        const layer = psd.layerAndMaskInfo.layerInfo.layers[0];
        expect(layer).toBeDefined();
        expect(layer.name).toBe('Test Layer');

        // Find mask channel (ID=-2)
        let maskChannel = null;
        for (let i = 0; i < layer.channels.length; i++) {
            if (layer.channels[i].channelID === -2) {
                maskChannel = layer.channelData[i];
                break;
            }
        }

        expect(maskChannel).toBeDefined();
        expect(maskChannel.compression).toBe(3); // ZIP compression

        // Decompress and verify
        const decompressedMask = zlib.inflateSync(maskChannel.data);
        expect(decompressedMask.length).toBe(width * height * 2);

        // Verify byte duplication format
        for (let i = 0; i < mask8.length; i++) {
            const highByte = decompressedMask[i * 2];
            const lowByte = decompressedMask[i * 2 + 1];

            // Both bytes should be equal (byte duplication)
            expect(highByte).toBe(lowByte);
            expect(highByte).toBe(mask8[i]);
        }
    });

    test('8-bit masks are passed through unchanged', () => {
        const width = 4;
        const height = 4;
        const mask8 = new Uint8Array([
            255, 0, 255, 0,
            0, 255, 0, 255,
            255, 0, 255, 0,
            0, 255, 0, 255
        ]);

        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 8
        });

        writer.addFillLayer({
            name: 'Test Layer 8bit',
            color: { L: 50, a: 0, b: 0 },
            mask: mask8
        });

        const psdBuffer = writer.write();
        const outputPath = path.join(testOutputDir, 'test-mask-8bit.psd');
        fs.writeFileSync(outputPath, psdBuffer);

        // Read back and verify
        const reader = new PSDReader(psdBuffer);
        const psd = reader.read();

        const layer = psd.layerAndMaskInfo.layerInfo.layers[0];
        let maskChannel = null;
        for (let i = 0; i < layer.channels.length; i++) {
            if (layer.channels[i].channelID === -2) {
                maskChannel = layer.channelData[i];
                break;
            }
        }

        expect(maskChannel).toBeDefined();

        // 8-bit masks should match input exactly
        const maskData = maskChannel.data;
        expect(maskData.length).toBe(width * height);
        for (let i = 0; i < mask8.length; i++) {
            expect(maskData[i]).toBe(mask8[i]);
        }
    });

    test('binary masks (0/255) produce correct 16-bit values', () => {
        const width = 2;
        const height = 2;
        const mask8 = new Uint8Array([255, 0, 0, 255]);

        // Convert to 16-bit
        const mask16 = new Uint8Array(width * height * 2);
        for (let i = 0; i < mask8.length; i++) {
            mask16[i * 2] = mask8[i];
            mask16[i * 2 + 1] = mask8[i];
        }

        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        writer.addFillLayer({
            name: 'Binary Mask',
            color: { L: 75, a: 10, b: -20 },
            mask: mask16
        });

        const psdBuffer = writer.write();
        const reader = new PSDReader(psdBuffer);
        const psd = reader.read();

        const layer = psd.layerAndMaskInfo.layerInfo.layers[0];
        let maskChannel = null;
        for (let i = 0; i < layer.channels.length; i++) {
            if (layer.channels[i].channelID === -2) {
                maskChannel = layer.channelData[i];
                break;
            }
        }

        const decompressedMask = zlib.inflateSync(maskChannel.data);

        // Verify binary values
        // 255 → 0xFFFF (65535)
        expect(decompressedMask[0]).toBe(0xFF);
        expect(decompressedMask[1]).toBe(0xFF);

        // 0 → 0x0000 (0)
        expect(decompressedMask[2]).toBe(0x00);
        expect(decompressedMask[3]).toBe(0x00);

        // 0 → 0x0000
        expect(decompressedMask[4]).toBe(0x00);
        expect(decompressedMask[5]).toBe(0x00);

        // 255 → 0xFFFF
        expect(decompressedMask[6]).toBe(0xFF);
        expect(decompressedMask[7]).toBe(0xFF);
    });

    test('mid-tone masks (128) produce correct 16-bit values', () => {
        const width = 2;
        const height = 2;
        const mask8 = new Uint8Array([128, 128, 128, 128]);

        // Convert to 16-bit
        const mask16 = new Uint8Array(width * height * 2);
        for (let i = 0; i < mask8.length; i++) {
            mask16[i * 2] = mask8[i];
            mask16[i * 2 + 1] = mask8[i];
        }

        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        writer.addFillLayer({
            name: 'Mid-tone Mask',
            color: { L: 50, a: 0, b: 0 },
            mask: mask16
        });

        const psdBuffer = writer.write();
        const reader = new PSDReader(psdBuffer);
        const psd = reader.read();

        const layer = psd.layerAndMaskInfo.layerInfo.layers[0];
        let maskChannel = null;
        for (let i = 0; i < layer.channels.length; i++) {
            if (layer.channels[i].channelID === -2) {
                maskChannel = layer.channelData[i];
                break;
            }
        }

        const decompressedMask = zlib.inflateSync(maskChannel.data);

        // 128 → 0x8080 (32896) using byte duplication
        for (let i = 0; i < 8; i += 2) {
            expect(decompressedMask[i]).toBe(0x80);
            expect(decompressedMask[i + 1]).toBe(0x80);
        }
    });

    test('rejects incorrectly sized masks', () => {
        const writer = new PSDWriter({
            width: 4,
            height: 4,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        expect(() => {
            writer.addFillLayer({
                name: 'Bad Mask',
                color: { L: 50, a: 0, b: 0 },
                mask: new Uint8Array(10) // Wrong size!
            });
        }).toThrow();
    });

    test('multiple fill+mask layers write correctly', () => {
        const width = 3;
        const height = 3;

        // Create 3 different masks
        const mask1 = new Uint8Array(width * height * 2);
        const mask2 = new Uint8Array(width * height * 2);
        const mask3 = new Uint8Array(width * height * 2);

        for (let i = 0; i < width * height; i++) {
            const val1 = i % 2 === 0 ? 255 : 0;
            const val2 = i % 3 === 0 ? 255 : 0;
            const val3 = i < 4 ? 255 : 0;

            mask1[i * 2] = val1;
            mask1[i * 2 + 1] = val1;
            mask2[i * 2] = val2;
            mask2[i * 2 + 1] = val2;
            mask3[i * 2] = val3;
            mask3[i * 2 + 1] = val3;
        }

        const writer = new PSDWriter({
            width,
            height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        writer.addFillLayer({ name: 'Layer 1', color: { L: 30, a: 10, b: 5 }, mask: mask1 });
        writer.addFillLayer({ name: 'Layer 2', color: { L: 60, a: -10, b: 20 }, mask: mask2 });
        writer.addFillLayer({ name: 'Layer 3', color: { L: 90, a: 0, b: 0 }, mask: mask3 });

        const psdBuffer = writer.write();
        const outputPath = path.join(testOutputDir, 'test-multiple-masks.psd');
        fs.writeFileSync(outputPath, psdBuffer);

        // Read back and verify all 3 layers
        const reader = new PSDReader(psdBuffer);
        const psd = reader.read();

        expect(psd.layerAndMaskInfo.layerInfo.layers.length).toBe(3);
        expect(psd.layerAndMaskInfo.layerInfo.layers[0].name).toBe('Layer 1');
        expect(psd.layerAndMaskInfo.layerInfo.layers[1].name).toBe('Layer 2');
        expect(psd.layerAndMaskInfo.layerInfo.layers[2].name).toBe('Layer 3');
    });
});
