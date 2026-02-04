# UI Archetype Update - All 18 DNA v2.0 Archetypes

**Date:** 2026-02-04
**Status:** ✅ Complete - Ready for Build

---

## Changes Made

### 1. Updated Archetype Loading (index.js)

**File:** `packages/reveal-adobe/src/index.js`
**Lines:** 2850-2878

**Before:** 13 archetypes loaded
**After:** 18 archetypes loaded (all DNA v2.0 archetypes)

```javascript
const ARCHETYPES = {
    // Core archetypes (DNA v2.0 optimized) - 16 NEW
    'subtle-naturalist': require('@reveal/core/archetypes/subtle-naturalist.json'),
    'structural-outlier-rescue': require('@reveal/core/archetypes/structural-outlier-rescue.json'),
    'blue-rescue': require('@reveal/core/archetypes/blue-rescue.json'),
    'silver-gelatin': require('@reveal/core/archetypes/silver-gelatin.json'),
    'neon-graphic': require('@reveal/core/archetypes/neon-graphic.json'),
    'cinematic-moody': require('@reveal/core/archetypes/cinematic-moody.json'),
    'muted-vintage': require('@reveal/core/archetypes/muted-vintage.json'),         // NEW
    'pastel-high-key': require('@reveal/core/archetypes/pastel-high-key.json'),     // NEW
    'noir-shadow': require('@reveal/core/archetypes/noir-shadow.json'),             // NEW
    'pure-graphic': require('@reveal/core/archetypes/pure-graphic.json'),
    'vibrant-tonal': require('@reveal/core/archetypes/vibrant-tonal.json'),
    'warm-tonal-optimized': require('@reveal/core/archetypes/warm-tonal-optimized.json'),
    'thermonuclear-yellow': require('@reveal/core/archetypes/thermonuclear-yellow.json'),
    'soft-ethereal': require('@reveal/core/archetypes/soft-ethereal.json'),
    'hard-commercial': require('@reveal/core/archetypes/hard-commercial.json'),     // NEW
    'bright-desaturated': require('@reveal/core/archetypes/bright-desaturated.json'), // NEW

    // Legacy archetypes (backward compatibility) - 2
    'vibrant-hyper': require('@reveal/core/archetypes/vibrant-hyper.json'),
    'standard-balanced': require('@reveal/core/archetypes/standard-balanced.json')
};
```

### 2. Parameter Flow Verification

**Confirmed Working:**

1. **Archetype Selection → UI**
   - Line 4253-4273: Archetype dropdown populated from `ARCHETYPES` object
   - Line 4276-4435: Change handler loads archetype parameters
   - Line 4370-4393: Parameter mapping to UI controls
   - Line 4428: Complete config stored in `lastGeneratedConfig`

2. **UI → Backend (Posterization)**
   - Line 3709-3714: Merges `lastGeneratedConfig` + UI form values
   - Config-only parameters preserved (not in UI but in archetype)
   - Line 3719-3724: Logs config-only parameters

3. **Analyze Image → Archetype → UI**
   - Line 3160: Stores complete ParameterGenerator config
   - Line 3251: Applies UI settings from config
   - Line 3282-3284: Sets archetype selector to "auto"

---

## Parameter Coverage

### Parameters in UI (23 total)

✅ All UI-exposed parameters properly mapped:

| Parameter | UI Element | Type |
|-----------|------------|------|
| `targetColorsSlider` | Slider | Number (3-15) |
| `ditherType` | Dropdown | String |
| `distanceMetric` | Dropdown | String |
| `lWeight` | Slider | Number |
| `cWeight` | Slider | Number |
| `blackBias` | Slider | Number |
| `vibrancyMode` | Dropdown | String |
| `vibrancyBoost` | Slider | Number |
| `highlightThreshold` | Slider | Number |
| `highlightBoost` | Slider | Number |
| `enablePaletteReduction` | Checkbox | Boolean |
| `paletteReduction` | Slider | Number |
| `substrateMode` | Dropdown | String |
| `substrateTolerance` | Slider | Number |
| `shadowPoint` | Slider | Number |
| `enableHueGapAnalysis` | Checkbox | Boolean |
| `hueLockAngle` | Slider | Number |
| `colorMode` | Dropdown | String |
| `preserveWhite` | Checkbox | Boolean |
| `preserveBlack` | Checkbox | Boolean |
| `ignoreTransparent` | Checkbox | Boolean |
| `maskProfile` | Dropdown | String |
| `preprocessingIntensity` | Dropdown | String |

### Config-Only Parameters (4 total)

✅ Preserved in `lastGeneratedConfig`, not exposed in UI:

- `vibrancyThreshold` - Advanced vibrancy control
- `neutralSovereigntyThreshold` - Neutral axis protection (DNA v2.0)
- `neutralCentroidClampThreshold` - Neutral centroid clamping (DNA v2.0)
- *(Other archetype-specific parameters)*

**These parameters:**
- Are included in archetype JSON files
- Stored in `lastGeneratedConfig` when archetype selected
- Merged into posterization parameters (line 3712)
- Not shown in UI (by design - advanced parameters)

---

## 18 Archetypes in UI

When users open the archetype dropdown, they'll see:

```
Analyze Image...
──────────────
Subtle Naturalist                    ← DNA v2.0
Structural Outlier Rescue            ← DNA v2.0
Blue Rescue                          ← DNA v2.0
Silver Gelatin                       ← DNA v2.0
Neon Graphic                         ← DNA v2.0
Cinematic Moody                      ← DNA v2.0
Muted Vintage                        ← DNA v2.0 NEW
Pastel High-Key                      ← DNA v2.0 NEW
Noir Shadow                          ← DNA v2.0 NEW
Pure Graphic                         ← DNA v2.0
Vibrant Tonal                        ← DNA v2.0
Warm Tonal Optimized                 ← DNA v2.0
Thermonuclear Yellow                 ← DNA v2.0
Soft Ethereal                        ← DNA v2.0
Hard Commercial                      ← DNA v2.0 NEW
Bright Desaturated                   ← DNA v2.0 NEW
Vibrant Hyper                        ← Legacy
Standard Balanced                    ← Legacy (fallback)
──────────────
Manual Input
```

---

## Parameter Wiring Flow

### Forward Flow (Archetype → UI → Posterization)

```
1. User selects archetype from dropdown
   └─> archetypeSelector.addEventListener('change') [Line 4276]

2. Load archetype parameters
   └─> const archetype = ARCHETYPES[selectedValue] [Line 4363]
   └─> const params = archetype.parameters [Line 4367]

3. Map to UI controls
   └─> const paramMapping = {...} [Line 4370-4393]
   └─> Apply to form elements [Line 4396-4425]

4. Store complete config
   └─> lastGeneratedConfig = { ...params } [Line 4428]
       (Includes config-only parameters!)

5. User clicks "Posterize"
   └─> const formParams = getFormValues() [Line 3710]
   └─> const params = {
           ...lastGeneratedConfig,  // Complete archetype params
           ...formParams            // User overrides from UI
       } [Line 3712-3714]

6. Posterize with merged params
   └─> Includes all archetype parameters + user adjustments
```

### Reverse Flow (Analyze Image → Archetype → UI)

```
1. User clicks "Analyze Image"
   └─> Generate DNA from image pixels

2. ParameterGenerator.generate(dna)
   └─> Returns complete config object
   └─> Includes archetype selection + all parameters

3. Store config
   └─> lastGeneratedConfig = config [Line 3160]
   └─> lastImageDNA = dna [Line 3151]

4. Apply UI settings
   └─> applyAnalyzedSettings(uiSettings) [Line 3251]
       (Only UI-exposed parameters)

5. Update archetype selector
   └─> archetypeSelector.value = 'auto' [Line 3284]
```

---

## Backward Compatibility

### DNA v1.0 Support
- ✅ Legacy archetypes (`vibrant-hyper`, `standard-balanced`) still loaded
- ✅ DNA v1.0 images match using 4D distance
- ✅ Existing parameter mappings unchanged

### Mixed Usage
- ✅ User can select archetype OR use "Analyze Image"
- ✅ "Manual Input" mode still available
- ✅ Config-only parameters preserved in both flows

---

## Build Instructions

### 1. Rebuild Plugin

```bash
cd /workspaces/electrosaur/reveal-project/packages/reveal-adobe

# Build plugin (webpack bundles src/index.js → dist/index.js)
npm run build

# Verify build succeeded
ls -lh dist/index.js
# Expected: ~600-700 KB bundled file
```

### 2. Reload in Photoshop

**Option A: UXP Developer Tool**
```
1. Open UXP Developer Tool
2. Find "Reveal" plugin
3. Click "..." → "Reload"
```

**Option B: Photoshop Restart**
```
1. Quit Photoshop
2. Restart Photoshop
3. Plugins → Reveal
```

### 3. Verify Archetypes Loaded

**Check Console Log:**
```javascript
✓ Loaded archetype: "Subtle Naturalist" (subtle-naturalist)
✓ Loaded archetype: "Structural Outlier Rescue" (structural-outlier-rescue)
... (18 total)
✓ Populated archetype selector with 18 archetypes
```

**Check Dropdown:**
- Open Reveal plugin
- Click archetype dropdown
- Verify 18 archetypes + "Analyze Image" + "Manual Input" = 20 options

---

## Testing Checklist

### Basic Functionality
- [ ] Archetype dropdown shows all 18 archetypes
- [ ] "Analyze Image" still works
- [ ] "Manual Input" still works
- [ ] Selecting archetype loads parameters into UI
- [ ] UI values update correctly (sliders, dropdowns, checkboxes)

### DNA v2.0 Archetypes
- [ ] Select "Subtle Naturalist" → Check targetColors=8, distanceMetric=cie2000
- [ ] Select "Blue Rescue" → Check neutralSovereigntyThreshold logged (config-only)
- [ ] Select "Muted Vintage" → Parameters load correctly
- [ ] Select "Pastel High-Key" → Parameters load correctly
- [ ] Select "Noir Shadow" → Parameters load correctly
- [ ] Select "Hard Commercial" → Parameters load correctly
- [ ] Select "Bright Desaturated" → Parameters load correctly

### Parameter Preservation
- [ ] Select archetype, adjust UI slider, posterize → Both archetype params + UI override used
- [ ] Analyze image, adjust UI, posterize → Both DNA config + UI override used
- [ ] Config-only parameters (neutralSovereigntyThreshold) preserved through flow

### Backward Compatibility
- [ ] "Vibrant Hyper" (legacy) still works
- [ ] "Standard Balanced" (fallback) still works
- [ ] Existing presets (if any) still work

---

## Known Limitations

**Config-Only Parameters Not in UI:**
- `vibrancyThreshold`
- `neutralSovereigntyThreshold`
- `neutralCentroidClampThreshold`

These are advanced parameters that are:
- Set by archetype definitions
- Used during posterization
- Not adjustable via UI (by design)
- Logged to console for debugging

**Reason:** These parameters are DNA v2.0 specific and archetype-dependent. Exposing them in UI would add complexity for minimal benefit.

---

## Files Modified

1. **`packages/reveal-adobe/src/index.js`** (lines 2850-2878)
   - Added 5 new archetypes
   - Organized archetypes by category
   - Added comments for clarity

---

## Files to Build

- **Source:** `packages/reveal-adobe/src/index.js`
- **Output:** `packages/reveal-adobe/dist/index.js` (webpack bundle)

**Build command:** `npm run build` (in reveal-adobe package)

---

**Status:** ✅ Code changes complete. Ready to build and test in Photoshop.
