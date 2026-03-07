# TESTIMAGES (SAMPLING subset)

40 high-dynamic-range reference images for image processing algorithm testing.

## Source

> Nicola Asuni and Andrea Giachetti, "TESTIMAGES: A Large Data Archive For Display and Algorithm Testing,"
> *Journal of Graphics Tools*, Volume 17, Issue 4, 2015, pages 113-125.
> DOI: 10.1080/2165347X.2015.1024298

**Website:** https://testimages.org/sampling/

**Download:** https://sourceforge.net/projects/testimages/files/SAMPLING/16BIT/RGB/2400x2400/C00C00/

**License:** CC BY-NC-SA 4.0 (Nicola Asuni)

## Acquisition

1. Download the 16-bit RGB PNGs from SourceForge (link above)
2. Strip the `img_2400x2400_3x16bit_C00C00_RGB_` prefix from filenames
3. Place them in `input/png/16bit/`

## Preparation

Convert source PNGs to 16-bit Lab PSDs:

```bash
npm run convert:testimages
```

This writes 16-bit Lab PSDs to `input/psd/16bit/`.

## Directory Structure

```
TESTIMAGES/
  input/
    png/16bit/                 # Source 16-bit RGB PNGs (not included, ~1 GB)
    psd/16bit/                 # Converted 16-bit Lab PSDs (generated, 40 files)
  output/
    psd/16bit/                 # Posterized PSDs + JSON sidecars (generated)
```

## Images (40)

almonds, apples, baloons, bananas, billiard_balls_a, billiard_balls_b, building, cards_a, cards_b, carrots, chairs, clips, coins, cushions, ducks, fence, flowers, garden_table, guitar_bridge, guitar_fret, guitar_head, keyboard_a, keyboard_b, lion, multimeter, pencils_a, pencils_b, pillar, plastic, roof, scarf, screws, snails, socks, sweets, tomatoes_a, tomatoes_b, tools_a, tools_b, wood_game
