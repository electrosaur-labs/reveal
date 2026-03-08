# reveal-cli

Command-line color separation tool for screen printing. Accepts PNG, TIFF, JPEG, or Lab PSD files and outputs posterized images, layered PSDs, OpenRaster files, plate masks, and JSON metadata.

## Installation

From the monorepo root:

```bash
npm install
```

Or standalone:

```bash
npm install @electrosaur-labs/reveal-cli
```

## Usage

```bash
reveal <input> [options]
```

### Basic separation

```bash
reveal photo.png -o output/
```

### Layered PSD output

```bash
reveal photo.png --psd -o output/
```

### All output formats

```bash
reveal photo.png --psd --ora --plates -o output/
```

### Compare adaptive archetypes

Runs chameleon, distilled, salamander, and the top-scoring archetype side by side:

```bash
reveal photo.png --compare -o output/
```

### Using a recipe

```bash
# Save settings to a recipe
reveal photo.png --psd --save-recipe settings.json -o output/

# Reuse settings (CLI flags override recipe values)
reveal another.png --recipe settings.json -o output/
```

### Explicit archetype

```bash
reveal photo.png -a cinematic -c 6 --psd -o output/
```

## Flags

| Flag | Description |
|------|-------------|
| `-o, --output <path>` | Output directory |
| `-a, --archetype <name>` | Archetype ID (default: auto-detect) |
| `-c, --colors <n>` | Target color count (2-10) |
| `--psd` | Produce layered PSD |
| `--ora` | Produce OpenRaster (.ora) file |
| `--plates` | Produce individual plate PNGs |
| `--trap <pixels>` | Trap width in pixels |
| `--min-volume <percent>` | Ghost plate threshold (0-5%) |
| `--speckle-rescue <pixels>` | Despeckle threshold (0-10px) |
| `--shadow-clamp <percent>` | Ink body clamp (0-20%) |
| `--compare` | Compare 3 adaptive + top-scoring archetype |
| `--recipe <path>` | Load settings from recipe JSON |
| `--save-recipe <path>` | Save effective settings to recipe JSON |
| `--list-archetypes` | Print available archetypes and exit |
| `--no-json` | Suppress JSON sidecar |
| `-q, --quiet` | Errors only |
| `-v, --verbose` | Detailed diagnostics |

## Output Formats

**Flat image** (default) — Posterized image as PNG or TIFF (matches input format). Always produced.

**PSD** (`--psd`) — Layered Photoshop file with fill+mask layers sorted by lightness. Includes composite thumbnail.

**OpenRaster** (`--ora`) — ZIP archive of colorized RGBA layer PNGs with `stack.xml`. Opens in GIMP, Krita, and other ORA-compatible editors.

**Plates** (`--plates`) — Individual grayscale PNGs per ink color (255 = ink, 0 = no ink). Named with plate number and hex color.

**JSON sidecar** (default, suppress with `--no-json`) — Metadata including palette (Lab, RGB, hex, coverage), archetype info, DNA analysis, and processing parameters.

## Recipe Schema

```json
{
  "archetype": "cinematic",
  "colors": 6,
  "trap": 2,
  "minVolume": 1.5,
  "speckleRescue": 3,
  "shadowClamp": 5,
  "outputs": ["psd", "ora", "plates"],
  "outputDir": "./output"
}
```

All fields are optional. CLI flags override recipe values.

## License

Apache-2.0
