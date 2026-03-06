# CQ100_v4 Dataset License

## Source Dataset: CQ100

The source images in this directory are derived from the **CQ100** dataset, a high-quality image dataset for color quantization research.

### Original Dataset Citation

> M. Emre Celebi and María-Luisa Pérez-Delgado, "cq100: a high-quality image dataset for color quantization research," *Journal of Electronic Imaging* 32(3), 033019 (7 June 2023).
> https://doi.org/10.1117/1.JEI.32.3.033019

### Dataset Repository

The original CQ100 dataset is available at:
https://data.mendeley.com/datasets/vw5ys9hfxw/2

### License

**CC BY 4.0** (Creative Commons Attribution 4.0 International)
http://creativecommons.org/licenses/by/4.0

You can share, copy and modify this dataset so long as you give appropriate credit, provide a link to the CC BY license, and indicate if changes were made.

### Individual Image Licenses

The CQ100 dataset contains images under various permissive licenses:
- Some images are in the **public domain**
- Some images are licensed under **CC0** (Public Domain Dedication)
- Some images are licensed under **CC BY-SA** (Creative Commons Attribution-ShareAlike)

Refer to the original dataset documentation for per-image license details.

## Derived Works (PSD Files)

The 16-bit Lab PSD files in this repository are derived works created by converting the original CQ100 PPM files to Adobe Photoshop format using:

1. **sRGB to CIELAB Conversion** - Standard CIE 1976 L*a*b* color space conversion:
   - sRGB gamma decoding (inverse gamma correction)
   - Linear RGB to XYZ using sRGB color space matrix (D65 illuminant)
   - XYZ to CIELAB using D65 reference white point

2. **PSD Encoding** - 16-bit Lab PSD format with RLE compression

These derived PSD files inherit the licenses of their source images and are additionally released under **CC BY 4.0**, consistent with the original dataset license.

### RGB to Lab Conversion Formula

The conversion uses the standard CIE 1976 L*a*b* formulas with D65 illuminant:

```
Step 1: sRGB [0-255] -> sRGB [0-1]
  R' = R / 255, G' = G / 255, B' = B / 255

Step 2: sRGB -> Linear RGB (inverse gamma)
  If c > 0.04045: c_linear = ((c + 0.055) / 1.055)^2.4
  Else: c_linear = c / 12.92

Step 3: Linear RGB -> XYZ (sRGB/D65 matrix)
  X = 0.4124564*R + 0.3575761*G + 0.1804375*B
  Y = 0.2126729*R + 0.7151522*G + 0.0721750*B
  Z = 0.0193339*R + 0.1191920*G + 0.9503041*B

Step 4: Normalize to D65 white point
  X_n = X / 0.95047
  Y_n = Y / 1.00000
  Z_n = Z / 1.08883

Step 5: XYZ -> L*a*b*
  f(t) = t^(1/3)           if t > 0.008856
       = (903.3*t + 16)/116  otherwise

  L* = 116 * f(Y_n) - 16
  a* = 500 * (f(X_n) - f(Y_n))
  b* = 200 * (f(Y_n) - f(Z_n))
```

References:
- [CIELAB color space - Wikipedia](https://en.wikipedia.org/wiki/CIELAB_color_space)
- [Bruce Lindbloom's Color Space Conversions](http://brucelindbloom.com)

## Attribution

When using this dataset, please cite:

1. The original CQ100 dataset (Celebi & Pérez-Delgado, 2023)
2. This derived dataset repository (optional but appreciated)
