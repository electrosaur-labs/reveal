/**
 * Engine Registry - Isolated in Engineer package
 * Loads declarative separation recipes from external JSON files.
 */

const EngineRegistry = {
    // --- Dynamic "Celtic Goddess" Engines ---
    'aine': require('../../../engines/aine.json'),
    'anu': require('../../../engines/anu.json'),
    'brigid': require('../../../engines/brigid.json'),
    'cailleach': require('../../../engines/cailleach.json'),
    'morrigan': require('../../../engines/morrigan.json'),
    'rhiannon': require('../../../engines/rhiannon.json'),

    // --- Direct Access Engines ---
    'median-cut-direct': require('../../../engines/median-cut-direct.json'),
    'wu-direct': require('../../../engines/wu-direct.json'),
    'distilled-saliency': require('../../../engines/distilled-saliency.json'),
    'perceptual-optimizer': require('../../../engines/perceptual-optimizer.json'),

    // --- Production & Reference ---
    'production-reveal': require('../../../engines/production-reveal.json'),
    'jethro-print': require('../../../engines/jethro-print.json'),
    'reveal-mk1.5': require('../../../engines/reveal-mk1.5.json'),
    'reveal-mk1.5-reference': require('../../../engines/reveal-mk1.5-reference.json'),
    'reveal-mk1.0-reference': require('../../../engines/reveal-mk1.0-reference.json'),

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
