# @reveal/psd-writer

Minimal PSD file writer for 8-bit Lab color documents with fill+mask layers.

## Purpose

Writes Photoshop PSD files for screen printing color separations. Each layer represents one ink color with a solid fill and layer mask.

**Why not use ag-psd?** The ag-psd library cannot write Lab color mode PSD files. This package implements just enough of the PSD format to write our specific use case.

## Features

- ✅ 8-bit Lab color mode (mode=9)
- ✅ Multiple layers with solid color fills
- ✅ Layer masks (8-bit grayscale)
- ✅ Minimal file size (uncompressed for now)
- ❌ No text layers, effects, or advanced features

## Usage

```javascript
const PSDWriter = require('@reveal/psd-writer');

// Create writer
const writer = new PSDWriter({
  width: 800,
  height: 600,
  colorMode: 'lab',  // Only 'lab' supported currently
  bitsPerChannel: 8
});

// Add layer with solid fill + mask
writer.addFillLayer({
  name: 'Red Ink',
  color: { L: 50, a: 75, b: 60 },  // Lab color
  mask: maskData  // Uint8Array (width * height bytes)
});

// Write to file
const buffer = writer.write();
fs.writeFileSync('output.psd', buffer);
```

## API

### `new PSDWriter(options)`

Creates a new PSD writer instance.

**Options:**
- `width` (number) - Image width in pixels
- `height` (number) - Image height in pixels
- `colorMode` (string) - Color mode ('lab' only for now)
- `bitsPerChannel` (number) - Bit depth (8 only for now)

### `addFillLayer(options)`

Adds a solid color fill layer with mask.

**Options:**
- `name` (string) - Layer name
- `color` (object) - Lab color `{ L, a, b }`
  - L: 0-100 (lightness)
  - a: -128 to +127 (green-red)
  - b: -128 to +127 (blue-yellow)
- `mask` (Uint8Array) - Layer mask data (width * height bytes, 255=visible, 0=transparent)

### `write()`

Generates the PSD file buffer.

**Returns:** `Buffer` - Complete PSD file data

## PSD Format Implementation

This package implements a minimal subset of the Adobe PSD specification:

1. **File Header** - Basic image properties
2. **Color Mode Data** - Empty for Lab mode
3. **Image Resources** - Minimal metadata
4. **Layer Information** - Fill layers with masks
5. **Image Data** - Composite preview (optional)

**References:**
- [Adobe PSD Specification](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)
- [PSD Format on FileFormat.info](https://www.fileformat.info/format/psd/egff.htm)

## Limitations

- **8-bit only** - No 16-bit support (yet)
- **Lab only** - No RGB/CMYK support (yet)
- **Fill layers only** - No raster layers (yet)
- **No compression** - Raw data only (RLE PackBits could be added)
- **No composite preview** - Photoshop will generate on first open

## Development Status

🚧 **In Development** - Phase 1: Synthetic test program

## License

Apache-2.0
