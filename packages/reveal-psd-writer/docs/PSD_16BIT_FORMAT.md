# 16-Bit Lab PSD Format - Fill+Mask Layers

## Key Findings

Through analysis of `JethroAsMonroe-16bit.psd`, we've identified the critical differences between 8-bit and 16-bit Lab PSD files with fill+mask layers.

## Reference File Analysis

**File:** `JethroAsMonroe-16bit.psd` (313 MB)
- 6 layers, each with Solid Color fill + user mask
- 5700×3900 pixels, 16-bit Lab color mode
- Mask compression: ZIP (type 3)
- Channel data compression: Raw (type 0)

## Major Structural Difference

**8-bit format:** Layers stored in traditional Layer Info section
**16-bit format:** Layers stored in tagged `Lr16` block

### Layer and Mask Info Section Structure

```
Offset    Field                         Value (16-bit)
--------  ---------------------------   --------------
0x00      Section length (4 bytes)      1,968,832 bytes
0x04      Layer info length (4 bytes)   0 (EMPTY!)
0x08      Global mask length (4 bytes)  0

Tagged Blocks:
0x0C      Signature                     "8BIM"
0x10      Key                           "Mt16"
0x14      Length                        0 bytes

0x18      Signature                     "8BIM"
0x1C      Key                           "Lr16"
0x20      Length                        1,967,941 bytes
0x24      <Lr16 data starts>            Layer count (2 bytes) + layer records...
```

## Lr16 Block Format

The Lr16 block contains layer data in a format similar to the traditional Layer Info section, but starts **directly with the layer count** (no length field):

```
Offset  Field
------  ----------------------
0x00    Layer count (2 bytes)  Negative indicates transparency
0x02    Layer record 1
...     Layer record 2-N
...     Channel image data
```

## Fill Layer Structure (16-bit vs 8-bit)

### Layer Bounds

**8-bit:** `(0, 0, height, width)` - Full canvas
**16-bit:** `(0, 0, 0, 0)` - Zero-size bounds!

Fill layers have no raster data, so bounds are 0.

### Channel Structure

Both formats have 5 channels per layer:

| Index | Channel ID | Purpose | 8-bit Size | 16-bit Size |
|-------|------------|---------|------------|-------------|
| 0 | -1 | Transparency | 2 + (w×h×1) | 2 + 0 |
| 1 | 0 | L (Lightness) | 2 + (w×h×1) | 2 + 0 |
| 2 | 1 | a (green-red) | 2 + (w×h×1) | 2 + 0 |
| 3 | 2 | b (blue-yellow) | 2 + (w×h×1) | 2 + 0 |
| 4 | -2 | User mask | 2 + (w×h×1) | 2 + (varies) |

**Key difference:**
- 8-bit fill layers write solid pixel data for L/a/b channels
- 16-bit fill layers write NO pixel data (just compression header)
- Both formats store actual mask data in channel -2

### Channel Data Lengths

**8-bit example (100×100):**
```
Transparency (-1): 2 + 10,000 = 10,002 bytes
L (0):            2 + 10,000 = 10,002 bytes
a (1):            2 + 10,000 = 10,002 bytes
b (2):            2 + 10,000 = 10,002 bytes
User mask (-2):   2 + 10,000 = 10,002 bytes
```

**16-bit example (100×100):**
```
Transparency (-1): 2 + 0 = 2 bytes  (no data!)
L (0):            2 + 0 = 2 bytes  (no data!)
a (1):            2 + 0 = 2 bytes  (no data!)
b (2):            2 + 0 = 2 bytes  (no data!)
User mask (-2):   2 + (varies with compression)
```

### Mask Data

**8-bit masks:** Uncompressed, 1 byte per pixel
**16-bit masks:** ZIP compressed (type 3), variable size

Example mask sizes from reference (5700×3900 = 22,230,000 pixels):
- Layer 1: 839,267 bytes (3.8% of uncompressed)
- Layer 2: 84,170 bytes (0.4%)
- Layer 3: 80,006 bytes (0.4%)
- Layer 4: 61,902 bytes (0.3%)
- Layer 5: 88,699 bytes (0.4%)
- Layer 6: 810,577 bytes (3.6%)

## Descriptor Format

**UNCHANGED!** - SoCo descriptors are identical in 8-bit and 16-bit:
- 112 bytes
- Stores Lab values as doubles (L, a, b)
- Same structure, same byte-for-byte format

## Additional Info Blocks

**UNCHANGED!** - Same blocks in both formats:
- SoCo (112 bytes) - Solid color descriptor
- luni (44 bytes) - Unicode layer name
- lyid, clbl, infx, knko, lspf, lclr, shmd, fxrp (various sizes)

## Implementation Changes for 16-Bit Support

### 1. Header
```javascript
writer.writeUint16(16);  // Depth (not 8)
```

### 2. Layer Records
```javascript
// Bounds: (0, 0, 0, 0) for fill layers
writer.writeInt32(0);  // Top
writer.writeInt32(0);  // Left
writer.writeInt32(0);  // Bottom
writer.writeInt32(0);  // Right

// Channel data sizes
const transparencySize = 2;  // Just compression header
const labChannelSize = 2;    // Just compression header
const maskSize = 2 + maskData.length;  // Compression + actual data
```

### 3. Channel Image Data
```javascript
// Transparency channel: compression=0, no data
writer.writeUint16(0);  // Compression type

// L channel: compression=0, no data
writer.writeUint16(0);

// a channel: compression=0, no data
writer.writeUint16(0);

// b channel: compression=0, no data
writer.writeUint16(0);

// User mask: compression=0 (raw), actual mask data
writer.writeUint16(0);
writer.writeBytes(mask);  // 8-bit mask data (not 16-bit!)
```

**Important:** Even in 16-bit documents, layer masks remain 8-bit (1 byte per pixel).

### 4. Layer and Mask Info Section
```javascript
// Empty traditional layer info
writer.writeUint32(0);  // Layer info length = 0

// Empty global mask
writer.writeUint32(0);  // Global mask length = 0

// Lr16 tagged block
writer.writeString('8BIM');
writer.writeString('Lr16');
writer.writeUint32(lr16Data.length);
writer.writeBytes(lr16Data);  // Contains layer count + all layer records
```

## Mt16 Block

The reference file includes an empty `Mt16` block before `Lr16`:
```
8BIM Mt16 00 00 00 00  (signature, key, length=0)
```

Purpose unknown, but appears to be a marker for 16-bit mask/transparency support. We should include it for compatibility.

## Compression

**8-bit files:** Typically use compression type 0 (raw) or 1 (RLE)
**16-bit files:** Use compression type 3 (ZIP/zlib) for masks

For our implementation:
- We'll use compression type 0 (raw) for masks initially
- ZIP compression can be added later for file size optimization

## File Size Comparison

**8-bit:** JethroAsMonroe.psd = 16 MB
**16-bit:** JethroAsMonroe-16bit.psd = 313 MB

The 16-bit file is ~20× larger primarily due to:
- Higher precision in image data section (composite preview)
- Larger mask data (even though compressed)

For fill layers with no raster data, the difference is smaller since L/a/b channels don't store pixel data in either format.

## Summary of Differences

| Aspect | 8-bit | 16-bit |
|--------|-------|--------|
| Header depth | 8 | 16 |
| Layer storage | Layer Info section | Lr16 tagged block |
| Layer bounds | (0,0,w,h) | (0,0,0,0) |
| L/a/b channel data | Solid fill pixels | None (0 bytes) |
| Mask channel data | 8-bit raw | 8-bit raw/ZIP |
| SoCo descriptor | 112 bytes | 112 bytes (same) |
| Additional info | Same blocks | Same blocks |
| Mt16 block | Absent | Present (empty) |

## Next Steps

1. ✅ Analyze reference file structure
2. ✅ Document format differences
3. ⏳ Implement 16-bit PSDWriter
4. ⏳ Test with synthetic 16-bit file
5. ⏳ Verify Photoshop compatibility

## References

- Adobe PSD File Format Specification
- Reference files: `JethroAsMonroe.psd` (8-bit), `JethroAsMonroe-16bit.psd` (16-bit)
- Analysis tools: `analyze-reference.js`, `inspect-layer-section.js`
