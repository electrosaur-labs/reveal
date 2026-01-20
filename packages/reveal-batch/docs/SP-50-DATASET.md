# SP-50: Screen Print Dataset Specification

## Overview

The **SP-50** (Screen Print 50) dataset is designed to properly calibrate the Dynamic Configurator's color budget decisions. Unlike CQ100 (which is homogeneous high-contrast photography), SP-50 represents the actual diversity of work processed by screen printers.

## Why Not CQ100?

CQ100 has served its purpose: it proved the engine handles "worst case scenarios" (full dynamic range, high-resolution photos). However:

| Metric | CQ100 Value | Problem |
|--------|-------------|---------|
| Avg Contrast (K) | 96.4 | Nearly uniform - all images hit max |
| Avg Chroma (C) | 19.4 | Moderate, but 40% trigger saliency rescue |
| Color Distribution | 100% at 12c | No variety - engine never learns efficiency |

**Result:** The engine assigns 12 colors to everything because CQ100 is too homogeneous.

## SP-50 Composition

A balanced dataset that forces the engine to use different code paths:

### 1. Vector/Flat (20%)
**Examples:** Logos, flat illustrations, text, icons

| DNA Profile | Engine Goal |
|-------------|-------------|
| High K (distinct edges) | 4-6 colors |
| Low noise | Zero dither (Solid) |
| Distinct color regions | Fast separation |
| Low L standard deviation | |

**Test Images Needed:**
- Corporate logo (2-3 colors)
- Simple icon set
- Text-heavy poster
- Flat illustration

### 2. Vintage/Muted (20%)
**Examples:** Faded t-shirts, old posters, distressed prints, sepia photos

| DNA Profile | Engine Goal |
|-------------|-------------|
| Low C (< 15) | 6-8 colors |
| Low K (< 40) | Heavy noise dither to blend |
| Washed-out appearance | Saturation boost applied |

**Test Images Needed:**
- Faded concert poster
- Vintage photograph
- Distressed texture overlay
- Aged paper effect

### 3. Noir/Mono (15%)
**Examples:** Black & white photos, ink drawings, high-contrast art

| DNA Profile | Engine Goal |
|-------------|-------------|
| C near 0 (grayscale) | 2-4 colors |
| High K | Perfect shadow preservation |
| No color information | Black bias protection |

**Test Images Needed:**
- Pen-and-ink drawing
- High-contrast B&W portrait
- Silhouette art
- Charcoal sketch

### 4. Neon/Vibrant (15%)
**Examples:** Concert posters, 80s aesthetics, neon signs, tropical

| DNA Profile | Engine Goal |
|-------------|-------------|
| Extreme C (> 45) | 10-12 colors |
| Often flat K | Max saturation preservation |
| Saturated colors | BlueNoise dither for clamped images |

**Test Images Needed:**
- Neon sign photograph
- 80s synthwave poster
- Tropical bird/flower
- Comic book cover

### 5. Photographic (30%)
**Examples:** Standard photographs (like CQ100 but limited quantity)

| DNA Profile | Engine Goal |
|-------------|-------------|
| Balanced L, C, K | 8-10 colors |
| Full dynamic range | The "control" group |
| Natural appearance | Standard processing |

**Test Images Needed:**
- Portrait
- Landscape
- Product shot
- Street photography

## Target Distribution

```
Category        Target    Ideal Count (of 50)
─────────────────────────────────────────────
Vector/Flat     20%       10 images
Vintage/Muted   20%       10 images
Noir/Mono       15%       7-8 images
Neon/Vibrant    15%       7-8 images
Photographic    30%       15 images
─────────────────────────────────────────────
Total           100%      50 images
```

## Building the Dataset

### Step 1: Gather Candidates

Create a folder with candidate images:

```bash
mkdir -p data/SP50_Candidates
# Add 60-70 images across all categories
```

### Step 2: Analyze Balance

Run the DatasetArchitect to classify and check balance:

```bash
node src/DatasetArchitect.js ./data/SP50_Candidates
```

Output shows:
- Each image's classification
- Current distribution vs targets
- Recommendations (need more X, too many Y)

### Step 3: Curate Final Set

Based on the analysis:
1. Remove excess images from over-represented categories
2. Add images to under-represented categories
3. Re-run analysis until balanced

### Step 4: Process and Validate

```bash
# Process the SP-50 dataset
npm run process-sp50

# Analyze results
npm run analyze-sp50
```

## Success Criteria

The engine is "smart" if it produces this color distribution:

| Category | Expected Colors | Efficiency Penalty |
|----------|-----------------|-------------------|
| Vector/Flat | 4-6 | 0 pts (under 8) |
| Vintage/Muted | 6-8 | 0 pts |
| Noir/Mono | 2-4 | 0 pts (under 8) |
| Neon/Vibrant | 10-12 | 3-6 pts |
| Photographic | 8-10 | 0-3 pts |

**Key Metrics:**
- Average colors: 7-8 (not 12)
- Average efficiency penalty: < 2 pts
- Pass rate: > 85%

## Classification Algorithm

The DatasetArchitect uses this logic:

```javascript
function classify(dna) {
    // 1. MONOCHROME / NOIR
    if (dna.c < 5) return 'Noir/Mono';

    // 2. VINTAGE / MUTED
    if (dna.c < 15 && dna.k < 40) return 'Vintage/Muted';

    // 3. NEON / VIBRANT
    if (dna.c > 45) return 'Neon/Vibrant';

    // 4. VECTOR / FLAT
    if (dna.l_std_dev < 15) return 'Vector/Flat';

    // 5. PHOTOGRAPHIC (Catch-all)
    return 'Photographic';
}
```

## DNA Reference

| Metric | Symbol | Range | Meaning |
|--------|--------|-------|---------|
| Lightness | L | 0-100 | Average brightness |
| Chroma | C | 0-100+ | Color saturation |
| Contrast | K | 0-100 | Dynamic range (maxL - minL) |
| Max Chroma | maxC | 0-128 | Peak saturation (for saliency) |
| L Std Dev | l_std_dev | 0-50 | Lightness variation (flat vs textured) |

## File Naming Convention

Recommended naming for SP-50 images:

```
sp50_vector_logo_acme.png
sp50_vintage_poster_woodstock.jpg
sp50_noir_portrait_shadow.jpg
sp50_neon_synthwave_grid.png
sp50_photo_landscape_mountain.jpg
```

## Version History

- **v1.0** (2026-01-20): Initial specification
- CQ100 analysis revealed need for diverse dataset
- Chroma Driver v1.3 requires varied input to demonstrate efficiency
