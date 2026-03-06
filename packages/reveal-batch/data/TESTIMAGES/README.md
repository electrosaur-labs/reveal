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
2. Place them in `download/SAMPLING/16BIT/RGB/2400x2400/C00C00/`

The filenames follow the pattern: `img_2400x2400_3x16bit_C00C00_RGB_<name>.png`

## Preparation

The source images are 16-bit RGB PNGs. Reveal works with Lab PSD files:

```
16-bit RGB PNG -> 16-bit Lab PSD
```

Convert using the batch converter:

```bash
cd packages/reveal-batch/data/TESTIMAGES
node batch-convert-all.js
```

This uses a LUT-accelerated sRGB-to-Lab converter and writes 16-bit Lab PSDs via `@electrosaur-labs/psd-writer` to `input/psd/16bit/`.

A smaller subset of 15 selected images can be converted with `convert-to-psd.js` (see `selected-images.json` for the selection criteria: high entropy, low chroma, landscapes).

## Directory Structure

```
TESTIMAGES/
  download/                    # Raw downloads (not included, ~1.5 GB)
    SAMPLING/16BIT/RGB/2400x2400/C00C00/
  input/
    psd/16bit/                 # Converted 16-bit Lab PSDs (generated, 40 files)
  output/                      # Separation results (generated)
  selected-images.json         # Curated subset by image characteristics
  batch-convert-all.js         # Full 40-image converter
  convert-to-psd.js            # 15-image subset converter
  batch-posterize-all.js       # Run separation on all converted PSDs
  audit-testimages.js          # Audit separation quality
  analyze-testimages.js        # Analyze results and generate CSV
  testimages_analysis.json     # Latest analysis results
  testimages_summary.csv       # Latest summary spreadsheet
```

## Images (40)

almonds, apples, baloons, bananas, billiard_balls_a, billiard_balls_b, building, cards_a, cards_b, carrots, chairs, clips, coins, cushions, ducks, fence, flowers, garden_table, guitar_bridge, guitar_fret, guitar_head, keyboard_a, keyboard_b, lion, multimeter, pencils_a, pencils_b, pillar, plastic, roof, scarf, screws, snails, socks, sweets, tomatoes_a, tomatoes_b, tools_a, tools_b, wood_game
