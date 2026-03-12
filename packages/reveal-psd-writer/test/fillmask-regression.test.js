/**
 * Automated tests for fill+mask layer writing
 * Prevents regressions in mask data format
 */

const fs = require('fs');
const path = require('path');
const { PSDWriter } = require('../src');
const PSDReader = require('../src/PSDReader');

const MIN_JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02, 0x00, 0x00, 0xFF, 0xD9]);

function addPreviewData(writer) {
    const composite = new Uint8Array(writer.width * writer.height * 3);
    composite.fill(128);
    writer.setComposite(composite);
    writer.setThumbnail({ jpegData: MIN_JPEG, width: 2, height: 2 });
}

function findMaskChannel(layer) {
    for (let i = 0; i < layer.channels.length; i++) {
        if (layer.channels[i].channelID === -2) {
            return layer.channelData[i];
        }
    }
    return null;
}

describe('Fill+Mask Layer Writing', () => {
    const testOutputDir = path.join(__dirname, '../test-output');

    beforeAll(() => {
        if (!fs.existsSync(testOutputDir)) {
            fs.mkdirSync(testOutputDir, { recursive: true });
        }
    });

    test('16-bit masks use byte duplication format', () => {
        const width = 4;
        const height = 4;
        const mask8 = new Uint8Array([
            255, 0, 255, 0,
            0, 255, 0, 255,
            255, 0, 255, 0,
            0, 255, 0, 255
        ]);

        const mask16 = new Uint8Array(width * height * 2);
        for (let i = 0; i < mask8.length; i++) {
            mask16[i * 2] = mask8[i];
            mask16[i * 2 + 1] = mask8[i];
        }

        const writer = new PSDWriter({
            width, height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        writer.addFillLayer({
            name: 'Test Layer',
            color: { L: 50, a: 0, b: 0 },
            mask: mask16
        });

        addPreviewData(writer);
        const psdBuffer = writer.write();
        fs.writeFileSync(path.join(testOutputDir, 'test-mask-format.psd'), psdBuffer);

        const reader = new PSDReader(psdBuffer);
        const psd = reader.read();

        const layer = psd.layerAndMaskInfo.layerInfo.layers[0];
        expect(layer).toBeDefined();
        expect(layer.name).toBe('Test Layer');

        const maskChannel = findMaskChannel(layer);
        expect(maskChannel).toBeDefined();

        const decompressed = maskChannel.decompressedData;
        expect(decompressed.length).toBe(width * height * 2);

        for (let i = 0; i < mask8.length; i++) {
            const highByte = decompressed[i * 2];
            const lowByte = decompressed[i * 2 + 1];
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
            width, height,
            colorMode: 'lab',
            bitsPerChannel: 8
        });

        writer.addFillLayer({
            name: 'Test Layer 8bit',
            color: { L: 50, a: 0, b: 0 },
            mask: mask8
        });

        addPreviewData(writer);
        const psdBuffer = writer.write();
        fs.writeFileSync(path.join(testOutputDir, 'test-mask-8bit.psd'), psdBuffer);

        const reader = new PSDReader(psdBuffer);
        const psd = reader.read();

        const layer = psd.layerAndMaskInfo.layerInfo.layers[0];
        const maskChannel = findMaskChannel(layer);
        expect(maskChannel).toBeDefined();

        const decompressed = maskChannel.decompressedData;
        expect(decompressed.length).toBe(width * height);
        for (let i = 0; i < mask8.length; i++) {
            expect(decompressed[i]).toBe(mask8[i]);
        }
    });

    test('binary masks (0/255) produce correct 16-bit values', () => {
        const width = 2;
        const height = 2;
        const mask8 = new Uint8Array([255, 0, 0, 255]);

        const mask16 = new Uint8Array(width * height * 2);
        for (let i = 0; i < mask8.length; i++) {
            mask16[i * 2] = mask8[i];
            mask16[i * 2 + 1] = mask8[i];
        }

        const writer = new PSDWriter({
            width, height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        writer.addFillLayer({
            name: 'Binary Mask',
            color: { L: 75, a: 10, b: -20 },
            mask: mask16
        });

        addPreviewData(writer);
        const psdBuffer = writer.write();
        const reader = new PSDReader(psdBuffer);
        const psd = reader.read();

        const layer = psd.layerAndMaskInfo.layerInfo.layers[0];
        const maskChannel = findMaskChannel(layer);
        const decompressed = maskChannel.decompressedData;

        // 255 -> 0xFFFF
        expect(decompressed[0]).toBe(0xFF);
        expect(decompressed[1]).toBe(0xFF);
        // 0 -> 0x0000
        expect(decompressed[2]).toBe(0x00);
        expect(decompressed[3]).toBe(0x00);
        // 0 -> 0x0000
        expect(decompressed[4]).toBe(0x00);
        expect(decompressed[5]).toBe(0x00);
        // 255 -> 0xFFFF
        expect(decompressed[6]).toBe(0xFF);
        expect(decompressed[7]).toBe(0xFF);
    });

    test('mid-tone masks (128) produce correct 16-bit values', () => {
        const width = 2;
        const height = 2;
        const mask8 = new Uint8Array([128, 128, 128, 128]);

        const mask16 = new Uint8Array(width * height * 2);
        for (let i = 0; i < mask8.length; i++) {
            mask16[i * 2] = mask8[i];
            mask16[i * 2 + 1] = mask8[i];
        }

        const writer = new PSDWriter({
            width, height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        writer.addFillLayer({
            name: 'Mid-tone Mask',
            color: { L: 50, a: 0, b: 0 },
            mask: mask16
        });

        addPreviewData(writer);
        const psdBuffer = writer.write();
        const reader = new PSDReader(psdBuffer);
        const psd = reader.read();

        const layer = psd.layerAndMaskInfo.layerInfo.layers[0];
        const maskChannel = findMaskChannel(layer);
        const decompressed = maskChannel.decompressedData;

        // 128 -> 0x8080 using byte duplication
        for (let i = 0; i < 8; i += 2) {
            expect(decompressed[i]).toBe(0x80);
            expect(decompressed[i + 1]).toBe(0x80);
        }
    });

    test('rejects incorrectly sized masks', () => {
        const writer = new PSDWriter({
            width: 4, height: 4,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        expect(() => {
            writer.addFillLayer({
                name: 'Bad Mask',
                color: { L: 50, a: 0, b: 0 },
                mask: new Uint8Array(10)
            });
        }).toThrow();
    });

    test('multiple fill+mask layers write correctly', () => {
        const width = 3;
        const height = 3;

        const mask1 = new Uint8Array(width * height * 2);
        const mask2 = new Uint8Array(width * height * 2);
        const mask3 = new Uint8Array(width * height * 2);

        for (let i = 0; i < width * height; i++) {
            const val1 = i % 2 === 0 ? 255 : 0;
            const val2 = i % 3 === 0 ? 255 : 0;
            const val3 = i < 4 ? 255 : 0;

            mask1[i * 2] = val1; mask1[i * 2 + 1] = val1;
            mask2[i * 2] = val2; mask2[i * 2 + 1] = val2;
            mask3[i * 2] = val3; mask3[i * 2 + 1] = val3;
        }

        const writer = new PSDWriter({
            width, height,
            colorMode: 'lab',
            bitsPerChannel: 16
        });

        writer.addFillLayer({ name: 'Layer 1', color: { L: 30, a: 10, b: 5 }, mask: mask1 });
        writer.addFillLayer({ name: 'Layer 2', color: { L: 60, a: -10, b: 20 }, mask: mask2 });
        writer.addFillLayer({ name: 'Layer 3', color: { L: 90, a: 0, b: 0 }, mask: mask3 });

        addPreviewData(writer);
        const psdBuffer = writer.write();
        fs.writeFileSync(path.join(testOutputDir, 'test-multiple-masks.psd'), psdBuffer);

        const reader = new PSDReader(psdBuffer);
        const psd = reader.read();

        expect(psd.layerAndMaskInfo.layerInfo.layers.length).toBe(3);
        expect(psd.layerAndMaskInfo.layerInfo.layers[0].name).toBe('Layer 1');
        expect(psd.layerAndMaskInfo.layerInfo.layers[1].name).toBe('Layer 2');
        expect(psd.layerAndMaskInfo.layerInfo.layers[2].name).toBe('Layer 3');
    });
});
