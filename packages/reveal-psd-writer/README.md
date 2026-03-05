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

## macOS QuickLook Compatibility

For QuickLook previews to work with Lab PSDs, three things are required:

### 1. Header: Declare exactly 3 channels (L, a, b)
Do NOT add extra alpha channels for layers. Layer masks are stored separately in Section 4.
```javascript
// CORRECT: Always 3 channels for Lab
writer.writeUint16(3);

// WRONG: Adding alpha channels breaks QuickLook
channelCount = 3 + layers.length;  // Don't do this!
```

### 2. Section 5: Write composite image data from a pixel source
QuickLook reads the merged/composite image from Section 5. Provide pixel data via:
- `setComposite(labPixels)` for flat files (no layers), OR
- `addPixelLayer({ pixels: labPixels })` when you have layers

```javascript
// Option A: Flat mode (no layers, best QuickLook support)
writer.setComposite(labPixels);

// Option B: With layers (add pixel layer as composite source)
writer.addPixelLayer({
  name: 'Original Image (Reference)',
  pixels: lab8bitData,  // 8-bit Lab encoding (3 bytes/pixel)
  visible: false
});
writer.addFillLayer({ ... });  // Add your ink layers
```

### 3. Resource 1036: Add JPEG thumbnail
The thumbnail appears in Finder icons and Adobe dialogs:
```javascript
writer.setThumbnail({
  jpegData: jpegBuffer,  // RGB JPEG, max 160px
  width: thumbWidth,
  height: thumbHeight
});
```

### Summary
| Requirement | What to do |
|-------------|-----------|
| Header channels | Always 3 (L, a, b) |
| Section 5 composite | Use `setComposite()` or `addPixelLayer()` |
| Thumbnail | Call `setThumbnail()` with RGB JPEG |

## Limitations

- **Lab only** - No RGB/CMYK support
- **Fill layers only** - No raster pixel layers with effects
- **No advanced features** - No text, effects, smart objects

## Development Status

🚧 **In Development** - Phase 1: Synthetic test program

## License

Apache-2.0
