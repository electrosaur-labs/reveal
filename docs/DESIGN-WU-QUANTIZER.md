# Design: Wu Quantizer Integration

## Overview

Add Xiaolin Wu's optimal color quantization as an alternative to the current median cut splitting strategy inside `LabMedianCut`. Wu uses a 3D histogram with cumulative moment tables to find splits that minimize total variance (SSE) — mathematically optimal, unlike median cut's heuristic median-position splits.

**Reference:** Wu, X. "Efficient Statistical Computations for Optimal Color Quantization." *Graphics Gems vol. II*, Academic Press, 1991, pp. 126-133.

## Why Wu

Median cut splits boxes at the median pixel position along the widest axis. This balances pixel counts but doesn't minimize color error. Wu splits at the position that minimizes total within-box variance — the mathematically optimal split point. In practice this produces better palettes, particularly for images with uneven color distributions (which is most photographs).

## Design Principles

1. **Not a new engine type.** Wu is a splitting strategy, not a new pipeline. The engine types (reveal, balanced, distilled, etc.) stay the same.
2. **Surfaced as a config option.** `quantizer: 'median-cut' | 'wu'` — selectable per archetype or as a user override. Default remains `'median-cut'` until Wu is validated.
3. **Same interface contract.** Wu takes deduplicated Lab colors in, returns palette out. All downstream processing (centroid strategies, hue gap recovery, PaletteOps refinement, neutral sovereignty) is untouched.
4. **Performance budget.** Must be at least as fast as median cut at 512px proxy resolution (~260K pixels). Wu's histogram approach should actually be faster since splitting works on ~36K histogram cells, not on pixels.

## Algorithm Summary

### Step 1: Build 3D Histogram

Discretize Lab color space into a 3D grid. Each deduplicated color `{L, a, b, count}` maps to a voxel. Accumulate five moments per voxel:

| Moment | Purpose |
|--------|---------|
| `wt[l][a][b]` | Pixel count |
| `mL[l][a][b]` | Sum of L values (full precision, not quantized) |
| `mA[l][a][b]` | Sum of a values |
| `mB[l][a][b]` | Sum of b values |
| `m2[l][a][b]` | Sum of L² + a² + b² per pixel |

### Step 2: Compute Cumulative Moment Tables

Convert all five arrays into 3D prefix sums (cumulative sums). After this step, any sub-box's total count, channel sums, and sum-of-squares can be computed from 8 corner lookups via 3D inclusion-exclusion (the 3D analog of a summed-area table).

This is what makes Wu fast: evaluating a candidate split point is O(1), not O(n).

### Step 3: Iterative Splitting

Starting with one box spanning the entire grid:

1. Select the box with highest variance
2. For each axis (L, a, b), sweep through all candidate split positions
3. For each candidate, compute the variance reduction using the moment tables (O(1))
4. Accept the axis/position with the best variance reduction
5. Repeat until we have N boxes (or no box has positive variance)

### Step 4: Extract Palette

Each box's representative color is computed using the existing centroid strategy injection (SALIENCY, ROBUST_SALIENCY, or VOLUMETRIC) — not a simple weighted mean. This preserves Reveal's existing centroid behavior.

## Adaptation for Lab Color Space

Wu's original algorithm operates in RGB with 5-bit quantization (32 bins per axis, values 0-255). Reveal operates in Lab (L: 0-100, a: -128 to +127, b: -128 to +127). Adaptations:

### Histogram Resolution

| Axis | Range | Bins | Bin width | Array index |
|------|-------|------|-----------|-------------|
| L | 0–100 | 32 | ~3.1 L* units | `Math.min(31, Math.floor(L * 32 / 101))` |
| a | -128–+127 | 32 | ~8.0 a* units | `Math.min(31, Math.floor((a + 128) * 32 / 256))` |
| b | -128–+127 | 32 | ~8.0 b* units | `Math.min(31, Math.floor((b + 128) * 32 / 256))` |

Array dimensions: `[33][33][33]` (indices 0–32, with 0 as prefix-sum boundary). Linearized as a flat array: `index = l * 1089 + a * 33 + b` (total: 35,937 entries).

### Bin Width Implications

- **L axis:** 3.1 L* per bin. CIE76 ΔE of ~3 is "just noticeable." This means two colors in adjacent L bins are near the threshold of perceptual difference. Adequate resolution.
- **a/b axes:** 8.0 units per bin. Coarser than L, but a/b contribute less to perceptual difference than L in most distance metrics. Two colors in adjacent a or b bins differ by ΔE ~8, which is "noticeable but acceptable" for quantization purposes.

If 32 bins proves too coarse for Lab (possible for high-chroma images with closely-spaced hues), we can increase to 64 bins per axis. This increases memory from ~250KB to ~2MB — still fine. Start with 32 and validate.

### Variance Metric

The original Wu uses RGB Euclidean distance: `r² + g² + b²`. In Lab space, Euclidean distance IS CIE76 ΔE (by definition). So the variance metric translates directly: `L² + a² + b²` with no weighting needed.

However, we should support **chroma-weighted variance** to match Reveal's existing `vibrancyBoost` behavior. Without weighting, Wu optimizes for raw CIE76 distance, which can over-partition dense shadow regions at the expense of sparse but perceptually important high-chroma colors (e.g., the golden highlights on the horse).

The variance metric becomes:

```
chromaWeight = 1.0 + vibrancyBoost * sqrt(a² + b²) / maxChroma
m2 += chromaWeight * (L² + a² + b²)
```

This biases splitting toward boxes containing vivid colors — the same principle as median cut's `vibrancyBoost` priority multiplier, but applied inside the variance calculation rather than as a post-hoc priority adjustment.

Default: unweighted (standard CIE76). Enabled when the archetype specifies `vibrancyBoost > 0`.

## Integration Point

### Where It Plugs In

Inside `LabMedianCut.medianCutInLabSpace()`, the recursive splitting loop (currently lines ~485-620) is the replacement target. Everything before (deduplication, substrate culling, neutral isolation) and everything after (centroid calculation, metadata attachment) stays the same.

```
medianCutInLabSpace()
├── Grid sampling + deduplication          ← KEEP
├── Substrate culling                       ← KEEP
├── Neutral isolation                       ← KEEP
├── ▸▸▸ SPLITTING LOOP ◂◂◂                 ← REPLACE (Wu or median cut)
├── Centroid calculation per box            ← KEEP (strategy injection)
├── Attach _allColors, _labPixels metadata  ← KEEP
└── Return palette                          ← KEEP
```

### Config Flow

```
archetype.json
  └── "quantizer": "wu"        (or omit for default "median-cut")
        ↓
generateConfiguration(dna)
  └── config.quantizer = archetype.quantizer || "median-cut"
        ↓
PosterizationEngine.posterize(pixels, w, h, N, { quantizer: "wu", ... })
  └── options.quantizer passed through to LabMedianCut
        ↓
LabMedianCut.medianCutInLabSpace(..., tuning)
  └── tuning.split.quantizer === "wu"
        ? _splitLoopWu(colors, targetColors, ...)
        : _splitLoopMedianCut(colors, targetColors, ...)
```

### Interface Contract

The Wu splitting loop receives:

```javascript
_splitLoopWu(
    colors,              // Array<{L, a, b, count}> — deduplicated, culled
    targetColors,        // number
    grayscaleOnly,       // boolean
    tuning,              // {split, prune, centroid}
    sectorEnergy,        // Float32Array(12) — hue sector weights
    coveredSectors       // Set<number> — already-covered hue sectors
)
// Returns: Array<Array<{L, a, b, count}>> — array of boxes (arrays of colors)
```

The return is an array of color groups (boxes). The caller computes centroids using the existing strategy injection, same as it does for median cut boxes.

### Hue-Aware Priority

Wu's original algorithm splits the highest-variance box. Reveal's median cut also considers hue sector coverage — boxes containing uncovered hue sectors get a priority boost. For Wu, we apply the same boost: after computing each box's variance from the moment tables, multiply by the hue-sector priority multiplier before selecting which box to split.

### Centroid Strategy Compatibility

Wu's original algorithm computes box centroids as simple weighted means (`sum_channel / count`). Reveal uses pluggable centroid strategies (SALIENCY, ROBUST_SALIENCY, VOLUMETRIC) that do more sophisticated things — top-5% slicing, chroma winsorization, black protection.

These strategies operate on `Array<{L, a, b, count}>` — the list of colors in a box. The Wu splitting loop must preserve the mapping from histogram voxels back to the original deduplicated colors, so that centroid strategies receive the same data format they expect.

Implementation: each box tracks its bounds in histogram space. After splitting is complete, we iterate the deduplicated colors and assign each to its containing box based on histogram coordinates. The resulting per-box color lists are passed to the existing centroid strategies.

## File Changes

| File | Change |
|------|--------|
| `lib/engines/LabMedianCut.js` | Add `_splitLoopWu()` static method. Modify `medianCutInLabSpace()` to dispatch based on `tuning.split.quantizer`. |
| `lib/engines/PosterizationEngine.js` | Pass `options.quantizer` through to `tuning.split.quantizer`. |
| `index.js` | No change — `quantizer` flows through existing config plumbing. |
| `archetypes/*.json` | No change initially — default stays `median-cut`. Add `"quantizer": "wu"` to selected archetypes after validation. |

### New Code (~200-300 lines in LabMedianCut.js)

```
_splitLoopWu(colors, targetColors, grayscaleOnly, tuning, sectorEnergy, coveredSectors)
├── _buildLabHistogram(colors)           // Discretize to 33³ grid, accumulate moments
├── _computeCumulativeMoments(moments)   // 3D prefix sums
├── _wuVariance(box, moments)            // O(1) variance from 8 corner lookups
├── _wuMaximize(box, axis, moments)      // Find best split along one axis
├── _wuCut(box, moments)                 // Try all 3 axes, pick best split
└── loop: split highest-variance box until targetColors reached
```

## Testing Strategy

### Unit Tests

1. **Histogram accuracy:** Build histogram from known colors, verify moments match hand-calculated values.
2. **Cumulative moments:** Verify prefix sums by comparing `Vol()` queries against brute-force box sums.
3. **Single-color image:** Wu returns 1 color matching the input.
4. **Two-cluster image:** Wu correctly separates two distinct color groups.
5. **Symmetry:** Identical results regardless of pixel order (histogram is order-independent).
6. **Determinism:** Bitwise-identical results across runs.

### Integration Tests

7. **Interface parity:** For each existing posterization test, run with both `quantizer: 'median-cut'` and `quantizer: 'wu'`. Both must produce valid palettes (correct count, valid Lab ranges, no NaN).
8. **Golden palette regression:** The horse and ducks fixtures have golden palette tests (ΔE < 2/3). Wu palettes may differ — capture new golden values after validation.
9. **Benchmark datasets:** Run CQ100, TESTIMAGES, SP100 with Wu. Compare mean ΔE against median cut. Wu should be equal or better.

### Performance Tests

10. **Proxy speed:** Time Wu vs median cut at 512px proxy resolution. Wu must not be slower.
11. **Full-res speed:** Time at 3000px+ for production render path.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| 32-bin histogram too coarse for Lab | Start with 32, validate visually. Fall back to 64 if needed (2MB vs 250KB). |
| Hue-sector priority integration breaks Wu's variance optimality | The priority boost is a heuristic overlay — it makes Wu non-optimal but still better than median cut. Same tradeoff median cut already makes. |
| Centroid strategy needs per-box color lists, not histogram voxels | After splitting, map deduplicated colors back to boxes via histogram coords. O(n) in color count. |
| Wu produces different palettes → golden tests fail | Expected. Update golden values after visual validation confirms quality. |
| m2 overflow for large images | Use Float64Array for m2. At 512px proxy (~260K pixels), max m2 per voxel is ~260K × (100² + 128² + 128²) ≈ 1.7 × 10¹⁰. Float64 handles this. |

## Validation Plan

1. Implement with `quantizer: 'median-cut'` as default
2. Run existing test suite — must pass 100% (Wu not yet active)
3. Switch horse fixture to `quantizer: 'wu'`, compare palette visually
4. Switch ducks fixture to `quantizer: 'wu'`, compare palette visually
5. Run CQ100 benchmark with Wu, compare mean ΔE
6. If Wu is equal or better across the board, flip default to `'wu'`
7. If Wu is better for some archetypes but not others, set per-archetype

## Non-Goals

- **Replacing the entire LabMedianCut module.** Wu replaces the splitting loop only.
- **Changing the UI.** No new controls. The `quantizer` option is internal config, not user-facing.
- **Removing median cut.** Both strategies coexist. Archetypes choose.
- **Optimizing for >256 colors.** Screen printing uses 5-20 colors. Wu's overhead is negligible at this scale.
