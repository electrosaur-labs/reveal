/**
 * ExpressionEvaluator — Evaluate dynamic expressions in archetype parameters.
 *
 * String values in archetype JSON are treated as expressions and evaluated
 * against an image context. Non-string values pass through unchanged.
 *
 * Evaluation context:
 *   - image: { width, height, bitDepth, dna, sectors }
 *   - channels: current targetColors value
 *   - Math: standard JS Math object
 *
 * Expressions are pure — no assignments, no side effects, no imports.
 * Implemented via new Function() with a frozen scope.
 *
 * @module ExpressionEvaluator
 */

class ExpressionEvaluator {

    /**
     * Evaluate all string-valued parameters in a params object.
     * Non-string values pass through unchanged.
     *
     * @param {Object} params - Archetype parameters (may contain expression strings)
     * @param {Object} context - Evaluation context
     * @param {Object} context.image - { width, height, bitDepth, dna, sectors, filename }
     * @param {number} [context.channels] - Current targetColors (for self-referencing expressions)
     * @returns {Object} New params object with expressions resolved to values
     */
    static evaluate(params, context = {}) {
        const result = {};
        const image = context.image || {};
        const channels = context.channels || params.targetColors || 8;

        for (const [key, value] of Object.entries(params)) {
            if (typeof value === 'string' && this._isExpression(value)) {
                result[key] = this._evalExpression(value, image, channels, key);
            } else {
                result[key] = value;
            }
        }

        return result;
    }

    /**
     * Evaluate a single expression string.
     *
     * @param {string} expr - Expression string
     * @param {Object} image - Image context
     * @param {number} channels - Current targetColors
     * @param {string} paramName - Parameter name (for error messages)
     * @returns {*} Evaluated value
     */
    static _evalExpression(expr, image, channels, paramName) {
        try {
            // Build a function with restricted scope
            // Only image, channels, and Math are available
            const fn = new Function('image', 'channels', 'Math',
                `"use strict"; return (${expr});`
            );

            const value = fn(
                Object.freeze({ ...image }),
                channels,
                Math
            );

            if (value === undefined || value === null || Number.isNaN(value)) {
                throw new Error(`expression returned ${value}`);
            }

            return value;
        } catch (err) {
            throw new Error(
                `ExpressionEvaluator: failed to evaluate "${paramName}": "${expr}" — ${err.message}`
            );
        }
    }

    /**
     * Determine if a string value looks like an expression vs. a plain string enum.
     * Plain strings: "none", "floyd-steinberg", "SALIENCY", "cie76", etc.
     * Expressions: contain operators, function calls, or variable references.
     *
     * @param {string} value
     * @returns {boolean}
     */
    static _isExpression(value) {
        // If it references known context variables, it's an expression
        if (/\bimage\b/.test(value)) return true;
        if (/\bchannels\b/.test(value)) return true;
        if (/\bMath\b/.test(value)) return true;

        // If it contains operators or grouping, it's an expression
        // (but not just hyphens, which appear in "floyd-steinberg")
        if (/[+*/%<>=?:()!&|]/.test(value)) return true;

        // Plain enum string like "none", "floyd-steinberg", "SALIENCY",
        // "cie76", "reveal-mk1.5", "auto"
        return false;
    }
}

module.exports = ExpressionEvaluator;
