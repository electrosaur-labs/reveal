/**
 * LABSliderSync - Real-time LAB color panel synchronization
 *
 * "Sovereign" foundation for event-driven UI:
 * 1. Forces Photoshop Color Panel to LAB mode
 * 2. Listens for LAB slider changes
 * 3. Updates nearest palette color
 * 4. Triggers proxy re-render
 *
 * This creates the interactive loop:
 *   LAB slider drag → palette update → proxy render → preview update
 *
 * @module LABSliderSync
 */

const { app, action } = require('photoshop');

class LABSliderSync {
    constructor() {
        this.isEnabled = false;
        this.lastKnownLAB = null;
        this.pollInterval = null;
        this.sessionState = null;
    }

    /**
     * Initialize LAB slider sync
     * @param {SessionState} sessionState - Global session state
     */
    async initialize(sessionState) {
        console.log('[LABSliderSync] Initializing...');

        this.sessionState = sessionState;

        try {
            // Force Photoshop Color Panel to LAB mode
            await this._forceColorPanelToLAB();

            // Start polling for color changes
            // Note: UXP doesn't support true event listeners for color changes,
            // so we poll the foreground color
            this._startPolling();

            this.isEnabled = true;
            console.log('[LABSliderSync] ✓ Initialized - LAB sliders are now live');

        } catch (error) {
            console.error('[LABSliderSync] Initialization failed:', error);
            throw error;
        }
    }

    /**
     * Stop LAB slider sync
     */
    stop() {
        this.isPolling = false;
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout);
            this.pollTimeout = null;
        }
        this.isEnabled = false;
        console.log('[LABSliderSync] Stopped');
    }

    /**
     * Force Photoshop Color Panel to LAB mode
     * @private
     */
    async _forceColorPanelToLAB() {
        console.log('[LABSliderSync] Forcing Color Panel to LAB mode...');

        try {
            // Set foreground color mode to Lab
            await app.batchPlay([{
                _obj: 'set',
                _target: [{ _ref: 'application' }],
                to: {
                    _obj: 'application',
                    colorSettings: {
                        _obj: 'colorSettings',
                        colorMode: {
                            _enum: 'colorMode',
                            _value: 'labColor'
                        }
                    }
                }
            }], {});

            console.log('[LABSliderSync] ✓ Color Panel set to LAB mode');

        } catch (error) {
            // Fallback: try alternative method
            console.warn('[LABSliderSync] Primary method failed, trying alternative...');

            try {
                // Set foreground color to a LAB color (forces panel to LAB)
                await app.batchPlay([{
                    _obj: 'set',
                    _target: [{ _ref: 'color', _property: 'foregroundColor' }],
                    to: {
                        _obj: 'labColor',
                        luminance: 50,
                        a: 0,
                        b: 0
                    }
                }], {});

                console.log('[LABSliderSync] ✓ Color Panel forced to LAB via foreground color');

            } catch (fallbackError) {
                console.error('[LABSliderSync] Both methods failed:', fallbackError);
                throw fallbackError;
            }
        }
    }

    /**
     * Start polling for foreground color changes
     * @private
     */
    _startPolling() {
        console.log('[LABSliderSync] Starting color change polling (2000ms interval - non-intrusive)...');
        this.isPolling = true;

        // Use recursive setTimeout to avoid promise accumulation
        this._pollLoop();
    }

    /**
     * Recursive polling loop that waits for each check to complete
     * @private
     */
    async _pollLoop() {
        if (!this.isPolling) {
            return;
        }

        try {
            await this._checkColorChange();
        } catch (error) {
            // Silently ignore errors
        }

        // Schedule next poll after 2000ms (less aggressive to avoid UI blocking)
        if (this.isPolling) {
            this.pollTimeout = setTimeout(() => this._pollLoop(), 2000);
        }
    }

    /**
     * Check if foreground color has changed
     * @private
     */
    async _checkColorChange() {
        if (!this.sessionState || !this.sessionState.proxyEngine) {
            return;
        }

        try {
            // Get current foreground color in LAB
            const labColor = await this._getForegroundLAB();

            if (!labColor) {
                return;
            }

            // Check if color has changed significantly
            if (this._hasColorChanged(labColor)) {
                console.log(`[LABSliderSync] Color change detected: L=${labColor.L.toFixed(1)}, a=${labColor.a.toFixed(1)}, b=${labColor.b.toFixed(1)}`);

                // Update last known color
                this.lastKnownLAB = labColor;

                // Handle color change
                await this._handleColorChange(labColor);
            }

        } catch (error) {
            // Silently ignore errors during polling (common when Photoshop is busy)
            // Only log if it's persistent
        }
    }

    /**
     * Get foreground color in LAB
     * @private
     */
    async _getForegroundLAB() {
        try {
            const result = await app.batchPlay([{
                _obj: 'get',
                _target: [{ _ref: 'color', _property: 'foregroundColor' }],
                _options: { dialogOptions: 'dontDisplay' }
            }], {
                modalBehavior: 'fail',  // Fail silently instead of showing modal
                synchronousExecution: false
            });

            if (!result || !result[0]) {
                return null;
            }

            const colorData = result[0];

            // Check if it's LAB color
            if (colorData.labColor) {
                return {
                    L: colorData.labColor.luminance || 0,
                    a: colorData.labColor.a || 0,
                    b: colorData.labColor.b || 0
                };
            }

            // If not LAB, try to extract from other formats
            // (Photoshop might return RGB even if panel is LAB)
            return null;

        } catch (error) {
            return null;
        }
    }

    /**
     * Check if color has changed significantly
     * @private
     */
    _hasColorChanged(labColor) {
        if (!this.lastKnownLAB) {
            return true;
        }

        const THRESHOLD = 0.5; // Minimum ΔE to trigger update

        const dL = labColor.L - this.lastKnownLAB.L;
        const da = labColor.a - this.lastKnownLAB.a;
        const db = labColor.b - this.lastKnownLAB.b;

        const deltaE = Math.sqrt(dL * dL + da * da + db * db);

        return deltaE > THRESHOLD;
    }

    /**
     * Handle color change event
     * @private
     */
    async _handleColorChange(labColor) {
        console.log('[LABSliderSync] Handling color change...');

        try {
            // Get current palette from proxy state
            const palette = this.sessionState.getCurrentPalette();

            if (!palette || palette.length === 0) {
                console.warn('[LABSliderSync] No palette available');
                return;
            }

            // Find nearest color in palette
            const nearestIndex = this._findNearestColorIndex(palette, labColor);

            console.log(`[LABSliderSync] Updating color ${nearestIndex} in palette`);

            // Update that color in palette
            const newPalette = [...palette];
            newPalette[nearestIndex] = {
                L: labColor.L,
                a: labColor.a,
                b: labColor.b
            };

            // Trigger proxy re-render with updated palette
            await this.sessionState.proxyEngine.updateProxy({
                paletteOverride: newPalette
            });

            // Update preview canvas
            const proxyResult = {
                palette: newPalette,
                elapsedMs: 0
            };

            if (window.updatePreviewCanvas) {
                // updatePreviewCanvas will be called by the proxy update
                console.log(`[LABSliderSync] ✓ Color ${nearestIndex} updated`);
            }

        } catch (error) {
            console.error('[LABSliderSync] Failed to handle color change:', error);
        }
    }

    /**
     * Find nearest color index in palette
     * @private
     */
    _findNearestColorIndex(palette, labColor) {
        let minDist = Infinity;
        let nearestIdx = 0;

        for (let i = 0; i < palette.length; i++) {
            const color = palette[i];

            const dL = color.L - labColor.L;
            const da = color.a - labColor.a;
            const db = color.b - labColor.b;
            const dist = Math.sqrt(dL * dL + da * da + db * db);

            if (dist < minDist) {
                minDist = dist;
                nearestIdx = i;
            }
        }

        return nearestIdx;
    }

    /**
     * Manually update a palette color (for UI integration)
     * @param {number} colorIndex - Index in palette
     * @param {Object} labColor - New LAB color {L, a, b}
     */
    async updatePaletteColor(colorIndex, labColor) {
        console.log(`[LABSliderSync] Manual update: color ${colorIndex} → L=${labColor.L.toFixed(1)}, a=${labColor.a.toFixed(1)}, b=${labColor.b.toFixed(1)}`);

        const palette = this.sessionState.getCurrentPalette();

        if (!palette || colorIndex < 0 || colorIndex >= palette.length) {
            console.error('[LABSliderSync] Invalid color index');
            return;
        }

        const newPalette = [...palette];
        newPalette[colorIndex] = labColor;

        await this.sessionState.proxyEngine.updateProxy({
            paletteOverride: newPalette
        });

        console.log('[LABSliderSync] ✓ Manual update complete');
    }
}

// Export singleton instance
const labSliderSync = new LABSliderSync();

// CommonJS export for UXP
module.exports = { LABSliderSync, labSliderSync };
