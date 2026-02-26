/**
 * Navigator - Screen Print Color Separation UI
 *
 * Command plugin: invoked from Plugins → Navigator...
 * Opens a non-modal dialog, auto-ingests the active document,
 * and dismisses itself after production render completes.
 */

const { entrypoints } = require("uxp");
const { app, action } = require("photoshop");
const Reveal = require("@reveal/core");
const SessionState = require("./state/SessionState");
const PhotoshopBridge = require("./bridge/PhotoshopBridge");
const ProductionWorker = require("./bridge/ProductionWorker");
const Preview = require("./components/Preview");
const ArchetypeCarousel = require("./components/ArchetypeCarousel");
const RadarHUD = require("./components/RadarHUD");
const MechanicalKnobs = require("./components/MechanicalKnobs");
const PaletteSurgeon = require("./components/PaletteSurgeon");
const Loupe = require("./components/Loupe");

const logger = Reveal.logger;

let sessionState = null;
let preview = null;
let carousel = null;
let radar = null;
let knobs = null;
let surgeon = null;
let loupe = null;
let splashShownAt = 0;    // timestamp when splash was shown
let isIngesting = false;
let isProductionRunning = false;
let currentDocId = null;    // Track which document we've ingested
let dialogOpen = false;

// ─── Bootstrap ───────────────────────────────────────────

function initPlugin() {
    try {
        logger.log('Navigator plugin loaded');
        logger.log(`Build: ${typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'}`);
        logger.log(`Build time: ${typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'unknown'}`);

        sessionState = new SessionState();

        // Wire Preview component
        preview = new Preview(
            document.getElementById('preview-img'),
            document.getElementById('status-text'),
            document.getElementById('accuracy-text'),
            document.getElementById('preview-placeholder'),
            sessionState
        );

        // Update archetype badge on config change
        sessionState.on('configChanged', (config) => {
            const badge = document.getElementById('archetype-badge');
            if (badge) {
                const activeId = sessionState.getState().activeArchetypeId;
                const label = activeId === 'dynamic_interpolator' ? 'Chameleon' : (config.id || activeId || '');
                if (label) {
                    badge.textContent = label;
                    badge.style.display = 'block';
                }
            }
        });

        // Wire Archetype Carousel (non-fatal if it fails)
        try {
            carousel = new ArchetypeCarousel(
                document.getElementById('carousel'),
                sessionState
            );
        } catch (err) {
            logger.log('[Navigator] Carousel init failed: ' + err.message);
        }

        // Wire 7D Radar HUD (non-fatal if SVG not supported)
        try {
            radar = new RadarHUD(
                document.getElementById('radar-container'),
                sessionState
            );
        } catch (err) {
            logger.log('[Navigator] Radar init failed: ' + err.message);
        }

        // Wire Mechanical Knobs (non-fatal)
        try {
            knobs = new MechanicalKnobs(
                document.getElementById('knobs-panel'),
                sessionState
            );
        } catch (err) {
            logger.log('[Navigator] Knobs init failed: ' + err.message);
        }

        // Wire Palette Surgeon (non-fatal)
        try {
            surgeon = new PaletteSurgeon(
                document.getElementById('palette-surgeon'),
                sessionState
            );
        } catch (err) {
            logger.log('[Navigator] PaletteSurgeon init failed: ' + err.message);
        }

        // Wire Loupe component (non-fatal)
        try {
            loupe = new Loupe(
                document.getElementById('loupe-container'),
                document.getElementById('loupe-img'),
                document.getElementById('loupe-coords'),
                document.getElementById('preview-img'),
                sessionState,
                document.getElementById('loupe-erev')
            );
        } catch (err) {
            logger.log('[Navigator] Loupe init failed: ' + err.message);
        }

        // Wire Loupe zoom dropdown
        const loupeZoom = document.getElementById('loupe-zoom');
        if (loupeZoom) {
            loupeZoom.addEventListener('change', (e) => {
                if (!loupe) return;
                const factor = parseInt(e.target.value, 10);
                if (factor === 0) {
                    loupe.deactivate();
                } else {
                    if (!loupe.isActive) loupe.activate();
                    loupe.setZoom(factor);
                }
            });
        }

        // Wire Reset to Defaults button (knobs + palette surgery)
        const btnReset = document.getElementById('btn-reset-archetype');
        if (btnReset) {
            btnReset.addEventListener('click', () => {
                sessionState.resetToDefaults();
            });
            // Always visible, disabled when nothing is customized
            btnReset.disabled = true;
            const updateResetState = () => {
                btnReset.disabled = !sessionState.isCustomized();
            };
            sessionState.on('knobsCustomizedChanged', updateResetState);
            sessionState.on('paletteChanged', updateResetState);
        }

        // ─── Advanced Panel: Dropdowns & Checkboxes ───────────────
        // Wire all <select> dropdowns (change → updateParameter)
        const PICKER_DEFS = [
            'engineType', 'splitMode', 'distanceMetric', 'centroidStrategy', 'vibrancyMode',
            'substrateMode', 'ditherType', 'colorMode', 'preprocessingIntensity',
            'meshSize', 'maskProfile'
        ];
        for (const key of PICKER_DEFS) {
            const picker = document.getElementById(`picker-${key}`);
            if (picker) {
                picker.addEventListener('change', (e) => {
                    const val = key === 'meshSize' ? parseInt(e.target.value, 10) : e.target.value;
                    sessionState.updateParameter(key, val);
                });
            }
            // Revert button
            const revertBtn = document.getElementById(`revert-${key}`);
            if (revertBtn) {
                revertBtn.addEventListener('click', () => {
                    sessionState.resetKnob(key);
                });
            }
        }

        // Wire all <input type="checkbox"> controls (change → updateParameter)
        const CHECKBOX_DEFS = [
            'enableHueGapAnalysis', 'enablePaletteReduction',
            'preserveWhite', 'preserveBlack', 'ignoreTransparent', 'medianPass'
        ];
        for (const key of CHECKBOX_DEFS) {
            const chk = document.getElementById(`chk-${key}`);
            if (chk) {
                chk.addEventListener('change', (e) => {
                    sessionState.updateParameter(key, e.target.checked);
                });
            }
            // Revert button
            const revertBtn = document.getElementById(`revert-${key}`);
            if (revertBtn) {
                revertBtn.addEventListener('click', () => {
                    sessionState.resetKnob(key);
                });
            }
        }

        // Sync Advanced pickers/checkboxes from config or state
        function syncAdvancedControls(source) {
            // Sync pickers — read from source (config obj or state)
            for (const key of PICKER_DEFS) {
                const picker = document.getElementById(`picker-${key}`);
                if (!picker) continue;
                const val = source[key];
                if (val !== undefined) {
                    picker.value = String(val);
                }
            }

            // Sync checkboxes
            for (const key of CHECKBOX_DEFS) {
                const chk = document.getElementById(`chk-${key}`);
                if (!chk) continue;
                const val = source[key];
                if (val !== undefined) {
                    chk.checked = !!val;
                }
            }

            // Sync revert icons for pickers and checkboxes
            for (const key of [...PICKER_DEFS, ...CHECKBOX_DEFS]) {
                const revertBtn = document.getElementById(`revert-${key}`);
                if (revertBtn) {
                    const dflt = sessionState.getKnobDefault(key);
                    const cur = source[key];
                    revertBtn.style.display = (dflt != null && cur !== dflt) ? 'inline-block' : 'none';
                }
            }
        }

        // Sync on config change (archetype swap, structural param change, reset)
        sessionState.on('configChanged', (config) => {
            syncAdvancedControls(config);
        });

        // Sync on proxy ready (initial load — pickers must reflect archetype values)
        sessionState.on('proxyReady', () => {
            syncAdvancedControls(sessionState.getState());
        });

        // Progress events from SessionState (heavy CPU phases during loadImage)
        sessionState.on('progress', (data) => {
            _showProgress(data.label, data.percent);
        });

        // Carousel cards built during splash (root hidden) — no splash interaction.
        sessionState.on('carouselReady', () => {
            // Cards are built by ArchetypeCarousel._rebuild().
            // Splash stays up — scoring hasn't finished yet.
        });

        // Background scoring progress — update stats panel ΔE for active archetype.
        // No progress bar / card highlight / scroll — all happens under hidden root
        // during splash, and the scoring loop is only 3 archetypes (~1s).
        sessionState.on('archetypeScored', (data) => {
            const state = sessionState.getState();
            if (data.id === state.activeArchetypeId) {
                const deltaEl = document.getElementById('stat-delta');
                if (deltaEl) deltaEl.textContent = `\u0394E ${data.meanDeltaE.toFixed(1)}`;
            }
        });

        // Background scoring done — re-sort carousel by ΔE now that badges are filled.
        sessionState.on('scoringComplete', () => {
            if (carousel) carousel.sortByDisplayedDeltaE();
        });

        // When the user clicks a card, update the stats panel ΔE from the stored value
        sessionState.on('archetypeChanged', () => {
            const deltaEl = document.getElementById('stat-delta');
            const storedDE = sessionState.getArchetypeDeltaE();
            if (deltaEl) {
                deltaEl.textContent = storedDE != null ? `\u0394E ${storedDE.toFixed(1)}` : '';
            }
        });

        // Pulse 1: dnaReady fires ~50ms after ingest — update radar + DNA stats immediately
        sessionState.on('dnaReady', (dna) => {
            const sectorEl = document.getElementById('dominant-sector');
            if (sectorEl && dna && dna.dominant_sector) {
                sectorEl.textContent = `Dominant: ${dna.dominant_sector}`;
            }
            // Refresh radar HUD immediately with DNA data
            if (radar) {
                try { radar.render(); } catch (_) {}
            }
            // Show DNA stats immediately
            updateDNADisplay();

        });

        // Show dominant sector in HUD info (kept for backward compat with imageLoaded)
        sessionState.on('imageLoaded', (data) => {
            const sectorEl = document.getElementById('dominant-sector');
            if (sectorEl && data.dna && data.dna.dominant_sector) {
                sectorEl.textContent = `Dominant: ${data.dna.dominant_sector}`;
            }
        });

        // Show preview image, hide placeholder on proxy ready
        sessionState.on('proxyReady', () => {
            const img = document.getElementById('preview-img');
            const placeholder = document.getElementById('preview-placeholder');
            if (img) img.style.display = 'block';
            if (placeholder) placeholder.style.display = 'none';

            // Show finalize button
            const finalizeRow = document.getElementById('finalize-row');
            if (finalizeRow) finalizeRow.style.display = '';
        });

        // Update stats panel below preview on every posterization
        sessionState.on('previewUpdated', (data) => {
            const statsPanel = document.getElementById('preview-stats');
            if (statsPanel) statsPanel.style.display = '';

            // Row 1: Posterization results
            const colorsEl = document.getElementById('stat-colors');
            const deltaEl = document.getElementById('stat-delta');
            const timeEl = document.getElementById('stat-time');
            if (colorsEl && data.palette) {
                const count = data.activeColorCount != null ? data.activeColorCount : data.palette.length;
                colorsEl.textContent = `${count} screens`;
            }
            // ΔE comes from the single stored value (background scoring),
            // NOT from calculateCurrentAccuracy(). Updated by archetypeScored/archetypeChanged.
            if (deltaEl) {
                const storedDE = sessionState.getArchetypeDeltaE();
                if (storedDE != null) deltaEl.textContent = `\u0394E ${storedDE.toFixed(1)}`;
            }
            if (timeEl && data.elapsedMs != null) {
                timeEl.textContent = `${data.elapsedMs.toFixed(0)}ms`;
            }

            // DNA Fidelity display
            const dnaFidelityEl = document.getElementById('dna-fidelity-text');
            if (dnaFidelityEl && data.dnaFidelity) {
                const f = data.dnaFidelity;
                const score = Math.round(f.fidelity);
                dnaFidelityEl.textContent = `DNA ${score}`;
                dnaFidelityEl.className = score >= 80 ? 'fidelity-good'
                    : score >= 60 ? 'fidelity-warn' : 'fidelity-bad';
                dnaFidelityEl.title = f.alerts.length
                    ? f.alerts.join('\n')
                    : 'No drift detected';
            }

            // Row 2: Archetype match score + breakdown
            updateMatchScore();

            // Row 3: DNA signature
            updateDNADisplay();
        });

        // Wire Sync button — manual sync shows error dialog on failure
        const btnSync = document.getElementById('btn-sync');
        if (btnSync) {
            btnSync.addEventListener('click', () => ingestActiveDocument(true));
        }

        // Wire error overlay OK button
        const btnOk = document.getElementById('btn-error-ok');
        if (btnOk) {
            btnOk.addEventListener('click', () => {
                const overlay = document.getElementById('error-overlay');
                if (overlay) overlay.setAttribute('style', 'display: none');
                // If no document was ingested, close the dialog entirely
                if (!currentDocId) {
                    _closeDialog();
                }
            });
        }

        // Wire help toggle button
        const btnHelp = document.getElementById('btn-help-toggle');
        if (btnHelp) {
            btnHelp.addEventListener('click', () => {
                const panel = document.getElementById('knobs-panel');
                if (panel) panel.classList.toggle('show-help');
                btnHelp.classList.toggle('active');
            });
        }

        // Wire Finalize button
        const btnFinalize = document.getElementById('btn-finalize');
        if (btnFinalize) {
            btnFinalize.addEventListener('click', () => handleFinalize());
        }

        // Keyboard shortcuts
        // NOTE: UXP non-modal dialogs do NOT receive keyboard events.
        // Photoshop intercepts them at the application level.
        // Blink comparator uses pointer events on Preview instead.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && surgeon) {
                surgeon.deselect();
            }
        });

        // Snap back to originating document if user switches tabs
        setupDocumentChangeListener();

        // Listen for manual dialog dismiss (X button / Escape).
        // UXP non-modal dialogs don't honor preventDefault() on cancel,
        // so we catch the close event and re-show immediately if the
        // Photoshop color picker is still open.
        const dialogEl = document.getElementById('navigatorDialog');
        if (dialogEl) {
            dialogEl.addEventListener('close', () => {
                if (surgeon && surgeon.isPickerOpen()) {
                    logger.log('[Navigator] Dialog closed while picker open — re-showing');
                    dialogEl.show({
                        resize: "both",
                        size: { width: 1100, height: 850, minWidth: 500, minHeight: 400, maxWidth: 3000, maxHeight: 3000 }
                    });
                    return;
                }
                _onDialogDismissed();
            });
        }

        logger.log('[Navigator] Init complete');
    } catch (err) {
        logger.log('[Navigator] FATAL init error: ' + err.message);
        setStatus('Init error: ' + err.message);
    }
}

// ─── Document Lock (snap-back) ───────────────────────────

function setupDocumentChangeListener() {
    try {
        action.addNotificationListener(["open", "select"], onDocumentChanged);
        logger.log('[Navigator] Document lock listener registered');
    } catch (err) {
        logger.log('[Navigator] Could not register document listener: ' + err.message);
    }
}

function onDocumentChanged() {
    if (!dialogOpen || !currentDocId) return;

    try {
        const newDocId = app.activeDocument ? app.activeDocument.id : null;
        if (newDocId && newDocId !== currentDocId) {
            logger.log(`[Navigator] Tab switch blocked — snapping back to doc ${currentDocId}`);
            require("photoshop").core.executeAsModal(async () => {
                await action.batchPlay([{
                    _obj: "select",
                    _target: [{ _ref: "document", _id: currentDocId }]
                }], {});
            }, { commandName: "Navigator: return to locked document" });
        }
    } catch (_) {
        // No document open or snap-back failed — ignore
    }
}

// ─── Document Validation & Ingest ────────────────────────

function validateDocument() {
    const info = PhotoshopBridge.getDocumentInfo();

    if (!info) {
        return { ok: false, title: 'No Document', message: 'Open a document in Photoshop first.' };
    }

    if (info.mode !== 'labColorMode') {
        return {
            ok: false,
            title: 'Wrong Color Mode',
            message: `Navigator requires a Lab color document.\n\nCurrent mode: ${info.mode}\n\nConvert via Image \u2192 Mode \u2192 Lab Color.`
        };
    }

    if (info.layerCount > 1) {
        return {
            ok: false,
            title: 'Flatten First',
            message: `Navigator requires a single-layer document.\n\nCurrent layers: ${info.layerCount}\n\nFlatten via Layer \u2192 Flatten Image.`
        };
    }

    return { ok: true, info };
}

function showErrorDialog(title, message) {
    const overlay = document.getElementById('error-overlay');
    const titleEl = document.getElementById('error-title');
    const msgEl = document.getElementById('error-message');

    if (!overlay) {
        logger.log(`[Navigator] Error: ${title} — ${message}`);
        return;
    }

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    overlay.setAttribute('style', 'display: flex');
}

/**
 * @param {boolean} showDialog - If true, validation errors show a modal dialog.
 *                                If false (auto-ingest), errors go to status bar only.
 */
async function ingestActiveDocument(showDialog) {
    if (isIngesting) return;
    isIngesting = true;

    // Immediately clear stale content so old preview never flashes
    _clearUI();
    if (sessionState) sessionState.reset();

    const btnSync = document.getElementById('btn-sync');
    if (btnSync) btnSync.disabled = true;

    // Show boot screen immediately — user sees feedback within 1 frame
    _showProgress('Preparing\u2026', 0);

    try {
        const validation = validateDocument();
        if (!validation.ok) {
            if (showDialog) {
                showErrorDialog(validation.title, validation.message);
            }
            setStatus(validation.title);
            currentDocId = null;
            return;
        }

        // Track which document we're ingesting
        try {
            currentDocId = app.activeDocument ? app.activeDocument.id : null;
        } catch (_) {
            currentDocId = null;
        }

        updateDocumentHeader(validation.info);

        // ── Phase 1: INGEST — the slow bridge call (2-3s for large docs) ──
        _showProgress('Acquiring 16-bit Lab data\u2026', 10);
        await new Promise(r => setTimeout(r, 20)); // yield so boot screen paints

        // Read full-res pixels — ProxyEngine handles downsampling internally.
        // PS GPU downsampling (targetSize) was tested but loses minority color
        // signals like green on the Jethro image. Photoshop's bicubic resample
        // averages out sparse green pixels that JS bilinear preserves.
        // The preservedUnifyThreshold fix helps but doesn't fully compensate.
        const { labPixels, width, height, originalWidth, originalHeight } =
            await PhotoshopBridge.getDocumentLab();
        logger.log(`[Navigator] Ingested ${width}x${height} from ${validation.info.name}`);

        // ── Phases 2-3 are driven by SessionState.loadImage progress events ──
        // Splash hides when preview is ready. Background ΔE scoring continues asynchronously.
        await sessionState.loadImage(labPixels, width, height, originalWidth, originalHeight);
        _hideProgress();

    } catch (err) {
        logger.log(`[Navigator] Ingest failed: ${err.message}`);
        if (showDialog) {
            showErrorDialog('Ingest Failed', err.message);
        }
        setStatus('Error: ' + err.message);
        _hideProgress();
    } finally {
        isIngesting = false;
        if (btnSync) btnSync.disabled = false;
    }
}

function updateDocumentHeader(info) {
    const nameEl = document.getElementById('doc-name');
    const layerEl = document.getElementById('doc-layer');

    if (!info) {
        info = PhotoshopBridge.getDocumentInfo();
    }

    if (!info) {
        if (nameEl) nameEl.textContent = 'No document';
        if (layerEl) layerEl.textContent = '';
        return;
    }

    if (nameEl) nameEl.textContent = info.name;
    if (layerEl) layerEl.textContent = info.layerName ? `[${info.layerName}]` : '';
}

function updateMatchScore() {
    const scoreEl = document.getElementById('stat-score');
    const nameEl = document.getElementById('stat-archetype-name');
    if (!sessionState) return;

    const state = sessionState.getState();
    const activeId = state.activeArchetypeId;
    if (!activeId) return;

    // Find the active archetype's score from the ranked list
    const scores = sessionState.getAllArchetypeScores();
    const match = scores.find(s => s.id === activeId);

    if (scoreEl && match) {
        scoreEl.textContent = `Match ${match.score.toFixed(0)}%`;
    }

    // Update archetype name in stats line
    if (nameEl) {
        if (activeId === 'dynamic_interpolator') {
            nameEl.textContent = 'Chameleon';
        } else {
            const Reveal = require('@reveal/core');
            const archetypes = Reveal.ArchetypeLoader.loadArchetypes();
            const arch = archetypes.find(a => a.id === activeId);
            nameEl.textContent = arch ? arch.name : activeId;
        }
    }
}

function updateDNADisplay() {
    // DNA details removed from stats panel (consolidated to single line).
    // DNA score is now shown inline via updateMatchScore.
}

function setStatus(text) {
    const el = document.getElementById('status-text');
    if (el) el.textContent = text;
}

function _showProgress(label) {
    const overlay = document.getElementById('progress-overlay');
    const isAlreadyVisible = overlay && overlay.style.display === 'flex';

    // Hide root content — UXP <select> elements render above z-index layers
    const root = document.getElementById('root');
    if (root) root.style.display = 'none';
    if (overlay) overlay.setAttribute('style', 'display: flex');
    // Status is a separate element — updating it doesn't reflow the splash GIF
    const status = document.getElementById('splash-status');
    if (status) {
        status.textContent = label;
        status.setAttribute('style', 'display: block;');
    }

    // Only reset GIF + timestamp on the first show.
    // Subsequent calls just update the status text — no blink.
    if (!isAlreadyVisible) {
        const img = document.getElementById('splash-img');
        if (img) {
            const src = img.getAttribute('src');
            img.setAttribute('src', '');
            img.setAttribute('src', src);
        }
        splashShownAt = Date.now();
    }
}

function _hideProgress() {
    const overlay = document.getElementById('progress-overlay');
    if (!overlay) return;

    // Dismiss immediately — Chameleon preview is ready, show it now.
    const root = document.getElementById('root');
    if (root) root.style.display = '';
    overlay.classList.add('fade-out');
    const status = document.getElementById('splash-status');
    if (status) status.setAttribute('style', 'display: none;');
    setTimeout(() => {
        overlay.setAttribute('style', 'display: none');
        overlay.classList.remove('fade-out');
    }, 350);
}

// ─── Finalize ────────────────────────────────────────────

async function handleFinalize() {
    if (!sessionState || !sessionState.proxyEngine) return;
    if (isProductionRunning) return;

    const labPalette = sessionState.getPalette();
    if (!labPalette || labPalette.length === 0) {
        showErrorDialog('No Palette', 'Navigate an archetype first.');
        return;
    }

    isProductionRunning = true;

    // Disable UI immediately
    const btn = document.getElementById('btn-finalize');
    const carouselEl = document.getElementById('carousel');
    const progressEl = document.getElementById('finalize-progress');
    if (btn) btn.disabled = true;
    if (carouselEl) carouselEl.style.pointerEvents = 'none';
    if (progressEl) {
        progressEl.style.display = 'block';
        progressEl.textContent = 'Reading full-res pixels...';
    }

    // Yield to repaint before heavy I/O
    await new Promise(r => setTimeout(r, 50));

    try {
        const worker = new ProductionWorker(sessionState, (step, total, msg) => {
            if (progressEl) progressEl.textContent = msg;
        });

        const result = await worker.execute();

        const state = sessionState.getState();
        const lines = [
            `Created ${result.layerCount} layers in ${(result.elapsedMs / 1000).toFixed(1)}s`,
            `Archetype: ${state.activeArchetypeId || 'unknown'}`,
            `Knobs: Vol ${state.minVolume}% | Spkl ${state.speckleRescue}px | Shd ${state.shadowClamp}%` +
                (state.trapSize > 0 ? ` | Trap ${state.trapSize}pt` : '')
        ];
        const overrideCount = sessionState.paletteOverrides.size;
        if (overrideCount > 0) lines.push(`Palette overrides: ${overrideCount}`);

        logger.log(`[Navigator] Production render complete: ${result.layerCount} layers, ${result.elapsedMs}ms`);

        // Dismiss dialog — work is done
        _closeDialog();

    } catch (err) {
        logger.log('[Navigator] Production render failed: ' + err.message);
        showErrorDialog('Production Failed', err.message);
        // Restore UI on failure
        if (btn) btn.disabled = false;
        if (carouselEl) carouselEl.style.pointerEvents = '';
        if (progressEl) progressEl.style.display = 'none';
    } finally {
        isProductionRunning = false;
    }
}

/** Dismiss the dialog after successful render and reset UI for next invocation. */
function _closeDialog() {
    _resetFinalizeUI();
    if (loupe) loupe.destroy();
    currentDocId = null;
    dialogOpen = false;

    // Close dialog FIRST — before reset, so the UI dismisses immediately
    const dialog = document.getElementById('navigatorDialog');
    if (dialog) {
        try {
            dialog.close('done');
            logger.log('[Navigator] Dialog closed');
        } catch (err) {
            logger.log('[Navigator] dialog.close() failed: ' + err.message);
        }
    }

    // Clear session state after dialog is dismissed
    try {
        if (sessionState) sessionState.reset();
    } catch (err) {
        logger.log('[Navigator] reset() failed: ' + err.message);
    }
}

/** Reset finalize-related UI elements to their initial state. */
function _resetFinalizeUI() {
    const btn = document.getElementById('btn-finalize');
    const carouselEl = document.getElementById('carousel');
    const progressEl = document.getElementById('finalize-progress');
    if (btn) btn.disabled = false;
    if (carouselEl) carouselEl.style.pointerEvents = '';
    if (progressEl) {
        progressEl.style.display = 'none';
        progressEl.textContent = '';
    }
}

// ─── UI Reset ────────────────────────────────────────────

/**
 * Immediately clear all visible UI to blank state.
 * Called at the start of every new ingest so stale content from the
 * previous session never flashes on screen.
 */
function _clearUI() {
    // Hide preview image, show placeholder
    const img = document.getElementById('preview-img');
    const placeholder = document.getElementById('preview-placeholder');
    if (img) img.style.display = 'none';
    if (placeholder) {
        placeholder.style.display = 'block';
        placeholder.textContent = 'Loading\u2026';
        placeholder.style.color = '';  // reset error styling
    }

    // Clear carousel cards
    const carouselEl = document.getElementById('carousel');
    if (carouselEl) carouselEl.innerHTML = '';

    // Hide stats panel
    const statsPanel = document.getElementById('preview-stats');
    if (statsPanel) statsPanel.style.display = 'none';

    // Hide archetype badge
    const badge = document.getElementById('archetype-badge');
    if (badge) badge.style.display = 'none';

    // Hide finalize row
    const finalizeRow = document.getElementById('finalize-row');
    if (finalizeRow) finalizeRow.style.display = 'none';

    // Clear status and accuracy
    setStatus('');
    const accuracyEl = document.getElementById('accuracy-text');
    if (accuracyEl) accuracyEl.textContent = '';
}

/**
 * Handle dialog dismissed by user (X button / Escape) without Commit.
 * Resets state so the next invocation starts clean.
 */
function _onDialogDismissed() {
    if (!dialogOpen) return;
    logger.log('[Navigator] Dialog dismissed by user');
    if (loupe) loupe.destroy();
    currentDocId = null;
    dialogOpen = false;
    if (sessionState) sessionState.reset();
    _clearUI();
}

// ─── Show Dialog (command entrypoint) ────────────────────

async function showDialog() {
    try {
        const dialog = document.getElementById('navigatorDialog');
        if (!dialog) {
            logger.log('[Navigator] Dialog element not found');
            return;
        }

        // Initialize plugin on first open
        if (!sessionState) {
            initPlugin();
        }

        // Guard against re-entry while Navigator is already open
        if (dialogOpen) {
            logger.log('[Navigator] Already open — ignoring re-invocation');
            return;
        }

        // Reset any stale state from previous session
        if (sessionState) sessionState.reset();
        _clearUI();

        dialogOpen = true;

        // Validate before showing dialog — reject with native PS alert (no big dialog)
        const validation = validateDocument();
        if (!validation.ok) {
            dialogOpen = false;
            await app.showAlert(validation.title + '\n\n' + validation.message);
            return;
        }

        // Auto-ingest the active document
        ingestActiveDocument(false);

        // Show non-modal dialog (allows Photoshop Color Panel access)
        dialog.show({
            resize: "both",
            size: {
                width: 1100,
                height: 850,
                minWidth: 500,
                minHeight: 400,
                maxWidth: 3000,
                maxHeight: 3000
            }
        });

        logger.log('[Navigator] Dialog shown');

    } catch (err) {
        logger.log('[Navigator] Error showing dialog: ' + err.message);
    }
}

// ─── UXP Entrypoints ────────────────────────────────────

entrypoints.setup({
    commands: {
        "navigator.showDialog": showDialog
    }
});

// Initialize on load
initPlugin();
