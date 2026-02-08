/**
 * ProxyIntegration - Sovereign Foundation Integration
 *
 * Wires together:
 * - ProxyEngine (512px low-res posterization)
 * - SessionState (global parameter store)
 * - LABSliderSync (real-time color panel sync)
 *
 * Provides simple API for existing UI to enable proxy mode:
 *   await initializeProxyMode(labPixels, width, height, config)
 *   → LAB sliders become live
 *   → Preview updates in real-time
 *
 * @module ProxyIntegration
 */

const Reveal = require('@reveal/core');
const ProxyEngine = Reveal.ProxyEngine;
const PreviewEngine = Reveal.engines.PreviewEngine;
const { SessionState } = require('./SessionState');
const { LABSliderSync } = require('./LABSliderSync');

/**
 * Initialize proxy mode for real-time editing
 * @param {Uint16Array} labPixels - Source 16-bit LAB pixels
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {Object} config - Posterization configuration
 * @returns {Promise<Object>} Initialization result
 */
async function initializeProxyMode(labPixels, width, height, config) {
    console.log('[ProxyIntegration] Initializing proxy mode...');
    console.log(`[ProxyIntegration] Source: ${width}x${height}, ${labPixels.length} elements`);

    const startTime = performance.now();

    try {
        // 1. Initialize SessionState (if not already done)
        if (!window.sessionState) {
            window.sessionState = new SessionState();
        }

        // Store source metadata
        window.sessionState.setSourceMetadata({
            width,
            height,
            bitDepth: 16
        });

        // Update session parameters
        window.sessionState.updateParameters(config);

        // 2. Create ProxyEngine
        const proxyEngine = new ProxyEngine();

        // 3. Initialize proxy (downsample + initial posterization)
        console.log('[ProxyIntegration] Creating 512px proxy...');
        const proxyResult = await proxyEngine.initializeProxy(
            labPixels,
            width,
            height,
            config
        );

        console.log(`[ProxyIntegration] ✓ Proxy initialized: ${proxyResult.dimensions.width}x${proxyResult.dimensions.height}, ${proxyResult.palette.length} colors`);

        // 4. Attach proxy to session state
        window.sessionState.proxyEngine = proxyEngine;

        // 5. Update preview canvas with initial result
        if (window.updatePreviewCanvas) {
            window.updatePreviewCanvas(proxyResult.previewBuffer, proxyResult);
        }

        // 6. Initialize LAB slider sync (2-second polling, non-intrusive)
        const labSync = new LABSliderSync();
        await labSync.initialize(window.sessionState);
        window.labSliderSync = labSync;

        const elapsed = performance.now() - startTime;
        console.log(`[ProxyIntegration] ✓ Proxy mode active (${elapsed.toFixed(0)}ms)`);
        console.log(`[ProxyIntegration] 🎨 LAB slider sync active - adjust colors in Photoshop Color Panel (updates every 2s)`);

        return {
            success: true,
            proxyResult,
            elapsedMs: elapsed,
            message: 'LAB sliders are now live - adjust colors in Photoshop Color Panel'
        };

    } catch (error) {
        console.error('[ProxyIntegration] Initialization failed:', error);
        throw error;
    }
}

/**
 * Update preview canvas with proxy result
 * @param {Uint8ClampedArray} previewBuffer - RGBA preview buffer
 * @param {Object} proxyResult - Proxy result metadata
 */
function updatePreviewCanvas(previewBuffer, proxyResult) {
    console.log('[ProxyIntegration] Updating preview canvas...');

    const canvas = document.getElementById('previewCanvas');
    if (!canvas) {
        console.warn('[ProxyIntegration] Preview canvas not found');
        return;
    }

    const ctx = canvas.getContext('2d');

    // Get proxy dimensions from result or session state
    const width = proxyResult.dimensions?.width || window.sessionState?.proxyEngine?.separationState?.width;
    const height = proxyResult.dimensions?.height || window.sessionState?.proxyEngine?.separationState?.height;

    if (!width || !height) {
        console.error('[ProxyIntegration] Missing dimensions for preview');
        return;
    }

    // Resize canvas if needed
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        console.log(`[ProxyIntegration] Canvas resized to ${width}x${height}`);
    }

    // Create ImageData and draw to canvas
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(previewBuffer);
    ctx.putImageData(imageData, 0, 0);

    console.log(`[ProxyIntegration] ✓ Preview updated (${proxyResult.elapsedMs?.toFixed(1) || '?'}ms)`);

    // Update performance indicator if available
    if (document.getElementById('proxyPerformance')) {
        const perf = document.getElementById('proxyPerformance');
        perf.textContent = `${proxyResult.elapsedMs?.toFixed(1) || '?'}ms`;

        // Color code: green <30ms, yellow 30-60ms, red >60ms
        const ms = proxyResult.elapsedMs || 0;
        if (ms < 30) {
            perf.style.color = '#4CAF50';
        } else if (ms < 60) {
            perf.style.color = '#FFC107';
        } else {
            perf.style.color = '#f44336';
        }
    }
}

/**
 * Stop proxy mode and cleanup
 */
function stopProxyMode() {
    console.log('[ProxyIntegration] Stopping proxy mode...');

    if (window.labSliderSync) {
        window.labSliderSync.stop();
        window.labSliderSync = null;
    }

    if (window.sessionState) {
        window.sessionState.reset();
    }

    console.log('[ProxyIntegration] ✓ Proxy mode stopped');
}

/**
 * Check if proxy mode is active
 * @returns {boolean}
 */
function isProxyModeActive() {
    return !!(window.sessionState && window.sessionState.proxyEngine);
}

/**
 * Get current proxy state for debugging
 * @returns {Object}
 */
function getProxyState() {
    if (!window.sessionState || !window.sessionState.proxyEngine) {
        return { active: false };
    }

    const proxyEngine = window.sessionState.proxyEngine;
    const palette = window.sessionState.getCurrentPalette();

    return {
        active: true,
        dimensions: {
            width: proxyEngine.separationState?.width,
            height: proxyEngine.separationState?.height
        },
        colorCount: palette?.length || 0,
        parameters: window.sessionState.parameters,
        labSyncEnabled: window.labSliderSync?.isEnabled || false
    };
}

// Export global helper functions for browser console
if (typeof window !== 'undefined') {
    window.updatePreviewCanvas = updatePreviewCanvas;
    window.stopProxyMode = stopProxyMode;
    window.isProxyModeActive = isProxyModeActive;
    window.getProxyState = getProxyState;
}

// CommonJS export for UXP
module.exports = {
    initializeProxyMode,
    updatePreviewCanvas,
    stopProxyMode,
    isProxyModeActive,
    getProxyState
};
