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

        // Diagnostic modes
        this.filmFlashMode = false;
        this.meshOverlayMode = false;

        // Document properties for mesh overlay calculation
        this.documentDPI = options.documentDPI || 300;  // Default 300 DPI
        this.meshTPI = options.meshTPI || 230;          // Default 230 TPI

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

        console.log(`[ViewportManager] Viewport dimensions updated: ${this.viewportWidth}x${this.viewportHeight}`);
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

        const fullWidth = this.cropEngine.sourceWidth;
        const fullHeight = this.cropEngine.sourceHeight;

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

        // Apply diagnostic modes if enabled
        let displayBuffer = cropResult.previewBuffer;

        if (this.filmFlashMode) {
            displayBuffer = this._applyFilmFlash(displayBuffer, cropResult.cropWidth, cropResult.cropHeight);
        }

        if (this.meshOverlayMode) {
            displayBuffer = this._applyMeshOverlay(displayBuffer, cropResult.cropWidth, cropResult.cropHeight);
        }

        return {
            buffer: displayBuffer,
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

        console.log(`[ViewportManager] Panned to normalized (${this.center.x.toFixed(3)}, ${this.center.y.toFixed(3)})`);
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

        console.log(`[ViewportManager] Jumped to normalized (${this.center.x.toFixed(3)}, ${this.center.y.toFixed(3)})`);
    }

    /**
     * Sync CropEngine viewport position from normalized center
     * Must be called whenever center changes to keep Navigator Map accurate
     * @private
     */
    _syncCropEngineViewport() {
        if (!this.cropEngine) return;

        const fullWidth = this.cropEngine.sourceWidth;
        const fullHeight = this.cropEngine.sourceHeight;

        // Convert normalized center to absolute pixel coordinates
        const centerX = this.center.x * fullWidth;
        const centerY = this.center.y * fullHeight;

        // Calculate crop bounds (top-left corner)
        let startX = Math.floor(centerX - this.viewportWidth / 2);
        let startY = Math.floor(centerY - this.viewportHeight / 2);

        // Constrain to image bounds
        startX = Math.max(0, Math.min(fullWidth - this.viewportWidth, startX));
        startY = Math.max(0, Math.min(fullHeight - this.viewportHeight, startY));

        // Update CropEngine viewport position
        this.cropEngine.viewportX = startX;
        this.cropEngine.viewportY = startY;
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
        console.log('[ViewportManager] Centered viewport');
    }

    /**
     * Toggle between fit and 1:1 modes
     * @returns {string} New view mode
     */
    toggleViewMode() {
        this.viewMode = this.viewMode === '1:1' ? 'fit' : '1:1';
        console.log(`[ViewportManager] Toggled to ${this.viewMode} mode`);
        return this.viewMode;
    }

    /**
     * Update mechanical parameters (triggers loupe refresh)
     *
     * @param {Object} params - { minVolume?, speckleRescue?, shadowClamp? }
     */
    updateMechanicalParams(params) {
        Object.assign(this.mechanicalParams, params);
        console.log('[ViewportManager] Updated mechanical params:', this.mechanicalParams);
    }

    /**
     * Get Navigator Map data with viewport bounding box
     * @param {number} thumbnailSize - Thumbnail size (default 200px)
     * @returns {Object} Navigator map data
     */
    getNavigatorMap(thumbnailSize = 200) {
        console.log('🟢🟢🟢 [ViewportManager.getNavigatorMap] CALLED 🟢🟢🟢');
        console.log('[ViewportManager] cropEngine exists:', !!this.cropEngine);
        if (!this.cropEngine) {
            console.error('[ViewportManager] ❌❌❌ cropEngine is NULL!');
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

    // ============================================================================
    // DIAGNOSTIC MODES
    // ============================================================================

    /**
     * Toggle Film Flash mode (1-bit black & white preview)
     * Mimics how light passes through film during screen exposure
     */
    toggleFilmFlash() {
        this.filmFlashMode = !this.filmFlashMode;
        console.log(`[ViewportManager] Film Flash: ${this.filmFlashMode ? 'ON' : 'OFF'}`);
        return this.filmFlashMode;
    }

    /**
     * Toggle Mesh Overlay mode
     * Shows 230-mesh weave pattern to visualize screen openings
     */
    toggleMeshOverlay() {
        this.meshOverlayMode = !this.meshOverlayMode;
        console.log(`[ViewportManager] Mesh Overlay: ${this.meshOverlayMode ? 'ON' : 'OFF'}`);
        return this.meshOverlayMode;
    }

    /**
     * Apply Film Flash effect: High-contrast 1-bit black & white
     * @private
     */
    _applyFilmFlash(buffer, width, height) {
        const flashBuffer = new Uint8ClampedArray(buffer.length);

        for (let i = 0; i < width * height; i++) {
            const idx = i * 4;

            // Calculate luminance (perceptually weighted)
            const r = buffer[idx];
            const g = buffer[idx + 1];
            const b = buffer[idx + 2];
            const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

            // 1-bit threshold at 50% gray
            const binary = luminance > 127 ? 255 : 0;

            flashBuffer[idx] = binary;
            flashBuffer[idx + 1] = binary;
            flashBuffer[idx + 2] = binary;
            flashBuffer[idx + 3] = 255; // Opaque
        }

        return flashBuffer;
    }

    /**
     * Apply mesh overlay: Grid representing physical screen weave
     * Calculates actual mesh spacing based on document DPI and mesh TPI
     * @private
     */
    _applyMeshOverlay(buffer, width, height) {
        const overlayBuffer = new Uint8ClampedArray(buffer);

        // Calculate ACTUAL mesh spacing in pixels
        // Formula: pixels per mesh opening = DPI / mesh TPI
        // Example: 300 DPI / 230 TPI = 1.3 pixels per mesh opening
        const actualSpacing = this.documentDPI / this.meshTPI;

        // For very fine meshes (<2px), multiply by 2 for visibility
        // For coarse meshes (>4px), use actual spacing
        const meshSpacing = actualSpacing < 2 ? actualSpacing * 2 : actualSpacing;

        console.log(`[ViewportManager] Mesh overlay: ${this.documentDPI} DPI / ${this.meshTPI} TPI = ${actualSpacing.toFixed(2)}px (displaying at ${meshSpacing.toFixed(2)}px)`);

        // Draw grid lines at mesh boundaries
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;

                // Check if we're on a mesh line (using floating point modulo)
                const onVerticalLine = Math.abs(x % meshSpacing) < 0.5;
                const onHorizontalLine = Math.abs(y % meshSpacing) < 0.5;

                if (onVerticalLine || onHorizontalLine) {
                    // Darken to show mesh lines
                    overlayBuffer[idx] = Math.max(0, overlayBuffer[idx] - 30);
                    overlayBuffer[idx + 1] = Math.max(0, overlayBuffer[idx + 1] - 30);
                    overlayBuffer[idx + 2] = Math.max(0, overlayBuffer[idx + 2] - 30);
                }
            }
        }

        return overlayBuffer;
    }

    /**
     * Get current state for debugging/status display
     */
    getState() {
        return {
            center: { ...this.center },
            viewMode: this.viewMode,
            filmFlashMode: this.filmFlashMode,
            meshOverlayMode: this.meshOverlayMode,
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
