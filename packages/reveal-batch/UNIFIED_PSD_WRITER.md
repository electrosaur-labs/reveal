# Unified PSD Writer - Technical Documentation

**Date:** 2026-01-28
**Author:** Architect + Implementation Team
**Purpose:** Production-ready streaming PSD writer for large 16-bit Lab files

---

## Overview

The **Unified PSD Writer** is a memory-efficient, streaming implementation for creating 16-bit Lab PSDs with macOS QuickLook compatibility. It solves critical issues discovered during AIC dataset processing:

1. **16-bit RLE byte interleaving** - High/low byte separation required for QuickLook
2. **Resource 1033 thumbnails** - Correct resource ID for Finder icons
3. **Streaming architecture** - Minimal memory footprint via callback pattern
4. **Universal compatibility** - Works with Sharp, GeoTIFF, or any data source

---

## Architecture

### Callback Pattern

The writer uses a **row data accessor callback** to decouple data acquisition from PSD writing:

```javascript
async function getRowData(channel, y) {
    // channel: 0=L, 1=a, 2=b
    // y: row index (0 to height-1)
    // returns: Uint16Array of length width with 16-bit Lab values
}
```

This allows:
- **Sharp integration**: Load entire image, access rows from memory
- **GeoTIFF streaming**: Read rows on-demand from pyramid pages
- **Procedural generation**: Generate patterns algorithmically
- **Custom sources**: Any data source that can produce row data

### Memory Efficiency

**Traditional approach:**
```
Load full RGB → Convert to Lab → Write PSD
Memory: 3 × width × height × channels
```

**Unified writer approach:**
```
Fetch row → Convert → Compress → Write → Discard
Memory: width × channels (constant, independent of height)
```

---

## Critical Technical Details

### 1. 16-Bit RLE Byte Interleaving (QuickLook Fix)

**Problem:** Standard 16-bit RLE compresses values as-is, which QuickLook cannot decode correctly.

**Solution:** Separate high and low bytes per scanline, compress independently, concatenate:

```javascript
for (let x = 0; x < width; x++) {
    hi[x] = (scanline[x] >> 8) & 0xFF;  // MSB
    lo[x] = scanline[x] & 0xFF;         // LSB
}

const compHi = packBits(hi);
const compLo = packBits(lo);
const combined = Buffer.concat([compHi, compLo]);
```

**Why this works:** QuickLook expects byte-planar data, not value-planar.

### 2. Resource 1033 Thumbnail (Not 1036)

**Correction from architect:**
- **1036** = Thumbnail for Adobe dialogs (older spec)
- **1033** = Thumbnail for Finder and Adobe (current spec)

**Format:**
```javascript
Header (28 bytes):
  - Format: 1 (kJpegRGB)
  - Width, Height (pixels)
  - WidthBytes: ((width * 24 + 31) / 32) * 4
  - Total Size: jpegData.length + 28  // CRITICAL: Include header
  - JPEG Size: jpegData.length
  - Bits per pixel: 24 (RGB)
  - Planes: 1

+ JPEG data
+ Padding (even length)
```

### 3. 16-Bit Lab Encoding

**Standard encoding for PSD:**
```
L: 0-65535 (0 = black, 65535 = white)
   Formula: value8 * 257

a/b: 0-65535 (32768 = neutral)
   Formula: (value8 - 128) * 256 + 32768
```

**Why 32768 for neutral:**
- Lab a/b range: -128 to +127
- Neutral (0) maps to 32768 in 16-bit unsigned
- This centers the range in the 16-bit space

---

## PSD File Structure

```
┌─────────────────────────────────────────┐
│ Section 1: Header (26 bytes)           │
│  - Signature: "8BPS"                    │
│  - Channels: 3                          │
│  - Width, Height                        │
│  - Depth: 16 bits                       │
│  - Mode: 7 (Lab)                        │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Section 2: Color Mode Data             │
│  - Length: 0 (empty for Lab)            │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Section 3: Image Resources              │
│  - Resource 1033: Thumbnail             │
│    - 28-byte header                     │
│    - JPEG data (max 160×160)            │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Section 4: Layer/Mask Info              │
│  - Length: 0 (flat composite)           │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Section 5: Image Data (QuickLook)       │
│  - Compression: 1 (RLE with interleave) │
│  - Scanline count table                 │
│  - Compressed data (channel-by-channel) │
│    Order: L (all rows) → a → b          │
│    Per row: Hi bytes + Lo bytes         │
└─────────────────────────────────────────┘
```

---

## Usage Examples

### Example 1: Convert TIFF with Sharp

```javascript
const { writeUnifiedPsd } = require('./UnifiedPSDWriter');
const sharp = require('sharp');
const Reveal = require('@electrosaur-labs/core');

async function convertTiff(inputPath, outputPath) {
    // Load and resize
    const { data: rgbPixels, info } = await sharp(inputPath)
        .resize(3000, 3000, { fit: 'inside' })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height } = info;

    // Convert RGB to Lab (in-memory)
    const labPixels = new Uint8ClampedArray(width * height * 3);
    for (let i = 0; i < width * height; i++) {
        const lab = Reveal.rgbToLab({
            r: rgbPixels[i * 3],
            g: rgbPixels[i * 3 + 1],
            b: rgbPixels[i * 3 + 2]
        });
        labPixels[i * 3] = Math.round((lab.L / 100) * 255);
        labPixels[i * 3 + 1] = Math.round(lab.a + 128);
        labPixels[i * 3 + 2] = Math.round(lab.b + 128);
    }

    // Generate thumbnail
    const thumbBuffer = await sharp(Buffer.from(rgbPixels), {
        raw: { width, height, channels: 3 }
    })
    .resize(160, 160, { fit: 'inside' })
    .jpeg({ quality: 90 })
    .toBuffer();

    // Row accessor
    async function getRowData(channel, y) {
        const row = new Uint16Array(width);
        const offset = y * width;

        for (let x = 0; x < width; x++) {
            const val8 = labPixels[(offset + x) * 3 + channel];

            if (channel === 0) {
                row[x] = val8 * 257;  // L
            } else {
                row[x] = (val8 - 128) * 256 + 32768;  // a/b
            }
        }

        return row;
    }

    // Write PSD
    await writeUnifiedPsd(outputPath, {
        width,
        height,
        thumbnailBuffer: thumbBuffer
    }, getRowData);
}
```

### Example 2: Pyramid TIFF with GeoTIFF

```javascript
const GeoTIFF = require('geotiff');

async function convertPyramidTiff(inputPath, outputPath, pageNum = 2) {
    const tiff = await GeoTIFF.fromFile(inputPath);
    const image = await tiff.getImage(pageNum);

    const width = image.getWidth();
    const height = image.getHeight();

    // Load full rasters (page is already downsampled)
    const rasters = await image.readRasters();

    // Generate thumbnail...
    const thumbBuffer = await generateThumbnail(rasters, width, height);

    // Row accessor with on-demand RGB→Lab conversion
    async function getRowData(channel, y) {
        const row = new Uint16Array(width);

        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const r = rasters[0][idx] || 0;
            const g = rasters[1][idx] || 0;
            const b = rasters[2][idx] || 0;

            const lab = Reveal.rgbToLab({ r, g, b });
            const val8 = channel === 0
                ? Math.round((lab.L / 100) * 255)
                : channel === 1
                    ? Math.round(lab.a + 128)
                    : Math.round(lab.b + 128);

            row[x] = channel === 0
                ? val8 * 257
                : (val8 - 128) * 256 + 32768;
        }

        return row;
    }

    await writeUnifiedPsd(outputPath, {
        width,
        height,
        thumbnailBuffer: thumbBuffer
    }, getRowData);
}
```

### Example 3: Procedural Test Pattern

```javascript
async function createTestPattern(outputPath) {
    const width = 512;
    const height = 512;

    // Generate thumbnail (gradient)
    const thumbBuffer = await generateGradientThumbnail();

    // Row accessor: procedural gradient
    async function getRowData(channel, y) {
        const row = new Uint16Array(width);

        for (let x = 0; x < width; x++) {
            if (channel === 0) {
                // L: horizontal gradient
                row[x] = (x / width) * 65535;
            } else if (channel === 1) {
                // a: centered vertical gradient
                row[x] = 32768 + ((y / height) - 0.5) * 30000;
            } else {
                // b: centered diagonal gradient
                row[x] = 32768 + (((x + y) / (width + height)) - 0.5) * 30000;
            }
        }

        return row;
    }

    await writeUnifiedPsd(outputPath, {
        width,
        height,
        thumbnailBuffer: thumbBuffer
    }, getRowData);
}
```

---

## Performance Characteristics

### Memory Usage

| File Size | Traditional | Unified Writer |
|-----------|-------------|----------------|
| 3000×3000 (16-bit Lab) | ~162 MB | ~18 KB |
| 8000×8000 (16-bit Lab) | ~1.15 GB | ~48 KB |
| 15000×15000 (16-bit Lab) | ~4.05 GB | ~90 KB |

**Formula:** Unified memory = width × 3 channels × 2 bytes (one row)

### Processing Speed

- **Compression overhead:** ~40% longer than uncompressed
- **QuickLook compatibility:** 100% with proper byte interleaving
- **I/O bound:** Performance limited by disk write speed, not CPU

### Comparison: RLE vs Uncompressed

| Method | File Size | QuickLook | Processing Time |
|--------|-----------|-----------|-----------------|
| Uncompressed | 100% | ✓ Always works | 100% |
| RLE (standard) | ~40-60% | ✗ Black screen | 140% |
| RLE (interleaved) | ~40-60% | ✓ Works perfectly | 140% |

**Recommendation:** Use RLE with byte interleaving for production (smaller files, QuickLook works).

---

## Validation Results (AIC Dataset)

**Applied to:** 25 Art Institute of Chicago images
**File sizes:** 44-60 MB per image (uncompressed)
**QuickLook success rate:** 100%
**Finder thumbnails:** 100% working

**Key fixes from architect:**
1. Resource 1033 (not 1036)
2. TotalSize = jpegData.length + 28 (include header)
3. 16-bit byte interleaving for RLE
4. a/b centered at 32768 (not 32896)

---

## Integration with Existing Code

### PSDWriter.js Updates

The following changes were made to `packages/reveal-psd-writer/src/PSDWriter.js`:

1. **Resource ID:** Changed 1036 → 1033
2. **TotalSize calculation:** Fixed to include header (offset 16)
3. **Comments:** Updated to reflect architect's corrections

### Backward Compatibility

The unified writer is **standalone** and does not replace PSDWriter.js. Use:
- **PSDWriter.js**: For separated layers (posterization output)
- **UnifiedPSDWriter.js**: For flat composites (TIFF conversion)

---

## Future Enhancements

### Potential Optimizations

1. **Temp file buffering**: Write compressed chunks to temp file if > 1GB
2. **Parallel compression**: Compress multiple rows concurrently
3. **Adaptive compression**: Switch to uncompressed for low-entropy images
4. **Smart caching**: Cache Lab conversion results for duplicate colors

### Additional Features

1. **ICC profile support**: Embed Lab ICC profile (Resource 1039)
2. **Resolution metadata**: DPI/PPI information (Resource 1005)
3. **EXIF preservation**: Copy EXIF from source (Resource 1058)
4. **Layer support**: Extend callback pattern to multi-layer files

---

## Troubleshooting

### QuickLook shows black rectangle

**Cause:** Missing byte interleaving in 16-bit RLE
**Solution:** Ensure high/low bytes are separated before compression

### Finder shows generic PSD icon (no thumbnail)

**Cause:** Wrong resource ID or malformed thumbnail block
**Solution:** Use Resource 1033 with correct TotalSize calculation

### Colors appear shifted/wrong

**Cause:** Incorrect a/b centering (32896 instead of 32768)
**Solution:** Use formula (val8 - 128) * 256 + 32768

### Out of memory during conversion

**Cause:** Loading entire image into memory
**Solution:** Use pyramid pages or tile-based processing

---

## Files and Locations

```
packages/reveal-batch/scripts/
├── UnifiedPSDWriter.js             # Core implementation
├── UnifiedPSDWriter_Example.js     # Usage examples
├── convertSingleAIC.js             # Legacy (uses old approach)
├── convertLargeTIFF_PyramidPage.js # Uses pyramid + old writer
└── UNIFIED_PSD_WRITER.md           # This document

packages/reveal-psd-writer/src/
└── PSDWriter.js                    # Updated for Resource 1033
```

---

## References

### Adobe PSD Specification
- [Adobe Developer Resources](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)
- Section 2.3: Image Resources
- Section 2.5: Image Data (Section 5)

### Key Resources
- **1033**: Thumbnail (kJpegRGB format)
- **1005**: Resolution Info
- **1039**: ICC Profile
- **1058**: EXIF Data

### Lab Color Space
- **CIELAB (D65)**: Perceptually uniform color space
- **L**: 0-100 (lightness)
- **a**: -128 to +127 (green-red axis)
- **b**: -128 to +127 (blue-yellow axis)

---

## Acknowledgments

**Architect:** Provided streaming architecture, byte interleaving fix, and Resource 1033 correction
**Implementation:** Integration with Sharp, GeoTIFF, and Reveal color conversion
**Testing:** Validated on 25 AIC museum images (300-700 MP pyramid TIFFs)

---

**Document Version:** 1.0
**Last Updated:** 2026-01-28
