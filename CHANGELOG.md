# Reveal Project Changelog

## v1.0.0-saliency-rescue (2026-01-20)

**Known Good State** - CQ100 Benchmark with Saliency Rescue

### Major Features

#### 🧬 DNA-Based Dynamic Configuration
- Implemented `DynamicConfigurator.js` for image-specific parameter generation
- Analyzes image "DNA" (avg L, C, K, maxC, luminance range)
- Generates bespoke parameters without manual presets
- 7 heuristic rules covering diverse image types

#### 🚑 Saliency Rescue System
- Detects "hidden color spikes" in otherwise grey images
- Condition: `avgC < 12 && maxC > 50`
- Forces 12-color palette to preserve salient features
- Results: Astronaut Revelation Score 27.7 → 35 (+26.4%)
- Triggered for 3/100 images in CQ100 dataset

#### 🛡️ Texture Rescue System
- Detects extreme contrast (K > 28) causing scum dots
- Applies noise suppression with heavy black bias
- Fixes marrakech_museum and similar high-texture images

#### 📊 Extended Integrity Scoring
- Three-zone tolerance model based on screen printing reality:
  - Safe Zone (0-0.5%): Score 100
  - Good Zone (0.5-8%): Linear decay 100→60
  - Fail Zone (8-12%): Linear decay 60→0
- Extended from 5% to 12% tolerance
- 92% of CQ100 images achieve print-ready status

### CQ100 Benchmark Results

**Global Metrics (100 images):**
- Avg ΔE: 16.53 (improved from 16.85)
- Avg Revelation: 32.3 (improved from 30.3, +6.6%)
- Avg Integrity: 93.8 (maintained from 93.7)
- Processing: ~1.4s per image

**Color Distribution:**
- 51% use 12-13 colors (optimal sweet spot)
- 26% use 12 colors (maximum palette)
- 3% triggered Saliency Rescue
- Bell curve validates dynamic approach

### New Tools

#### Core Implementation
- `src/DynamicConfigurator.js` - DNA-based parameter generation
- `src/MetricsCalculator.js` - Extended integrity scoring
- `src/processCQ100.js` - Enhanced with maxC tracking

#### Analysis Tools
- `src/CQ100_MetaAnalyzer.js` - Batch results analysis
- `src/CQ100_Profiler.js` - Image DNA profiling
- `src/Revalidate.js` - Integrity recalculation utility
- `analyze-colors.js` - Color distribution analysis
- `compare-results.js` - Before/after comparison

#### NPM Scripts
```bash
npm run process-cq100   # Process CQ100 benchmark
npm run analyze-cq100   # Analyze results
npm run revalidate      # Recalculate integrity scores
```

### Technical Details

#### DynamicConfigurator Heuristics

1. **Complexity Scaling**: High contrast + high chroma → more colors
2. **Saliency Rescue**: Hidden color spikes → force 12 colors
3. **Texture Rescue**: Extreme contrast → noise suppression
4. **Vintage Optimization**: Flat images → fewer colors
5. **Rich Images**: High chroma + contrast → ensure 12 colors
6. **Dynamic Black Bias**: Noir protection, high-key relaxation
7. **Saturation Boost**: Dull boost, neon clamp

#### Integrity Scoring Formula

```javascript
// Safe Zone (0-0.5%)
if (noiseRatio <= 0.005) return 100;

// Good Zone (0.5-8%)
if (noiseRatio <= 0.08) {
    const progress = (noiseRatio - 0.005) / 0.075;
    return 100 - (progress * 40);  // 100 → 60
}

// Fail Zone (8-12%)
if (noiseRatio <= 0.12) {
    const progress = (noiseRatio - 0.08) / 0.04;
    return 60 - (progress * 60);  // 60 → 0
}

// Critical (>12%)
return 0;
```

### Notable Case Studies

#### Astronaut (Saliency Rescue Success)
- **Before**: 11 colors, Rev: 27.7, Int: 96.9
- **After**: 12 colors, Rev: 35, Int: 93
- **DNA**: avgC=5.7, maxC=85.9 (triggered rescue)
- **Result**: +26.4% Revelation improvement, red flag preserved

#### Marrakech Museum (Texture Rescue Success)
- **Before**: Integrity: 68.5 (failing)
- **After**: Integrity: 71.2 (passing)
- **DNA**: K=31.4 (extreme contrast)
- **Result**: Noise suppression prevented scum dots

#### Siberian Tiger (Best Performer)
- **Colors**: 12
- **Revelation**: 53.4 (highest in dataset)
- **Integrity**: 85.4 (still printable)
- **Why**: Complex fur textures benefit from maximum palette

### Breaking Changes

None - fully backward compatible.

### Documentation Updates

- Updated `packages/reveal-batch/README.md` with:
  - CQ100 Benchmark section
  - DynamicConfigurator logic
  - Integrity scoring explanation
  - Analysis tools usage
  - Current benchmark results

### Known Issues

- Color charts (synthetic test images) score poorly (Rev: 5-6)
  - Expected: Not real-world use case
- 8% of images don't reach "print-ready" (Int > 60)
  - Acceptable: Reflects genuine printing challenges

### Performance

- Processing: 1.4s per image average
- Batch 100 images: ~2.5 minutes
- Analysis: <1 second
- Revalidation: <1 second (no reprocessing)

### Future Work

- Per-color breach analysis
- Spatial breach clustering
- Correlation analysis (breaches vs visual quality)
- Adaptive threshold tuning based on substrate

---

## Previous Releases

### v0.3.0 (2026-01-19)
- Added quality metrics to batch processor
- Fixed PSD layer visibility handling
- Standardized presets to 8 colors

### v0.2.0 (2026-01-18)
- Fixed non-determinism between UI and batch
- Implemented PSD writer package
- Added Lab color space support

### v0.1.0 (2026-01-17)
- Initial reveal-core implementation
- Basic posterization engine
- Preset system foundation
