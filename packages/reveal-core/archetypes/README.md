# Archetype Definitions

This directory contains JSON definitions for image archetypes used by the Reveal color separation system. Archetypes define "ideal" image characteristics and their corresponding processing parameters.

## Overview

The archetype system works by:
1. **Analyzing** images to extract 4D "DNA" (L, C, K, σL)
2. **Matching** against archetype centroids using weighted Euclidean distance
3. **Applying** the matched archetype's processing parameters

## DNA Dimensions (4D Feature Space)

Each archetype defines a centroid in 4D feature space:

| Dimension | Range | Description |
|-----------|-------|-------------|
| **L** (Lightness) | 0-100 | Average brightness (0=black, 100=white) |
| **C** (Chroma) | 0-150 | Average saturation (0=grayscale, 150=vivid) |
| **K** (Contrast) | 0-100 | Dynamic range / contrast (0=flat, 100=punchy) |
| **σL** (Flatness) | 0-50 | Lightness std deviation (0=vector art, 50=photo) |

## Archetype Files

Each archetype is defined in a separate JSON file:

- `noir-shadow.json` - Dark, high-contrast images (film noir, woodcuts)
- `muted-vintage.json` - Desaturated, flat images (faded posters, WPA prints)
- `pastel-high-key.json` - Very bright, soft colors
- `vibrant-hyper.json` - Highly saturated, colorful (pop art, concert posters)
- `hard-commercial.json` - High contrast, saturated (advertising)
- `soft-ethereal.json` - Low contrast, dreamy photos
- `cinematic-moody.json` - Darker tones, moderate saturation
- `standard-balanced.json` - Balanced, typical photographs

## JSON Structure

```json
{
  "id": "noir_shadow",
  "name": "Deep Shadow / Noir",
  "description": "Dark, low color, high contrast (film noir, woodcuts, ink drawings)",

  "centroid": {
    "l": 25,          // Target lightness
    "c": 10,          // Target chroma
    "k": 80,          // Target contrast
    "l_std_dev": 30   // Target flatness
  },

  "weights": {
    "l": 0.5,         // Lightness weight in distance calculation
    "c": 1.0,         // Chroma weight
    "k": 1.5,         // Contrast weight
    "l_std_dev": 1.0  // Flatness weight
  },

  "parameters": {
    "targetColors": 6,              // Number of colors to extract
    "blackBias": 8.0,               // Black deepening strength
    "saturationBoost": 1.0,         // Saturation multiplier
    "rangeClamp": [0, 100],         // Lightness clamp range
    "ditherType": "BlueNoise",      // Halftone algorithm
    "distanceMetric": "cie76",      // Color distance metric
    "vibrancyMode": "linear"        // Vibrancy processing
  }
}
```

## Adding New Archetypes

1. **Create a new JSON file** in this directory (e.g., `my-archetype.json`)
2. **Define the centroid** based on target image characteristics
3. **Set weights** to prioritize important dimensions (higher = more important)
4. **Choose parameters** appropriate for the image style
5. **Rebuild** the preset system: `npm run build` in reveal-batch
6. **Test** by running PresetArchitect: `node src/PresetArchitect.js`

### Weight Guidelines

- **Lightness (l)**: 0.5-1.0 - Less critical, most styles span multiple brightness levels
- **Chroma (c)**: 1.0-2.0 - Important for distinguishing colorful vs muted images
- **Contrast (k)**: 1.5-2.5 - Critical for style perception (soft vs hard)
- **Flatness (l_std_dev)**: 1.0-3.0 - Important for distinguishing vector art from photos

### Parameter Guidelines

| Parameter | Low Value | High Value | Use Case |
|-----------|-----------|------------|----------|
| `targetColors` | 4-6 | 8-10 | Noir/graphic vs photos |
| `blackBias` | 1.0-2.0 | 5.0-10.0 | Pastel vs noir |
| `saturationBoost` | 0.8-0.9 | 1.2-1.5 | Vintage vs vibrant |
| `rangeClamp` | [5, 95] | [0, 100] | Soft vs punchy |

## Schema Validation

The `schema.json` file defines the complete archetype structure. Validate your archetypes:

```bash
npm install -g ajv-cli
ajv validate -s schema.json -d "*.json"
```

## Usage in Code

### PresetArchitect (Batch Processing)

```javascript
// Load archetypes
const archetypes = PresetArchitect.loadArchetypes();

// Match image DNA to closest archetype
const archetype = PresetArchitect.nameArchetype(imageDNA, archetypes);

// Generate preset config
const config = PresetArchitect.generateConfig(archetype, imageDNA);
```

### Adobe Plugin (Runtime)

Archetypes are copied to `dist/archetypes/` during build and can be loaded at runtime for dynamic preset generation.

## Distance Calculation

Matching uses weighted Euclidean distance in 4D space:

```
distance = sqrt(
  w_l * (L - L_target)² +
  w_c * (C - C_target)² +
  w_k * (K - K_target)² +
  w_σ * (σL - σL_target)²
)
```

The archetype with the **minimum distance** is selected.

## Benefits

- **No code changes** needed to add new archetypes
- **Version controlled** - track archetype evolution in git
- **Self-documenting** - JSON is readable and explicit
- **Easy testing** - modify parameters without recompiling
- **Extensible** - add new parameters without breaking existing archetypes

## Migration Notes

Previous implementation (v0.12):
- Archetypes hardcoded in PresetArchitect.js
- Switch statement for parameter mapping
- 3D DNA (L, C, K only)

Current implementation (v0.13+):
- Archetypes externalized to JSON
- Parameters embedded in archetype files
- 4D DNA (L, C, K, σL) for better vector art detection
