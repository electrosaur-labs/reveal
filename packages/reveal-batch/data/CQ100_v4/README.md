# CQ100 Dataset

100 high-quality images for color quantization research.

## Source

> M. Emre Celebi and Maria-Luisa Perez-Delgado, "CQ100: A High-Quality Image Dataset for Color Quantization Research,"
> *Journal of Electronic Imaging* 32(3), 033019 (7 June 2023).
> https://doi.org/10.1117/1.JEI.32.3.033019

**Download:** https://data.mendeley.com/datasets/vw5ys9hfxw/2

**License:** CC BY 4.0

## Acquisition

1. Download the CQ100 dataset from Mendeley Data (link above)
2. Place the PPM files in `input/ppm/`

## Preparation

The source images are 8-bit RGB PPM files. Reveal works with Lab PSD files, so they need conversion:

```
8-bit RGB PPM -> 8-bit Lab -> 16-bit Lab PSD
```

The `processCQ100.js` script handles this automatically — it reads PPM, converts to Lab in memory, writes a 16-bit Lab PSD to `input/psd/`, then continues with separation:

```bash
cd packages/reveal-batch
npm run process-cq100
```

The PPM parser is in `src/ppmParser.js`. RGB-to-Lab conversion uses standard sRGB linearization -> D65 XYZ -> CIE L*a*b* (see `LICENSE.md` for the full formula).

## Directory Structure

```
CQ100_v4/
  input/
    ppm/          # Source PPM files (not included, ~2 GB)
    psd/          # Converted 16-bit Lab PSDs (generated)
  output/
    psd/          # Separated multi-layer PSDs (generated)
  LICENSE.md      # Dataset license and conversion details
```
