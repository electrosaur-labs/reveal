# DNA v2.0 ParameterGenerator Fix

**Date:** 2026-02-04
**Status:** ✅ FIXED - DNA v2.0 posterized JSON update complete

---

## Issue

When reprocessing images with the updated DNA v2.0 system, the batch processor crashed with:

```
TypeError: Cannot read properties of undefined (reading 'toFixed')
at DynamicConfigurator._applyDNAv2Overrides
(/workspaces/electrosaur/reveal-project/packages/reveal-core/lib/analysis/ParameterGenerator.js:267:56)
```

**Root cause:** ParameterGenerator was accessing `dna.hue_entropy` and `dna.temperature_bias` directly, but in DNA v2.0 structure these fields are nested inside `dna.global`.

---

## DNA v2.0 Structure

```javascript
{
  version: "2.0",
  global: {
    l: 72.8,
    c: 7.5,
    k: 100.0,
    l_std_dev: 30.8,
    hue_entropy: 0.414,        // ← Inside global object
    temperature_bias: 0.995,   // ← Inside global object
    primary_sector_weight: 0.664
  },
  dominant_sector: "yellow",
  sectors: { /* 12 hue sectors */ }
}
```

---

## Fix Applied

**File:** `packages/reveal-core/lib/analysis/ParameterGenerator.js`

**Lines 264-276:** Added fallback accessor for DNA v2.0 fields

```javascript
// Access DNA v2.0 fields from global object if available, fallback to top-level
const hue_entropy = dna.global?.hue_entropy ?? dna.hue_entropy;
const temperature_bias = dna.global?.temperature_bias ?? dna.temperature_bias;

if (hue_entropy !== undefined) {
    console.log(`   Hue Entropy: ${hue_entropy.toFixed(3)}`);
}
if (temperature_bias !== undefined) {
    console.log(`   Temperature: ${temperature_bias.toFixed(3)} (${temperature_bias > 0 ? 'warm' : 'cool'})`);
}
```

**Lines 310-335:** Updated all references to use local variables

```javascript
// Low Entropy (< 0.3): Limited Palette
if (hue_entropy !== undefined && hue_entropy < 0.3) {
    console.log(`   🎨 Limited Palette (entropy ${hue_entropy.toFixed(3)})`);
    // ...
}

// High Entropy (> 0.8): Rainbow Protection
else if (hue_entropy !== undefined && hue_entropy > 0.8) {
    console.log(`   🌈 High Diversity (entropy ${hue_entropy.toFixed(3)})`);
    // ...
}

// Cool Outlier Protection
if (coolPresence > 0.05 && temperature_bias !== undefined && temperature_bias > 0.5) {
    console.log(`   ❄️ Cool Outlier Protection...`);
    // ...
}
```

---

## Backward Compatibility

The fix maintains backward compatibility with both:

1. **DNA v1.0** - No `version` field, no `global` object
   - Falls back to top-level fields (if present)
   - Skips DNA v2.0 overrides gracefully

2. **DNA v2.0** - `version: "2.0"`, fields in `global` object
   - Reads from `dna.global.hue_entropy` and `dna.global.temperature_bias`
   - Applies full DNA v2.0 trait stack

---

## Verification

**Test image:** `wood_game.psd` (16-bit Lab, 2400×2400)

**Output:** `/workspaces/electrosaur/reveal-project/packages/reveal-batch/data/TESTIMAGES/output/psd/16bit/wood_game.json`

**Verified fields:**

```json
{
  "dna": {
    "version": "2.0",
    "global": {
      "l": 72.8,
      "c": 7.5,
      "hue_entropy": 0.414,
      "temperature_bias": 0.995
    },
    "dominant_sector": "yellow",
    "sectors": { /* 12 sectors */ }
  },
  "configuration": {
    "meta": {
      "archetype": "Warm Tonal / Yellow Protect",
      "matchVersion": "2.0",
      "matchScore": 59.87,
      "matchBreakdown": {
        "structural": 8.9,
        "sectorAffinity": 100,
        "pattern": 75.5
      }
    }
  }
}
```

✅ DNA v2.0 structure present
✅ Archetype matching score breakdown included
✅ 12 hue sectors validated
✅ No runtime errors

---

## Batch Reprocessing

**Command:**
```bash
cd /workspaces/electrosaur/reveal-project/packages/reveal-batch/data/TESTIMAGES
rm output/psd/16bit/*.psd output/psd/16bit/*.json
./batch-process-flat.js
```

**Status:** Running in background (task ID: b6484df)

**Expected:** All 40 TESTIMAGES reprocessed with DNA v2.0 posterized JSON format

---

## Files Modified

1. **packages/reveal-core/lib/analysis/ParameterGenerator.js** (lines 264-335)
   - Added fallback accessor for `hue_entropy` and `temperature_bias`
   - Updated all references to use local variables with `undefined` checks
   - Maintains backward compatibility with DNA v1.0

---

**Status:** ✅ Fix complete, batch reprocessing in progress
