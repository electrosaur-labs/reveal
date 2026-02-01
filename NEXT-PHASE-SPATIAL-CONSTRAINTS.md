# Next Phase: Spatial Entropy-Based Constraints

## Overview

The constraint system is now operational. The next phase is to leverage the **spatial DNA metrics** to automatically distinguish between flat graphics (Minkler posters) and photographic textures.

---

## Key Insight: Geography of Color

As you noted, we need to **stop treating the image as a single "flavor"** and start treating it as a **map of competing interests**.

The 12-bucket hue DNA + spatial entropy provides the engine with enough context to know:
- **Minkler poster** → entropy < 20, flat sectors → disable L-weighting, keep edges sharp
- **Photograph** → entropy > 40, textured sectors → enable dithering, allow tonal gradients

---

## Spatial Metrics Available

The DNAGenerator now calculates (when `spatialMetrics: true`):

```javascript
{
  spatial: {
    entropy: 42.3,        // Shannon entropy (0-100)
    edgeDensity: 0.14,    // Sobel edges / total pixels
    complexityScore: 42.3 // Composite metric
  }
}
```

**Thresholds:**
- `entropy < 20` → Flat graphic (Minkler, WPA poster)
- `entropy 20-40` → Moderate detail (illustration, lithograph)
- `entropy > 40` → Photographic (texture, noise, grain)

---

## Example: Minkler Flatten Constraint

### Problem

Doug Minkler posters have:
- **Flat color planes** (low entropy)
- **Sharp edges** (low edge density)
- **Bold hues** (high sector chroma, low sector variance)

Current system applies L-weighting designed for photos, which causes:
- Unnecessary tonal smoothing
- Loss of sharp edges
- Palette over-reduction

### Solution: Spatial Constraint

Add to `yellow-dominant.json`, `pure-graphic.json`, or `neon-graphic.json`:

```json
{
  "dna_constraints": [
    {
      "name": "Minkler Flatten (Low Spatial Complexity)",
      "priority": 50,
      "if": "spatial.entropy < 20 && spatial.edgeDensity < 0.05",
      "then": {
        "lWeight": 0.5,
        "ditherType": "none",
        "paletteReduction": 12.0,
        "blackBias": 1.5,
        "hueLockAngle": 45
      }
    }
  ]
}
```

**What This Does:**
- Forces low L-weight (preserve flat color planes)
- Disables dithering (keep edges crisp)
- Increases palette reduction (merge similar tones)
- Reduces black bias (don't over-deepen shadows)
- Widens hue lock (allow warm tones to stay distinct)

---

## Example: Photographic Texture Enhancement

Add to `standard-balanced.json` or `soft-ethereal.json`:

```json
{
  "dna_constraints": [
    {
      "name": "Photographic Texture Enhancement",
      "priority": 60,
      "if": "spatial.entropy > 40 && l_std_dev > 20",
      "then": {
        "lWeight": 1.4,
        "ditherType": "BlueNoise",
        "paletteReduction": 6.0,
        "blackBias": 5.0,
        "vibrancyMode": "exponential"
      }
    }
  ]
}
```

**What This Does:**
- Increases L-weight (capture tonal gradients)
- Enables Blue Noise dither (smooth gradients)
- Reduces palette reduction (preserve subtle variations)
- Increases black bias (protect shadow detail)
- Uses exponential vibrancy (rescue low-chroma colors)

---

## Per-Sector Responsiveness

As you noted, we can make archetypes even more responsive by using **sector-specific DNA**:

### Example: Yellow Sector Flatness Detection

```json
{
  "dna_constraints": [
    {
      "name": "Flat Yellow Highlight Protection",
      "priority": 100,
      "if": "sectors.yellow.lMean > 80 && sectors.yellow.lStdDev < 10",
      "then": {
        "lWeight": 5.0,
        "centroidStrategy": "SALIENCY",
        "paletteReduction": 0
      }
    }
  ]
}
```

**What This Detects:**
- Yellow sector at high lightness (L > 80) → Neon yellow highlight
- Low variance within yellow sector (σ < 10) → Flat, not gradient
- **Action:** Apply extreme L-weighting to keep yellow separate from orange

This is **more precise** than global `yellowDominance > 20` because it distinguishes:
- **Lemon poster** (yellow at L=90, flat) → lWeight=5.0
- **Golden hour photo** (yellow at L=60, gradient) → lWeight=1.5

---

## Proposed Constraints for Next Phase

### 1. Minkler Flatten (Flat Graphics)

**Archetypes:** `pure-graphic.json`, `neon-graphic.json`, `yellow-dominant.json`

```json
{
  "name": "Minkler Flatten",
  "priority": 50,
  "if": "spatial.entropy < 20 && sectors.yellow.lStdDev < 10",
  "then": {
    "lWeight": 0.5,
    "ditherType": "none",
    "paletteReduction": 12.0
  }
}
```

### 2. Photo Texture Enhancement

**Archetypes:** `standard-balanced.json`, `soft-ethereal.json`, `silver-gelatin.json`

```json
{
  "name": "Photo Texture Enhancement",
  "priority": 60,
  "if": "spatial.entropy > 40 && l_std_dev > 20",
  "then": {
    "lWeight": 1.4,
    "ditherType": "BlueNoise",
    "blackBias": 5.0
  }
}
```

### 3. Neon Spike on Flat Background

**Archetypes:** `vibrant-tonal.json`, `neon-graphic.json`

```json
{
  "name": "Neon Spike on Flat Background",
  "priority": 110,
  "if": "spatial.entropy < 30 && maxC > 120",
  "then": {
    "centroidStrategy": "SALIENCY",
    "highlightBoost": 3.0,
    "cWeight": 6.5
  }
}
```

### 4. Archive Restoration (16-bit Muted Photo)

**Archetypes:** `silver-gelatin.json`, `muted-vintage.json`

```json
{
  "name": "Archive Restoration",
  "priority": 80,
  "if": "spatial.entropy > 35 && c < 20 && bitDepth === 16",
  "then": {
    "vibrancyMode": "exponential",
    "vibrancyBoost": 2.2,
    "paletteReduction": 6.5,
    "distanceMetric": "cie2000"
  }
}
```

---

## Expression-Based Logic (Future Enhancement)

You mentioned making archetypes more responsive with expression-based logic:

```json
{
  "logic": {
    "lWeight": "5.0 if sectors.yellow.lMean > 80 else 0.5",
    "cWeight": "base_c - (global.entropy * 0.02)",
    "blackBias": "4.0 + (global.complexity * 0.02)"
  }
}
```

This is possible with the current ConstraintEvaluator! We can extend it to support:

### Option 1: Ternary Expressions (Simple)

```json
{
  "dna_scales": [
    {
      "param": "lWeight",
      "by": "sectors.yellow.lMean > 80 ? sectors.yellow.lMean : 0.5",
      "clamp": false
    }
  ]
}
```

### Option 2: Formula-Based Scales (More Flexible)

```json
{
  "dna_scales": [
    {
      "param": "cWeight",
      "formula": "3.0 - (spatial.entropy * 0.02)",
      "clamp": true,
      "outputRange": [0.5, 6.5]
    }
  ]
}
```

### Option 3: Multiple Scales (Current Approach)

```json
{
  "dna_scales": [
    {
      "param": "blackBias",
      "by": "spatial.entropy",
      "inputRange": [0, 100],
      "outputRange": [1.5, 8.0]
    }
  ]
}
```

**Recommendation:** Stick with Option 3 (multiple scales) for now, as it's:
- Already implemented
- Easy to understand
- Composable (multiple scales can affect same parameter)
- Testable

---

## Implementation Steps for Next Phase

### Step 1: Enable Spatial Metrics in Plugin

**File:** `packages/reveal-adobe/src/ColorSeparationCoordinator.js`

```javascript
// Generate DNA with spatial metrics
const dna = DNAGenerator.generate(labPixels, width, height, 40, {
    richDNA: true,
    spatialMetrics: true  // Enable spatial complexity analysis
});
```

### Step 2: Add Spatial Constraints to Archetypes

Add the 4 constraints above to appropriate archetypes.

### Step 3: Test on CQ100 Dataset

```bash
cd packages/reveal-batch
npm run process:cq100 -- --dna-version=2.0 --spatial-metrics
```

Expected improvements:
- Minkler posters: Cleaner edges, no dithering
- Photos: Better gradient preservation
- Neon graphics: Vibrant spikes protected

### Step 4: Validate Results

Compare output images:
- CQ100 v1.0 (legacy morphing) vs. v2.0 (constraints)
- Should see 97%+ same or better
- 3%+ improvement on Minkler/flat graphics

---

## Example: Complete "Pure Graphic" Archetype

```json
{
  "id": "pure_graphic",
  "name": "Pure Graphic / Vector Art",
  "description": "Ultra-flat images with solid color planes and sharp edges",

  "centroid": {
    "l": 70,
    "c": 40,
    "k": 60,
    "l_std_dev": 8
  },

  "weights": {
    "l": 0.5,
    "c": 2.0,
    "k": 1.0,
    "l_std_dev": 5.0,
    "spatial.entropy": 3.0
  },

  "parameters": {
    "centroidStrategy": "VOLUMETRIC",
    "lWeight": 0.8,
    "cWeight": 1.8,
    "blackBias": 1.5,
    "ditherType": "none",
    "paletteReduction": 12.0
  },

  "dna_scales": [
    {
      "name": "Scale L-weight by spatial complexity",
      "param": "lWeight",
      "by": "spatial.entropy",
      "inputRange": [0, 30],
      "outputRange": [0.5, 1.5],
      "clamp": true
    }
  ],

  "dna_constraints": [
    {
      "name": "Ultra-Flat Graphics (Minkler Mode)",
      "priority": 100,
      "if": "spatial.entropy < 15 && l_std_dev < 8",
      "then": {
        "lWeight": 0.5,
        "ditherType": "none",
        "paletteReduction": 12.0,
        "blackBias": 1.0,
        "hueLockAngle": 45
      }
    },
    {
      "name": "Moderate Detail Graphics (Illustration)",
      "priority": 90,
      "if": "spatial.entropy >= 15 && spatial.entropy < 30",
      "then": {
        "lWeight": 1.0,
        "ditherType": "Atkinson",
        "paletteReduction": 8.0
      }
    },
    {
      "name": "High Chroma Spike Protection",
      "priority": 110,
      "if": "maxC > 100",
      "then": {
        "centroidStrategy": "SALIENCY",
        "cWeight": 3.0
      }
    }
  ]
}
```

---

## Benefits of Spatial Constraints

✅ **Automatic Minkler Detection** - No manual "flat graphic" toggle needed
✅ **Photo vs. Graphic** - System knows which to apply based on entropy
✅ **Per-Sector Precision** - "Flat yellow spike" vs. "gradient yellow"
✅ **Composable Logic** - Multiple constraints can fire, each refining parameters
✅ **Self-Documenting** - Constraint names explain WHY parameters changed

---

## Validation Criteria

### Success Metrics

- [ ] Minkler posters have `spatial.entropy < 20`
- [ ] Photos have `spatial.entropy > 40`
- [ ] Flat yellow spikes detected via `sectors.yellow.lStdDev < 10`
- [ ] CQ100: 97%+ same or better results
- [ ] CQ100: 3%+ improvement on flat graphics

### Test Images

1. **Doug Minkler poster** → entropy < 20 → lWeight = 0.5
2. **Lemon photo** → sectors.yellow.lMean = 90, lStdDev = 5 → lWeight = 5.0
3. **Golden hour photo** → sectors.yellow.lMean = 60, lStdDev = 25 → lWeight = 1.5
4. **Chennai shrine photo** → entropy > 40 → ditherType = "BlueNoise"

---

## Conclusion

The constraint system is ready to leverage spatial DNA. The next step is to:
1. Enable `spatialMetrics: true` in the plugin
2. Add spatial constraints to archetypes
3. Validate on CQ100 dataset
4. Remove legacy morphing code once validated

This completes the transformation from **imperative morphing** to **declarative, self-contained archetypes**.

---

*Next Phase Plan - Ready for Implementation*
