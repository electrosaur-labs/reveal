/**
 * Engine Registry - Isolated in Engineer package
 * Loads declarative separation recipes from external JSON files.
 */

const EngineRegistry = {
    // --- Dynamic "Celtic Goddess" Engines ---
    'aine': require('../../../../reveal-core/engines/aine.json'),
    'anu': require('../../../../reveal-core/engines/anu.json'),
    'brigid': require('../../../../reveal-core/engines/brigid.json'),
    'cailleach': require('../../../../reveal-core/engines/cailleach.json'),
    'morrigan': require('../../../../reveal-core/engines/morrigan.json'),
    'rhiannon': require('../../../../reveal-core/engines/rhiannon.json'),

    // --- Legacy Reference Engines ---
    'mk15': require('../../../../reveal-core/engines/mk15.json'),
    'reveal-mk1.5-reference': require('../../../../reveal-core/engines/reveal-mk1.5-reference.json'),
    'reveal-mk1.0-reference': require('../../../../reveal-core/engines/reveal-mk1.0-reference.json'),

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

module.exports = EngineRegistry;
