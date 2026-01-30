/**
 * UnifiedPreviewManager - Orchestrates between Fit and Zoom preview modes
 *
 * Fit Mode: Shows entire image scaled to fit (full image, stride-based quality)
 * Zoom Mode: Shows 1:1 viewport with panning (viewport-based, resolution scales)
 */

const ZoomPreviewRenderer = require('./ZoomPreviewRenderer');

class UnifiedPreviewManager {
    constructor(containerEl, imageEl, dropdownEl, stateGetter, metadataGetter) {
        this.mode = 'fit';
        this.container = containerEl;
        this.imageEl = imageEl;
        this.dropdown = dropdownEl;
        this.dropdownLabel = null;
        this.getState = stateGetter;
        this.getMetadata = metadataGetter;

        this.zoomRenderer = null;
        this.zoomEventHandlers = [];
        this.fitRenderFn = null;

        console.log('[UnifiedPreviewManager] Initialized');
    }

    /**
     * Set the render function for fit mode
     */
    setFitRenderer(renderFn) {
        this.fitRenderFn = renderFn;
    }

    /**
     * Switch between fit and zoom modes
     */
    async setMode(mode) {
        if (mode === this.mode) return;

        console.log(`[UnifiedPreviewManager] Switching from ${this.mode} to ${mode}`);

        if (mode === 'zoom') {
            await this.setupZoomMode();
        } else if (mode === 'fit') {
            this.teardownZoomMode();
            if (this.fitRenderFn) {
                await this.fitRenderFn();
            }
        }

        this.mode = mode;
        this.updateDropdown();
    }

    /**
     * Initialize zoom mode with ZoomPreviewRenderer
     */
    async setupZoomMode() {
        const { documentID, originalLayerID, docWidth, docHeight, bitDepth, separationData } =
            this.getMetadata();

        console.log('[UnifiedPreviewManager] Setting up zoom mode...');

        this.zoomRenderer = new ZoomPreviewRenderer(
            this.container,
            this.imageEl,
            documentID,
            originalLayerID,
            docWidth,
            docHeight,
            bitDepth,
            separationData
        );

        this.attachZoomEventHandlers();
        this.container.classList.add('zoom-mode');
        await this.zoomRenderer.init();
    }

    /**
     * Attach event handlers for zoom mode interactions
     */
    attachZoomEventHandlers() {
        // Mouse drag panning
        let isDragging = false;
        let lastX = 0;
        let lastY = 0;

        const onMouseDown = (e) => {
            isDragging = true;
            lastX = e.clientX;
            lastY = e.clientY;
            this.container.classList.add('panning');
            e.preventDefault();
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const deltaX = e.clientX - lastX;
            const deltaY = e.clientY - lastY;
            lastX = e.clientX;
            lastY = e.clientY;

            this.zoomRenderer.pan(-deltaX, -deltaY);
            this.zoomRenderer.fetchAndRender();
        };

        const onMouseUp = () => {
            isDragging = false;
            this.container.classList.remove('panning');
        };

        // Arrow key step panning (100px)
        const onKeyDown = (e) => {
            if (!this.zoomRenderer) return;

            switch (e.key) {
                case 'ArrowLeft':
                    this.zoomRenderer.pan(-100, 0);
                    this.zoomRenderer.fetchAndRender();
                    e.preventDefault();
                    break;
                case 'ArrowRight':
                    this.zoomRenderer.pan(100, 0);
                    this.zoomRenderer.fetchAndRender();
                    e.preventDefault();
                    break;
                case 'ArrowUp':
                    this.zoomRenderer.pan(0, -100);
                    this.zoomRenderer.fetchAndRender();
                    e.preventDefault();
                    break;
                case 'ArrowDown':
                    this.zoomRenderer.pan(0, 100);
                    this.zoomRenderer.fetchAndRender();
                    e.preventDefault();
                    break;
                case 'Home':
                    // Recenter viewport
                    this.zoomRenderer.viewportX = (this.zoomRenderer.docWidth / this.zoomRenderer.resolution - this.zoomRenderer.width) / 2;
                    this.zoomRenderer.viewportY = (this.zoomRenderer.docHeight / this.zoomRenderer.resolution - this.zoomRenderer.height) / 2;
                    this.zoomRenderer.applyBounds();
                    this.zoomRenderer.fetchAndRender();
                    e.preventDefault();
                    break;
                case 'Escape':
                    // Exit zoom mode
                    document.getElementById('previewMode')?.dispatchEvent(new Event('change'));
                    e.preventDefault();
                    break;
            }
        };

        // Wheel zoom to cursor
        const onWheel = async (e) => {
            e.preventDefault();

            const resolutions = [1, 2, 4, 8];
            let currentIndex = resolutions.indexOf(this.zoomRenderer.resolution);
            const zoomDirection = e.deltaY > 0 ? 1 : -1;
            let nextIndex = currentIndex + zoomDirection;

            if (nextIndex < 0 || nextIndex >= resolutions.length) return;

            const nextRes = resolutions[nextIndex];

            // Get mouse position relative to viewport
            const rect = this.container.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            // Zoom to cursor position
            await this.zoomRenderer.setResolutionAtPoint(nextRes, mouseX, mouseY);

            // Update dropdown to match
            this.dropdown.value = nextRes;
        };

        // Store handlers for cleanup
        this.zoomEventHandlers = [
            { element: this.container, type: 'mousedown', handler: onMouseDown },
            { element: document, type: 'mousemove', handler: onMouseMove },
            { element: document, type: 'mouseup', handler: onMouseUp },
            { element: document, type: 'keydown', handler: onKeyDown },
            { element: this.container, type: 'wheel', handler: onWheel }
        ];

        // Attach all handlers
        this.zoomEventHandlers.forEach(({ element, type, handler }) => {
            element.addEventListener(type, handler, type === 'wheel' ? { passive: false } : false);
        });

        console.log('[UnifiedPreviewManager] Attached zoom event handlers');
    }

    /**
     * Cleanup zoom mode
     */
    teardownZoomMode() {
        console.log('[UnifiedPreviewManager] Tearing down zoom mode...');

        // Remove all event handlers
        this.zoomEventHandlers.forEach(({ element, type, handler }) => {
            element.removeEventListener(type, handler);
        });
        this.zoomEventHandlers = [];

        // Dispose zoom renderer
        if (this.zoomRenderer) {
            if (this.zoomRenderer.activePixelData && this.zoomRenderer.activePixelData.imageData) {
                this.zoomRenderer.activePixelData.imageData.dispose();
                this.zoomRenderer.activePixelData = null;
            }
            this.zoomRenderer = null;
        }

        this.container.classList.remove('zoom-mode', 'panning');

        console.log('[UnifiedPreviewManager] Zoom mode torn down');
    }

    /**
     * Update dropdown label and options based on current mode
     */
    updateDropdown() {
        if (!this.dropdownLabel) return;

        if (this.mode === 'fit') {
            this.dropdownLabel.textContent = 'Preview Quality:';
            this.dropdown.innerHTML = `
                <option value="4" selected>Standard (fast)</option>
                <option value="2">Fine (slow)</option>
                <option value="1">Finest (slower)</option>
            `;
        } else {
            this.dropdownLabel.textContent = 'Resolution:';
            this.dropdown.innerHTML = `
                <option value="1" selected>1:1 (Full Res)</option>
                <option value="2">1:2 (Half Res)</option>
                <option value="4">1:4 (Quarter Res)</option>
                <option value="8">1:8 (Eighth Res)</option>
            `;
        }

        console.log(`[UnifiedPreviewManager] Dropdown updated for ${this.mode} mode`);
    }

    /**
     * Render current mode
     */
    async render() {
        if (this.mode === 'fit' && this.fitRenderFn) {
            await this.fitRenderFn();
        } else if (this.mode === 'zoom' && this.zoomRenderer) {
            await this.zoomRenderer.fetchAndRender();
        }
    }

    /**
     * Handle dropdown value change
     */
    async onDropdownChange(value) {
        const numValue = parseInt(value, 10);

        if (this.mode === 'fit') {
            // Fit mode: change stride (reassign pixels)
            console.log(`[UnifiedPreviewManager] Changing stride to ${numValue}`);
            // This is handled in index.js previewStride handler
        } else {
            // Zoom mode: change resolution
            console.log(`[UnifiedPreviewManager] Changing resolution to 1:${numValue}`);
            if (this.zoomRenderer) {
                const centerX = this.zoomRenderer.width / 2;
                const centerY = this.zoomRenderer.height / 2;
                await this.zoomRenderer.setResolutionAtPoint(numValue, centerX, centerY);
            }
        }
    }

    /**
     * Complete cleanup
     */
    destroy() {
        console.log('[UnifiedPreviewManager] Destroying...');
        this.teardownZoomMode();
    }
}

module.exports = UnifiedPreviewManager;
