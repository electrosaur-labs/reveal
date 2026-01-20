# RevealEngine.js - Proposed Architecture

> **Status:** Design Proposal (Not Implemented)
> **Date:** 2026-01-20
> **Purpose:** Cleaner facade pattern for UXP plugin with state management

## Overview

This proposal outlines a refactored architecture for the reveal-adobe plugin that:
1. Provides a clean facade over existing engines
2. Implements state management for soft-delete operations
3. Enables instant preview updates without re-separation

## Current Architecture

The existing `index.js` (~127KB) handles:
- UI event binding
- DNA extraction via `DNAGenerator.js`
- Parameter generation via `@reveal/core/lib/analysis/ParameterGenerator`
- Posterization via `PosterizationEngine`
- Separation via `SeparationEngine`
- Photoshop layer creation via `PhotoshopAPI.js`

## Proposed Architecture

### RevealEngine.js (Facade)

```javascript
/**
 * RevealEngine.js (v1.3 - Production)
 * The UXP Adapter.
 * Integrates:
 * - Chroma Driver (Stingy Configurator)
 * - Context-Aware Validation
 * - Efficiency Penalties
 * - Saliency Rescue
 */

import { SepEngine } from './SepEngine';
import DynamicConfigurator from './DynamicConfigurator';
import MetricsCalculator from './MetricsCalculator';
import { ImageLoader } from './ImageLoader';
import { RemapTable } from './RemapTable'; // For Soft Deletes

export class RevealEngine {

    /**
     * PRIMARY ACTION: Process an image from scratch.
     * @param {Object} layer - The Photoshop layer/selection
     * @param {Object} options - { forceColors, forceDither }
     */
    static async process(layer, options = {}) {
        try {
            console.log("🚀 Engine: Analysis Started...");

            // 1. DNA EXTRACTION
            const image = await ImageLoader.fromLayer(layer);
            const dna = image.getDNA();

            // 2. CONFIGURATION (The "Chroma Driver")
            let config = DynamicConfigurator.generate(dna);

            // User Overrides
            if (options.forceColors) config.targetColors = options.forceColors;
            if (options.forceDither) config.ditherType = options.forceDither;

            console.log(`   ⚙️ Config: ${config.targetColors}c | ${config.ditherType}`);

            // 3. SEPARATION (16-bit Lab)
            const result = await SepEngine.process(image, config);

            // 4. VALIDATION (Context-Aware + Efficiency Penalty)
            const metrics = MetricsCalculator.compute(
                image.labData,
                result.labData,
                result.layers,
                image.width,
                image.height,
                dna,
                config
            );

            // 5. PACKAGING
            return {
                status: 'SUCCESS',
                // Metadata for the UI to display 'State'
                state: {
                    dna: dna,
                    config: config,
                    palette: result.palette, // Array of {l,a,b}
                    deletedIndices: new Set(), // Track user deletions
                    timestamp: Date.now()
                },
                // The heavy bitmaps
                layers: result.layers,
                // The full RGB preview
                preview: result.composite,
                // The Report Card
                report: {
                    integrity: metrics.physical_feasibility.integrityScore,
                    quality: metrics.feature_preservation.revelationScore,
                    warnings: this._generateWarnings(metrics, dna)
                }
            };

        } catch (e) {
            console.error("❌ Engine Error:", e);
            return { status: 'ERROR', message: e.message };
        }
    }

    /**
     * UI ACTION: Soft Delete a color.
     * Re-renders the preview instantly without re-running separation.
     * @param {Object} engineState - The 'state' object returned from process()
     * @param {number} indexToDelete - Index to hide
     * @returns {ImageData} New preview image
     */
    static async softDeleteColor(engineState, indexToDelete) {
        // Toggle deletion
        if (engineState.deletedIndices.has(indexToDelete)) {
            engineState.deletedIndices.delete(indexToDelete); // Undelete
        } else {
            engineState.deletedIndices.add(indexToDelete); // Delete
        }

        // Build Redirect Table (Route deleted pixels to nearest neighbor)
        const remapTable = RemapTable.build(engineState.palette, engineState.deletedIndices);

        // Re-Render Preview (Fast)
        // Note: You needs a renderPreview helper that takes the indexMap and remapTable
        return SepEngine.renderPreview(
             engineState.layers, // Needs access to raw index map
             engineState.palette,
             remapTable
        );
    }

    static _generateWarnings(metrics, dna) {
        const w = [];
        if (metrics.physical_feasibility.integrityScore < 60) {
            w.push({ type: 'CRITICAL', msg: 'Print Risk: High noise levels.' });
        }
        if (metrics.colors > 10) {
            w.push({ type: 'INFO', msg: 'High Color Cost: Consider reducing palette.' });
        }
        if (dna.c < 12 && dna.maxC > 50) {
            w.push({ type: 'SUCCESS', msg: 'Saliency Rescue: Outlier colors preserved.' });
        }
        return w;
    }
}
```

### RemapTable.js (Soft Delete Support)

```javascript
/**
 * RemapTable.js
 * Calculates where pixels go when their color bucket is deleted.
 */
export class RemapTable {
    static build(palette, deletedIndices) {
        const size = palette.length;
        const table = new Int8Array(size);

        // Find active survivors
        const survivors = [];
        for(let i=0; i<size; i++) {
            if(!deletedIndices.has(i)) survivors.push(i);
        }

        if (survivors.length === 0) return table.fill(0); // Safety

        // Build Table
        for (let i = 0; i < size; i++) {
            if (!deletedIndices.has(i)) {
                table[i] = i; // Map to self
            } else {
                // Find nearest survivor
                let min = Infinity;
                let nearest = survivors[0];
                const p1 = palette[i];

                for (let s of survivors) {
                    const p2 = palette[s];
                    const d = (p1.l-p2.l)**2 + (p1.a-p2.a)**2 + (p1.b-p2.b)**2;
                    if (d < min) { min = d; nearest = s; }
                }
                table[i] = nearest;
            }
        }
        return table;
    }
}
```

## Implementation Notes

### Mapping to Existing Code

| Proposed | Existing Equivalent |
|----------|---------------------|
| `SepEngine` | `@reveal/core/lib/engines/SeparationEngine` |
| `DynamicConfigurator` | `@reveal/core/lib/analysis/ParameterGenerator` |
| `MetricsCalculator` | `@reveal/batch/src/MetricsCalculator` (batch-only) |
| `ImageLoader.fromLayer()` | `DNAGenerator.js` + `PhotoshopAPI.js` |
| `RemapTable` | **New - not yet implemented** |

### Key Differences from Current Architecture

1. **State Management**: Current `index.js` doesn't persist state between operations
2. **Soft Delete**: Currently requires full re-separation; proposal enables instant preview
3. **Metrics in Plugin**: Currently only in batch; would need to port to core
4. **Facade Pattern**: Current code is procedural; proposal is object-oriented

### Migration Path

1. Extract `MetricsCalculator` from `reveal-batch` to `reveal-core`
2. Implement `RemapTable` in `reveal-core`
3. Create `RevealEngine` facade in `reveal-adobe`
4. Refactor `index.js` to use `RevealEngine` instead of direct engine calls
5. Add state management for soft-delete feature

## Benefits

- **Cleaner API**: Single entry point for all operations
- **Instant Soft Delete**: No re-separation needed for preview updates
- **Better State Management**: Track deletions, config, and results
- **Consistent Warnings**: Unified warning generation

## Deferred Until

- SP-50 dataset validation complete
- Current plugin stability confirmed
- User feedback on soft-delete priority
