# PSD Format Findings - Fill+Mask Layers

## Executive Summary

Through empirical analysis of real Photoshop files, we identified and fixed critical differences between our generated PSD files and authentic Photoshop files. The key issues were:

1. ✅ **Descriptor format** - Missing key length fields and incorrect empty string encoding
2. ✅ **Channel structure** - Missing transparency mask channel (ID=-1)
3. ✅ **Layer flags** - Using 0x00 instead of 0x18
4. ✅ **Unicode layer names** - Missing 'luni' additional info block

## Reference File Analysis

**File:** `JethroAsMonroe.psd` (16.2 MB)
- 6 layers, each with Solid Color fill + user mask
- 5700×3900 pixels, 8-bit Lab color mode
- Compression: RLE/PackBits (type 1)

### Channel Structure (Per Layer)

Real Photoshop files have **5 channels** per fill+mask layer:

| Index | Channel ID | Purpose | Size Example |
|-------|------------|---------|--------------|
| 0 | -1 | Transparency mask | 358,802 bytes |
| 1 | 0 | L (Lightness) | 358,802 bytes |
| 2 | 1 | a (green-red) | 358,802 bytes |
| 3 | 2 | b (blue-yellow) | 358,802 bytes |
| 4 | -2 | User mask | 1,568,427 bytes |

**Our original implementation:** Only 4 channels (missing transparency mask)

### Layer Flags

Real Photoshop files use: `0x18` (binary: 00011000)

- Bit 3 (0x08): Pixel data irrelevant to appearance (fill layers)
- Bit 4 (0x10): Related to visibility/transparency

**Our original implementation:** `0x00` (all bits off)

### Additional Info Blocks

Real Photoshop files include many additional info blocks after SoCo:

| Key | Name | Size | Purpose |
|-----|------|------|---------|
| SoCo | Solid Color | 112 bytes | Fill color descriptor |
| luni | Unicode Name | Variable | Unicode layer name + null terminator |
| lyid | Layer ID | 4 bytes | Unique layer identifier |
| clbl | Blend Clipping | 4 bytes | Blend clipping elements |
| infx | Blend Interior | 4 bytes | Blend interior elements |
| knko | Knockout | 4 bytes | Knockout setting |
| lspf | Protected | 4 bytes | Protected settings flags |
| lclr | Layer Color | 8 bytes | Layer color in UI |
| shmd | Metadata | 72 bytes | Layer metadata |
| fxrp | Reference Point | 16 bytes | Reference point for effects |

**Our original implementation:** Only SoCo block

## Descriptor Format Analysis

### SoCo Descriptor Structure (112 bytes)

```
Offset  Hex Data                              Description
------  ------------------------------------  ---------------------------
0x0000  00 00 00 10                           Version: 16
0x0004  00 00 00 01                           Descriptor name length: 1 char
0x0008  00 00                                 Name: U+0000 (null char)
0x000A  00 00 00 00                           Class ID length: 0 (use 4-byte)
0x000E  6e 75 6c 6c                           Class ID: "null"
0x0012  00 00 00 01                           Item count: 1

Item 1 (Color property):
0x0016  00 00 00 00                           Key length: 0 (use 4-byte)
0x001A  43 6c 72 20                           Key: "Clr "
0x001E  4f 62 6a 63                           Type: "Objc" (Object)

Nested Object:
0x0022  00 00 00 01                           Name length: 1 char
0x0026  00 00                                 Name: U+0000 (null char)
0x0028  00 00 00 00                           Class ID length: 0
0x002C  4c 62 43 6c                           Class ID: "LbCl" (Lab Color)
0x0030  00 00 00 03                           Item count: 3

Sub-item 1 (Luminance):
0x0034  00 00 00 00                           Key length: 0
0x0038  4c 6d 6e 63                           Key: "Lmnc"
0x003C  64 6f 75 62                           Type: "doub" (double)
0x0040  40 59 00 00 00 00 00 00               Value: 100.0

Sub-item 2 (A channel):
0x0048  00 00 00 00                           Key length: 0
0x004C  41 20 20 20                           Key: "A   "
0x0050  64 6f 75 62                           Type: "doub"
0x0054  00 00 00 00 00 00 00 00               Value: 0.0

Sub-item 3 (B channel):
0x005C  00 00 00 00                           Key length: 0
0x0060  42 20 20 20                           Key: "B   "
0x0064  64 6f 75 62                           Type: "doub"
0x0068  00 00 00 00 00 00 00 00               Value: 0.0
```

### Key Findings

1. **Empty Unicode strings**: Photoshop writes length=1 with null character (U+0000), NOT length=0
2. **Key fields**: MUST include 4-byte length field before every key (0x00000000 for 4-byte keys)
3. **Class IDs**: Same format as keys (length + string, or 0 + 4-byte code)

### Bugs Fixed in DescriptorWriter

**Before:**
```javascript
// Wrong: No key length field
writer.writeString(item.key);

// Wrong: Empty strings as length=0
static _writeUnicodeString(writer, str) {
    writer.writeUint32(str.length);  // 0 for empty
    // ... chars
}
```

**After:**
```javascript
// Correct: Write key length field
static _writeKey(writer, key) {
    if (key.length === 4) {
        writer.writeUint32(0);  // Length 0 = use 4-byte key
        writer.writeString(key);
    } else {
        writer.writeUint32(key.length);
        writer.writeString(key);
    }
}

// Correct: Empty strings as length=1 + null char
static _writeUnicodeString(writer, str) {
    if (str.length === 0) {
        writer.writeUint32(1);      // Length 1
        writer.writeUint16(0);      // Null char U+0000
    } else {
        writer.writeUint32(str.length);
        for (let i = 0; i < str.length; i++) {
            writer.writeUint16(str.charCodeAt(i));
        }
    }
}
```

## luni Block Format

**Purpose:** Unicode layer name (more robust than Pascal string)

**Structure:**
```
Offset  Data                    Description
------  ----------------------  ---------------------------
0x0000  Length (4 bytes)        Total data length
0x0004  Char count (4 bytes)    Number of characters
0x0008  Unicode chars           2 bytes per char (UTF-16 BE)
...     Null terminator         0x0000 (2 bytes)
```

**Example:** Layer name "Red Layer" (9 characters)
```
00 00 00 16                     Length: 22 bytes (4 + 9*2 + 2)
00 00 00 09                     Char count: 9
00 52 00 65 00 64 00 20 ...     "Red Layer" in UTF-16 BE
00 00                           Null terminator
```

## Implementation Changes

### PSDWriter.js

1. **Channel structure** (lines 182-207):
   - Changed from 4 to 5 channels
   - Added transparency mask (ID=-1) before Lab channels
   - Renamed mask channel to "user mask" (ID=-2)

2. **Layer flags** (line 222):
   - Changed from `0x00` to `0x18`

3. **Channel data** (lines 299-335):
   - Added transparency channel write (all 255)
   - Write order: transparency, L, a, b, user mask

4. **Additional info blocks** (lines 243-297):
   - Added `_writeUnicodeLayerName()` method
   - Writes luni block after SoCo

### DescriptorWriter.js

1. **Key writing** (lines 69-71, 136-146):
   - Added `_writeKey()` method
   - All keys now have length field

2. **Unicode strings** (lines 104-116):
   - Empty strings: length=1 + null char
   - Non-empty: length + chars

## Validation

### Test Results

**Generated descriptor:** 112 bytes ✓
**Byte-for-byte match:** YES ✓

```bash
$ node examples/test-descriptor.js
Generated descriptor: 112 bytes

0000: 00 00 00 10 00 00 00 01 00 00 00 00 00 00 6e 75
0010: 6c 6c 00 00 00 01 00 00 00 00 43 6c 72 20 4f 62
# ... (matches exactly) ...

Match: YES ✓
```

**Synthetic test file:** 176 KB (3 layers, 100×100 px)
- Includes: 5 channels per layer
- Includes: SoCo + luni blocks
- Includes: Correct flags and structure

## Remaining Differences

Our implementation is now structurally correct for the essential components. Remaining differences from real Photoshop files:

1. **Compression:** We use type 0 (raw), real files use type 1 (RLE)
   - Impact: Larger file sizes
   - Priority: Low (raw data is valid)

2. **Additional info blocks:** We only include SoCo + luni
   - Missing: lyid, clbl, infx, knko, lspf, lclr, shmd, fxrp
   - Impact: May affect advanced Photoshop features
   - Priority: Medium (test if fill layers work without them)

3. **Mask extra data:** Real files have 2 extra bytes in mask structure
   - Impact: Unknown
   - Priority: Low (may be optional)

## Next Steps

1. ✅ Test synthetic PSD in Photoshop
2. ⏳ Verify fill layers are recognized
3. ⏳ Verify masks work correctly
4. ⏳ Add remaining info blocks if needed
5. ⏳ Consider adding RLE compression for smaller files

## References

- Adobe PSD File Format Specification: https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/
- Reference file: `examples/JethroAsMonroe.psd`
- Analysis tools: `examples/analyze-reference.js`, `examples/extract-soco.js`, `examples/decode-soco.js`
