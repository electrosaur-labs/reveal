/**
 * INTEGRATION_SNIPPET.js
 *
 * Add this single line to index.js after UI initialization (around line 4870):
 *
 * ```javascript
 * // Enable Proxy Mode Test Harness (Sovereign Foundation)
 * const { ProxyModeTestHarness } = require('./ProxyModeTestHarness');
 * ProxyModeTestHarness.attach();
 * ```
 *
 * This adds a "Test Proxy Mode" button to the UI that:
 * 1. Reads current document at 512px
 * 2. Initializes ProxyEngine
 * 3. Enables LAB slider sync
 * 4. Updates preview in real-time when you adjust LAB sliders
 *
 * Test workflow:
 * 1. Open Photoshop document (Lab mode)
 * 2. Open Reveal plugin
 * 3. Click "🎨 Test Proxy Mode" button
 * 4. Open Photoshop Color Panel (Window → Color)
 * 5. Ensure Color Panel is in LAB mode
 * 6. Drag L, a, or b sliders
 * 7. Watch preview update in real-time!
 *
 * Debug commands (browser console):
 * - window.getProxyState() - View current proxy state
 * - window.debugProxyState() - Detailed debug info
 * - window.stopProxyMode() - Stop proxy mode
 */

// This file is documentation only - see instructions above
