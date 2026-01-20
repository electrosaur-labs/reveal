# SP-100 Dataset Build Guide

> **Purpose:** Step-by-step instructions for building the SP-100 validation dataset
> **Time Required:** ~2 hours
> **Prerequisites:** Internet access, ~2GB disk space

## Overview

SP-100 tests the Chroma Driver's ability to assign economically sensible color counts to diverse print archetypes. Unlike CQ100 (91% photography), SP-100 contains vectors, vintage posters, and line art.

## Step 1: Create Directory Structure

```bash
cd /workspaces/electrosaur/reveal-project/packages/reveal-batch
mkdir -p data/SP100/input
mkdir -p data/SP100/output
```

## Step 2: Download BAM! Dataset (50 images)

**Source:** [bam-dataset.org](https://bam-dataset.org/)

1. Register for academic/research access
2. Download BAM! 5.0 dataset
3. Extract and select 50 images:
   - 25 flat vector illustrations (logos, icons, simple graphics)
   - 25 vibrant digital posters (neon, gradients, complex colors)

```bash
# After downloading, copy selected images
cp /path/to/bam/vectors/*.jpg data/SP100/input/
cp /path/to/bam/posters/*.jpg data/SP100/input/

# Rename with prefix for tracking
cd data/SP100/input
for f in *.jpg; do mv "$f" "bam_$f"; done
```

**Selection Criteria:**
- Vectors: Look for flat colors, distinct shapes, minimal gradients
- Posters: Look for vibrant colors, complex compositions, neon effects

## Step 3: Download LOC Performing Arts Posters (50 images)

**Source:** [loc.gov/collections/performing-arts-posters](https://www.loc.gov/collections/performing-arts-posters/)

1. Browse the collection online
2. Download 50 high-resolution JPEGs
3. Focus on:
   - Theater posters (1890-1920)
   - Magic show advertisements
   - Vaudeville bills

```bash
# Manual download from LOC website, then:
cp /path/to/loc/posters/*.jpg data/SP100/input/

# Rename with prefix
cd data/SP100/input
for f in *.jpg; do
  if [[ ! $f == bam_* ]]; then
    mv "$f" "loc_$f"
  fi
done
```

**Selection Criteria:**
- Visible wear/texture (tests vintage detection)
- Limited color palette (4-8 colors in original)
- Typography-heavy designs

## Step 4: Verify Dataset Balance

```bash
cd /workspaces/electrosaur/reveal-project/packages/reveal-batch
npm run analyze-dataset -- ./data/SP100/input
```

**Expected Output:**
```
📊 DATASET BALANCE REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Vector/Flat:     20-30%  (target: 20%)
✓ Vintage/Muted:   40-50%  (target: 50%)
✓ Neon/Vibrant:    15-25%  (target: 15%)
⚠️ Photographic:   <10%    (target: 0%)
```

If balance is off, add/remove images and re-run.

## Step 5: Process Dataset

```bash
# Create processing script (or use existing batch processor)
npm run process-sp100
```

Or manually:

```bash
node src/cli.js process ./data/SP100/input --output ./data/SP100/output --analyze
```

## Step 6: Analyze Results

```bash
npm run analyze-sp100
```

**Success Criteria:**

| Metric | CQ100 Baseline | SP-100 Target |
|--------|----------------|---------------|
| Avg Colors | 10.2 | **6-8** |
| Efficiency Penalty | 3.7 pts | **< 1.5 pts** |
| Pass Rate | 82% | **> 90%** |
| 12-color images | 41% | **< 20%** |

## Step 7: Validate Archetype Assignments

Check that the engine correctly identified archetypes:

```bash
# Count color assignments by source
cat data/SP100/output/*.json | jq -s '
  [.[] | {
    source: (if .meta.filename | startswith("bam_") then "BAM" else "LOC" end),
    colors: .configuration.targetColors
  }] | group_by(.source) | map({
    source: .[0].source,
    avg_colors: ([.[].colors] | add / length),
    distribution: (group_by(.colors) | map({colors: .[0].colors, count: length}))
  })'
```

**Expected:**
- BAM vectors: 4-8 colors
- BAM posters: 10-12 colors
- LOC vintage: 6-8 colors

## Troubleshooting

### Too Many 12-Color Assignments

If > 30% of images get 12 colors:
1. Check if images are actually photographs (misclassified)
2. Review Chroma Driver thresholds in `ParameterGenerator.js`
3. Consider raising `c > 50` threshold for 12-color assignment

### Vintage Not Detected

If LOC posters get high color counts:
1. Check chroma values in DNA output
2. Vintage detection requires: `c < 15 && k < 40`
3. LOC posters may have been digitally enhanced - select originals

### Vector Detection Failing

If flat vectors get 10+ colors:
1. Check `l_std_dev` values (should be < 15 for vectors)
2. May need to add explicit vector detection to Chroma Driver

## Optional: Add Manga109 for Noir Testing

If noir detection needs validation:

1. Register at [manga109.org](http://www.manga109.org/en/)
2. Download 10-20 B&W manga pages
3. Add to SP100 with `noir_` prefix
4. Re-run analysis

**Noir Success Criteria:** 2-4 colors maximum

## Files Reference

```
packages/reveal-batch/
├── data/
│   └── SP100/
│       ├── input/           # 100 source images
│       │   ├── bam_*.jpg    # 50 BAM images
│       │   └── loc_*.jpg    # 50 LOC images
│       └── output/
│           ├── *.psd        # Separated PSDs
│           └── *.json       # Analysis sidecars
├── docs/
│   ├── SP-100-SOURCES.md    # Dataset source links
│   └── SP-100-BUILD-GUIDE.md # This file
└── src/
    └── DatasetArchitect.js  # Balance analyzer
```

## After Completion

1. Run final analysis: `npm run analyze-sp100`
2. Update SESSION_STATE.md with results
3. If targets met, tag as `v1.4.0-sp100-validated`
4. If targets missed, adjust Chroma Driver thresholds and re-process
