# Reveal: Contributor Technical Checklist (v1.0)

You don't need to know color science or screen printing to contribute. We'll help you with all of that. What matters is solid programming skills and a willingness to learn the domain as you go.

This checklist isn't a gate — it's a map of the territory so you know what's ahead. If you can't check a box yet, that's what the reference implementation and the [Mathematical Parity Guide](MATHEMATICAL_PARITY.md) are for. Ask questions in [Discussions](https://github.com/electrosaur-labs/reveal/discussions) — we're friendly.

## 1. Data Integrity & Bit-Depth
- [ ] **16-bit Pipeline:** Comfortable working with `uint16` data end-to-end without downsampling to 8-bit?
- [ ] **Precision Awareness:** Understand why normalizing 16-bit signals to 0.0–1.0 floats too early can introduce rounding errors in quantization?

## 2. Color Science
- [ ] **Lab Color Space:** Familiar with CIELAB coordinates ($L^*a^*b^*$), or willing to learn? The [Mathematical Parity Guide](MATHEMATICAL_PARITY.md) Section 1 covers the encoding.
- [ ] **Color Distance:** Understand the difference between CIE76, CIE94, and CIE2000? (See `lib/color/LabDistance.js` for reference implementations.)
- [ ] **Hue Analysis:** Comfortable with polar coordinates and histograms? The DNA system uses a 12-sector hue breakdown — see `lib/analysis/DNAGenerator.js`.

## 3. Algorithmic Implementation
- [ ] **Quantization:** Have experience with spatial partitioning or clustering algorithms? The core uses Wu variance-minimizing quantization — see `lib/engines/LabMedianCut.js`.
- [ ] **Error Diffusion:** Familiar with dithering concepts? Atkinson, Floyd-Steinberg, etc. are documented in `lib/engines/DitheringStrategies.js`.
- [ ] **Image Processing Basics:** Comfortable with pixel buffers, masks, and array manipulation at scale?

## 4. Systems & Tooling
- [ ] **NumPy / Array Computing:** For Python ports — comfortable with vectorized operations on large arrays?
- [ ] **Zero Dependencies:** The core engine has zero external dependencies by design. Ports should aim for minimal dependencies in the core module.
- [ ] **Benchmarking:** Willing to validate your output against the **CQ100**, **TESTIMAGES**, and **SP100** benchmark datasets? Parity criteria: per-pixel deltaE < 0.5, identical palette sizes, identical mask topology.

## Getting Started

Don't check every box before jumping in. The best way to learn is to:

1. Read the [Mathematical Parity Guide](MATHEMATICAL_PARITY.md)
2. Pick one stage of the pipeline (e.g., RGB→Lab conversion, or the DNA fingerprint)
3. Implement it, validate against the JS output, and open a draft PR

We're happy to review work-in-progress. Questions welcome in [Discussions](https://github.com/electrosaur-labs/reveal/discussions).
