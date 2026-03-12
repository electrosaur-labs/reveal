# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Pure JavaScript color separation engine for screen printing. Reduces full-color images to 3-10 spot colors via Lab color quantization. Monorepo with npm workspaces.

## Build & Test Commands

```bash
# From reveal/ root:
npm run build                    # Build all packages
npm run test:core                # Core engine tests (900+ tests, 57 files)
npm run test:cli                 # CLI tests (36 tests)
npm run test:navigator           # Navigator plugin tests
npm run build:navigator          # Build Photoshop Navigator panel
npm run build:adobe              # Build legacy Photoshop dialog
npm run package:navigator        # Create .ccx installer

# Watch modes:
cd packages/reveal-core && npm run test:watch
cd packages/reveal-navigator && npm run watch

# Coverage:
cd packages/reveal-core && npm run test:coverage

# CLI usage:
node packages/reveal-cli/bin/reveal.js <input> [options]
node packages/reveal-cli/bin/reveal.js --help
node packages/reveal-cli/bin/reveal.js --list-archetypes

# Batch processor:
cd packages/reveal-batch
npm run reveal                   # Process single image
npm run process-cq100            # Process CQ100 benchmark dataset
npm run analyze                  # Analyze batch results

# Web UI (reveal-app):
npm run server                    # Express server on port 3700 (from root)
PORT=3000 npm run server          # Override port via env var
```

Vitest workspace includes: reveal-core, reveal-navigator, reveal-psd-writer.

No linters, formatters, or CI/CD. Code style: 4-space indent, single quotes, `const` default. Conventional commits: `feat(core):`, `fix(navigator):`, `test(core):`, `docs:`.

## Hard Constraints

- **`reveal-core` has ZERO external dependencies.** All algorithms are pure JavaScript — portable across Node.js, browsers, Photoshop UXP, AI agents. If you need an external library, it goes in an adapter package.
- **All color math in CIELAB**, not RGB.
- **16-bit engine encoding is canonical:** L: 0–32768, a/b: 0–32768 (16384 = neutral). Conversions to 8-bit PSD or perceptual space only at system boundaries.
- **Do not run `npm install` from inside the devcontainer** — breaks Mac-native sharp/rollup binaries.

## Package Dependency Graph

```
reveal-core (ZERO deps, pure JS)
     │
     ├── reveal-navigator   (Photoshop UXP panel — webpack, jpeg-js, buffer)
     ├── reveal-adobe        (Legacy UXP dialog — superseded by navigator)
     ├── reveal-cli          (CLI tool — sharp, commander, utif2)
     ├── reveal-batch        (Benchmarking CLI — sharp, commander, chalk)
     └── reveal-app          (Standalone web UI — express, ws, sharp) [in progress]

reveal-psd-reader  (ZERO deps, pure JS — reads Lab PSDs)
reveal-psd-writer  (ZERO deps, pure JS — writes Lab PSDs with fill+mask layers)
```

## Data Flow Pipeline

```
Image (PNG/TIFF/JPEG/PSD)
  → ingest (Sharp → Lab 16-bit pixels)
  → DNAGenerator.generate() → 7D vector + 12-sector hue analysis
  → ArchetypeMapper.getBestMatch(dna) → matched archetype (40/45/15 scoring)
  → ParameterGenerator.generate() → RevealConfig with engineType
  → PosterizationEngine.posterize() → palette + assignments (engine dispatch by engineType)
  → SeparationEngine.mapPixelsToPaletteAsync() → colorIndices per pixel
  → MechanicalKnobs (minVolume → speckleRescue → shadowClamp)
  → generateMask() per color → binary masks
  → Output (PSD / ORA / plates / flat PNG)
```

## Core Architecture (reveal-core)

### Engine Dispatch

ONE field flows through the entire system: archetype `engine` → ParameterGenerator `engineType` → `PosterizationEngine.posterize()` switch:

| engineType | Algorithm |
|-----------|-----------|
| `reveal` | LabMedianCut + HueGapRecovery (default) |
| `reveal-mk1.5` | RevealMk15Engine (legacy) |
| `balanced` | LabMedianCut only |
| `distilled` | Over-quantize 3× + Furthest-Point Sampling |
| `stencil` | Luminance-only quantization |
| `classic` | RGB median cut (legacy) |

There is no `engineMode` — eliminated in engine unification.

### DNA v2.0 & Archetypes

**DNA:** 7D global vector (L, C, K, σL, entropy, temperature, sector_weight) + 12-sector hue breakdown.

**Archetypes:** 25 JSON files auto-discovered from `packages/reveal-core/archetypes/*.json`. Add/remove by adding/removing files. Grouped by `"group"` field (graphic, faithful, dramatic) for carousel filter chips.

**Three pseudo-archetypes** (code-only, no JSON): Chameleon (Mk2 interpolator), Distilled (furthest-point sampling), Salamander (DNA-driven color count).

**Matching:** ArchetypeMapper uses 40/45/15 weighted scoring (structural distance / sector affinity / pattern score). Alphabetical tiebreaker.

### Key Quantization Behaviors

- **Neutral Sovereignty:** >20% neutral pixels → 1 fixed neutral slot. Median cut runs on chromatic pixels only.
- **Color budget headroom:** Pruning eats ~2 colors. Over-request `targetColors` by ~2 (e.g., request 10 to get 8).
- **ROBUST_SALIENCY centroid strategy:** Chroma winsorization P90, black protection, achromatic exclusion for warm-dominant images.
- **ProxyEngine palette collapse prevention:** Overrides `snapThreshold:0, enablePaletteReduction:false, densityFloor:0` at 512px proxy resolution.

### MechanicalKnobs (Post-Separation)

Three knobs shared between ProxyEngine (preview) and ProductionWorker (commit):

| Knob | Range | Purpose |
|------|-------|---------|
| `minVolume` | 0–5% | Ghost plate removal — merges weak colors into nearest neighbor (sector-aware rescue) |
| `speckleRescue` | 0–10px | Morphological despeckle — removes isolated pixel clusters |
| `shadowClamp` | 0–20% | Minimum mask density — clamps barely-visible regions to printable floor |

### Key Source Files

| File | Size | Responsibility |
|------|------|---------------|
| `lib/engines/PosterizationEngine.js` | 55K | Engine dispatcher + tuning system |
| `lib/engines/LabMedianCut.js` | 60K | Recursive Lab space quantization |
| `lib/engines/SeparationEngine.js` | 36K | Pixel→palette mapping + dithering |
| `lib/engines/ProxyEngine.js` | 41K | 800px real-time preview engine |
| `lib/engines/PaletteOps.js` | 30K | Snap/prune/merge palette operations |
| `lib/engines/HueGapRecovery.js` | 18K | Missing hue sector injection |
| `lib/engines/MechanicalKnobs.js` | 15K | Post-separation mask adjustments |
| `lib/engines/DitheringStrategies.js` | 18K | Floyd-Steinberg, Bayer, Atkinson, Stucki |
| `lib/engines/CentroidStrategies.js` | 16K | SALIENCY, ROBUST_SALIENCY, VOLUMETRIC |
| `lib/color/LabEncoding.js` | 20K | 8-bit ↔ 16-bit ↔ perceptual Lab conversions |
| `lib/color/LabDistance.js` | 22K | CIE76/94/2000 in 16-bit integer space |
| `lib/analysis/DNAGenerator.js` | — | 7D vector + 12-sector hue analysis |
| `lib/analysis/ArchetypeMapper.js` | — | 40/45/15 scoring matcher |
| `lib/analysis/ParameterGenerator.js` | — | DNA → engine config mapping |

### Core API (index.js)

Mid-level API designed for function-calling:

```
analyzeImage(labPixels, w, h) → DNA
generateConfiguration(dna, options) → config
preprocessImage(imageData, w, h, config) → bilateral-filtered pixels
posterizeImage(labPixels, w, h, colorCount, params) → palette + assignments
separateImage(labPixels, palette, w, h, params) → colorIndices
generateMask(colorIndices, colorIndex, w, h) → binary mask
generatePreview(labPixels, labPalette, rgbPalette) → RGBA buffer
```

## Navigator Plugin (reveal-navigator)

Active Photoshop plugin. Built with Webpack 5 (externals: `photoshop`, `uxp`).

**Design principle — Preview = Production:** The 800px proxy preview MUST produce visually identical results to the full-res Commit output. ProxyEngine and ProductionWorker share identical MechanicalKnobs logic.

**Key files:**
- `src/index.js` — Plugin entry, UI wiring
- `src/bridge/PhotoshopBridge.js` — UXP pixel I/O (16-bit Lab reads)
- `src/bridge/ProductionWorker.js` — Full-res separation + layer creation
- `src/state/SessionState.js` — Reactive state machine
- `src/components/ArchetypeCarousel.js` — Two-phase progressive rendering (scores first, swatches async)
- `src/components/PaletteSurgeon.js` — Per-swatch color editing

**After modifying navigator code, always run `npm run build:navigator` before testing in Photoshop.**

## CLI (reveal-cli)

```bash
reveal input.png -a golden_hour -c 8 -f psd -f plates --min-volume 2
reveal input.tiff --recipe settings.json -o output/
reveal --list-archetypes
```

Key source: `src/cli.js` (command parser), `src/ingest.js` (Sharp → Lab), `src/pipeline.js` (engine wrappers), `src/output/` (PSD/ORA/plates writers).

## Web UI (reveal-app)

Standalone browser-based alternative to the Photoshop Navigator — no Photoshop required. Express + WebSocket server on port 3700, vanilla JS frontend.

**Status:** Code complete, server tested via curl. NOT browser-tested yet (see `electrosaur/session-states/reveal-app-2026-03-12.md`).

**Architecture:**
- `src/server.js` — Express server, multer file upload (`POST /ingest`), WebSocket broadcast, `POST /export`
- `src/app-pipeline.js` — Runs 3+1 archetype passes (Distilled, Chameleon, Salamander, Auto-detected) with progressive card delivery via WebSocket
- `src/ingest-adapter.js` — Multi-format image reader (copied from reveal-cli, intentional duplication)
- `src/export-adapter.js` — Full-res pixel mapping + PSD export to `output/`
- `public/` — Single-page vanilla HTML/JS/CSS with dark theme, card grid, drag-and-drop upload

**v1 scope boundaries (SCOPE.md):** No palette surgery, no mechanical knobs UI, no loupe/radar/blink comparator, no framework.

## PSD I/O (Pure JS, Zero Deps)

**Reader:** `readPsd(buffer) → {width, height, colorMode, depth, data}` — returns interleaved Lab (L,a,b,L,a,b,...). Supports 8-bit and 16-bit via Lr16 block.

**Writer:** `PSDWriter.write({width, height, layers, bitDepth}) → Buffer` — creates Lab PSDs with fill+mask and pixel layer types.

## Test Structure

```
packages/reveal-core/test/
├── unit/          # 44 files, 900+ tests
├── integration/   # 16 directories (end-to-end engine scenarios)
├── fixtures/      # 64×64 horse images (Lab/RGB × 8/16-bit × TIFF/PNG/PSD)
└── performance/   # Benchmark baselines (JSON)
```

## Developer Documentation

- `dev/DEVELOPMENT.md` — Comprehensive algorithm reference, architecture details, design decisions, known pitfalls
- `dev/SMOKE-TEST.md` — Photoshop plugin validation checklist (manual test matrix)
- `docs/ARCHETYPES.md` — Archetype definitions and scoring details
- `docs/USER-GUIDE.md` — Screen printer's walkthrough of the Photoshop plugin

## Lab Encoding Reference

| Space | L range | a/b range | Neutral a/b |
|-------|---------|-----------|-------------|
| 8-bit PSD | 0–255 | 0–255 | 128 |
| Engine 16-bit | 0–32768 | 0–32768 | 16384 |
| Perceptual | 0–100 | -128..+127 | 0 |
