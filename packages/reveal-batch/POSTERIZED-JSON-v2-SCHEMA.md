# Posterized JSON v2.0 Schema

Updated batch processing JSON output format with DNA v2.0 and archetype matching details.

**Updated:** 2026-02-04

---

## Changes from v1.0

### 1. DNA v2.0 Structure

**OLD (DNA v1.0):**
```json
{
  "dna": {
    "l": 72.8,
    "c": 7.5,
    "k": 100,
    "l_std_dev": 30.8,
    "minL": 0,
    "maxL": 100,
    "maxC": 42.4,
    "lowChromaDensity": 0.745,
    "filename": "wood_game",
    "bitDepth": 16
  }
}
```

**NEW (DNA v2.0):**
```json
{
  "dna": {
    "version": "2.0",

    "global": {
      "l": 72.8,
      "c": 7.5,
      "k": 100,
      "l_std_dev": 30.8,
      "hue_entropy": 0.456,
      "temperature_bias": 0.12,
      "primary_sector_weight": 0.25,

      "minL": 0,
      "maxL": 100,
      "maxC": 42.4,
      "lowChromaDensity": 0.745,
      "warm_cool_ratio": 0.56
    },

    "dominant_sector": "orange",

    "sectors": {
      "red": { "weight": 0.08, "lMean": 45.2, "cMean": 28.4, "cMax": 42.1 },
      "orange": { "weight": 0.25, "lMean": 65.8, "cMean": 35.6, "cMax": 58.3 },
      "yellow": { "weight": 0.15, "lMean": 78.3, "cMean": 42.1, "cMax": 65.2 },
      "chartreuse": { "weight": 0.05, "lMean": 72.1, "cMean": 18.7, "cMax": 28.9 },
      "green": { "weight": 0.12, "lMean": 52.4, "cMean": 22.5, "cMax": 38.6 },
      "cyan": { "weight": 0.03, "lMean": 68.9, "cMean": 15.2, "cMax": 22.4 },
      "azure": { "weight": 0.02, "lMean": 58.3, "cMean": 12.8, "cMax": 18.5 },
      "blue": { "weight": 0.08, "lMean": 42.7, "cMean": 25.6, "cMax": 38.2 },
      "purple": { "weight": 0.06, "lMean": 38.5, "cMean": 18.3, "cMax": 28.7 },
      "magenta": { "weight": 0.07, "lMean": 55.2, "cMean": 32.4, "cMax": 48.5 },
      "pink": { "weight": 0.05, "lMean": 72.8, "cMean": 22.1, "cMax": 32.8 },
      "rose": { "weight": 0.04, "lMean": 48.6, "cMean": 28.9, "cMax": 42.3 }
    },

    "l": 72.8,
    "c": 7.5,
    "k": 100,
    "l_std_dev": 30.8,
    "minL": 0,
    "maxL": 100,
    "maxC": 42.4,
    "filename": "wood_game",
    "bitDepth": 16
  }
}
```

**Key Additions:**
- `version`: "2.0" marker
- `global`: 7D core metrics + extended fields
- `dominant_sector`: Primary hue sector (or "none")
- `sectors`: 12 hue sectors (30° each) with weight/lMean/cMean/cMax
- Legacy fields preserved at top level for backward compatibility

---

### 2. Archetype Matching Details

**OLD:**
```json
{
  "configuration": {
    "meta": {
      "archetype": "Bright Desaturated / High-Key Contrast",
      "archetypeId": "bright_desaturated",
      "matchDistance": 0
    }
  }
}
```

**NEW (DNA v1.0 matching):**
```json
{
  "configuration": {
    "meta": {
      "archetype": "Bright Desaturated / High-Key Contrast",
      "archetypeId": "bright_desaturated",
      "matchVersion": "1.0",
      "matchDistance": 15.3
    }
  }
}
```

**NEW (DNA v2.0 matching):**
```json
{
  "configuration": {
    "meta": {
      "archetype": "Subtle Naturalist",
      "archetypeId": "subtle_naturalist",
      "matchVersion": "2.0",
      "matchScore": 72.5,
      "matchBreakdown": {
        "structural": 68.2,
        "sectorAffinity": 78.5,
        "pattern": 65.0
      }
    }
  }
}
```

**Key Additions:**
- `matchVersion`: "1.0" or "2.0"
- `matchScore`: Total score (0-100) for DNA v2.0
- `matchBreakdown`: Component scores
  - `structural`: Distance-based similarity (40% weight)
  - `sectorAffinity`: 12-sector voting (45% weight)
  - `pattern`: Pattern detection bonus (15% weight)

---

## Complete Example (DNA v2.0)

```json
{
  "meta": {
    "filename": "wood_game.psd",
    "timestamp": "2026-02-04T12:00:00.000Z",
    "width": 2400,
    "height": 2400,
    "inputBitDepth": 16,
    "outputFile": "wood_game.psd"
  },

  "dna": {
    "version": "2.0",
    "global": {
      "l": 72.8,
      "c": 7.5,
      "k": 100,
      "l_std_dev": 30.8,
      "hue_entropy": 0.456,
      "temperature_bias": 0.12,
      "primary_sector_weight": 0.25,
      "minL": 0,
      "maxL": 100,
      "maxC": 42.4,
      "lowChromaDensity": 0.745,
      "warm_cool_ratio": 0.56
    },
    "dominant_sector": "orange",
    "sectors": {
      "red": { "weight": 0.08, "lMean": 45.2, "cMean": 28.4, "cMax": 42.1 },
      "orange": { "weight": 0.25, "lMean": 65.8, "cMean": 35.6, "cMax": 58.3 },
      "yellow": { "weight": 0.15, "lMean": 78.3, "cMean": 42.1, "cMax": 65.2 },
      "chartreuse": { "weight": 0.05, "lMean": 72.1, "cMean": 18.7, "cMax": 28.9 },
      "green": { "weight": 0.12, "lMean": 52.4, "cMean": 22.5, "cMax": 38.6 },
      "cyan": { "weight": 0.03, "lMean": 68.9, "cMean": 15.2, "cMax": 22.4 },
      "azure": { "weight": 0.02, "lMean": 58.3, "cMean": 12.8, "cMax": 18.5 },
      "blue": { "weight": 0.08, "lMean": 42.7, "cMean": 25.6, "cMax": 38.2 },
      "purple": { "weight": 0.06, "lMean": 38.5, "cMean": 18.3, "cMax": 28.7 },
      "magenta": { "weight": 0.07, "lMean": 55.2, "cMean": 32.4, "cMax": 48.5 },
      "pink": { "weight": 0.05, "lMean": 72.8, "cMean": 22.1, "cMax": 32.8 },
      "rose": { "weight": 0.04, "lMean": 48.6, "cMean": 28.9, "cMax": 42.3 }
    },
    "l": 72.8,
    "c": 7.5,
    "k": 100,
    "l_std_dev": 30.8,
    "minL": 0,
    "maxL": 100,
    "maxC": 42.4,
    "filename": "wood_game",
    "bitDepth": 16
  },

  "configuration": {
    "id": "subtle_naturalist",
    "name": "Subtle Naturalist",
    "targetColors": 10,
    "ditherType": "blue-noise",
    "distanceMetric": "cie94",
    "lWeight": 1.2,
    "cWeight": 2.0,
    "blackBias": 2.5,
    "vibrancyMode": "moderate",
    "vibrancyBoost": 1.3,
    "meta": {
      "archetype": "Subtle Naturalist",
      "archetypeId": "subtle_naturalist",
      "peakChroma": 42.4,
      "isPhoto": false,
      "isGraphic": false,
      "isArchive": true,
      "bitDepth": 16,
      "matchVersion": "2.0",
      "matchScore": 72.5,
      "matchBreakdown": {
        "structural": 68.2,
        "sectorAffinity": 78.5,
        "pattern": 65.0
      }
    },
    "preprocessing": {
      "enabled": false,
      "intensity": "off",
      "entropyScore": 0,
      "reason": "Very low entropy (0.0, 8-bit) - already clean"
    }
  },

  "palette": [...],
  "metrics": {...},
  "timing": {...}
}
```

---

## DNA v2.0 Field Reference

### Global Metrics (7D Core)
| Field | Range | Description |
|-------|-------|-------------|
| `l` | 0-100 | Average lightness |
| `c` | 0-150 | Average chroma (saturation) |
| `k` | 0-100 | Contrast (dynamic range) |
| `l_std_dev` | 0-50 | Lightness standard deviation |
| `hue_entropy` | 0-1 | Color diversity (0=monochrome, 1=rainbow) |
| `temperature_bias` | -1 to +1 | Warm/cool balance (-1=cool, 0=neutral, +1=warm) |
| `primary_sector_weight` | 0-1 | Weight of dominant hue sector |

### Extended Metrics
| Field | Range | Description |
|-------|-------|-------------|
| `minL` | 0-100 | Darkest pixel lightness |
| `maxL` | 0-100 | Brightest pixel lightness |
| `maxC` | 0-150 | Maximum chroma spike |
| `lowChromaDensity` | 0-1 | Proportion of low-chroma pixels |
| `warm_cool_ratio` | 0-1 | Warm/(Warm+Cool) ratio |

### Sector Fields (per hue sector)
| Field | Range | Description |
|-------|-------|-------------|
| `weight` | 0-1 | Proportion of chromatic pixels in this hue |
| `lMean` | 0-100 | Average lightness in this hue |
| `cMean` | 0-150 | Average chroma in this hue |
| `cMax` | 0-150 | Maximum chroma spike in this hue |

### 12 Hue Sectors (30° each)
1. **red** (345-15°)
2. **orange** (15-45°)
3. **yellow** (45-75°)
4. **chartreuse** (75-105°)
5. **green** (105-135°)
6. **cyan** (135-165°)
7. **azure** (165-195°)
8. **blue** (195-225°)
9. **purple** (225-255°)
10. **magenta** (255-285°)
11. **pink** (285-315°)
12. **rose** (315-345°)

---

## Archetype Matching Score Breakdown

### Structural Score (40% weight)
- Distance-to-similarity conversion using exponential decay
- Compares L/C/K/σL (DNA v1.0) or full 7D space (DNA v2.0)
- Range: 0-100 (100 = perfect match)

### Sector Affinity Score (45% weight)
- Weighted voting by 12 hue sectors
- Each sector votes based on:
  - **Favored sectors**: Bonus if sector matches archetype expectations
  - **Chroma profile**: Alignment with expected cMax ranges
  - **Tonal range**: Alignment with expected lMean ranges
- Range: 0-100 (100 = perfect chromatic alignment)

### Pattern Match Score (15% weight)
- Detects specific patterns:
  - **Monochromatic** (entropy < 0.3) → Structural Rescue
  - **Rainbow** (entropy > 0.85) → Subtle Naturalist
  - **Blue outlier** in warm image → Blue Rescue
  - **Warm dominant** → Vibrant Hyper
  - **Chroma spikes** → Neon Graphic
- Range: 0-100 (bonus for pattern matches)

---

## Backward Compatibility

### DNA v1.0 Support
- Legacy fields (`l`, `c`, `k`, `l_std_dev`) preserved at top level
- DNA v1.0 images (no `version` field) still match using 4D distance
- `matchVersion: "1.0"` and `matchDistance` in metadata

### Mixed Datasets
- Same batch can contain both DNA v1.0 and v2.0 images
- Meta analyzers handle both formats
- CSV export includes both matchDistance and matchScore columns

---

## Testing the New Format

### Process Single Image
```bash
cd packages/reveal-batch
node src/posterize-psd.js 16 data/TESTIMAGES/input/psd/16bit/wood_game.psd /tmp/test
cat /tmp/test/wood_game.json
```

### Batch Process TESTIMAGES
```bash
cd data/TESTIMAGES
./batch-process-flat.js
```

### Analyze Results
```bash
cd packages/reveal-batch
node src/TESTIMAGES_MetaAnalyzer.js
```

The analyzer will show:
- **By Archetype**: Distribution of matched archetypes (with v2.0 scores)
- **Score Distribution**: Average structural/sector/pattern scores
- **Outliers**: Best and worst matches with score breakdowns

---

## Implementation Files Modified

1. **`packages/reveal-core/lib/analysis/ArchetypeLoader.js`**
   - Attach `matchScore`, `matchBreakdown`, `matchVersion` to archetype
   - DNA v1.0: Attach `matchDistance`, `matchVersion`

2. **`packages/reveal-core/lib/analysis/ParameterGenerator.js`**
   - Include matching details in `config.meta`
   - Support both v1.0 and v2.0 formats

3. **`packages/reveal-batch/src/posterize-psd.js`**
   - Update `calculateImageDNA()` to return DNA v2.0 with `global` object
   - Preserve legacy fields for backward compatibility
   - Include all 12 sectors with full metrics

---

This schema enables comprehensive validation of the DNA v2.0 archetype matching system and provides rich data for analyzing batch processing results.
