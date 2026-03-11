# Development Guide

## Project Overview

Reveal is a **pure JavaScript color separation engine** for screen printing and print production. It reduces full-color images to 3-9 distinct colors using perceptually-accurate Lab color space quantization.

**Key Principle:** 100% pure JavaScript core with zero external dependencies, enabling reuse across Node.js, browsers, Photoshop UXP, and AI agents.

## Build and Test Commands

```bash
# Install all workspace dependencies
npm install

# Build all packages
npm run build

# Build only Adobe plugin (most common during development)
npm run build:adobe

# Build only Navigator plugin
npm run build:navigator

# Test core engines (Vitest)
npm run test:core

# Watch mode for core development
cd packages/reveal-core && npm run test:watch

# Build Adobe plugin in watch mode
cd packages/reveal-adobe && npm run watch

# Build Navigator plugin in watch mode
cd packages/reveal-navigator && npm run watch
```

### Package-Specific Commands

```bash
# reveal-batch (CLI batch processor)
cd packages/reveal-batch
npm run reveal              # Process single image
npm run analyze             # Analyze batch results
npm run process-cq100       # Process CQ100 benchmark dataset
npm run analyze-sp100       # Analyze SP100 dataset results

# reveal-core (pure JS engines)
cd packages/reveal-core
npm test                    # Run all tests
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report
```

## First Steps

Read this file and the README to understand the architecture. Then explore the package you're working on.

## Architecture

### Core + Adapter Pattern

The project uses strict separation of concerns:

```
reveal-core (Pure Math)        → 100% pure JS, NO dependencies, NO I/O
     ↓
reveal-adobe (UXP Adapter)     → Photoshop command dialog (full separation + layer creation)
reveal-navigator (UXP Panel)   → Real-time archetype navigation with 512px proxy preview
reveal-batch (CLI Adapter)     → Node.js batch processing + PSD I/O
```

**Design rationale:** Keep algorithms portable and testable. Core engines can run anywhere—Node.js, browsers, Photoshop, AI agents—without modification.

### Monorepo Structure

```
reveal/
├── packages/
│   ├── reveal-core/          # Pure JS engines (CRITICAL: no dependencies)
│   │   ├── lib/
│   │   │   ├── engines/       # PosterizationEngine, SeparationEngine, PreviewEngine
│   │   │   ├── color/         # Lab/RGB conversions, LabDistance metrics
│   │   │   ├── analysis/      # DNA analysis, ParameterGenerator
│   │   │   ├── preprocessing/ # BilateralFilter
│   │   │   ├── metrics/       # QualityMetrics, DensityScanner
│   │   │   └── validation/    # DocumentValidator
│   │   └── index.js           # Agent-optimized mid-level API
│   │
│   ├── reveal-adobe/          # Photoshop UXP plugin (command dialog)
│   │   ├── src/index.js       # Main plugin entry (~3000 lines)
│   │   ├── src/api/           # PhotoshopAPI wrapper
│   │   └── dist/              # Webpack-built bundle
│   │
│   ├── reveal-navigator/      # Photoshop UXP panel (real-time archetype navigation)
│   │   ├── src/index.js       # Panel entry point
│   │   ├── src/state/         # SessionState (ingest, proxy, archetype swap)
│   │   ├── src/bridge/        # PhotoshopBridge (pixel I/O)
│   │   └── src/components/    # ArchetypeCarousel, Preview, StatsPanel
│   │
│   ├── reveal-batch/          # CLI batch processor
│   │   ├── src/
│   │   │   ├── reveal-batch.js        # Main batch pipeline
│   │   │   ├── ImageProcessor.js      # Per-image processing
│   │   │   ├── MetricsCalculator.js   # Quality validation
│   │   │   └── SP100_MetaAnalyzer.js  # Dataset analysis
│   │   └── data/               # Test datasets (CQ100, SP100)
│   │
│   ├── reveal-psd-reader/     # PSD file reader (ag-psd wrapper)
│   └── reveal-psd-writer/     # PSD file writer with Lab support
│
├── DEVELOPMENT.md             # This file
└── CONTRIBUTING.md            # Contribution guidelines
```

## Key Algorithms and Code Locations

### 1. PosterizationEngine (`packages/reveal-core/lib/engines/PosterizationEngine.js`)

**Purpose:** Reduce image to 3-9 distinct colors using perceptually-accurate quantization

**Algorithm:** Lab Median Cut + Hue Gap Analysis + SALIENCY Centroid Strategy

**Key method:** `posterize(labPixels, width, height, colorCount, options)`

**Critical sections:**
- **TUNING object** (lines 41-58): Centralized parameters for split/prune/centroid strategies
- **Green Rescue** (lines 2561-2615): Protects minority green signals in 16-bit archival images
- **Centroid generation** (lines 1900-2100): SALIENCY strategy with vibrancy boost

**Flow:**
1. Recursively partition Lab color space along axis with highest variance
2. Generate representative color (centroid) for each partition using SALIENCY strategy
3. Apply hue gap analysis to detect missing colors
4. Prune similar colors (merge within ΔE threshold)

**When to modify:** Changing color quantization behavior, adjusting vibrancy boost, tuning black protection

### 2. SeparationEngine (`packages/reveal-core/lib/engines/SeparationEngine.js`)

**Purpose:** Map pixels to nearest palette colors with optional dithering

**Key method:** `mapPixelsToPaletteAsync(labPixels, labPalette, width, height, options)`

**Features:**
- Configurable distance metrics (CIE76, CIE94, CIE2000)
- Multiple dithering algorithms (Floyd-Steinberg, Atkinson, Bayer, Stucki)
- LPI-aware dithering (scales patterns based on mesh TPI)
- Spatial locality optimization (checks last winner first)

**When to modify:** Adding new distance metrics, implementing new dithering algorithms, optimizing performance

### 3. CentroidStrategies (`packages/reveal-core/lib/engines/CentroidStrategies.js`)

**Purpose:** Select representative color from median cut bucket

**SALIENCY Strategy:**
- Averages top 5% of pixels by perceptual importance
- **Black Protection:** Boosts very dark pixels (L<10) to snap to black
- **Brown-Dampener:** Penalizes low-chroma warm pixels in 8-bit images
- **Aggressive Vibrancy:** Multiplies a* by 1.6× to rescue reds from pink dilution
- **16-bit aware:** Different thresholds for archival vs consumer sources

**When to modify:** Tuning color selection behavior, adjusting vibrancy algorithms

### 4. ProxyEngine (`packages/reveal-core/lib/engines/ProxyEngine.js`)

**Purpose:** Fast 512px proxy posterization for real-time preview (used by Navigator plugin)

**Key methods:**
- `ingest(labPixels, width, height)` — Downsamples to 512px proxy, runs DNA analysis
- `rePosterize(archetypeId)` — Re-posterizes proxy with a different archetype (fast swap)

**Proxy-safe config overrides:** At 512px, PosterizationEngine's snap/prune/densityFloor thresholds (calibrated for full-res) collapse palettes to 1 color. ProxyEngine forces `snapThreshold:0, enablePaletteReduction:false, densityFloor:0`.

**When to modify:** Changing proxy preview behavior, adjusting proxy resolution, adding new real-time features

### 5. ImageHeuristicAnalyzer (`packages/reveal-core/lib/analysis/ImageHeuristicAnalyzer.js`)

**Purpose:** "DNA analysis" - detect artistic signatures and recommend parameters

**Key method:** `analyze(labPixels, width, height, options)`

**Output:** `{signature, presetId, statistics, archetype, timing}`

**Detects:**
- Halftone patterns (absolute blacks < 5% L)
- Vibrant graphics (high chroma pixels > 35 C)
- Photographic content (high variation + moderate chroma)
- Shadow tints (warm/cool hues in dark areas)

**When to modify:** Adding new archetype detection, tuning signature thresholds

### 5a. ArchetypeMapper (`packages/reveal-core/lib/analysis/ArchetypeMapper.js`)

**Purpose:** Match DNA signatures to archetype definitions using weighted scoring

**Scoring formula (40/45/15 split):**
- **40% Structural DNA:** L (lightness), C (chroma), K (blackness), L-StdDev (contrast)
- **45% Sector Affinity:** 12-sector hue weights and chroma distribution
- **15% Pattern/Signature:** Entropy and color temperature

**Archetypes:** Auto-discovered from `packages/reveal-core/archetypes/*.json` (excluding `schema.json`). Node.js uses `fs.readdirSync`; webpack/UXP uses `require.context()`. All JSON files in the directory participate in matching — add/remove archetypes by adding/removing files.

**Key design:** No override gates — all archetypes compete purely through the 40/45/15 scoring. Previous hard-coded priority gates (blue rescue, high-chroma) were removed as they caused systemic misassignment.

### 6. ParameterGenerator (`packages/reveal-core/lib/analysis/ParameterGenerator.js`)

**Purpose:** Expert system - maps DNA analysis to ALL tunable UI parameters

**Key method:** `generate(dna, options)`

**Maps DNA to:**
- Preprocessing settings (bilateral filter intensity)
- Distance metric selection (CIE76/CIE94/CIE2000)
- Centroid strategy and weights (lWeight, cWeight)
- Vibrancy mode and boost factors
- Dithering type and intensity
- Palette reduction thresholds

**When to modify:** Changing parameter selection logic, adding new archetypes

### 7. LabDistance (`packages/reveal-core/lib/color/LabDistance.js`)

**Purpose:** Centralized Lab color distance calculations

**Metrics:**
- **CIE76:** Fast Euclidean distance (good for posters/graphics)
- **CIE94:** Chroma-dependent weighting (better for saturated colors)
- **CIE2000:** Museum-grade with advanced hue handling (slow but accurate)

**16-bit support:** Native integer math for archival images

**When to modify:** Adding new distance metrics, optimizing performance

## Processing Pipeline

```
INPUT: Lab pixels (8-bit or 16-bit encoding)
  ↓
1. Validate Document (DocumentValidator)
   - Check Lab color mode, bit depth, layer count
  ↓
2. Analyze Image DNA (ImageHeuristicAnalyzer)
   - Fast step-sampled scan (~10ms)
   - Output: {signature, archetype, statistics}
  ↓
3. Generate Configuration (ParameterGenerator)
   - DNA → Full parameter mapping
   - Expert system selects all tuning parameters
  ↓
4. Preprocess Image (BilateralFilter, conditional)
   - Edge-preserving noise reduction
   - Only if entropy exceeds threshold
  ↓
5. Posterize Image (PosterizationEngine)
   - Median cut in Lab space
   - SALIENCY centroid selection
   - Hue gap analysis
   - Output: {labPalette, rgbPalette, statistics}
  ↓
6. Separate Image (SeparationEngine)
   - Map pixels to nearest palette color
   - Optional dithering (Floyd-Steinberg, Atkinson, etc.)
   - Output: Uint8Array of palette indices
  ↓
7. Generate Masks (SeparationEngine)
   - Binary mask per color (255 where match)
   - Output: Uint8ClampedArray per color
  ↓
8. Generate Preview (PreviewEngine)
   - Fast RGBA buffer for canvas (~10-20ms)
   - Uses squared Euclidean distance (fast)
  ↓
OUTPUT: Color palette + pixel indices + masks + preview

PHOTOSHOP PLUGIN ONLY:
  ↓
9. Create Layers (reveal-adobe/PhotoshopAPI)
   - Create background layer per color with mask
   - Apply colors and blending modes

CLI BATCH ONLY:
  ↓
9. Write PSD File (PSDWriter)
   - Lab-mode PSD with separated layers
   - Validate ink stack density
```

## Important Design Decisions

### 1. Pure JavaScript Core (NO External Dependencies)

**Why:** Maximize portability across environments
- Node.js batch processing
- Browser-based tools
- Photoshop UXP plugins
- AI agent function calling

**Constraint:** reveal-core must never import external packages. All math is inline or modular pure functions.

### 2. Lab Color Space (CIELAB)

**Why Lab, not RGB:**
- Lab is perceptually uniform—distances correlate with human color perception
- RGB Euclidean distance doesn't match human perception (e.g., blue shifts appear larger than green shifts)

**Encoding:**
- **8-bit:** L: 0-255 (→0-100), a: 0-255 (→-128 to +127), b: 0-255 (→-128 to +127)
- **16-bit:** L: 0-32768 (→0-100), a: 0-32768 (16384=neutral), b: 0-32768 (16384=neutral)

**Reference illuminant:** D65 (standard daylight)

### 3. Median Cut Algorithm

**Why Median Cut, not K-means:**
- K-means often produces grey centroids by averaging disparate colors
- Median cut preserves color distribution and eliminates banding
- Recursive partitioning along highest-variance axis maintains color purity

**Enhancement:** SALIENCY centroid strategy (not simple averaging)
- Top 5% of pixels by perceptual importance
- Black Protection: Dark pixels (L<10) get massive boost
- Brown-Dampener: 8-bit quantization noise in warm tones is penalized
- Aggressive Vibrancy: a* multiplied by 1.6× to rescue reds

### 4. DNA-Driven Parameter Selection

The system uses a 3-level perceptual rescue cascade — no manual tuning required:

**Level 1 - DNA:** ArchetypeMapper scores image against all archetypes (40/45/15 weighting). Winner drives all downstream parameters.
**Level 2 - Entropy:** Bilateral filter activates only when image entropy exceeds threshold (edge-preserving noise reduction).
**Level 3 - Complexity:** Distance metric auto-selected (CIE2000 for subtle naturalist, CIE94 for vibrant, CIE76 for graphics).

### 5. 16-bit Archival Support (Green Rescue)

**Problem:** Green foliage in archival scans gets averaged into dominant orange/yellow

**Solution:** Green Rescue feature (PosterizationEngine.js:2561-2615)
- Detects minority green signals (hue sectors 3-4, 90-150°)
- Activation: `16-bit AND greenEnergy > 1.5% AND not grayscale`
- Forces green-priority centroid in box with highest green content

**Why 16-bit only:** 8-bit images have higher quantization noise; green signals are less distinct

### 6. Configurable Distance Metrics

**Selection logic:**
- **CIE76:** Fast (posters, graphics, vector art)
- **CIE94:** Better for saturated colors and photographic content
- **CIE2000:** Museum-grade archival accuracy (slow but most perceptual)

**When to use:**
- `peakChroma > 80 OR isPhotographic → CIE94`
- `archivalImage AND 16-bit → CIE2000`
- Default: CIE76

## Mechanical Knobs (Separation Post-Processing)

Three user-facing parameters in the separation pipeline, applied per-layer after mask generation:

| Knob | Range | Purpose | Code Location |
|------|-------|---------|---------------|
| **minVolume** | 0-5% | Ghost plate removal — merges colors below coverage threshold into nearest strong neighbor | `SeparationEngine.pruneWeakColors()` |
| **speckleRescue** | 0-10px | Halftone solidity — morphological despeckle removes isolated pixel clusters below threshold | `SeparationEngine.generateSeparations()` → `_despeckleMask()` |
| **shadowClamp** | 0-20% | Ink body control — clamps barely-visible mask values to printable minimum density | `SeparationEngine.generateSeparations()` |

## Known Pitfalls

### UXP Plugin Constraints (reveal-adobe and reveal-navigator)

**componentSize 16 for Lab reads now works (2026-02-16):** Previously broken (returned neutral a/b), `componentSize: 16` with Lab colorspace is confirmed working. `reveal-navigator` uses native 16-bit reads. `reveal-adobe` still uses `componentSize: 8` with `lab8to16()` upconversion (pending upgrade).

**No ImageData API:** UXP does not support `new ImageData()`, `ctx.createImageData()`, or `ctx.putImageData()`. To render pixels in plugin UI, encode RGBA buffers to JPEG using `jpeg-js`, convert to base64 data URL, and set as `<img>.src`. For writing to Photoshop layers, use `imaging.createImageDataFromBuffer()` + `imaging.putPixels()`.

**No Canvas/SVG/CSS transforms for graphics:** UXP `<canvas>` is invisible in DOM, `ctx.fillText()` doesn't exist, `document.createElementNS()` silently fails, CSS `transform: rotate()` is ignored. The only proven rendering path for charts/graphics is: manual pixel rasterization → jpeg-js encode → base64 → `<img>.src`. Use `<span>` with absolute positioning for text labels.

### Distance Metric Scale Mismatch

When using spatial locality optimizations with distance thresholds (e.g., snap-to-last-winner), thresholds must be calibrated per metric. CIE76/CIE94 return squared distances in 16-bit range (0–3.2 billion), while CIE2000 returns perceptual dE² (0–10,000). A threshold tuned for CIE76 will cause CIE2000 to always snap to the first candidate, mapping every pixel to index 0. See `SeparationEngine._mapPixelsNearestNeighbor()` for the metric-aware implementation.

## Common Development Patterns

### Modifying Color Quantization Behavior

**File:** `packages/reveal-core/lib/engines/PosterizationEngine.js`

**Tuning parameters (lines 41-58):**
```javascript
const TUNING = {
    split: {
        cutStrategy: 'VARIANCE_BASED',  // or 'LONGEST_AXIS', 'VOLUME_BASED'
        minBoxSize: 2,
        contiguityWeight: 0.05
    },
    prune: {
        deltaEThreshold: 4.0,
        similarityMode: 'PERCEPTUAL'
    },
    centroid: {
        strategy: 'SALIENCY',           // or 'VOLUMETRIC', 'AVERAGE'
        topPercentile: 0.05,
        lWeight: 1.0,
        cWeight: 1.0
    }
};
```

**Common changes:**
- Increase `deltaEThreshold` to merge more similar colors
- Adjust `lWeight`/`cWeight` to prioritize lightness vs chroma
- Change `cutStrategy` for different partitioning behavior

### Adding a New Distance Metric

**File:** `packages/reveal-core/lib/color/LabDistance.js`

1. Add new metric function (e.g., `deltaE_Custom`)
2. Add inline variant for hot loops (e.g., `deltaE_Custom_inline`)
3. Update `SeparationEngine.js` to accept new metric name
4. Add tests in `packages/reveal-core/__tests__/LabDistance.test.js`

### Modifying Vibrancy Algorithms

**Files:**
- `packages/reveal-core/lib/engines/CentroidStrategies.js` (SALIENCY strategy)
- `packages/reveal-core/lib/engines/PosterizationEngine.js` (vibrancy application)

**Current algorithms:**
- **Aggressive Vibrancy:** Multiply a* by boost factor (e.g., 1.6×)
- **Exponential Vibrancy:** Transform chroma^(1/boost) to rescue muted colors

**When to modify:** Adjusting red/green rescue behavior, tuning color purity

### Testing Changes

**Unit tests (fast, no Photoshop required):**
```bash
cd packages/reveal-core
npm run test:watch  # Watch mode for rapid iteration
```

**Integration tests (requires test images):**
```bash
cd packages/reveal-batch
npm run process-8bit  # Test 8-bit pipeline
npm run analyze       # Validate quality metrics
```

**Photoshop plugin testing:**
```bash
cd packages/reveal-adobe
npm run build
# Then reload plugin in UXP Developer Tool
```

**Regression testing (SP100 dataset):**
```bash
cd packages/reveal-batch
npm run analyze-sp100  # Full batch validation
```


## Constraints

- **RGB mode only** in Photoshop input (spot color workflows, not CMYK)
- **8-bit or 16-bit per channel** (Lab color space)
- **Single layer input** (flatten before processing)
- **Maximum 10 distinct colors** per image
- **reveal-core must have ZERO external dependencies** (keep it portable)


## Quick Reference: Development Workflow

```bash
# Make changes to core engines
cd packages/reveal-core
npm run test:watch  # Run tests in watch mode

# Build Adobe plugin to test changes
cd ../reveal-adobe
npm run build

# Build Navigator plugin to test changes
cd ../reveal-navigator
npm run build

# Run batch validation (regression testing)
cd ../reveal-batch
npm run analyze-sp100

# Commit changes
git add .
git commit -m "feat(reveal-core): description"
```

## Key Files for Future Sessions

| Component | Location | Purpose |
|-----------|----------|---------|
| **Main API** | `packages/reveal-core/index.js` | Agent-optimized mid-level API |
| **Posterization** | `packages/reveal-core/lib/engines/PosterizationEngine.js` | Color quantization engine |
| **Separation** | `packages/reveal-core/lib/engines/SeparationEngine.js` | Pixel mapping and dithering |
| **Centroid Selection** | `packages/reveal-core/lib/engines/CentroidStrategies.js` | SALIENCY strategy |
| **DNA Analysis** | `packages/reveal-core/lib/analysis/ImageHeuristicAnalyzer.js` | Image signature detection |
| **Parameter Mapping** | `packages/reveal-core/lib/analysis/ParameterGenerator.js` | Expert system (DNA→Config) |
| **Distance Metrics** | `packages/reveal-core/lib/color/LabDistance.js` | CIE76/CIE94/CIE2000 |
| **Photoshop Plugin** | `packages/reveal-adobe/src/index.js` | UXP adapter and UI |
| **ProxyEngine** | `packages/reveal-core/lib/engines/ProxyEngine.js` | 512px proxy preview for Navigator |
| **Archetype Mapper** | `packages/reveal-core/lib/analysis/ArchetypeMapper.js` | 40/45/15 DNA scoring |
| **Archetype Defs** | `packages/reveal-core/archetypes/*.json` | Archetype centroids and weights |
| **Navigator Entry** | `packages/reveal-navigator/src/index.js` | UXP panel entry point |
| **Navigator State** | `packages/reveal-navigator/src/state/SessionState.js` | Ingest, proxy, archetype swap |
| **Navigator Bridge** | `packages/reveal-navigator/src/bridge/PhotoshopBridge.js` | Pixel I/O for navigator |
| **Batch Processor** | `packages/reveal-batch/src/reveal-batch.js` | CLI pipeline |
| **Per-Image Pipeline** | `packages/reveal-batch/src/posterize-psd.js` | Single-image processing (bilateral → posterize → separate) |
