/**
 * Engine Registry
 * Statically requires all declarative separation recipes from engines/*.json
 * so webpack can bundle them for UXP (no fs/path at runtime).
 * To add an engine: drop a JSON in engines/ and add a require() line here.
 */

const EngineRegistry = {
    register(id, description) {
        this[id] = description;
    },

    get(id) {
        return this[id];
    }
};

const engines = [
    require('../../../engines/aine.json'),
    require('../../../engines/anu.json'),
    require('../../../engines/brigid.json'),
    require('../../../engines/cailleach.json'),
    require('../../../engines/morrigan.json'),
    require('../../../engines/rhiannon.json'),
    require('../../../engines/rusalka.json'),
];

for (const recipe of engines) {
    EngineRegistry[recipe.id] = recipe;
}

module.exports = EngineRegistry;
