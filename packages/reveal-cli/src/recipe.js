/**
 * recipe.js — Recipe file reader/writer
 *
 * A recipe is a JSON file that defines separation parameters
 * for repeatable workflows.
 *
 * @module recipe
 */

const fs = require('fs');

const VALID_FIELDS = new Set([
    'archetype', 'colors', 'trap', 'minVolume',
    'speckleRescue', 'shadowClamp', 'outputs', 'outputDir'
]);

const VALID_OUTPUTS = new Set(['flat', 'psd', 'ora', 'plates']);

/**
 * Load and validate a recipe from a JSON file.
 *
 * @param {string} filePath - Path to recipe JSON
 * @returns {Object} Validated recipe object
 */
function loadRecipe(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Recipe file not found: ${filePath}`);
    }

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        throw new Error(`Invalid recipe JSON: ${err.message}`);
    }

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('Recipe must be a JSON object');
    }

    // Warn about unknown fields
    for (const key of Object.keys(raw)) {
        if (!VALID_FIELDS.has(key)) {
            process.stderr.write(`Warning: unknown recipe field "${key}" ignored\n`);
        }
    }

    const recipe = {};

    if (raw.archetype !== undefined) {
        if (typeof raw.archetype !== 'string') throw new Error('Recipe "archetype" must be a string');
        recipe.archetype = raw.archetype;
    }

    if (raw.colors !== undefined) {
        const c = Number(raw.colors);
        if (!Number.isInteger(c) || c < 2 || c > 10) throw new Error('Recipe "colors" must be 2-10');
        recipe.colors = c;
    }

    if (raw.trap !== undefined) {
        const t = Number(raw.trap);
        if (!Number.isFinite(t) || t < 0) throw new Error('Recipe "trap" must be >= 0');
        recipe.trap = t;
    }

    if (raw.minVolume !== undefined) {
        const v = Number(raw.minVolume);
        if (!Number.isFinite(v) || v < 0 || v > 5) throw new Error('Recipe "minVolume" must be 0-5');
        recipe.minVolume = v;
    }

    if (raw.speckleRescue !== undefined) {
        const s = Number(raw.speckleRescue);
        if (!Number.isFinite(s) || s < 0 || s > 10) throw new Error('Recipe "speckleRescue" must be 0-10');
        recipe.speckleRescue = s;
    }

    if (raw.shadowClamp !== undefined) {
        const s = Number(raw.shadowClamp);
        if (!Number.isFinite(s) || s < 0 || s > 20) throw new Error('Recipe "shadowClamp" must be 0-20');
        recipe.shadowClamp = s;
    }

    if (raw.outputs !== undefined) {
        if (!Array.isArray(raw.outputs)) throw new Error('Recipe "outputs" must be an array');
        for (const o of raw.outputs) {
            if (!VALID_OUTPUTS.has(o)) throw new Error(`Recipe "outputs" contains invalid value "${o}". Valid: ${[...VALID_OUTPUTS].join(', ')}`);
        }
        recipe.outputs = raw.outputs;
    }

    if (raw.outputDir !== undefined) {
        if (typeof raw.outputDir !== 'string') throw new Error('Recipe "outputDir" must be a string');
        recipe.outputDir = raw.outputDir;
    }

    return recipe;
}

/**
 * Save effective parameters to a recipe file.
 *
 * @param {string} filePath - Output path
 * @param {Object} params - Effective parameters to save
 */
function saveRecipe(filePath, params) {
    const recipe = {};
    if (params.archetype) recipe.archetype = params.archetype;
    if (params.colors !== undefined) recipe.colors = params.colors;
    if (params.trap !== undefined && params.trap > 0) recipe.trap = params.trap;
    if (params.minVolume !== undefined) recipe.minVolume = params.minVolume;
    if (params.speckleRescue !== undefined) recipe.speckleRescue = params.speckleRescue;
    if (params.shadowClamp !== undefined) recipe.shadowClamp = params.shadowClamp;
    if (params.outputs) recipe.outputs = params.outputs;
    if (params.outputDir) recipe.outputDir = params.outputDir;

    fs.writeFileSync(filePath, JSON.stringify(recipe, null, 2) + '\n');
}

/**
 * Merge recipe with CLI options. CLI wins.
 */
function mergeRecipeWithCli(recipe, cliOptions) {
    const merged = { ...recipe };
    for (const [key, value] of Object.entries(cliOptions)) {
        if (value !== undefined) merged[key] = value;
    }
    return merged;
}

module.exports = { loadRecipe, saveRecipe, mergeRecipeWithCli };
