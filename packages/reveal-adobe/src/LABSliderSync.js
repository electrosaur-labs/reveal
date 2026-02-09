/**
 * LABSliderSync - Manual LAB color capture for palette editing
 *
 * "Sovereign" foundation for event-driven UI:
 * 1. Forces Photoshop Color Panel to LAB mode
 * 2. Manual capture reads current foreground LAB color
 * 3. Updates nearest palette color
 * 4. Triggers proxy re-render
 *
 * This creates the interactive loop:
 *   LAB slider adjustment → "Capture" button click → palette update → proxy render → preview update
 *
 * Architecture: Queue-safe manual capture (not polling) to avoid Photoshop's single-threaded command queue conflicts
 *
 * @module LABSliderSync
 */

const { app, action } = require('photoshop');

class LABSliderSync {
    constructor() {
        this.isEnabled = false;
        this.lastKnownLAB = null;
        this.sessionState = null;
        this.isCapturing = false;  // Guard against multiple simultaneous captures
    }

    /**
     * Initialize LAB slider sync (Manual Capture mode)
     * @param {SessionState} sessionState - Global session state
     */
    async initialize(sessionState) {
        console.log('[LABSliderSync] Initializing Manual Capture mode...');

        this.sessionState = sessionState;

        try {
            // Force Photoshop Color Panel to LAB mode
            await this._forceColorPanelToLAB();

            this.isEnabled = true;
            console.log('[LABSliderSync] ✓ Initialized - Manual capture ready');
            console.log('[LABSliderSync] Adjust LAB sliders, then click "Capture LAB Color" to update palette');

        } catch (error) {
            console.error('[LABSliderSync] Initialization failed:', error);
            throw error;
        }
    }

    /**
     * Stop LAB slider sync (disable manual capture)
     */
    stop() {
        this.isEnabled = false;
        this.lastKnownLAB = null;
        console.log('[LABSliderSync] Stopped');
    }

    /**
     * Force Photoshop Color Panel to LAB mode
     * @private
     */
    async _forceColorPanelToLAB() {
        console.log('[LABSliderSync] Forcing Color Panel to LAB mode...');

        const { core } = require('photoshop');

        try {
            // Set foreground color mode to Lab (requires modal scope)
            await core.executeAsModal(async () => {
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
            }, { commandName: "Set Color Panel to LAB" });

            console.log('[LABSliderSync] ✓ Color Panel set to LAB mode');

        } catch (error) {
            // Fallback: try alternative method
            console.warn('[LABSliderSync] Primary method failed, trying alternative...');

            try {
                // Set foreground color to a LAB color (forces panel to LAB)
                await core.executeAsModal(async () => {
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
                }, { commandName: "Set Foreground Color to LAB" });

                console.log('[LABSliderSync] ✓ Color Panel forced to LAB via foreground color');

            } catch (fallbackError) {
                console.error('[LABSliderSync] Both methods failed:', fallbackError);
                throw fallbackError;
            }
        }
    }

    /**
     * Manually capture current foreground LAB color and update palette
     * This is the "Ink Dropper" - queue-safe, intentional color capture
     * @returns {Promise<Object>} Result with success status and captured color
     */
    async captureAndUpdatePalette() {
        // Guard against multiple simultaneous captures
        if (this.isCapturing) {
            console.log('[LABSliderSync] Capture already in progress, ignoring...');
            return {
                success: false,
                error: 'Capture already in progress'
            };
        }

        this.isCapturing = true;
        console.log('[LABSliderSync] Capturing foreground LAB color...');

        if (!this.sessionState || !this.sessionState.proxyEngine) {
            this.isCapturing = false;
            return {
                success: false,
                error: 'Proxy engine not initialized'
            };
        }

        try {
            // Get current foreground color in LAB
            const labColor = await this._getForegroundLAB();

            if (!labColor) {
                return {
                    success: false,
                    error: 'Could not read foreground color (ensure Color Panel is in LAB mode)'
                };
            }

            console.log(`[LABSliderSync] Captured: L=${labColor.L.toFixed(1)}, a=${labColor.a.toFixed(1)}, b=${labColor.b.toFixed(1)}`);

            // Update last known color
            this.lastKnownLAB = labColor;

            // Handle color change (find nearest, update palette, re-render)
            await this._handleColorChange(labColor);

            return {
                success: true,
                labColor,
                message: 'Palette updated successfully'
            };

        } catch (error) {
            console.error('[LABSliderSync] Capture failed:', error);
            return {
                success: false,
                error: error.message
            };
        } finally {
            this.isCapturing = false;
        }
    }

    /**
     * Get foreground color in LAB
     * @private
     */
    async _getForegroundLAB() {
        try {
            console.log('[LABSliderSync] Reading foreground color via direct property...');

            // Try using app.foregroundColor directly instead of batchPlay
            const fgColor = app.foregroundColor;
            console.log('[LABSliderSync] Foreground color object:', fgColor);
            console.log('[LABSliderSync] Color properties:', Object.keys(fgColor || {}));

            if (!fgColor) {
                console.warn('[LABSliderSync] No foreground color available');
                return null;
            }

            // Check what color model is available
            if (fgColor.lab) {
                console.log('[LABSliderSync] Has lab property:', fgColor.lab);
                return {
                    L: fgColor.lab.l || 0,
                    a: fgColor.lab.a || 0,
                    b: fgColor.lab.b || 0
                };
            }

            // If RGB, log it for debugging
            if (fgColor.rgb) {
                console.log('[LABSliderSync] Only has RGB:', fgColor.rgb);
            }

            console.warn('[LABSliderSync] Foreground color does not have LAB values');
            return null;

        } catch (error) {
            console.error('[LABSliderSync] Error reading foreground color:', error);
            return null;
        }
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
            const proxyResult = await this.sessionState.proxyEngine.updateProxy({
                paletteOverride: newPalette
            });

            console.log(`[LABSliderSync] ✓ Color ${nearestIndex} updated`);

            // Update preview canvas with new preview buffer
            if (window.updatePreviewCanvas && proxyResult.previewBuffer) {
                console.log(`[LABSliderSync] Updating preview canvas...`);
                window.updatePreviewCanvas(proxyResult.previewBuffer, proxyResult);
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
