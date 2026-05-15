/**
 * Orchestrator for the Pipeline/Filter architecture.
 * Executes a sequence of discrete mathematical operations.
 */
const PipelineState = require('./PipelineState');
const OperationFactory = require('./OperationFactory');
const LabEncoding = require('../../color/LabEncoding');

const { L_SCALE, AB_SCALE, LAB16_AB_NEUTRAL } = LabEncoding;

class PipelineEngine {
    /**
     * Execute a separation recipe asynchronously.
     * Yields to the UI thread during heavy operations (like nearest-neighbor mapping).
     * 
     * @param {Uint16Array} pixels16 - Raw Engine 16-bit Lab pixels (0-32768)
     * @param {Object} recipe - Compiled steps from EngineBuilder
     * @param {Object} config - Global configuration (can contain onProgress callback)
     * @returns {Promise<Object>} Final separation result
     */
    static async executeAsync(pixels16, recipe, config) {
        const state = new PipelineState(pixels16, config);

        // Convert raw 16-bit Lab to perceptual Float32 (L: 0-100, a/b: ±128) for
        // the working buffer. LabMedianCut and PaletteOps (which QuantizeOperation
        // and friends call into) expect this encoding. state.originalPixels stays
        // as the raw 16-bit source so MapOperation's mapPixelsToPalette — which
        // does its own internal 16-bit → perceptual conversion — receives what
        // it expects.
        const pixelsPerceptual = new Float32Array(pixels16.length);
        for (let i = 0; i < pixels16.length; i += 3) {
            pixelsPerceptual[i]     = pixels16[i] / L_SCALE;
            pixelsPerceptual[i + 1] = (pixels16[i + 1] - LAB16_AB_NEUTRAL) / AB_SCALE;
            pixelsPerceptual[i + 2] = (pixels16[i + 2] - LAB16_AB_NEUTRAL) / AB_SCALE;
        }
        state.pixels = pixelsPerceptual;

        const logger = config.logger || console;

        logger.log(`[PipelineEngine] Starting Async: ${recipe.name || 'Unnamed'}`);

        // 1. Instantiate the pipeline steps
        const operations = recipe.steps.map(stepDef => OperationFactory.create(stepDef));

        // 2. Linear Execution
        let currentState = state;
        const totalSteps = operations.length;
        
        for (let i = 0; i < totalSteps; i++) {
            const op = operations[i];
            
            // Inject scaled progress callback if requested
            if (config.onProgress) {
                const baseProgress = (i / totalSteps) * 100;
                const progressScale = 100 / totalSteps;
                config._stepProgress = (pct) => {
                    config.onProgress(baseProgress + (pct * progressScale / 100));
                };
            }

            // Operations can now return a Promise or synchronous result
            currentState = await op.execute(currentState, config);
            logger.log(`[PipelineEngine]   Step [${op.op}] complete. Palette: ${currentState.palette.length}`);
        }

        const elapsed = Date.now() - state.metadata.startTime;
        logger.log(`[PipelineEngine] Pipeline complete in ${elapsed}ms`);

        return {
            palette: currentState.palette,
            assignments: currentState.assignments,
            metadata: {
                ...currentState.metadata,
                elapsedMs: elapsed
            }
        };
    }

    /**
     * Legacy synchronous execution (DEPRECATED)
     * Maintained only for test suite compatibility.
     * @deprecated Use executeAsync instead
     */
    static execute(pixels16, recipe, config) {
        const state = new PipelineState(pixels16, config);

        const pixelsPerceptual = new Float32Array(pixels16.length);
        for (let i = 0; i < pixels16.length; i += 3) {
            pixelsPerceptual[i]     = pixels16[i] / L_SCALE;
            pixelsPerceptual[i + 1] = (pixels16[i + 1] - LAB16_AB_NEUTRAL) / AB_SCALE;
            pixelsPerceptual[i + 2] = (pixels16[i + 2] - LAB16_AB_NEUTRAL) / AB_SCALE;
        }
        state.pixels = pixelsPerceptual;

        const logger = config.logger || console;
        logger.log(`[PipelineEngine] Starting Sync: ${recipe.name || 'Unnamed'}`);

        const operations = recipe.steps.map(stepDef => OperationFactory.create(stepDef));
        let currentState = state;
        for (const op of operations) {
            // WARNING: If an operation is async, this will fail in sync mode.
            // Tests that trigger mapPixelsToPaletteAsync must use executeAsync.
            const result = op.execute(currentState, config);
            if (result instanceof Promise) {
                throw new Error(`PipelineEngine.execute: Operation '${op.op}' returned a Promise. Use executeAsync() instead.`);
            }
            currentState = result;
        }

        const elapsed = Date.now() - state.metadata.startTime;
        return {
            palette: currentState.palette,
            assignments: currentState.assignments,
            metadata: { ...currentState.metadata, elapsedMs: elapsed }
        };
    }
}

module.exports = PipelineEngine;
