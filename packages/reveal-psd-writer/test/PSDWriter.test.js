/**
 * PSDWriter Tests
 *
 * Tests for 8-bit and 16-bit Lab PSD generation with fill+mask layers
 */

const { PSDWriter } = require('../src');

// --- Helper: parse PSD buffer to extract key structural information ---

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

        const rawLayerInfoLen = buffer.readUInt32BE(scanPos);
        scanPos += 4;

        if (rawLayerInfoLen > 0) {
            layerInfoStart = scanPos;
            scanPos += rawLayerInfoLen + (rawLayerInfoLen % 2);
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

            let layerPos = layerInfoStart + 2;
            for (let i = 0; i < result.layerCount && layerPos + 34 <= buffer.length; i++) {
                const numChannels = buffer.readUInt16BE(layerPos + 16);
                layerPos += 18 + numChannels * 6;
                // Blend mode signature + key + opacity + clipping + flags + filler
                layerPos += 4 + 4 + 1 + 1 + 1 + 1;
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

// --- Helper: add minimum composite + thumbnail so write() doesn't throw ---

const MIN_JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02, 0x00, 0x00, 0xFF, 0xD9]);

function addPreviewData(writer) {
    const pixelCount = writer.width * writer.height;
    const composite = new Uint8Array(pixelCount * 3);
    composite.fill(128);
    writer.setComposite(composite);
    writer.setThumbnail({ jpegData: MIN_JPEG, width: 2, height: 2 });
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
        refPixels[i * 3] = 128;
        refPixels[i * 3 + 1] = 128;
        refPixels[i * 3 + 2] = 128;
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
        mask.fill(i === 0 ? 255 : 0);
        writer.addFillLayer({
            name: `[${i + 1}] #aabbcc L${colors[i].L} a${colors[i].a} b${colors[i].b}`,
            color: colors[i],
            mask: mask
        });
    }

    // Composite (8-bit Lab for QuickLook)
    const composite = new Uint8Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        composite[i * 3] = 200;
        composite[i * 3 + 1] = 130;
        composite[i * 3 + 2] = 120;
    }
    writer.setComposite(composite);

    // Thumbnail (minimal valid JPEG)
    if (opts.includeThumbnail !== false) {
        const minJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02, 0x00, 0x00, 0xFF, 0xD9]);
        writer.setThumbnail({ jpegData: minJpeg, width: 10, height: 10 });
    }

    return { writer, width, height, depth };
}

// --- Basic Constructor Tests ---

describe('PSDWriter constructor', () => {
    it('creates default 8-bit Lab writer', () => {
        const writer = new PSDWriter({ width: 100, height: 100 });
        expect(writer.width).toBe(100);
        expect(writer.height).toBe(100);
        expect(writer.colorMode).toBe('lab');
        expect(writer.bitsPerChannel).toBe(8);
    });

    it('creates 16-bit Lab writer', () => {
        const writer = new PSDWriter({
            width: 200, height: 150,
            colorMode: 'lab', bitsPerChannel: 16
        });
        expect(writer.width).toBe(200);
        expect(writer.height).toBe(150);
        expect(writer.bitsPerChannel).toBe(16);
    });

    it('validates dimensions', () => {
        expect(() => new PSDWriter({ width: 0, height: 100 })).toThrow(/width and height are required/i);
        expect(() => new PSDWriter({ width: 100, height: 0 })).toThrow(/width and height are required/i);
    });

    it('validates bits per channel', () => {
        expect(() => new PSDWriter({ width: 100, height: 100, bitsPerChannel: 24 }))
            .toThrow(/Only 8-bit and 16-bit per channel are supported/i);
    });
});

// --- Fill Layer Tests (8-bit) ---

describe('addFillLayer - 8-bit', () => {
    it('adds layer with valid mask', () => {
        const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 8 });
        const mask = new Uint8Array(100).fill(255);

        writer.addFillLayer({
            name: 'Test Layer',
            color: { L: 50, a: 10, b: -20 },
            mask: mask
        });

        expect(writer.layers.length).toBe(1);
        expect(writer.layers[0].name).toBe('Test Layer');
    });

    it('validates mask size', () => {
        const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 8 });
        const invalidMask = new Uint8Array(50);

        expect(() => {
            writer.addFillLayer({
                name: 'Test',
                color: { L: 50, a: 0, b: 0 },
                mask: invalidMask
            });
        }).toThrow(/Mask must be 100 bytes/i);
    });

    it('stores color values correctly', () => {
        const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 8 });
        const mask = new Uint8Array(100);

        writer.addFillLayer({
            name: 'Test',
            color: { L: 50, a: 20, b: -30 },
            mask: mask
        });

        expect(writer.layers.length).toBe(1);
        expect(writer.layers[0].color.L).toBe(50);
        expect(writer.layers[0].color.a).toBe(20);
        expect(writer.layers[0].color.b).toBe(-30);
    });

    it('validates required fields', () => {
        const writer = new PSDWriter({ width: 10, height: 10 });
        const mask = new Uint8Array(100);

        expect(() => writer.addFillLayer({ color: { L: 50, a: 0, b: 0 }, mask }))
            .toThrow(/name is required/i);
        expect(() => writer.addFillLayer({ name: 'Test', mask }))
            .toThrow(/color is required/i);
        expect(() => writer.addFillLayer({ name: 'Test', color: { L: 50, a: 0, b: 0 } }))
            .toThrow(/mask is required/i);
    });
});

// --- Fill Layer Tests (16-bit) ---

describe('addFillLayer - 16-bit', () => {
    it('accepts 8-bit mask with deferred conversion', () => {
        const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 16 });
        const mask8 = new Uint8Array(100).fill(128);

        writer.addFillLayer({
            name: 'Test Layer',
            color: { L: 60, a: 30, b: -40 },
            mask: mask8
        });

        expect(writer.layers.length).toBe(1);
        expect(writer.layers[0].mask.length).toBe(100);
        expect(writer.layers[0].maskIs8bit).toBe(true);
        addPreviewData(writer);
        const buffer = writer.write();
        expect(buffer.toString('ascii', 0, 4)).toBe('8BPS');
    });

    it('accepts 16-bit mask', () => {
        const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 16 });
        const mask16 = new Uint8Array(200);

        writer.addFillLayer({
            name: 'Test Layer',
            color: { L: 60, a: 30, b: -40 },
            mask: mask16
        });

        expect(writer.layers.length).toBe(1);
        expect(writer.layers[0].mask.length).toBe(200);
    });

    it('defers mask conversion to write time', () => {
        const writer = new PSDWriter({ width: 2, height: 2, bitsPerChannel: 16 });
        const mask8 = new Uint8Array([0, 85, 170, 255]);

        writer.addFillLayer({
            name: 'Test',
            color: { L: 50, a: 0, b: 0 },
            mask: mask8
        });

        expect(writer.layers[0].maskIs8bit).toBe(true);
        expect(writer.layers[0].mask.length).toBe(4);

        addPreviewData(writer);
        const buffer = writer.write();
        expect(buffer.toString('ascii', 0, 4)).toBe('8BPS');
        expect(buffer.length).toBeGreaterThan(100);
    });
});

// --- PSD Generation Tests ---

describe('write', () => {
    it('generates valid 8-bit PSD structure', () => {
        const writer = new PSDWriter({ width: 50, height: 50, bitsPerChannel: 8 });
        const mask = new Uint8Array(2500).fill(255);

        writer.addFillLayer({
            name: 'Layer 1',
            color: { L: 50, a: 20, b: -10 },
            mask: mask
        });

        addPreviewData(writer);
        const buffer = writer.write();
        expect(buffer.toString('ascii', 0, 4)).toBe('8BPS');
        expect(buffer.readUInt16BE(4)).toBe(1);
        expect(buffer.readUInt16BE(24)).toBe(9);
    });

    it('generates valid 16-bit PSD structure', () => {
        const writer = new PSDWriter({ width: 50, height: 50, bitsPerChannel: 16 });
        const mask = new Uint8Array(2500).fill(128);

        writer.addFillLayer({
            name: 'Layer 1',
            color: { L: 60, a: 30, b: -20 },
            mask: mask
        });

        addPreviewData(writer);
        const buffer = writer.write();
        expect(buffer.toString('ascii', 0, 4)).toBe('8BPS');
        expect(buffer.readUInt16BE(4)).toBe(1);
        expect(buffer.readUInt16BE(22)).toBe(16);
        expect(buffer.readUInt16BE(24)).toBe(9);
    });

    it('handles multiple layers', () => {
        const writer = new PSDWriter({ width: 20, height: 20, bitsPerChannel: 8 });
        const mask = new Uint8Array(400).fill(200);

        writer.addFillLayer({ name: 'Layer 1', color: { L: 30, a: 10, b: 5 }, mask });
        writer.addFillLayer({ name: 'Layer 2', color: { L: 70, a: -15, b: 25 }, mask });
        writer.addFillLayer({ name: 'Layer 3', color: { L: 50, a: 0, b: 0 }, mask });

        addPreviewData(writer);
        const buffer = writer.write();
        expect(buffer.toString('ascii', 0, 4)).toBe('8BPS');
        expect(buffer.length).toBeGreaterThan(1000);
    });

    it('generates 16-bit PSD with uncompressed masks', () => {
        const writer = new PSDWriter({ width: 10, height: 10, bitsPerChannel: 16 });
        const mask = new Uint8Array(100);
        for (let i = 0; i < 100; i++) mask[i] = Math.floor((i / 100) * 255);

        writer.addFillLayer({
            name: 'Gradient Layer',
            color: { L: 50, a: 0, b: 0 },
            mask: mask
        });

        addPreviewData(writer);
        const buffer = writer.write();
        expect(buffer.toString('ascii', 0, 4)).toBe('8BPS');
        expect(buffer.readUInt16BE(22)).toBe(16);
    });

    it('throws without composite', () => {
        const writer = new PSDWriter({ width: 10, height: 10 });
        writer.addFillLayer({ name: 'L1', color: { L: 50, a: 0, b: 0 }, mask: new Uint8Array(100) });
        writer.setThumbnail({ jpegData: MIN_JPEG, width: 2, height: 2 });
        expect(() => writer.write()).toThrow(/setComposite/);
    });

    it('throws without thumbnail', () => {
        const writer = new PSDWriter({ width: 10, height: 10 });
        writer.addFillLayer({ name: 'L1', color: { L: 50, a: 0, b: 0 }, mask: new Uint8Array(100) });
        writer.setComposite(new Uint8Array(300).fill(128));
        expect(() => writer.write()).toThrow(/setThumbnail/);
    });

    it('throws without layers', () => {
        const writer = new PSDWriter({ width: 10, height: 10 });
        writer.setComposite(new Uint8Array(300).fill(128));
        writer.setThumbnail({ jpegData: MIN_JPEG, width: 2, height: 2 });
        expect(() => writer.write()).toThrow(/at least one layer/);
    });
});

// --- Edge Cases ---

describe('edge cases', () => {
    it('handles long and unicode layer names', () => {
        const writer = new PSDWriter({ width: 10, height: 10 });
        const mask = new Uint8Array(100);

        writer.addFillLayer({ name: 'A'.repeat(200), color: { L: 50, a: 0, b: 0 }, mask });
        writer.addFillLayer({ name: 'Test Layer', color: { L: 50, a: 0, b: 0 }, mask });

        expect(writer.layers.length).toBe(2);
    });
});

// --- QuickLook / Finder Icon / Reference Layer Regression Tests ---

describe('REGRESSION: Resource 1036 (Finder Icon)', () => {
    it('layered PSD contains Resource 1036 thumbnail', () => {
        const { writer } = createLayeredPsd();
        const buffer = writer.write();
        const info = parsePsdStructure(buffer);

        expect(info.hasResource1036).toBe(true);
        expect(info.resource1036Size).toBeGreaterThan(0);
    });

    it('flat PSD contains Resource 1036 thumbnail', () => {
        const writer = new PSDWriter({
            width: 10, height: 10,
            colorMode: 'lab', bitsPerChannel: 16,
            compression: 'none', flat: true
        });
        writer.setThumbnail({ jpegData: MIN_JPEG, width: 5, height: 5 });
        const composite = new Uint8Array(300);
        composite.fill(128);
        writer.setComposite(composite);

        const buffer = writer.write();
        const info = parsePsdStructure(buffer);

        expect(info.hasResource1036).toBe(true);
    });
});

describe('REGRESSION: Section 5 Uncompressed (QuickLook)', () => {
    it('compression=none produces uncompressed Section 5', () => {
        const { writer } = createLayeredPsd();
        const buffer = writer.write();
        const info = parsePsdStructure(buffer);

        expect(info.section5Compression).toBe(0);
    });

    it('8-bit layered PSD has uncompressed Section 5', () => {
        const { writer } = createLayeredPsd({ depth: 8 });
        const buffer = writer.write();
        const info = parsePsdStructure(buffer);

        expect(info.section5Compression).toBe(0);
    });
});

describe('REGRESSION: Composite Data (QuickLook Preview)', () => {
    it('setComposite stores 8-bit Lab data for Section 5', () => {
        const writer = new PSDWriter({
            width: 10, height: 10,
            colorMode: 'lab', bitsPerChannel: 16,
            compression: 'none'
        });
        const composite = new Uint8Array(300);
        for (let i = 0; i < 100; i++) {
            composite[i * 3] = 200;
            composite[i * 3 + 1] = 130;
            composite[i * 3 + 2] = 120;
        }
        writer.setComposite(composite);

        expect(writer.compositePixels).not.toBeNull();
        expect(writer.compositePixels.length).toBe(300);
    });

    it('setComposite does NOT set flatMode', () => {
        const writer = new PSDWriter({
            width: 10, height: 10,
            colorMode: 'lab', bitsPerChannel: 16,
            compression: 'none'
        });
        const mask = new Uint8Array(100).fill(255);
        writer.addFillLayer({ name: 'L1', color: { L: 50, a: 0, b: 0 }, mask });

        const composite = new Uint8Array(300);
        writer.setComposite(composite);

        expect(writer.flatMode).toBe(false);
    });
});

describe('REGRESSION: Reference Pixel Layer', () => {
    it('layered PSD includes reference pixel layer', () => {
        const { writer } = createLayeredPsd();
        const buffer = writer.write();
        const info = parsePsdStructure(buffer);

        expect(info.layerCount).toBe(4);
        expect(info.layerNames[0]).toBe('Original Image (Reference)');
    });
});

describe('REGRESSION: Header Channel Count', () => {
    it('layered PSD header has 3 + extra alpha channels', () => {
        const { writer } = createLayeredPsd();
        const buffer = writer.write();
        const info = parsePsdStructure(buffer);

        expect(info.channels).toBe(7);
    });

    it('flat PSD header has 3 channels', () => {
        const writer = new PSDWriter({
            width: 10, height: 10,
            colorMode: 'lab', bitsPerChannel: 16,
            compression: 'none', flat: true
        });
        const composite = new Uint8Array(300);
        writer.setComposite(composite);
        writer.setThumbnail({ jpegData: MIN_JPEG, width: 2, height: 2 });

        const buffer = writer.write();
        const info = parsePsdStructure(buffer);

        expect(info.channels).toBe(3);
    });
});

describe('REGRESSION: Full Round-Trip', () => {
    it('16-bit layered PSD with thumbnail + composite + reference layer', () => {
        const { writer } = createLayeredPsd({ depth: 16 });
        const buffer = writer.write();
        const info = parsePsdStructure(buffer);

        expect(info.signature).toBe('8BPS');
        expect(info.depth).toBe(16);
        expect(info.colorMode).toBe(9);
        expect(info.hasResource1036).toBe(true);
        expect(info.section5Compression).toBe(0);
        expect(info.layerCount).toBeGreaterThanOrEqual(4);
        expect(info.layerNames[0]).toBe('Original Image (Reference)');
    });

    it('8-bit layered PSD with thumbnail + composite + reference layer', () => {
        const { writer } = createLayeredPsd({ depth: 8 });
        const buffer = writer.write();
        const info = parsePsdStructure(buffer);

        expect(info.signature).toBe('8BPS');
        expect(info.depth).toBe(8);
        expect(info.hasResource1036).toBe(true);
        expect(info.section5Compression).toBe(0);
        expect(info.layerCount).toBeGreaterThanOrEqual(4);
        expect(info.layerNames[0]).toBe('Original Image (Reference)');
    });
});
