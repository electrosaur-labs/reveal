# SP-100 Dataset Sources

> **Status:** Research Complete - Ready for Download
> **Date:** 2026-01-20

## Overview

The SP-100 dataset will be built from established research datasets that naturally contain the archetypes needed for screen print workflow testing. No manual curation needed - the research community has done the heavy lifting.

## Recommended Sources

### 1. BAM! (Behance Artistic Media)

**Best For:** Vector, Neon, & Modern Digital Art

| Attribute | Value |
|-----------|-------|
| Source | Behance (professional design platform) |
| Content | Graphic design, flat vector illustrations, digital posters |
| Expected Archetypes | Vector/Flat, Neon/Vibrant |
| Target Colors | 4-8 (vectors), 10-12 (neon posters) |

**Why It Works:**
- Professional graphic design = distinct, high-chroma flat colors
- Closest thing to a "Commercial Screen Print" dataset
- Tests if engine correctly assigns low color counts to simple vectors

**The Test:** If the engine assigns 12 colors to a simple vector logo, it fails.

**Link:** [BAM! Dataset](https://bam-dataset.org/)

---

### 2. Library of Congress: Performing Arts Posters

**Best For:** Vintage, Texture, & Typography

| Attribute | Value |
|-----------|-------|
| Source | Library of Congress |
| Content | 2,100+ American theater/magic posters (1890-1920) |
| Expected Archetypes | Vintage/Muted |
| Target Colors | 6-8 with BlueNoise dither |

**Why It Works:**
- Images are already screen printed or lithographed
- Naturally have low color counts (4-8) but high texture/noise
- Tests Vintage detection (Low Chroma, High Contrast)

**The Test:** Engine should identify as "Vintage" and assign 8 colors max.

**Link:** [LOC Performing Arts Collection](https://www.loc.gov/collections/performing-arts-posters/)

---

### 3. Manga109 / ComicLib

**Best For:** Noir, Line Art, & High Contrast

| Attribute | Value |
|-----------|-------|
| Source | Academic manga dataset |
| Content | Pure B&W or limited-color manga illustrations |
| Expected Archetypes | Noir/Mono |
| Target Colors | 2-4 |

**Why It Works:**
- Pure black-and-white = ultimate test for Noir logic
- If engine tries to find 12 colors in B&W manga, the logic is broken

**The Test:** Engine must assign 2-4 colors maximum.

**Link:** [Manga109](http://www.manga109.org/en/)

---

### 4. WikiArt (Posters Category)

**Best For:** The Control Group (Variety)

| Attribute | Value |
|-----------|-------|
| Source | WikiArt public domain collection |
| Content | Art Nouveau, Constructivism, Bauhaus posters |
| Expected Archetypes | Mixed (all types) |
| Target Colors | 4-12 depending on style |

**Why It Works:**
- Provides variety: 4-color Bauhaus vs 12-color Art Nouveau
- Tests engine's ability to switch between archetypes

**The Test:** Can engine handle style variety without crashing?

**Link:** [WikiArt Posters](https://www.wikiart.org/en/paintings-by-genre/poster)

---

## SP-100 Build Plan

### Recommended Mix

| Source | Count | Archetypes |
|--------|-------|------------|
| BAM! (Behance) | 50 | Vector, Neon |
| Library of Congress | 50 | Vintage |
| **Total** | **100** | |

### Alternative: SP-50 Quick Build

| Source | Count | Archetypes |
|--------|-------|------------|
| BAM! | 25 | Vector, Neon |
| LOC Posters | 15 | Vintage |
| Manga109 | 10 | Noir |
| **Total** | **50** | |

---

## Download Instructions

### BAM! Dataset
```bash
# Registration required at bam-dataset.org
# Download "BAM! 5.0" (latest version)
# Extract poster/illustration categories
```

### Library of Congress
```bash
# Direct download available
# Filter by "Performing Arts Posters"
# Download high-resolution JPEGs
curl -O "https://www.loc.gov/collections/performing-arts-posters/?fo=json&fa=online-format:image"
```

### Manga109
```bash
# Academic use - registration required
# http://www.manga109.org/en/download.html
```

### WikiArt
```bash
# Public domain images
# Use wikiart-downloader or manual selection
# Filter: Genre = Poster
```

---

## Expected Results

After processing SP-100 with Chroma Driver v1.3:

| Archetype | Expected Colors | Pass Criteria |
|-----------|-----------------|---------------|
| Vector (BAM!) | 4-6 | No efficiency penalty |
| Neon (BAM!) | 10-12 | Penalty acceptable |
| Vintage (LOC) | 6-8 | No efficiency penalty |
| Noir (Manga109) | 2-4 | No efficiency penalty |

**Success Metric:**
- Average colors: 6-8 (not 12)
- Average efficiency penalty: < 1.5 pts
- Pass rate: > 90%

---

## Comparison: CQ100 vs SP-100

| Metric | CQ100 | SP-100 (Expected) |
|--------|-------|-------------------|
| Content | Photography | Design/Art |
| Avg Chroma | 19.4 | 30-40 (varied) |
| Avg Contrast | 96.4 | 60-80 (varied) |
| Archetype Mix | 91% Photo | Balanced |
| Color Distribution | 41% at 12c | <20% at 12c |

SP-100 will validate that the Chroma Driver correctly identifies and handles diverse print archetypes.
