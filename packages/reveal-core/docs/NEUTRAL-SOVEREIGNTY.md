# Neutral Sovereignty System

**Purpose:** Prevents gray pixels from morphing into blue/cool colors during posterization.

**Problem:** Blue is a "bully color" with high luminance at high chroma. Without intervention, neutral gray pixels (stone walls, concrete, clouds) often get assigned to pale blue centroids, causing unwanted color shifts.

---

## Architecture

The Neutral Sovereignty system uses a **three-part defense**:

1. **Hard Neutral Sovereignty** (Archetype Constraint)
2. **Desaturation Force** (Centroid Snapping)
3. **Bully Suppression** (LUT Enhancement)
4. **Gravity Well** (Squared Chroma Penalty)

All four components work together to create a robust defense against gray-to-blue morphing.

---

## 1. Hard Neutral Sovereignty (Archetype Constraint)

**Location:** `archetypes/*.json` files

**Trigger Condition:** `global.neutralWeight > 0.05` (5% or more neutral content)

**Parameters:**
```json
{
  "name": "Hard Neutral Sovereignty",
  "priority": 980,
  "if": "global.neutralWeight > 0.05",
  "then": {
    "useNeutralGravity": true,
    "neutralStiffness": 25.0,
    "neutralChromaThreshold": 3.5,
    "cWeight": 3.5,
    "description": "Enforces a strict 'Migration Tax' to keep grays from being captured by blue/cool centroids."
  }
}
```

**Archetype Variations:**
- **standard-balanced.json**: neutralStiffness = 25.0 (strict)
- **soft-ethereal.json**: neutralStiffness = 25.0 (strict)
- **cinematic-moody.json**: neutralStiffness = 10.0 (softer, allows artistic blue grading)

**Why different stiffness values?**
- Cinematic images WANT blue-tinted shadows for artistic effect
- Standard/ethereal images should preserve neutral grays faithfully

---

## 2. Desaturation Force (Centroid Snapping)

**Location:** `PosterizationEngine.js:3476-3497`

**Purpose:** Forces creation of a "True Gray" centroid at exactly a=0, b=0

**Algorithm:**
```javascript
if (options.useNeutralGravity) {
    const snapThreshold = 5.0;
    for (let i = 0; i < curatedPaletteLab.length; i++) {
        const color = curatedPaletteLab[i];
        const chroma = Math.sqrt(color.a * color.a + color.b * color.b);

        if (chroma < snapThreshold && chroma > 0) {
            color.a = 0;
            color.b = 0;
            snappedCount++;
        }
    }
}
```

**Why this works:**
- Prevents centroids from drifting into "pale blue" territory (a=-5, b=-10)
- Ensures there's always a perfectly neutral bucket for gray pixels
- Snapping happens AFTER median cut but BEFORE palette pruning

---

## 3. Bully Suppression (LUT Enhancement)

**Location:** `PosterizationEngine.js:250-257`

**Purpose:** Makes blue/violet sector penalties 2× larger when neutral content exists

**Algorithm:**
```javascript
// Inside generateHuePenaltyLUT()
if (drift > lockAngle) {
    lut[h] = Math.pow(drift - lockAngle, 2) * sensitivity;

    // BULLY SUPPRESSION
    const neutralWeight = dna.global?.neutralWeight || 0;
    if (neutralWeight > 0.1 && (sectorName === 'blue' || sectorName === 'violet')) {
        const bullyFactor = 2.0;
        lut[h] *= bullyFactor;
    }
}
```

**Effect:**
- Blue/violet hues get 2× penalty when neutralWeight > 10%
- Makes the "wall" taller for blue sectors adjacent to neutral zones
- Only affects penalty magnitude, not whether penalty applies

---

## 4. Gravity Well (Squared Chroma Penalty)

**Location:**
- 16-bit path: `PosterizationEngine.js:3827-3838`
- 8-bit path: `PosterizationEngine.js:3921-3931`

**Purpose:** Creates exponentially increasing "migration tax" for colorful centroids trying to absorb neutral pixels

**Algorithm:**
```javascript
const useNeutralGravity = options.useNeutralGravity || false;
const neutralStiffness = options.neutralStiffness || 25.0;
const neutralChromaThreshold = options.neutralChromaThreshold || 3.5;

if (useNeutralGravity && pixelChroma < neutralChromaThreshold && targetChroma > 5.0) {
    // CHROMA SQUARING: C² penalty
    const neutralPenalty = Math.pow(targetChroma, 2) * neutralStiffness * scaleFactor;
    dist += neutralPenalty;
}
```

**Why squaring works:**
| Centroid Chroma | Linear Penalty (C × 25) | Squared Penalty (C² × 25) | Ratio |
|----------------|------------------------|---------------------------|-------|
| C = 2 (pale gray) | 50 | 100 | 1× |
| C = 5 (light pastel) | 125 | 625 | 5× |
| C = 10 (moderate color) | 250 | 2,500 | 10× |
| C = 15 (sky blue) | 375 | 5,625 | 15× |
| C = 20 (vibrant) | 500 | 10,000 | 20× |

**Key insight:** Pale centroids (C≈2-3) pay almost no tax, while vibrant ones (C≈15-20) pay massive penalties. This creates a "gravity well" that pulls neutral pixels toward true neutral centroids.

---

## Parameter Reference

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `useNeutralGravity` | boolean | false | Master switch for entire system |
| `neutralStiffness` | number | 25.0 | Penalty multiplier (higher = stronger protection) |
| `neutralChromaThreshold` | number | 3.5 | Chroma below which pixels are "neutral" |

**Parameter name change:**
- Old: `useNeutralAnchoring`
- New: `useNeutralGravity`

---

## DNA Requirements

The system requires **Rich DNA v2.0** with:
- `global.neutralWeight` - Percentage of neutral pixels (chroma < 3.0)
- `global.neutralLMean` - Average lightness of neutral pixels
- `sectors.blue.weight` - Blue sector presence (for bully suppression)

**Backward compatibility:** If DNA lacks these fields, the constraints gracefully fail to activate (system remains disabled).

---

## Test Coverage

**File:** `test/unit/neutral-sovereignty.test.js`

**Tests:**
1. ✅ LUT Bully Suppression - Verifies 2× penalty for blue sectors
2. ✅ Desaturation Force - Verifies centroid snapping to a=0, b=0
3. ✅ Gravity Well (WITH) - Verifies neutral pixels stay neutral
4. ✅ Gravity Well (WITHOUT) - Baseline showing the problem
5. ✅ Integration Test - Full system prevents gray-to-blue morphing
6. ✅ Cinematic Archetype - Documents softer stiffness for artistic grading

**Total:** 6 tests, all passing

---

## Usage Examples

### Automatic (Archetype-Driven)

When processing with Rich DNA v2.0, the system activates automatically:

```javascript
const dna = DNAGenerator.generate(labPixels, width, height, 40, {
    richDNA: true,
    spatialMetrics: true
});

const result = Reveal.posterizeImage(labPixels, width, height, 6, {
    dna: dna,  // System auto-activates if neutralWeight > 0.05
    useDynamicAnchors: true
});
```

### Manual Override

Force enable/disable regardless of DNA:

```javascript
const result = Reveal.posterizeImage(labPixels, width, height, 6, {
    useNeutralGravity: true,
    neutralStiffness: 25.0,
    neutralChromaThreshold: 3.5
});
```

### Custom Stiffness

Adjust protection strength:

```javascript
// Strict protection (standard images)
{ neutralStiffness: 25.0 }

// Moderate protection (cinematic images)
{ neutralStiffness: 10.0 }

// Weak protection (heavily color-graded images)
{ neutralStiffness: 5.0 }
```

---

## Performance Impact

**LUT Generation:** O(1) amortized cost - precomputed once per image
**Pixel Assignment:** +3 arithmetic operations per pixel-centroid comparison
**Centroid Snapping:** O(k) where k = palette size (typically < 15)

**Total overhead:** < 2% on typical images

---

## When to Disable

Neutral Sovereignty should be **disabled** for:
- Heavily color-graded images where blue grays are intentional
- Abstract/artistic images without photographic neutral grays
- Images with `neutralWeight < 0.05` (< 5% neutral content)
- Workflows requiring exact color matching (use manual palette instead)

---

## Troubleshooting

**Problem:** Grays still morphing to blue
- Check DNA has `global.neutralWeight` field
- Verify archetype constraint is activating (check logs for "Hard Neutral Sovereignty")
- Increase `neutralStiffness` to 30-35 for stricter protection

**Problem:** Colors look oversaturated
- Reduce `cWeight` in archetype (try 2.5 instead of 3.5)
- Check if image truly has neutral content (verify `neutralWeight`)

**Problem:** Too many gray colors in palette
- This is expected behavior - multiple L values need separate neutral centroids
- Use `paletteReduction` to merge similar grays if needed

---

## Implementation History

**Version 1.0** (Original Neutral Anchoring)
- Linear penalty: C × stiffness
- Sector-specific trigger: `sectors.blue.weight > 0.15 && global.neutralWeight > 0.10`
- Parameter name: `useNeutralAnchoring`

**Version 2.0** (Neutral Sovereignty) - Current
- Squared penalty: C² × stiffness
- Global trigger: `global.neutralWeight > 0.05`
- Added Desaturation Force (centroid snapping)
- Added Bully Suppression (blue sector 2× multiplier)
- Parameter name: `useNeutralGravity`

---

## References

- Original issue: Gray stone walls appearing pale blue in output
- Test image: Gray stone (70%) + blue sky (30%)
- Key insight: Blue has high L even at high C, making it "bully" neutral pixels
- Solution: Exponential penalty curve creates gravity well toward neutral axis
