#!/usr/bin/env node
/**
 * Create a compact 16-bit Lab test fixture from horse PSD.
 *
 * Reads 0B9A4230-original-16bit-512px.psd (350×512, 16-bit Lab) via
 * reveal-psd-reader, converts PSD 16-bit to engine 16-bit Lab, and writes
 * a gzip-compressed .labbin file.
 *
 * Output format (.labbin.gz):
 *   Bytes 0-3:   magic "LAB\0"
 *   Bytes 4-7:   width  (uint32 LE)
 *   Bytes 8-11:  height (uint32 LE)
 *   Bytes 12-13: bitDepth (uint16 LE) — always 16
 *   Bytes 14+:   Uint16Array Lab pixels (L,a,b triples, engine format 0-32768)
 *
 * Usage:
 *   node create-horse-fixture.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { readPsd } = require('/workspaces/electrosaur/reveal-project/packages/reveal-psd-reader');
const LabEncoding = require('../../lib/color/LabEncoding');

const SOURCE_PSD = '/workspaces/electrosaur/fixtures/0B9A4230-original-16bit-512px.psd';
const OUTPUT_FILE = path.join(__dirname, 'horse-350x512-lab16.labbin.gz');

console.log(`Reading ${SOURCE_PSD}...`);
const psdBuffer = fs.readFileSync(SOURCE_PSD);
const psd = readPsd(psdBuffer);
console.log(`  PSD: ${psd.width}×${psd.height} depth=${psd.depth}`);

const pixelCount = psd.width * psd.height;

// Convert PSD 16-bit (0-65535, 32768=neutral) to engine 16-bit (0-32768, 16384=neutral)
const lab16 = LabEncoding.convertPsd16bitToEngineLab(psd.data, pixelCount);
console.log(`  Converted to engine Lab: ${lab16.length} values (${pixelCount} pixels)`);

// Verify pixel variation
const uniqueL = new Set();
for (let i = 0; i < pixelCount; i++) uniqueL.add(lab16[i * 3]);
console.log(`  Unique L values: ${uniqueL.size}`);

// Build binary: magic + dimensions + pixel data
const header = Buffer.alloc(14);
header.write('LAB\0', 0, 4, 'ascii');
header.writeUInt32LE(psd.width, 4);
header.writeUInt32LE(psd.height, 8);
header.writeUInt16LE(16, 12);

const pixelBytes = Buffer.from(lab16.buffer, lab16.byteOffset, lab16.byteLength);
const uncompressed = Buffer.concat([header, pixelBytes]);
console.log(`  Uncompressed: ${(uncompressed.length / 1024).toFixed(0)} KB`);

const compressed = zlib.gzipSync(uncompressed, { level: 9 });
console.log(`  Compressed:   ${(compressed.length / 1024).toFixed(0)} KB`);

fs.writeFileSync(OUTPUT_FILE, compressed);
console.log(`\n✓ Written to ${OUTPUT_FILE}`);
