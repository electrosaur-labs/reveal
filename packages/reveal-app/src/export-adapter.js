/**
 * export-adapter.js — Export a separation result in multiple formats.
 *
 * Supported: ora (OpenRaster), png (flat posterized), psd (Lab fill+mask layers).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const Reveal = require('@electrosaur-labs/core');
const { LabEncoding } = Reveal;

const OUT_DIR = path.join(__dirname, '..', 'output');

function ensureOutDir() {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

/**
 * Run full-res separation from a card's proxy palette.
 * Returns colorIndices, masks, and derived data needed by all formats.
 */
async function separate(card, session) {
    const { lab16bit, width, height } = session;
    const { _paletteLab: paletteLab, _paletteRgb: paletteRgb, _config: config } = card;

    const SeparationEngine = Reveal.engines.SeparationEngine;
    const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
        lab16bit, paletteLab, null, width, height,
        { ditherType: config.ditherType, distanceMetric: config.distanceMetric }
    );

    const pixelCount = width * height;
    const MechanicalKnobs = Reveal.MechanicalKnobs;
    const masks = MechanicalKnobs.rebuildMasks(colorIndices, paletteLab.length, pixelCount);

    if (config.speckleRescue > 0) {
        MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, config.speckleRescue);
    }

    const hexColors = paletteRgb.map(rgb =>
        '#' + [rgb.r, rgb.g, rgb.b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase()
    );

    return { colorIndices, masks, paletteLab, paletteRgb, hexColors, config, pixelCount };
}

// ─── PNG (flat posterized image) ───

async function exportPng(card, session) {
    const { width, height, originalName } = session;
    const { colorIndices, paletteRgb, pixelCount } = await separate(card, session);

    const rgb8 = new Uint8Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const c = paletteRgb[colorIndices[i]];
        const off = i * 3;
        rgb8[off]     = Math.round(c.r);
        rgb8[off + 1] = Math.round(c.g);
        rgb8[off + 2] = Math.round(c.b);
    }

    ensureOutDir();
    const baseName = path.basename(originalName || 'untitled', path.extname(originalName || ''));
    const outPath = path.join(OUT_DIR, `${baseName}-${card.archetypeId}.png`);

    await sharp(Buffer.from(rgb8), { raw: { width, height, channels: 3 } })
        .png().toFile(outPath);

    return outPath;
}

// ─── ORA (OpenRaster — layered, open standard) ───

async function exportOra(card, session) {
    const { width, height, originalName } = session;
    const { colorIndices, masks, paletteLab, paletteRgb, hexColors, pixelCount } = await separate(card, session);

    const entries = [];

    // 1. mimetype (must be first, stored uncompressed)
    entries.push({ name: 'mimetype', data: Buffer.from('image/openraster'), store: true });

    // 2. mergedimage.png — flat composite
    const mergedRgba = Buffer.alloc(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
        const rgb = paletteRgb[colorIndices[i]];
        mergedRgba[i * 4]     = Math.round(rgb.r);
        mergedRgba[i * 4 + 1] = Math.round(rgb.g);
        mergedRgba[i * 4 + 2] = Math.round(rgb.b);
        mergedRgba[i * 4 + 3] = 255;
    }
    const mergedPng = await sharp(mergedRgba, { raw: { width, height, channels: 4 } })
        .png().toBuffer();
    entries.push({ name: 'mergedimage.png', data: mergedPng, store: false });

    // 3. Layer PNGs — sorted by lightness descending
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

        const rgba = Buffer.alloc(pixelCount * 4);
        const r = Math.round(rgb.r), g = Math.round(rgb.g), b = Math.round(rgb.b);
        for (let i = 0; i < pixelCount; i++) {
            if (mask[i] === 255) {
                rgba[i * 4] = r;
                rgba[i * 4 + 1] = g;
                rgba[i * 4 + 2] = b;
                rgba[i * 4 + 3] = 255;
            }
        }

        const layerPng = await sharp(rgba, { raw: { width, height, channels: 4 } })
            .png().toBuffer();
        entries.push({ name: filename, data: layerPng, store: false });
        layerNames.push({ name, src: filename });
    }

    // 4. stack.xml
    let stackXml = `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.3" w="${width}" h="${height}">\n  <stack>\n`;
    for (const layer of layerNames) {
        const escaped = layer.name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        stackXml += `    <layer name="${escaped}" src="${layer.src}" x="0" y="0" opacity="1.0" visibility="visible" />\n`;
    }
    stackXml += `  </stack>\n</image>\n`;
    entries.push({ name: 'stack.xml', data: Buffer.from(stackXml), store: false });

    ensureOutDir();
    const baseName = path.basename(originalName || 'untitled', path.extname(originalName || ''));
    const outPath = path.join(OUT_DIR, `${baseName}-${card.archetypeId}.ora`);
    fs.writeFileSync(outPath, buildZip(entries));
    return outPath;
}

// ─── PSD (Lab fill+mask layers) ───

async function exportPsd(card, session) {
    const { width, height, originalName } = session;
    const { colorIndices, masks, paletteLab, paletteRgb, pixelCount } = await separate(card, session);

    const { PSDWriter } = require('@electrosaur-labs/psd-writer');

    const writer = new PSDWriter({
        width, height,
        colorMode: 'lab',
        bitsPerChannel: 16,
        compression: 'none',
        documentName: path.basename(originalName || 'untitled', path.extname(originalName || '')),
    });

    // 8-bit Lab composite for thumbnail + QuickLook
    const lab8bit = new Uint8Array(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const color = paletteLab[colorIndices[i]];
        lab8bit[i * 3]     = Math.round((color.L / 100) * 255);
        lab8bit[i * 3 + 1] = Math.round(color.a + 128);
        lab8bit[i * 3 + 2] = Math.round(color.b + 128);
    }

    const rgb = LabEncoding.lab8bitToRgb(lab8bit, pixelCount);
    const thumbScale = Math.min(256 / width, 256 / height);
    const thumbW = Math.round(width * thumbScale);
    const thumbH = Math.round(height * thumbScale);
    const jpegData = await sharp(Buffer.from(rgb), { raw: { width, height, channels: 3 } })
        .resize(thumbW, thumbH).jpeg({ quality: 80 }).toBuffer();

    writer.setThumbnail({ jpegData, width: thumbW, height: thumbH });
    writer.setComposite(lab8bit);

    // Layers sorted by lightness descending
    const layerOrder = paletteLab.map((color, i) => ({ index: i, L: color.L }));
    layerOrder.sort((a, b) => b.L - a.L);

    for (let li = 0; li < layerOrder.length; li++) {
        const { index } = layerOrder[li];
        const color = paletteLab[index];
        const rgbC = paletteRgb[index];
        const hex = '#' + [rgbC.r, rgbC.g, rgbC.b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('').toUpperCase();
        const aSign = color.a >= 0 ? '+' : '';
        const bSign = color.b >= 0 ? '+' : '';
        writer.addFillLayer({
            name: `[${li + 1}] ${hex} L${Math.round(color.L)} a${aSign}${Math.round(color.a)} b${bSign}${Math.round(color.b)}`,
            color,
            mask: masks[index],
        });
    }

    ensureOutDir();
    const baseName = path.basename(originalName || 'untitled', path.extname(originalName || ''));
    const outPath = path.join(OUT_DIR, `${baseName}-${card.archetypeId}.psd`);
    fs.writeFileSync(outPath, writer.write());
    return outPath;
}

// ─── Dispatch ───

async function exportSeparation(card, session, format) {
    switch (format) {
        case 'png': return exportPng(card, session);
        case 'ora': return exportOra(card, session);
        case 'psd': return exportPsd(card, session);
        default: throw new Error(`Unknown format: ${format}`);
    }
}

module.exports = { exportSeparation };

// ─── ZIP builder (for ORA) ───

function buildZip(entries) {
    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBuffer = Buffer.from(entry.name, 'utf8');
        const uncompressedData = entry.data;
        const compressedData = entry.store ? uncompressedData : zlib.deflateRawSync(uncompressedData);
        const crc = crc32(uncompressedData);
        const method = entry.store ? 0 : 8;

        const local = Buffer.alloc(30 + nameBuffer.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressedData.length, 18);
        local.writeUInt32LE(uncompressedData.length, 22);
        local.writeUInt16LE(nameBuffer.length, 26);
        local.writeUInt16LE(0, 28);
        nameBuffer.copy(local, 30);

        localHeaders.push(Buffer.concat([local, compressedData]));

        const central = Buffer.alloc(46 + nameBuffer.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressedData.length, 20);
        central.writeUInt32LE(uncompressedData.length, 24);
        central.writeUInt16LE(nameBuffer.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        nameBuffer.copy(central, 46);

        centralHeaders.push(central);
        offset += local.length + compressedData.length;
    }

    const centralDirData = Buffer.concat(centralHeaders);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralDirData.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localHeaders, centralDirData, eocd]);
}

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
