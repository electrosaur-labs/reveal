/**
 * PluginState - Singleton mutable state for the Reveal plugin
 *
 * All module-level `let` variables that were previously in index.js
 * are now centralized here. Every module that needs shared state
 * requires this singleton.
 */

const pluginState = {
    /** Store posterization results for preview */
    posterizationData: null,

    /**
     * Last image DNA analysis result (used for "Smart Reveal" auto mode)
     * Stores { maxC, l_std_dev, c, k, minL, maxL, archetype } from analysis
     */
    lastImageDNA: null,

    /** Complete config from ParameterGenerator (includes all parameters) */
    lastGeneratedConfig: null,

    /** Manually selected archetype ID (bypasses DNA matching) */
    lastSelectedArchetypeId: null,

    /**
     * Zoom preview state (tile managers, viewport tracker, renderer)
     * Initialized when zoom preview dialog is opened
     */
    zoomPreviewState: null,

    /** Track if event listeners have been set up */
    listenersAttached: false,

    /** Track if plugin is initialized */
    isInitialized: false
};

module.exports = pluginState;
