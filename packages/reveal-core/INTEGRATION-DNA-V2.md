# DNA v2.0 Integration Guide

## Overview

DNA v2.0 adds sophisticated archetype matching using **12-sector hue analysis** and **multi-factor scoring**. This guide shows how to integrate the new system into existing workflows.

---

## Quick Start

### 1. Generate DNA v2.0 from Lab Pixels

```javascript
const { DNAGenerator } = require('@reveal/core');

const generator = new DNAGenerator();
const dna = generator.generate(labPixels, width, height, { bitDepth: 8 });

console.log(dna);
// {
//   version: '2.0',
//   global: {
//     l: 52.3,
//     c: 18.7,
//     k: 94.2,
//     l_std_dev: 28.6,
//     hue_entropy: 0.75,
//     temperature_bias: 0.0,
//     primary_sector_weight: 0.15
//   },
//   dominant_sector: 'green',
//   sectors: {
//     red: { weight: 0.10, lMean: 50, cMean: 20, cMax: 35 },
//     orange: { weight: 0.08, lMean: 52, cMean: 18, cMax: 30 },
//     yellow: { weight: 0.12, lMean: 55, cMean: 25, cMax: 38 },
//     // ... 9 more sectors
//   }
// }
```

### 2. Match DNA to Archetype (Automatic)

```javascript
const { ArchetypeLoader } = require('@reveal/core');

// DNA v2.0: Uses multi-factor scoring (40/45/15)
const archetype = ArchetypeLoader.matchArchetype(dna);

console.log(`Matched: ${archetype.name}`);
// Logs detailed breakdown:
// 🎯 Matched archetype: Subtle Naturalist / Architectural (score: 87.5)
//    DNA v2.0 Breakdown:
//    • Structural:      92.3/100 (40% weight)
//    • Sector Affinity: 85.1/100 (45% weight)
//    • Pattern Match:   88.2/100 (15% weight)
```

### 3. Backward Compatibility (DNA v1.0)

```javascript
// DNA v1.0: Uses legacy 4D weighted Euclidean distance
const dnaV1 = {
    l: 52.3,
    c: 18.7,
    k: 94.2,
    l_std_dev: 28.6
};

const archetype = ArchetypeLoader.matchArchetype(dnaV1);
// Automatically falls back to legacy matching
// 🎯 Matched archetype: Subtle Naturalist / Architectural (DNA v1.0, distance: 12.45)
```

---

## Integration Points

### Option A: Full Pipeline (DNA v2.0 Generation + Matching)

```javascript
const { DNAGenerator, ArchetypeLoader, ParameterGenerator } = require('@reveal/core');

// 1. Generate DNA v2.0
const generator = new DNAGenerator();
const dna = generator.generate(labPixels, width, height, { bitDepth: 8 });

// 2. Match to archetype
const archetype = ArchetypeLoader.matchArchetype(dna);

// 3. Generate processing parameters
const config = ParameterGenerator.generate(dna, {
    imageData: rgbaPixels,
    width,
    height
});

console.log(`Using archetype: ${archetype.name}`);
console.log(`Parameters: targetColors=${config.targetColors}, ditherType=${config.ditherType}`);
```

### Option B: Use Existing DNA Analyzer + Upgrade

If you already have `ImageHeuristicAnalyzer` generating DNA v1.0:

```javascript
const { ImageHeuristicAnalyzer, DNAGenerator, ArchetypeLoader } = require('@reveal/core');

// Existing v1.0 analysis
const analysisV1 = ImageHeuristicAnalyzer.analyze(labPixels, width, height);
// analysisV1.statistics contains { l, c, k, l_std_dev }

// Upgrade to v2.0 for better archetype matching
const generator = new DNAGenerator();
const dnaV2 = generator.generate(labPixels, width, height, { bitDepth: 8 });

// Use v2.0 for archetype matching
const archetype = ArchetypeLoader.matchArchetype(dnaV2);

// Use v2.0 for parameter generation
const config = ParameterGenerator.generate(dnaV2, { imageData: rgbaPixels, width, height });
```

### Option C: Manual Archetype Matching (Advanced)

```javascript
const { ArchetypeMapper, ArchetypeLoader } = require('@reveal/core');

const archetypes = ArchetypeLoader.loadArchetypes();
const mapper = new ArchetypeMapper(archetypes);

const result = mapper.getBestMatch(dna);
console.log(result);
// {
//   id: 'subtle_naturalist',
//   score: 87.5,
//   breakdown: {
//     structural: 92.3,
//     sectorAffinity: 85.1,
//     pattern: 88.2
//   }
// }

// Get archetype object
const archetype = archetypes.find(a => a.id === result.id);
```

---

## DNA v2.0 Structure Reference

### Global Metrics

| Field | Range | Description |
|-------|-------|-------------|
| `l` | 0-100 | Average lightness |
| `c` | 0-150 | Average chroma |
| `k` | 0-100 | Contrast (max - min lightness) |
| `l_std_dev` | 0-50 | Lightness standard deviation |
| `hue_entropy` | 0-1 | Color diversity (0=mono, 1=rainbow) |
| `temperature_bias` | -1 to +1 | Warm/cool balance (-1=cool, +1=warm) |
| `primary_sector_weight` | 0-1 | Weight of dominant 30° hue sector |

### 12 Hue Sectors (30° each)

`red`, `orange`, `yellow`, `chartreuse`, `green`, `cyan`, `azure`, `blue`, `purple`, `magenta`, `pink`, `rose`

Each sector contains:
- `weight`: Proportion of image pixels in this sector (0-1)
- `lMean`: Average lightness of pixels in this sector
- `cMean`: Average chroma of pixels in this sector
- `cMax`: Maximum chroma in this sector

---

## Scoring System

### 40% - Structural Match
Weighted Euclidean distance using archetype weights:
- L, C, K, l_std_dev weighted by `archetype.weights.{l,c,k,l_std_dev}`
- Exponential decay converts distance to similarity (0-100)

### 45% - Sector Affinity
Weighted voting by 12 sectors based on:
- Preferred sectors (e.g., blue_rescue prefers `['blue', 'cyan', 'azure']`)
- Chroma profile matching (achromatic/low/moderate/extreme)
- Tonal range matching (dark/mid/bright)
- Outlier detection (small weight + high chroma)

### 15% - Pattern Match
Signature detection:
- Hue entropy matching (monochrome vs rainbow)
- Temperature bias matching (warm vs cool)
- Primary sector weight matching (focused vs diverse)

---

## Archetype System

### Archetypes with Sector Preferences

| Archetype | Preferred Sectors | Use Case |
|-----------|------------------|----------|
| `blue_rescue` | blue, cyan, azure | Cool outliers in warm/neutral images |
| `warm_tonal_optimized` | yellow, orange, chartreuse | Landscape with yellow protection |
| `thermonuclear_yellow` | yellow | Extreme yellow dominance |
| `neon_graphic` | yellow, orange, red, magenta | Fluorescent flat art |
| `cinematic_moody` | blue, cyan, purple | Dark moody cinematics |
| `muted_vintage` | orange, chartreuse, rose | Faded WPA posters |

### Universal Archetypes (No Sector Preference)

- `subtle_naturalist` - Diverse photographic content
- `structural_outlier_rescue` - Monochromatic detail preservation
- `silver_gelatin` - Pure B&W
- `pastel_high_key` - Bright soft colors
- `noir_shadow` - High contrast dark
- `pure_graphic` - Flat vector art
- `vibrant_tonal` - High chroma spikes
- `soft_ethereal` - Mid-bright gradients
- `hard_commercial` - Commercial photography
- `bright_desaturated` - Washed-out high-key

---

## Migration Path

### Phase 1: Add DNA v2.0 Generation (Current)
✅ `DNAGenerator.js` created
✅ `ArchetypeMapper.js` created
✅ `ArchetypeLoader.js` updated with backward compatibility
✅ Archetypes updated with DNA v2.0 fields

### Phase 2: Integrate into Batch Processing
- Update `reveal-batch` to use DNAGenerator
- Add DNA v2.0 output to analysis logs
- Validate archetype assignments on test images

### Phase 3: Update Adobe Plugin
- Integrate DNAGenerator into `reveal-adobe`
- Show DNA v2.0 metrics in UI (optional)
- Test with real Photoshop documents

---

## Testing

### Run Unit Tests

```bash
cd packages/reveal-core
npm test -- archetype-mapper.test.js
```

### Test with Sample DNA

```javascript
const { ArchetypeMapper, ArchetypeLoader } = require('@reveal/core');

// Monochromatic blue image
const dna = {
    version: '2.0',
    global: {
        l: 40, c: 35, k: 80, l_std_dev: 22,
        hue_entropy: 0.25,  // Low (monochrome)
        temperature_bias: -0.6,  // Cool
        primary_sector_weight: 0.60
    },
    dominant_sector: 'blue',
    sectors: {
        blue: { weight: 0.60, lMean: 38, cMean: 42, cMax: 55 }
    }
};

const archetypes = ArchetypeLoader.loadArchetypes();
const mapper = new ArchetypeMapper(archetypes);
const result = mapper.getBestMatch(dna);

console.log(`Matched: ${result.id} (score: ${result.score})`);
// Expected: blue_rescue or structural_outlier_rescue
```

---

## Troubleshooting

### "Module not found: ArchetypeMapper"
Ensure `reveal-core` is rebuilt:
```bash
cd packages/reveal-core
npm run build
```

### "No archetypes loaded"
Check archetype directory exists:
```bash
ls packages/reveal-core/archetypes/*.json
```

### DNA v2.0 not detected
Ensure DNA object has:
- `version: '2.0'`
- `global` object with all 7 fields
- `sectors` object with 12 sectors

### Low scores across all archetypes
Check DNA values are in valid ranges:
- L: 0-100
- C: 0-150
- hue_entropy: 0-1
- temperature_bias: -1 to +1

---

## API Reference

See unit tests in `test/unit/archetype-mapper.test.js` for comprehensive examples.
