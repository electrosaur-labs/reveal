const PipelineOperation = require('../PipelineOperation');

/**
 * Cull: Temporarily disabled (noop) per Architect guidance.
 */
class CullOperation extends PipelineOperation {
    execute(state, config) {
        // --- NOOP ---
        // Just return state unchanged.
        return state;
    }
}

module.exports = CullOperation;
