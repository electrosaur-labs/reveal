# Reveal Web App

Browser-based color separation — no Photoshop required.

Drop an image, get multiple archetype separations side-by-side, pick the one you like, export as PSD, OpenRaster, or PNG.

## Quick Start

```bash
git clone https://github.com/electrosaur-labs/reveal.git
cd reveal
npm install --omit=dev
npm run server
```

Open **http://localhost:3700** in your browser.

To use a different port:

```bash
PORT=3000 npm run server
```

## Usage

1. **Drop an image** (PNG, TIFF, JPEG, or PSD) onto the drop zone, or click to browse
2. **Wait for cards** — the engine runs 3 automatic archetype passes (Auto, Chameleon, Distilled) and results appear progressively as each completes
3. **Compare** — use the archetype picker to run additional passes with any of the 25+ built-in archetypes
4. **Click a card** to see the full-size preview and palette
5. **Export** — choose PSD (Lab fill+mask layers), OpenRaster (.ora), or flat PNG

## Supported Input Formats

| Format | Notes |
|--------|-------|
| PNG | 8-bit RGB |
| JPEG | 8-bit RGB |
| TIFF | 8/16-bit RGB |
| PSD | 8/16-bit Lab (native, no conversion loss) |

## Output Formats

| Format | What you get |
|--------|-------------|
| **PSD** | Lab document with fill+mask layers — open in Photoshop, one layer per ink color |
| **OpenRaster** | .ora ZIP — opens in GIMP, Krita, and other open-source editors |
| **PNG** | Flat composite — quick preview, no layer data |

Exported files are saved to `output/` in the directory you ran `npm run server` from.

## Limitations (v1)

This is a viewing and export tool. It does not include:

- Palette surgery (merge, remove, add, recolor individual inks)
- Mechanical knobs (minVolume, speckleRescue, shadowClamp sliders)
- Loupe, radar HUD, or blink comparator
- Recipe recording

For full interactive control, use the [Photoshop Navigator plugin](../reveal-navigator/).
