const PipelineOperation = require('../PipelineOperation');

/**
 * SnapLab: clip near-black pixels to pure black (L=0, a=b=0) and near-white
 * to pure white (L=100, a=b=0). Matches the pre-analysis snapping that the
 * reveal-core Mk1.0/Mk1.5 paths do inline at pixel ingest.
 *
 * Operates on state.pixels (Float32 perceptual — L: 0-100, a/b: ±128) as set
 * up by PipelineEngine entry normalization. Writes results into a fresh
 * Float32Array to keep operations downstream typed correctly.
 *
 * Params:
 *   shadowThreshold:     L below which a pixel becomes pure black (default 6.0)
 *   highlightThreshold:  L above which a pixel becomes pure white (default 98.0)
 */
class SnapLabOperation extends PipelineOperation {
    execute(state, config) {
        const pixels = state.pixels;
        const pixelCount = pixels.length / 3;

        const shadowThreshold = this.params.shadowThreshold !== undefined
            ? this.params.shadowThreshold : 6.0;
        const highlightThreshold = this.params.highlightThreshold !== undefined
            ? this.params.highlightThreshold : 98.0;

        const result = new Float32Array(pixels.length);

        for (let i = 0; i < pixelCount; i++) {
            const idx = i * 3;
            const L = pixels[idx];

            if (L < shadowThreshold) {
                result[idx] = 0;
                result[idx + 1] = 0;
                result[idx + 2] = 0;
            } else if (L > highlightThreshold) {
                result[idx] = 100;
                result[idx + 1] = 0;
                result[idx + 2] = 0;
            } else {
                result[idx]     = L;
                result[idx + 1] = pixels[idx + 1];
                result[idx + 2] = pixels[idx + 2];
            }
        }

        state.pixels = result;
        return state;
    }
}

module.exports = SnapLabOperation;
