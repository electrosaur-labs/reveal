# @electrosaur-labs/core

Pure JavaScript color separation engine for screen printing. Zero external dependencies.

## What It Does

Takes a full-color image and reduces it to 3-9 distinct spot colors for screen printing. All computation happens in Lab color space (CIELAB) for perceptually accurate results. This is reductive color separation, not simulated process — there's no attempt at photorealism.

The engine analyzes your image, fingerprints its visual characteristics (DNA), matches it to one of 26 built-in archetypes, and generates separation parameters automatically.

## Usage

```javascript
const Reveal = require('@electrosaur-labs/core');

// 1. Analyze image DNA (fast fingerprint — ~10ms)
const dna = Reveal.analyzeImage(labPixels, width, height);

// 2. Generate separation configuration from DNA
const config = Reveal.generateConfiguration(dna);

// 3. Posterize — find the color palette via median cut quantization
const result = await Reveal.posterizeImage(
    labPixels, width, height,
    config.targetColors, config
);

// 4. Separate — map every pixel to nearest palette color
const separation = await Reveal.separateImage(
    labPixels, result.labPalette, width, height,
    { distanceMetric: config.distanceMetric, ditherType: config.ditherType }
);

// 5. Generate per-color masks for each ink layer
for (let i = 0; i < result.labPalette.length; i++) {
    const mask = Reveal.generateMask(separation.colorIndices, i, width, height);
    // mask: Uint8ClampedArray — 255 where this color prints, 0 elsewhere
}
```

## API

### Pipeline Functions

| Function | Purpose |
|----------|---------|
| `analyzeImage(labPixels, w, h)` | DNA fingerprint — detects artistic signature (~10ms) |
| `generateConfiguration(dna)` | Maps DNA to full separation parameters via archetype matching |
| `posterizeImage(labPixels, w, h, colorCount, config)` | Median cut quantization — returns Lab + RGB palettes |
| `separateImage(labPixels, palette, w, h, opts)` | Maps each pixel to nearest palette color |
| `generateMask(colorIndices, colorIndex, w, h)` | Binary mask for one palette color |
| `generatePreview(labPixels, labPalette, rgbPalette)` | Fast RGBA preview buffer (~15ms) |
| `preprocessImage(imageData, w, h, config)` | Bilateral filter (edge-preserving noise reduction) |

### Configuration Variants

| Function | Strategy |
|----------|----------|
| `generateConfiguration(dna)` | Standard archetype-based (26 archetypes) |
| `generateConfigurationMk2(dna)` | Mk II interpolator (12 learned clusters, soft blending) |
| `generateConfigurationDistilled(dna)` | Over-quantize to 20 → reduce to 12 via furthest-point sampling |
| `generateConfigurationSalamander(dna)` | DNA-driven color count + no palette reduction |

### Utilities

| Function | Purpose |
|----------|---------|
| `rgbToLab(r, g, b)` | sRGB to CIELAB (D65 white point) |
| `labToRgb(L, a, b)` | CIELAB to sRGB with gamut mapping |
| `validateDocument(doc)` | Check color mode, bit depth, dimensions |
| `validateDNA(dna)` | Validate DNA v2.0 structure |

### Engine Access

For lower-level control, all engines are available via `Reveal.engines.*`:

- **PosterizationEngine** — Direct median cut with full parameter control
- **SeparationEngine** — Pixel mapping with configurable distance metrics
- **ProxyEngine** — 512px proxy pipeline for real-time preview
- **PreviewEngine** — RGBA buffer generation from Lab separation
- **LabDistance** — CIE76, CIE94, CIE2000 metrics
- **ArchetypeMapper** — DNA scoring against all 26 archetypes
- **DNAGenerator** — 7D feature vector extraction
- **ParameterGenerator** — Parameter synthesis with CONFIG_CATEGORIES
- **MechanicalKnobs** — Post-processing (ghost removal, despeckle, shadow clamp)
- **TrapEngine** — Color trapping for misregistration compensation
- **SuggestedColorAnalyzer** — K-Means++ detection of missing image colors
- **BilateralFilter** — Edge-preserving noise reduction
- **PaletteOps** — Palette manipulation (merge, prune, sort)

## Archetypes

26 built-in archetypes in `archetypes/*.json`, each a separation strategy tuned for a different image character:

| Group | Archetypes |
|-------|-----------|
| **Natural** | Everyday Photo, Fine Art Scan, Warm Photo, Painterly, Full Spectrum |
| **Soft** | Pastel, Soft Light, Faded Vintage, Bleached, Black & White |
| **Graphic** | Spot Color, Bold Poster, Commercial, Neon, Vivid Poster |
| **Dramatic** | Dark Portrait, Old Master, Film Noir, Cinematic, Golden Hour |
| **Vibrant** | Sunlit, Saturated Max, Vivid Photo, Hot Yellow |
| **Specialist** | Cool Recovery, Detail Recovery |

Plus 3 code-only pseudo-archetypes: **Chameleon** (DNA-interpolated), **Distilled** (over-quantize then reduce), **Salamander** (hybrid).

Each archetype defines a 7D centroid, dimension weights, preferred hue sectors, and engine parameters. The DNA matcher scores every archetype against the image and ranks them.

## Input Format

Lab pixel data: flat `Uint8ClampedArray` or `Uint16Array`, 3 values per pixel (L, a, b), row-major order.

| Encoding | L range | a/b range | Neutral a/b |
|----------|---------|-----------|-------------|
| **8-bit** | 0-255 → 0-100 | 0-255 → -128 to +127 | 128 |
| **16-bit** | 0-32768 → 0-100 | 0-32768 | 16384 |

## Constraints

- **Zero external dependencies** — runs in Node.js, browsers, Photoshop UXP, web workers
- **Lab color space** — all operations in CIELAB, not RGB
- **3-9 colors** typical output (up to 14 internally before pruning)
- **Single-layer input** — flatten composites before processing

## License

[Apache-2.0](../../LICENSE)
