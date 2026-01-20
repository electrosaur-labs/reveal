# reveal-batch: Next Steps Plan

## Current State (2026-01-20)

### Completed
1. **Chroma Driver v1.3** - Color budget based on saturation, not dynamic range
2. **Efficiency Penalty** - Screen count penalty in revelation score
3. **Calibrated Thresholds** - Failure threshold at RevScore < 20
4. **CQ100 Processing** - 100 images processed with new configurator

### CQ100 Results
- **Color Distribution:** 18% at 8c, 41% at 10c, 41% at 12c
- **Pass Rate:** 82.2% (83/101 passing)
- **Avg Efficiency Penalty:** 3.7 pts (down from 5.9)

### Problem Identified
CQ100 is too homogeneous for tuning a "smart" engine:

| Category | CQ100 | SP-50 Target |
|----------|-------|--------------|
| Vector/Flat | 0% | 20% |
| Vintage/Muted | 0% | 20% |
| Noir/Mono | 6% | 15% |
| Neon/Vibrant | 4% | 15% |
| Photographic | 91% | 30% |

## Next Phase: SP-50 Dataset

### Step 1: Gather Candidate Images
Collect 60-70 diverse images representing screen print work (not photography):

**Vector/Flat (10+ needed):**
- Corporate logos
- Flat illustrations
- Text-heavy posters
- Icon sets

**Vintage/Muted (10+ needed):**
- Faded concert posters
- Distressed textures
- Sepia photographs
- Aged paper effects

**Noir/Mono (8+ needed):**
- Pen-and-ink drawings
- B&W portraits
- Silhouette art
- Charcoal sketches

**Neon/Vibrant (8+ needed):**
- Neon sign photos
- 80s synthwave art
- Comic book covers
- Tropical subjects

**Photographic (15+ needed):**
- Portrait
- Landscape
- Product shot
- Street photography

### Step 2: Analyze Dataset Balance
```bash
npm run analyze-dataset ./data/SP50_Candidates
```

### Step 3: Curate Final 50
Remove excess, add missing categories until balanced.

### Step 4: Process and Validate
```bash
npm run process-sp50
npm run analyze-sp50
```

### Success Criteria
- Average colors: 7-8 (not 12)
- Average efficiency penalty: < 2 pts
- Pass rate: > 85%
- Color distribution matches image complexity

## Files Created This Session

| File | Purpose |
|------|---------|
| `src/DatasetArchitect.js` | Analyzes dataset balance by archetype |
| `src/RevalidateQuality.js` | Applies efficiency penalty to existing JSONs |
| `docs/SP-50-DATASET.md` | Full SP-50 specification |
| `data/SP50_Candidates/` | Directory for candidate images |

## Configuration Changes

| File | Change |
|------|--------|
| `@reveal/core/lib/analysis/ParameterGenerator.js` | Chroma Driver v1.3 |
| `src/MetricsCalculator.js` | Added efficiency penalty |
| `src/CQ100_MetaAnalyzer.js` | Calibrated thresholds (RevScore > 20) |

## Commands Reference

```bash
# Analyze dataset balance
npm run analyze-dataset ./path/to/images

# Revalidate with efficiency penalty
npm run revalidate-quality

# Run CQ100 analysis
npm run analyze-cq100

# Process CQ100 batch
npm run process-cq100
```
