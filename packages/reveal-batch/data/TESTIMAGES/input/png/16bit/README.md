# TESTIMAGES Source Images

Place 16-bit RGB PNG files here (40 images, 2400x2400).

Download the TESTIMAGES SAMPLING dataset (C00C00 variant), strip the `img_2400x2400_3x16bit_C00C00_RGB_` prefix, then run:

```
npm run convert:testimages
```

This converts PNG to 16-bit Lab PSD in `input/psd/16bit/`.
