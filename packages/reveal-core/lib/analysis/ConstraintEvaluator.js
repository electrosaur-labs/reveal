/**
 * ConstraintEvaluator - Safe expression evaluator for archetype constraints
 *
 * Evaluates expressions from archetype JSON constraints without using eval().
 * Uses a whitelist-based approach for security.
 *
 * Supported syntax:
 * - Comparisons: >, >=, <, <=, ===, !==
 * - Logic: &&, ||, !
 * - Arithmetic: +, -, *, /
 * - Property access: dna.yellowDominance, dna.sectors.yellow.lMean
 *
 * Example expressions:
 * - "yellowDominance > 20"
 * - "sectors.yellow.weight > 0.20 && sectors.yellow.lMean > 90"
 * - "spatial.entropy < 20 && sectors.yellow.weight > 0.10"
 */

class ConstraintEvaluator {
    constructor() {
        // Whitelist of allowed DNA properties (top-level legacy fields + v2.0 global fields)
        this.allowedTopLevelProperties = new Set([
            'l', 'c', 'k', 'l_std_dev',
            'maxC', 'maxCHue', 'minL', 'maxL',
            'yellowDominance', 'bitDepth',
            'dynamicRange', 'complexityScore', 'edgeDensity',
            'dominantHue', 'chromaticCoverage',
            // v2.0 global fields
            'neutralWeight', 'neutralLMean'
        ]);

        // Whitelist of allowed nested objects
        this.allowedNestedObjects = new Set([
            'global', 'sectors', 'spatial'
        ]);

        // Whitelist of sector names
        this.allowedSectors = new Set([
            'red', 'orange', 'yellow', 'chartreuse',
            'green', 'cyan', 'blue', 'violet',
            'purple', 'magenta', 'pink', 'crimson'
        ]);

        // Whitelist of sector properties
        this.allowedSectorProperties = new Set([
            'weight', 'coverage', 'lMean', 'lStdDev',
            'cMean', 'cMax', 'hMean'
        ]);

        // Whitelist of spatial properties
        this.allowedSpatialProperties = new Set([
            'entropy', 'edgeDensity', 'localContrast',
            'gradientMagnitude', 'microDNA'
        ]);
    }

    /**
     * Evaluate an expression against DNA data
     * @param {string} expression - Expression to evaluate
     * @param {Object} dna - DNA object
     * @returns {boolean} Result of evaluation
     */
    evaluate(expression, dna) {
        if (!expression || typeof expression !== 'string') {
            throw new Error('Expression must be a non-empty string');
        }

        if (!dna || typeof dna !== 'object') {
            throw new Error('DNA must be an object');
        }

        try {
            // Parse expression into tokens
            const tokens = this.tokenize(expression);

            // Validate and evaluate
            return this.evaluateTokens(tokens, dna);
        } catch (error) {
            throw new Error(`Failed to evaluate expression "${expression}": ${error.message}`);
        }
    }

    /**
     * Tokenize an expression into an array of tokens
     * @param {string} expression - Expression string
     * @returns {Array} Array of tokens
     */
    tokenize(expression) {
        const tokens = [];
        let current = '';
        let i = 0;

        while (i < expression.length) {
            const char = expression[i];

            // Skip whitespace
            if (/\s/.test(char)) {
                if (current) {
                    tokens.push(current);
                    current = '';
                }
                i++;
                continue;
            }

            // Multi-character operators
            if (char === '>' || char === '<' || char === '=' || char === '!') {
                if (current) {
                    tokens.push(current);
                    current = '';
                }

                // Check for >=, <=, ===, !==
                if (i + 1 < expression.length && expression[i + 1] === '=') {
                    if (char === '=' && i + 2 < expression.length && expression[i + 2] === '=') {
                        tokens.push('===');
                        i += 3;
                    } else if (char === '!' && i + 2 < expression.length && expression[i + 2] === '=') {
                        tokens.push('!==');
                        i += 3;
                    } else {
                        tokens.push(char + '=');
                        i += 2;
                    }
                } else if (char === '!') {
                    tokens.push('!');
                    i++;
                } else {
                    tokens.push(char);
                    i++;
                }
                continue;
            }

            // && and ||
            if (char === '&' && i + 1 < expression.length && expression[i + 1] === '&') {
                if (current) {
                    tokens.push(current);
                    current = '';
                }
                tokens.push('&&');
                i += 2;
                continue;
            }

            if (char === '|' && i + 1 < expression.length && expression[i + 1] === '|') {
                if (current) {
                    tokens.push(current);
                    current = '';
                }
                tokens.push('||');
                i += 2;
                continue;
            }

            // Single character operators and parentheses
            if ('()+-*/'.includes(char)) {
                if (current) {
                    tokens.push(current);
                    current = '';
                }
                tokens.push(char);
                i++;
                continue;
            }

            // Build up identifier or number
            current += char;
            i++;
        }

        if (current) {
            tokens.push(current);
        }

        return tokens;
    }

    /**
     * Evaluate tokenized expression
     * @param {Array} tokens - Token array
     * @param {Object} dna - DNA object
     * @returns {boolean} Evaluation result
     */
    evaluateTokens(tokens, dna) {
        // Convert to postfix notation (Shunting Yard algorithm)
        const postfix = this.toPostfix(tokens);

        // Evaluate postfix expression
        return this.evaluatePostfix(postfix, dna);
    }

    /**
     * Convert infix tokens to postfix notation (Shunting Yard)
     * @param {Array} tokens - Infix tokens
     * @returns {Array} Postfix tokens
     */
    toPostfix(tokens) {
        const output = [];
        const operators = [];
        const precedence = {
            '!': 4,
            '*': 3,
            '/': 3,
            '+': 2,
            '-': 2,
            '>': 1,
            '>=': 1,
            '<': 1,
            '<=': 1,
            '===': 1,
            '!==': 1,
            '&&': 0,
            '||': 0
        };

        const isOperator = (token) => token in precedence;
        const isRightAssociative = (token) => token === '!';

        for (const token of tokens) {
            if (token === '(') {
                operators.push(token);
            } else if (token === ')') {
                while (operators.length && operators[operators.length - 1] !== '(') {
                    output.push(operators.pop());
                }
                if (!operators.length) {
                    throw new Error('Mismatched parentheses');
                }
                operators.pop(); // Remove '('
            } else if (isOperator(token)) {
                while (
                    operators.length &&
                    operators[operators.length - 1] !== '(' &&
                    isOperator(operators[operators.length - 1]) &&
                    (
                        precedence[operators[operators.length - 1]] > precedence[token] ||
                        (precedence[operators[operators.length - 1]] === precedence[token] && !isRightAssociative(token))
                    )
                ) {
                    output.push(operators.pop());
                }
                operators.push(token);
            } else {
                // Operand (number, identifier, or property path)
                output.push(token);
            }
        }

        while (operators.length) {
            const op = operators.pop();
            if (op === '(' || op === ')') {
                throw new Error('Mismatched parentheses');
            }
            output.push(op);
        }

        return output;
    }

    /**
     * Evaluate postfix expression
     * @param {Array} postfix - Postfix tokens
     * @param {Object} dna - DNA object
     * @returns {boolean|number} Evaluation result
     */
    evaluatePostfix(postfix, dna) {
        const stack = [];

        for (const token of postfix) {
            if (token === '!') {
                if (stack.length < 1) throw new Error('Invalid expression: not enough operands for !');
                const operand = stack.pop();
                stack.push(!operand);
            } else if (['+', '-', '*', '/'].includes(token)) {
                if (stack.length < 2) throw new Error(`Invalid expression: not enough operands for ${token}`);
                const b = stack.pop();
                const a = stack.pop();
                switch (token) {
                    case '+': stack.push(a + b); break;
                    case '-': stack.push(a - b); break;
                    case '*': stack.push(a * b); break;
                    case '/':
                        if (b === 0) throw new Error('Division by zero');
                        stack.push(a / b);
                        break;
                }
            } else if (['>', '>=', '<', '<=', '===', '!=='].includes(token)) {
                if (stack.length < 2) throw new Error(`Invalid expression: not enough operands for ${token}`);
                const b = stack.pop();
                const a = stack.pop();
                switch (token) {
                    case '>': stack.push(a > b); break;
                    case '>=': stack.push(a >= b); break;
                    case '<': stack.push(a < b); break;
                    case '<=': stack.push(a <= b); break;
                    case '===': stack.push(a === b); break;
                    case '!==': stack.push(a !== b); break;
                }
            } else if (['&&', '||'].includes(token)) {
                if (stack.length < 2) throw new Error(`Invalid expression: not enough operands for ${token}`);
                const b = stack.pop();
                const a = stack.pop();
                switch (token) {
                    case '&&': stack.push(a && b); break;
                    case '||': stack.push(a || b); break;
                }
            } else {
                // Operand: resolve value from DNA
                stack.push(this.resolveValue(token, dna));
            }
        }

        if (stack.length !== 1) {
            throw new Error('Invalid expression: evaluation stack has multiple values');
        }

        return stack[0];
    }

    /**
     * Resolve a token to its value from DNA
     * @param {string} token - Token (number, property path)
     * @param {Object} dna - DNA object
     * @returns {number|boolean} Resolved value
     */
    resolveValue(token, dna) {
        // Check if it's a number
        if (/^-?\d+\.?\d*$/.test(token)) {
            return parseFloat(token);
        }

        // Check if it's a boolean
        if (token === 'true') return true;
        if (token === 'false') return false;

        // Property path (e.g., "yellowDominance" or "sectors.yellow.lMean")
        const parts = token.split('.');

        // Validate property path
        this.validatePropertyPath(parts);

        // Special handling for "sectors.any.*"
        // Returns the MAXIMUM value of that property across all sectors
        if (parts.length === 3 && parts[0] === 'sectors' && parts[1] === 'any') {
            const property = parts[2];
            const sectors = dna.sectors || {};

            let maxValue = -Infinity;
            let foundAny = false;

            for (const sectorName in sectors) {
                const sector = sectors[sectorName];
                if (sector && property in sector) {
                    const value = sector[property];
                    if (typeof value === 'number') {
                        maxValue = Math.max(maxValue, value);
                        foundAny = true;
                    }
                }
            }

            if (!foundAny) {
                throw new Error(`No sectors found with property "${property}"`);
            }

            return maxValue;
        }

        // Normal property path resolution
        let value = dna;
        for (const part of parts) {
            if (value === undefined || value === null) {
                throw new Error(`Property path "${token}" resolved to undefined/null at "${part}"`);
            }
            value = value[part];
        }

        if (value === undefined || value === null) {
            throw new Error(`Property "${token}" not found in DNA`);
        }

        return value;
    }

    /**
     * Validate a property path against whitelist
     * @param {Array} parts - Property path parts
     */
    validatePropertyPath(parts) {
        if (parts.length === 0) {
            throw new Error('Empty property path');
        }

        const first = parts[0];

        // Check top-level properties
        if (this.allowedTopLevelProperties.has(first)) {
            if (parts.length > 1) {
                throw new Error(`Top-level property "${first}" cannot have nested access`);
            }
            return;
        }

        // Check nested objects
        if (first === 'global') {
            if (parts.length === 1) {
                throw new Error('Cannot access "global" object directly, must specify property');
            }
            if (parts.length > 2) {
                throw new Error(`Global properties cannot have deep nesting: ${parts.join('.')}`);
            }
            if (!this.allowedTopLevelProperties.has(parts[1])) {
                throw new Error(`Unknown global property: ${parts[1]}`);
            }
            return;
        }

        if (first === 'sectors') {
            if (parts.length < 3) {
                throw new Error('Sector access requires format: sectors.<sector>.<property> or sectors.any.<property>');
            }
            if (parts.length > 3) {
                throw new Error(`Sector properties cannot have deep nesting: ${parts.join('.')}`);
            }

            // Special handling for "sectors.any.*" - checks if ANY sector meets condition
            if (parts[1] === 'any') {
                if (!this.allowedSectorProperties.has(parts[2])) {
                    throw new Error(`Unknown sector property: ${parts[2]}. Allowed: ${Array.from(this.allowedSectorProperties).join(', ')}`);
                }
                return;
            }

            // Normal sector access
            if (!this.allowedSectors.has(parts[1])) {
                throw new Error(`Unknown sector: ${parts[1]}. Allowed: ${Array.from(this.allowedSectors).join(', ')}, any`);
            }
            if (!this.allowedSectorProperties.has(parts[2])) {
                throw new Error(`Unknown sector property: ${parts[2]}. Allowed: ${Array.from(this.allowedSectorProperties).join(', ')}`);
            }
            return;
        }

        if (first === 'spatial') {
            if (parts.length === 1) {
                throw new Error('Cannot access "spatial" object directly, must specify property');
            }
            if (parts.length > 2) {
                throw new Error(`Spatial properties cannot have deep nesting: ${parts.join('.')}`);
            }
            if (!this.allowedSpatialProperties.has(parts[1])) {
                throw new Error(`Unknown spatial property: ${parts[1]}. Allowed: ${Array.from(this.allowedSpatialProperties).join(', ')}`);
            }
            return;
        }

        throw new Error(`Unknown property: ${first}. Not in whitelist.`);
    }
}

module.exports = ConstraintEvaluator;
