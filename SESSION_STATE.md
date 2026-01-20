# Reveal Project Session State - 2026-01-20

## Executive Summary

✅ **MetaAnalyzer calibration complete** - Failure threshold tuned to capture only true outliers
✅ **Efficiency penalty system implemented** - Screen count penalty in revelation score
✅ **Chroma Driver v1.3 deployed** - Color budget based on saturation, not contrast
✅ **SP-50 dataset tooling created** - DatasetArchitect analyzes dataset diversity
✅ **RevealEngine proposal documented** - Future refactor design saved for later
🚧 **SP-50 dataset needed** - CQ100 too homogeneous for stingy configurator tuning

---

## Current Work: Metrics Calibration & SP-50 Dataset (2026-01-20)

**Date:** 2026-01-20 (Current Session)
**Status:** PHASE 1 COMPLETE - Ready for SP-50 image collection

### Session Focus

Calibrate the Dynamic Configurator and MetaAnalyzer to produce economically sensible color separations.

### What Was Done

#### 1. MetaAnalyzer Calibration
- **File:** `packages/reveal-batch/src/CQ100_MetaAnalyzer.js`
- Lowered failure threshold: RevScore 50 → 30 → **20**
- Now captures only true failures (~10% bottom outliers)
- Added calibration documentation in file header
- Rationale: "A validator that flags 32% of images as failures is one users will turn off"

#### 2. Efficiency Penalty System
- **File:** `packages/reveal-batch/src/MetricsCalculator.js`
- Added screen count penalty to revelation score
- `<= 8 colors`: 0 penalty (efficiency safe zone)
- `> 8 colors`: -1.5 pts per extra screen
- 12 colors = -6 pts penalty
- New fields in metrics: `baseScore`, `efficiencyPenalty`, `screenCount`

- **File:** `packages/reveal-batch/src/RevalidateQuality.js` (NEW)
- Retroactively applies efficiency penalty to existing JSONs
- `npm run revalidate-quality`

#### 3. Chroma Driver v1.3
- **File:** `packages/reveal-core/lib/analysis/ParameterGenerator.js`
- **Key Insight:** K (contrast) is always 90-100 for photographs - not useful for color budgeting
- Color budget now based on **saturation (C)**, not dynamic range (K)
- Thresholds:
  - c ≤ 20: 8 colors (muted, vintage, noir)
  - c > 20: 10 colors (most photographs)
  - c > 50: 12 colors (hyper vibrant)
- K (contrast) still used for dither strategy selection (Atkinson vs BlueNoise)
- Saliency Rescue preserved: c < 15 AND maxC > 50 → force 12 colors

#### 4. SP-50 Dataset Tooling
- **File:** `packages/reveal-batch/src/DatasetArchitect.js` (NEW)
- Classifies images into 5 archetypes based on DNA
- Analyzes dataset balance against SP-50 targets
- `npm run analyze-dataset ./path/to/images`

- **File:** `packages/reveal-batch/docs/SP-50-DATASET.md` (NEW)
- Full specification for diverse dataset
- Target distribution:
  - Vector/Flat: 20% (logos, flat illustration)
  - Vintage/Muted: 20% (faded posters, distress)
  - Noir/Mono: 15% (B&W, ink drawings)
  - Neon/Vibrant: 15% (concert posters, 80s)
  - Photographic: 30% (standard photos)

#### 5. RevealEngine Proposal
- **File:** `packages/reveal-adobe/docs/REVEAL-ENGINE-PROPOSAL.md` (NEW)
- Design document for future refactor of reveal-adobe
- Includes RemapTable for soft-delete feature
- Deferred until SP-50 validation complete

### CQ100 Results (After All Calibrations)

| Metric | Value |
|--------|-------|
| Color Distribution | 18% at 8c, 41% at 10c, 41% at 12c |
| Pass Rate | 82.2% (83/101 passing) |
| Avg Efficiency Penalty | 3.7 pts |
| Avg ΔE | 16.02 |
| Avg Revelation | 30.4 |
| Avg Integrity | 92.7 |

### CQ100 Limitation Identified

Dataset is **91% photographic** - not diverse enough to properly tune "stingy" configurator:

| Category | CQ100 | SP-50 Target |
|----------|-------|--------------|
| Vector/Flat | 0% | 20% |
| Vintage/Muted | 0% | 20% |
| Noir/Mono | 6% | 15% |
| Neon/Vibrant | 4% | 15% |
| Photographic | 91% | 30% |

**Conclusion:** Need SP-50 dataset with diverse image types to validate efficiency tuning.

---

## Files Modified This Session

| File | Change |
|------|--------|
| `reveal-core/lib/analysis/ParameterGenerator.js` | Chroma Driver v1.3 |
| `reveal-batch/src/MetricsCalculator.js` | Added efficiency penalty |
| `reveal-batch/src/CQ100_MetaAnalyzer.js` | Calibrated thresholds |
| `reveal-batch/src/RevalidateQuality.js` | NEW - retroactive penalty |
| `reveal-batch/src/DatasetArchitect.js` | NEW - dataset balance analyzer |
| `reveal-batch/docs/SP-50-DATASET.md` | NEW - dataset specification |
| `reveal-batch/PLAN.md` | NEW - next steps |
| `reveal-batch/package.json` | Added npm scripts |
| `reveal-adobe/docs/REVEAL-ENGINE-PROPOSAL.md` | NEW - refactor proposal |

---

## Pending Todos

### Near-term (SP-50 Dataset)
1. [ ] Build SP-50 dataset (gather 50 diverse images)
2. [ ] Run DatasetArchitect on SP-50 candidates to verify balance
3. [ ] Process SP-50 batch and validate color distribution

### Future (RevealEngine Refactor)
4. [ ] Port MetricsCalculator from reveal-batch to reveal-core
5. [ ] Implement RemapTable for soft-delete feature
6. [ ] Refactor reveal-adobe to use RevealEngine facade pattern

---

## Commands Reference

```bash
# In packages/reveal-batch:

# Analyze dataset balance
npm run analyze-dataset ./path/to/images

# Revalidate with efficiency penalty
npm run revalidate-quality

# Run CQ100 analysis
npm run analyze-cq100

# Process CQ100 batch
npm run process-cq100
```

---

## Key Algorithm: Chroma Driver v1.3

```javascript
// Color budget based on saturation (C), not dynamic range (K)
static generate(dna) {
    let idealColors = 8;  // Baseline: Economic standard

    // Earning upgrades (driven by Chroma)
    if (dna.c > 20) idealColors = 10;  // Moderate saturation
    if (dna.c > 50) idealColors = 12;  // Hyper vibrant

    // Saliency Rescue (Astronaut Rule)
    if (dna.c < 15 && dna.maxC > 50) {
        idealColors = 12;  // Hidden color spike
    }

    // Commercial clamp
    let finalColors = Math.min(idealColors, 12);
    finalColors = Math.max(4, finalColors);

    // Dither strategy (K still used here)
    let dither = 'BlueNoise';
    if (finalColors >= idealColors && dna.k > 80) {
        dither = 'Atkinson';  // Sharp edges for high contrast
    }

    return { targetColors: finalColors, ditherType: dither, ... };
}
```

---

## Key Algorithm: Efficiency Penalty

```javascript
// In MetricsCalculator.js
const SCREEN_LIMIT = 8;
const PENALTY_PER_SCREEN = 1.5;

// Base score from visual fidelity
const baseRevScore = 100 - (avgDeltaE * 1.5) - (saliencyLoss * 2);

// Efficiency penalty for screen bloat
let efficiencyPenalty = 0;
if (screenCount > SCREEN_LIMIT) {
    efficiencyPenalty = (screenCount - SCREEN_LIMIT) * PENALTY_PER_SCREEN;
}

// Final score
const revScore = Math.max(0, baseRevScore - efficiencyPenalty);
```

---

## Resume Instructions

1. Read this file for context
2. Check todos above for next steps
3. **Primary focus:** Build SP-50 dataset with diverse images
4. Use `npm run analyze-dataset` to verify balance before processing
5. Target distribution: 20% Vector, 20% Vintage, 15% Noir, 15% Neon, 30% Photo

---

## Previous Session Work (2026-01-19)

### Completed Previously
- ✅ Complete dithering algorithm integration (6 algorithms)
- ✅ Preset architecture refactoring (moved to reveal-core)
- ✅ Parameter analysis (24 UI parameters documented)
- ✅ Added 3 new presets with 23-parameter structure
- ✅ Checkbox event dispatch fix
- ✅ Substrate duplication fix
- ✅ @reveal/psd-writer package (8-bit Lab multi-layer)

### PSD Writer Status
- Phase 1 complete: Synthetic test program working
- Issue: Layers show as raster, not fill layers
- Needs: Reference PSD from Photoshop for empirical validation
- See previous SESSION_STATE.md sections for details

---

## Project Structure

```
reveal-project/
├── SESSION_STATE.md              (this file)
├── PARAMETER_ANALYSIS.md         (24 parameter documentation)
├── packages/
│   ├── reveal-core/
│   │   ├── lib/
│   │   │   ├── engines/
│   │   │   │   ├── PosterizationEngine.js
│   │   │   │   └── SeparationEngine.js (6 dithering algorithms)
│   │   │   └── analysis/
│   │   │       └── ParameterGenerator.js (Chroma Driver v1.3)
│   │   └── presets/ (13 JSON files)
│   ├── reveal-batch/
│   │   ├── src/
│   │   │   ├── MetricsCalculator.js (efficiency penalty)
│   │   │   ├── CQ100_MetaAnalyzer.js (calibrated thresholds)
│   │   │   ├── RevalidateQuality.js (NEW)
│   │   │   └── DatasetArchitect.js (NEW)
│   │   ├── docs/
│   │   │   └── SP-50-DATASET.md (NEW)
│   │   └── data/
│   │       ├── CQ100_v4/ (100 test images)
│   │       └── SP50_Candidates/ (NEW - empty, needs images)
│   ├── reveal-adobe/
│   │   ├── src/
│   │   │   ├── index.js (~127KB plugin)
│   │   │   └── DNAGenerator.js
│   │   └── docs/
│   │       └── REVEAL-ENGINE-PROPOSAL.md (NEW)
│   └── reveal-psd-writer/
│       └── (8-bit Lab PSD writer)
```

---

**Session started:** 2026-01-20
**Session ended:** 2026-01-20
**Status:** ✅ CALIBRATION COMPLETE - Ready for SP-50 dataset collection
**Ready for:** Image gathering for SP-50 dataset
