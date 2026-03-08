/**
 * ora.js — OpenRaster (.ora) writer
 *
 * Creates ORA files (ZIP of PNGs + stack.xml).
 * Uses Node.js built-in zlib — no external ZIP library.
 *
 * ORA spec: https://www.freedesktop.org/wiki/Specifications/OpenRaster/
 */

const fs = require('fs');
const zlib = require('zlib');
const sharp = require('sharp');

/**
 * Write an OpenRaster file with colorized separation layers.
 *
 * @param {Array<{L,a,b}>} paletteLab
 * @param {Array<{r,g,b}>} paletteRgb
 * @param {Array<Uint8Array>} masks
 * @param {Uint32Array|Int32Array} colorIndices
 * @param {number} width
 * @param {number} height
 * @param {string} outputPath
 * @param {string[]} hexColors
 */
async function writeOra(paletteLab, paletteRgb, masks, colorIndices, width, height, outputPath, hexColors) {
    const entries = [];

    // 1. mimetype (MUST be first, stored uncompressed)
    entries.push({ name: 'mimetype', data: Buffer.from('image/openraster'), store: true });

    // 2. mergedimage.png — flat composite
    const mergedRgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const rgb = paletteRgb[colorIndices[i]];
        mergedRgba[i * 4]     = Math.round(rgb.r);
        mergedRgba[i * 4 + 1] = Math.round(rgb.g);
        mergedRgba[i * 4 + 2] = Math.round(rgb.b);
        mergedRgba[i * 4 + 3] = 255;
    }
    const mergedPng = await sharp(mergedRgba, {
        raw: { width, height, channels: 4 }
    }).png().toBuffer();
    entries.push({ name: 'mergedimage.png', data: mergedPng, store: false });

    // 3. Layer PNGs — colorized RGBA (palette color where ink, transparent elsewhere)
    // Sort by lightness descending (lightest on top in stack)
    const layerOrder = paletteLab.map((_, i) => i);
    layerOrder.sort((a, b) => paletteLab[b].L - paletteLab[a].L);

    const layerNames = [];
    for (let li = 0; li < layerOrder.length; li++) {
        const idx = layerOrder[li];
        const rgb = paletteRgb[idx];
        const hex = hexColors[idx];
        const mask = masks[idx];
        const name = `Ink ${li + 1} (${hex})`;
        const filename = `data/layer${String(li).padStart(2, '0')}_${hex.replace('#', '')}.png`;

        const rgba = Buffer.alloc(width * height * 4);
        const r = Math.round(rgb.r), g = Math.round(rgb.g), b = Math.round(rgb.b);
        for (let i = 0; i < width * height; i++) {
            if (mask[i] === 255) {
                rgba[i * 4] = r;
                rgba[i * 4 + 1] = g;
                rgba[i * 4 + 2] = b;
                rgba[i * 4 + 3] = 255;
            }
            // else stays 0,0,0,0 (transparent)
        }

        const layerPng = await sharp(rgba, {
            raw: { width, height, channels: 4 }
        }).png().toBuffer();

        entries.push({ name: filename, data: layerPng, store: false });
        layerNames.push({ name, src: filename });
    }

    // 4. stack.xml
    let stackXml = `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.3" w="${width}" h="${height}">\n  <stack>\n`;
    for (const layer of layerNames) {
        const escapedName = layer.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        stackXml += `    <layer name="${escapedName}" src="${layer.src}" x="0" y="0" opacity="1.0" visibility="visible" />\n`;
    }
    stackXml += `  </stack>\n</image>\n`;
    entries.push({ name: 'stack.xml', data: Buffer.from(stackXml), store: false });

    // Build ZIP
    const zipBuffer = buildZip(entries);
    fs.writeFileSync(outputPath, zipBuffer);
    return zipBuffer.length;
}

/**
 * Build a ZIP file from entries.
 * Minimal implementation supporting stored and deflated entries.
 */
function buildZip(entries) {
    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBuffer = Buffer.from(entry.name, 'utf8');
        const uncompressedData = entry.data;
        const compressedData = entry.store ? uncompressedData : zlib.deflateRawSync(uncompressedData);
        const crc = crc32(uncompressedData);
        const method = entry.store ? 0 : 8; // 0=stored, 8=deflated

        // Local file header (30 + name + data)
        const local = Buffer.alloc(30 + nameBuffer.length);
        local.writeUInt32LE(0x04034b50, 0);   // signature
        local.writeUInt16LE(20, 4);            // version needed
        local.writeUInt16LE(0, 6);             // flags
        local.writeUInt16LE(method, 8);        // compression
        local.writeUInt16LE(0, 10);            // mod time
        local.writeUInt16LE(0, 12);            // mod date
        local.writeUInt32LE(crc, 14);          // crc32
        local.writeUInt32LE(compressedData.length, 18);   // compressed size
        local.writeUInt32LE(uncompressedData.length, 22); // uncompressed size
        local.writeUInt16LE(nameBuffer.length, 26);       // name length
        local.writeUInt16LE(0, 28);            // extra length
        nameBuffer.copy(local, 30);

        localHeaders.push(Buffer.concat([local, compressedData]));

        // Central directory header (46 + name)
        const central = Buffer.alloc(46 + nameBuffer.length);
        central.writeUInt32LE(0x02014b50, 0);  // signature
        central.writeUInt16LE(20, 4);           // version made by
        central.writeUInt16LE(20, 6);           // version needed
        central.writeUInt16LE(0, 8);            // flags
        central.writeUInt16LE(method, 10);      // compression
        central.writeUInt16LE(0, 12);           // mod time
        central.writeUInt16LE(0, 14);           // mod date
        central.writeUInt32LE(crc, 16);         // crc32
        central.writeUInt32LE(compressedData.length, 20);   // compressed size
        central.writeUInt32LE(uncompressedData.length, 24); // uncompressed size
        central.writeUInt16LE(nameBuffer.length, 28);       // name length
        central.writeUInt16LE(0, 30);           // extra length
        central.writeUInt16LE(0, 32);           // comment length
        central.writeUInt16LE(0, 34);           // disk start
        central.writeUInt16LE(0, 36);           // internal attrs
        central.writeUInt32LE(0, 38);           // external attrs
        central.writeUInt32LE(offset, 42);      // local header offset
        nameBuffer.copy(central, 46);

        centralHeaders.push(central);
        offset += local.length + compressedData.length;
    }

    // End of central directory
    const centralDirOffset = offset;
    const centralDirData = Buffer.concat(centralHeaders);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);                    // signature
    eocd.writeUInt16LE(0, 4);                              // disk number
    eocd.writeUInt16LE(0, 6);                              // disk with central dir
    eocd.writeUInt16LE(entries.length, 8);                  // entries on this disk
    eocd.writeUInt16LE(entries.length, 10);                 // total entries
    eocd.writeUInt32LE(centralDirData.length, 12);         // central dir size
    eocd.writeUInt32LE(centralDirOffset, 16);              // central dir offset
    eocd.writeUInt16LE(0, 20);                             // comment length

    return Buffer.concat([...localHeaders, centralDirData, eocd]);
}

/**
 * CRC32 implementation for ZIP.
 */
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

module.exports = { writeOra };
