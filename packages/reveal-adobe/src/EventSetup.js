/**
 * EventSetup - One-time event listener attachment for the main dialog
 *
 * Imports: PluginState, FormHelpers, AnalysisUI, ViewModeController, DialogHelpers
 */

const { action, imaging, app } = require("photoshop");

const Reveal = require("@reveal/core");
const logger = Reveal.logger;

const pluginState = require('./PluginState');
const { sliderConfigs, ARCHETYPES } = require('./FormHelpers');
const { handleAnalyzeImage } = require('./AnalysisUI');
const { rebuildPreviewStrideForMode, detachPreviewZoomHandlers } = require('./ViewModeController');
const { showSuccessDialog, showErrorDialog } = require('./DialogHelpers');

/**
 * Attach all one-time event listeners for the main dialog.
 * Called once during the first showDialog() invocation.
 *
 * @param {HTMLElement} dialog - The main dialog element
 * @param {Function} handlePosterization - The posterization orchestrator (buttonElement, originalText) => Promise
 */
function attachAllEventListeners(dialog, handlePosterization) {

    // Set up collapsible sections
    const sectionTitles = document.querySelectorAll('.section-title');
    sectionTitles.forEach(title => {
        title.addEventListener('click', () => {
            const section = title.parentElement;
            section.classList.toggle('collapsed');
            title.classList.toggle('collapsed');
        });
    });

    // Set up mesh dropdown (show/hide custom input)
    const meshSizeSelect = document.getElementById('meshSize');
    const customMeshInput = document.getElementById('customMeshInput');
    if (meshSizeSelect && customMeshInput) {
        meshSizeSelect.addEventListener('change', () => {
            if (meshSizeSelect.value === 'custom') {
                customMeshInput.style.display = 'block';
                const customMeshValue = document.getElementById('customMeshValue');
                if (customMeshValue) customMeshValue.focus();
            } else {
                customMeshInput.style.display = 'none';
            }
        });
    }

    // Set up preview item selection
    const previewItems = document.querySelectorAll('.preview-item[data-color-count]');
    previewItems.forEach(item => {
        item.addEventListener('click', (event) => {
            const colorCount = item.dataset.colorCount;
            const radio = document.getElementById(`color${colorCount}`);

            // Update selection state
            previewItems.forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            radio.checked = true;

        });
    });

    // Set up Cancel button
    const btnCancel = document.getElementById("btnCancel");
    if (btnCancel) {
        btnCancel.addEventListener("click", () => {
            dialog.close();
        });
    }

    // Set up Cancel button in palette dialog
    const btnPaletteCancel = document.getElementById("btnPaletteCancel");
    if (btnPaletteCancel) {
        btnPaletteCancel.addEventListener("click", () => {

            // Cleanup zoom renderer if in zoom mode
            if (window.previewState && window.previewState.viewMode === 'zoom') {
                detachPreviewZoomHandlers();

                if (window.previewState.zoomRenderer) {
                    // Clear quality timeout
                    if (window.previewState.zoomRenderer.qualityTimeout) {
                        clearTimeout(window.previewState.zoomRenderer.qualityTimeout);
                    }

                    // Dispose pixel data
                    if (window.previewState.zoomRenderer.activePixelData &&
                        window.previewState.zoomRenderer.activePixelData.imageData) {
                        window.previewState.zoomRenderer.activePixelData.imageData.dispose();
                    }

                    window.previewState.zoomRenderer = null;
                }
            }

            const paletteDialog = document.getElementById('paletteDialog');
            if (paletteDialog) {
                paletteDialog.close();
            }
        });
    }

    // Set up Back button (goes from palette editor back to posterization settings)
    const btnBack = document.getElementById("btnBack");
    if (btnBack) {
        btnBack.addEventListener("click", () => {

            // Cleanup zoom renderer if in zoom mode
            if (window.previewState && window.previewState.viewMode === 'zoom') {
                detachPreviewZoomHandlers();

                if (window.previewState.zoomRenderer) {
                    // Clear quality timeout
                    if (window.previewState.zoomRenderer.qualityTimeout) {
                        clearTimeout(window.previewState.zoomRenderer.qualityTimeout);
                    }

                    // Dispose pixel data
                    if (window.previewState.zoomRenderer.activePixelData &&
                        window.previewState.zoomRenderer.activePixelData.imageData) {
                        window.previewState.zoomRenderer.activePixelData.imageData.dispose();
                    }

                    window.previewState.zoomRenderer = null;
                }
            }

            // Close palette dialog
            const paletteDialog = document.getElementById('paletteDialog');
            if (paletteDialog) {
                paletteDialog.close();
            }

            // Show Posterize button (it was hidden when palette editor opened)
            const btnPosterize = document.getElementById('btnPosterize');
            if (btnPosterize) {
                btnPosterize.style.display = '';
            }

            // Reopen main dialog with size options (NON-MODAL for LAB slider access)
            const mainDialog = document.getElementById('mainDialog');
            if (mainDialog) {
                mainDialog.show({
                    resize: "both",
                    size: {
                        width: 620,
                        height: 700,
                        minWidth: 580,
                        minHeight: 500,
                        maxWidth: 750,
                        maxHeight: 900
                    }
                });
            }

            // Note: Keep posterizationData intact so user doesn't lose their work
            // They can modify settings and re-posterize if desired

        });
    }

    // Set up Run Mask Tests button
    // Set up Pixel Data Mask Test button (alpha channel → selection → mask)
    const btnRunNetwisdomTests = document.getElementById("btnRunNetwisdomTests");
    if (btnRunNetwisdomTests) {
        btnRunNetwisdomTests.addEventListener("click", async () => {
            btnRunNetwisdomTests.disabled = true;
            btnRunNetwisdomTests.textContent = "Running Test...";

            try {
                // Import test suite
                const { runAllNetwisdomTests } = require('./tests/netwisdom-mask-test');

                // Run test (pixel data → alpha channel → selection → mask)
                const results = await runAllNetwisdomTests();

                // Show results summary
                if (results.passed === results.total) {
                    showSuccessDialog(
                        2,  // 2 layers created
                        { hexColors: [] },  // dummy preview
                        0,
                        `✓ Overlapping layers test passed!\n\nCheck Photoshop:\n- RED circle layer with mask\n- GREEN rectangle layer with mask\n- Masks show correct patterns\n\nThis approach WORKS!\nSelection → revealSelection creates perfect masks!`
                    );
                } else {
                    showErrorDialog(
                        "Test Failed",
                        "Overlapping layers test failed",
                        "Check console for error details"
                    );
                }
            } catch (error) {
                logger.error("Test execution failed:", error);
                showErrorDialog(
                    "Test Error",
                    error.message,
                    "Check console for details"
                );
            } finally {
                btnRunNetwisdomTests.disabled = false;
                btnRunNetwisdomTests.textContent = "🔬 Test Pixel Data Mask";
            }
        });
    }

    // Set up Lab Uniformity Test button
    const btnTestLabUniformity = document.getElementById("btnTestLabUniformity");
    if (btnTestLabUniformity) {
        btnTestLabUniformity.addEventListener("click", async () => {
            btnTestLabUniformity.disabled = true;
            btnTestLabUniformity.textContent = "Running Test...";

            try {
                const width = 100;
                const height = 100;
                const testLab = { L: 204, a: 128, b: 128 };

                // 1. Create Lab document
                await action.batchPlay([{
                    "_obj": "make",
                    "_target": [{ "_ref": "document" }],
                    "documentPreset": {
                        "_obj": "documentPreset",
                        "width": { "_unit": "pixelsUnit", "_value": width },
                        "height": { "_unit": "pixelsUnit", "_value": height },
                        "resolution": { "_unit": "densityUnit", "_value": 72 },
                        "mode": { "_class": "mode", "_value": "labColorMode" },
                        "depth": 8,
                        "fill": { "_class": "fill", "_value": "white" }
                    }
                }], {});

                const doc = app.activeDocument;

                // 2. Write UNIFORM Lab data
                const labData = new Uint8Array(width * height * 3);
                for (let i = 0; i < width * height; i++) {
                    const idx = i * 3;
                    labData[idx] = testLab.L;
                    labData[idx + 1] = testLab.a;
                    labData[idx + 2] = testLab.b;
                }

                const imageData = await imaging.createImageDataFromBuffer(labData, {
                    width, height, components: 3, chunky: true, colorSpace: "Lab"
                });

                await imaging.putPixels({
                    layerID: doc.layers[0].id,
                    imageData: imageData,
                    replace: true
                });

                imageData.dispose();

                // 3. Read it back
                const pixelData = await imaging.getPixels({
                    documentID: doc.id,
                    componentSize: 8,
                    targetComponentCount: 3,
                    colorSpace: "Lab"
                });

                let readData;
                if (pixelData.imageData) {
                    readData = await pixelData.imageData.getData({ chunky: true });
                } else if (pixelData.pixels) {
                    readData = pixelData.pixels;
                }

                // 4. Check uniformity
                const uniqueValues = new Set();
                for (let i = 0; i < width * height; i++) {
                    const idx = i * 3;
                    const val = `${readData[idx]},${readData[idx + 1]},${readData[idx + 2]}`;
                    uniqueValues.add(val);
                }


                // Log the values for debugging
                if (uniqueValues.size <= 10) {
                }

                // 5. Close document (may fail if already closed)
                try {
                    await doc.close();
                } catch (closeError) {
                }

                // Show results
                if (uniqueValues.size === 1) {
                    const resultValue = Array.from(uniqueValues)[0];
                    showSuccessDialog(
                        0, { hexColors: [] }, 0,
                        `✓ Lab Uniformity Test PASSED!\n\nWrote uniform Lab values\nRead back: ${uniqueValues.size} unique value\nValue: ${resultValue}\n\n✅ Photoshop preserves Lab uniformity!\n\nThis means the dithering in your PSD was introduced during its creation, not during reading.`
                    );
                } else {
                    const values = Array.from(uniqueValues).slice(0, 5).join('\n  ');
                    showErrorDialog(
                        "Lab Uniformity Test FAILED",
                        `Found ${uniqueValues.size} different Lab values after round-trip`,
                        `Wrote: ${testLab.L},${testLab.a},${testLab.b}\nRead back:\n  ${values}\n${uniqueValues.size > 5 ? `  ... and ${uniqueValues.size - 5} more` : ''}\n\n❌ Photoshop's imaging.getPixels() dithers Lab data!`
                    );
                }
            } catch (error) {
                logger.error("Lab uniformity test failed:", error);
                showErrorDialog("Test Error", error.message, "Check console for details");
            } finally {
                btnTestLabUniformity.disabled = false;
                btnTestLabUniformity.textContent = "🔬 Test Lab Uniformity";
            }
        });
    }

    // Set up Posterize button
    const btnPosterize = document.getElementById("btnPosterize");
    if (btnPosterize) {
        const originalText = btnPosterize.textContent;
        btnPosterize.addEventListener("click", () => {
            handlePosterization(btnPosterize, originalText);
        });
    }

    // Target Colors slider value display is handled by sliderConfigs below (no sync needed)

    // Spectrum slider value display updates
    // (sliderConfigs defined at module level for reuse by preset/analysis functions)
    sliderConfigs.forEach(config => {
        const slider = document.getElementById(config.id);
        const valueDisplay = document.getElementById(config.valueId || `${config.id}Value`);

        if (slider && valueDisplay) {
            slider.addEventListener('input', () => {
                const value = parseFloat(slider.value);
                valueDisplay.textContent = config.format(value);
            });
            slider.addEventListener('change', () => {
                const value = parseFloat(slider.value);
                valueDisplay.textContent = config.format(value);
            });
        }
    });

    // Collapsible section toggle functionality
    const collapsibleHeaders = document.querySelectorAll('.collapsible-header');
    collapsibleHeaders.forEach(header => {
        header.addEventListener('click', () => {
            const section = header.parentElement;
            section.classList.toggle('open');
        });
    });

    // Conditional UI disabling - Centroid Strategy
    const centroidStrategy = document.getElementById("centroidStrategy");
    const lWeight = document.getElementById("lWeight");
    const cWeight = document.getElementById("cWeight");
    const blackBias = document.getElementById("blackBias");

    function updateSaliencyControls() {
        const isVolumetric = centroidStrategy.value === "VOLUMETRIC";

        if (lWeight) {
            lWeight.disabled = isVolumetric;
            lWeight.style.opacity = isVolumetric ? "0.5" : "1";
        }
        if (cWeight) {
            cWeight.disabled = isVolumetric;
            cWeight.style.opacity = isVolumetric ? "0.5" : "1";
        }
        if (blackBias) {
            blackBias.disabled = isVolumetric;
            blackBias.style.opacity = isVolumetric ? "0.5" : "1";
        }

        // Also disable the labels
        const lWeightValue = document.getElementById("lWeightValue");
        const cWeightValue = document.getElementById("cWeightValue");
        const blackBiasValue = document.getElementById("blackBiasValue");

        if (lWeightValue) lWeightValue.style.opacity = isVolumetric ? "0.5" : "1";
        if (cWeightValue) cWeightValue.style.opacity = isVolumetric ? "0.5" : "1";
        if (blackBiasValue) blackBiasValue.style.opacity = isVolumetric ? "0.5" : "1";
    }

    if (centroidStrategy) {
        centroidStrategy.addEventListener("change", updateSaliencyControls);
        updateSaliencyControls(); // Set initial state
    }

    // Conditional UI disabling - Substrate Awareness
    const substrateMode = document.getElementById("substrateMode");
    const substrateTolerance = document.getElementById("substrateTolerance");

    function updateSubstrateToleranceControl() {
        const isAutoDetect = substrateMode.value === "auto";

        if (substrateTolerance) {
            substrateTolerance.disabled = !isAutoDetect;
            substrateTolerance.style.opacity = isAutoDetect ? "1" : "0.5";
        }

        // Also disable the label
        const substrateToleranceValue = document.getElementById("substrateToleranceValue");
        if (substrateToleranceValue) {
            substrateToleranceValue.style.opacity = isAutoDetect ? "1" : "0.5";
        }
    }

    if (substrateMode) {
        substrateMode.addEventListener("change", updateSubstrateToleranceControl);
        updateSubstrateToleranceControl(); // Set initial state
    }

    // Reset to Defaults button
    const btnResetDefaults = document.getElementById("btnResetDefaults");
    if (btnResetDefaults) {
        btnResetDefaults.addEventListener("click", () => {

            // Default values object
            const defaults = {
                engineType: 'reveal-mk1.5',
                centroidStrategy: 'SALIENCY',
                substrateMode: 'white',
                substrateTolerance: 3.5,
                vibrancyMode: 'aggressive',
                vibrancyBoost: 1.6,
                highlightThreshold: 85,
                highlightBoost: 2.2,
                enablePaletteReduction: true,
                paletteReduction: 10.0,
                hueLockAngle: 18,
                shadowPoint: 15,
                lWeight: 1.1,
                cWeight: 2.0,
                blackBias: 5.0,
                colorMode: 'color',
                targetColors: 8,
                preserveWhite: false,
                preserveBlack: false,
                ignoreTransparent: true,
                enableHueGapAnalysis: true,
                maskProfile: 'Gray Gamma 2.2'
            };

            // Reset all form controls (use targetColorsSlider instead of targetColors)
            const resetDefaults = { ...defaults, targetColorsSlider: defaults.targetColors };
            delete resetDefaults.targetColors;

            Object.keys(resetDefaults).forEach(key => {
                const element = document.getElementById(key);
                if (!element) {
                    return;
                }

                const value = resetDefaults[key];

                if (element.type === 'checkbox') {
                    element.checked = value;
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (element.tagName === 'SELECT') {
                    element.value = value;
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                } else if (element.tagName === 'SP-SLIDER') {
                    element.value = value;
                    // Update value display
                    const valueDisplay = document.getElementById(`${key}Value`);
                    if (valueDisplay) {
                        const config = sliderConfigs.find(c => c.id === key);
                        if (config) {
                            valueDisplay.textContent = config.format(value);
                        } else {
                            valueDisplay.textContent = value.toString();
                        }
                    }
                    // Trigger events
                    element.dispatchEvent(new Event('input', { bubbles: true }));
                    element.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });

        });
    }

    // Archetype Selector - populate dropdown and add event listener
    const archetypeSelector = document.getElementById("archetypeSelector");
    if (archetypeSelector) {
        // Populate dropdown with all loaded archetypes
        // First, clear any existing archetype options (keep "Analyze Image..." and "Manual Input")
        const existingOptions = Array.from(archetypeSelector.options);
        existingOptions.forEach(opt => {
            if (opt.value !== 'auto' && opt.value !== 'manual' && !opt.disabled) {
                archetypeSelector.removeChild(opt);
            }
        });

        // Add archetype options
        Object.keys(ARCHETYPES).forEach(archetypeId => {
            const archetype = ARCHETYPES[archetypeId];
            const option = document.createElement('option');
            option.value = archetypeId;
            option.textContent = archetype.name;
            archetypeSelector.appendChild(option);
        });


        // Add change event listener
        archetypeSelector.addEventListener('change', async () => {
            const selectedValue = archetypeSelector.value;

            if (selectedValue === 'auto') {
                // "Analyze Image..." - trigger DNA analysis
                pluginState.lastSelectedArchetypeId = null;  // Clear manual selection
                await handleAnalyzeImage();
            } else if (selectedValue === 'manual') {
                // "Manual Input" - reset to defaults
                pluginState.lastSelectedArchetypeId = null;  // Clear manual selection

                // Use the same defaults as btnResetDefaults
                const defaults = {
                    engineType: 'reveal-mk1.5',
                    centroidStrategy: 'SALIENCY',
                    substrateMode: 'white',
                    substrateTolerance: 3.5,
                    vibrancyMode: 'aggressive',
                    vibrancyBoost: 1.6,
                    highlightThreshold: 85,
                    highlightBoost: 2.2,
                    enablePaletteReduction: true,
                    paletteReduction: 10.0,
                    hueLockAngle: 18,
                    shadowPoint: 15,
                    lWeight: 1.1,
                    cWeight: 2.0,
                    blackBias: 5.0,
                    colorMode: 'color',
                    targetColors: 6,
                    preserveWhite: false,
                    preserveBlack: false,
                    ignoreTransparent: true,
                    enableHueGapAnalysis: true,
                    maskProfile: 'Gray Gamma 2.2',
                    // Production Quality Controls (defaults off)
                    minVolume: 0,
                    speckleRescue: 0,
                    shadowClamp: 0
                };

                // Reset all form controls
                const resetDefaults = { ...defaults, targetColorsSlider: defaults.targetColors };
                delete resetDefaults.targetColors;

                Object.keys(resetDefaults).forEach(key => {
                    const element = document.getElementById(key);
                    if (!element) return;

                    const value = resetDefaults[key];

                    if (element.type === 'checkbox') {
                        element.checked = value;
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (element.tagName === 'SELECT') {
                        element.value = value;
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                    } else if (element.tagName === 'SP-SLIDER') {
                        element.value = value;
                        const valueDisplay = document.getElementById(`${key}Value`);
                        if (valueDisplay) {
                            const config = sliderConfigs.find(c => c.id === key);
                            if (config) {
                                valueDisplay.textContent = config.format(value);
                            } else {
                                valueDisplay.textContent = value.toString();
                            }
                        }
                        element.dispatchEvent(new Event('input', { bubbles: true }));
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                });

                // Clear stored config
                pluginState.lastGeneratedConfig = null;
                pluginState.lastImageDNA = null;

            } else {
                // Archetype selected - load parameters from archetype
                const archetype = ARCHETYPES[selectedValue];

                if (archetype && archetype.parameters) {
                    pluginState.lastSelectedArchetypeId = selectedValue;  // Store manual selection ID

                    const params = archetype.parameters;

                    // Map archetype parameters to UI controls
                    const paramMapping = {
                        engineType: params.engineType,
                        centroidStrategy: params.centroidStrategy,
                        targetColorsSlider: params.targetColorsSlider,
                        ditherType: params.ditherType,
                        distanceMetric: params.distanceMetric,
                        lWeight: params.lWeight,
                        cWeight: params.cWeight,
                        blackBias: params.blackBias,
                        vibrancyMode: params.vibrancyMode,
                        vibrancyBoost: params.vibrancyBoost,
                        highlightThreshold: params.highlightThreshold,
                        highlightBoost: params.highlightBoost,
                        enablePaletteReduction: params.enablePaletteReduction,
                        paletteReduction: params.paletteReduction,
                        substrateMode: params.substrateMode,
                        substrateTolerance: params.substrateTolerance,
                        shadowPoint: params.shadowPoint,
                        enableHueGapAnalysis: params.enableHueGapAnalysis,
                        hueLockAngle: params.hueLockAngle,
                        colorMode: params.colorMode,
                        preserveWhite: params.preserveWhite,
                        preserveBlack: params.preserveBlack,
                        ignoreTransparent: params.ignoreTransparent,
                        maskProfile: params.maskProfile,
                        // Production Quality Controls (Archetype Overrides)
                        minVolume: params.minVolume,
                        speckleRescue: params.speckleRescue,
                        shadowClamp: params.shadowClamp
                    };

                    // Apply parameters to UI

                    try {
                        Object.keys(paramMapping).forEach(key => {
                        const element = document.getElementById(key);
                        if (!element) {
                            return;
                        }

                        const value = paramMapping[key];

                        // Special diagnostic for paletteReduction
                        if (key === 'paletteReduction') {
                        }

                        if (element.type === 'checkbox') {
                            element.checked = value;
                            // Don't dispatch events - we're loading programmatically, not responding to user input
                        } else if (element.tagName === 'SELECT') {
                            element.value = value;
                            // Don't dispatch events - we're loading programmatically
                        } else if (element.tagName === 'SP-SLIDER') {
                            element.value = value;
                            const valueDisplay = document.getElementById(`${key}Value`);
                            if (valueDisplay) {
                                const config = sliderConfigs.find(c => c.id === key);
                                if (config) {
                                    valueDisplay.textContent = config.format(value);
                                } else {
                                    valueDisplay.textContent = value.toString();
                                }
                            }
                            // Don't dispatch events - we're loading programmatically

                            // Special diagnostic for paletteReduction AFTER setting
                            if (key === 'paletteReduction') {
                            }
                        }

                            // Log if paletteReduction wasn't handled by any branch
                            if (key === 'paletteReduction' && element.tagName !== 'SP-SLIDER' && element.tagName !== 'SELECT' && element.type !== 'checkbox') {
                            }
                        });

                    } catch (error) {
                        logger.error(`❌ ERROR in UI application loop:`, error);
                        logger.error(`   Error message: ${error.message}`);
                        logger.error(`   Error stack:`, error.stack);
                    }


                    // Store the complete config for posterization (includes parameters not in UI)
                    // CRITICAL: Must include archetype ID and metadata to prevent parameter dilution
                    pluginState.lastGeneratedConfig = {
                        // Identity (prevents DNA hijacking)
                        id: archetype.id,
                        name: archetype.name,

                        // All parameters from archetype JSON
                        ...params,

                        // Metadata
                        meta: {
                            archetype: archetype.name,
                            archetypeId: archetype.id,
                            manualSelection: true  // Flag to indicate this was manually chosen
                        }
                    };

                } else {
                    logger.error(`Archetype not found or missing parameters: ${selectedValue}`);
                }
            }
        });

    }

    // Preview Quality dropdown - initial setup for fit mode
    // Each mode switch (Fit/Zoom) rebuilds the dropdown from scratch via rebuildPreviewStrideForMode()
    rebuildPreviewStrideForMode('fit');

    // Analyse Image button handler (image analysis for dynamic configuration)
    const btnAnalyzeAndSet = document.getElementById("btnAnalyzeAndSet");
    if (btnAnalyzeAndSet) {
        btnAnalyzeAndSet.addEventListener("click", async () => {
            // Disable button and show loading state
            const originalText = btnAnalyzeAndSet.textContent;
            btnAnalyzeAndSet.disabled = true;
            btnAnalyzeAndSet.textContent = "Analysing...";
            btnAnalyzeAndSet.style.opacity = "0.6";
            document.body.style.cursor = "wait";

            try {
                // Call shared analysis function
                await handleAnalyzeImage();
            } finally {
                // Restore button and cursor state
                btnAnalyzeAndSet.disabled = false;
                btnAnalyzeAndSet.textContent = originalText;
                btnAnalyzeAndSet.style.opacity = "1";
                document.body.style.cursor = "";
            }
        });
    }


    // Preset selector handler (DEPRECATED - DNA analysis now used)
    // Kept for rollback if needed
    /* const presetSelector = document.getElementById("presetSelector");
    if (presetSelector) {
        presetSelector.addEventListener("change", () => {
            const presetId = presetSelector.value;

            if (!presetId) {
                return;
            }

            const preset = PARAMETER_PRESETS[presetId];
            if (!preset) {
                logger.error(`Invalid preset ID: ${presetId}`);
                return;
            }


            // Apply preset settings
            applyAnalyzedSettings(preset.settings);

            // Reset selector to default
            presetSelector.value = "";

            // Log confirmation to console (no alert dialog)
        });
    } */

    // Palette Reduction checkbox toggle
    const enablePaletteReductionCheckbox = document.getElementById("enablePaletteReduction");
    const paletteReductionSlider = document.getElementById("paletteReduction");
    const paletteReductionControl = document.getElementById("paletteReductionControl");

    if (enablePaletteReductionCheckbox && paletteReductionSlider && paletteReductionControl) {
        // Toggle slider enabled/disabled based on checkbox
        const updateReductionState = () => {
            const enabled = enablePaletteReductionCheckbox.checked;
            paletteReductionSlider.disabled = !enabled;
            paletteReductionControl.style.opacity = enabled ? "1" : "0.5";
        };

        enablePaletteReductionCheckbox.addEventListener("change", updateReductionState);
        updateReductionState(); // Set initial state
    }

    // NOTE: Apply Separation button handler is attached in showPaletteEditor()
    // This ensures a fresh handler with current posterizationData on each invocation

    // Mark listeners as attached so they don't get duplicated on dialog reopen
    pluginState.listenersAttached = true;
}

module.exports = {
    attachAllEventListeners
};
