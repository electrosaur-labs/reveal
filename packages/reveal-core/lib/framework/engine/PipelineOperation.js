/**
 * Base class for all pipeline operations.
 * Defines the standard interface for discrete mathematical steps.
 */
class PipelineOperation {
    /**
     * @param {Object} stepDef - The step definition from the JSON recipe
     */
    constructor(stepDef) {
        this.op = stepDef.op;
        // Merge top-level step properties with nested params for flexibility
        const { op, params, ...topLevelParams } = stepDef;
        this.params = { ...(params || {}), ...topLevelParams };
    }

    /**
     * Execute the operation on the current state.
     * @param {Object} state - The current pipeline state
     * @param {Object} config - Global configuration
     * @returns {Object} Updated state
     */
    execute(state, config) {
        throw new Error(`execute() not implemented for ${this.op}`);
    }
}

module.exports = PipelineOperation;
