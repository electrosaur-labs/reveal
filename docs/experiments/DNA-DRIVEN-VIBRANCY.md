# DNA-Driven Vibrancy Exponent Experiment

**Date**: 2026-01-20
**Status**: Shelved (git stash)
**Stash Name**: `DNA-driven vibrancy exponent experiment`

## Problem Statement

Some posterized photos look very muted. This is the "Regression to the Mean" problem.

**Example**: If you have a photo with Neon Red (C=90) and Brick Red (C=40), a standard averaging algorithm (Exponent 1.0) will give you Standard Red (C=65). The "Neon" is lost.

## Solution Concept

Use the Image DNA to drive the Saliency Exponent dynamically:

- **Low Chroma Image** (maxC~20): Use Exponent ~1.5 (Safe averaging)
- **High Chroma Image** (maxC~100): Use Exponent ~4.5 (Aggressively snap to the most vibrant pixels)

## Implementation

### 1. PosterizationEngine.js - SALIENCY Strategy

Updated to accept `weights.chromaExponent` parameter:

```javascript
const CentroidStrategies = {
    /**
     * THE "VIBRANCY AWARE" SALIENCY STRATEGY (DNA-DRIVEN)
     *
     * If chromaExponent is HIGH (e.g., 4.0), a pixel with Chroma 80
     * contributes 16x more to the average than a pixel with Chroma 40.
     * This forces the centroid to "snap" to the vibrant peaks.
     */
    SALIENCY: (bucket, weights) => {
        if (!bucket || bucket.length === 0) return { L: 50, a: 0, b: 0 };

        // 1. Get DNA-Driven Exponent (Default to 2.5 if missing)
        const chromaExponent = weights.chromaExponent || 2.5;
        const blackBias = weights.blackBias || 5.0;

        let sumL = 0, sumA = 0, sumB = 0;
        let totalWeight = 0;

        for (let i = 0; i < bucket.length; i++) {
            const p = bucket[i];

            // Calculate Chroma
            const chroma = Math.sqrt(p.a * p.a + p.b * p.b);

            // EXPONENTIAL WEIGHTING - The "Vibrancy Driver"
            let weight = Math.pow(chroma + 1, chromaExponent);

            // Black Protection (Keep shadows deep)
            if (p.L < 10) {
                weight *= blackBias;
            }

            sumL += p.L * weight;
            sumA += p.a * weight;
            sumB += p.b * weight;
            totalWeight += weight;
        }

        return {
            L: sumL / totalWeight,
            a: sumA / totalWeight,
            b: sumB / totalWeight
        };
    }
};
```

### 2. reveal-adobe/src/index.js - DNA Calculation

Added before posterization call (~line 2494):

```javascript
// DNA-DRIVEN VIBRANCY: Calculate chromaExponent from image DNA
// This prevents "regression to mean" - neon colors stay neon, muted colors stay muted
const dna = DNAGenerator.generate(pixelData.pixels, pixelData.width, pixelData.height, 40);

// Formula: If maxC = 20 (Dull), exponent -> 1.8 | If maxC = 100 (Neon), exponent -> 5.0
let dynamicChromaExponent = 1.0 + (dna.maxC / 25.0);
dynamicChromaExponent = Math.max(1.0, Math.min(5.0, dynamicChromaExponent));  // Clamp 1.0-5.0

logger.log(`🧬 DNA Analysis: maxC=${dna.maxC.toFixed(1)} → chromaExponent=${dynamicChromaExponent.toFixed(2)}`);

// Added to tuning.centroid object:
centroid: {
    lWeight: params.lWeight,
    cWeight: params.cWeight,
    blackBias: params.blackBias,
    chromaExponent: dynamicChromaExponent  // NEW: DNA-driven vibrancy exponent (1.0-5.0)
}
```

## Math Explanation

**Formula**: `dynamicExponent = 1.0 + (dna.maxC / 25.0)`

| Image Type | maxC | Exponent | Effect |
|------------|------|----------|--------|
| Dull/Muted | 20 | 1.8 | Safe arithmetic mean |
| Normal | 50 | 3.0 | Moderate vibrancy bias |
| Vibrant | 75 | 4.0 | Strong snap to peaks |
| Neon | 100+ | 5.0 (capped) | Maximum peak seeking |

**Weight Comparison** (at exponent 5.0):
- Pixel A (Neon, C=100): weight ≈ 10,000,000,000
- Pixel B (Dull, C=50): weight ≈ 300,000,000
- **Result**: Neon pixel has 33× more influence

## Files Modified

1. `packages/reveal-core/lib/engines/PosterizationEngine.js` - SALIENCY strategy
2. `packages/reveal-adobe/src/index.js` - DNA calculation and tuning injection

## How to Restore

```bash
cd /workspaces/electrosaur/reveal-project
git stash list  # Find the stash
git stash apply stash@{0}  # Or git stash pop
npm run build  # Rebuild reveal-adobe
```

## Why Shelved

Needs testing to verify:
1. Does it actually improve vibrant images?
2. Does it harm muted/neutral images?
3. Performance impact of DNA calculation (already done once, so minimal)
4. Edge cases with near-grayscale images

## Important Note: Photoshop Display Artifact

**The "muted" appearance may be a Photoshop display issue, not an algorithm problem.**

When viewing images in Photoshop at "Fit to View" zoom levels, the display can appear muted or desaturated. However, at 100% (actual pixels) zoom, the colors appear correct and vibrant.

This is a known Photoshop behavior related to how it downsamples images for display at reduced zoom levels. Before implementing this fix, verify:
1. View the posterized result at 100% zoom
2. Export/flatten and view in another application
3. Compare against the original at matching zoom levels

If colors look correct at 100%, the algorithm is working properly and this experiment may not be needed.

## Related Concepts

- **Regression to Mean**: Statistical tendency for extreme values to average out
- **Chroma-weighted centroid**: Giving more influence to saturated pixels
- **Image DNA**: Extracted statistics (L, C, K, maxC, minL, maxL) that characterize an image

## Test Images to Consider

- High chroma: Neon signs, vibrant flowers, saturated graphics
- Low chroma: Black & white photos, foggy landscapes, neutral portraits
- Mixed: JethroAsMonroe (skin tones + dark background)
