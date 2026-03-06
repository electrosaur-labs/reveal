# Reveal

**Pure JavaScript color separation for screen printing**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Screen printing doesn't reproduce photographs — it *interprets* them. Reveal is built on the philosophy that **reduction is revelation**: stripping an image down to 5-8 spot colors forces you to find what matters in the image. The colors that survive are the ones that carry the meaning.

Reveal analyzes your image, selects a separation strategy from 26 built-in archetypes, and generates spot color layers ready for film output. It's not simulated process — there's no attempt at photorealism. Instead, it finds a palette that captures the essence of the image and commits to it.

The Photoshop plugin gives you real-time preview, palette editing, and one-click export to separated Lab layers with masks. The core engine is **100% pure JavaScript with zero external dependencies**, so it also runs in Node.js, browsers, and batch pipelines.

<table>
  <tr>
    <th align="center">Original</th>
    <th align="center">Separated (flat)</th>
    <th align="center">Separated (dithered)</th>
  </tr>
  <tr>
    <td><img src="docs/images/horse-original.jpg" width="280" alt="Original photo"></td>
    <td><img src="docs/images/horse-chameleon.png" width="280" alt="Chameleon flat separation"></td>
    <td><img src="docs/images/horse-chameleon-dithered.png" width="280" alt="Chameleon dithered separation"></td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/screenshot-navigator.jpg" width="600" alt="Reveal Navigator — Photoshop plugin">
  <br><em>Navigator panel in Photoshop — archetype carousel, radar HUD, palette surgery, mechanical knobs</em>
</p>

## Key Features

- **Lab median cut quantization** — Recursive partitioning in perceptual color space, not RGB
- **26 archetypes** — DNA analysis fingerprints each image and recommends separation parameters (Warm Sovereign, Punchy Commercial, Subtle Naturalist, Chiaroscuro, etc.)
- **Three distance metrics** — CIE76 (fast), CIE94 (perceptual), CIE2000 (museum-grade)
- **Dithering** — Floyd-Steinberg, Atkinson, blue noise, Bayer, with mesh-aware LPI scaling
- **Mechanical knobs** — Ghost screen removal (minVolume), dust removal (speckleRescue), shadow floor (shadowClamp), color trapping
- **Neutral sovereignty** — Automatically isolates white/gray backgrounds to preserve the chromatic color budget
- **8-bit and 16-bit Lab** — Full archival quality support
- **Photoshop plugin** — Real-time archetype exploration at 800px proxy, production render to Lab fill+mask layers

## Quick Start

```bash
npm install
npm run test:core    # 1,000+ tests
```

### Programmatic Usage (Node.js)

```javascript
const Reveal = require('@electrosaur-labs/core');

// 1. Analyze image DNA
const dna = Reveal.analyzeImage(labPixels, width, height, { bitDepth: 16 });

// 2. Generate configuration from DNA
const config = Reveal.generateConfiguration(dna);

// 3. Posterize — reduce to spot colors
const { labPalette, rgbPalette, statistics } = await Reveal.posterize(
    labPixels, width, height, config.targetColors, config
);

// 4. Separate — map every pixel to nearest palette color
const { colorIndices, masks } = await Reveal.separate(
    labPixels, labPalette, width, height, {
        distanceMetric: config.distanceMetric,
        ditherType: config.ditherType
    }
);
```

## Packages

| Package | Description |
|---------|-------------|
| **[@electrosaur-labs/core](packages/reveal-core/)** | Pure JS engines — posterization, separation, DNA analysis, archetypes. **Zero dependencies.** |
| **[@electrosaur-labs/navigator](packages/reveal-navigator/)** | Photoshop UXP panel — real-time archetype exploration, palette surgery, production render |
| **[@electrosaur-labs/adobe](packages/reveal-adobe/)** | Photoshop UXP command dialog (superseded by Navigator, kept for reference) |
| **[@electrosaur-labs/batch](packages/reveal-batch/)** | CLI batch processor for automated testing and benchmarking |
| **[@electrosaur-labs/psd-reader](packages/reveal-psd-reader/)** | Minimal PSD reader for Lab documents |
| **[@electrosaur-labs/psd-writer](packages/reveal-psd-writer/)** | PSD writer for 8/16-bit Lab with fill+mask and pixel layers |

## Architecture

```
@electrosaur-labs/core (Pure Math)          Zero dependencies, no I/O
     │
     ├── @electrosaur-labs/navigator        Photoshop UXP panel (real-time preview + production)
     ├── @electrosaur-labs/adobe            Photoshop UXP dialog (legacy)
     └── @electrosaur-labs/batch            Node.js CLI (ag-psd, sharp, commander)
```

The core engines are pure computation — no file system, no network, no Photoshop APIs. Adapters handle I/O for each platform. This means you can run the same separation algorithm in a Photoshop plugin, a Node.js batch pipeline, a web worker, or an AI agent's function call.

## Processing Pipeline

```
Lab pixels → DNA Analysis → Parameter Generation → Bilateral Filter
    → Median Cut Quantization → Pixel Separation → Mask Generation
    → [Photoshop: Lab fill+mask layers] or [CLI: PSD file output]
```

## Development

```bash
# Build all packages
npm run build

# Test core engines (Vitest)
npm run test:core

# Watch mode
cd packages/reveal-core && npm run test:watch

# Build Photoshop plugins
npm run build:navigator
npm run build:adobe

# Batch processing
cd packages/reveal-batch
npm run reveal              # Single image
npm run process-cq100       # Benchmark dataset
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding conventions, and PR workflow.

## License

[Apache License 2.0](LICENSE) — Copyright 2026 Electrosaur
