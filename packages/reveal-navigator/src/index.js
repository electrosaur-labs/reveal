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
let isIngesting = false;
let isProductionRunning = false;
let currentDocId = null;    // Track which document we've ingested
let dialogOpen = false;

// ─── Bootstrap ───────────────────────────────────────────

function initPlugin() {
    try {
        logger.log('Navigator plugin loaded');
        logger.log(`Build: ${typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'}`);

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
            if (badge && config.id) {
                badge.textContent = config.id;
                badge.style.display = 'block';
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
                sessionState
            );
        } catch (err) {
            logger.log('[Navigator] Loupe init failed: ' + err.message);
        }

        // Wire Loupe toggle button
        const btnLoupe = document.getElementById('btn-loupe');
        if (btnLoupe) {
            btnLoupe.addEventListener('click', () => {
                if (loupe) {
                    loupe.toggle();
                    btnLoupe.classList.toggle('active', loupe.isActive);
                }
            });
        }

        // Wire Reset Archetype button (master knob reset)
        const btnReset = document.getElementById('btn-reset-archetype');
        if (btnReset) {
            btnReset.addEventListener('click', () => {
                sessionState.resetAllKnobs();
            });
            // Show/hide based on knob customization state
            sessionState.on('knobsCustomizedChanged', (data) => {
                btnReset.style.display = data.customized ? 'block' : 'none';
            });
        }

        // Wire Restore My Tweaks button (Option B: Snapshot)
        const btnRestore = document.getElementById('btn-restore-tweaks');
        if (btnRestore) {
            btnRestore.addEventListener('click', () => {
                sessionState.restoreTweaks();
            });
            sessionState.on('tweaksAvailable', (data) => {
                btnRestore.style.display = data.available ? 'block' : 'none';
            });
            // Hide on knob customization (user is already tweaking — no need to restore)
            sessionState.on('knobsCustomizedChanged', (data) => {
                if (data.customized) btnRestore.style.display = 'none';
            });
        }

        // ─── Advanced Panel: Dropdowns & Checkboxes ───────────────
        // Wire all <select> dropdowns (change → updateParameter)
        const PICKER_DEFS = [
            'engineType', 'distanceMetric', 'centroidStrategy', 'vibrancyMode',
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
                    revertBtn.style.display = (dflt !== null && cur !== dflt) ? 'inline-block' : 'none';
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
                colorsEl.textContent = `${count} colors`;
            }
            if (deltaEl) {
                deltaEl.textContent = data.accuracyDeltaE != null
                    ? `\u0394E ${data.accuracyDeltaE.toFixed(1)}`
                    : '';
            }
            if (timeEl && data.elapsedMs != null) {
                timeEl.textContent = `${data.elapsedMs.toFixed(0)}ms`;
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
                if (overlay) overlay.style.display = 'none';
            });
        }

        // Wire Finalize button
        const btnFinalize = document.getElementById('btn-finalize');
        if (btnFinalize) {
            btnFinalize.addEventListener('click', () => handleFinalize());
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && surgeon) {
                surgeon.deselect();
            }
            // Z key → toggle 1:1 Loupe
            if ((e.key === 'z' || e.key === 'Z') && loupe && !e.ctrlKey && !e.metaKey) {
                loupe.toggle();
                const btnLoupeEl = document.getElementById('btn-loupe');
                if (btnLoupeEl) btnLoupeEl.classList.toggle('active', loupe.isActive);
            }
        });

        // Listen for document changes (open, switch, close)
        setupDocumentChangeListener();

        // Listen for manual dialog dismiss (X button / Escape)
        const dialogEl = document.getElementById('navigatorDialog');
        if (dialogEl) {
            dialogEl.addEventListener('close', () => _onDialogDismissed());
            dialogEl.addEventListener('cancel', () => _onDialogDismissed());
        }

        logger.log('[Navigator] Init complete');
    } catch (err) {
        logger.log('[Navigator] FATAL init error: ' + err.message);
        setStatus('Init error: ' + err.message);
    }
}

// ─── Document Change Detection ──────────────────────────

function setupDocumentChangeListener() {
    try {
        // Listen for document open and select (tab switch) events
        action.addNotificationListener(["open", "select"], onDocumentChanged);
        logger.log('[Navigator] Document change listener registered');
    } catch (err) {
        logger.log('[Navigator] Could not register document listener: ' + err.message);
    }
}

function onDocumentChanged() {
    if (!dialogOpen) return;

    // Check if the active document actually changed
    try {
        const doc = app.activeDocument;
        const newDocId = doc ? doc.id : null;

        if (newDocId && newDocId !== currentDocId) {
            logger.log(`[Navigator] Document changed: ${currentDocId} → ${newDocId}`);
            ingestActiveDocument(false);
        }
    } catch (_) {
        // No document open — ignore
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
    overlay.style.display = 'block';
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

        // ── Phases 2-4 are driven by SessionState.loadImage progress events ──
        await sessionState.loadImage(labPixels, width, height, originalWidth, originalHeight);

        _showProgress('Ready', 100);

    } catch (err) {
        logger.log(`[Navigator] Ingest failed: ${err.message}`);
        if (showDialog) {
            showErrorDialog('Ingest Failed', err.message);
        }
        setStatus('Error: ' + err.message);
    } finally {
        _hideProgress();
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
    const breakdownEl = document.getElementById('stat-breakdown');
    if (!scoreEl || !sessionState) return;

    const state = sessionState.getState();
    const activeId = state.activeArchetypeId;
    if (!activeId) return;

    // Find the active archetype's score from the ranked list
    const scores = sessionState.getAllArchetypeScores();
    const match = scores.find(s => s.id === activeId);
    if (!match) return;

    scoreEl.textContent = match.score.toFixed(0);

    if (breakdownEl && match.breakdown) {
        const b = match.breakdown;
        breakdownEl.textContent =
            `S:${b.structural.toFixed(0)} A:${b.sectorAffinity.toFixed(0)} P:${b.pattern.toFixed(0)}`;
    }
}

function updateDNADisplay() {
    const dnaEl = document.getElementById('stat-dna');
    if (!dnaEl || !sessionState) return;

    const dna = sessionState.getDNA();
    if (!dna || !dna.global) return;

    const g = dna.global;
    const parts = [
        `L:${Number(g.l).toFixed(0)}`,
        `C:${Number(g.c).toFixed(0)}`,
        `K:${Number(g.k).toFixed(0)}`,
        `\u03C3L:${Number(g.l_std_dev).toFixed(0)}`,
        `H:${Number(g.hue_entropy).toFixed(2)}`,
        `T:${Number(g.temperature_bias) >= 0 ? '+' : ''}${Number(g.temperature_bias).toFixed(1)}`
    ];
    dnaEl.textContent = parts.join(' \u00b7 ');
}

function setStatus(text) {
    const el = document.getElementById('status-text');
    if (el) el.textContent = text;
}

function _showProgress(label, percent) {
    const overlay = document.getElementById('progress-overlay');
    const status = document.getElementById('splash-status');
    if (overlay) {
        overlay.style.display = 'flex';
        overlay.classList.remove('fade-out');
    }
    if (status) status.textContent = label;
}

function _hideProgress() {
    const overlay = document.getElementById('progress-overlay');
    if (!overlay) return;
    overlay.classList.add('fade-out');
    setTimeout(() => {
        overlay.style.display = 'none';
        overlay.classList.remove('fade-out');
        const status = document.getElementById('splash-status');
        if (status) status.textContent = '';
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
                (state.trapSize > 0 ? ` | Trap ${state.trapSize}px` : '')
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

        // Validate document BEFORE showing dialog
        const validation = validateDocument();
        if (!validation.ok) {
            alert(`${validation.title}\n\n${validation.message}`);
            return;
        }

        // Initialize plugin on first open
        if (!sessionState) {
            initPlugin();
        }

        // Reset any stale state from previous session
        if (sessionState) sessionState.reset();
        _clearUI();

        const root = document.getElementById('root');
        if (root) root.style.display = '';

        dialogOpen = true;

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
        alert(`Navigator error: ${err.message}`);
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
