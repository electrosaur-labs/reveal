# Definitive Guide: Finder Icons & QuickLook for Lab PSDs

**Last Updated:** 2026-03-04
**Validated On:**
- 100+ CQ100 benchmark images (16-bit Lab PSDs)
- Reveal-15 TESTIMAGES dataset (16-bit PNG → 16-bit Lab PSDs)
- Art Institute of Chicago archival images
- Photoshop-generated reference files (astronaut-16bit-PS.psd)
- **Layered separated PSDs (posterize-psd.js output) — 2026-03-04**

**macOS Compatibility:** Tested on macOS Ventura/Sonoma with 8-bit and 16-bit Lab PSDs

---

## TL;DR - Two Recipes

### Recipe 1: Flat PSD (no layers)

```javascript
const writer = new PSDWriter({
    width, height,
    colorMode: 'lab',
    bitsPerChannel: 16,
    compression: 'none'           // CRITICAL: uncompressed Section 5
});

writer.setThumbnail({ jpegData, width: tw, height: th });  // Resource 1036
writer.setComposite(lab8bitPixels);  // Sets flatMode — 3 channels only
const psdBuffer = writer.write();
```

### Recipe 2: Layered PSD (separated output with layers)

```javascript
const writer = new PSDWriter({
    width, height,
    colorMode: 'lab',
    bitsPerChannel: 16,
    compression: 'none'           // CRITICAL: uncompressed Section 5
});

// Add layers FIRST
writer.addPixelLayer({ name: 'Reference', pixels: lab8bit, visible: false });
writer.addFillLayer({ name: 'Color 1', color: labColor, mask: maskData });
// ... more layers ...

// THEN set thumbnail + composite
writer.setThumbnail({ jpegData, width: tw, height: th });  // Resource 1036
writer.setComposite(lab8bitPixels);  // Does NOT set flatMode when layers exist
const psdBuffer = writer.write();
```

**Both recipes produce working Finder icons AND QuickLook previews.**

---

## Critical Requirements (Non-Negotiable)

### 1. Resource 1036 (Photoshop Standard)

**Use Resource 1036** - This is what Photoshop uses and what works reliably:

```javascript
writer.setThumbnail({
    jpegData: thumbJpegBuffer,  // JPEG thumbnail
    width: thumbWidth,           // Thumbnail width
    height: thumbHeight          // Thumbnail height
});
```

**Note:** Some documentation mentions Resource 1033 as "current standard", but Photoshop itself uses 1036, and this is what we've verified works across 100+ test images.

### 2. 8-bit Lab Composite (Even for 16-bit PSDs!)

**CRITICAL INSIGHT:** Photoshop-created 16-bit Lab PSDs use **8-bit Lab composite data** in Section 5, which PSDWriter upsamples to 16-bit internally (×257).

```javascript
// For 16-bit PSDs, still use 8-bit Lab composite
const lab8bit = new Uint8Array(width * height * 3);
for (let i = 0; i < pixelCount; i++) {
    lab8bit[i * 3] = L_value;     // L: 0-255
    lab8bit[i * 3 + 1] = a_value; // a: 0-255 (128 = neutral)
    lab8bit[i * 3 + 2] = b_value; // b: 0-255 (128 = neutral)
}

writer.setComposite(lab8bit);
```

PSDWriter automatically upsamples when `bitsPerChannel: 16`.

**DO NOT use native 16-bit composite data** — QuickLook cannot parse it. The PSD file format 16-bit encoding uses 0-65535 range (NOT the UXP API's 0-32768 range), but QuickLook still needs the 8-bit input.

### 3. Uncompressed Section 5

**CRITICAL:** Use `compression: 'none'` (not `compositeCompression`):

```javascript
const writer = new PSDWriter({
    width, height,
    colorMode: 'lab',
    bitsPerChannel: 16,
    compression: 'none'  // ← Correct option name
});
```

**WRONG:**
```javascript
compositeCompression: 'none'  // ← This option doesn't exist!
```

RLE compression in Section 5 breaks QuickLook for Lab PSDs.

### 4. setComposite() Behavior

`setComposite()` stores 8-bit Lab composite data for Section 5 (QuickLook preview).

**For flat PSDs:** Also enables flat mode (empty Section 4, 3 channels in header).

**For layered PSDs:** Does NOT enable flat mode. Layers are written normally in Section 4 (Lr16 block). Header declares 3 + N channels. Section 5 includes composite + extra alpha channels. Both QuickLook and Photoshop work.

---

## Working Format Summary

| Component | Flat PSD | Layered PSD |
|-----------|----------|-------------|
| Header channels | 3 (L, a, b) | 3 + min(layers, 4) |
| Resource 1036 | JPEG thumbnail | JPEG thumbnail |
| Section 4 | Empty (flat mode) | Lr16 block with layer data |
| Section 5 compression | **none** | **none** |
| Section 5 data | 8-bit Lab (upsampled) | 8-bit Lab (upsampled) + extra alphas |
| Finder icon | ✓ | ✓ |
| QuickLook | ✓ | ✓ |
| Photoshop opens | ✓ | ✓ (with layers) |

---

## Common Issues & Solutions

### Problem: Black Rectangle in QuickLook

**Causes:**
1. Using RLE compression instead of uncompressed
2. Native 16-bit Lab composite data (instead of 8-bit upsampled)

**Solution:**
```javascript
const writer = new PSDWriter({
    compression: 'none'  // ✓ Correct
});
writer.setComposite(lab8bit);  // ✓ 8-bit, will be upsampled
```

### Problem: Photoshop Can't Open File

**Causes:**
1. Header channel count doesn't match Section 5 channel count
2. Header says 3 channels but layers exist (need 3 + N)
3. `flatMode` accidentally enabled when layers were added

**Solution:** Ensure `setComposite()` does NOT set `flatMode` when layers exist. Header channel count must be `3 + min(layers.length, 4)` for layered files.

### Problem: No Layers in Output

**Cause:** `setComposite()` was setting `flatMode = true`, which skips layer writing in Section 4.

**Solution:** `setComposite()` must not touch `flatMode`. Flat mode should only be set by the constructor option `flat: true`.

### Problem: Generic PSD Icon (No Thumbnail)

**Causes:**
1. Missing thumbnail resource
2. Wrong resource ID
3. Malformed JPEG data

**Solution:**
```javascript
const thumbJpeg = await sharp(rgbBuffer, {
    raw: { width, height, channels: 3 }
})
.resize(thumbWidth, thumbHeight, { fit: 'inside' })
.jpeg({ quality: 90 })
.toBuffer();

writer.setThumbnail({
    jpegData: thumbJpeg,
    width: thumbWidth,
    height: thumbHeight
});
```

### Problem: Image Opens but Wrong Colors (Blue Cast)

**Cause:** Incorrect Lab 16-bit encoding — using UXP API range (0-32768) instead of PSD file format range (0-65535).

**Solution:** Always use 8-bit Lab for composite data. PSDWriter upsamples correctly via ×257.

```javascript
// Correct 8-bit Lab encoding
lab8bit[i * 3] = Math.round((lab.L / 100) * 255);  // L: 0-100 → 0-255
lab8bit[i * 3 + 1] = Math.round(lab.a + 128);      // a: -128..127 → 0-255
lab8bit[i * 3 + 2] = Math.round(lab.b + 128);      // b: -128..127 → 0-255
```

---

## Key Findings from Analysis

### Photoshop-Generated 16-bit Lab PSDs

Analyzing `astronaut-16bit-PS.psd` (Photoshop-created reference):
- ✓ Header: 16-bit Lab (depth=16, mode=9)
- ✓ Channels: 3 (L, a, b only - no alpha)
- ✓ Resource 1036: JPEG thumbnail (107×160, 5.7 KB)
- ✓ Section 5: Uncompressed (compression=0)
- ✓ Composite data: 8-bit values (0x7F-0x80 range)
- ✓ Layers: 0 (flat mode)

### Layered Separated PSDs (2026-03-04)

Testing `posterize-psd.js` output (16-bit Lab, 10+ layers):
- ✓ Header: 16-bit Lab, channels = 3 + min(layers, 4)
- ✓ Resource 1036: JPEG thumbnail (posterized preview)
- ✓ Section 4: Lr16 block with fill+mask layers
- ✓ Section 5: Uncompressed, 8-bit Lab composite + extra alpha channels
- ✓ Finder icon shows posterized result
- ✓ QuickLook shows posterized result
- ✓ Photoshop opens with all layers intact

---

## References

- Adobe PSD File Format Specification
- macOS QuickLook Preview Generator
- Photoshop Lab Color Mode (D65 illuminant)
- Working reference: `fixtures/astronaut-16bit-PS.psd`

---

**Success Rate:** 100% Finder icons + QuickLook across 100+ validated images (flat and layered) when following this guide.
