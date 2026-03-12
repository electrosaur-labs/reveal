# @electrosaur-labs/psd-writer

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
const PSDWriter = require('@electrosaur-labs/psd-writer');

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

## macOS QuickLook & Finder Thumbnail

`write()` **throws** if you haven't provided all three required pieces. This is enforced
because silently producing PSDs without previews has caused repeated bugs.

### Required before calling `write()`:

| # | Method | What it provides |
|---|--------|-----------------|
| 1 | `setComposite(lab8bit)` | Section 5 merged image data — QuickLook reads this |
| 2 | `setThumbnail({ jpegData, width, height })` | Resource 1036 JPEG — Finder icon + Adobe Open dialog |
| 3 | At least one layer (`addFillLayer` or `addPixelLayer`) | The actual separation data |

### Complete example:

```javascript
const writer = new PSDWriter({ width, height, colorMode: 'lab', bitsPerChannel: 16 });

// 1. Composite (8-bit Lab: L 0-255, a/b 0-255 with 128=neutral)
const lab8bit = new Uint8Array(pixelCount * 3);
for (let i = 0; i < pixelCount; i++) {
    lab8bit[i * 3]     = Math.round((color.L / 100) * 255);
    lab8bit[i * 3 + 1] = Math.round(color.a + 128);
    lab8bit[i * 3 + 2] = Math.round(color.b + 128);
}
writer.setComposite(lab8bit);

// 2. Thumbnail (RGB JPEG, max 256px)
const rgb = LabEncoding.lab8bitToRgb(lab8bit, pixelCount);
const jpegData = await sharp(Buffer.from(rgb), { raw: { width, height, channels: 3 } })
    .resize(thumbW, thumbH).jpeg({ quality: 80 }).toBuffer();
writer.setThumbnail({ jpegData, width: thumbW, height: thumbH });

// 3. Layers
writer.addFillLayer({ name: 'Ink 1', color: { L: 50, a: 30, b: -10 }, mask: maskData });

// Write — throws if any of the above are missing
const buffer = writer.write();
```

### What NOT to do

- Do NOT set header channels to 3 for layered documents. Photoshop requires
  `3 + min(layerCount, 4)` channels in both the header and Section 5, or it
  reports "premature EOF". The extra channels are opaque alpha (255).
- Do NOT skip `setComposite()` — without it, Section 5 writes neutral white
  and QuickLook shows a blank preview.
- Do NOT skip `setThumbnail()` — without it, Finder shows a generic icon.

## Limitations

- **Lab only** - No RGB/CMYK support
- **Fill layers only** - No raster pixel layers with effects
- **No advanced features** - No text, effects, smart objects

## Development Status

🚧 **In Development** - Phase 1: Synthetic test program

## License

Apache-2.0
