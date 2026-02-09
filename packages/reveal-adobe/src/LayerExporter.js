/**
 * LayerExporter - "Clean Handshake" Protocol
 *
 * Bridges interactive UI and physical screen printing press.
 * Verifies production result matches UI state before export.
 * Creates structured PSD layer stack ready for film output.
 *
 * @module LayerExporter
 */

export class LayerExporter {
    constructor(sessionState, productionResult) {
        this.sessionState = sessionState;
        this.productionResult = productionResult;
    }

    /**
     * Verify production result matches UI state before export
     * @returns {Object} Verification report
     */
    async verifyProductionSync() {
        console.log('[LayerExporter] Running Clean Handshake verification...');

        const verification = {
            passed: true,
            issues: []
        };

        // 1. Final Pruning Sync
        const uiPalette = this.sessionState.getCurrentPalette();
        const prodPalette = this.productionResult.palette;

        if (!uiPalette || !prodPalette) {
            verification.passed = false;
            verification.issues.push('Missing palette data (UI or production)');
            return verification;
        }

        if (uiPalette.length !== prodPalette.length) {
            verification.passed = false;
            verification.issues.push(
                `Palette mismatch: UI has ${uiPalette.length} colors, ` +
                `production has ${prodPalette.length} colors. ` +
                `minVolume pruning may have diverged.`
            );
        }

        // Verify LAB values match (within tolerance)
        const LAB_TOLERANCE = 0.5;
        for (let i = 0; i < Math.min(uiPalette.length, prodPalette.length); i++) {
            const uiColor = uiPalette[i];
            const prodColor = prodPalette[i];

            const deltaL = Math.abs(uiColor.L - prodColor.L);
            const deltaA = Math.abs(uiColor.a - prodColor.a);
            const deltaB = Math.abs(uiColor.b - prodColor.b);

            if (deltaL > LAB_TOLERANCE || deltaA > LAB_TOLERANCE || deltaB > LAB_TOLERANCE) {
                verification.passed = false;
                verification.issues.push(
                    `Color ${i} mismatch: UI=[${uiColor.L.toFixed(1)}, ${uiColor.a.toFixed(1)}, ${uiColor.b.toFixed(1)}], ` +
                    `Prod=[${prodColor.L.toFixed(1)}, ${prodColor.a.toFixed(1)}, ${prodColor.b.toFixed(1)}]`
                );
            }
        }

        // 2. Safety Lock Check: minColorCount enforcement
        const MIN_COLOR_COUNT = 4; // Printmaker minimum
        const finalColorCount = prodPalette.length;

        if (finalColorCount < MIN_COLOR_COUNT) {
            verification.passed = false;
            verification.issues.push(
                `Production palette has ${finalColorCount} colors, below minimum of ${MIN_COLOR_COUNT}. ` +
                `High-res collapse detected - proxy showed more colors than production.`
            );
        }

        // 3. Verify speckleRescue was applied
        if (this.sessionState.parameters.speckleRescue > 0) {
            const rescueFailed = this._verifySpeckleRescue(
                this.productionResult.masks,
                this.sessionState.parameters.speckleRescue
            );

            if (rescueFailed) {
                verification.passed = false;
                verification.issues.push(
                    `speckleRescue=${this.sessionState.parameters.speckleRescue}px was not properly applied to production masks`
                );
            }
        }

        // 4. Verify shadowClamp was applied
        if (this.sessionState.parameters.shadowClamp > 0) {
            const clampFailed = this._verifyShadowClamp(
                this.productionResult.masks,
                this.sessionState.parameters.shadowClamp
            );

            if (clampFailed) {
                verification.passed = false;
                verification.issues.push(
                    `shadowClamp=${this.sessionState.parameters.shadowClamp}% was not properly applied to production masks`
                );
            }
        }

        console.log(`[LayerExporter] Verification ${verification.passed ? 'PASSED ✓' : 'FAILED ✗'}`);
        if (!verification.passed) {
            console.error('[LayerExporter] Issues:', verification.issues);
        }

        return verification;
    }

    /**
     * Export production result to Photoshop layers
     * @param {Object} options - Export options
     * @returns {Promise<Object>} Export result
     */
    async exportToLayers(options = {}) {
        const { createComposite = true } = options;

        console.log('[LayerExporter] Starting layer export...');

        // 1. Verification pass
        const verification = await this.verifyProductionSync();
        if (!verification.passed) {
            throw new Error(
                'Production sync verification failed. ' +
                'UI state does not match production result. ' +
                'Issues: ' + verification.issues.join(', ')
            );
        }

        // 2. Sort palette by lightness (darkest first = base layer)
        const sortedColors = this._sortPaletteByLightness(this.productionResult.palette);

        // 3. Calculate coverage percentages
        const coverages = this._calculateCoverages(
            this.productionResult.colorIndices,
            this.productionResult.palette.length
        );

        // 4. Create layers in reverse order (base layer first)
        const layers = [];

        for (let i = sortedColors.length - 1; i >= 0; i--) {
            const color = sortedColors[i];
            const colorIndex = sortedColors[i].originalIndex;
            const coverage = coverages[colorIndex];

            // Generate layer name with LAB + coverage
            const layerName = this._generateLayerName(color, coverage);

            // Create Solid Color Fill Layer
            const layer = await this._createSolidColorLayer(
                layerName,
                color,
                this.productionResult.masks[colorIndex],
                this.productionResult.width,
                this.productionResult.height
            );

            // Inject metadata
            await this._injectLayerMetadata(layer, {
                labColor: color,
                coverage,
                parameters: this.sessionState.parameters
            });

            layers.push(layer);

            console.log(`[LayerExporter] Created layer: ${layerName}`);
        }

        // 5. Create composite reference layer (optional)
        if (createComposite) {
            const composite = await this._createCompositeLayer(
                this.productionResult.palette,
                this.productionResult.colorIndices,
                this.productionResult.width,
                this.productionResult.height
            );
            layers.push(composite);
        }

        console.log(`[LayerExporter] Export complete: ${layers.length} layers created`);

        return {
            layers,
            verification,
            metadata: {
                totalColors: sortedColors.length,
                parameters: this.sessionState.parameters,
                exportTimestamp: new Date().toISOString()
            }
        };
    }

    /**
     * Verify speckle rescue was applied
     * @private
     */
    _verifySpeckleRescue(masks, radiusPixels) {
        // TODO: Implement cluster analysis
        // For now, return false (verification passed)
        return false;
    }

    /**
     * Verify shadow clamp was applied
     * @private
     */
    _verifyShadowClamp(masks, clampPercent) {
        const clampValue = Math.round(clampPercent * 255 / 100);

        // Check if any mask has values below clamp threshold
        for (const mask of masks) {
            for (let i = 0; i < mask.length; i++) {
                const val = mask[i];
                if (val > 0 && val < clampValue) {
                    return true; // Verification failed
                }
            }
        }

        return false; // Verification passed
    }

    /**
     * Sort palette by lightness (darkest first)
     * @private
     */
    _sortPaletteByLightness(palette) {
        return palette
            .map((color, idx) => ({ ...color, originalIndex: idx }))
            .sort((a, b) => a.L - b.L);
    }

    /**
     * Calculate coverage percentages for each color
     * @private
     */
    _calculateCoverages(colorIndices, paletteSize) {
        const counts = new Array(paletteSize).fill(0);
        for (let i = 0; i < colorIndices.length; i++) {
            counts[colorIndices[i]]++;
        }

        const totalPixels = colorIndices.length;
        return counts.map(count => (count / totalPixels) * 100);
    }

    /**
     * Generate layer name with LAB values and coverage
     * @private
     */
    _generateLayerName(color, coverage) {
        const L = color.L.toFixed(0);
        const a = color.a >= 0 ? `a${color.a.toFixed(0)}` : `a${color.a.toFixed(0)}`;
        const b = color.b >= 0 ? `b${color.b.toFixed(0)}` : `b${color.b.toFixed(0)}`;
        const cov = coverage.toFixed(1);

        return `L${L} ${a} ${b} | ${cov}%`;
    }

    /**
     * Create Solid Color Fill Layer with mask
     * @private
     */
    async _createSolidColorLayer(layerName, labColor, maskData, width, height) {
        const { app, imaging } = require('photoshop');

        console.log(`[LayerExporter] Creating layer: ${layerName}`);

        const doc = app.activeDocument;

        // 1. Create new layer
        const layer = await doc.createLayer({
            name: layerName,
            opacity: 100,
            mode: 'normal'
        });

        // 2. Fill layer with solid color (convert LAB to RGB for display)
        const rgbColor = this._labToRGB(labColor);

        await app.batchPlay([{
            _obj: 'fill',
            _target: [{ _ref: 'layer', _id: layer.id }],
            using: {
                _enum: 'fillContents',
                _value: 'color'
            },
            color: {
                _obj: 'RGBColor',
                red: rgbColor.r,
                grain: rgbColor.g,
                blue: rgbColor.b
            },
            opacity: { _unit: 'percentUnit', _value: 100 }
        }], {});

        // 3. Create layer mask from mask data
        await this._createLayerMask(layer, maskData, width, height);

        return layer;
    }

    /**
     * Create layer mask with artifact cleanup
     * @private
     */
    async _createLayerMask(layer, maskData, width, height) {
        const { app, imaging } = require('photoshop');

        // 1. Artifact cleanup: Final stride 1 scan
        const cleanedMask = this._applyArtifactCleanup(maskData, width, height);

        // 2. Convert to Photoshop ImageData format
        const psImageData = await imaging.createImageDataFromBuffer(
            cleanedMask,
            { width, height, components: 1, colorSpace: 'Grayscale' }
        );

        // 3. Apply mask to layer
        await app.batchPlay([{
            _obj: 'make',
            _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }],
            at: { _ref: 'layer', _id: layer.id },
            using: { _obj: 'grayscale' }
        }], {});

        // 4. Write mask pixels
        await imaging.putPixels({
            layerID: layer.id,
            imageData: psImageData,
            targetMask: true
        });

        console.log(`[LayerExporter] Mask applied: ${width}x${height}`);
    }

    /**
     * Artifact cleanup: Remove isolated single-pixel artifacts
     * @private
     */
    _applyArtifactCleanup(maskData, width, height) {
        const cleaned = new Uint8Array(maskData.length);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const val = maskData[idx];

                if (val === 0) {
                    cleaned[idx] = 0;
                    continue;
                }

                // Check 4-connected neighbors
                let neighbors = 0;
                if (x > 0 && maskData[idx - 1] > 0) neighbors++;
                if (x < width - 1 && maskData[idx + 1] > 0) neighbors++;
                if (y > 0 && maskData[idx - width] > 0) neighbors++;
                if (y < height - 1 && maskData[idx + width] > 0) neighbors++;

                // Remove isolated single pixels
                if (neighbors === 0) {
                    cleaned[idx] = 0;
                } else {
                    cleaned[idx] = val;
                }
            }
        }

        return cleaned;
    }

    /**
     * Inject LAB values and parameters into layer metadata
     * @private
     */
    async _injectLayerMetadata(layer, metadata) {
        const { app } = require('photoshop');

        const metadataString = JSON.stringify({
            revealVersion: '2.0',
            labColor: metadata.labColor,
            coverage: metadata.coverage,
            parameters: {
                minVolume: metadata.parameters.minVolume,
                speckleRescue: metadata.parameters.speckleRescue,
                shadowClamp: metadata.parameters.shadowClamp,
                targetColors: metadata.parameters.targetColors,
                distanceMetric: metadata.parameters.distanceMetric,
                engineType: metadata.parameters.engineType
            },
            exportTimestamp: new Date().toISOString()
        });

        // Store in layer description
        await app.batchPlay([{
            _obj: 'set',
            _target: [{ _ref: 'layer', _id: layer.id }],
            to: {
                _obj: 'layer',
                layerDescription: metadataString
            }
        }], {});

        console.log(`[LayerExporter] Metadata injected for layer: ${layer.name}`);
    }

    /**
     * Create composite preview layer
     * @private
     */
    async _createCompositeLayer(palette, colorIndices, width, height) {
        const { app, imaging } = require('photoshop');
        const { PreviewEngine } = await import('@reveal/core/engines/PreviewEngine.js');

        console.log('[LayerExporter] Creating composite preview layer...');

        // 1. Generate RGBA preview buffer
        const previewBuffer = PreviewEngine.generatePreview(
            palette,
            colorIndices,
            width,
            height
        );

        // 2. Create layer
        const doc = app.activeDocument;
        const compositeLayer = await doc.createLayer({
            name: '[Composite Preview]',
            opacity: 100,
            mode: 'normal'
        });

        // 3. Write pixels
        const psImageData = await imaging.createImageDataFromBuffer(
            previewBuffer,
            { width, height, components: 4, colorSpace: 'RGB' }
        );

        await imaging.putPixels({
            layerID: compositeLayer.id,
            imageData: psImageData,
            replace: true
        });

        // 4. Lock layer to prevent accidental editing
        await app.batchPlay([{
            _obj: 'set',
            _target: [{ _ref: 'layer', _id: compositeLayer.id }],
            to: {
                _obj: 'layer',
                layerLocking: {
                    _obj: 'layerLocking',
                    protectAll: true
                }
            }
        }], {});

        console.log('[LayerExporter] Composite preview layer created');

        return compositeLayer;
    }

    /**
     * Convert LAB to RGB (simple conversion for display)
     * @private
     */
    _labToRGB(lab) {
        // Simple LAB to RGB conversion (placeholder)
        // TODO: Use proper color space conversion
        const L = lab.L;
        const a = lab.a;
        const b = lab.b;

        // Rough approximation
        const r = Math.max(0, Math.min(255, L * 2.55 + a * 1.28));
        const g = Math.max(0, Math.min(255, L * 2.55 - a * 0.64 - b * 0.64));
        const blue = Math.max(0, Math.min(255, L * 2.55 + b * 1.28));

        return {
            r: Math.round(r),
            g: Math.round(g),
            b: Math.round(blue)
        };
    }
}
