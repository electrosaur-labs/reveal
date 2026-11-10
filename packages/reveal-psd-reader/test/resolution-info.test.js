const { parseResolutionInfo, readPsd } = require('../index.js');

/**
 * Build a single 8BIM Image Resource Block: signature, ID, Pascal-string
 * name (padded to even total length), size, and data (padded to even).
 */
function buildResourceBlock(id, name, data) {
    const nameBytes = Buffer.from(name, 'ascii');
    let nameBlockLen = 1 + nameBytes.length;
    const namePad = nameBlockLen % 2 !== 0 ? 1 : 0;
    nameBlockLen += namePad;

    const dataPad = data.length % 2 !== 0 ? 1 : 0;

    const buf = Buffer.alloc(4 + 2 + nameBlockLen + 4 + data.length + dataPad);
    let o = 0;
    buf.write('8BIM', o, 'ascii'); o += 4;
    buf.writeUInt16BE(id, o); o += 2;
    buf.writeUInt8(nameBytes.length, o); o += 1;
    nameBytes.copy(buf, o); o += nameBytes.length;
    o += namePad;
    buf.writeUInt32BE(data.length, o); o += 4;
    data.copy(buf, o); o += data.length;
    // trailing pad byte(s) are already zeroed by Buffer.alloc

    return buf;
}

/** 16-byte ResolutionInfo resource data (hRes only matters to our parser). */
function buildResolutionInfoData(hResDpi, hResUnit = 1) {
    const buf = Buffer.alloc(16);
    buf.writeInt32BE(Math.round(hResDpi * 65536), 0);
    buf.writeUInt16BE(hResUnit, 4);
    buf.writeUInt16BE(1, 6); // widthUnit (unused)
    buf.writeInt32BE(Math.round(hResDpi * 65536), 8); // vRes (unused by parser)
    buf.writeUInt16BE(hResUnit, 12);
    buf.writeUInt16BE(1, 14); // heightUnit (unused)
    return buf;
}

function section(...blocks) {
    return Buffer.concat(blocks);
}

describe('parseResolutionInfo', () => {
    it('reads 300 DPI (pixels/inch)', () => {
        const buf = section(buildResourceBlock(0x03ED, '', buildResolutionInfoData(300, 1)));
        expect(parseResolutionInfo(buf, 0, buf.length)).toBeCloseTo(300, 2);
    });

    it('reads 72 DPI', () => {
        const buf = section(buildResourceBlock(0x03ED, '', buildResolutionInfoData(72, 1)));
        expect(parseResolutionInfo(buf, 0, buf.length)).toBeCloseTo(72, 2);
    });

    it('reads 600 DPI', () => {
        const buf = section(buildResourceBlock(0x03ED, '', buildResolutionInfoData(600, 1)));
        expect(parseResolutionInfo(buf, 0, buf.length)).toBeCloseTo(600, 2);
    });

    it('converts pixels/cm to pixels/inch (unit = 2)', () => {
        // 118.11 px/cm * 2.54 = 300.0 px/inch
        const buf = section(buildResourceBlock(0x03ED, '', buildResolutionInfoData(118.11, 2)));
        expect(parseResolutionInfo(buf, 0, buf.length)).toBeCloseTo(300, 0);
    });

    it('skips preceding unrelated resources to find ResolutionInfo', () => {
        const displayInfo = buildResourceBlock(1077, '', Buffer.alloc(14));
        const resInfo = buildResourceBlock(0x03ED, '', buildResolutionInfoData(240, 1));
        const buf = section(displayInfo, resInfo);
        expect(parseResolutionInfo(buf, 0, buf.length)).toBeCloseTo(240, 2);
    });

    it('handles a non-empty Pascal string name (odd-length padding)', () => {
        // 3-char name -> 1+3=4 bytes, already even, no pad needed; verifies
        // the name-length walk doesn't desync the offset for what follows.
        const named = buildResourceBlock(9999, 'abc', Buffer.alloc(4));
        const resInfo = buildResourceBlock(0x03ED, '', buildResolutionInfoData(150, 1));
        const buf = section(named, resInfo);
        expect(parseResolutionInfo(buf, 0, buf.length)).toBeCloseTo(150, 2);
    });

    it('returns null when no ResolutionInfo resource is present', () => {
        const buf = section(buildResourceBlock(1077, '', Buffer.alloc(14)));
        expect(parseResolutionInfo(buf, 0, buf.length)).toBeNull();
    });

    it('returns null for an empty Image Resources section', () => {
        const buf = Buffer.alloc(0);
        expect(parseResolutionInfo(buf, 0, 0)).toBeNull();
    });
});

// Smallest valid JPEG byte sequence — matches reveal-psd-writer's own
// test convention (test/fillmask-regression.test.js).
const MIN_JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02, 0x00, 0x00, 0xFF, 0xD9]);

describe('readPsd — dpi field end to end', () => {
    it('surfaces dpi from a real PSDWriter-generated 8-bit Lab PSD', async () => {
        const { PSDWriter } = require('@electrosaur-labs/psd-writer');
        const width = 4, height = 4;
        const mask = new Uint8Array(width * height).fill(255);
        const writer = new PSDWriter({ width, height, colorMode: 'lab', bitsPerChannel: 8, compression: 'none' });
        writer.addFillLayer({ name: 'Test', color: { L: 50, a: 0, b: 0 }, mask });
        writer.setComposite(new Uint8Array(width * height * 3).fill(128));
        writer.setThumbnail({ jpegData: MIN_JPEG, width: 2, height: 2 });
        const buf = writer.write();

        const psd = readPsd(Buffer.from(buf));
        // PSDWriter currently always writes 300 DPI (see PSDWriter.js _writeImageResources).
        expect(psd.dpi).toBeCloseTo(300, 2);
    });
});
