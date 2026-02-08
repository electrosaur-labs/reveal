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
        console.log('[ProxyIntegration] Proxy result:', {
            hasPreviewBuffer: !!proxyResult.previewBuffer,
            bufferLength: proxyResult.previewBuffer?.length,
            paletteLength: proxyResult.palette?.length,
            dimensions: proxyResult.dimensions
        });

        if (window.updatePreviewCanvas) {
            window.updatePreviewCanvas(proxyResult.previewBuffer, proxyResult);
        }

        // 6. Initialize LAB slider sync (2-second polling, non-intrusive)
        const labSync = new LABSliderSync();
        await labSync.initialize(window.sessionState);
        window.labSliderSync = labSync;

        const elapsed = performance.now() - startTime;
        console.log(`[ProxyIntegration] ✓ Proxy mode active (${elapsed.toFixed(0)}ms)`);
        console.log(`[ProxyIntegration] 🎨 Manual Capture ready - adjust LAB sliders, then click "Capture LAB Color"`);

        return {
            success: true,
            proxyResult,
            elapsedMs: elapsed,
            message: 'Manual Capture ready - adjust LAB sliders, then click "Capture LAB Color"'
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
    console.log('[ProxyIntegration] Preview buffer length:', previewBuffer?.length);
    console.log('[ProxyIntegration] First 20 values:', previewBuffer?.slice(0, 20));

    const canvas = document.getElementById('previewCanvas');
    if (!canvas) {
        console.warn('[ProxyIntegration] Preview canvas not found');
        return;
    }

    const ctx = canvas.getContext('2d');

    // Debug: Check canvas element dimensions
    console.log(`[ProxyIntegration] Canvas element dimensions: ${canvas.width}×${canvas.height}`);
    console.log(`[ProxyIntegration] Canvas display size: ${canvas.offsetWidth}×${canvas.offsetHeight}`);

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

    // Clear canvas before redrawing
    ctx.clearRect(0, 0, width, height);
    console.log(`[ProxyIntegration] Canvas cleared`);

    // Sample first few pixels for debugging
    console.log(`[ProxyIntegration] First pixel: R=${previewBuffer[0]} G=${previewBuffer[1]} B=${previewBuffer[2]} A=${previewBuffer[3]}`);
    console.log(`[ProxyIntegration] Buffer length: ${previewBuffer.length} (expected: ${width * height * 4})`);

    // Draw pixels to canvas using scanline optimization
    // UXP doesn't support putImageData, so we use fillRect with horizontal runs
    // This is MUCH faster than pixel-by-pixel (typically 10-100x fewer draw calls)
    const drawStart = performance.now();
    console.log(`[ProxyIntegration] Drawing ${width}x${height} with scanline optimization...`);

    let totalRuns = 0;

    for (let y = 0; y < height; y++) {
        let x = 0;
        while (x < width) {
            const idx = (y * width + x) * 4;
            const r = previewBuffer[idx];
            const g = previewBuffer[idx + 1];
            const b = previewBuffer[idx + 2];
            const a = previewBuffer[idx + 3] / 255;

            // Find run length of consecutive pixels with same color
            let runLength = 1;
            while (x + runLength < width) {
                const nextIdx = (y * width + (x + runLength)) * 4;
                if (previewBuffer[nextIdx] === r &&
                    previewBuffer[nextIdx + 1] === g &&
                    previewBuffer[nextIdx + 2] === b &&
                    previewBuffer[nextIdx + 3] === previewBuffer[idx + 3]) {
                    runLength++;
                } else {
                    break;
                }
            }

            // Draw horizontal run (single fillRect for multiple pixels)
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
            ctx.fillRect(x, y, runLength, 1);

            totalRuns++;
            x += runLength;
        }
    }

    const drawTime = performance.now() - drawStart;
    console.log(`[ProxyIntegration] ✓ Canvas drawn: ${totalRuns} runs in ${drawTime.toFixed(0)}ms (${(179200 / totalRuns).toFixed(1)}x compression)`);

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
