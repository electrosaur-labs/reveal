# Parameter Analysis - Reveal Project Core
**Date:** 2026-01-19
**Analysis:** UI Parameters vs Engine Usage

---

## Executive Summary

**Total UI Parameters:** 24
**Engine-Used Parameters:** 19
**UI-Only Parameters:** 5
**Unused/Legacy Parameters:** 0

---

## All UI Parameters (24 Total)

### Category 1: Engine Selection (2 parameters)
1. **presetSelector** - Dropdown to load predefined parameter sets
2. **engineType** - Algorithm selection (reveal, balanced, classic, stencil)

### Category 2: Centroid Strategy (4 parameters)
3. **centroidStrategy** - SALIENCY or VOLUMETRIC
4. **lWeight** - Lightness weight for SALIENCY (1.0-3.0, default: 1.1)
5. **cWeight** - Chroma weight for SALIENCY (0.1-3.0, default: 2.0)
6. **blackBias** - Black protection multiplier (1.0-20.0, default: 5.0)

### Category 3: Substrate Detection (2 parameters)
7. **substrateMode** - auto, white, black, none
8. **substrateTolerance** - ΔE threshold for substrate culling (1.0-10.0, default: 3.5)

### Category 4: Color Vibrancy (2 parameters)
9. **vibrancyMode** - linear, aggressive, exponential
10. **vibrancyBoost** - Vibrancy multiplier (1.0-3.0, default: 1.6)

### Category 5: Highlight/Shadow Protection (2 parameters)
11. **highlightThreshold** - White point L-value (75-98, default: 85)
12. **highlightBoost** - Highlight boost multiplier (1.0-4.0, default: 2.2)

### Category 6: Palette Reduction (4 parameters)
13. **enablePaletteReduction** - Enable/disable merging (checkbox, default: true)
14. **paletteReduction** - Color merging threshold ΔE (2.0-20.0, default: 10.0)
15. **hueLockAngle** - Hue protection angle in degrees (10-30, default: 18)
16. **shadowPoint** - Shadow ceiling L-value (5-25, default: 15)

### Category 7: Color Mode & Target (4 parameters)
17. **colorMode** - color or bw (grayscale)
18. **targetColorsSlider** - Target color count (2-20, default: 6)
19. **preserveWhite** - Force white in palette (checkbox, default: false)
20. **preserveBlack** - Force black in palette (checkbox, default: false)

### Category 8: Hue Diversity (2 parameters)
21. **ignoreTransparent** - Skip transparent pixels (checkbox, default: true)
22. **enableHueGapAnalysis** - Force hue diversity (checkbox, default: true)

### Category 9: Dithering (1 parameter)
23. **ditherType** - none, floyd-steinberg, blue-noise, bayer, atkinson, stucki

### Category 10: Edge Quality (1 parameter)
24. **maskProfile** - Gray Gamma 2.2, Dot Gain 20%, Gray Gamma 1.8, sGray

---

## Engine Usage Breakdown

### PosterizationEngine.posterize() - Used Parameters (17)

**Core Engine Control:**
- ✅ `engineType` - Selects algorithm (reveal/balanced/classic/stencil)
- ✅ `centroidStrategy` - SALIENCY or VOLUMETRIC
- ✅ `grayscaleOnly` - Derived from `colorMode` (bw = true)

**Centroid Tuning (via options.tuning.centroid):**
- ✅ `lWeight` - Saliency L-weight
- ✅ `cWeight` - Saliency C-weight
- ✅ `blackBias` - Black boost multiplier

**Split Tuning (via options.tuning.split):**
- ✅ `vibrancyBoost` - Chroma-rich pixel weighting
- ✅ `highlightBoost` - Highlight multiplier

**Prune Tuning (via options.tuning.prune):**
- ✅ `paletteReduction` - Merge threshold (maps to `threshold`)
- ✅ `hueLockAngle` - Hue protection angle
- ✅ `highlightThreshold` - White point (maps to `whitePoint`)
- ✅ `shadowPoint` - Shadow ceiling

**Color Preservation:**
- ✅ `preserveWhite` - Force white into palette
- ✅ `preserveBlack` - Force black into palette

**Substrate Detection:**
- ✅ `substrateMode` - Substrate awareness mode
- ✅ `substrateTolerance` - ΔE threshold

**Feature Toggles:**
- ✅ `enableHueGapAnalysis` - Force hue diversity (may exceed target count)
- ✅ `enablePaletteReduction` - Enable/disable merging phase

### SeparationEngine.mapPixelsToPaletteAsync() - Used Parameters (1)

**Dithering:**
- ✅ `ditherType` - Algorithm selection (none/floyd-steinberg/blue-noise/bayer/atkinson/stucki)

### PhotoshopAPI (Adobe Plugin Only) - Used Parameters (1)

**Layer Mask Creation:**
- ✅ `maskProfile` - Gray Gamma 2.2 (hard edges) or Dot Gain 20% (soft edges)

---

## UI-Only Parameters (Not Used by Engines)

### 1. **presetSelector**
- **Purpose:** UI convenience for loading predefined parameter sets
- **Usage:** Sets other parameters, not passed to engines
- **Status:** Essential UI feature

### 2. **ignoreTransparent**
- **Purpose:** Skip transparent pixels during RGB→Lab conversion
- **Usage:** Handled in `PhotoshopAPI.getDocumentPixels()` before engine processing
- **Status:** Pre-processing, not an engine parameter
- **Note:** Effectively used, but not in the engine signature

### 3. **vibrancyMode**
- **Purpose:** Intended to select vibrancy algorithm (linear/aggressive/exponential)
- **Usage:** **NOT CURRENTLY USED** - Only `vibrancyBoost` multiplier is used
- **Status:** ⚠️ **CANDIDATE FOR REMOVAL OR IMPLEMENTATION**
- **Note:** UI exposes this dropdown but engine ignores it

---

## Parameter Flow Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      UI (index.html)                        │
│                     24 Input Controls                       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│              Parameter Collection (index.js)                │
│              Lines 1572-1593: gatherParameters()            │
└──────────────────────────────┬──────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │ Pre-Process  │  │ Posterization│  │  Separation  │
   │   (Adobe)    │  │   (Core)     │  │   (Core)     │
   └──────────────┘  └──────────────┘  └──────────────┘
   ignoreTransparent   17 parameters     ditherType
   (alpha check)       + tuning object
```

---

## Preset File Structure

**Location:** `/workspaces/electrosaur/reveal-project/packages/reveal-core/presets/*.json`

**Format:**
```json
{
  "id": "preset-id",
  "name": "Display Name",
  "description": "Purpose description",
  "settings": {
    "engineType": "reveal",
    "centroidStrategy": "VOLUMETRIC",
    "blackBias": 5.0,
    "lWeight": 1.0,
    "cWeight": 1.0,
    "paletteReduction": 8.0,
    "hueLockAngle": 15,
    "shadowPoint": 15,
    "highlightThreshold": 95
  }
}
```

**Preset Parameters (8 total):**
- engineType
- centroidStrategy
- blackBias
- lWeight
- cWeight
- paletteReduction
- hueLockAngle
- shadowPoint
- highlightThreshold (in some presets)

**Note:** Presets contain ~8 of the 24 parameters. Others use UI defaults.

---

## Missing/Incomplete Features

### ⚠️ vibrancyMode Not Implemented

**Current State:**
- UI dropdown exists with 3 options: linear, aggressive, exponential
- Parameter is collected from UI (line 1583)
- **Parameter is NOT passed to engine**
- Only `vibrancyBoost` (multiplier) is used

**Options:**
1. **Implement** - Add vibrancyMode logic to PosterizationEngine
2. **Remove** - Delete dropdown from UI, keep only vibrancyBoost slider
3. **Document** - Mark as "planned future feature"

**Recommendation:** Remove dropdown or implement. Current state is confusing.

---

## Parameter Naming Inconsistencies

### UI Name → Engine Name Mappings

| UI Parameter | Engine Parameter | Location |
|--------------|------------------|----------|
| `targetColorsSlider` | `targetColors` | Function argument |
| `paletteReduction` | `tuning.prune.threshold` | Options object |
| `highlightThreshold` | `tuning.prune.whitePoint` | Options object |
| `colorMode` | `grayscaleOnly` (boolean) | Derived value |

**Note:** These are intentional design choices for cleaner API, not bugs.

---

## Default Value Summary

| Parameter | UI Default | Engine Default | Notes |
|-----------|-----------|----------------|-------|
| targetColors | 6 | N/A | Required argument |
| engineType | "reveal" | "reveal" | Matches |
| centroidStrategy | "SALIENCY" | "SALIENCY" (reveal only) | Matches |
| lWeight | 1.1 | 1.1 | Matches |
| cWeight | 2.0 | 2.0 | Matches |
| blackBias | 5.0 | 5.0 | Matches |
| paletteReduction | 10.0 | 9.0 | ⚠️ **Mismatch** |
| hueLockAngle | 18 | 18 | Matches |
| shadowPoint | 15 | 15 | Matches |
| highlightThreshold | 85 | 85 | Matches |
| highlightBoost | 2.2 | 2.2 | Matches |
| vibrancyBoost | 1.6 | 1.6 | Matches |
| substrateTolerance | 3.5 | N/A | Always passed |
| ditherType | "none" | "none" | Matches |
| enableHueGapAnalysis | true | false | ⚠️ **Mismatch** |
| enablePaletteReduction | true | N/A | Always passed |

**Critical Mismatches:**
1. **paletteReduction:** UI default (10.0) ≠ Engine default (9.0)
2. **enableHueGapAnalysis:** UI default (true) ≠ Engine default (false)

---

## Recommendations

### Priority 1: Fix Default Mismatches
- [ ] Align `paletteReduction` defaults (use 10.0 in both)
- [ ] Align `enableHueGapAnalysis` defaults (use true in both, or document intentional difference)

### Priority 2: Implement or Remove vibrancyMode
- [ ] Either implement mode selection logic in engine
- [ ] Or remove dropdown from UI

### Priority 3: Documentation
- [ ] Add JSDoc for all 24 parameters
- [ ] Document which parameters affect which engine phases
- [ ] Create user-facing parameter guide

### Priority 4: Testing
- [ ] Verify all 17 engine parameters actually work
- [ ] Test preset loading for all 10 presets
- [ ] Validate default value behavior

---

## Technical Notes

### Parameter Injection Pattern

**UI → Engine Flow:**
```javascript
// 1. UI collects 24 parameters (lines 1572-1593)
const params = gatherParameters();

// 2. Tuning object built from subset (lines 2153-2161)
const tuning = {
    split: { highlightBoost, vibrancyBoost },
    prune: { threshold, hueLockAngle, whitePoint, shadowPoint },
    centroid: { lWeight, cWeight, blackBias }
};

// 3. Engine called with flat + nested structure (lines 2164-2190)
PosterizationEngine.posterize(pixels, width, height, colorCount, {
    engineType,
    centroidStrategy,
    preserveWhite,
    preserveBlack,
    // ... 14 more flat parameters
    tuning  // nested object
});
```

### Why Nested Tuning Object?

**Historical Context:**
- Original engine had hardcoded `TUNING` constant
- Refactored to accept runtime overrides
- Nested structure preserves internal algorithm phases (split, prune, centroid)
- Maintains backward compatibility with internal code

---

## Quick Reference: Parameter Locations

**UI Definition:** `/workspaces/electrosaur/reveal-project/packages/reveal-adobe/src/index.html`
- Lines 884-1375: All 24 input controls

**Parameter Collection:** `/workspaces/electrosaur/reveal-project/packages/reveal-adobe/src/index.js`
- Lines 1572-1593: `gatherParameters()` function

**Engine Signature:** `/workspaces/electrosaur/reveal-project/packages/reveal-core/lib/engines/PosterizationEngine.js`
- Lines 144-217: `posterize()` method

**Preset Storage:** `/workspaces/electrosaur/reveal-project/packages/reveal-core/presets/`
- 10 JSON files with 8 parameters each

---

**Analysis Complete:** 2026-01-19
**Status:** All 24 parameters documented, 3 issues identified
