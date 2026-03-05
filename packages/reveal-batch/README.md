# @electrosaur-labs/batch

Command-line batch processing and benchmarking tool for Reveal color separations.

## Overview

This package is a **development and benchmarking tool**, not an end-user application. It processes PSD and image files through the @electrosaur-labs/core separation pipeline and outputs Lab-mode PSD files with separated layers.

## Requirements

- Node.js >= 18.17.0
- Input images (not included — bring your own)

## Image Datasets

The batch processor was developed against two benchmark datasets that are **not included in this repository** due to size (44 GB+):

- **CQ100** — 100 diverse screen print test images (CC BY 4.0)
- **SP100** — 100 fine art images from Met Museum, Rijksmuseum, Library of Congress (CC0)

The `data/` directory contains only small analysis result files. To run the benchmark scripts, you need to supply your own source images in `data/CQ100_v4/input/` or `data/SP100/input/`.

## Key Scripts

```bash
# Process a single PSD file
npm run posterize -- path/to/image.psd

# Process a single image (auto-detect format)
npm run reveal -- path/to/image.jpg

# Run CQ100 benchmark (requires dataset)
npm run process-cq100

# Analyze CQ100 results
npm run analyze-cq100

# Analyze SP100 results
npm run analyze-sp100
```

## Dependencies

- **@electrosaur-labs/core** — Pure JavaScript color separation engines
- **@electrosaur-labs/psd-reader** — PSD file reader for Lab documents
- **@electrosaur-labs/psd-writer** — PSD file writer with Lab layer support
- **ag-psd** — PSD file I/O
- **sharp** — Image format conversion and resizing
- **commander** — CLI framework
- **chalk** — Terminal output formatting

## License

Apache-2.0
