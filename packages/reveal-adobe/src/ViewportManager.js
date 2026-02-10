/**
 * ViewportManager - Coordination Handshake for 1:1 Loupe System
 *
 * Manages the relationship between:
 * - Full Canvas (e.g., 2400px high-res source)
 * - Navigator Thumbnail (compositional map)
 * - 1:1 Loupe (800x800 mechanical diagnostic viewport)
 *
 * Key principle: Use normalized center point (0.0-1.0) as the anchor.
 * This keeps the viewport synchronized across different image sizes.
 *
 * @module ViewportManager
 */

class ViewportManager {
    constructor(cropEngine, options = {}) {
        this.cropEngine = cropEngine;

        // Normalized center point (0.0 to 1.0)
        this.center = { x: 0.5, y: 0.5 };

        // Viewport dimensions (Elastic Portal - dynamic based on container)
        this.viewportWidth = 800;   // Default, will be set by ResizeObserver
        this.viewportHeight = 800;  // Default, will be set by ResizeObserver

        // Current view mode
        this.viewMode = 'fit'; // 'fit' or '1:1'

        // Mechanical parameters (for real-time application to loupe)
        this.mechanicalParams = {
            minVolume: 0,
            speckleRescue: 0,
            shadowClamp: 0
        };
    }

    /**
     * Set viewport dimensions (Elastic Portal)
     * Called by ResizeObserver when container size changes
     *
     * @param {number} width - New viewport width
     * @param {number} height - New viewport height
     */
    setViewportDimensions(width, height) {
        this.viewportWidth = Math.floor(width);
        this.viewportHeight = Math.floor(height);

        // Update crop engine dimensions
        if (this.cropEngine) {
            this.cropEngine.setViewportDimensions(this.viewportWidth, this.viewportHeight);
        }
    }

    /**
     * Extract the 800x800 pixel array for the 1:1 Loupe
     * Uses normalized center to calculate crop bounds
     *
     * @returns {Promise<Object>} Loupe buffer and crop info
     */
    async getLoupeBuffer() {
        if (!this.cropEngine || !this.cropEngine.sourceBuffer) {
            throw new Error('CropEngine not initialized');
        }

        // CRITICAL FIX: Use actualDocWidth/Height (full document), NOT sourceWidth/Height (downsampled preview)
        // This must match _syncCropEngineViewport() to avoid coordinate mismatch
        const fullWidth = this.cropEngine.actualDocWidth;
        const fullHeight = this.cropEngine.actualDocHeight;

        if (!fullWidth || !fullHeight) {
            console.error('[ViewportManager] actualDocWidth/Height not set on CropEngine!');
            throw new Error('CropEngine actualDocWidth/Height not initialized');
        }

        // Convert normalized center to absolute pixel coordinates
        const centerX = this.center.x * fullWidth;
        const centerY = this.center.y * fullHeight;

        // Calculate crop bounds (top-left corner)
        let startX = Math.floor(centerX - this.viewportWidth / 2);
        let startY = Math.floor(centerY - this.viewportHeight / 2);

        // Constrain to image bounds
        startX = Math.max(0, Math.min(fullWidth - this.viewportWidth, startX));
        startY = Math.max(0, Math.min(fullHeight - this.viewportHeight, startY));

        // Update crop engine viewport position
        this.cropEngine.viewportX = startX;
        this.cropEngine.viewportY = startY;

        // Extract and process crop
        const cropResult = await this.cropEngine.extractCrop(this.mechanicalParams);

        return {
            buffer: cropResult.previewBuffer,
            cropX: startX,
            cropY: startY,
            cropWidth: cropResult.cropWidth,
            cropHeight: cropResult.cropHeight,
            normalizedCenter: { ...this.center }
        };
    }

    /**
     * Pan viewport by delta pixels
     * Updates normalized center based on absolute pixel movement
     *
     * @param {number} deltaX - Horizontal movement in pixels
     * @param {number} deltaY - Vertical movement in pixels
     */
    pan(deltaX, deltaY) {
        const fullWidth = this.cropEngine.sourceWidth;
        const fullHeight = this.cropEngine.sourceHeight;

        // Convert delta to normalized space
        const normDeltaX = deltaX / fullWidth;
        const normDeltaY = deltaY / fullHeight;

        // Update normalized center
        this.center.x = Math.max(0, Math.min(1, this.center.x + normDeltaX));
        this.center.y = Math.max(0, Math.min(1, this.center.y + normDeltaY));

        // CRITICAL FIX: Update CropEngine viewport position for Navigator Map
        this._syncCropEngineViewport();
    }

    /**
     * Jump to specific normalized coordinates (from Navigator Map click)
     *
     * @param {number} normX - Normalized X (0.0-1.0)
     * @param {number} normY - Normalized Y (0.0-1.0)
     */
    jumpToNormalized(normX, normY) {
        this.center.x = Math.max(0, Math.min(1, normX));
        this.center.y = Math.max(0, Math.min(1, normY));

        // CRITICAL FIX: Update CropEngine viewport position for Navigator Map
        this._syncCropEngineViewport();
    }

    /**
     * Sync CropEngine viewport position from normalized center
     * Must be called whenever center changes to keep Navigator Map accurate
     * @private
     */
    _syncCropEngineViewport() {
        if (!this.cropEngine) return;

        // CRITICAL FIX: Use actualDocWidth/Height (full document), NOT sourceWidth/Height (downsampled preview)
        const fullWidth = this.cropEngine.actualDocWidth;
        const fullHeight = this.cropEngine.actualDocHeight;

        if (!fullWidth || !fullHeight) {
            return;
        }

        // Convert normalized center to absolute pixel coordinates
        const centerX = this.center.x * fullWidth;
        const centerY = this.center.y * fullHeight;

        // Calculate crop bounds (top-left corner)
        let startX = Math.floor(centerX - this.viewportWidth / 2);
        let startY = Math.floor(centerY - this.viewportHeight / 2);

        // Constrain to image bounds
        startX = Math.max(0, Math.min(fullWidth - this.viewportWidth, startX));
        startY = Math.max(0, Math.min(fullHeight - this.viewportHeight, startY));

        // ARCHITECT'S FIX: Sync ALL viewport properties (position AND dimensions)
        this.cropEngine.viewportX = startX;
        this.cropEngine.viewportY = startY;
        this.cropEngine.viewportWidth = this.viewportWidth;
        this.cropEngine.viewportHeight = this.viewportHeight;
    }

    /**
     * Jump to absolute pixel coordinates (converts to normalized)
     *
     * @param {number} absX - Absolute X pixel coordinate
     * @param {number} absY - Absolute Y pixel coordinate
     */
    jumpToAbsolute(absX, absY) {
        const fullWidth = this.cropEngine.sourceWidth;
        const fullHeight = this.cropEngine.sourceHeight;

        const normX = absX / fullWidth;
        const normY = absY / fullHeight;

        this.jumpToNormalized(normX, normY);
    }

    /**
     * Center viewport on image
     */
    centerViewport() {
        this.center = { x: 0.5, y: 0.5 };
    }

    /**
     * Toggle between fit and 1:1 modes
     * @returns {string} New view mode
     */
    toggleViewMode() {
        this.viewMode = this.viewMode === '1:1' ? 'fit' : '1:1';
        return this.viewMode;
    }

    /**
     * Update mechanical parameters (triggers loupe refresh)
     *
     * @param {Object} params - { minVolume?, speckleRescue?, shadowClamp? }
     */
    updateMechanicalParams(params) {
        Object.assign(this.mechanicalParams, params);
    }

    /**
     * Get Navigator Map data with viewport bounding box
     * @param {number} thumbnailSize - Thumbnail size (default 200px)
     * @returns {Object} Navigator map data
     */
    getNavigatorMap(thumbnailSize = 200) {
        if (!this.cropEngine) {
            return null;
        }
        return this.cropEngine.getNavigatorMap(thumbnailSize);
    }

    /**
     * Get viewport bounding box in thumbnail coordinates
     * @param {number} thumbWidth - Thumbnail width
     * @param {number} thumbHeight - Thumbnail height
     * @returns {Object} { x, y, width, height } in thumbnail pixels
     */
    getViewportBoundsInThumbnail(thumbWidth, thumbHeight) {
        const fullWidth = this.cropEngine.sourceWidth;
        const fullHeight = this.cropEngine.sourceHeight;

        // Scale factors
        const scaleX = thumbWidth / fullWidth;
        const scaleY = thumbHeight / fullHeight;

        // Current viewport in absolute pixels
        const centerX = this.center.x * fullWidth;
        const centerY = this.center.y * fullHeight;

        const startX = Math.max(0, Math.min(fullWidth - this.viewportWidth, centerX - this.viewportWidth / 2));
        const startY = Math.max(0, Math.min(fullHeight - this.viewportHeight, centerY - this.viewportHeight / 2));

        // Convert to thumbnail coordinates
        return {
            x: Math.round(startX * scaleX),
            y: Math.round(startY * scaleY),
            width: Math.round(this.viewportWidth * scaleX),
            height: Math.round(this.viewportHeight * scaleY)
        };
    }

    /**
     * Get current state for debugging/status display
     */
    getState() {
        return {
            center: { ...this.center },
            viewMode: this.viewMode,
            mechanicalParams: { ...this.mechanicalParams },
            viewportWidth: this.viewportWidth,
            viewportHeight: this.viewportHeight
        };
    }
}

// Export for use in index.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ViewportManager;
}
