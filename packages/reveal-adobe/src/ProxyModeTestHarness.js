/**
 * ProxyModeTestHarness - Minimal integration for testing Sovereign Foundation
 *
 * Adds "Test Proxy Mode" button to existing UI.
 * Call from index.js after UI initialization:
 *   ProxyModeTestHarness.attach();
 *
 * Test workflow:
 * 1. Click "Test Proxy Mode" button
 * 2. Reads current document at 512px
 * 3. Initializes ProxyEngine
 * 4. Enables LAB slider sync
 * 5. Opens Photoshop Color Panel
 * 6. Adjust LAB sliders → see preview update in real-time
 *
 * @module ProxyModeTestHarness
 */

const { initializeProxyMode, stopProxyMode, getProxyState } = require('./ProxyIntegration');
const PhotoshopAPI = require('./api/PhotoshopAPI');
const logger = require('@reveal/core').logger;

class ProxyModeTestHarness {
    /**
     * Attach test harness to existing UI
     */
    static attach() {
        // Add test button to main dialog (after btnPosterize)
        const btnPosterize = document.getElementById('btnPosterize');
        if (!btnPosterize) {
            console.warn('[ProxyModeTestHarness] btnPosterize not found, cannot attach');
            return;
        }

        // Create test button
        const btnTestProxy = document.createElement('sp-button');
        btnTestProxy.id = 'btnTestProxy';
        btnTestProxy.variant = 'secondary';
        btnTestProxy.textContent = '🎨 Test Proxy Mode';
        btnTestProxy.style.marginLeft = '10px';

        // Insert after posterize button
        btnPosterize.parentElement.insertBefore(btnTestProxy, btnPosterize.nextSibling);

        // Add event listener
        btnTestProxy.addEventListener('click', async () => {
            await this.runProxyTest();
        });

        // Add stop button
        const btnStopProxy = document.createElement('sp-button');
        btnStopProxy.id = 'btnStopProxy';
        btnStopProxy.variant = 'secondary';
        btnStopProxy.textContent = '⏹ Stop Proxy';
        btnStopProxy.style.marginLeft = '10px';
        btnStopProxy.style.display = 'none';

        btnPosterize.parentElement.insertBefore(btnStopProxy, btnTestProxy.nextSibling);

        btnStopProxy.addEventListener('click', () => {
            stopProxyMode();
            btnTestProxy.style.display = '';
            btnStopProxy.style.display = 'none';
            const btnCapture = document.getElementById('btnCaptureLAB');
            if (btnCapture) btnCapture.style.display = 'none';

            // Hide preview canvas and performance indicator
            const perfContainer = document.getElementById('proxyPerformanceContainer');
            if (perfContainer) perfContainer.style.display = 'none';
            const previewContainer = document.getElementById('proxyPreviewContainer');
            if (previewContainer) previewContainer.style.display = 'none';

            this.showStatus('Proxy mode stopped', 'info');
        });

        // Add "Capture LAB Color" button (The Ink Dropper)
        const btnCaptureLAB = document.createElement('sp-button');
        btnCaptureLAB.id = 'btnCaptureLAB';
        btnCaptureLAB.variant = 'accent';
        btnCaptureLAB.textContent = '🎨 Capture LAB Color';
        btnCaptureLAB.style.marginLeft = '10px';
        btnCaptureLAB.style.display = 'none';

        btnPosterize.parentElement.insertBefore(btnCaptureLAB, btnStopProxy.nextSibling);

        btnCaptureLAB.addEventListener('click', async () => {
            await this.captureLABColor();
        });

        // Add status indicator
        const statusDiv = document.createElement('div');
        statusDiv.id = 'proxyModeStatus';
        statusDiv.style.cssText = 'margin: 10px 0; padding: 8px; border-radius: 4px; display: none;';
        btnPosterize.parentElement.insertBefore(statusDiv, btnPosterize.nextSibling);

        // Add performance indicator
        const perfDiv = document.createElement('div');
        perfDiv.id = 'proxyPerformanceContainer';
        perfDiv.style.cssText = 'margin: 10px 0; padding: 8px; font-family: monospace; display: none;';
        perfDiv.innerHTML = 'Proxy update: <span id="proxyPerformance">--</span>';
        btnPosterize.parentElement.insertBefore(perfDiv, btnPosterize.nextSibling);

        // Add preview canvas for proxy visualization
        const canvasContainer = document.createElement('div');
        canvasContainer.id = 'proxyPreviewContainer';
        canvasContainer.style.cssText = 'margin: 10px 0; padding: 8px; display: none; text-align: center; background: #2c2c2c; border-radius: 4px; min-height: 300px;';

        const canvas = document.createElement('canvas');
        canvas.id = 'previewCanvas';
        canvas.style.cssText = 'max-width: 100%; max-height: 512px; image-rendering: auto; display: block;';

        canvasContainer.appendChild(canvas);
        btnPosterize.parentElement.insertBefore(canvasContainer, btnPosterize.nextSibling);
    }

    /**
     * Run proxy mode test
     */
    static async runProxyTest() {
        const btnTestProxy = document.getElementById('btnTestProxy');
        const btnStopProxy = document.getElementById('btnStopProxy');

        try {
            // Show loading state
            btnTestProxy.disabled = true;
            btnTestProxy.textContent = 'Initializing...';
            this.showStatus('Reading document...', 'info');

            // 1. Get document info
            const { app } = require('photoshop');
            const doc = app.activeDocument;

            // Validate document
            const validation = PhotoshopAPI.validateDocument();

            if (!validation.valid) {
                this.showStatus('⚠️ Validation warning (continuing anyway): ' + validation.errors[0], 'warning');
            }

            // 2. Read document pixels at 512px (matches proxy resolution)
            this.showStatus('Reading pixels (512px)...', 'info');
            const pixelData = await PhotoshopAPI.getDocumentPixels(512, 512);

            // 3. Get current form values for config
            const config = this.getTestConfig();

            // 4. Initialize proxy mode
            this.showStatus('Initializing proxy engine...', 'info');
            const result = await initializeProxyMode(
                pixelData.pixels,
                pixelData.width,
                pixelData.height,
                config
            );

            // 5. Show success
            this.showStatus(
                `✓ Proxy mode active (${result.elapsedMs.toFixed(0)}ms) - Adjust LAB sliders in Photoshop Color Panel`,
                'success'
            );

            // Update buttons
            btnTestProxy.style.display = 'none';
            btnStopProxy.style.display = '';
            document.getElementById('btnCaptureLAB').style.display = '';

            // Show performance indicator and preview canvas
            const perfContainer = document.getElementById('proxyPerformanceContainer');
            const previewContainer = document.getElementById('proxyPreviewContainer');

            if (perfContainer) perfContainer.style.display = 'block';
            if (previewContainer) previewContainer.style.display = 'block';

            // Open Photoshop Color Panel (if possible)
            try {
                await this.openColorPanel();
            } catch (e) {
                // Panel may already be open
            }

        } catch (error) {
            console.error('[ProxyModeTestHarness] Test failed:', error);
            this.showStatus(`Error: ${error.message}`, 'error');

        } finally {
            btnTestProxy.disabled = false;
            btnTestProxy.textContent = '🎨 Test Proxy Mode';
        }
    }

    /**
     * Capture current LAB color and update palette (Manual Capture mode)
     */
    static async captureLABColor() {
        const btnCapture = document.getElementById('btnCaptureLAB');

        try {
            // Disable button during capture
            btnCapture.disabled = true;
            btnCapture.textContent = 'Capturing...';

            // Ensure LAB slider sync is initialized
            if (!window.labSliderSync || !window.labSliderSync.isEnabled) {
                this.showStatus('LAB slider sync not initialized', 'error');
                return;
            }

            // Capture and update palette
            const result = await window.labSliderSync.captureAndUpdatePalette();

            if (result.success) {
                const { L, a, b } = result.labColor;
                this.showStatus(
                    `✓ Captured L=${L.toFixed(1)} a=${a.toFixed(1)} b=${b.toFixed(1)} - Palette updated`,
                    'success'
                );
            } else {
                this.showStatus(`⚠️ ${result.error}`, 'error');
            }

        } catch (error) {
            console.error('[ProxyModeTestHarness] Capture failed:', error);
            this.showStatus(`Error: ${error.message}`, 'error');

        } finally {
            btnCapture.disabled = false;
            btnCapture.textContent = '🎨 Capture LAB Color';
        }
    }

    /**
     * Get test configuration
     */
    static getTestConfig() {
        // Try to get values from existing form, fall back to defaults
        const targetColors = parseInt(document.getElementById('targetColors')?.value || '8', 10);

        return {
            targetColors: targetColors,
            engineType: 'reveal-mk1.5',
            centroidStrategy: 'SALIENCY',
            distanceMetric: 'cie76',
            format: 'lab',          // CRITICAL: Tell engine this is Lab data
            minVolume: 0.0,
            speckleRescue: 0,
            shadowClamp: 0.0,
            lWeight: 1.1,
            cWeight: 2.0,
            vibrancyBoost: 1.6,
            paletteReduction: 9.0,
            substrateMode: 'auto',
            ditherType: 'none',
            bilateralFilter: true,
            bitDepth: 16
        };
    }

    /**
     * Show status message
     */
    static showStatus(message, type = 'info') {
        const statusDiv = document.getElementById('proxyModeStatus');
        if (!statusDiv) return;

        statusDiv.style.display = 'block';
        statusDiv.textContent = message;

        // Color coding
        const colors = {
            info: { bg: '#2196F3', text: '#fff' },
            success: { bg: '#4CAF50', text: '#fff' },
            error: { bg: '#f44336', text: '#fff' },
            warning: { bg: '#FFC107', text: '#000' }
        };

        const color = colors[type] || colors.info;
        statusDiv.style.backgroundColor = color.bg;
        statusDiv.style.color = color.text;
    }

    /**
     * Open Photoshop Color Panel
     */
    static async openColorPanel() {
        const { app } = require('photoshop');

        try {
            await app.batchPlay([{
                _obj: 'select',
                _target: [{ _ref: 'menuItemClass', _enum: 'menuItemType', _value: 'color' }]
            }], {});
        } catch (error) {
            // Panel may already be open, or command not available
        }
    }

    /**
     * Debug: Get current proxy state
     */
    static debugProxyState() {
        return getProxyState();
    }
}

// Export for console debugging
if (typeof window !== 'undefined') {
    window.ProxyModeTestHarness = ProxyModeTestHarness;
    window.debugProxyState = () => ProxyModeTestHarness.debugProxyState();
}

// CommonJS export for UXP
module.exports = { ProxyModeTestHarness };
