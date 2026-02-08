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
        console.log('[ProxyModeTestHarness] Attaching test harness...');

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
            this.showStatus('Proxy mode stopped', 'info');
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

        console.log('[ProxyModeTestHarness] ✓ Test harness attached');
    }

    /**
     * Run proxy mode test
     */
    static async runProxyTest() {
        console.log('[ProxyModeTestHarness] Starting proxy mode test...');

        const btnTestProxy = document.getElementById('btnTestProxy');
        const btnStopProxy = document.getElementById('btnStopProxy');

        try {
            // Show loading state
            btnTestProxy.disabled = true;
            btnTestProxy.textContent = 'Initializing...';
            this.showStatus('Reading document...', 'info');

            // 1. Get document info for debugging
            const { app } = require('photoshop');
            const doc = app.activeDocument;

            console.log('[ProxyModeTestHarness] Document info:');
            console.log('  mode:', doc.mode);
            console.log('  mode type:', typeof doc.mode);
            console.log('  bitsPerChannel:', doc.bitsPerChannel);
            console.log('  dimensions:', doc.width, 'x', doc.height);
            console.log('  layers:', doc.layers?.length);

            // Validate document
            const validation = PhotoshopAPI.validateDocument();

            console.log('[ProxyModeTestHarness] Validation result:', validation);

            if (!validation.valid) {
                // Show error but continue anyway for debugging
                this.showStatus('⚠️ Validation warning (continuing anyway): ' + validation.errors[0], 'warning');
                console.warn('[ProxyModeTestHarness] Validation errors (bypassing for debug):', validation.errors);

                // Check if it's actually a Lab document by trying to read pixels
                console.log('[ProxyModeTestHarness] Attempting to read pixels anyway...');
            }

            // 2. Read document pixels at 512px (matches proxy resolution)
            this.showStatus('Reading pixels (512px)...', 'info');
            const pixelData = await PhotoshopAPI.getDocumentPixels(512, 512);

            console.log(`[ProxyModeTestHarness] Read ${pixelData.width}x${pixelData.height} pixels`);

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

            // Show performance indicator
            document.getElementById('proxyPerformanceContainer').style.display = 'block';

            // Open Photoshop Color Panel (if possible)
            try {
                await this.openColorPanel();
            } catch (e) {
                console.warn('[ProxyModeTestHarness] Could not open Color Panel automatically:', e);
            }

            // Log instructions
            console.log('\n' + '='.repeat(60));
            console.log('🎨 PROXY MODE ACTIVE');
            console.log('='.repeat(60));
            console.log('Instructions:');
            console.log('1. Open Photoshop Color Panel (Window → Color)');
            console.log('2. Ensure it\'s in LAB mode');
            console.log('3. Adjust L, a, or b sliders');
            console.log('4. Watch the preview update in real-time!');
            console.log('='.repeat(60) + '\n');

        } catch (error) {
            console.error('[ProxyModeTestHarness] Test failed:', error);
            this.showStatus(`Error: ${error.message}`, 'error');

        } finally {
            btnTestProxy.disabled = false;
            btnTestProxy.textContent = '🎨 Test Proxy Mode';
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
            engineType: 'reveal',
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
            // Try to open Color panel
            await app.batchPlay([{
                _obj: 'select',
                _target: [{ _ref: 'menuItemClass', _enum: 'menuItemType', _value: 'color' }]
            }], {});

            console.log('[ProxyModeTestHarness] ✓ Color Panel opened');

        } catch (error) {
            // Panel may already be open, or command not available
            console.log('[ProxyModeTestHarness] Could not open Color Panel automatically');
        }
    }

    /**
     * Debug: Get current proxy state
     */
    static debugProxyState() {
        const state = getProxyState();
        console.log('\n' + '='.repeat(60));
        console.log('PROXY STATE DEBUG');
        console.log('='.repeat(60));
        console.log('Active:', state.active);
        if (state.active) {
            console.log('Dimensions:', state.dimensions);
            console.log('Color Count:', state.colorCount);
            console.log('LAB Sync Enabled:', state.labSyncEnabled);
            console.log('Parameters:', state.parameters);
        }
        console.log('='.repeat(60) + '\n');
    }
}

// Export for console debugging
if (typeof window !== 'undefined') {
    window.ProxyModeTestHarness = ProxyModeTestHarness;
    window.debugProxyState = () => ProxyModeTestHarness.debugProxyState();
}

// CommonJS export for UXP
module.exports = { ProxyModeTestHarness };
