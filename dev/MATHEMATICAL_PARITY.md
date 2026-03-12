# Reveal Python Port: Mathematical Parity Guide (v1.0)

This document defines the "Truth" requirements for porting the `reveal-core` engine from JavaScript to Python. The JS implementation is the source of truth. Parity is defined as statistically equivalent output across the benchmark datasets (per-pixel deltaE < 0.5, identical palette sizes, identical mask topology).

Bit-perfect identity across languages is not realistic due to floating-point differences. The goal is perceptual equivalence — identical palettes and visually identical masks.

## 1. 16-bit Ingest & Color Space
Reveal treats 16-bit photographic data as an immutable signal. Any normalization or downsampling to 8-bit before the final output is a failure.

* **Ingest:** Use `tifffile` or `imageio` to read 16-bit TIFFs into `uint16` NumPy arrays.
* **Transform (RGB to Lab):** Must use the **CIE D50** illuminant to match Photoshop’s internal color engine.
* **Internal encoding:** The JS engine works in **16-bit integer Lab** (L: 0–32768, a/b: 0–32768 with 16384 = neutral). The Python port should match this encoding to stay close to the JS math. Using float64 throughout will produce different rounding behavior and diverge from the reference implementation.

## 2. DNA Analysis (7D Global Vector + 12-Sector Hue Breakdown)
The DNA fingerprint determines archetype selection and parameter generation.

* **Global vector:** 7 dimensions — L (mean lightness), C (mean chroma), K (black level), σL (lightness std dev), hue_entropy, temperature_bias, primary_sector_weight.
* **Hue Entropy:** Calculate using a 360-degree histogram partitioned into 12 sectors (30° each).
* **Temperature Bias:** Calculated as a weighted average of the $a^*$ (Red-Green) and $b^*$ (Yellow-Blue) channels.
* **Primary Sector Weight:** Identify the highest-density 30° sector. This is a critical trigger for archetypes like `golden_hour`.
* **Reference implementation:** `reveal-core/lib/analysis/DNAGenerator.js`

## 3. The Wu Quantization Core
The Wu quantization algorithm is the structural heart of Reveal. Python implementations must match the box-splitting logic of the JS source.

* **Moment Generation:** Compute 3D "moments" for L, a, and b. These are integral tables that allow O(1) calculation of variance for any given sub-box in Lab space.
* **Split Priority:** Always split the sub-box along the axis ($L$, $a$, or $b$) with the highest variance.
* **Reference implementation:** `reveal-core/lib/engines/LabMedianCut.js`

## 4. Dithering
Reveal supports multiple dithering strategies. The archetype JSON specifies which to use.

* **Atkinson** (default for many archetypes): Error propagated as **1/8** to 6 neighbors — preserves local contrast in textures.
    ```
    [x] [1/8] [1/8]
    [1/8] [1/8] [1/8]
    [0] [1/8] [0]
    ```
* **Floyd-Steinberg:** Classic 4-neighbor error diffusion (1/16 weights).
* **Stucki:** 12-neighbor, smoother gradients.
* **Bayer:** Ordered dither matrix, no error diffusion.
* **Constraint:** Error must be calculated and distributed in 16-bit space before the final mask thresholding to prevent "banding".
* **Reference implementation:** `reveal-core/lib/engines/DitheringStrategies.js`

## 5. Validation Benchmarks
Port completion is verified when the following datasets produce equivalent output (same palette sizes, per-pixel deltaE < 0.5, no mask topology differences):
1.  **CQ100:** Color Quantization accuracy check (300 images × 3 archetypes).
2.  **TESTIMAGES:** 40-image COLOR subset — edge-case handling.
3.  **SP100:** 147 fine art images — shadow point and highlight retention.

The JS implementation includes a batch processor (`reveal-batch`) and analysis tools (`analyze-batch.js`) that generate statistical reports. The Python port should produce comparable aggregate metrics (avg deltaE, integrity, color count distribution).