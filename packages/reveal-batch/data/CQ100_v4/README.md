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
2. Place the PPM files in `input/ppm/8bit/`

## Preparation

Convert source PPMs to 8-bit Lab PSDs:

```bash
npm run convert:cq100
```

This writes 8-bit Lab PSDs to `input/psd/8bit/`.

## Directory Structure

```
CQ100_v4/
  input/
    ppm/8bit/     # Source PPM files (not included, ~2 GB)
    psd/8bit/     # Converted 8-bit Lab PSDs (generated, 100 files)
  output/
    psd/8bit/     # Posterized PSDs + JSON sidecars (generated)
  LICENSE.md      # Dataset license and conversion details
```
