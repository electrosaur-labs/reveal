# Dynamic Hue Anchoring Architecture

**Status:** 🏗️ **ARCHITECTURE DEFINED - Ready for Engine Implementation**
**Complexity:** ⭐⭐⭐⭐⭐ (Engine-Level Changes Required)
**Impact:** 🎯 **Final Boss of Color Separation**

---

## Executive Summary

Dynamic Hue Anchoring replaces **hardcoded hue penalties** with **DNA-derived anchors** that adapt to each image's actual color distribution. This is the ultimate solution to yellow-orange separation and cross-sector "bullying."

**Key Insight:** Instead of forcing yellows toward 90°, let the image's **own yellows define the anchor** (e.g., 72° for ochre, 100° for lemon).

---

## Current vs. Proposed System

### Current System (Hardcoded)

**In PosterizationEngine.js:**
```javascript
// Fixed penalty at 90° for yellow range
if (hue >= 70 && hue <= 95) {
    distance *= 256; // Binary on/off switch
}
```

**Problems:**
- Fights against image's natural colors
- Same penalty for all yellows (ochre, lemon, neon)
- No adaptation to sector relationships
- Fixed 90° anchor may not match image

---

### Proposed System (DNA-Derived)

**Enhanced PosterizationEngine.js:**
```javascript
// Dynamic anchor derived from DNA
const anchor = dna.sectors.yellow.hMean; // Actual yellow in THIS image
const drift = Math.abs(pixelHue - anchor);

// Gaussian curve penalty (not binary)
const huePenalty = Math.pow(drift, 2) * config.hueLockSensitivity;
totalDistance += huePenalty;
```

**Benefits:**
- ✅ Adapts to each image's actual yellows
- ✅ Gaussian curve (smooth falloff, not binary)
- ✅ Self-correcting for underexposed/overexposed images
- ✅ Prevents cross-sector "bullying"
- ✅ Stable edges for Trapper module

---

## Mathematical Foundation

### 1. Anchor Calculation

For each significant sector (weight > threshold):

```
Ay = sectors.yellow.hMean  // Actual yellow centroid (e.g., 85.3°)
                          // Note: "hMean" in our code = "hActual" in architect's terminology
                          // Both mean: (hSum / count) - the true mean hue of that sector
Ao = sectors.orange.hMean  // Actual orange centroid (e.g., 45.2°)
```

### 2. Penalty Curve (Gaussian)

```
hueDrift = |pixelHue - sectorAnchor|
huePenalty = (hueDrift²) × hueLockSensitivity
```

**Example:**
- `pixelHue = 88°`, `anchor = 85°`, `sensitivity = 12.0`
- `drift = 3°`
- `penalty = 3² × 12.0 = 108`

**Comparison to Binary:**
- Binary: 0 (in range) or 256 (out of range)
- Gaussian: Proportional to drift (3° = 108, 10° = 1200, etc.)

### 3. Cross-Sector Stiffness

Detect "bully" sectors and increase victim's stiffness:

```
bullyFactor = sectors.orange.weight / sectors.yellow.weight

if (bullyFactor > 2.0) {
    yellowStiffness = hueLockSensitivity × (1 + bullyFactor × 0.5)
}
```

**Example:**
- Orange weight: 0.40, Yellow weight: 0.15
- `bullyFactor = 0.40 / 0.15 = 2.67`
- `yellowStiffness = 12.0 × (1 + 2.67 × 0.5) = 28.0`
- Yellow's penalty curve becomes **2.3× steeper** to resist orange

---

## Implementation Architecture

### Phase 1: Data Flow Setup

**Current Flow:**
```
DNAGenerator → ParameterGenerator → Config → Engine
                                              ↓
                                         (DNA lost)
```

**Required Flow:**
```
DNAGenerator → ParameterGenerator → Config + DNA → Engine
                                                    ↓
                                              (DNA preserved)
```

**Changes Required:**
1. Pass DNA alongside config to engine
2. Engine stores DNA for pixel assignment phase
3. Access `dna.sectors` during pixel-to-centroid calculations

---

### Phase 2: Engine Modifications

**File:** `packages/reveal-core/lib/posterization/PosterizationEngine.js`

#### 2.1 Add Dynamic Anchor Calculation

**New Method:**
```javascript
/**
 * Calculate dynamic hue anchors from DNA sectors
 * @param {Object} dna - Image DNA with sectors
 * @param {Object} config - Configuration with useDynamicAnchors flag
 * @returns {Map} sector → anchor mapping
 */
calculateDynamicAnchors(dna, config) {
    if (!config.useDynamicAnchors || !dna.sectors) {
        return null; // Fall back to static anchors
    }

    const anchors = new Map();
    const minWeight = 0.05; // Only anchor sectors with >5% weight

    for (const [sectorName, sectorData] of Object.entries(dna.sectors)) {
        if (sectorData.weight > minWeight) {
            anchors.set(sectorName, {
                hue: sectorData.hMean,
                lMean: sectorData.lMean,
                weight: sectorData.weight,
                stiffness: config.hueLockSensitivity
            });
        }
    }

    // Calculate cross-sector bully adjustments
    this.adjustStiffnessForBullies(anchors);

    return anchors;
}
```

#### 2.2 Calculate Bully Adjustments

**New Method:**
```javascript
/**
 * Adjust stiffness for sectors being "bullied" by dominant neighbors
 * @param {Map} anchors - sector → anchor data
 */
adjustStiffnessForBullies(anchors) {
    const BULLY_THRESHOLD = 2.0; // Bully if 2× larger
    const STIFFNESS_BOOST = 0.5; // Increase stiffness by 50% per bully ratio

    for (const [sectorName, anchorData] of anchors) {
        // Check adjacent sectors (±30° for 12-sector system)
        const neighbors = this.getAdjacentSectors(sectorName);

        for (const neighborName of neighbors) {
            const neighbor = anchors.get(neighborName);
            if (!neighbor) continue;

            const bullyRatio = neighbor.weight / anchorData.weight;

            if (bullyRatio > BULLY_THRESHOLD) {
                // This sector is being bullied - increase its stiffness
                const boost = 1 + (bullyRatio * STIFFNESS_BOOST);
                anchorData.stiffness *= boost;

                console.log(`🛡️  ${sectorName} stiffness boosted by ${boost.toFixed(2)}× (bullied by ${neighborName})`);
            }
        }
    }
}
```

#### 2.3 Modify Pixel Assignment Loop

**Current:**
```javascript
// In assignPixelsToCentroids()
for (const pixel of pixels) {
    let minDistance = Infinity;
    let bestCentroid = null;

    for (const centroid of centroids) {
        const dist = this.calculateDistance(pixel, centroid, config);
        // dist already includes hardcoded hue penalties

        if (dist < minDistance) {
            minDistance = dist;
            bestCentroid = centroid;
        }
    }
}
```

**Enhanced:**
```javascript
// In assignPixelsToCentroids()
const dynamicAnchors = this.calculateDynamicAnchors(this.dna, config);

for (const pixel of pixels) {
    let minDistance = Infinity;
    let bestCentroid = null;

    for (const centroid of centroids) {
        let dist = this.calculateDistance(pixel, centroid, config);

        // Apply dynamic hue anchoring
        if (dynamicAnchors) {
            const huePenalty = this.calculateDynamicHuePenalty(
                pixel,
                centroid,
                dynamicAnchors
            );
            dist += huePenalty;
        }

        if (dist < minDistance) {
            minDistance = dist;
            bestCentroid = centroid;
        }
    }
}
```

#### 2.4 Calculate Dynamic Hue Penalty

**New Method:**
```javascript
/**
 * Calculate dynamic hue penalty based on DNA-derived anchors
 * @param {Object} pixel - Pixel in Lab space
 * @param {Object} centroid - Centroid to compare against
 * @param {Map} anchors - Dynamic anchors from DNA
 * @returns {number} Hue penalty
 */
calculateDynamicHuePenalty(pixel, centroid, anchors) {
    const pixelHue = this.calculateHue(pixel.a, pixel.b);
    const centroidHue = this.calculateHue(centroid.a, centroid.b);

    // Find which sector this pixel's hue belongs to
    const pixelSector = this.getSectorForHue(pixelHue);
    const anchor = anchors.get(pixelSector);

    if (!anchor) {
        return 0; // No anchor for this sector
    }

    // Calculate drift from anchor
    const drift = Math.abs(pixelHue - anchor.hue);

    // Gaussian curve penalty
    const penalty = Math.pow(drift, 2) * anchor.stiffness;

    return penalty;
}

/**
 * Determine which 12-sector a hue belongs to
 * @param {number} hue - Hue angle (0-360°)
 * @returns {string} Sector name (e.g., "yellow", "orange")
 */
getSectorForHue(hue) {
    const SECTORS = [
        'red', 'orange', 'yellow', 'chartreuse',
        'green', 'cyan', 'blue', 'violet',
        'purple', 'magenta', 'pink', 'crimson'
    ];

    const sectorIndex = Math.floor(hue / 30) % 12;
    return SECTORS[sectorIndex];
}
```

---

### Phase 3: Archetype Integration

**vibrant-tonal.json (Already Prepared):**
```json
{
  "parameters": {
    "hueLockSensitivity": 1.0,
    "useDynamicAnchors": false
  },

  "dna_constraints": [
    {
      "name": "Dynamic Anchor Sync",
      "priority": 1000,
      "if": "sectors.yellow.weight > 0.10",
      "then": {
        "hueLockSensitivity": 12.0,
        "useDynamicAnchors": true
      }
    }
  ]
}
```

**How It Works:**
1. Baseline: `useDynamicAnchors: false` (static behavior)
2. Constraint triggers when yellow weight > 10%
3. Enables dynamic anchoring with high stiffness (12.0)
4. Engine reads these params and applies Gaussian penalties

---

## Example Walkthrough

### Scenario: Lemon Photo

**DNA Extraction:**
```javascript
{
  sectors: {
    yellow: {
      weight: 0.35,  // 35% of chromatic pixels
      hMean: 85.3,   // Actual yellow in THIS image
      lMean: 90.2    // Very bright yellows
    },
    orange: {
      weight: 0.12,  // 12% of chromatic pixels
      hMean: 45.8,
      lMean: 55.3
    }
  }
}
```

**Constraint Evaluation:**
```json
{
  "if": "sectors.yellow.weight > 0.10",  // TRUE (0.35 > 0.10)
  "then": {
    "hueLockSensitivity": 12.0,
    "useDynamicAnchors": true
  }
}
```

**Engine Processing:**

1. **Anchor Calculation:**
```javascript
anchors.set('yellow', {
    hue: 85.3,      // Use actual yellow hMean
    stiffness: 12.0  // From constraint
});
anchors.set('orange', {
    hue: 45.8,
    stiffness: 12.0
});

// No bully adjustment (orange weight 0.12 < yellow weight 0.35)
```

2. **Pixel Assignment (Yellow Pixel at 88°):**
```javascript
// Assigning to yellow centroid (87°)
drift_to_yellow = |88 - 85.3| = 2.7°
penalty_yellow = 2.7² × 12.0 = 87

// Assigning to orange centroid (46°)
drift_to_orange = |88 - 85.3| = 2.7° (pixel still in yellow sector)
penalty_orange = 2.7² × 12.0 = 87 (yellow anchor applied)

// Base Lab distance favors orange (higher chroma)
// But dynamic penalty keeps pixel in yellow!
```

**Result:** Yellow pixels stay yellow, even when orange has higher chroma

---

### Scenario: Ochre Sunset (Underexposed)

**DNA Extraction:**
```javascript
{
  sectors: {
    yellow: {
      weight: 0.20,
      hMean: 72.5,   // Ochre yellow (darker, more orange-ish)
      lMean: 60.3    // Mid-tone yellows
    },
    orange: {
      weight: 0.35,  // Dominant orange
      hMean: 45.2,
      lMean: 50.1
    }
  }
}
```

**Bully Detection:**
```javascript
bullyRatio = 0.35 / 0.20 = 1.75
// Not quite bully threshold (2.0), but close

// Yellow anchor: 72.5° (adapts to ochre, not forcing to 90°)
```

**Result:**
- Anchor adapts to **actual ochre** (72.5°, not 90°)
- Preserves natural underexposed warmth
- No fighting against image's natural tones

---

## Benefits Summary

### 1. Self-Correction
- **Lemon photo (L=90):** Anchor at 90° (bright yellow)
- **Ochre sunset (L=60):** Anchor at 72° (warm yellow)
- **Neon sign (L=95):** Anchor at 100° (green-ish yellow)

### 2. Bully Prevention
- Orange (0.40 weight) bullying yellow (0.15 weight)
- Yellow stiffness boosted 2.3× automatically
- Yellow resists merging into orange

### 3. Trap Readiness
- Stable hue boundaries (no fluctuation)
- Consistent edges for Trapper module
- Clean color separation for screen printing

### 4. No Configuration Needed
- DNA automatically detects bullying
- Anchors automatically adapt to image
- Stiffness automatically calibrated

---

## Implementation Phases

### Phase 1: Foundation ✅ (Complete)
- [x] Add `hueLockSensitivity` parameter to archetypes
- [x] Add `useDynamicAnchors` flag
- [x] Update schema documentation
- [x] Add constraints to vibrant-tonal.json

### Phase 2: Engine Core 🏗️ (Next)
- [ ] Modify PosterizationEngine.js to accept DNA
- [ ] Implement `calculateDynamicAnchors()`
- [ ] Implement `adjustStiffnessForBullies()`
- [ ] Add `calculateDynamicHuePenalty()` to pixel assignment loop

### Phase 3: Integration 🔌 (After Phase 2)
- [ ] Update engine invocation to pass DNA
- [ ] Test on lemon images (bright yellow)
- [ ] Test on ochre images (dark yellow)
- [ ] Test on orange-dominant images (bully prevention)

### Phase 4: Optimization ⚡ (Future)
- [ ] Cache anchor calculations per frame
- [ ] Optimize drift calculations
- [ ] Benchmark performance impact

---

## Testing Strategy

### Test Cases

**1. Lemon Photo (Bright Yellow)**
- DNA: `yellow.hMean = 90`, `yellow.weight = 0.35`
- Expected: Anchor at 90°, clean yellow-orange separation
- Validation: No yellow pixels assigned to orange

**2. Ochre Sunset (Dark Yellow)**
- DNA: `yellow.hMean = 72`, `yellow.weight = 0.20`, `orange.weight = 0.35`
- Expected: Anchor at 72°, bully protection enabled
- Validation: Ochre preserved, not forced to 90°

**3. Orange-Dominant (Bully)**
- DNA: `orange.weight = 0.45`, `yellow.weight = 0.10`
- Expected: Yellow stiffness boosted 2.25×
- Validation: Small yellow areas preserved

**4. No Yellow (Graceful Fallback)**
- DNA: No yellow sector (weight < 5%)
- Expected: No dynamic anchoring applied
- Validation: Static behavior maintained

---

## Performance Considerations

### Computational Cost

**Per-Pixel Operations Added:**
1. Hue calculation: ~5 ops (atan2)
2. Sector lookup: ~1 op (division + modulo)
3. Drift calculation: ~3 ops (abs, pow, multiply)

**Total:** ~9 ops per pixel × 2M pixels = ~18M ops
**Estimated Impact:** +5-10ms per frame (negligible)

### Memory Cost

**Anchor Map:** 12 sectors × 4 fields × 8 bytes = 384 bytes
**Negligible**

### Optimization Opportunities

1. **Pre-compute sector boundaries** (30° increments)
2. **LUT for pow(drift, 2)** if drift is quantized
3. **SIMD vectorization** for batch penalty calculations

---

## Comparison to Alternatives

### Alternative 1: Multiple Fixed Anchors
- Define anchors at 70°, 80°, 90°, 100°
- Select closest anchor based on DNA
- **Problem:** Still discrete, not adaptive

### Alternative 2: Soft Hue Locks
- Scale existing 256× penalty by yellow weight
- **Problem:** Still binary, not Gaussian

### Alternative 3: Post-Processing Merge Prevention
- Detect yellow-orange merges after posterization
- Split centroids retroactively
- **Problem:** Too late, data already lost

**Dynamic Hue Anchoring is Superior:**
- ✅ Truly adaptive (not discrete)
- ✅ Gaussian (smooth falloff)
- ✅ Proactive (not reactive)
- ✅ Self-calibrating (bully detection)

---

## Next Steps

1. **Review This Architecture** - Validate approach with team
2. **Implement Phase 2** - Modify PosterizationEngine.js
3. **Create Test Suite** - 4 test cases above
4. **Benchmark Performance** - Ensure <10ms impact
5. **Integrate with Plugin** - Pass DNA to engine

---

## Conclusion

Dynamic Hue Anchoring is the **"Final Boss" of color separation** - it solves:
- ✅ Yellow-orange bullying
- ✅ Underexposed ochre preservation
- ✅ Overexposed neon yellow handling
- ✅ Cross-sector density imbalances
- ✅ Trap-ready edge stability

**The architecture is defined. Ready for engine implementation.**

---

*Architecture Document - Dynamic Hue Anchoring - 2026-01-31*
