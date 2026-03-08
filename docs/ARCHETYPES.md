# Archetype Reference

Reveal ships with 26 archetypes organized into 6 groups. Each archetype is a separation strategy tuned for a specific kind of image. The DNA system automatically ranks archetypes against your image, but you can select any archetype manually.

Archetype definitions live in `packages/reveal-core/archetypes/*.json`. Add or remove archetypes by adding or removing files — they are auto-discovered at runtime.

## Natural

General-purpose archetypes for photographic and painterly images with diverse color content.

| Archetype | Target Colors | Metric | Best for |
|-----------|--------------|--------|----------|
| **Everyday Photo** | 4–10 | CIE2000 | Baseline for standard photographic scenes |
| **Fine Art Scan** | 4–10 | CIE2000 | 16-bit archival scans with clinical color diversity |
| **Warm Photo** | 4–10 | CIE2000 | Warm multi-hue subjects — food, toys, wildlife |
| **Painterly** | 5–10 | CIE2000 | Warm-toned painterly scenes — landscapes, genre scenes, Art Nouveau |
| **Full Spectrum** | 10–12 | CIE94 | High-entropy images with color spread across many sectors, no dominant hue |

## Soft

Low-contrast, desaturated, or high-key images where preserving subtle gradients matters.

| Archetype | Target Colors | Metric | Best for |
|-----------|--------------|--------|----------|
| **Pastel** | 4–8 | CIE94 | Very bright, soft colors — high-key photography |
| **Soft Light** | 4–8 | CIE94 | Mid-bright, low contrast — dreamy, ethereal images |
| **Faded Vintage** | 4–8 | CIE2000 | Mid-bright, desaturated — retro posters, WPA aesthetics |
| **Bleached** | 4–8 | CIE2000 | Bright, washed-out images with extreme contrast and minimal color |
| **Black & White** | 8–10 | CIE2000 | Pure grayscale — locks neutral centroids to prevent chromatic noise |

## Graphic

High-contrast, saturated art with bold colors and clean edges.

| Archetype | Target Colors | Metric | Best for |
|-----------|--------------|--------|----------|
| **Spot Color** | 4–10 | CIE2000 | Ultra-flat colors, zero gradients — vector art, spot color separation |
| **Minkler** | 5–10 | CIE76 | Bold, rough-and-ready graphic style — political posters, woodcuts, editorial graphics |
| **Commercial** | 6–10 | CIE2000 | High contrast, saturated commercial photography |
| **Neon** | 6–12 | CIE76 | Aggressive hue-locking for saturated flat art — prevents color bleed |
| **Vivid Poster** | 6–12 | CIE2000 | High-impact graphic style that respects luminance boundaries |

## Dramatic

Dark, high-contrast images with strong shadow content.

| Archetype | Target Colors | Metric | Best for |
|-----------|--------------|--------|----------|
| **Dark Portrait** | 4–8 | CIE2000 | Dark warm paintings with dramatic light-dark contrast — Rembrandt, candlelit scenes |
| **Old Master** | 4–8 | CIE2000 | Very dark paintings with golden tonality — Caravaggio, old masters in deep shadow |
| **Film Noir** | 4–8 | CIE94 | Dark, high contrast — woodcuts and film noir aesthetics |
| **Cinematic** | 4–10 | CIE2000 | Deep tones and heavy shadows — prevents shadow fusion in low-exposure shots |
| **Golden Hour** | 12–14 | CIE2000 | Single warm hue dominates a neutral canvas — amber-lit interiors, autumn foliage |

## Vibrant

High-chroma images where preserving color intensity is the priority.

| Archetype | Target Colors | Metric | Best for |
|-----------|--------------|--------|----------|
| **Sunlit** | 4–10 | CIE2000 | Bright warm scenes with dramatic shadows — murals, warm-lit architecture, folk art |
| **Saturated Max** | 6–10 | CIE76 | Maximum palette with high vibrancy — 10-color partition |
| **Vivid Photo** | 6–12 | CIE94 | Finds vibrant details without crushing luminance |
| **Hot Yellow** | 6–10 | CIE76 | Maximum aggression for yellow-dominant high-chroma images |

## Specialist

Edge-case recovery archetypes for images that defeat the general strategies.

| Archetype | Target Colors | Metric | Best for |
|-----------|--------------|--------|----------|
| **Cool Recovery** | 4–10 | CIE2000 | Recovers cool-spectrum colors in warm or neutral images |
| **Detail Recovery** | 4–10 | CIE2000 | Monochromatic, high-detail images — prevents saliency shadow |

## Pseudo-Archetypes

Three additional archetypes appear in the carousel but are not JSON files — they are code-driven engines that adapt to each image dynamically rather than using fixed parameters.

| Archetype | Engine | Best for |
|-----------|--------|----------|
| **Chameleon** | DNA-interpolated parameters, distilled quantization | The adaptive default — blends parameters from neighboring archetypes based on your image's exact DNA. Works well on most images without manual tuning. |
| **Distilled** | Over-quantize to 20 colors, reduce to 12 via furthest-point sampling | Maximum color fidelity — finds the 12 most distinct colors in your image with no pruning. Fixed 12-color target, no preprocessing. |
| **Salamander** | Chameleon's DNA-driven color count + Distilled's raw signal preservation | Hybrid — DNA tells it how many colors; distilled engine picks which colors. No preprocessing, no palette reduction. All extracted colors survive intact. |

## Distance Metrics

| Metric | Speed | Best for |
|--------|-------|----------|
| **CIE76** | Fast | Posters, graphics, vector art — perceptual accuracy less critical |
| **CIE94** | Medium | Saturated colors, photographic content — chroma-dependent weighting |
| **CIE2000** | Slow | Museum-grade accuracy — advanced hue handling for subtle color differences |
