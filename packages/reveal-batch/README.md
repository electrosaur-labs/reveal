# reveal-batch

Command-line batch processing tool for screen print color separation using @electrosaur-labs/core.

## Features

- ✅ Batch process multiple images
- ✅ Auto-detect optimal color count
- ✅ Use presets or custom parameters
- ✅ Generate previews and separation masks
- ✅ Pure JavaScript processing (no Photoshop required)
- ✅ Uses Sharp for fast image I/O

## Installation

```bash
cd packages/reveal-batch
npm install
```

## Usage

### Process a Single Image

```bash
npm start -- process image.jpg --colors 5 --preview --masks
```

### Process a Directory

```bash
npm start -- process ./images/ --output ./output --colors 7
```

### Auto-Detect Parameters

```bash
npm start -- process image.jpg --analyze --preview --masks
```

### Analyze an Image

```bash
npm start -- analyze image.jpg
```

## Commands

### `process <input>`

Process image(s) for color separation.

**Arguments:**
- `<input>` - Input image file or directory

**Options:**
- `-o, --output <dir>` - Output directory (default: `./output`)
- `-c, --colors <number>` - Number of colors 3-9 (default: `5`)
- `-p, --preset <name>` - Preset name (halftone-portrait, vibrant-graphic, etc.)
- `--analyze` - Auto-detect optimal color count
- `--preview` - Generate preview images
- `--masks` - Generate separation masks
- `--width <number>` - Max width for processing (default: `800`)
- `--height <number>` - Max height for processing (default: `800`)

**Examples:**

```bash
# Basic posterization
npm start -- process image.jpg --colors 5

# With preview
npm start -- process image.jpg --colors 7 --preview

# Full separation with masks
npm start -- process image.jpg --colors 5 --preview --masks

# Auto-detect with preset
npm start -- process image.jpg --analyze --preset halftone-portrait

# Batch process directory
npm start -- process ./photos/ --output ./separated --colors 6 --preview
```

### `analyze <input>`

Analyze an image and recommend parameters.

**Arguments:**
- `<input>` - Input image file

**Example:**

```bash
npm start -- analyze image.jpg
```

**Output:**
```
🔍 Image Analysis

Image Information:
  Dimensions: 4032×3024
  File size: 8.45 MB

Color Analysis:
  Detected signature: Vibrant Graphic
  Recommended preset: vibrant-graphic
  Suggested colors: 7

Statistics:
  Max chroma: 82.3
  Dark pixels: 12.5%
  High chroma: 45.2%
```

## Output Files

When processing with `--preview --masks`, the following files are generated:

```
output/
├── image-preview.png           # Posterized preview
├── image-palette.json          # Color palette info
├── image-mask-1-ff0000.png    # Separation mask for color 1 (red)
├── image-mask-2-00ff00.png    # Separation mask for color 2 (green)
└── ...
```

### Palette JSON Format

```json
{
  "colors": [
    {
      "index": 0,
      "rgb": { "r": 255, "g": 0, "b": 0 },
      "lab": { "L": 53.24, "a": 80.09, "b": 67.20 },
      "hex": "#ff0000"
    }
  ],
  "statistics": {
    "substrate": { "L": 95.0, "a": 0, "b": 0 }
  },
  "processingTime": 1234
}
```

## Available Presets

- `halftone-portrait` - For halftone portraits with skin tones
- `vibrant-graphic` - For high-saturation graphics
- `deep-shadow-noir` - For dark, moody images
- `pastel-high-key` - For light, pastel images
- `standard-image` - General purpose default

## Dependencies

- **@electrosaur-labs/core** - Pure JavaScript color separation engines
- **sharp** - High-performance image processing
- **commander** - CLI framework
- **chalk** - Terminal colors

## Architecture

```
reveal-batch/
├── src/
│   ├── cli.js                      # Command-line interface
│   ├── ImageProcessor.js           # Image I/O and workflow
│   ├── processCQ100.js             # CQ100 benchmark processor
│   ├── DynamicConfigurator.js      # DNA-based parameter generation
│   ├── MetricsCalculator.js        # Quality metrics with integrity scoring
│   ├── CQ100_MetaAnalyzer.js       # Batch results analysis
│   ├── CQ100_Profiler.js           # Image DNA profiling
│   ├── Revalidate.js               # Integrity recalculation tool
│   └── index.js                   # Main entry point
├── package.json
└── README.md
```

## CQ100 Benchmark System

The CQ100 benchmark processes 100 diverse images to validate color separation quality across different image types.

### Key Features

**🧬 DNA-Based Configuration**
- Analyzes each image's "DNA" (avg L, C, K, maxC, range)
- Dynamically generates bespoke parameters per image
- No manual presets required

**🚑 Saliency Rescue**
- Detects "hidden color spikes" (low avg chroma, high max chroma)
- Forces maximum palette (12 colors) to preserve salient features
- Example: Grey astronaut with bright red flag

**🛡️ Texture Rescue**
- Detects extreme contrast (K > 28) causing "scum dots"
- Applies noise suppression with heavy black bias
- Example: Marrakech museum with fine textures

**📊 Quality Metrics**
- **Integrity Score (0-100)**: Printability assessment with 12% tolerance
- **Revelation Score (0-100)**: Visual quality assessment
- **Global Fidelity**: Average ΔE (CIE76 color difference)

### Running CQ100 Benchmark

```bash
# Process all 100 images with dynamic configuration
npm run process-cq100

# Analyze results
npm run analyze-cq100

# Recalculate integrity scores
npm run revalidate
```

### CQ100 Results (Current)

**Global Metrics:**
- Avg ΔE: 16.53
- Avg Revelation: 32.3
- Avg Integrity: 93.8
- Processing: ~1.4s per image

**Color Distribution:**
- 51% of images use 12-13 colors (optimal sweet spot)
- 26% use 12 colors (maximum palette)
- 3% triggered Saliency Rescue

**Passing Rate:** 92% of images achieve Integrity > 60 (print-ready)

### DynamicConfigurator Logic

The system uses 7 heuristic rules:

1. **Complexity Scaling**: High contrast + high chroma → more colors
2. **Saliency Rescue**: Hidden color spikes → force 12 colors (avgC < 12, maxC > 50)
3. **Texture Rescue**: Extreme contrast → noise suppression (K > 28)
4. **Vintage Optimization**: Flat images → fewer colors (K < 10, C < 10)
5. **Rich Images**: High chroma + contrast → ensure 12 colors
6. **Dynamic Black Bias**: Protect blacks in noir, relax in high-key
7. **Saturation Boost**: Boost dull images, clamp neon images

### Integrity Scoring (Extended Tolerance)

Three-zone scoring model based on screen printing reality:

- **Safe Zone (0-0.5%)**: Score 100 (microscopic noise acceptable)
- **Good Zone (0.5-8%)**: Linear decay 100→60 (still printable)
- **Fail Zone (8-12%)**: Linear decay 60→0 (quality issues)
- **Critical (>12%)**: Score 0 (unprintable)

### Analysis Tools

**analyze-colors.js** - Show color count distribution
```bash
node analyze-colors.js
```

**compare-results.js** - Compare before/after metrics
```bash
node compare-results.js
```

## Examples

### Batch Process Wedding Photos

```bash
npm start -- process ./wedding-photos/ \\
  --output ./separated \\
  --analyze \\
  --preview \\
  --colors 5
```

### Process with Custom Resolution

```bash
npm start -- process large-image.jpg \\
  --width 1200 \\
  --height 1200 \\
  --colors 7 \\
  --masks
```

### Use Specific Preset

```bash
npm start -- process portrait.jpg \\
  --preset halftone-portrait \\
  --preview \\
  --masks
```

## Performance

Processing times on typical hardware:

- **800×800 image**: 0.5-2 seconds
- **1200×1200 image**: 1-4 seconds
- **Batch 100 images**: 1-5 minutes (depending on size and complexity)

## Limitations

- Maximum recommended resolution: 2000×2000 pixels
- Supported formats: JPEG, PNG, TIFF
- Color space: Automatically converted to Lab

## License

Apache-2.0
