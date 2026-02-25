/**
 * PaletteEditor - The showPaletteEditor() function and all internal closures
 *
 * Includes: swatch rendering, color picker, production quality listeners,
 * Apply Separation handler.
 *
 * Imports: PluginState, ColorUtils, MechanicalFilters, SwatchManager,
 *          PreviewRenderer, ViewModeController, DialogHelpers
 */

const { core, action, imaging, app } = require("photoshop");

const Reveal = require("@reveal/core");
const PosterizationEngine = Reveal.engines.PosterizationEngine;
const SeparationEngine = Reveal.engines.SeparationEngine;
const LabDistance = Reveal.LabDistance;
const logger = Reveal.logger;

const pluginState = require('./PluginState');
const { hexToRgb, rgbToHex, showPhotoshopColorPicker, resolveDistanceMetric } = require('./ColorUtils');
const { applyShadowClamp, applyMinVolume, applySpeckleRescue } = require('./MechanicalFiltersAdapter');
const { handleSwatchClick, handleSwatchDelete, updateSwatchHighlights, updateSwatchVisuals, clearSwatchSelection } = require('./SwatchManager');
const { renderPreview, renderNavigatorMap, render1to1Preview, renderCropWithFilters } = require('./PreviewRenderer');
const { detachPreviewZoomHandlers } = require('./ViewModeController');
const { showErrorDialog } = require('./DialogHelpers');
const { getFormValues } = require('./FormHelpers');
const PhotoshopAPI = require("./api/PhotoshopAPI");

/**
 * Merge palette entries that are perceptually indistinguishable (ΔE < threshold).
 * First-encountered color wins; later duplicates collapse into it.
 * Returns a new set of arrays — never mutates the originals.
 *
 * NOTE: paletteLab may contain a trailing substrate entry beyond hexColors.length.
 * Only ink entries (0..hexColors.length-1) are compared for merging;
 * any trailing entries (substrate) are preserved unchanged.
 */
function preFlightPaletteMerge(paletteLab, hexColors, originalHexColors, threshold = 2.0) {
    const mergedLab = [];
    const mergedHex = [];
    const mergedOriginalHex = [];

    for (let i = 0; i < hexColors.length; i++) {
        let foundMatch = false;
        for (let j = 0; j < mergedLab.length; j++) {
            if (LabDistance.cie76(paletteLab[i], mergedLab[j]) < threshold) {
                foundMatch = true;
                break;
            }
        }
        if (!foundMatch) {
            mergedLab.push(paletteLab[i]);
            mergedHex.push(hexColors[i]);
            mergedOriginalHex.push(originalHexColors[i]);
        }
    }

    // Preserve trailing palette entries beyond ink range (e.g., substrate)
    const trailingLab = paletteLab.slice(hexColors.length);

    return {
        paletteLab: [...mergedLab, ...trailingLab],
        hexColors: mergedHex,
        originalHexColors: mergedOriginalHex,
        mergeCount: hexColors.length - mergedLab.length
    };
}

/**
 * Show palette editor section and hide preview section
 */
function showPaletteEditor(selectedPalette) {

    // Close the main dialog
    const mainDialog = document.getElementById('mainDialog');
    if (mainDialog) {
        mainDialog.close();
    }

    // Open the palette dialog
    const paletteDialog = document.getElementById('paletteDialog');
    if (!paletteDialog) {
        logger.error("Palette dialog not found!");
        return;
    }

    paletteDialog.showModal({
        resize: "both",
        size: {
            width: 1200,
            height: 800,
            minWidth: 800,
            minHeight: 600,
            maxWidth: 1600,
            maxHeight: 1000
        }
    });

    // UXP workaround: CSS flexbox doesn't properly fill dialog space on resize
    function updatePanelLayout() {
        const dialog = document.getElementById('paletteDialog');
        const content = dialog.querySelector('.reveal-content');
        const formSection = dialog.querySelector('.form-section');
        const mainFlex = formSection?.firstElementChild;

        if (!dialog || !content || !formSection || !mainFlex) return;

        const dialogRect = dialog.getBoundingClientRect();
        const titleEl = dialog.querySelector('.reveal-title');
        const buttonsEl = dialog.querySelector('.reveal-buttons');

        const titleHeight = titleEl ? titleEl.offsetHeight : 0;
        const buttonsHeight = buttonsEl ? buttonsEl.offsetHeight : 0;
        const padding = 48;

        const availableHeight = dialogRect.height - titleHeight - buttonsHeight - padding;

        content.style.height = `${availableHeight}px`;
        formSection.style.height = `${availableHeight - 24}px`;
        mainFlex.style.height = `${availableHeight - 24}px`;
    }

    setTimeout(updatePanelLayout, 100);

    if (typeof ResizeObserver !== 'undefined') {
        const resizeObserver = new ResizeObserver(() => {
            updatePanelLayout();
        });
        resizeObserver.observe(paletteDialog);
    }

    // Snapshot entry state for "Reset to Defaults"
    const entryState = {
        hexColors: [...selectedPalette.hexColors],
        allHexColors: [...selectedPalette.allHexColors],
        paletteLab: selectedPalette.paletteLab.map(c => ({...c})),
        palette: selectedPalette.palette.map(c => ({...c})),
        minVolume: parseFloat(document.getElementById('minVolume')?.value || '0'),
        speckleRescue: parseFloat(document.getElementById('speckleRescue')?.value || '0'),
        shadowClamp: parseFloat(document.getElementById('shadowClamp')?.value || '0')
    };

    // Render palette swatches (extracted to function for re-rendering after color changes)
    function renderPaletteSwatches() {
        const container = document.getElementById('editablePaletteContainer');

        const swatchesHTML = selectedPalette.hexColors.map((hex, featureIndex) => {
            const rgb = hexToRgb(hex);
            const lab = PosterizationEngine.rgbToLab(rgb);
            const lightnessPercent = Math.round(lab.L);
            const lightnessLabel = lightnessPercent < 33 ? 'Shadow' : lightnessPercent < 67 ? 'Midtone' : 'Highlight';

            const labDisplay = `L${Math.round(lab.L)} a${Math.round(lab.a)} b${Math.round(lab.b)}`;

            return `
            <div class="editable-swatch-container">
                <div class="editable-swatch"
                     style="background-color: ${hex};"
                     data-feature-index="${featureIndex}"
                     data-hex="${hex}"
                     title="Click: Highlight in preview&#10;Alt+Click: Toggle delete">
                    <div class="lightness-badge">L${lightnessPercent}</div>
                </div>
                <div class="editable-swatch-label">${lightnessLabel}</div>
                <div class="editable-swatch-lab clickable-lab"
                     data-feature-index="${featureIndex}"
                     data-hex="${hex}"
                     title="Click to choose ink color"
                     style="cursor: pointer; padding: 2px; border-radius: 2px; transition: background 0.2s;">${labDisplay}</div>
            </div>
        `;
        }).join('');

        container.innerHTML = swatchesHTML;

        attachSwatchClickHandlers();
    }

    renderPaletteSwatches();

    updateSwatchVisuals();

    // CRITICAL: Force UXP to recalculate flex layout after innerHTML injection
    requestAnimationFrame(() => {
        const container = document.getElementById('editablePaletteContainer');

        const height = container.offsetHeight;

        const swatches = container.querySelectorAll('.editable-swatch-container');
        swatches.forEach(swatch => {
            swatch.offsetHeight;
        });

        if (swatches.length > 0) {
            const firstSwatch = swatches[0];
        }
    });

    // Attach click handlers to swatches
    function attachSwatchClickHandlers() {
        const container = document.getElementById('editablePaletteContainer');

        // Handler: Lab text click → Color Picker
        const labTexts = container.querySelectorAll('.clickable-lab');

        labTexts.forEach(labText => {
            labText.addEventListener('mouseenter', () => {
                labText.style.background = '#e3f2fd';
            });
            labText.addEventListener('mouseleave', () => {
                labText.style.background = 'transparent';
            });

            labText.addEventListener('click', async (event) => {
                event.stopPropagation();

                const featureIndex = parseInt(labText.dataset.featureIndex);
                const currentHex = labText.dataset.hex;
                const currentRgb = hexToRgb(currentHex);

                if (window.previewState) {
                    window.previewState.activeSoloIndex = featureIndex;
                    renderPreview();
                }

                try {
                    const result = await showPhotoshopColorPicker(currentRgb);

                    if (!result) {
                        return;
                    }

                    const newHex = rgbToHex(result.red, result.green, result.blue);

                    if (newHex === currentHex) {
                        return;
                    }

                    const newLab = PosterizationEngine.rgbToLab({ r: result.red, g: result.green, b: result.blue });

                    const MIN_DISTANCE = 12;
                    let tooSimilar = false;
                    let similarTo = null;
                    let minDistance = Infinity;

                    for (let i = 0; i < selectedPalette.hexColors.length; i++) {
                        if (i === featureIndex) continue;

                        const otherHex = selectedPalette.hexColors[i];
                        const distance = PosterizationEngine.calculateHexDistance(newHex, otherHex);

                        if (distance < MIN_DISTANCE) {
                            tooSimilar = true;
                            similarTo = i + 1;
                            minDistance = distance;
                            break;
                        }
                    }

                    if (tooSimilar) {
                        alert(`Warning: This color is very similar to Feature ${similarTo} (dE=${minDistance.toFixed(1)}). Colors may not separate cleanly in final output.`);
                    }

                    selectedPalette.hexColors[featureIndex] = newHex;

                    const substrateIndex = selectedPalette.substrateIndex;
                    let paletteIndex = featureIndex;
                    if (substrateIndex !== null && featureIndex >= substrateIndex) {
                        paletteIndex = featureIndex + 1;
                    }

                    selectedPalette.allHexColors[paletteIndex] = newHex;
                    selectedPalette.paletteLab[paletteIndex] = newLab;

                    renderPaletteSwatches();
                    updateSwatchVisuals();

                    if (window.previewState) {
                        window.previewState.palette = selectedPalette.allHexColors;
                        renderPreview();
                    }

                } catch (error) {
                    logger.error(`Failed to show color picker:`, error);
                    alert(`Error showing color picker: ${error.message}`);
                }
            });
        });

        // Handler: Swatch click → Highlight color in canvas preview
        const swatches = container.querySelectorAll('.editable-swatch');

        swatches.forEach(swatch => {
            swatch.addEventListener('click', (event) => {
                event.stopPropagation();

                const featureIndex = parseInt(swatch.dataset.featureIndex);

                if (event.altKey) {
                    handleSwatchDelete(featureIndex);
                    return;
                }

                handleSwatchClick(featureIndex);
            });
        });

        // Handler: Click on preview container → Clear swatch selection
        const previewContainer = document.getElementById('previewContainer');
        if (previewContainer && !previewContainer._clickHandlerAttached) {
            previewContainer.addEventListener('click', () => {
                clearSwatchSelection();
            });
            previewContainer._clickHandlerAttached = true;
        }

    }

    // Production Quality Control sliders
    let rerunInProgress = false;
    let rerunDebounceTimer = null;
    let lastRerunTime = 0;
    const MIN_RERUN_INTERVAL = 500;

    if (!window._productionQualityHandlers) {
        window._productionQualityHandlers = {};
    }

    function attachProductionQualityListeners() {
        const sliders = [
            { id: 'minVolume', name: 'Min Volume', format: v => v.toFixed(1) },
            { id: 'speckleRescue', name: 'Speckle Rescue', format: v => v.toFixed(0) },
            { id: 'shadowClamp', name: 'Shadow Clamp', format: v => v.toFixed(1) }
        ];

        sliders.forEach(({ id, name, format }) => {
            const slider = document.getElementById(id);
            const valueDisplay = document.getElementById(`${id}Value`);

            if (!slider) {
                return;
            }

            if (window._productionQualityHandlers[id]) {
                const prev = window._productionQualityHandlers[id];
                slider.removeEventListener('input', prev.input);
                slider.removeEventListener('change', prev.change);
            }

            const inputHandler = () => {
                const value = parseFloat(slider.value);
                if (valueDisplay) {
                    valueDisplay.textContent = format(value);
                }
                if (window.previewState?.viewMode === '1:1' && window._cachedCropData) {
                    renderCropWithFilters();
                }
            };
            slider.addEventListener('input', inputHandler);

            const changeHandler = async () => {
                const value = parseFloat(slider.value);

                if (rerunDebounceTimer) {
                    clearTimeout(rerunDebounceTimer);
                }

                if (rerunInProgress) {
                    return;
                }

                const now = Date.now();
                const timeSinceLastRerun = now - lastRerunTime;
                if (timeSinceLastRerun < MIN_RERUN_INTERVAL && lastRerunTime > 0) {
                }

                rerunDebounceTimer = setTimeout(async () => {
                    const timeSinceLastCheck = Date.now() - lastRerunTime;
                    if (timeSinceLastCheck < MIN_RERUN_INTERVAL && lastRerunTime > 0) {
                        return;
                    }

                    if (rerunInProgress) {
                        return;
                    }

                    rerunInProgress = true;
                    lastRerunTime = Date.now();
                    document.body.style.cursor = 'wait';

                    try {
                        const config = getFormValues();
                        await rerunPosterization(config);
                    } catch (error) {
                        logger.error(`Failed to re-posterize with ${name}:`, error);
                        logger.error(`   Stack:`, error.stack);
                        alert(`Re-posterization failed: ${error.message}\n\nPlease run posterization again from Parameters dialog.`);
                    } finally {
                        document.body.style.cursor = '';
                        rerunInProgress = false;
                    }
                }, 500);
            };
            slider.addEventListener('change', changeHandler);

            window._productionQualityHandlers[id] = { input: inputHandler, change: changeHandler };

        });
    }

    // FROZEN PALETTE PROTOCOL: Apply mechanical filters WITHOUT regenerating colors
    async function rerunPosterization(config) {
        try {

            const frozenPalette = window._frozenPalette;
            if (!frozenPalette || !frozenPalette.labPalette) {
                throw new Error('Frozen palette not available - posterize first');
            }

            const originalData = window._originalImageData;
            if (!originalData || !originalData.labPixels) {
                throw new Error('Original image data not available');
            }

            const labPixels = new Uint16Array(originalData.labPixels);
            const { width, height } = originalData;

            const assignments = await SeparationEngine.mapPixelsToPaletteAsync(
                labPixels,
                frozenPalette.labPalette,
                null,
                width,
                height,
                {
                    distanceMetric: originalData.config?.distanceMetric || 'cie76',
                    ditherType: 'none'
                }
            );

            let processedAssignments = assignments;

            if (config.shadowClamp > 0) {
                processedAssignments = applyShadowClamp(
                    processedAssignments,
                    frozenPalette.labPalette.length,
                    config.shadowClamp
                );
            }

            if (config.minVolume > 0) {
                processedAssignments = applyMinVolume(
                    processedAssignments,
                    frozenPalette.labPalette,
                    config.minVolume
                );
            }

            if (config.speckleRescue > 0) {
                processedAssignments = applySpeckleRescue(
                    processedAssignments,
                    width,
                    height,
                    config.speckleRescue
                );
            }

            const result = {
                palette: frozenPalette.rgbPalette,
                paletteLab: frozenPalette.labPalette,
                assignments: processedAssignments,
                width: width,
                height: height
            };

            const hexColors = frozenPalette.hexColors;

            window.selectedPreview.assignments = processedAssignments;

            if (window.previewState) {
                window.previewState.palette = hexColors;
                window.previewState.assignments = result.assignments;

                try {
                    if (window.previewState.viewMode === '1:1') {
                        await render1to1Preview();

                        renderNavigatorMap();
                    } else if (window.previewState.viewMode === 'zoom') {
                        if (window.previewState.zoomRenderer) {
                            await window.previewState.zoomRenderer.fetchAndRender();
                        }
                    } else {
                        renderPreview();
                    }
                } catch (previewError) {
                    logger.error(`   Failed to update preview:`, previewError);
                    throw new Error(`Preview update failed: ${previewError.message}`);
                }
            }

        } catch (error) {
            logger.error(`Re-posterization failed:`, error);
            logger.error(`   Stack:`, error.stack);
            throw error;
        }
    }

    attachProductionQualityListeners();

    // Hide "Posterize" button, show "Apply Separation" and "Back" buttons
    const btnPosterize = document.getElementById('btnPosterize');
    if (btnPosterize) btnPosterize.style.display = 'none';

    const btnApplySeparation = document.getElementById('btnApplySeparation');
    btnApplySeparation.style.display = 'block';
    btnApplySeparation.style.visibility = 'visible';

    btnApplySeparation.disabled = false;
    btnApplySeparation.textContent = "Separate with this palette \u2192";

    const btnBack = document.getElementById('btnBack');
    if (btnBack) {
        btnBack.style.display = 'block';
    }

    const buttonsContainer = document.querySelector('.reveal-buttons');
    if (buttonsContainer) {
        buttonsContainer.style.display = 'flex';
    }

    // Reset to Defaults handler
    const btnReset = document.getElementById('btnPaletteReset');
    if (btnReset) {
        const btnResetClone = btnReset.cloneNode(true);
        btnReset.parentNode.replaceChild(btnResetClone, btnReset);

        btnResetClone.addEventListener('click', async () => {
            // Restore palette data from entry snapshot
            selectedPalette.hexColors = [...entryState.hexColors];
            selectedPalette.allHexColors = [...entryState.allHexColors];
            selectedPalette.paletteLab = entryState.paletteLab.map(c => ({...c}));
            selectedPalette.palette = entryState.palette.map(c => ({...c}));

            // Clear UI state
            if (window.previewState) {
                window.previewState.deletedIndices = new Set();
                window.previewState.activeSoloIndex = null;
                window.previewState.palette = [...entryState.allHexColors];
            }

            // Reset production quality sliders to entry values
            const sliderResets = [
                { id: 'minVolume', value: entryState.minVolume, format: v => v.toFixed(1) },
                { id: 'speckleRescue', value: entryState.speckleRescue, format: v => v.toFixed(0) },
                { id: 'shadowClamp', value: entryState.shadowClamp, format: v => v.toFixed(1) }
            ];
            sliderResets.forEach(({ id, value, format }) => {
                const slider = document.getElementById(id);
                const display = document.getElementById(`${id}Value`);
                if (slider) slider.value = value;
                if (display && value !== undefined) display.textContent = format(value);
            });

            // Rebuild swatch UI
            renderPaletteSwatches();
            updateSwatchVisuals();

            // Regenerate assignments and preview with entry slider values
            try {
                const config = getFormValues();
                await rerunPosterization(config);
            } catch (error) {
                logger.error('Reset re-posterization failed:', error);
            }
        });
    }

    // CRITICAL: Clone and replace button to remove ALL old event listeners
    const btnApplySeparationClone = btnApplySeparation.cloneNode(true);
    btnApplySeparation.parentNode.replaceChild(btnApplySeparationClone, btnApplySeparation);
    const btnApply = btnApplySeparationClone;

    btnApply.addEventListener("click", async () => {

        if (btnApply.disabled) {
            logger.warn('Separation already in progress, ignoring duplicate click');
            return;
        }

        btnApply.disabled = true;
        btnApply.textContent = "Applying Separation...";

        if (!pluginState.posterizationData) {
            alert("Error: No posterization data found. Please restart the workflow.");
            btnApply.disabled = false;
            btnApply.textContent = "Separate with this palette \u2192";
            return;
        }

        const selectedPreview = pluginState.posterizationData.selectedPreview;

        if (!selectedPreview) {
            alert("Error: No color palette selected. Please go back and select a palette.");
            btnApply.disabled = false;
            btnApply.textContent = "Separate with this palette \u2192";
            return;
        }

        let hexColors = selectedPreview.hexColors;
        let originalHexColors = selectedPreview.originalHexColors;
        let paletteLab = selectedPreview.paletteLab;

        if (window.previewState && window.previewState.deletedIndices.size > 0) {
            const deletedIndices = window.previewState.deletedIndices;

            hexColors = selectedPreview.hexColors.filter((_, idx) => !deletedIndices.has(idx));
            originalHexColors = selectedPreview.originalHexColors.filter((_, idx) => !deletedIndices.has(idx));
            paletteLab = selectedPreview.paletteLab.filter((_, idx) => !deletedIndices.has(idx));

        }

        // Pre-flight merge: collapse near-duplicate colors the user may have edited
        const mergeResult = preFlightPaletteMerge(paletteLab, hexColors, originalHexColors);
        if (mergeResult.mergeCount > 0) {
            const saved = mergeResult.mergeCount;
            logger.log(`Pre-flight merge: collapsed ${saved} near-duplicate color${saved > 1 ? 's' : ''}`);
            hexColors = mergeResult.hexColors;
            originalHexColors = mergeResult.originalHexColors;
            paletteLab = mergeResult.paletteLab;
        }

        const separationStartTime = Date.now();

        let fullResPixels = null;
        let fullResLayers = null;

        try {
            await core.executeAsModal(async (executionContext) => {

                const ditherTypeEl = document.getElementById('ditherType');
                const ditherType = ditherTypeEl ? ditherTypeEl.value : 'none';

                const distanceMetricEl = document.getElementById('distanceMetric');
                const distanceMetricSetting = distanceMetricEl ? distanceMetricEl.value : 'auto';
                const distanceMetric = resolveDistanceMetric(distanceMetricSetting, pluginState.lastImageDNA);
                const metricLabels = {
                    'cie76': 'Poster/Graphic (CIE76)',
                    'cie94': 'Photographic (CIE94)',
                    'cie2000': 'Museum Grade (CIE2000)'
                };
                const metricLabel = metricLabels[distanceMetric] || distanceMetric;

                const meshSizeEl = document.getElementById('meshSize');
                let meshValue = meshSizeEl ? parseInt(meshSizeEl.value, 10) : 0;

                if (meshSizeEl && meshSizeEl.value === 'custom') {
                    const customMeshEl = document.getElementById('customMeshValue');
                    meshValue = customMeshEl ? parseInt(customMeshEl.value, 10) : 0;
                }

                const preDocInfo = PhotoshopAPI.getDocumentInfo();
                const documentPPI = preDocInfo ? preDocInfo.resolution : 72;

                if (meshValue > 0) {
                    const maxLPI = Math.floor(meshValue / 7);
                    const cellSize = Math.ceil(documentPPI / maxLPI);
                }

                const layers = await SeparationEngine.separateImage(
                    pluginState.posterizationData.originalPixels,
                    pluginState.posterizationData.originalWidth,
                    pluginState.posterizationData.originalHeight,
                    hexColors,
                    originalHexColors,
                    paletteLab,
                    {
                        onProgress: (percent) => {
                            if (percent % 25 === 0) {
                            }
                        },
                        ditherType: ditherType,
                        mesh: meshValue,
                        ppi: documentPPI,
                        distanceMetric: distanceMetric
                    }
                );

                const docInfo = PhotoshopAPI.getDocumentInfo();

                fullResPixels = await PhotoshopAPI.getDocumentPixels(docInfo.width, docInfo.height);

                fullResLayers = await SeparationEngine.separateImage(
                    fullResPixels.pixels,
                    fullResPixels.width,
                    fullResPixels.height,
                    hexColors,
                    originalHexColors,
                    paletteLab,
                    {
                        onProgress: (percent) => {
                            if (percent % 25 === 0) {
                            }
                        },
                        ditherType: ditherType,
                        mesh: meshValue,
                        ppi: docInfo.resolution,
                        distanceMetric: distanceMetric
                    }
                );

                let substrateLayer = null;
                let inkLayers = [];

                let whiteLayer = null;
                let blackLayer = null;
                let detectedSubstrateLayer = null;

                const totalPixels = fullResPixels.width * fullResPixels.height;
                const SUBSTRATE_MIN_COVERAGE = 5.0;

                for (const layer of fullResLayers) {
                    let coveragePixels = 0;
                    for (let i = 0; i < layer.mask.length; i++) {
                        if (layer.mask[i] > 0) coveragePixels++;
                    }
                    const coveragePercent = (coveragePixels / totalPixels) * 100;

                    const whiteL = layer.labColor.L > 99;
                    const whiteA = Math.abs(layer.labColor.a - 0) < 2;
                    const whiteB = Math.abs(layer.labColor.b - 0) < 2;
                    const whiteCoverage = coveragePercent >= SUBSTRATE_MIN_COVERAGE;
                    const isWhite = whiteL && whiteA && whiteB && whiteCoverage;

                    const blackL = layer.labColor.L < 5;
                    const blackA = Math.abs(layer.labColor.a - 0) < 5;
                    const blackB = Math.abs(layer.labColor.b - 0) < 5;
                    const blackCoverage = coveragePercent >= SUBSTRATE_MIN_COVERAGE;
                    const isBlack = blackL && blackA && blackB && blackCoverage;

                    const matchesDetectedSubstrate = selectedPreview.substrateLab &&
                                       Math.abs(layer.labColor.L - selectedPreview.substrateLab.L) < 0.1 &&
                                       Math.abs(layer.labColor.a - selectedPreview.substrateLab.a) < 0.1 &&
                                       Math.abs(layer.labColor.b - selectedPreview.substrateLab.b) < 0.1;

                    if (isWhite) {
                        whiteLayer = layer;
                    } else if (isBlack) {
                        blackLayer = layer;
                    } else if (matchesDetectedSubstrate) {
                        detectedSubstrateLayer = layer;
                    } else {
                        inkLayers.push(layer);
                    }
                }

                const autoDetectedWhite = selectedPreview.substrateLab && selectedPreview.substrateLab.L > 95;
                const autoDetectedBlack = selectedPreview.substrateLab && selectedPreview.substrateLab.L < 5;

                if (autoDetectedWhite) {
                    if (whiteLayer) {
                        substrateLayer = whiteLayer;
                    } else {
                        const allLayers = [...inkLayers];
                        if (blackLayer) allLayers.push(blackLayer);
                        if (detectedSubstrateLayer) allLayers.push(detectedSubstrateLayer);

                        let brightestLayer = null;
                        let brightestL = -1;
                        for (const layer of allLayers) {
                            if (layer.labColor.L > brightestL) {
                                brightestL = layer.labColor.L;
                                brightestLayer = layer;
                            }
                        }

                        if (brightestLayer && brightestL > 85) {
                            const idx = inkLayers.indexOf(brightestLayer);
                            if (idx >= 0) inkLayers.splice(idx, 1);

                            substrateLayer = brightestLayer;
                        }
                    }
                    if (blackLayer && substrateLayer !== blackLayer) {
                        if (!inkLayers.includes(blackLayer)) {
                            inkLayers.push(blackLayer);
                        }
                    }
                } else if (whiteLayer) {
                    substrateLayer = whiteLayer;
                    if (blackLayer) {
                        inkLayers.push(blackLayer);
                    }
                    if (detectedSubstrateLayer) {
                        inkLayers.push(detectedSubstrateLayer);
                    }
                } else if (autoDetectedBlack && blackLayer) {
                    substrateLayer = blackLayer;
                    if (detectedSubstrateLayer && detectedSubstrateLayer !== blackLayer) {
                        inkLayers.push(detectedSubstrateLayer);
                    }
                } else if (blackLayer) {
                    substrateLayer = blackLayer;
                    if (detectedSubstrateLayer) {
                        inkLayers.push(detectedSubstrateLayer);
                    }
                } else if (detectedSubstrateLayer) {
                    substrateLayer = detectedSubstrateLayer;
                }

                inkLayers.sort((a, b) => b.labColor.L - a.labColor.L);

                const orderedLayers = [];
                let layerIndex = 0;

                if (substrateLayer) {
                    orderedLayers.push(substrateLayer);
                    layerIndex++;
                }

                inkLayers.forEach((layer) => {
                    orderedLayers.push(layer);
                    layerIndex++;
                });
                const doc = PhotoshopAPI.getActiveDocument();
                if (!doc) {
                    throw new Error("No active document");
                }

                let suspensionID = null;
                let historySuspendedByUs = false;

                try {
                    suspensionID = await executionContext.hostControl.suspendHistory({
                        documentID: doc.id,
                        name: "Reveal"
                    });
                    historySuspendedByUs = true;
                } catch (err) {
                }

                try {
                    try {
                        for (const layer of doc.layers) {
                            if (!layer.visible) {
                                layer.visible = true;
                            }
                        }
                    } catch (err) {
                        logger.warn(`Could not show hidden layers: ${err.message}`);
                    }

                    await PhotoshopAPI.deleteAllLayersExceptBackground();

                    const originalLayer = doc.layers.length > 0 ? doc.layers[doc.layers.length - 1] : null;

                    const docBitDepth = String(doc.bitsPerChannel).toLowerCase();
                    const is16bit = docBitDepth.includes('16') || doc.bitsPerChannel === 16;

                    let skippedCount = 0;

                    for (let i = 0; i < orderedLayers.length; i++) {
                        const layerData = orderedLayers[i];

                        const layerDataWithProfile = {
                            ...layerData,
                            maskProfile: pluginState.posterizationData.params.maskProfile
                        };

                        const createdLayer = is16bit
                            ? await PhotoshopAPI.createLabSeparationLayer16Bit(layerDataWithProfile)
                            : await PhotoshopAPI.createLabSeparationLayer(layerDataWithProfile);

                        if (createdLayer === null) {
                            skippedCount++;
                        }
                    }

                    if (skippedCount > 0) {
                        const skipPercent = (skippedCount / orderedLayers.length * 100).toFixed(1);
                        logger.warn(`Skipped ${skippedCount}/${orderedLayers.length} layers (${skipPercent}%) due to empty masks`);

                        if (skippedCount > orderedLayers.length * 0.2) {
                            logger.error(`HIGH SKIP RATE: More than 20% of layers skipped!`);
                            logger.error(`   This may indicate a bug in mask generation or palette selection.`);
                        }
                    }

                    try {
                        if (originalLayer) {
                            const layerStillExists = doc.layers.find(l => l.id === originalLayer.id);
                            if (layerStillExists) {
                                originalLayer.visible = false;
                            } else {
                                logger.warn(`Original layer was deleted during separation`);
                            }
                        } else {
                            logger.warn(`No original layer reference to hide`);
                        }
                    } catch (err) {
                        logger.warn(`Could not hide original layer: ${err.message}`);
                    }

                    if (historySuspendedByUs && suspensionID !== null) {
                        await executionContext.hostControl.resumeHistory(suspensionID);
                    }
                } catch (error) {
                    if (historySuspendedByUs && suspensionID !== null) {
                        await executionContext.hostControl.resumeHistory(suspensionID, false);
                    }
                    throw error;
                }
            }, {
                commandName: "Reveal"
            });

            if (fullResPixels && fullResPixels.pixels) {
                fullResPixels.pixels = null;
            }
            fullResLayers.forEach(layer => {
                if (layer.mask) {
                    layer.mask = null;
                }
            });

            const paletteDialogEl = document.getElementById('paletteDialog');
            if (paletteDialogEl) {
                paletteDialogEl.close();
            }

        } catch (error) {
            logger.error("Error applying separation:", error);

            let errorMessage = error.message || error.toString() || "An unknown error occurred";

            let errorCode = error.number || error.code;

            if (!errorCode && errorMessage.includes("Code:")) {
                const codeMatch = errorMessage.match(/Code:\s*(-?\d+)/);
                if (codeMatch) {
                    errorCode = parseInt(codeMatch[1]);
                }
            }

            const isCancellation =
                errorCode === -8007 ||
                errorCode === 8007 ||
                errorMessage.toLowerCase().includes('cancel') ||
                errorMessage.toLowerCase().includes('abort') ||
                errorMessage.toLowerCase().includes('user stopped');

            if (isCancellation) {

                btnApply.disabled = false;
                btnApply.textContent = "Separate with this palette \u2192";

                return;
            }

            logger.error("Error details:", {
                message: errorMessage,
                code: errorCode,
                stack: error.stack
            });

            let errorDetails = '';
            if (errorCode) {
                errorDetails = `Photoshop Error Code: ${errorCode}`;

                if (errorCode === -25010) {
                    errorDetails += '\n\nThis error may occur with very large images or after multiple operations. Try:\n\u2022 Closing and reopening the document\n\u2022 Reducing the image size\n\u2022 Using fewer colors';
                }
            }

            showErrorDialog(
                "Separation Failed",
                errorMessage,
                errorDetails
            );

            btnApply.disabled = false;
            btnApply.textContent = "Separate with this palette \u2192";
        }
    });

    document.querySelector('.reveal-title').textContent = 'Reveal - Customize Palette & Separate';

}

module.exports = {
    showPaletteEditor
};
