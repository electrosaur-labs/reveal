#!/usr/bin/env node
/**
 * Create a compact test fixture from JethroAsMonroe-original-16bit.psd.
 *
 * Reads the full-res PSD (5700×3900), downsamples to ~1600px long edge
 * via bilinear interpolation, and writes a compact binary file containing
 * the 16-bit Lab pixel buffer + dimensions header.
 *
 * Output format (.labbin):
 *   Bytes 0-3:   magic "LAB\0"
 *   Bytes 4-7:   width  (uint32 LE)
 *   Bytes 8-11:  height (uint32 LE)
 *   Bytes 12-13: bitDepth (uint16 LE) — always 16
 *   Bytes 14+:   Uint16Array Lab pixels (L,a,b triples, engine format 0-32768)
 *
 * Usage:
 *   node create-jethro-fixture.js
 *
 * Requires: reveal-psd-reader (reads PSD) + zlib (compress)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readPsd } = require('/workspaces/electrosaur/reveal-project/packages/reveal-psd-reader');

const FIXTURES_DIR = '/workspaces/electrosaur/fixtures';
const SOURCE_PSD = path.join(FIXTURES_DIR, 'JethroAsMonroe-original-16bit.psd');
const TARGET_SIZE = 1600; // Long edge target

const OUTPUT_DIR = path.join(__dirname);
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'jethro-1600.labbin.gz');

// ─── PSD 16-bit → Engine Lab conversion ────────────────────

function convertPsd16bitToEngineLab(psdData, pixelCount) {
    // reveal-psd-reader returns 3-channel Lab (no alpha):
    //   L: 0-65535, a: 0-65535 (32768=neutral), b: 0-65535 (32768=neutral)
    //
    // Engine expects half-range:
    //   L: 0-32768, a: 0-32768 (16384=neutral), b: 0-32768 (16384=neutral)

    const output = new Uint16Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const idx = i * 3;
        output[idx]     = psdData[idx] >> 1;
        output[idx + 1] = psdData[idx + 1] >> 1;
        output[idx + 2] = psdData[idx + 2] >> 1;
    }
    return output;
}

// ─── Bilinear downsample ────────────────────────────────────

function downsampleBilinear(labPixels, srcWidth, srcHeight, targetLongEdge) {
    const longEdge = Math.max(srcWidth, srcHeight);
    const scale = targetLongEdge / longEdge;
    const dstWidth = Math.round(srcWidth * scale);
    const dstHeight = Math.round(srcHeight * scale);

    const dstBuffer = new Uint16Array(dstWidth * dstHeight * 3);

    for (let y = 0; y < dstHeight; y++) {
        for (let x = 0; x < dstWidth; x++) {
            const srcX = x / scale;
            const srcY = y / scale;

            const x0 = Math.floor(srcX);
            const y0 = Math.floor(srcY);
            const x1 = Math.min(x0 + 1, srcWidth - 1);
            const y1 = Math.min(y0 + 1, srcHeight - 1);

            const fx = srcX - x0;
            const fy = srcY - y0;

            for (let c = 0; c < 3; c++) {
                const v00 = labPixels[(y0 * srcWidth + x0) * 3 + c];
                const v10 = labPixels[(y0 * srcWidth + x1) * 3 + c];
                const v01 = labPixels[(y1 * srcWidth + x0) * 3 + c];
                const v11 = labPixels[(y1 * srcWidth + x1) * 3 + c];

                const v0 = v00 * (1 - fx) + v10 * fx;
                const v1 = v01 * (1 - fx) + v11 * fx;
                const v = v0 * (1 - fy) + v1 * fy;

                dstBuffer[(y * dstWidth + x) * 3 + c] = Math.round(v);
            }
        }
    }

    return { buffer: dstBuffer, width: dstWidth, height: dstHeight };
}

// ─── Main ───────────────────────────────────────────────────

console.log(`Reading ${SOURCE_PSD}...`);
const psdBuffer = fs.readFileSync(SOURCE_PSD);
const psd = readPsd(psdBuffer);
console.log(`  PSD: ${psd.width}×${psd.height}`);

const pixelCount = psd.width * psd.height;
const engineLab = convertPsd16bitToEngineLab(psd.data, pixelCount);
console.log(`  Converted to engine Lab: ${engineLab.length} values (${pixelCount} pixels)`);

const { buffer: downsampled, width: dstW, height: dstH } =
    downsampleBilinear(engineLab, psd.width, psd.height, TARGET_SIZE);
console.log(`  Downsampled to ${dstW}×${dstH} (${downsampled.length} values)`);

// Build binary: magic + dimensions + pixel data
const header = Buffer.alloc(14);
header.write('LAB\0', 0, 4, 'ascii');
header.writeUInt32LE(dstW, 4);
header.writeUInt32LE(dstH, 8);
header.writeUInt16LE(16, 12);

const pixelBytes = Buffer.from(downsampled.buffer, downsampled.byteOffset, downsampled.byteLength);
const uncompressed = Buffer.concat([header, pixelBytes]);
console.log(`  Uncompressed: ${(uncompressed.length / 1024 / 1024).toFixed(1)} MB`);

// Gzip compress
const compressed = zlib.gzipSync(uncompressed, { level: 9 });
console.log(`  Compressed:   ${(compressed.length / 1024 / 1024).toFixed(1)} MB`);

fs.writeFileSync(OUTPUT_FILE, compressed);
console.log(`\n✓ Written to ${OUTPUT_FILE}`);
console.log(`  To read in tests:`);
console.log(`    const zlib = require('zlib');`);
console.log(`    const raw = zlib.gunzipSync(fs.readFileSync('${path.basename(OUTPUT_FILE)}'));`);
console.log(`    const width = raw.readUInt32LE(4);`);
console.log(`    const height = raw.readUInt32LE(8);`);
console.log(`    const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);`);
