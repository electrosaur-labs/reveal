# Reveal Project

**Pure JavaScript color separation engines for screen printing**

This is a monorepo containing:

- **[@reveal/core](packages/reveal-core/)** - Pure JavaScript color separation engines (posterization, separation, analysis)
- **[@reveal/adobe](packages/reveal-adobe/)** - Adobe Photoshop UXP plugin

## Architecture

The core engines are **100% pure JavaScript** with zero external dependencies. They perform perceptual color quantization using Lab color space and median cut algorithms.

### reveal-core (Pure Math)
- No file I/O
- No image format dependencies
- No Adobe/Photoshop dependencies
- Works in Node.js, browsers, and AI agents

### reveal-adobe (Photoshop Plugin)
- Wraps reveal-core with UXP adapter layer
- Handles Photoshop-specific I/O and layer creation
- Provides UI for parameter tuning

## Installation

```bash
# Install all workspace dependencies
npm install

# Run tests for core package
npm run test:core

# Build Adobe plugin
npm run build:adobe
```

## Development

This monorepo uses npm workspaces. Changes to `reveal-core` are automatically available to `reveal-adobe` during development.

```bash
# Work on core engines
cd packages/reveal-core
npm test

# Work on plugin
cd packages/reveal-adobe
npm run dev  # Watch mode
```

## License

GPL-3.0 - See LICENSE file
