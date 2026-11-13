# Changelog

## v2.1.0 (2026-11-13)

Major prepress physics release, external CLI verification tool, and studio refinement.

### Pre-Flight Inspector & CLI (`@electrosaur-labs/reveal-cli`)

- **`reveal verify <file.psd>`** — Automated pre-flight separation inspector auditing delivered PSDs against press physics
- **Manifest v2.1 Verification** — Extracts and validates embedded XMP prepress metadata (`meshSize`, `dpi`, `ruleOfN`, `minDotPx`, `trapPx`, `dualScale`, `screenCount`)
- **Trapping Physics Audit** — Euclidean Distance Transform (EDT) enforcing directional containment (light under dark inks), boundary dilation limits ($\le r + 0.5\text{px}$), and zero reverse trapping
- **Physical Dot Floor Audit** — 8-connected component labeling with inscribed disk radius ($R \ge \text{floorPx}/2$) catching sub-mesh debris while preserving continuous line art under Dual-Scale
- **Universal "Screens" Terminology** — Renamed `--format plates` to `--format screens`, writing `<image>_screen_NN_HEX.png` (with hidden deprecated `plates` alias retained for backward compatibility)

### Core Engine (`@electrosaur-labs/core`)

- **Configurable Rule of N** — Physical mesh floor scaling ($N = 4.0 \dots 10.0$, default 7.0) dynamically calculating minimum dot diameter from mesh count (TPI) and document DPI
- **Bimodal Variance Gating (BVG)** — Decouples macro-cell edge pixels from internal gradient quantization, eliminating phantom edge hue bleed on high-contrast contours
- **Wu Quantizer Chroma Parity** — Uniform sample weighting across all 0th, 1st, and 2nd order moments, preserving the sum-of-squares identity while enabling `vibrancyBoost`
- **Span-Based Despeckle** — Replaced raw-pixel area thresholds with true physical dot span ($R \ge \text{minSpanPx}/2$) and line-length survival

### Navigator Plugin (`@electrosaur-labs/navigator`)

- **Dedicated Credits Window** — Cinematic ambient crawl celebrating Doug Minkler, algorithmic pioneers (Wu, Heckbert, Atkinson, Floyd & Steinberg, Stucki, Bayer, Tomasi & Manduchi, Sharma), and production team
- **Doug Minkler Manifesto Easter Egg** — Dedicated silkscreen broadsheet viewer honoring political printmaking traditions
- **Multi-Tier Breadcrumb Navigation** — Natural Esc hierarchy (Manifesto → Credits → Navigator → dismiss) with light-dismiss backdrop support
- **Dynamic Rule of N Readout** — Real-time display showing effective physical pixel floor alongside N slider

---

## v1.0.0 (2026-03-06)

Initial public release.

### Core Engine (`@electrosaur-labs/core`)

- Lab median cut quantization with SALIENCY centroid strategy
- 26 archetypes with DNA-based automatic matching (40/45/15 scoring)
- Three distance metrics: CIE76, CIE94, CIE2000
- Dithering: Floyd-Steinberg, Atkinson, Bayer, Stucki
- Mechanical knobs: ghost screen removal, speckle rescue, shadow clamp, trapping
- Neutral sovereignty for white/gray background isolation
- Bilateral filter preprocessing (edge-preserving noise reduction)
- 8-bit and 16-bit Lab support
- Zero external dependencies

### Navigator Plugin (`@electrosaur-labs/navigator`)

- Real-time archetype exploration with live preview
- Archetype carousel with filter chips and sorting
- Palette surgery: click, ctrl+click, drag-merge, alt+delete, add
- Suggested color detection and injection
- Radar HUD with draggable parameter vertices
- Mechanical knobs panel with advanced controls
- Loupe with configurable magnification
- Production render to Lab fill+mask layers

### Batch Processor (`@electrosaur-labs/batch`)

- CLI batch processing for automated testing and benchmarking
- PSD input/output with Lab color support

### PSD I/O

- `@electrosaur-labs/psd-reader`: Minimal Lab PSD reader (pure JS, zero deps)
- `@electrosaur-labs/psd-writer`: 8/16-bit Lab PSD writer with fill+mask and pixel layers (pure JS, zero deps)
