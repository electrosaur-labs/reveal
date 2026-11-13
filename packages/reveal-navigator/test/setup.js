/**
 * Vitest setup: patches Node's CJS resolver so `require("photoshop")`
 * resolves to a local stand-in instead of throwing MODULE_NOT_FOUND.
 * "photoshop" is the UXP host module -- it doesn't exist outside
 * Photoshop, so without this, any code path that touches PhotoshopBridge
 * (e.g. SessionState.buildManifest()) is permanently untestable.
 *
 * vitest.config.js's `resolve.alias` does not reach this: Vite's aliasing
 * only applies to its own SSR/ESM module graph, and this codebase's
 * nested `require()` calls (SessionState -> PhotoshopBridge -> "photoshop")
 * fall through to plain Node CJS resolution, which alias never touches.
 */
const Module = require('module');
const path = require('path');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'photoshop') {
        return path.resolve(__dirname, 'mocks/photoshop.js');
    }
    return originalResolveFilename.call(this, request, ...rest);
};
