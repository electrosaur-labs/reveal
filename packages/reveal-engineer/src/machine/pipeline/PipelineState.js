/**
 * Pipeline State
 * Encapsulates all data passed between discrete pipeline operations.
 */
class PipelineState {
    /**
     * @param {Float32Array|Uint16Array} pixels - Raw Lab pixels
     * @param {Object} config - Global configuration (width, height, etc)
     */
    constructor(pixels, config) {
        this.originalPixels = pixels; // Constant source
        this.pixels = pixels;         // Work buffer (may be modified)
        this.palette = [];
        this.assignments = null;
        this.substrate = null;
        this.metadata = {
            width: config.width,
            height: config.height,
            startTime: Date.now()
        };
    }

    /**
     * Helper to clone state if needed for pure transitions
     */
    clone() {
        const newState = new PipelineState(this.originalPixels, this.metadata);
        newState.pixels = this.pixels;
        newState.palette = [...this.palette];
        newState.assignments = this.assignments;
        newState.substrate = this.substrate;
        newState.metadata = { ...this.metadata };
        return newState;
    }
}

module.exports = PipelineState;
