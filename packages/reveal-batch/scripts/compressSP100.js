#!/usr/bin/env node
/**
 * compressSP100.js - Compress SP100 input PSDs using RLE compression
 *
 * Reads existing uncompressed 16-bit Lab PSDs and rewrites them with RLE compression,
 * preserving thumbnails and all metadata.
 */

const fs = require('fs');
const path = require('path');
const PSDReader = require('../../reveal-psd-writer/src/PSDReader');
const PSDWriter = require('../../reveal-psd-writer/src/PSDWriter');

const DATA_ROOT = path.join(__dirname, '../data/SP100/input');

async function compressPSD(inputPath) {
    const filename = path.basename(inputPath);
    console.log(`\n📦 Processing: ${filename}`);

    const originalSize = fs.statSync(inputPath).size;
    console.log(`  Original size: ${(originalSize / 1024 / 1024).toFixed(1)} MB`);

    // Read the PSD
    const buffer = fs.readFileSync(inputPath);
    const reader = new PSDReader(buffer);
    const psd = reader.read();

    const { width, height, depth, mode } = psd.header;
    console.log(`  Dimensions: ${width}x${height}, ${depth}-bit, mode=${mode}`);

    if (mode !== 9) {
        console.log(`  ⚠️ Skipping: Not Lab mode (mode=${mode})`);
        return null;
    }

    if (depth !== 16) {
        console.log(`  ⚠️ Skipping: Not 16-bit (depth=${depth})`);
        return null;
    }

    // Get the layer info (should be in Lr16 block for 16-bit)
    const layers = psd.layerAndMaskInfo.layerInfo.layers;
    if (layers.length !== 1 || layers[0].name !== 'Background') {
        console.log(`  ⚠️ Skipping: Expected single Background layer, found ${layers.length} layers`);
        return null;
    }

    const layer = layers[0];

    // Extract Lab pixel data from channels
    // Channel order: -1 (alpha), 0 (L), 1 (a), 2 (b)
    const channelData = layer.channelData;
    if (!channelData || channelData.length < 4) {
        console.log(`  ⚠️ Skipping: Expected 4 channels, found ${channelData ? channelData.length : 0}`);
        return null;
    }

    // Get decompressed channel data
    const alphaData = channelData[0].decompressedData;
    const lData = channelData[1].decompressedData;
    const aData = channelData[2].decompressedData;
    const bData = channelData[3].decompressedData;

    if (!alphaData || !lData || !aData || !bData) {
        console.log(`  ⚠️ Skipping: Missing decompressed channel data`);
        return null;
    }

    const pixelCount = width * height;
    const bytesPerChannel = pixelCount * 2; // 16-bit = 2 bytes per pixel

    console.log(`  Pixel count: ${pixelCount.toLocaleString()}, bytes per channel: ${bytesPerChannel.toLocaleString()}`);

    // Interleave channels into Lab pixel buffer (L, a, b for each pixel - 6 bytes per pixel)
    // Note: 16-bit channels are stored as big-endian 16-bit values
    const labPixels = Buffer.alloc(pixelCount * 6); // L(2) + a(2) + b(2) = 6 bytes per pixel

    for (let i = 0; i < pixelCount; i++) {
        const srcOffset = i * 2;
        const dstOffset = i * 6;

        // Copy L (2 bytes big-endian)
        labPixels[dstOffset] = lData[srcOffset];
        labPixels[dstOffset + 1] = lData[srcOffset + 1];

        // Copy a (2 bytes big-endian)
        labPixels[dstOffset + 2] = aData[srcOffset];
        labPixels[dstOffset + 3] = aData[srcOffset + 1];

        // Copy b (2 bytes big-endian)
        labPixels[dstOffset + 4] = bData[srcOffset];
        labPixels[dstOffset + 5] = bData[srcOffset + 1];
    }

    console.log(`  Lab pixel buffer: ${(labPixels.length / 1024 / 1024).toFixed(1)} MB (native 16-bit format)`);

    // Create new PSD with RLE compression
    const writer = new PSDWriter({
        width,
        height,
        colorMode: 'lab',
        bitsPerChannel: 16,
        compression: 'rle'  // Enable RLE compression
    });

    // Add the pixel layer (native 16-bit format)
    writer.addPixelLayer({
        name: 'Background',
        pixels: labPixels,
        visible: true
    });

    // Extract and set thumbnail if present
    const thumbnailResource = psd.imageResources.resources.find(r => r.id === 1036);
    if (thumbnailResource && thumbnailResource.data) {
        // Extract JPEG data from thumbnail resource
        // Format: 4 bytes format + 4 bytes width + 4 bytes height + 4 bytes row bytes + 4 bytes total size + 4 bytes compressed size + 2 bytes bits/pixel + 2 bytes planes + JPEG data
        const thumbData = thumbnailResource.data;
        if (thumbData.length > 28) {
            const format = thumbData.readUInt32BE(0);
            const thumbWidth = thumbData.readUInt32BE(4);
            const thumbHeight = thumbData.readUInt32BE(8);
            const jpegData = thumbData.slice(28);

            if (format === 1 && jpegData.length > 0) {
                console.log(`  Thumbnail: ${thumbWidth}x${thumbHeight}, JPEG ${jpegData.length} bytes`);
                writer.setThumbnail({
                    jpegData,
                    width: thumbWidth,
                    height: thumbHeight
                });
            }
        }
    }

    // Write the compressed PSD
    const outputBuffer = writer.write();
    const compressedSize = outputBuffer.length;
    const ratio = (originalSize / compressedSize).toFixed(2);
    const savings = ((1 - compressedSize / originalSize) * 100).toFixed(1);

    console.log(`  Compressed: ${(compressedSize / 1024 / 1024).toFixed(1)} MB (${ratio}x compression, ${savings}% savings)`);

    // Backup original and write compressed
    const backupPath = inputPath + '.uncompressed';
    if (!fs.existsSync(backupPath)) {
        fs.renameSync(inputPath, backupPath);
        console.log(`  Backed up original to: ${path.basename(backupPath)}`);
    }

    fs.writeFileSync(inputPath, outputBuffer);
    console.log(`  ✓ Saved compressed PSD`);

    return {
        filename,
        originalSize,
        compressedSize,
        ratio: parseFloat(ratio),
        savings: parseFloat(savings)
    };
}

async function processSource(source) {
    const inputDir = path.join(DATA_ROOT, source, 'psd');

    if (!fs.existsSync(inputDir)) {
        console.log(`\n⚠️ Directory not found: ${inputDir}`);
        return [];
    }

    const files = fs.readdirSync(inputDir)
        .filter(f => f.endsWith('.psd') && !f.endsWith('.uncompressed'))
        .sort();

    console.log(`\n📁 Processing ${source.toUpperCase()}: ${files.length} files`);
    console.log('━'.repeat(50));

    const results = [];

    for (const file of files) {
        try {
            const result = await compressPSD(path.join(inputDir, file));
            if (result) {
                results.push(result);
            }
        } catch (error) {
            console.error(`  ❌ Error: ${error.message}`);
        }
    }

    return results;
}

async function main() {
    console.log('🗜️  SP100 PSD Compression Tool');
    console.log('━'.repeat(50));

    const sources = process.argv.slice(2);
    const validSources = ['met', 'rijks'];

    const toProcess = sources.length > 0
        ? sources.filter(s => validSources.includes(s))
        : validSources;

    if (toProcess.length === 0) {
        console.log('Usage: node compressSP100.js [met|rijks|all]');
        process.exit(1);
    }

    const allResults = [];

    for (const source of toProcess) {
        const results = await processSource(source);
        allResults.push(...results);
    }

    // Summary
    if (allResults.length > 0) {
        console.log('\n\n📊 Summary');
        console.log('━'.repeat(50));

        const totalOriginal = allResults.reduce((sum, r) => sum + r.originalSize, 0);
        const totalCompressed = allResults.reduce((sum, r) => sum + r.compressedSize, 0);
        const avgRatio = allResults.reduce((sum, r) => sum + r.ratio, 0) / allResults.length;
        const totalSavings = ((1 - totalCompressed / totalOriginal) * 100).toFixed(1);

        console.log(`Files processed: ${allResults.length}`);
        console.log(`Original total:  ${(totalOriginal / 1024 / 1024 / 1024).toFixed(2)} GB`);
        console.log(`Compressed total: ${(totalCompressed / 1024 / 1024 / 1024).toFixed(2)} GB`);
        console.log(`Average ratio:   ${avgRatio.toFixed(2)}x`);
        console.log(`Total savings:   ${totalSavings}%`);
    }

    console.log('\n✓ Done');
}

main().catch(console.error);
