/**
 * Minimal stand-in for the "photoshop" UXP host module, aliased in via
 * vitest.config.js. Only shaped enough for PhotoshopBridge.getDocumentInfo()
 * -- the one real dependency that keeps SessionState.buildManifest()
 * (the XMP manifest, which embeds the exact same palette-surgery data as
 * exportSavedConfig) from running at all under Node/vitest.
 *
 * Tests set `__mockDoc` to control what app.activeDocument returns; set it
 * to null to simulate no open document.
 */
const state = {
    __mockDoc: {
        name: 'test-document.psd',
        activeLayers: [{ name: 'Layer 1' }],
        mode: 'LabColor',
        width: 100,
        height: 100,
        resolution: 300,
        layers: [{}]
    }
};

module.exports = {
    get app() {
        return { get activeDocument() { return state.__mockDoc; } };
    },
    core: {},
    action: {},
    imaging: {},
    __setMockDoc(doc) { state.__mockDoc = doc; }
};
