/**
 * Reveal - Screen Printing Color Separation Plugin
 *
 * Main entry point for the plugin.
 * Phase 2.5: Posterization engine & preview UI
 */

const { entrypoints } = require("uxp");
const { core, action, imaging, app } = require("photoshop");

// Import @reveal/core engines
const Reveal = require("@reveal/core");
const PosterizationEngine = Reveal.engines.PosterizationEngine;
const BilateralFilter = require("@reveal/core/lib/preprocessing/BilateralFilter");
const logger = Reveal.logger;

// Photoshop-specific API (stays in reveal-adobe)
const PhotoshopAPI = require("./api/PhotoshopAPI");

// 1:1 Viewport components for mechanical knobs
const CropEngine = require('../../reveal-core/lib/engines/CropEngine');
const ViewportManager = require('./ViewportManager');

// Extracted modules
const pluginState = require('./PluginState');
const { showError, showErrorDialog } = require('./DialogHelpers');
const { getFormValues, validateForm } = require('./FormHelpers');
const { initializePreviewCanvas, renderPreview, renderNavigatorMap } = require('./PreviewRenderer');
const { setPreviewMode } = require('./ViewModeController');
const { showPaletteEditor } = require('./PaletteEditor');
const { attachAllEventListeners } = require('./EventSetup');

/**
 * Initialize the plugin
 */
function initPlugin() {
    logger.log('Reveal plugin loaded');
    logger.log(`Build ID: ${typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'}`);
    logger.log(`Build Time: ${typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'development'}`);
}

/**
 * Show the main dialog
 */
async function showDialog() {
    try {
        const dialog = document.getElementById("mainDialog");

        if (!dialog) {
            logger.error("Dialog element not found! DOM might not be ready.");
            throw new Error("Dialog element not found");
        }


        // CRITICAL: Validate document BEFORE showing dialog
        const validation = PhotoshopAPI.validateDocument();

        if (!validation.valid) {

            // Use alert instead of modal dialog to avoid UXP crashes during entrypoint
            const errorMessage = "Your document doesn't meet the requirements for Reveal:\n\n" +
                validation.errors.map((err, i) => `${i + 1}. ${err}`).join('\n');
            alert(errorMessage);

            return; // Don't open dialog
        }


        // CRITICAL: Reset UI state to initial view (parameter entry)
        // This ensures re-invoking the plugin starts fresh

        // Show parameter entry section wrapper
        const parameterEntrySection = document.getElementById('parameterEntrySection');
        if (parameterEntrySection) {
            parameterEntrySection.style.display = 'block';
        }

        // Show version badge
        const versionBadge = document.querySelector('.version-badge');
        if (versionBadge) {
            versionBadge.style.display = '';
            versionBadge.textContent = 'Phase 2: Parameter Entry';
        }

        // Hide auto-detect section
        document.getElementById('autoDetectSection').style.display = 'none';
        // Note: paletteEditorSection is now in a separate dialog (paletteDialog)

        // Show Posterize button (other buttons are in paletteDialog)
        const btnPosterize = document.getElementById('btnPosterize');
        if (btnPosterize) btnPosterize.style.display = '';

        // Note: btnApplySeparation and btnBack are now in paletteDialog, not mainDialog

        // Reset dialog title
        document.querySelector('.reveal-title').textContent = 'Reveal - Posterization Parameters';

        // Clear posterization data from previous session
        pluginState.posterizationData = null;

        // Clear preview state from previous session
        if (window.previewState) {
            window.previewState = null;
        }


        // CRITICAL: Set up event listeners BEFORE showing dialog
        // showModal() blocks until dialog closes, so code after it won't run until then!
        // Only attach listeners once to prevent accumulation on dialog reopen
        if (!pluginState.listenersAttached) {

            // Posterization handler - reads color mode from form values
            const handlePosterization = async (buttonElement, buttonOriginalText) => {
                // Validate form
                const errors = validateForm();

                if (errors.length > 0) {
                    showError("Validation Error", "Please correct the following errors:", errors);
                    return;
                }

                // Get form values and merge with stored config (includes parameters not in UI)
                const formParams = getFormValues();

                // DIAGNOSTIC: Log what we're merging
                if (pluginState.lastGeneratedConfig) {
                }

                const params = {
                    ...pluginState.lastGeneratedConfig,  // Start with complete config from ParameterGenerator
                    ...formParams            // Override with user-adjusted UI values
                };
                const grayscaleOnly = params.colorMode === 'bw';  // Determine from dropdown

                // Log final merged parameters
                if (pluginState.lastGeneratedConfig) {
                }

                try {
                    // Validate document (includes Lab mode check)
                    const docValidation = PhotoshopAPI.validateDocument();

                    if (!docValidation.valid) {
                        showError("Document Error", "Your document doesn't meet the requirements for Reveal:", docValidation.errors);
                        return;
                    }


                    // Get document info
                    const docInfo = PhotoshopAPI.getDocumentInfo();

                    // Show processing message
                    buttonElement.disabled = true;
                    buttonElement.textContent = "Analyzing...";

                    // Read document pixels for preview (800px max for performance)
                    const pixelData = await PhotoshopAPI.getDocumentPixels(800, 800);

                    // DIAGNOSTIC: Check ORIGINAL buffer before copying

                    // CRITICAL: Copy pixel buffer IMMEDIATELY before any processing
                    // Photoshop may clear/reuse the buffer after the API call returns
                    const pixelsCopy = new Uint16Array(pixelData.pixels);

                    // Apply preprocessing (bilateral filter for noise reduction) if enabled
                    // Engine always operates in 16-bit Lab space
                    const preprocessingIntensity = params.preprocessingIntensity || 'auto';

                    if (preprocessingIntensity !== 'off') {
                        buttonElement.textContent = "Preprocessing...";

                        // For "auto" mode, use DNA-based decision; for manual modes, force the setting
                        const dnaForPreprocessing = pluginState.lastImageDNA || {};

                        // Calculate entropy from 16-bit Lab L channel
                        if (pixelData.pixels && pixelData.pixels.length > 0) {
                        }
                        const entropyScore = BilateralFilter.calculateEntropyScoreLab(
                            pixelData.pixels, pixelData.width, pixelData.height
                        );

                        // Get preprocessing config based on DNA and entropy
                        // Detect bit depth from pixel data type
                        const is16Bit = pixelData.pixels instanceof Uint16Array;

                        let preprocessConfig;
                        if (preprocessingIntensity === 'auto') {
                            const decision = BilateralFilter.shouldPreprocess(dnaForPreprocessing, entropyScore, is16Bit);
                            preprocessConfig = {
                                enabled: decision.shouldProcess,
                                reason: decision.reason,
                                entropyScore,
                                radius: decision.radius,
                                sigmaR: decision.sigmaR,
                                intensity: decision.shouldProcess ? (decision.radius >= 5 ? 'heavy' : 'light') : 'off'
                            };
                        } else {
                            // Manual override (light or heavy) - use bit-depth-aware sigmaR
                            const isHeavy = preprocessingIntensity === 'heavy';
                            // 8-bit: sigmaR=10, 16-bit: sigmaR=500 (per architect recommendation)
                            // sigmaR in 16-bit L units (no internal scaling)
                            const sigmaR = is16Bit ? 5000 : 3000;
                            preprocessConfig = {
                                enabled: true,
                                reason: `${preprocessingIntensity} filter (user override)`,
                                entropyScore,
                                radius: isHeavy ? 5 : 3,
                                sigmaR: sigmaR,
                                intensity: preprocessingIntensity
                            };
                        }

                        if (preprocessConfig.enabled) {
                            console.log(`[Preprocess] APPLIED — entropy=${preprocessConfig.entropyScore?.toFixed(1)}, radius=${preprocessConfig.radius}, sigmaR=${preprocessConfig.sigmaR}, reason=${preprocessConfig.reason}`);

                            // Apply bilateral filter in 16-bit Lab space
                            BilateralFilter.applyBilateralFilterLab(
                                pixelData.pixels,
                                pixelData.width,
                                pixelData.height,
                                preprocessConfig.radius,
                                preprocessConfig.sigmaR
                            );

                        } else {
                            console.log(`[Preprocess] SKIPPED — entropy=${preprocessConfig.entropyScore?.toFixed(1)}, reason=${preprocessConfig.reason}`);
                        }
                    } else {
                        console.log(`[Preprocess] OFF — preprocessingIntensity=${preprocessingIntensity}`);
                    }

                    // TEMP: Store preprocessed image data (config will be stored later after tuning is defined)
                    // This must happen AFTER preprocessing so sliders can skip preprocessing step
                    window._originalImageData = {
                        labPixels: new Uint16Array(pixelsCopy), // pixelsCopy now contains preprocessed data
                        width: pixelData.width,
                        height: pixelData.height,
                        bitDepth: pixelData.bitDepth,
                        format: pixelData.format
                    };

                    // Determine color count (manual override or auto-detect)
                    let colorCount;
                    if (params.targetColors > 0) {
                        colorCount = params.targetColors;
                        buttonElement.textContent = `Posterizing to ${colorCount} colors...`;
                    } else {
                        buttonElement.textContent = "Analyzing complexity...";

                        colorCount = PosterizationEngine.analyzeOptimalColorCount(
                            pixelData.pixels,
                            pixelData.width,
                            pixelData.height
                        );

                        buttonElement.textContent = `Posterizing to ${colorCount} colors...`;
                    }

                    // Generate posterization using selected engine
                    // Factory method dispatches to appropriate algorithm based on engineType
                    // Build tuning config from UI parameters
                    const tuning = {
                        split: {
                            highlightBoost: params.highlightBoost,     // Facial highlight protection (default: 2.2)
                            vibrancyBoost: params.vibrancyBoost,       // Chroma-rich pixel weighting (default: 1.6)
                            minVariance: 10                             // Minimum variance to split
                        },
                        prune: {
                            threshold: params.paletteReduction,         // Delta-E merge distance (default: 9.0)
                            hueLockAngle: params.hueLockAngle,          // Hue protection angle (default: 18°)
                            whitePoint: params.highlightThreshold,      // L-value floor for white protection (default: 85)
                            shadowPoint: params.shadowPoint,            // L-value ceiling for shadow protection (default: 15)
                            isolationThreshold: params.isolationThreshold !== undefined ? params.isolationThreshold : 0.0  // Peak eligibility floor (25.0 = 1% minimum)
                        },
                        centroid: {
                            lWeight: params.lWeight,                    // Saliency lightness priority (default: 1.1)
                            cWeight: params.cWeight,                    // Saliency chroma priority (default: 2.0)
                            blackBias: params.blackBias,                // Black boost multiplier for halftones (default: 5.0)
                            bitDepth: pixelData.bitDepth,               // Source bit depth (8 or 16) for 16-bit precision fixes
                            vibrancyMode: params.vibrancyMode,          // Vibrancy mode: 'aggressive', 'exponential', 'linear'
                            vibrancyBoost: params.vibrancyBoost         // Vibrancy boost exponent (default: 2.2)
                        }
                    };

                    // Store config for re-posterization (now that tuning is defined)
                    window._originalImageData.config = {
                        engineType: params.engineType,
                        centroidStrategy: params.centroidStrategy,
                        distanceMetric: params.distanceMetric,
                        enableHueGapAnalysis: params.enableHueGapAnalysis,
                        preserveWhite: params.preserveWhite,
                        preserveBlack: params.preserveBlack,
                        preservedUnifyThreshold: params.preservedUnifyThreshold,
                        substrateMode: params.substrateMode,
                        substrateTolerance: params.substrateTolerance,
                        vibrancyMode: params.vibrancyMode,
                        vibrancyBoost: params.vibrancyBoost,
                        highlightThreshold: params.highlightThreshold,
                        highlightBoost: params.highlightBoost,
                        enablePaletteReduction: params.enablePaletteReduction,
                        paletteReduction: params.paletteReduction,
                        densityFloor: params.densityFloor,
                        isolationThreshold: params.isolationThreshold,
                        grayscaleOnly: grayscaleOnly,
                        tuning: tuning  // Now defined!
                    };

                    const result = PosterizationEngine.posterize(
                        pixelData.pixels,
                        pixelData.width,
                        pixelData.height,
                        colorCount,
                        {
                            engineType: params.engineType,           // NEW: Engine selection (reveal, balanced, classic, stencil)
                            centroidStrategy: params.centroidStrategy,  // NEW: User-selected strategy (SALIENCY or VOLUMETRIC)
                            enableGridOptimization: true,            // NEW: Default ON (Architect's requirement)
                            enableHueGapAnalysis: params.enableHueGapAnalysis,  // USER-CONTROLLED: Force hue diversity (default: ON, may exceed target count)
                            distanceMetric: params.distanceMetric,   // CIE76/CIE94/CIE2000 (cie76 = legacy v1 behavior)
                            format: pixelData.format,                // Pass Lab format flag for optimization
                            bitDepth: pixelData.bitDepth,            // Source bit depth (8 or 16) for Shadow Gate calibration
                            grayscaleOnly,                           // User-selected mode: grayscale (L-only) or color (full Lab)
                            preserveWhite: params.preserveWhite,
                            preserveBlack: params.preserveBlack,
                            preservedUnifyThreshold: params.preservedUnifyThreshold,  // ΔE threshold for white/black unification (default: 12.0, Jethro: 0.5)
                            substrateMode: params.substrateMode,     // Substrate awareness mode (auto, white, black, none)
                            substrateTolerance: params.substrateTolerance,  // ΔE threshold for substrate culling
                            vibrancyMode: params.vibrancyMode,       // Vibrancy algorithm (linear, aggressive, exponential)
                            vibrancyBoost: params.vibrancyBoost,     // Fixed vibrancy multiplier (split.vibrancyBoost)
                            highlightThreshold: params.highlightThreshold,  // White point (prune.whitePoint)
                            highlightBoost: params.highlightBoost,   // Highlight boost (split.highlightBoost)
                            enablePaletteReduction: params.enablePaletteReduction,  // Enable/disable palette reduction (default: true)
                            paletteReduction: params.paletteReduction,  // Color merging threshold (prune.threshold)
                            densityFloor: params.densityFloor,       // Density floor threshold (default: 0.005 = 0.5%, Jethro: 0.0 = disabled)
                            isolationThreshold: params.isolationThreshold,  // Peak eligibility floor (25.0 = 1% minimum cluster size)
                            tuning: tuning,                          // NEW: Centralized tuning configuration
                            // ignoreTransparent is handled during RGB→Lab conversion (alpha channel check)
                            isPreview: true,                          // Enable stride optimization for preview speed
                            previewStride: parseInt(document.getElementById('previewStride')?.value || '4', 10)  // User-selected stride (4=Standard, 2=Fine, 1=Finest)
                        }
                    );

                    const hexColors = PosterizationEngine.paletteToHex(result.palette);

                    // Show palette in Lab space (primary) with hex (secondary)
                    if (result.paletteLab) {
                        const labSummary = result.paletteLab.map((lab, i) => {
                            const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
                            const hue = (Math.atan2(lab.b, lab.a) * 180 / Math.PI + 360) % 360;
                            return `Lab(${lab.L.toFixed(0)},${lab.a.toFixed(0)},${lab.b.toFixed(0)})`;
                        }).join(', ');
                    }

                    // Analyze palette composition (Lab first, then RGB hex)
                    hexColors.forEach((color, i) => {
                        if (result.paletteLab && result.paletteLab[i]) {
                            const lab = result.paletteLab[i];
                            const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
                            const hue = (Math.atan2(lab.b, lab.a) * 180 / Math.PI + 360) % 360;
                        } else {
                        }
                    });

                    // Count pixel assignments per color
                    if (result.assignments) {
                        const counts = new Array(hexColors.length).fill(0);
                        for (let i = 0; i < result.assignments.length; i++) {
                            counts[result.assignments[i]]++;
                        }
                        counts.forEach((count, i) => {
                            const percent = ((count / result.assignments.length) * 100).toFixed(1);
                            if (result.paletteLab && result.paletteLab[i]) {
                                const lab = result.paletteLab[i];
                            } else {
                            }
                        });
                    }

                    // Log curation info if colors were merged
                    if (result.metadata.finalColors < result.metadata.targetColors) {
                    }


                    // Filter out substrate from UI display (but keep in full palette for separation)
                    // Substrate is the paper/medium, not an ink color
                    const inkHexColors = result.substrateIndex !== null
                        ? hexColors.filter((_, i) => i !== result.substrateIndex)
                        : hexColors;


                    // Store results for later use
                    const selectedPreview = {
                        colorCount: inkHexColors.length,    // Count of INK colors (excludes substrate)
                        assignments: result.assignments,    // Pixel→palette assignments
                        palette: result.palette,            // RGB palette for UI display (includes substrate)
                        paletteLab: result.paletteLab,      // Lab palette for layer creation (includes substrate)
                        hexColors: inkHexColors,            // INK colors for UI swatches (excludes substrate)
                        allHexColors: hexColors,            // ALL colors including substrate (for separation)
                        originalHexColors: [...inkHexColors],  // Store original ink colors before edits
                        substrateIndex: result.substrateIndex,  // Index of substrate in full palette (null if none)
                        substrateLab: result.substrateLab   // Substrate Lab color for layer identification
                    };

                    // Store globally for substrate-aware swatch/preview functions
                    window.selectedPreview = selectedPreview;

                    // 🏛️ FROZEN PALETTE PROTOCOL: Lock the palette as immutable Law
                    // Once Parameters Dialog closes, these colors are SOVEREIGN and never change
                    window._frozenPalette = {
                        labPalette: result.paletteLab,      // Immutable Lab colors
                        rgbPalette: result.palette,         // Immutable RGB colors
                        hexColors: hexColors,               // Immutable hex colors
                        inkHexColors: inkHexColors,         // Immutable ink-only colors
                        substrateIndex: result.substrateIndex
                    };

                    // Use the pixel copy we made at the beginning (before any processing)

                    pluginState.posterizationData = {
                        params,
                        originalPixels: pixelsCopy,  // Lab format - COPIED at start, before any processing!
                        originalWidth: pixelData.width,
                        originalHeight: pixelData.height,
                        bitDepth: pixelData.bitDepth,  // Source bit depth (8 or 16)
                        docInfo,
                        selectedPreview
                    };

                    // Reset button
                    buttonElement.disabled = false;
                    buttonElement.textContent = buttonOriginalText;

                    // Show palette editor first (sets up UI layout)
                    showPaletteEditor(selectedPreview);

                    // CRITICAL: Wait for UXP layout to complete before rendering preview
                    // UXP needs time to calculate element dimensions after DOM changes
                    setTimeout(async () => {
                        // Check if img is ready (in paletteDialog)
                        const img = document.getElementById('previewImg');
                        if (img) {
                        }

                        // Initialize preview AFTER palette dialog layout is complete
                        initializePreviewCanvas(
                            pixelData.width,
                            pixelData.height,
                            hexColors,  // Use ALL colors (matches assignment indices)
                            result.assignments
                        );

                        // Render initial preview
                        renderPreview();

                        // Initialize ViewportManager for 1:1 mode (Phase 2)
                        try {

                            // Create CropEngine with PRE-COMPUTED separation state
                            // CRITICAL: Use the frozen palette from main pipeline (not re-posterize)
                            // This ensures Navigator Map thumbnail shows the SAME colors as the preview
                            const cropEngine = new CropEngine();
                            const initResult = await cropEngine.initializeWithSeparation(
                                pluginState.posterizationData.originalPixels,
                                pluginState.posterizationData.originalWidth,
                                pluginState.posterizationData.originalHeight,
                                {
                                    paletteLab: window._frozenPalette.labPalette,
                                    rgbPalette: window._frozenPalette.rgbPalette,
                                    colorIndices: result.assignments
                                },
                                {
                                    bitDepth: pluginState.posterizationData.bitDepth || 16,
                                    actualDocumentWidth: pixelData.originalWidth,   // ACTUAL document size, not preview
                                    actualDocumentHeight: pixelData.originalHeight  // ACTUAL document size, not preview
                                }
                            );

                            // Create ViewportManager
                            const viewportManager = new ViewportManager(cropEngine, {
                                documentDPI: pixelData.resolution || 300,
                                meshTPI: 230
                            });

                            // Store globally for access by view mode handlers
                            window.viewportManager = viewportManager;
                            window.cropEngine = cropEngine;

                            // CRITICAL: Sync initial center position to CropEngine for Navigator Map
                            // ViewportManager defaults to center (0.5, 0.5) but CropEngine viewport isn't synced yet
                            viewportManager.jumpToNormalized(0.5, 0.5);

                            // DIAGNOSTIC: Log ALL dimension values for debugging viewport issues


                            // Initialize Navigator Map with current image
                            renderNavigatorMap();
                        } catch (error) {
                            logger.error('[Phase 2] Failed to initialize ViewportManager:', error);
                        }

                        // Set up view mode dropdown
                        // Use stored handler reference to properly remove old listener (avoids cloneNode DOM corruption)
                        const viewModeSelect = document.getElementById('viewMode');
                        if (viewModeSelect) {
                            // Remove previous listener if it exists
                            if (window._viewModeChangeHandler) {
                                viewModeSelect.removeEventListener('change', window._viewModeChangeHandler);
                            }

                            viewModeSelect.value = 'fit';  // Default to fit mode

                            window._viewModeChangeHandler = async (e) => {
                                const mode = e.target.value;

                                document.body.style.cursor = 'wait';
                                try {
                                    await setPreviewMode(mode);
                                } catch (error) {
                                    logger.error('Failed to switch view mode:', error);
                                    showErrorDialog("View Mode Error", error.message, error.stack);
                                } finally {
                                    document.body.style.cursor = '';
                                }
                            };

                            viewModeSelect.addEventListener('change', window._viewModeChangeHandler);
                        }
                    }, 300); // 300ms delay for UXP layout

                } catch (error) {
                    logger.error("Error processing document:", error);
                    showError("Processing Error", `An error occurred while processing your document: ${error.message}`);

                    // Reset button
                    buttonElement.disabled = false;
                    buttonElement.textContent = buttonOriginalText;
                }
            };

            attachAllEventListeners(dialog, handlePosterization);
        } else {
        }

        // Set up View Mode switching (Phase 1: UI state machine)
        // View mode switching is handled by setPreviewMode() function
        // (called from the change handler set up during posterization)

        // NOW show the dialog (after all event listeners are set up)
        // NON-MODAL to allow access to Photoshop Color Panel for LAB slider sync
        dialog.show({
            resize: "both",
            size: {
                width: 620,        // Wide enough for preset selector and buttons
                height: 700,       // Taller for palette
                minWidth: 580,
                minHeight: 500,
                maxWidth: 750,
                maxHeight: 900
            }
        });

    } catch (error) {
        logger.error("Error showing dialog:", error);
        logger.error("Error stack:", error.stack);
        // Can't use showError here since DOM might not be ready
        alert(`Error: ${error.message}`);
    }
}

/**
 * Register plugin entrypoints
 */
entrypoints.setup({
    commands: {
        "reveal.showDialog": showDialog
    }
});

// Initialize on load
initPlugin();

// Initialize test client if in test mode
if (typeof __TEST_MODE__ !== 'undefined' && __TEST_MODE__) {
    try {
        require('./test-client');
    } catch (error) {
        logger.error('[Reveal] Failed to load test client:', error);
    }
}

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        showDialog,
        initPlugin
    };
}
