/**
 * ingest-dpi.test.js — Unit tests for real-DPI extraction from input files.
 *
 * "The dpi must ALWAYS come from the input document" — these verify each
 * format actually reads it rather than guessing. Resolution of what to do
 * when a file has none (CLI flag / fallback+warning) is tested separately
 * in cli.test.js; this file is scoped to "what does ingest() report."
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const UTIF = require('utif2');
const { PSDWriter } = require('@electrosaur-labs/psd-writer');
const { ingest, extractTiffDpi } = require('../../src/ingest');

let tmpDir;

afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
});

function tmpFile(name) {
    tmpDir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-dpi-test-'));
    return path.join(tmpDir, name);
}

describe('extractTiffDpi', () => {
    it('reads a RATIONAL XResolution tagged as pixels/inch (unit 2)', () => {
        expect(extractTiffDpi({ t282: [[600, 1]], t296: [2] })).toBeCloseTo(600, 2);
    });

    it('converts pixels/cm (unit 3) to pixels/inch', () => {
        // 118.11 px/cm ~= 300 px/inch
        expect(extractTiffDpi({ t282: [[11811, 100]], t296: [3] })).toBeCloseTo(300, 0);
    });

    it('treats unit 1 ("no absolute unit") as no real dpi, even with a ratio present', () => {
        expect(extractTiffDpi({ t282: [[72, 1]], t296: [1] })).toBeNull();
    });

    it('returns null when the XResolution tag is absent entirely', () => {
        expect(extractTiffDpi({ t296: [2] })).toBeNull();
    });

    it('returns null when ResolutionUnit is absent', () => {
        expect(extractTiffDpi({ t282: [[300, 1]] })).toBeNull();
    });
});

describe('ingest() — real dpi per format', () => {
    it('PNG: reads density from the pHYs chunk', async () => {
        const file = tmpFile('test.png');
        await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 128, g: 64, b: 32 } } })
            .withMetadata({ density: 600 })
            .png()
            .toFile(file);

        const result = await ingest(file);
        expect(result.dpi).toBeCloseTo(600, 0);
    });

    it('PNG: dpi is null when the file carries no density metadata', async () => {
        const file = tmpFile('test-nodpi.png');
        await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } } })
            .png()
            .toFile(file);

        const result = await ingest(file);
        expect(result.dpi).toBeNull();
    });

    it('TIFF: reads XResolution/ResolutionUnit tags', async () => {
        const file = tmpFile('test.tiff');
        const w = 2, h = 2;
        const rgba = new Uint8Array(w * h * 4).fill(100);
        const buf = UTIF.encodeImage(rgba, w, h, { t282: [[450, 1]], t283: [[450, 1]], t296: [2] });
        fs.writeFileSync(file, Buffer.from(buf));

        const result = await ingest(file);
        expect(result.dpi).toBeCloseTo(450, 0);
    });

    it('PSD: reads ResolutionInfo (PSDWriter currently always writes 300)', async () => {
        const file = tmpFile('test.psd');
        const width = 4, height = 4;
        const mask = new Uint8Array(width * height).fill(255);
        const writer = new PSDWriter({ width, height, colorMode: 'lab', bitsPerChannel: 8, compression: 'none' });
        writer.addFillLayer({ name: 'Test', color: { L: 50, a: 0, b: 0 }, mask });
        writer.setComposite(new Uint8Array(width * height * 3).fill(128));
        writer.setThumbnail({
            jpegData: Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02, 0x00, 0x00, 0xFF, 0xD9]),
            width: 2, height: 2
        });
        fs.writeFileSync(file, Buffer.from(writer.write()));

        const result = await ingest(file);
        expect(result.dpi).toBeCloseTo(300, 0);
    });
});
