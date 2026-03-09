#!/usr/bin/env node
/**
 * Create compact .labbin.gz test fixtures from 16-bit Lab PSDs.
 *
 * Reads a PSD, downsamples to target long edge via bilinear interpolation,
 * and writes a gzipped binary file containing the 16-bit Lab pixel buffer.
 *
 * Output format (.labbin.gz):
 *   Bytes 0-3:   magic "LAB\0"
 *   Bytes 4-7:   width  (uint32 LE)
 *   Bytes 8-11:  height (uint32 LE)
 *   Bytes 12-13: bitDepth (uint16 LE) — always 16
 *   Bytes 14+:   Uint16Array Lab pixels (L,a,b triples, engine format 0-32768)
 *
 * Usage:
 *   node create-labbin-fixture.js <source.psd> <long-edge> [output-name]
 *
 * Examples:
 *   node create-labbin-fixture.js /path/to/Jethro.psd 3200 jethro-3200
 *   node create-labbin-fixture.js /path/to/horse.psd 800 horse-800
 *
 * Requires: reveal-psd-reader
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readPsd } = require('@electrosaur-labs/psd-reader');

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('Usage: node create-labbin-fixture.js <source.psd> <long-edge> [output-name]');
    process.exit(1);
}

const SOURCE_PSD = args[0];
const TARGET_SIZE = parseInt(args[1], 10);
const OUTPUT_NAME = args[2] || path.basename(SOURCE_PSD, '.psd').toLowerCase();
const OUTPUT_FILE = path.join(__dirname, `${OUTPUT_NAME}-lab16.labbin.gz`);

// ─── PSD → Engine Lab conversion ─────────────────────────────

function convertPsdToEngineLab(psdData, pixelCount) {
    // Detect bit depth from data range
    let max = 0;
    for (let i = 0; i < Math.min(psdData.length, 30000); i++) {
        if (psdData[i] > max) max = psdData[i];
    }
    const is16bit = max > 255;

    const output = new Uint16Array(pixelCount * 3);
    if (is16bit) {
        // 16-bit PSD: L 0-65535, a/b 0-65535 (32768=neutral)
        // Engine: L 0-32768, a/b 0-32768 (16384=neutral)
        for (let i = 0; i < pixelCount * 3; i++) {
            output[i] = psdData[i] >> 1;
        }
        console.log('  Detected 16-bit Lab (max=' + max + ')');
    } else {
        // 8-bit PSD: L 0-255, a 0-255, b 0-255
        // Engine: L 0-32768, a/b 0-32768 (16384=neutral)
        for (let i = 0; i < pixelCount; i++) {
            const idx = i * 3;
            output[idx]     = Math.round(psdData[idx] / 255 * 32768);
            output[idx + 1] = Math.round(psdData[idx + 1] / 255 * 32768);
            output[idx + 2] = Math.round(psdData[idx + 2] / 255 * 32768);
        }
        console.log('  Detected 8-bit Lab (max=' + max + ')');
    }
    return output;
}

// ─── Bilinear downsample ────────────────────────────────────

function downsampleBilinear(labPixels, srcWidth, srcHeight, targetLongEdge) {
    const longEdge = Math.max(srcWidth, srcHeight);
    if (targetLongEdge >= longEdge) {
        return { buffer: labPixels, width: srcWidth, height: srcHeight };
    }
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
                dstBuffer[(y * dstWidth + x) * 3 + c] = Math.round(v0 * (1 - fy) + v1 * fy);
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
const engineLab = convertPsdToEngineLab(psd.data, pixelCount);
console.log(`  Converted to engine Lab: ${pixelCount} pixels`);

const { buffer: downsampled, width: dstW, height: dstH } =
    downsampleBilinear(engineLab, psd.width, psd.height, TARGET_SIZE);
console.log(`  Downsampled to ${dstW}×${dstH}`);

const header = Buffer.alloc(14);
header.write('LAB\0', 0, 4, 'ascii');
header.writeUInt32LE(dstW, 4);
header.writeUInt32LE(dstH, 8);
header.writeUInt16LE(16, 12);

const pixelBytes = Buffer.from(downsampled.buffer, downsampled.byteOffset, downsampled.byteLength);
const uncompressed = Buffer.concat([header, pixelBytes]);
const compressed = zlib.gzipSync(uncompressed, { level: 9 });

console.log(`  Raw: ${(uncompressed.length / 1024 / 1024).toFixed(1)} MB`);
console.log(`  Gzipped: ${(compressed.length / 1024 / 1024).toFixed(1)} MB`);

fs.writeFileSync(OUTPUT_FILE, compressed);
console.log(`\n✓ ${OUTPUT_FILE}`);
