# Benchmark Data Directory Layout

Each dataset follows the same directory convention:

```
data/<DATASET>/
  input/
    <type>/{8|16}bit/       Raw source files (ppm, png, jpg, tiff)
    psd/{8|16}bit/          Converted Lab PSDs (via convert scripts)
  output/
    psd/{8|16}bit/          Posterized output PSDs + JSON sidecars
```

## Datasets

| Dataset | Source Format | Bit Depth | Images | Notes |
|---------|-------------|-----------|--------|-------|
| CQ100_v4 | PPM (8-bit RGB) | 8 | 100 | Color quantization benchmark, 768x512 |
| TESTIMAGES | PNG (16-bit RGB) | 16 | 40 | SAMPLING dataset, 2400x2400 |
| SP100 | JPEG/TIFF | 16 | ~150 | Museum fine art, 5 sources (met/rijks/aic/loc/minkler) |

## Workflow

1. **Download** source images into `input/<type>/{8|16}bit/`
2. **Convert** to Lab PSDs: `npm run convert:<dataset>`
3. **Benchmark** (posterize all): `npm run benchmark:<dataset>`
4. **Analyze** (aggregate stats): `npm run analyze:<dataset>`

## Output JSON Sidecars

Each posterized PSD gets a companion `.json` with:
- `archetype` — matched archetype id, name, score
- `palette` — Lab + RGB + hex for each ink, with coverage %
- `metrics` — avgDeltaE, revelationScore, edgeSurvival, integrity
- `dna` — image DNA v2.0 (global stats + 12 hue sectors)
- `configuration` — full engine parameters used

These sidecars serve as golden outputs for regression testing (see `test/fixtures/`).

## Test Fixtures

`../test/fixtures/` contains one representative image per archetype, named:

```
<archetype>-<dataset>-<image>.psd   Input PSD (for re-posterization)
<archetype>-<dataset>-<image>.json  Golden sidecar (expected palette)
```

CQ100 fixtures are at original size (768x512, 8-bit Lab).
TESTIMAGES fixtures are downscaled to 600x600 (16-bit Lab).

## .gitignore

The `data/` directory is not checked into git (large binary files).
Only `test/fixtures/` is committed — small enough for regression tests.
