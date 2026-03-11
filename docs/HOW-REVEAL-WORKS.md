# How Reveal Works

A conceptual guide to Reveal's architecture and algorithms, written for someone who understands screen printing but not computer science.

## The Problem

You have a photograph with 60,000+ unique colors. You need to print it with 8-12 opaque spot color inks on a screen press. That means:

1. **Choose the colors** — which 8-12 inks best represent this image?
2. **Assign every pixel** — for each of the ~400,000 pixels, which ink does it belong to?
3. **Generate separation masks** — one mask per ink color, defining where that ink prints
4. **Simulate gradations** — with only flat ink, use dithering patterns to fake tonal transitions

This is what Reveal automates.

## The Pipeline

Every image flows through the same sequence:

```
Photograph
    → Convert to Lab color space
    → Analyze the image's "DNA"
    → Match to archetypes (separation strategies)
    → User picks an archetype and refines the palette
    → Quantize: reduce to N colors via median cut
    → Separate: assign every pixel to its nearest palette color
    → Dither: add halftone-like patterns for tonal transitions
    → Generate masks: one per ink color
    → Output: Lab fill+mask layers in Photoshop
```

Each step is explained below.

## Why Lab, Not RGB

RGB describes colors as mixtures of red, green, and blue light — how a screen displays them. Lab describes colors as humans perceive them:

- **L** = lightness (0 = black, 100 = white)
- **a** = green-to-red axis
- **b** = blue-to-yellow axis

The critical property: **equal distances in Lab correspond to equal perceived differences**. A distance of 5 units between two Lab colors looks the same to your eye regardless of where in the color space those colors sit. RGB has no such guarantee — a 5-unit shift in dark blues looks different from a 5-unit shift in bright yellows.

This matters because every decision Reveal makes ("are these two colors similar enough to merge?", "which palette color is closest to this pixel?") depends on measuring color differences. If the measurement is perceptually wrong, the decisions are wrong.

## DNA: Fingerprinting the Image

Before choosing any colors, Reveal analyzes the image's statistical personality — its "DNA." This is a set of measurements that describe what kind of image it is:

| Measurement | What it captures |
|-------------|-----------------|
| **Mean L*** | Overall brightness — is this a dark, moody image or a bright, airy one? |
| **Mean Chroma** | Color intensity — vivid and saturated, or muted and desaturated? |
| **Key (darkness)** | How much of the image is in deep shadow |
| **Lightness spread (σL)** | Does the image use the full tonal range, or is it compressed? |
| **Hue entropy** | Are the colors spread across the rainbow, or concentrated in one region? |
| **Temperature bias** | Warm-dominant (oranges, reds) or cool-dominant (blues, greens)? |
| **Dominant sector weight** | How much does the single most common hue dominate? |

These seven numbers form a fingerprint — a point in a 7-dimensional space that characterizes the image.

## Archetypes: Separation Strategies

An archetype is a recipe for how to separate a particular kind of image. Each archetype was designed for a different visual personality:

- **Chameleon** — general purpose, adapts to most images
- **Golden Hour** — warm-dominant, preserves sunset/golden tones
- **Film Noir** — high contrast, dark, dramatic
- **Commercial** — clean, high-chroma graphics
- **Dark Portrait** — low-key images with skin tones in shadow
- ... and 20+ more

Each archetype specifies:

- **Target color count** — how many inks to use
- **Engine type** — which quantization algorithm to apply
- **Distance metric** — how to measure color similarity (fast vs. perceptually accurate)
- **Dither type** — which halftone pattern to use
- **Centroid strategy** — how to calculate the "center" of a group of colors
- **Preprocessing** — whether to smooth the image first to reduce noise

### How Matching Works

Each archetype has a **centroid** — a point in the same 7D space as the DNA fingerprint. Matching is essentially asking: "which archetype's ideal image is most similar to this image?"

The scoring uses three components (40/45/15 weighting):

1. **Structural match (40%)** — How close is the DNA fingerprint to the archetype's centroid? Measures lightness, chroma, contrast, and tonal spread.
2. **Sector match (45%)** — Does the image's hue distribution align with what the archetype expects? An archetype designed for warm images should score poorly on a cool blue landscape.
3. **Pattern match (15%)** — Special characteristics like high entropy (lots of different colors) or extreme temperature bias.

The result is a ranked list of archetypes, each with a score. Reveal presents these as a carousel — you see the top-scoring suggestions and pick the one whose preview looks best. Or you pick a different one entirely. The engine recommends; you decide.

## Median Cut Quantization: Choosing the Palette

Once you've selected an archetype and target color count, Reveal needs to find the best N colors. It uses **median cut** — a recursive partitioning algorithm that works like this:

1. Put all pixels in one big box in Lab color space
2. Find the dimension (L, a, or b) with the widest spread
3. Split the box at the median along that dimension — half the pixels go to each side
4. Repeat: keep splitting the most varied box until you have N boxes
5. Each box's center becomes one palette color

The result: colors that appear frequently in the image get more of the budget. A dark olive background that covers 60% of the pixels will dominate, but minority colors (a flash of orange, a sliver of blue) still get representation if they're sufficiently different from everything else.

### Neutral Sovereignty

A special case: if more than 20% of the image is achromatic (white, gray, black — very low chroma), Reveal reserves one palette slot for that neutral tone and runs median cut only on the chromatic pixels. Without this, a white background would eat into the color budget, and you'd lose a chromatic ink you actually need.

## Pixel Separation: Assigning Every Pixel

With the palette chosen, every pixel gets assigned to its nearest palette color. "Nearest" is measured using one of three distance metrics:

- **CIE76** — Euclidean distance in Lab. Fast, good enough for most work.
- **CIE94** — Weights lightness differences more heavily. Better perceptual accuracy.
- **CIE2000** — The most perceptually accurate formula. Handles blues and grays where CIE76 struggles. Slower.

The output is an array of indices — for each pixel, a number saying "this pixel belongs to color 3" or "this pixel belongs to color 7."

## Dithering: Faking Gradations

With only flat inks, a gradient becomes a hard edge between two colors. Dithering breaks up that edge by interleaving pixels of adjacent colors, creating the illusion of a smooth transition — similar to how halftone dots work in traditional printing.

Reveal supports several dithering algorithms:

- **Atkinson** — The default. Classic algorithm from the original Macintosh. Diffuses only 75% of the error, which preserves contrast and produces a distinctive graphic quality. Good match for screen printing's inherent boldness.
- **Floyd-Steinberg** — The most common error diffusion algorithm. Diffuses 100% of the error for smoother transitions, but can look mushy on low-color-count separations.
- **Stucki** — Distributes error over a wider neighborhood than Floyd-Steinberg. Smoother but slower.
- **Bayer** — Ordered dithering using a fixed threshold matrix. Produces a regular, grid-like pattern. Mesh-aware: can scale the pattern to match your screen mesh LPI.

## Mechanical Knobs: Post-Separation Refinement

After the initial separation, four knobs let you refine the result:

### Ghost Screen Removal (minVolume)

If a palette color covers only 0.3% of the image, that's a "ghost screen" — it would require burning a screen, mixing an ink, and running a pass for almost nothing visible. MinVolume sets a coverage threshold: colors below it get merged into their nearest neighbor. The pixels don't disappear; they get reassigned to the next closest color.

### Speckle Rescue (speckleRescue)

After separation, some colors may appear as isolated single pixels scattered across the image. These would print as dust — visible specks that serve no purpose. Speckle rescue uses morphological operations (examining the neighborhood of each pixel) to clean up clusters smaller than the threshold.

### Shadow Clamp (shadowClamp)

Some mask values end up barely visible — 2% or 3% coverage in a region. On press, this prints as a patchy, inconsistent whisper of ink. Shadow clamp sets a minimum: any mask value below the threshold gets pushed up to a printable floor, giving the ink enough body to print cleanly.

### Trapping (trapSize)

When two ink colors meet, any misregistration on press creates a white gap between them. Trapping expands the lighter color slightly under the darker one, so a small registration error is hidden by overlap rather than exposed as white paper.

Reveal's trapping works by iterative morphological dilation — the lighter color's mask grows outward pixel by pixel, but only into regions occupied by darker colors. The trap width is specified in points (the prepress standard unit) and converted to pixels using the document's DPI.

## The Proxy Pipeline: Interactive Preview

Full-resolution separation of a 4000x3000 image takes seconds — too slow for interactive exploration. Reveal solves this with a proxy pipeline:

1. **Downsample** the image to ~512px on the long edge
2. **Run the full separation** at proxy resolution (fast enough for real-time)
3. **Display the preview** at up to 800px in the Photoshop panel
4. When the user changes archetype, palette, or knobs: **re-run on the proxy** instantly
5. When the user commits: **re-separate at full resolution** using the locked palette

The key insight: the palette is chosen at proxy resolution, but pixel assignment at full resolution uses nearest-neighbor mapping with the same palette. The preview is the decision surface — what you see is what you get.

## Bilateral Filter: Preprocessing

Before quantization, an optional bilateral filter smooths the image while preserving edges. This is edge-preserving noise reduction — it averages out sensor noise and fine texture within flat regions, but doesn't blur across strong edges (like the boundary between an object and its background).

Why this matters: without it, noise in a flat sky gets quantized into speckled patches of two different blues. With it, the sky reads as one clean color.

## The Output

The final output in Photoshop is a set of Lab fill+mask layers:

- Each layer is a **solid fill** of one palette color
- Each layer has a **mask** defining where that color prints (0 = no ink, 255 = full ink)
- The mask includes dithering patterns for tonal transitions
- Trapping overlaps are baked into the masks

These layers map directly to film positives: each mask becomes one film, one screen, one ink, one pass on press.

---

## A Note on How This Was Built

No human wrote a single line of code in Reveal.

The human contribution was: requirements ("I need a tool that separates photographs into spot colors for screen printing"), manual testing in Photoshop, evaluation of posterization quality ("the horse lost its golden tones," "the ducks look muddy"), and artistic direction ("the goal is interpretation, not reproduction").

The code was written entirely by AI — primarily Claude (Anthropic), with architectural and design guidance from Gemini (Google). The AI pair-programming workflow involved thousands of iterations: propose an approach, implement it, test it, evaluate the visual result, diagnose failures, and refine. The human never needed to read or understand the code to direct the project — the same way a film director doesn't need to operate the camera to make the movie.

The result is an engine with 1,000+ automated tests, validated against 487 images, that produces print-ready separations. Whether this represents a new model for software development or just an interesting experiment is left as an exercise for the reader.
