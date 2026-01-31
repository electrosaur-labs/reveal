# Archetype System Migration Guide

## Before (Hardcoded) vs After (Data-Driven)

### Before: Hardcoded in PresetArchitect.js

**Archetype Definition (Line 130-139):**
```javascript
const ARCHETYPES = [
    { id: "noir_shadow", name: "Deep Shadow / Noir", target: { l: 25, c: 10, k: 20 } },
    { id: "muted_vintage", name: "Muted / Vintage", target: { l: 60, c: 10, k: 8 } },
    // ... 6 more archetypes
];
```

**Parameter Mapping (Line 181-213):**
```javascript
switch (archetype.id) {
    case 'noir_shadow':
        config.blackBias = 8.0;
        config.targetColors = 6;
        break;
    case 'vibrant_hyper':
        config.saturationBoost = 1.25;
        config.ditherType = 'Bayer';
        break;
    // ... 6 more cases
}
```

**Problems:**
- Split definition (targets + parameters)
- Requires code changes to add archetype
- No validation or documentation
- 3D DNA only (L, C, K)

---

### After: JSON Configuration Files

**noir-shadow.json:**
```json
{
  "id": "noir_shadow",
  "name": "Deep Shadow / Noir",
  "description": "Dark, low color, high contrast (film noir, woodcuts, ink drawings)",
  "centroid": {
    "l": 25,
    "c": 10,
    "k": 80,
    "l_std_dev": 30
  },
  "weights": {
    "l": 0.5,
    "c": 1.0,
    "k": 1.5,
    "l_std_dev": 1.0
  },
  "parameters": {
    "targetColors": 6,
    "blackBias": 8.0,
    "saturationBoost": 1.0,
    "rangeClamp": [0, 100],
    "ditherType": "BlueNoise",
    "distanceMetric": "cie76",
    "vibrancyMode": "linear"
  }
}
```

**PresetArchitect.js (Simplified):**
```javascript
// Load archetypes from JSON
const archetypes = loadArchetypes();

// Match using 4D weighted distance
const archetype = nameArchetype(imageDNA, archetypes);

// Return parameters directly from JSON
return {
    id: archetype.id,
    name: archetype.name,
    description: archetype.description,
    ...archetype.parameters
};
```

**Benefits:**
- Single source of truth
- No code changes needed
- Self-documenting JSON
- 4D DNA (L, C, K, σL)
- Schema validation
- Version controlled

---

## Code Changes Summary

### PresetArchitect.js

| Method | Before | After |
|--------|--------|-------|
| `run()` | Hardcoded ARCHETYPES array | Calls `loadArchetypes()` |
| `nameArchetype()` | 3D distance, fixed weights | 4D distance, JSON weights |
| `generateConfig()` | 35-line switch statement | Returns `archetype.parameters` |
| `loadPassports()` | 3D DNA (L, C, K) | 4D DNA (L, C, K, σL) |
| `kMeans()` | 3D clustering | 4D clustering |

### New Methods

```javascript
static loadArchetypes() {
    // Reads all JSON files from reveal-core/archetypes/
    // Validates required fields
    // Sets default weights
    return archetypes;
}
```

---

## Adding New Archetype

### Before (Required Code Changes)
1. Add entry to ARCHETYPES array
2. Add case to switch statement
3. Keep both in sync
4. Test and rebuild

### After (Pure Configuration)
1. Create JSON file in `reveal-core/archetypes/`
2. Test: `node src/PresetArchitect.js`

**Example - Adding "retro_print.json":**
```json
{
  "id": "retro_print",
  "name": "Retro Print",
  "description": "1970s screen print aesthetic",
  "centroid": {
    "l": 55,
    "c": 35,
    "k": 65,
    "l_std_dev": 18
  },
  "weights": {
    "l": 0.5,
    "c": 1.5,
    "k": 1.2,
    "l_std_dev": 1.0
  },
  "parameters": {
    "targetColors": 7,
    "blackBias": 3.0,
    "saturationBoost": 1.15,
    "rangeClamp": [0, 100],
    "ditherType": "Atkinson",
    "distanceMetric": "cie76",
    "vibrancyMode": "moderate"
  }
}
```

That's it! No code changes needed.

---

## DNA Evolution: 3D → 4D

### Before: 3D DNA
```javascript
{
    l: 50,      // Lightness
    c: 30,      // Chroma
    k: 70       // Contrast
}
```

**Limitation:** Cannot distinguish flat vector art from photographs

### After: 4D DNA
```javascript
{
    l: 50,          // Lightness
    c: 30,          // Chroma
    k: 70,          // Contrast
    l_std_dev: 15   // Flatness (NEW!)
}
```

**Improvement:**
- Low σL (< 10) = Flat vector art → Muted/Vintage archetype
- High σL (> 25) = Complex photo → Cinematic/Noir archetype

---

## Distance Calculation

### Before: Fixed Weights
```javascript
const dL = (l - arch.target.l) * 1.0;
const dC = (c - arch.target.c) * 1.5;
const dK = (k - arch.target.k) * 2.0;
const dist = Math.sqrt(dL*dL + dC*dC + dK*dK);
```

### After: JSON-Defined Weights
```javascript
const dSquared =
    weights.l * (l - centroid.l)² +
    weights.c * (c - centroid.c)² +
    weights.k * (k - centroid.k)² +
    weights.l_std_dev * (l_std_dev - centroid.l_std_dev)²;
const dist = Math.sqrt(dSquared);
```

Each archetype can customize its own weighting!

---

## File Structure

```
reveal-project/
├── packages/
│   ├── reveal-core/
│   │   └── archetypes/              ← NEW
│   │       ├── README.md            ← Documentation
│   │       ├── schema.json          ← JSON Schema
│   │       ├── noir-shadow.json     ← Archetype definitions
│   │       ├── muted-vintage.json
│   │       ├── pastel-high-key.json
│   │       ├── vibrant-hyper.json
│   │       ├── hard-commercial.json
│   │       ├── soft-ethereal.json
│   │       ├── cinematic-moody.json
│   │       └── standard-balanced.json
│   │
│   ├── reveal-batch/
│   │   └── src/
│   │       └── PresetArchitect.js   ← REFACTORED (loads JSON)
│   │
│   └── reveal-adobe/
│       ├── scripts/
│       │   └── copy-assets.js       ← UPDATED (copies archetypes/)
│       └── dist/
│           └── archetypes/          ← Built output
│               ├── noir-shadow.json
│               └── ...
```

---

## Validation

### JSON Schema Validation (Optional)
```bash
npm install -g ajv-cli
cd packages/reveal-core/archetypes
ajv validate -s schema.json -d "noir-shadow.json"
```

### Testing
```bash
cd packages/reveal-batch
node src/PresetArchitect.js

# Should output:
# ✓ Loaded 8 archetypes from .../reveal-core/archetypes
# 🧠 Architecting Presets from 100 passports...
# ✨ DISCOVERED ARCHETYPES & GENERATING CONFIG:
# ...
```

---

## Troubleshooting

### "Cannot read properties of undefined (reading 'l')"
**Cause:** Wrong passport directory path
**Fix:** Update PASSPORT_DIR in PresetArchitect.js
```javascript
const PASSPORT_DIR = path.join(__dirname, '../data/CQ100_v4/output/8bit/preprocessed');
```

### "No archetypes loaded!"
**Cause:** Missing JSON files or invalid format
**Fix:** Check that .json files exist in reveal-core/archetypes/

### Archetype not being matched
**Cause:** Centroid too far from cluster
**Fix:** Adjust centroid values or increase weights for important dimensions

---

## Performance

**Before:**
- Fixed 8 archetypes (hardcoded)
- 3D distance calculation
- ~100ms for 100 images

**After:**
- Dynamic archetype loading
- 4D distance calculation
- ~110ms for 100 images (+10% overhead for JSON parsing)
- Can support unlimited archetypes

---

## Backward Compatibility Notes

⚠️ **Breaking Changes:**
1. DNA structure: `contrast` renamed to `k`, added `l_std_dev`
2. Passport loading: Expects `dna` object (not `physical_dna`)
3. Directory path: `output/8bit/preprocessed` (not `input/psd`)

✅ **Compatible:**
- Generated preset format unchanged
- Existing presets still work
- Adobe plugin build compatible

---

## Future Enhancements

Possible next steps:
- [ ] Real-time archetype editor UI
- [ ] Archetype inheritance (base + overrides)
- [ ] Multiple archetype matches (blend parameters)
- [ ] Machine learning for auto-tuning centroids
- [ ] User-defined custom archetypes in Adobe plugin
- [ ] Archetype confidence thresholds

---

## Questions?

See:
- `README.md` - Complete usage guide
- `schema.json` - JSON structure definition
- `../../../ARCHETYPE-REFACTORING-SUMMARY.md` - Implementation notes
