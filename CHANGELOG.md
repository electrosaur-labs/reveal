# Changelog

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
