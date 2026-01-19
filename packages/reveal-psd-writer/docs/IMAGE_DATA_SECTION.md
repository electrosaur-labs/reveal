# Image Data Section - 16-bit Lab PSD

## Overview

The Image Data section (Section 5) is the final section of a PSD file. It contains the **merged/composite preview** that Photoshop displays before parsing individual layers.

**Critical:** This preview must match the visual result of compositing all layers, or the image will "flicker" when Photoshop finishes loading.

## Structure (16-bit Lab)

```
Offset  Size        Value       Description
------  ----------  ----------  ------------------------------------
0       2 bytes     0 or 1      Compression (0=Raw, 1=RLE)
2       W×H×2       Binary      Channel 0 (L): All pixels big-endian
...     W×H×2       Binary      Channel 1 (a): All pixels big-endian
...     W×H×2       Binary      Channel 2 (b): All pixels big-endian
```

**Important:** PSD uses **planar format**, not interleaved:
- ❌ NOT: L₁, a₁, b₁, L₂, a₂, b₂, ...
- ✅ YES: L₁, L₂, ..., Lₙ, a₁, a₂, ..., aₙ, b₁, b₂, ..., bₙ

## 16-bit Lab Scaling Formulas

Photoshop uses a **15-bit+1 range** (0-32768) for 16-bit Lab:

### Lightness (L)
Maps 0.0-100.0 to 0-32768:
```javascript
L16 = Math.round(L_float × 327.68)
```

Range check:
```javascript
L16 = Math.max(0, Math.min(32768, L16))
```

### Chroma (a and b)
Maps -128.0 to +127.0 to 0-32768, with **16384 as neutral**:
```javascript
a16 = Math.round(a_float × 128) + 16384
b16 = Math.round(b_float × 128) + 16384
```

Range check:
```javascript
a16 = Math.max(0, Math.min(32768, a16))
b16 = Math.max(0, Math.min(32768, b16))
```

**Key values:**
- L=0 (black) → 0
- L=50 (mid-grey) → 16384
- L=100 (white) → 32768
- a=0 (neutral) → 16384
- b=0 (neutral) → 16384

## Implementation Example

```javascript
_writeImageData(writer, labPixels) {
    // Compression: 0 = raw
    writer.writeUint16(0);

    const pixelCount = this.width * this.height;

    // Channel 0: Lightness (L)
    for (let i = 0; i < pixelCount; i++) {
        const L_float = labPixels[i * 3];
        const L16 = Math.max(0, Math.min(32768, Math.round(L_float * 327.68)));
        writer.writeUint16(L16);  // Big-endian
    }

    // Channel 1: a (green-red)
    for (let i = 0; i < pixelCount; i++) {
        const a_float = labPixels[i * 3 + 1];
        const a16 = Math.max(0, Math.min(32768, Math.round(a_float * 128) + 16384));
        writer.writeUint16(a16);  // Big-endian
    }

    // Channel 2: b (blue-yellow)
    for (let i = 0; i < pixelCount; i++) {
        const b_float = labPixels[i * 3 + 2];
        const b16 = Math.max(0, Math.min(32768, Math.round(b_float * 128) + 16384));
        writer.writeUint16(b16);  // Big-endian
    }
}
```

## Neutral Backgrounds

If you don't want to calculate a perfect merged preview (e.g., for test files or when the user relies on layers), you can write a **neutral background**:

### Option 1: Black Background (current test implementation)
```javascript
// L channel: Black (L=0)
for (let i = 0; i < pixelCount; i++) {
    writer.writeUint16(0);
}

// a channel: Neutral
for (let i = 0; i < pixelCount; i++) {
    writer.writeUint16(16384);
}

// b channel: Neutral
for (let i = 0; i < pixelCount; i++) {
    writer.writeUint16(16384);
}
```

### Option 2: Mid-Grey Background (recommended by Architect)
```javascript
// L channel: Mid-grey (L=50)
for (let i = 0; i < pixelCount; i++) {
    writer.writeUint16(16384);
}

// a channel: Neutral
for (let i = 0; i < pixelCount; i++) {
    writer.writeUint16(16384);
}

// b channel: Neutral
for (let i = 0; i < pixelCount; i++) {
    writer.writeUint16(16384);
}
```

## Compression

### Compression 0: Raw (Recommended for Development)
- Easiest to implement and debug
- Write pixels directly, no encoding
- Larger file size

### Compression 1: RLE (PackBits)
- Standard PSD compression
- Can be added after validation
- Smaller file size

For CQ100_v4 validation, use **Compression 0 (Raw)** initially.

## Validation

When testing in Photoshop:
1. File should open instantly with the merged preview
2. After parsing layers, the image should look **identical**
3. If colors "flicker" or shift after loading, your merged preview math doesn't match your layer math

## Current Implementation Status

**File:** `/workspaces/electrosaur/reveal-project/packages/reveal-psd-writer/src/PSDWriter.js`
**Method:** `_writeImageData()` (lines 481-524)

**Current behavior:**
- ✅ Planar format (all L, then all a, then all b)
- ✅ Compression 0 (raw)
- ✅ Correct neutral point (16384 for a/b)
- ✅ Big-endian byte order
- 📝 Uses black background (L=0) for test files

**Future integration:**
When integrating with @reveal/core, we'll need to either:
1. Calculate proper merged preview from layer stack (accurate but slower)
2. Use neutral grey background (L=16384, faster but shows grey before layers load)

## References

- Adobe PSD File Format Specification (Image Data section)
- Architect guidance on 16-bit Lab scaling (2026-01-19)
- Test files: `synthetic-test-16bit-output.psd`
