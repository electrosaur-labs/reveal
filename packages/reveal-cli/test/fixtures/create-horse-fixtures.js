#!/usr/bin/env node
/**
 * create-horse-fixtures.js — Generate test image fixtures for ingest tests.
 *
 * Reads the full-size Photoshop-exported horse TIFFs + PSD from cli-test/,
 * crops a 64×64 region (the horse's face — interesting colors), and writes
 * small fixture files in every supported format variant:
 *
 *   horse-lab16.tif    — 16-bit CIELab TIFF, LZW
 *   horse-lab8.tif     — 8-bit CIELab TIFF, LZW
 *   horse-rgb16.tif    — 16-bit RGB TIFF, LZW
 *   horse-rgb8.tif     — 8-bit RGB TIFF, LZW
 *   horse-rgb8.png     — 8-bit RGB PNG
 *   horse-rgb8.jpg     — 8-bit RGB JPEG
 *   horse-lab16.psd    — 16-bit Lab PSD (reference)
 *
 * Also writes horse-reference.json with per-pixel Lab values (engine encoding)
 * from the PSD, so tests can cross-validate all formats against ground truth.
 *
 * Usage:
 *   node test/fixtures/create-horse-fixtures.js
 *
 * Prerequisites: full-size files must exist in ../../cli-test/:
 *   0B9A4230-original-16bit.tif  (16-bit Lab TIFF from Photoshop)
 *   0B9A4230-original-16bit.psd  (16-bit Lab PSD from Photoshop)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { LabEncoding } = require('@electrosaur-labs/core');
const { readPsd } = require('@electrosaur-labs/psd-reader');

// Target size for the scaled fixture
const TARGET_W = 64;
const TARGET_H = 64;

const CLI_TEST = path.resolve(__dirname, '../../../../../cli-test');
const FIXTURE_DIR = __dirname;

// ── Deflate compression for TIFF (compression type 8 / 32946) ───────────
// utif2 expects: 2-byte zlib header + deflateRaw data + 4-byte adler32
// It strips off+2 and len-6, then calls pako.inflateRaw on the middle.

function deflateForTiff(data) {
    // Use Node zlib deflateSync which produces zlib-wrapped output
    // (2-byte header + raw deflate + 4-byte checksum) — exactly what utif2 expects
    return zlib.deflateSync(Buffer.from(data));
}

// ── Minimal PNG writer (pure JS) ────────────────────────────────────────

function writePng(rgb8, width, height) {
    // Build IDAT payload: filter byte (0=None) + row data for each row
    const rowSize = 1 + width * 3; // filter byte + RGB
    const raw = Buffer.alloc(rowSize * height);
    for (let y = 0; y < height; y++) {
        raw[y * rowSize] = 0; // filter: None
        rgb8.copy
            ? rgb8.copy(raw, y * rowSize + 1, y * width * 3, (y + 1) * width * 3)
            : raw.set(rgb8.subarray(y * width * 3, (y + 1) * width * 3), y * rowSize + 1);
    }
    // For Uint8Array that doesn't have .copy:
    const rawBuf = Buffer.from(raw);

    const deflated = zlib.deflateSync(rawBuf);

    function crc32(buf) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            crc ^= buf[i];
            for (let j = 0; j < 8; j++) {
                crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
            }
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function chunk(type, data) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const typeAndData = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(typeAndData), 0);
        return Buffer.concat([len, typeAndData, crc]);
    }

    // IHDR
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 2;  // color type: RGB
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    return Buffer.concat([
        signature,
        chunk('IHDR', ihdr),
        chunk('IDAT', deflated),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ── Minimal TIFF writer ─────────────────────────────────────────────────

function writeTiff(pixelData, width, height, opts) {
    const { photometric, bitsPerSample, samplesPerPixel } = opts;
    // photometric: 2=RGB, 8=CIELab
    // bitsPerSample: 8 or 16
    // samplesPerPixel: 3

    // Prepare raw strip data as byte array
    let stripBytes;
    if (bitsPerSample === 16) {
        // pixelData is Int16Array or Uint16Array — convert to bytes (little-endian)
        stripBytes = new Uint8Array(pixelData.length * 2);
        const dv = new DataView(stripBytes.buffer);
        for (let i = 0; i < pixelData.length; i++) {
            dv.setUint16(i * 2, pixelData[i] & 0xFFFF, true); // LE
        }
    } else {
        stripBytes = new Uint8Array(pixelData);
    }

    // Deflate compress (TIFF compression type 8)
    const compressed = deflateForTiff(stripBytes);

    // TIFF structure: header (8) + IFD + tag values + strip data
    // Tags we need:
    const tags = [
        // tag, type, count, value
        [256, 3, 1, width],           // ImageWidth (SHORT)
        [257, 3, 1, height],          // ImageLength (SHORT)
        [258, 3, samplesPerPixel, bitsPerSample], // BitsPerSample
        [259, 3, 1, 8],              // Compression: Deflate
        [262, 3, 1, photometric],     // PhotometricInterpretation
        [273, 4, 1, 0],              // StripOffsets (placeholder)
        [277, 3, 1, samplesPerPixel], // SamplesPerPixel
        [278, 3, 1, height],         // RowsPerStrip
        [279, 4, 1, compressed.length], // StripByteCounts
        [282, 5, 1, 0],              // XResolution (placeholder offset)
        [283, 5, 1, 0],              // YResolution (placeholder offset)
        [296, 3, 1, 2],              // ResolutionUnit: inch
    ];

    // If BitsPerSample has multiple values, we need an offset
    const bpsNeedsOffset = samplesPerPixel > 1;

    const numTags = tags.length;
    const ifdOffset = 8; // right after header
    const ifdSize = 2 + numTags * 12 + 4; // count + entries + next IFD ptr
    let dataOffset = ifdOffset + ifdSize;

    // Allocate space for BitsPerSample array if needed
    let bpsOffset = 0;
    if (bpsNeedsOffset) {
        bpsOffset = dataOffset;
        dataOffset += samplesPerPixel * 2; // SHORT values
    }

    // XResolution rational (8 bytes: num + denom)
    const xResOffset = dataOffset;
    dataOffset += 8;
    // YResolution rational
    const yResOffset = dataOffset;
    dataOffset += 8;

    // Strip data
    const stripOffset = dataOffset;
    dataOffset += compressed.length;

    // Total file size
    const fileSize = dataOffset;
    const buf = Buffer.alloc(fileSize);

    // ── Header ──
    buf.write('II', 0);          // Little-endian
    buf.writeUInt16LE(42, 2);    // TIFF magic
    buf.writeUInt32LE(ifdOffset, 4); // Offset to first IFD

    // ── IFD ──
    let pos = ifdOffset;
    buf.writeUInt16LE(numTags, pos); pos += 2;

    for (const [tag, type, count, value] of tags) {
        buf.writeUInt16LE(tag, pos); pos += 2;
        buf.writeUInt16LE(type, pos); pos += 2;
        buf.writeUInt32LE(count, pos); pos += 4;

        if (tag === 258 && bpsNeedsOffset) {
            // BitsPerSample: offset to array
            buf.writeUInt32LE(bpsOffset, pos);
        } else if (tag === 273) {
            buf.writeUInt32LE(stripOffset, pos);
        } else if (tag === 282) {
            buf.writeUInt32LE(xResOffset, pos);
        } else if (tag === 283) {
            buf.writeUInt32LE(yResOffset, pos);
        } else if (type === 3) { // SHORT
            buf.writeUInt16LE(value, pos);
        } else if (type === 4) { // LONG
            buf.writeUInt32LE(value, pos);
        }
        pos += 4; // value/offset field
    }
    buf.writeUInt32LE(0, pos); // Next IFD = none

    // ── BitsPerSample array ──
    if (bpsNeedsOffset) {
        for (let i = 0; i < samplesPerPixel; i++) {
            buf.writeUInt16LE(bitsPerSample, bpsOffset + i * 2);
        }
    }

    // ── Resolution rationals (72 dpi) ──
    buf.writeUInt32LE(72, xResOffset);
    buf.writeUInt32LE(1, xResOffset + 4);
    buf.writeUInt32LE(72, yResOffset);
    buf.writeUInt32LE(1, yResOffset + 4);

    // ── Strip data ──
    compressed.copy(buf, stripOffset);

    return buf;
}

// ── PSD writer (minimal 16-bit Lab, single merged layer) ────────────────

function writeMinimalPsd(labData, width, height) {
    // labData: Uint16Array of L,a,b triples in PSD encoding (0-65535, 32768=neutral a/b)
    const pixelCount = width * height;

    // PSD file structure:
    // 1. File header (26 bytes)
    // 2. Color mode data (4 bytes: length=0)
    // 3. Image resources (4 bytes: length=0)
    // 4. Layer and mask info (4 bytes: length=0)
    // 5. Image data: compression(2) + channel data

    // Channel data: L, a, b each as separate planes, raw (no compression)
    const channelSize = pixelCount * 2; // 16-bit
    const imageDataSize = 2 + channelSize * 3; // compression type + 3 channels

    const fileSize = 26 + 4 + 4 + 4 + imageDataSize;
    const buf = Buffer.alloc(fileSize);
    let pos = 0;

    // File header
    buf.write('8BPS', pos); pos += 4;           // Signature
    buf.writeUInt16BE(1, pos); pos += 2;        // Version
    buf.fill(0, pos, pos + 6); pos += 6;        // Reserved
    buf.writeUInt16BE(3, pos); pos += 2;        // Channels: 3 (L,a,b)
    buf.writeUInt32BE(height, pos); pos += 4;   // Height
    buf.writeUInt32BE(width, pos); pos += 4;    // Width
    buf.writeUInt16BE(16, pos); pos += 2;       // Depth: 16-bit
    buf.writeUInt16BE(9, pos); pos += 2;        // Color mode: 9=Lab

    // Color mode data
    buf.writeUInt32BE(0, pos); pos += 4;

    // Image resources
    buf.writeUInt32BE(0, pos); pos += 4;

    // Layer and mask info
    buf.writeUInt32BE(0, pos); pos += 4;

    // Image data
    buf.writeUInt16BE(0, pos); pos += 2; // Compression: 0=raw

    // Write planar channel data (L plane, then a plane, then b plane) — big-endian
    for (let ch = 0; ch < 3; ch++) {
        for (let i = 0; i < pixelCount; i++) {
            buf.writeUInt16BE(labData[i * 3 + ch], pos); pos += 2;
        }
    }

    return buf;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
    // Read the source 16-bit Lab PSD
    const psdPath = path.join(CLI_TEST, '0B9A4230-original-16bit.psd');
    if (!fs.existsSync(psdPath)) {
        console.error(`Source PSD not found: ${psdPath}`);
        console.error('Place the 16-bit Lab horse PSD in cli-test/');
        process.exit(1);
    }

    console.log(`Reading source PSD: ${psdPath}`);
    const psdBuffer = fs.readFileSync(psdPath);
    const psd = readPsd(psdBuffer);
    console.log(`  Full size: ${psd.width}×${psd.height}, depth=${psd.depth}`);

    const srcW = psd.width;
    const srcH = psd.height;

    const expectedInterleaved = srcW * srcH * 3;
    if (psd.data.length !== expectedInterleaved) {
        console.error(`Unexpected data length: ${psd.data.length} (expected ${expectedInterleaved})`);
        process.exit(1);
    }

    // Nearest-neighbor downscale to TARGET_W × TARGET_H
    // Preserves exact pixel values (no interpolation blurring)
    const dstW = TARGET_W;
    const dstH = TARGET_H;
    console.log(`  Scaling ${srcW}×${srcH} → ${dstW}×${dstH} (nearest-neighbor)...`);
    const cropPixels = dstW * dstH;
    const psdCrop = new Uint16Array(cropPixels * 3);
    for (let y = 0; y < dstH; y++) {
        const srcY = Math.floor(y * srcH / dstH);
        for (let x = 0; x < dstW; x++) {
            const srcX = Math.floor(x * srcW / dstW);
            const srcIdx = (srcY * srcW + srcX) * 3;
            const dstIdx = (y * dstW + x) * 3;
            psdCrop[dstIdx]     = psd.data[srcIdx];
            psdCrop[dstIdx + 1] = psd.data[srcIdx + 1];
            psdCrop[dstIdx + 2] = psd.data[srcIdx + 2];
        }
    }

    // Convert PSD 16-bit to engine Lab for reference
    const engineLab = LabEncoding.convertPsd16bitToEngineLab(psdCrop, cropPixels);

    // Save reference as JSON (first 10 pixels + stats for verification)
    const reference = {
        width: dstW,
        height: dstH,
        method: `nearest-neighbor downscale from ${srcW}×${srcH}`,
        source: '0B9A4230-original-16bit.psd',
        encoding: 'engine-lab16 (L: 0-32768, a/b: 0-32768, 16384=neutral)',
        samplePixels: [],
        allPixels: Array.from(engineLab),
    };
    for (let i = 0; i < Math.min(20, cropPixels); i++) {
        const L = engineLab[i * 3];
        const a = engineLab[i * 3 + 1];
        const b = engineLab[i * 3 + 2];
        const percep = LabEncoding.engine16ToPerceptual(L, a, b);
        reference.samplePixels.push({
            index: i,
            engine: { L, a, b },
            perceptual: { L: +percep.L.toFixed(2), a: +percep.a.toFixed(2), b: +percep.b.toFixed(2) },
        });
    }
    const refPath = path.join(FIXTURE_DIR, 'horse-reference.json');
    fs.writeFileSync(refPath, JSON.stringify(reference, null, 2));
    console.log(`  ✓ ${refPath} (${cropPixels} pixels)`);

    // ── 1. 16-bit CIELab TIFF ──────────────────────────────────────────
    // TIFF CIELab 16-bit: L unsigned 0-65535, a/b signed Int16 (value/256 = a*/b*)
    {
        const tiffData = new Uint16Array(cropPixels * 3);
        for (let i = 0; i < cropPixels; i++) {
            const eL = engineLab[i * 3];
            const ea = engineLab[i * 3 + 1];
            const eb = engineLab[i * 3 + 2];
            // Engine → perceptual
            const percep = LabEncoding.engine16ToPerceptual(eL, ea, eb);
            // Perceptual → TIFF CIELab
            const tiffL = Math.round((percep.L / 100) * 65535);           // L* 0-100 → 0-65535 unsigned
            const tiffA = Math.round(percep.a * 256);                     // a* → signed * 256
            const tiffB = Math.round(percep.b * 256);                     // b* → signed * 256
            tiffData[i * 3] = tiffL & 0xFFFF;
            tiffData[i * 3 + 1] = tiffA & 0xFFFF;  // stored as uint16 but represents signed
            tiffData[i * 3 + 2] = tiffB & 0xFFFF;
        }
        const tiffBuf = writeTiff(tiffData, dstW, dstH, {
            photometric: 8, bitsPerSample: 16, samplesPerPixel: 3,
        });
        const p = path.join(FIXTURE_DIR, 'horse-lab16.tif');
        fs.writeFileSync(p, tiffBuf);
        console.log(`  ✓ ${path.basename(p)} (${tiffBuf.length} bytes)`);
    }

    // ── 2. 8-bit CIELab TIFF ───────────────────────────────────────────
    // TIFF CIELab 8-bit: L unsigned 0-255, a/b signed Int8 (value = a*/b*)
    {
        const tiffData = new Uint8Array(cropPixels * 3);
        for (let i = 0; i < cropPixels; i++) {
            const eL = engineLab[i * 3];
            const ea = engineLab[i * 3 + 1];
            const eb = engineLab[i * 3 + 2];
            const percep = LabEncoding.engine16ToPerceptual(eL, ea, eb);
            tiffData[i * 3] = Math.round((percep.L / 100) * 255);
            // Clamp to signed byte range (-128..+127) then store as unsigned
            const a8 = Math.max(-128, Math.min(127, Math.round(percep.a)));
            const b8 = Math.max(-128, Math.min(127, Math.round(percep.b)));
            tiffData[i * 3 + 1] = a8 & 0xFF;
            tiffData[i * 3 + 2] = b8 & 0xFF;
        }
        const tiffBuf = writeTiff(tiffData, dstW, dstH, {
            photometric: 8, bitsPerSample: 8, samplesPerPixel: 3,
        });
        const p = path.join(FIXTURE_DIR, 'horse-lab8.tif');
        fs.writeFileSync(p, tiffBuf);
        console.log(`  ✓ ${path.basename(p)} (${tiffBuf.length} bytes)`);
    }

    // ── 3. 16-bit RGB TIFF ──────────────────────────────────────────────
    // Use labToRgb (D65) — matches rgbToLab (D65) used in ingest converter
    {
        const tiffData = new Uint16Array(cropPixels * 3);
        for (let i = 0; i < cropPixels; i++) {
            const eL = engineLab[i * 3];
            const ea = engineLab[i * 3 + 1];
            const eb = engineLab[i * 3 + 2];
            const percep = LabEncoding.engine16ToPerceptual(eL, ea, eb);
            const rgb = LabEncoding.labToRgb(percep);
            tiffData[i * 3]     = Math.round((rgb.r / 255) * 65535);
            tiffData[i * 3 + 1] = Math.round((rgb.g / 255) * 65535);
            tiffData[i * 3 + 2] = Math.round((rgb.b / 255) * 65535);
        }
        const tiffBuf = writeTiff(tiffData, dstW, dstH, {
            photometric: 2, bitsPerSample: 16, samplesPerPixel: 3,
        });
        const p = path.join(FIXTURE_DIR, 'horse-rgb16.tif');
        fs.writeFileSync(p, tiffBuf);
        console.log(`  ✓ ${path.basename(p)} (${tiffBuf.length} bytes)`);
    }

    // ── 4. 8-bit RGB TIFF ───────────────────────────────────────────────
    // Use labToRgb (D65) — matches rgbToLab (D65) used in ingest converter
    {
        const tiffData = new Uint8Array(cropPixels * 3);
        for (let i = 0; i < cropPixels; i++) {
            const eL = engineLab[i * 3];
            const ea = engineLab[i * 3 + 1];
            const eb = engineLab[i * 3 + 2];
            const percep = LabEncoding.engine16ToPerceptual(eL, ea, eb);
            const rgb = LabEncoding.labToRgb(percep);
            tiffData[i * 3]     = rgb.r;
            tiffData[i * 3 + 1] = rgb.g;
            tiffData[i * 3 + 2] = rgb.b;
        }
        const tiffBuf = writeTiff(tiffData, dstW, dstH, {
            photometric: 2, bitsPerSample: 8, samplesPerPixel: 3,
        });
        const p = path.join(FIXTURE_DIR, 'horse-rgb8.tif');
        fs.writeFileSync(p, tiffBuf);
        console.log(`  ✓ ${path.basename(p)} (${tiffBuf.length} bytes)`);
    }

    // ── 5. 8-bit RGB PNG (pure JS — minimal valid PNG) ─────────────────
    {
        const rgb8 = new Uint8Array(cropPixels * 3);
        for (let i = 0; i < cropPixels; i++) {
            const eL = engineLab[i * 3];
            const ea = engineLab[i * 3 + 1];
            const eb = engineLab[i * 3 + 2];
            const percep = LabEncoding.engine16ToPerceptual(eL, ea, eb);
            const rgb = LabEncoding.labToRgbD50(percep);
            rgb8[i * 3]     = rgb.r;
            rgb8[i * 3 + 1] = rgb.g;
            rgb8[i * 3 + 2] = rgb.b;
        }
        const pngBuf = writePng(rgb8, dstW, dstH);
        const p = path.join(FIXTURE_DIR, 'horse-rgb8.png');
        fs.writeFileSync(p, pngBuf);
        console.log(`  ✓ ${path.basename(p)} (${pngBuf.length} bytes)`);
    }

    // ── 6. 8-bit RGB JPEG — skipped (JPEG encoding requires complex DCT) ──
    // JPEG test coverage uses the PNG fixture converted via sharp at test time.
    // If sharp is unavailable, JPEG ingest tests are skipped.
    console.log('  ⊘ horse-rgb8.jpg skipped (create manually or via sharp on Mac)');

    // ── 7. 16-bit Lab PSD (reference) ───────────────────────────────────
    {
        const psdData = new Uint16Array(cropPixels * 3);
        for (let i = 0; i < cropPixels; i++) {
            psdData[i * 3]     = psdCrop[i * 3];     // L (PSD encoding)
            psdData[i * 3 + 1] = psdCrop[i * 3 + 1]; // a (PSD encoding)
            psdData[i * 3 + 2] = psdCrop[i * 3 + 2]; // b (PSD encoding)
        }
        const psdBuf = writeMinimalPsd(psdData, dstW, dstH);
        const p = path.join(FIXTURE_DIR, 'horse-lab16.psd');
        fs.writeFileSync(p, psdBuf);
        console.log(`  ✓ ${path.basename(p)} (${psdBuf.length} bytes)`);
    }

    console.log('\nDone! All fixtures created in test/fixtures/');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
