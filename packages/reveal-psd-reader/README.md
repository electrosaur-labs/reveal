# @reveal/psd-reader

Minimal PSD file reader for Lab color documents.

## Purpose

Reads single-layer (flattened) Lab PSDs to extract composite image data for processing.

**Why not use ag-psd?** The ag-psd library throws an error for Lab color mode (mode=9) PSDs. This package implements just enough of the PSD format to read our specific use case.

## Features

- ✅ Lab color mode (mode=9) support
- ✅ 8-bit and 16-bit depth
- ✅ 3-channel (Lab) and 4-channel (Lab+Alpha)
- ✅ Uncompressed (RAW) and RLE PackBits compression
- ✅ Extracts composite/flattened image data
- ❌ No layer extraction (single-layer PSDs only)
- ❌ No RGB/CMYK support

## Usage

```javascript
const fs = require('fs');
const { readPsd } = require('@reveal/psd-reader');

const buffer = fs.readFileSync('input.psd');
const psd = readPsd(buffer);

console.log(psd);
// {
//   width: 800,
//   height: 600,
//   colorMode: 9,     // Lab
//   depth: 8,         // or 16
//   channels: 3,      // or 4 (with alpha)
//   data: Uint8Array  // Interleaved Lab pixels (L,a,b,L,a,b,...)
// }
```

## API

### `readPsd(buffer)`

Reads a Lab PSD file and extracts composite image data.

**Parameters:**
- `buffer` (Buffer) - PSD file buffer

**Returns:** Object with:
- `width` (number) - Image width in pixels
- `height` (number) - Image height in pixels
- `colorMode` (number) - Color mode (always 9 for Lab)
- `depth` (number) - Bit depth per channel (8 or 16)
- `channels` (number) - Number of channels (3 or 4)
- `data` (Uint8Array) - Interleaved Lab pixel data
  - Format: `L,a,b,L,a,b,...` (3 bytes per pixel)
  - L: 0-255 (lightness)
  - a: 0-255 (green-red, 128=neutral)
  - b: 0-255 (blue-yellow, 128=neutral)

**Note:** 16-bit PSDs are automatically converted to 8-bit by taking the high byte.

## PSD Format Implementation

This package implements a minimal subset of the Adobe PSD specification:

1. **File Header** - Read dimensions, color mode, bit depth
2. **Color Mode Data** - Skip (empty for Lab)
3. **Image Resources** - Skip
4. **Layer Information** - Skip (we only read composite)
5. **Image Data** - Read and decompress channel data

**Compression Support:**
- **0 (RAW)** - Direct byte copy
- **1 (RLE PackBits)** - Full PackBits decompression

**References:**
- [Adobe PSD Specification](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)
- [PSD Format on FileFormat.info](https://www.fileformat.info/format/psd/egff.htm)

## Limitations

- **Single-layer only** - Extracts composite image, ignores layer data
- **Lab only** - No RGB/CMYK support (throws error)
- **No editing** - Read-only (use @reveal/psd-writer to create PSDs)
- **8-bit output** - 16-bit PSDs downsampled to 8-bit automatically

## Companion Package

See [@reveal/psd-writer](../reveal-psd-writer) for creating Lab PSDs.

## License

Apache-2.0
