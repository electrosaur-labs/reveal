# DNA-12 Vector Specification (v2.0)

**"DNA-12" names the twelve hue sectors.** The total vector is 19-dimensional: 7 global scalars plus 12 per-sector weight scalars. Each sector additionally carries 3 derived statistics (lMean, cMean, cMax), giving 43 scalar values in the full object — but the 19D subspace (7 global + 12 weights) is what drives manifold proximity.

All values are computed in a **single pixel pass** over the 16-bit Lab buffer. Implementation: `packages/reveal-core/lib/analysis/DNAGenerator.js`.

---

## Global Vector (7 dimensions)

| Field | Symbol | Range | Meaning |
|---|---|---|---|
| `l` | L-mean | 0–100 | Perceptual luminance average |
| `c` | C-mean | 0–∞ | Mean chroma (√(a²+b²)) across all pixels |
| `k` | Dynamic range | 0–100 | L*_max − L*_min (tonal spread) |
| `l_std_dev` | σL | 0–∞ | L* standard deviation (contrast distribution) |
| `hue_entropy` | H | 0–1 | Shannon entropy of the 12-sector weight distribution, normalized by log₂(12). 0 = monochromatic, 1 = perfectly uniform hue spread. |
| `temperature_bias` | T | −1..+1 | (warmPixels − coolPixels) / (warmPixels + coolPixels). Warm = b* > 5, cool = b* < −5. |
| `primary_sector_weight` | W | 0–1 | Fraction of chromatic pixels falling in the single dominant sector. |

---

## Hue Sectors (12 dimensions — the "12" in DNA-12)

12 sectors at 30° intervals, named: **red, orange, yellow, chartreuse, green, cyan, azure, blue, purple, magenta, pink, rose**.

A pixel is assigned to a sector only if its chroma C* > 5 (achromatic pixels don't vote).

Per sector:

| Field | Meaning |
|---|---|
| `weight` | Fraction of **total** pixels in this sector — this is the manifold coordinate |
| `lMean` | Mean L* of pixels in this sector |
| `aMean` | Mean a* of pixels in this sector |
| `bMean` | Mean b* of pixels in this sector |
| `cMean` | Mean chroma of pixels in this sector |
| `cMax` | Peak chroma observed in this sector |

`dominant_sector` names the sector with the highest weight.

---

## Manifold Coordinates

For inverse-distance interpolation (Mk2.0 continuous parameter generation), the proximity engine operates on the **19D subspace**:

```
[l, c, k, l_std_dev, hue_entropy, temperature_bias, primary_sector_weight,
 w_red, w_orange, w_yellow, w_chartreuse, w_green, w_cyan,
 w_azure, w_blue, w_purple, w_magenta, w_pink, w_rose]
```

The per-sector `lMean`, `cMean`, `cMax` are available for the Highlight Rescue sector check and PeakFinder anchor computation but do not contribute to archetype proximity distance.

---

## Full Object Shape (JavaScript)

```js
{
  version: '2.0',
  global: {
    l,                    // L* mean
    c,                    // chroma mean
    k,                    // dynamic range
    l_std_dev,            // L* std dev
    hue_entropy,          // normalized Shannon entropy of sector weights
    temperature_bias,     // warm/cool balance
    primary_sector_weight // dominant sector fraction
  },
  dominant_sector: 'orange',  // name of highest-weight sector
  sectors: {
    red:        { weight, lMean, aMean, bMean, cMean, cMax },
    orange:     { weight, lMean, aMean, bMean, cMean, cMax },
    yellow:     { weight, lMean, aMean, bMean, cMean, cMax },
    chartreuse: { weight, lMean, aMean, bMean, cMean, cMax },
    green:      { weight, lMean, aMean, bMean, cMean, cMax },
    cyan:       { weight, lMean, aMean, bMean, cMean, cMax },
    azure:      { weight, lMean, aMean, bMean, cMean, cMax },
    blue:       { weight, lMean, aMean, bMean, cMean, cMax },
    purple:     { weight, lMean, aMean, bMean, cMean, cMax },
    magenta:    { weight, lMean, aMean, bMean, cMean, cMax },
    pink:       { weight, lMean, aMean, bMean, cMean, cMax },
    rose:       { weight, lMean, aMean, bMean, cMean, cMax }
  },
  metadata: { width, height, totalPixels, bitDepth }
}
```
