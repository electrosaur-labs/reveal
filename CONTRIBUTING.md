# Contributing to Reveal

Thank you for your interest in contributing to Reveal! This guide covers everything you need to get started.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/electrosaur-labs/reveal/issues/new?template=bug_report.md) with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Image details (dimensions, bit depth, color mode) if relevant
- Console output or error messages

## Suggesting Features

Open a [Feature Request](https://github.com/electrosaur-labs/reveal/issues/new?template=feature_request.md). Screen printing domain context is especially welcome — we want the tool to match how printers actually work.

## Development Setup

```bash
git clone https://github.com/electrosaur-labs/reveal.git
cd reveal
npm install
npm run test:core    # Verify everything works
```

### Package Structure

- `packages/reveal-core/` — Pure JS engines (this is where most algorithm work happens)
- `packages/reveal-navigator/` — Photoshop UXP panel plugin
- `packages/reveal-batch/` — CLI batch processor

### Running Tests

```bash
npm run test:core                              # All core tests
cd packages/reveal-core && npm run test:watch  # Watch mode
```

### Building Plugins

```bash
npm run build:navigator   # Photoshop Navigator panel
npm run build:adobe       # Photoshop command dialog (legacy)
```

## Pull Request Workflow

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-change`)
3. Make your changes
4. Run `npm run test:core` — all tests must pass
5. Commit with a descriptive message
6. Open a Pull Request against `main`

### Commit Messages

Follow conventional commits style:

```
feat(core): add new dithering algorithm
fix(navigator): prevent palette override from disappearing
test(core): add integration test for CIE2000 metric
docs: update archetype documentation
```

## Code Conventions

There are no linters or formatters configured. Match the style of surrounding code:

- 4-space indentation
- Single quotes for strings
- `const` by default, `let` when reassignment is needed
- Descriptive variable names — clarity over brevity
- Comments for *why*, not *what*

## Hard Constraints

### `@electrosaur-labs/core` must have ZERO external dependencies

This is a non-negotiable architectural constraint. The core engines must remain 100% pure JavaScript so they can run in any environment — Node.js, browsers, Photoshop UXP, AI agents — without bundler configuration or polyfills.

If you need an external library, it belongs in an adapter package (`reveal-batch`, `reveal-navigator`), not in `reveal-core`.

### Lab Color Space

All color operations happen in CIELAB, not RGB. If you're adding color processing logic, work in Lab coordinates. See `packages/reveal-core/lib/color/LabDistance.js` for distance metrics and `LabEncoding.js` for encoding conversions.

### 16-bit Support

New features must handle both 8-bit and 16-bit Lab encoding:
- **8-bit:** L: 0–255, a/b: 0–255 (128 = neutral)
- **16-bit:** L: 0–32768, a/b: 0–32768 (16384 = neutral)

## Testing

- Add tests for new features and bug fixes
- Tests live in `packages/reveal-core/test/` (unit and integration)
- Test framework: [Vitest](https://vitest.dev/)
- Don't break existing tests — if a test needs updating, explain why in the PR

## Porting to Other Languages

If you're porting the Reveal engine to Python, Rust, or another language, read the [Mathematical Parity Guide](dev/MATHEMATICAL_PARITY.md) first. It defines the validation criteria, internal encoding requirements, and reference implementations for each stage of the pipeline.

The JS implementation is the source of truth. Ports must produce equivalent output — same palette sizes, visually identical masks, per-pixel deltaE < 0.5 — validated against the benchmark datasets (CQ100, TESTIMAGES, SP100).

## Questions?

Open a [Discussion](https://github.com/electrosaur-labs/reveal/discussions) or comment on the relevant issue.
