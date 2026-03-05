/**
 * FormHelpers - Form reading/writing + static config constants
 *
 * No mutable state dependencies. Reads from DOM, writes to DOM.
 */

const Reveal = require("@electrosaur-labs/core");
const logger = Reveal.logger;
const PhotoshopAPI = require("./api/PhotoshopAPI");

/**
 * Slider configuration for value display formatting
 * Used by both dialog initialization and preset/analysis application
 */
const sliderConfigs = [
    { id: 'substrateTolerance', format: v => v.toFixed(1) },
    { id: 'lWeight', format: v => v.toFixed(1) },
    { id: 'cWeight', format: v => v.toFixed(1) },
    { id: 'blackBias', format: v => v.toFixed(1) },
    { id: 'vibrancyBoost', format: v => v.toFixed(1) },
    { id: 'highlightThreshold', format: v => v.toFixed(0) },
    { id: 'highlightBoost', format: v => v.toFixed(1) },
    { id: 'paletteReduction', format: v => v.toFixed(1) },
    { id: 'hueLockAngle', format: v => v.toFixed(0) },
    { id: 'shadowPoint', format: v => v.toFixed(0) },
    { id: 'targetColorsSlider', valueId: 'targetColorsValue', format: v => v.toFixed(0) },
    // Production Quality Controls
    { id: 'minVolume', format: v => v.toFixed(1) },
    { id: 'speckleRescue', format: v => v.toFixed(0) },
    { id: 'shadowClamp', format: v => v.toFixed(1) }
];

/**
 * Load all presets from JSON files
 * Note: Must be hardcoded for UXP/browser environment (no fs module)
 */
const PARAMETER_PRESETS = {
    'standard-image': require('@electrosaur-labs/core/presets/standard-image.json'),
    'halftone-portrait': require('@electrosaur-labs/core/presets/halftone-portrait.json'),
    'vibrant-graphic': require('@electrosaur-labs/core/presets/vibrant-graphic.json'),
    'atmospheric-photo': require('@electrosaur-labs/core/presets/atmospheric-photo.json'),
    'pastel-high-key': require('@electrosaur-labs/core/presets/pastel-high-key.json'),
    'vintage-muted': require('@electrosaur-labs/core/presets/vintage-muted.json'),
    'deep-shadow-noir': require('@electrosaur-labs/core/presets/deep-shadow-noir.json'),
    'neon-fluorescent': require('@electrosaur-labs/core/presets/neon-fluorescent.json'),
    'textural-grunge': require('@electrosaur-labs/core/presets/textural-grunge.json'),
    'commercial-offset': require('@electrosaur-labs/core/presets/commercial-offset.json'),
    'minkler-justice': require('@electrosaur-labs/core/presets/minkler-justice.json'),
    'warhol-pop': require('@electrosaur-labs/core/presets/warhol-pop.json'),
    'technical-enamel': require('@electrosaur-labs/core/presets/technical-enamel.json'),
    'punchy-commercial': require('@electrosaur-labs/core/presets/punchy-commercial.json'),
    'cinematic-moody': require('@electrosaur-labs/core/presets/cinematic-moody.json')
};

// Validate presets on load
Object.keys(PARAMETER_PRESETS).forEach(id => {
    const preset = PARAMETER_PRESETS[id];
    if (!preset.id || !preset.name || !preset.settings) {
        logger.error(`Invalid preset: ${id} - missing required fields`);
    }
});

/**
 * ARCHETYPES - DNA-driven parameter baselines
 * Each archetype contains complete 30-parameter specifications
 *
 * Auto-discovered from @electrosaur-labs/core/archetypes/ via webpack require.context().
 * Adding/removing archetype JSON files in reveal-core automatically updates this map.
 */
const archetypeContext = require.context('@electrosaur-labs/core/archetypes', false, /^\.\/(?!schema\b).*\.json$/);
const ARCHETYPES = {};
archetypeContext.keys().forEach(key => {
    const id = key.replace('./', '').replace('.json', '');
    ARCHETYPES[id] = archetypeContext(key);
});

// Validate archetypes on load
Object.keys(ARCHETYPES).forEach(id => {
    const archetype = ARCHETYPES[id];
    if (!archetype.id || !archetype.name || !archetype.parameters) {
        logger.error(`Invalid archetype: ${id} - missing required fields`);
    }
});
logger.log(`Loaded ${Object.keys(ARCHETYPES).length} archetypes (auto-discovered)`);

/**
 * Get mesh value from UI, handling custom input
 * @returns {number} Mesh TPI (0 = pixel-level)
 */
function getMeshValue() {
    const meshSelect = document.getElementById("meshSize");
    if (!meshSelect) return 0;

    if (meshSelect.value === "custom") {
        const customInput = document.getElementById("customMeshValue");
        return customInput ? parseInt(customInput.value, 10) || 0 : 0;
    }

    return parseInt(meshSelect.value, 10) || 0;
}

/**
 * Get current form values
 */
function getFormValues() {
    return {
        targetColors: parseInt(document.getElementById("targetColorsSlider").value),
        preserveWhite: document.getElementById("preserveWhite")?.checked ?? false,
        preserveBlack: document.getElementById("preserveBlack")?.checked ?? false,
        ignoreTransparent: document.getElementById("ignoreTransparent")?.checked ?? true,
        enableHueGapAnalysis: document.getElementById("enableHueGapAnalysis")?.checked ?? true,
        engineType: document.getElementById("engineType")?.value ?? "reveal-mk1.5",
        centroidStrategy: document.getElementById("centroidStrategy")?.value ?? "SALIENCY",
        colorMode: document.getElementById("colorMode")?.value ?? "color",
        substrateMode: document.getElementById("substrateMode")?.value ?? "white",
        substrateTolerance: parseFloat(document.getElementById("substrateTolerance")?.value ?? 3.5),
        vibrancyMode: document.getElementById("vibrancyMode")?.value ?? "moderate",
        vibrancyBoost: parseFloat(document.getElementById("vibrancyBoost")?.value ?? 1.6),
        highlightThreshold: parseInt(document.getElementById("highlightThreshold")?.value ?? 85),
        highlightBoost: parseFloat(document.getElementById("highlightBoost")?.value ?? 1.0),
        hueLockAngle: parseFloat(document.getElementById("hueLockAngle")?.value ?? 20),
        shadowPoint: parseFloat(document.getElementById("shadowPoint")?.value ?? 15),
        lWeight: parseFloat(document.getElementById("lWeight")?.value ?? 1.0),
        cWeight: parseFloat(document.getElementById("cWeight")?.value ?? 1.0),
        blackBias: parseFloat(document.getElementById("blackBias")?.value ?? 5.0),
        enablePaletteReduction: document.getElementById("enablePaletteReduction")?.checked ?? true,
        paletteReduction: parseFloat(document.getElementById("paletteReduction")?.value ?? 10.0),
        ditherType: document.getElementById("ditherType")?.value ?? "none",
        mesh: getMeshValue(),
        ppi: PhotoshopAPI.getDocumentInfo()?.resolution || 72,
        distanceMetric: document.getElementById("distanceMetric")?.value ?? "cie94",
        preprocessingIntensity: document.getElementById("preprocessingIntensity")?.value ?? "auto",
        minVolume: parseFloat(document.getElementById("minVolume")?.value ?? 0),
        speckleRescue: parseInt(document.getElementById("speckleRescue")?.value ?? 0),
        shadowClamp: parseFloat(document.getElementById("shadowClamp")?.value ?? 0)
    };
}

/**
 * Validate form inputs
 */
function validateForm() {
    const values = getFormValues();
    const errors = [];

    if (values.targetColors < 1 || values.targetColors > 20) {
        errors.push("Target Colors must be between 1 and 20");
    }

    return errors;
}

/**
 * Map analyzer parameter names to actual form element IDs
 *
 * @param {Object} analyzerSettings - Settings from ImageHeuristicAnalyzer
 * @returns {Object} - Mapped settings with correct form IDs
 */
function mapAnalyzerSettings(analyzerSettings) {
    const mapped = { ...analyzerSettings };

    if ('whitePoint' in mapped) {
        mapped.highlightThreshold = mapped.whitePoint;
        delete mapped.whitePoint;
    }

    if ('blackPoint' in mapped) {
        mapped.shadowPoint = mapped.blackPoint;
        delete mapped.blackPoint;
    }

    if ('snapThreshold' in mapped) {
        mapped.paletteReduction = mapped.snapThreshold;
        delete mapped.snapThreshold;
    }

    return mapped;
}

/**
 * Apply analyzed settings to form controls
 * Follows same pattern as Reset to Defaults handler
 *
 * @param {Object} settings - Settings object with form IDs as keys
 */
function applyAnalyzedSettings(settings) {

    Object.keys(settings).forEach(key => {
        const element = document.getElementById(key);
        if (!element) {
            return;
        }

        const value = settings[key];

        try {
            if (element.type === 'checkbox') {
                element.checked = value;

            } else if (element.tagName === 'SELECT') {
                element.value = value;
                element.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value } }));

            } else if (element.tagName === 'SP-SLIDER') {
                element.value = value;

                const valueDisplay = document.getElementById(`${key}Value`);
                if (valueDisplay) {
                    const config = sliderConfigs.find(c => c.id === key);
                    if (config) {
                        valueDisplay.textContent = config.format(value);
                    } else {
                        valueDisplay.textContent = value.toString();
                    }
                }

                element.dispatchEvent(new CustomEvent('input', { bubbles: true, detail: { value } }));
                element.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value } }));
            }
        } catch (error) {
            logger.error(`Failed to apply setting ${key}=${value}:`, error);
        }
    });

}

module.exports = {
    sliderConfigs,
    PARAMETER_PRESETS,
    ARCHETYPES,
    getFormValues,
    getMeshValue,
    validateForm,
    mapAnalyzerSettings,
    applyAnalyzedSettings
};
