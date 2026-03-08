# reveal-cli - Design

## Overview

A new monorepo package (`packages/reveal-cli/`) that wraps reveal-core's posterization pipeline with standard image I/O via sharp. The design reuses the proven pipeline from reveal-batch's `posterize-psd.js` but replaces PSD-only input with multi-format support and adds ORA/plate/flat output writers.

## System Architecture

```
packages/reveal-cli/
├── package.json
├── bin/
│   └── reveal.js              # Shebang entry point (#!/usr/bin/env node)
├── src/
│   ├── cli.js                 # Commander argument parsing, validation, dispatch
│   ├── pipeline.js            # Core processing pipeline (shared by single + compare)
│   ├── ingest.js              # Image input: sharp → Lab conversion, PSD passthrough
│   ├── output/
│   │   ├── flat.js            # Flat posterized image writer (PNG/TIFF via sharp)
│   │   ├── psd.js             # Layered PSD writer (reveal-psd-writer)
│   │   ├── ora.js             # OpenRaster writer (ZIP of PNGs + stack.xml)
│   │   ├── plates.js          # Individual mask PNGs (sharp)
│   │   └── sidecar.js         # JSON metadata writer
│   └── recipe.js              # Recipe file reader/writer
└── test/
    ├── unit/
    │   ├── ingest.test.js
    │   ├── ora.test.js
    │   └── recipe.test.js
    └── integration/
        └── cli.test.js        # End-to-end: real image → all outputs
```

### Component Diagram

```
┌─────────────────────────────────────────────────────┐
│  cli.js (Commander)                                  │
│  Parse args → validate → merge recipe → dispatch     │
└──────────┬──────────────────────────────┬────────────┘
           │ single mode                  │ --compare
           ▼                              ▼
┌──────────────────┐        ┌──────────────────────────┐
│  pipeline.js     │        │  pipeline.js × 4         │
│  (one archetype) │        │  (chameleon, distilled,   │
│                  │        │   salamander, top-match)  │
└──────────────────┘        └──────────────────────────┘
           │                              │
    ┌──────┼──────┐               ┌───────┼──────┐
    ▼      ▼      ▼               ▼       ▼      ▼
┌──────┐┌─────┐┌──────┐     (same outputs per subdir)
│ingest││core ││output│
│.js   ││pipe ││/*.js │
└──────┘└─────┘└──────┘
```

### Dependency Graph

```
reveal-cli
├── @electrosaur-labs/core        (posterization, DNA, knobs, trapping)
├── @electrosaur-labs/psd-reader  (Lab PSD input)
├── @electrosaur-labs/psd-writer  (layered PSD output)
├── sharp                         (image I/O: PNG/TIFF/JPEG ↔ Lab conversion)
└── commander                     (CLI argument parsing)
```

No other dependencies. The ORA writer uses Node.js built-in `zlib` for ZIP creation — no archiver/jszip needed.

## Data Flow

### Single Mode (default)

```
1. cli.js        → Parse arguments, load recipe if --recipe
2. ingest.js     → Read input file
                    ├─ PNG/TIFF/JPEG: sharp.toColourspace('lab') → raw Lab buffer
                    └─ PSD: reveal-psd-reader → Lab buffer directly
3. pipeline.js   → DNA analysis (DNAGenerator.fromPixels)
4. pipeline.js   → Archetype selection (auto or --archetype override)
5. pipeline.js   → ParameterGenerator.generate(dna, options)
6. pipeline.js   → BilateralFilter (if config says to preprocess)
7. pipeline.js   → MedianFilter (if salt detected)
8. pipeline.js   → posterizeImage() → palette + color indices
9. pipeline.js   → SeparationEngine.mapPixelsToPaletteAsync()
10. pipeline.js  → Palette pruning (minVolume)
11. pipeline.js  → MechanicalKnobs (speckleRescue, shadowClamp)
12. pipeline.js  → TrapEngine.applyTrapping() (if --trap)
13. output/*.js  → Write requested outputs:
                    ├─ flat.js:    Lab→RGB via sharp, write PNG/TIFF
                    ├─ psd.js:    reveal-psd-writer fill+mask layers
                    ├─ ora.js:    ZIP(mimetype + mergedimage.png + layers + stack.xml)
                    ├─ plates.js: per-color grayscale PNGs via sharp
                    └─ sidecar.js: JSON metadata
```

### Compare Mode (--compare)

```
1. cli.js        → Parse arguments, detect --compare
2. ingest.js     → Read input file once (shared across all archetypes)
3. pipeline.js   → DNA analysis once (shared)
4. pipeline.js   → Auto-detect top archetype (for the 4th output set)
5. FOR EACH archetype IN [chameleon, distilled, salamander, top-match]:
   a. pipeline.js → Generate config for this archetype
   b. pipeline.js → Full posterization pipeline (steps 5-12 from above)
   c. output/*.js → Write outputs into <base>_reveal/<archetype-name>/
6. cli.js        → Print comparison summary table
```

Key optimization: steps 1-3 run once. The Lab buffer and DNA are shared. Only the posterization and output writing are repeated per archetype.

## Interface Specifications

### CLI Arguments

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `<input>` | positional | required | Input image path |
| `--output, -o` | string | `<base>_reveal.<ext>` | Output path or directory |
| `--archetype, -a` | string | auto-detect | Archetype ID |
| `--colors, -c` | number | from archetype | Target color count (2-10) |
| `--psd` | boolean | false | Produce layered PSD |
| `--ora` | boolean | false | Produce OpenRaster file |
| `--plates` | boolean | false | Produce individual plate PNGs |
| `--trap` | number | 0 | Trap width in pixels |
| `--min-volume` | number | from archetype | Ghost plate threshold (0-5%) |
| `--speckle-rescue` | number | from archetype | Despeckle threshold (0-10px) |
| `--shadow-clamp` | number | from archetype | Ink body clamp (0-20%) |
| `--compare` | boolean | false | Run 3 adaptive + top match |
| `--recipe` | string | none | Load settings from JSON file |
| `--save-recipe` | string | none | Write effective settings to JSON |
| `--list-archetypes` | boolean | false | Print archetypes and exit |
| `--no-json` | boolean | false | Suppress JSON sidecar |
| `--quiet, -q` | boolean | false | Errors only |
| `--verbose, -v` | boolean | false | Detailed diagnostics |

### Recipe File Schema

```json
{
  "archetype": "dramatic_ink",
  "colors": 7,
  "trap": 2,
  "minVolume": 1.5,
  "speckleRescue": 3,
  "shadowClamp": 5,
  "outputs": ["flat", "psd", "ora", "plates"],
  "outputDir": "./separated"
}
```

All fields optional. CLI flags override recipe values.

### ORA File Structure

```
output.ora (ZIP)
├── mimetype                    # "image/openraster" (uncompressed, first entry)
├── mergedimage.png             # Flat composite (RGB)
├── data/
│   ├── layer00_ink1_FFAA33.png # RGBA: palette color where ink, transparent elsewhere
│   ├── layer01_ink2_335599.png
│   └── ...
└── stack.xml                   # Layer ordering and names
```

`stack.xml` format:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.3" w="WIDTH" h="HEIGHT">
  <stack>
    <layer name="Ink 1 (#FFAA33)" src="data/layer00_ink1_FFAA33.png"
           x="0" y="0" opacity="1.0" visibility="visible" />
    ...
  </stack>
</image>
```

## Technical Decisions

### 1. Sharp for RGB↔Lab Conversion

**Choice:** Use sharp's `toColourspace('lab')` for input conversion and `toColourspace('srgb')` for flat output.

**Rationale:** sharp/libvips has battle-tested color management with ICC profile support built in. Avoids reimplementing color space math. Already a dependency in reveal-batch.

**Alternatives considered:**
- Manual conversion using reveal-core's LabEncoding: would work but no ICC profile handling, less accurate for non-sRGB inputs.
- lcms2 bindings: too heavy for this use case.

### 2. Node.js zlib for ORA (no archiver dependency)

**Choice:** Hand-roll the ZIP file using Node.js built-in `zlib.deflateRawSync()` and manual ZIP local/central directory headers.

**Rationale:** ORA is a simple ZIP with ~10 entries. A full ZIP library (archiver, jszip) is overkill and adds a dependency. The ZIP format for ORA is well-specified: mimetype must be first entry, stored uncompressed. Manual construction gives us precise control over these requirements.

**Alternatives considered:**
- archiver: adds dependency, async API more complex than needed
- jszip: adds dependency, but simpler API — acceptable fallback if hand-rolled ZIP proves buggy

### 3. Pipeline as Pure Function

**Choice:** `pipeline.js` exports a function `processSingle(labBuffer, width, height, config)` that returns `{ palette, masks, colorIndices, dna, metrics }`. Output writing is separate.

**Rationale:** Separating computation from I/O enables: (a) compare mode running pipeline 4x with different configs, (b) easy unit testing of the pipeline without filesystem, (c) future batch mode reuse.

**Alternatives considered:**
- Monolithic function (like current posterize-psd.js): works but harder to test and extend.

### 4. Ingest Returns Normalized 16-bit Lab

**Choice:** `ingest.js` always returns `{ lab16bit, width, height, bitDepth: 16 }` regardless of input format.

**Rationale:** Standardizes the pipeline entry point. reveal-core works on 16-bit Lab internally. Sharp can deliver Lab pixel data which we then normalize to the engine's 16-bit encoding (L: 0-32768, a/b: 0-32768, 16384=neutral).

**Alternatives considered:**
- Pass through 8-bit for 8-bit inputs: adds conditional paths throughout pipeline for minimal memory savings.

### 5. Flat Image Reconstruction via Sharp

**Choice:** Reconstruct flat posterized image by writing Lab pixel buffer → sharp → RGB output file.

**Rationale:** Sharp handles the Lab→RGB conversion, ICC profile embedding, and format encoding (PNG/TIFF compression) in one step.

**Alternatives considered:**
- Pixel-by-pixel Lab→RGB in JS then write raw: works but loses ICC profile embedding and format-specific optimizations.

## Error Handling

| Scenario | Detection | Response |
|----------|-----------|----------|
| Input file not found | `fs.existsSync` before processing | Exit 1, message: "File not found: <path>" |
| Unsupported format | Extension check + sharp metadata probe | Exit 1, message: "Unsupported format. Supported: PNG, TIFF, JPEG, PSD" |
| Invalid archetype name | Check against ArchetypeLoader.list() | Exit 1, message: "Unknown archetype '<name>'. Available:" + list |
| Colors out of range | Numeric bounds check in cli.js | Exit 1, message: "Colors must be 2-10" |
| --compare + --archetype | Mutual exclusion check in cli.js | Exit 1, message: "Cannot use --compare with --archetype" |
| Invalid recipe JSON | JSON.parse in try/catch | Exit 1, message: "Invalid recipe file: <parse error>" |
| Sharp processing error | try/catch around sharp operations | Exit 1, message: "Image processing error: <detail>" |
| Output directory creation fails | try/catch around mkdirSync | Exit 1, message: "Cannot create output directory: <path>" |
| Out of memory on large image | Process uncaughtException handler | Exit 1, message: "Image too large for available memory" |

## Testing Approach

### Unit Tests

- **ingest.test.js:** Test format detection, Lab conversion accuracy (compare known RGB values to expected Lab), ICC profile handling, PSD passthrough, error cases (missing file, bad format).
- **ora.test.js:** Test ORA ZIP structure (mimetype first, uncompressed; stack.xml valid; layer PNGs present and correct dimensions; RGBA colorization). Read back with standard unzip to verify.
- **recipe.test.js:** Test recipe loading, merging with CLI args (CLI wins), save-recipe output, validation errors.
- **pipeline.test.js:** Test with small synthetic Lab buffers — verify palette extraction, mask generation, knob application.

### Integration Tests

- **cli.test.js:** End-to-end tests using `child_process.execSync`:
  - `reveal photo.png` → produces `photo_reveal.png` + `photo_reveal.json`
  - `reveal photo.png --psd --ora --plates` → produces all 4 output formats
  - `reveal photo.png --compare` → produces 4 subdirectories
  - `reveal photo.png --archetype chameleon --colors 6` → override test
  - `reveal photo.png --recipe recipe.json` → recipe-driven test
  - `reveal --list-archetypes` → prints archetype list, exits 0
  - `reveal nonexistent.png` → exits 1 with error
  - `reveal photo.png --compare --archetype foo` → exits 1 (mutual exclusion)

### Test Images

Use the existing synthetic gradient images in `reveal-batch/data/synthetic/` for integration tests. These are small, deterministic, and already validated.

### Smoke Test

A single shell command that exercises the happy path:
```bash
node bin/reveal.js test/fixtures/sample.png --psd --ora --plates --verbose
```
Verifiable: all output files exist, JSON sidecar has valid structure, PSD opens in GIMP, ORA opens in GIMP.
