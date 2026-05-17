/**
 * Engine Registry
 * Dynamically loads all declarative separation recipes from engines/*.json.
 * Add or remove an engine by adding or removing its JSON file — no code changes needed.
 */

const fs = require('fs');
const path = require('path');

const ENGINES_DIR = path.resolve(__dirname, '../../../engines');

const EngineRegistry = {
    /**
     * Register a new engine recipe at runtime.
     */
    register(id, description) {
        this[id] = description;
    },

    /**
     * Get an engine recipe by ID.
     */
    get(id) {
        return this[id];
    }
};

// Load all JSON files from engines/ at startup
for (const file of fs.readdirSync(ENGINES_DIR)) {
    if (!file.endsWith('.json')) continue;
    const recipe = JSON.parse(fs.readFileSync(path.join(ENGINES_DIR, file), 'utf8'));
    EngineRegistry[recipe.id] = recipe;
}

module.exports = EngineRegistry;
