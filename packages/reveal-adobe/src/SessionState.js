/**
 * SessionState - Global parameter store for event-driven UI
 *
 * Ensures proxy and production renders use identical settings.
 * Single source of truth for all posterization parameters.
 *
 * @module SessionState
 */

class SessionState {
    constructor() {
        this.parameters = {
            // Core posterization
            targetColors: 8,
            engineType: 'reveal-mk1.5',
            centroidStrategy: 'SALIENCY',
            distanceMetric: 'cie76',

            // Print quality knobs (critical)
            minVolume: 0.0,          // Ghost plate threshold (0-5%)
            speckleRescue: 0,        // Halftone solidity (0-10px)
            shadowClamp: 0.0,        // Ink body control (0-20%)

            // Tuning
            lWeight: 1.1,
            cWeight: 2.0,
            vibrancyBoost: 1.6,
            paletteReduction: 9.0,

            // Advanced
            substrateMode: 'auto',
            ditherType: 'none',
            bilateralFilter: true,

            // Archetype
            archetype: null
        };

        this.proxyEngine = null;
        this.productionRenderPending = false;
        this.productionResult = null;

        // Source image metadata
        this.sourceMetadata = {
            width: 0,
            height: 0,
            bitDepth: 16
        };
    }

    /**
     * Update a single parameter
     * @param {string} key - Parameter name
     * @param {*} value - New value
     */
    updateParameter(key, value) {
        this.parameters[key] = value;
    }

    /**
     * Update multiple parameters at once
     * @param {Object} changes - Key-value pairs of parameter changes
     */
    updateParameters(changes) {
        Object.assign(this.parameters, changes);
    }

    /**
     * Trigger proxy update with changed parameters
     * @param {Array<string>} changedKeys - Parameter keys that changed
     */
    async triggerProxyUpdate(changedKeys) {
        if (!this.proxyEngine) {
            console.warn('[SessionState] ProxyEngine not initialized');
            return;
        }

        try {
            // Update proxy with only changed parameters
            const changes = this.getChangedParams(changedKeys);
            const proxyResult = await this.proxyEngine.updateProxy(changes);

            // Update preview canvas
            if (window.updatePreviewCanvas) {
                window.updatePreviewCanvas(proxyResult.previewBuffer, proxyResult);
            }

            // Update dashboard
            if (window.updateDashboard) {
                window.updateDashboard(proxyResult);
            }

            return proxyResult;

        } catch (error) {
            console.error('[SessionState] Proxy update failed:', error);
            if (window.showToast) {
                window.showToast(`Proxy update failed: ${error.message}`, 'error');
            }
            throw error;
        }
    }

    /**
     * Get changed parameters as object
     * @param {Array<string>} keys - Parameter keys
     * @returns {Object} Parameter values
     */
    getChangedParams(keys) {
        const changes = {};
        keys.forEach(key => {
            changes[key] = this.parameters[key];
        });
        return changes;
    }

    /**
     * Export full configuration for production render
     * @returns {Object} Complete posterization config
     */
    exportProductionConfig() {
        return {
            ...this.parameters,
            width: this.sourceMetadata.width,
            height: this.sourceMetadata.height,
            bitDepth: this.sourceMetadata.bitDepth
        };
    }

    /**
     * Set source image metadata
     * @param {Object} metadata - Width, height, bitDepth
     */
    setSourceMetadata(metadata) {
        this.sourceMetadata = {
            width: metadata.width,
            height: metadata.height,
            bitDepth: metadata.bitDepth || 16
        };
    }

    /**
     * Reset session state
     */
    reset() {
        this.proxyEngine = null;
        this.productionRenderPending = false;
        this.productionResult = null;
    }

    /**
     * Get current palette from proxy state
     * @returns {Array|null} LAB palette
     */
    getCurrentPalette() {
        if (!this.proxyEngine || !this.proxyEngine.separationState) {
            return null;
        }
        return this.proxyEngine.separationState.palette;
    }

    /**
     * Get current statistics from proxy state
     * @returns {Object|null} Statistics
     */
    getCurrentStatistics() {
        if (!this.proxyEngine || !this.proxyEngine.separationState) {
            return null;
        }
        return this.proxyEngine.separationState.statistics || {};
    }
}

// Global singleton
if (typeof window !== 'undefined') {
    window.sessionState = new SessionState();
}

// CommonJS export for UXP
module.exports = { SessionState };
