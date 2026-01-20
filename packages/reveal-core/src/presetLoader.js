/**
 * presetLoader.js
 * Dynamically loads all presets from the presets directory
 */

const fs = require('fs');
const path = require('path');

/**
 * Load all preset files from the presets directory
 * @returns {Object} Map of preset ID to preset configuration
 */
function loadPresets() {
    const presetsDir = path.join(__dirname, '../presets');
    const presets = {};

    try {
        const files = fs.readdirSync(presetsDir).filter(f => f.endsWith('.json'));

        files.forEach(file => {
            try {
                const preset = require(path.join(presetsDir, file));
                if (preset.id) {
                    presets[preset.id] = preset;
                } else {
                    console.warn(`[presetLoader] Warning: Preset file ${file} has no id field`);
                }
            } catch (error) {
                console.error(`[presetLoader] Error loading preset ${file}:`, error.message);
            }
        });

        console.log(`[presetLoader] Loaded ${Object.keys(presets).length} presets from ${presetsDir}`);
    } catch (error) {
        console.error('[presetLoader] Error reading presets directory:', error.message);
    }

    return presets;
}

/**
 * Get list of all available preset IDs
 * @returns {string[]} Array of preset IDs
 */
function getPresetIds() {
    const presets = loadPresets();
    return Object.keys(presets);
}

module.exports = {
    loadPresets,
    getPresetIds
};
