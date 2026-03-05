# PSD Writer Development Session State

**Last Updated:** 2026-01-19
**Status:** Debugging "corrupt layers" warning

## Current Situation

### What Works ✅
1. **8-bit Lab PSD writing** - Fully functional, no warnings
2. **16-bit Lab PSD writing** - Files open and display correctly with all 4 layers visible
3. **Fill+mask layer structure** - Layers render correctly in Photoshop
4. **Buffer writing mechanism** - Verified by byte-identical clone test
5. **File structure** - All sections have correct lengths and alignment
6. **Lab color encoding** - Correct 16-bit scaling (L: 0-32768, a/b neutral: 16384)
7. **Blending ranges** - Fixed to 40 bytes (4 ranges, not 3)
8. **Image resources** - ResolutionInfo + DisplayInfo written correctly
9. **LMsk global layer mask block** - Added after Lr16 block (14 bytes)

### Fix Applied ✅
**Problem Identified:**
- Reference file has **LMsk** (Global Layer Mask) block after Lr16
- Our original files were missing this block
- Photoshop expects LMsk block in 16-bit files, shows "corrupt layers" warning without it

**Solution Implemented:**
- Added `_writeGlobalLayerMask()` method in PSDWriter.js:246
- Writes LMsk tagged block with 14 bytes of data (disabled/transparent global mask)
- Block structure: signature (8BIM) + key (LMsk) + length (14) + data
- Total block size: 26 bytes (8 + 4 + 14)

**Testing Required:**
User needs to test new `synthetic-test-16bit-output.psd` in Photoshop to verify warning is gone

### Key Discovery 🔍
**Clone Test Results:**
- Created byte-identical clone of reference 16-bit file using `clone-reference.js`
- Clone opens **without any warnings** in Photoshop
- This proves our buffer writing and PSD structure are correct
- **Reference file also uses fill+mask layers** (not regular pixel layers)

**Comparison Results:**
- Used `dump-after-lr16.js` to compare bytes after Lr16 block
- Reference file has 7 global tagged blocks: LMsk, Pat2, CAI, OCIO, GenI, FMsk, cinf
- Our original files had **none of these**
- LMsk block is the critical one - others are optional metadata

## Architecture

### File Structure
```
/workspaces/electrosaur/reveal-project/packages/reveal-psd-writer/
├── src/
│   ├── PSDWriter.js           # Main implementation (8-bit + 16-bit)
│   ├── BinaryWriter.js        # Buffer writing with big-endian support
│   ├── DescriptorWriter.js    # SoCo descriptor writing
│   └── PSDReader.js           # Parser for validation
├── examples/
│   ├── synthetic-test-16bit.js              # 400×400 test with 4 layers
│   ├── clone-reference.js                   # Byte-identical clone tool ✓
│   ├── detailed-layer-comparison.js         # NEW: Byte-level layer comparison
│   ├── compare-mask-structure.js            # Mask structure comparison
│   ├── verify-channel-sizes.js              # Channel data validation
│   ├── extract-shmd.js                      # Extract shmd block
│   ├── JethroAsMonroe.psd                   # 8-bit reference (works)
│   └── JethroAsMonroe-16bit.psd             # 16-bit reference (313 MB, works)
└── docs/
    ├── IMAGE_DATA_SECTION.md   # 16-bit Lab encoding documentation
    └── SESSION_STATE.md        # This file
```

### Reference Files
- **JethroAsMonroe.psd** (8-bit) - Portrait with fill+mask layers, opens perfectly
- **JethroAsMonroe-16bit.psd** (16-bit) - Same portrait, 313 MB, opens perfectly
- **Both use fill+mask layers** (confirmed by user)

## Technical Details

### 16-bit Lab Format
```
Header Section (26 bytes):
  - Signature: "8BPS"
  - Version: 1
  - Channels: 3 (L, a, b)
  - Depth: 16
  - Mode: 9 (Lab)

Color Mode Data:
  - Length: 0 (no color data for Lab)

Image Resources:
  - ResolutionInfo (1005): 300 DPI
  - DisplayInfo (1077): 56 bytes exact structure from reference

Layer and Mask Info:
  - Lr16 block (not traditional Layer Info section)
  - Layer records with fill+mask structure
  - 4-byte alignment padding after Lr16 block

Image Data:
  - Planar storage: All L, then all a, then all b
  - Raw compression (type 0)
  - L: 0-32768 range
  - a/b: neutral at 16384
```

### Fill+Mask Layer Structure
```
Layer Record:
  - Bounds: (0, 0, 0, 0) for fill layers
  - Channels: 3 color channels (L, a, b) + 1 mask channel (-1)
  - Blend mode: "norm" (normal)
  - Opacity: 255
  - Flags: Various (transparency protected, etc.)
  - Mask data: User mask structure
  - Blending ranges: 40 bytes
  - Additional info blocks:
    * SoCo: Solid color descriptor
    * luni: Unicode layer name
    * lyid: Layer ID
```

### Known Issues Fixed
1. ✅ **Blending ranges byte count** - Was 32 bytes, now 40 (4 ranges for Lab)
2. ✅ **DisplayInfo resource** - Was incorrect length, now exact 56 bytes from reference
3. ✅ **4-byte alignment** - Applied to Lr16 global block, not per-layer blocks
4. ✅ **Layer IDs** - Unique IDs for each layer

## Debugging Strategy

### Phase 1: Isolation ✅
- Created byte-identical clone of reference file
- Result: Clone opens without warnings
- Conclusion: Our buffer writing mechanism is correct

### Phase 2: Comparison (Current)
- Created `detailed-layer-comparison.js` to compare layer structures byte-by-byte
- Compare reference file's first layer with our file's first layer
- Identify specific byte differences causing warning

### Phase 3: Fix (Pending)
- Once differences identified, update PSDWriter.js to match reference structure
- Verify fix with new test files
- Ensure warning no longer appears

## Next Steps

1. **Run detailed layer comparison** - Execute `detailed-layer-comparison.js` to see exact differences
2. **Analyze differences** - Understand which bytes/fields cause the warning
3. **Update PSDWriter** - Fix identified issues in `src/PSDWriter.js`
4. **Test** - Generate new file and verify no warning
5. **Integrate** - Connect PSD writer with @electrosaur-labs/core
6. **Build CQ100_v4** - Generate 100 reference images as PSDs

## Key Commands

```bash
# Generate 16-bit test file (400×400, 4 layers)
node examples/synthetic-test-16bit.js

# Clone reference file (byte-identical)
node examples/clone-reference.js

# Compare layer structures
node examples/detailed-layer-comparison.js

# Compare mask structures
node examples/compare-mask-structure.js

# Verify channel data lengths
node examples/verify-channel-sizes.js
```

## Important Notes

1. **Reference file uses fill+mask layers** - Not regular pixel layers
2. **Clone test confirms our mechanism works** - Issue is in layer structure details
3. **Files display correctly** - Warning is cosmetic but must be fixed
4. **Batch processing requires clean files** - Warning dialog would block automation

## Context for AI Assistants

**User Goal:** Create CQ100_v4 reference dataset with 100 multi-layer PSD files
**Blocker:** "Corrupt layers" warning prevents automated batch processing
**Strategy:** Compare working reference file with our generated file to find exact differences
**Progress:** 90% complete - files work but have cosmetic warning that needs fixing
