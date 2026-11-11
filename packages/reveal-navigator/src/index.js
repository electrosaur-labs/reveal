/**
 * Navigator - Screen Print Color Separation UI
 *
 * Command plugin: invoked from Plugins → Navigator...
 * Opens a non-modal dialog, auto-ingests the active document,
 * and dismisses itself after production render completes.
 */

const { entrypoints } = require("uxp");
const { app, action } = require("photoshop");
const Reveal = require("@electrosaur-labs/core");
const SessionState = require("./state/SessionState");
const PhotoshopBridge = require("./bridge/PhotoshopBridge");
const ProductionWorker = require("./bridge/ProductionWorker");
const Preview = require("./components/Preview");
const ArchetypeCarousel = require("./components/ArchetypeCarousel");
const MechanicalKnobs = require("./components/MechanicalKnobs");
const PaletteSurgeon = require("./components/PaletteSurgeon");
const Loupe = require("./components/Loupe");

const logger = Reveal.logger;

let sessionState = null;
let preview = null;
let carousel = null;
let knobs = null;
let surgeon = null;
let loupe = null;
// splashShownAt removed — splash screen eliminated
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
            document.getElementById('preview-placeholder'),
            sessionState
        );

        // Archetype name now shown in stats panel via updateMatchScore()

        // Wire Archetype Carousel (non-fatal if it fails)
        try {
            carousel = new ArchetypeCarousel(
                document.getElementById('carousel'),
                sessionState
            );
        } catch (err) {
            logger.log('[Navigator] Carousel init failed: ' + err.message);
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

        // Wire Advanced panel toggle (native <details> can be unreliable in some UXP environments)
        const advPanel = document.getElementById('advanced-panel');
        if (advPanel) {
            const trigger = document.getElementById('advanced-panel-trigger');
            if (trigger) {
                trigger.addEventListener('click', () => {
                    advPanel.classList.toggle('is-open');
                });
            }
        }

        // Wire Screen Printing panel toggle
        const spPanel = document.getElementById('screen-printing-panel');
        if (spPanel) {
            const trigger = document.getElementById('screen-printing-panel-trigger');
            if (trigger) {
                trigger.addEventListener('click', () => {
                    spPanel.classList.toggle('is-open');
                });
            }
        }

        // Wire Palette Surgeon (non-fatal)
        try {
            surgeon = new PaletteSurgeon(
                document.getElementById('palette-surgeon'),
                sessionState
            );
            surgeon.setPickerStateCallback((open) => {
                const panel = document.getElementById('main-panel');
                if (panel) panel.classList.toggle('picker-modal-active', open);
            });
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

        // Wire proxy resolution dropdown
        const proxyRes = document.getElementById('proxy-resolution');
        if (proxyRes) {
            proxyRes.addEventListener('change', async (e) => {
                const size = parseInt(e.target.value, 10);
                logger.log(`[Navigator] Proxy resolution changed to ${size}`);
                if (!sessionState || !size) return;
                Reveal.ProxyEngine.setProxyTargetSize(size);
                _completedPhases = [];
                _showProgress(`Resampling at ${size}px`, 5);
                await new Promise(r => setTimeout(r, 80)); // yield — let splash paint before CPU work
                try {
                    await sessionState.reinitializeProxy();
                    logger.log(`[Navigator] Proxy reinitialized at ${size}px`);
                } catch (err) {
                    logger.log(`[Navigator] Proxy reinitialize failed: ${err.message}`);
                } finally {
                    _hideProgress();
                }
            });
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

        // Wire filter/sort help buttons (click to expand)
        for (const id of ['filter-help-btn', 'sort-help-btn']) {
            const btn = document.getElementById(id);
            const text = document.getElementById(id.replace('-btn', '-text'));
            if (btn && text) {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const isVisible = text.classList.contains('visible');
                    document.querySelectorAll('.knob-help.visible').forEach(el => el.classList.remove('visible'));
                    document.querySelectorAll('.knob-help-btn.active').forEach(el => el.classList.remove('active'));
                    if (!isVisible) {
                        text.classList.add('visible');
                        btn.classList.add('active');
                    }
                });
            }
        }

        // Wire Reset to Defaults button (knobs + palette surgery)
        const btnReset = document.getElementById('btn-reset-top');
        if (btnReset) {
            btnReset.addEventListener('click', () => {
                sessionState.resetToDefaults();
            });
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
            'engineType', 'splitMode', 'quantizer', 'distanceMetric', 'centroidStrategy', 'vibrancyMode',
            'substrateMode', 'ditherType', 'colorMode', 'preprocessingIntensity',
            'meshSize'
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
                } else {
                    // Reset to first option when config doesn't specify (prevents stale browser cache)
                    picker.selectedIndex = 0;
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

        // ─── Structural change confirmation ─────────────────────
        const confirmBanner = document.getElementById('structural-confirm');
        const confirmOk = document.getElementById('structural-confirm-ok');
        const confirmCancel = document.getElementById('structural-confirm-cancel');

        sessionState.on('confirmStructuralChange', () => {
            if (confirmBanner) confirmBanner.setAttribute('style', 'display: block');
        });

        sessionState.on('revertParameter', ({ key, value }) => {
            if (confirmBanner) confirmBanner.setAttribute('style', 'display: none');
            // Snap slider/picker back to current value
            syncAdvancedControls(sessionState.getState());
            if (knobs) knobs.syncFromConfig(sessionState.getState());
        });

        if (confirmOk) {
            confirmOk.addEventListener('click', () => {
                confirmBanner.setAttribute('style', 'display: none');
                sessionState.confirmStructuralChange();
            });
        }
        if (confirmCancel) {
            confirmCancel.addEventListener('click', () => {
                confirmBanner.setAttribute('style', 'display: none');
                sessionState.cancelStructuralChange();
            });
        }

        // Progress events from SessionState (heavy CPU phases during loadImage)
        sessionState.on('progress', (data) => {
            _showProgress(data.label, data.percent);
        });

        // Carousel cards built during ingest — user sees them populate in real time.
        sessionState.on('carouselReady', () => {
            // Cards are built by ArchetypeCarousel._rebuild().
        });

        // Background scoring progress — update splash + stats panel ΔE.
        sessionState.on('archetypeScored', (data) => {
            const state = sessionState.getState();
            if (data.id === state.activeArchetypeId) {
                _setStatRated(document.getElementById('stat-delta'), 'deltaE', data.meanDeltaE, '\u0394E ');
            }
            // Update splash progress with scoring count
            _updateScoringProgress(data.computed, data.total);
        });

        // Background scoring done — reveal everything at once.
        sessionState.on('scoringComplete', (data) => {
            if (carousel) carousel.sortByDisplayedDeltaE();
            // Let carousel re-sort and card swatches render before revealing
            setTimeout(() => {
                // Show preview image
                const img = document.getElementById('preview-img');
                if (img) img.style.display = 'block';
                // Hide splash
                const placeholder = document.getElementById('preview-placeholder');
                if (placeholder) placeholder.style.display = 'none';
                // Show finalize button
                const finalizeRow = document.getElementById('finalize-row');
                if (finalizeRow) finalizeRow.style.display = '';
                // Show right panel and header controls
                const hudPanel = document.getElementById('hud-panel');
                if (hudPanel) hudPanel.style.display = '';
                const proxyResLabel = document.getElementById('proxy-resolution-label');
                if (proxyResLabel) proxyResLabel.setAttribute('style', 'display: inline; color:#888; font-size:10px; margin-left:4px;');
                const proxyResEl = document.getElementById('proxy-resolution');
                if (proxyResEl) proxyResEl.setAttribute('style', 'display: inline-block;');
                const loupeLabel = document.getElementById('loupe-label');
                if (loupeLabel) loupeLabel.setAttribute('style', 'display: inline; color:#e0e0e0; font-size:10px;');
                const loupeZoom = document.getElementById('loupe-zoom');
                if (loupeZoom) loupeZoom.setAttribute('style', 'display: inline-block;');
                const loupeHelpBtn = document.getElementById('loupe-help-btn');
                if (loupeHelpBtn) loupeHelpBtn.setAttribute('style', 'display: inline-block;');
                const btnTrapInspectEl = document.getElementById('btn-trap-inspect');
                if (btnTrapInspectEl) {
                    btnTrapInspectEl.style.display = 'inline-block';
                    btnTrapInspectEl.disabled = !(sessionState.state.trapSize > 0);
                }
                _hideProgress();
            }, 250);
        });

        // When the user clicks a card, update the stats panel ΔE from stored values
        sessionState.on('archetypeChanged', () => {
            _setStatRated(document.getElementById('stat-delta'), 'deltaE', sessionState.getArchetypeDeltaE(), '\u0394E ');
        });

        // Pulse 1: dnaReady fires ~50ms after ingest — update DNA stats immediately
        sessionState.on('dnaReady', (dna) => {
            const sectorEl = document.getElementById('dominant-sector');
            if (sectorEl && dna && dna.dominant_sector) {
                sectorEl.textContent = `Dominant: ${dna.dominant_sector}`;
            }
            updateDNADisplay();
        });

        // Show dominant sector (kept for backward compat with imageLoaded)
        sessionState.on('imageLoaded', (data) => {
            const sectorEl = document.getElementById('dominant-sector');
            if (sectorEl && data.dna && data.dna.dominant_sector) {
                sectorEl.textContent = `Dominant: ${data.dna.dominant_sector}`;
            }
        });

        // proxyReady: image is posterized but scoring still in progress.
        // Don't show UI yet — wait for scoringComplete to reveal everything together.
        sessionState.on('proxyReady', () => {
            // Sync controls but keep UI hidden until scoring completes
        });

        // Update inline stats in doc-header on every posterization
        sessionState.on('previewUpdated', (data) => {
            _showHeaderStats(true);

            // Hide processing overlay if active
            const overlay = document.getElementById('processing-overlay');
            if (overlay) overlay.classList.remove('visible');

            const colorsEl = document.getElementById('stat-colors');
            const deltaEl = document.getElementById('stat-delta');
            if (colorsEl && data.palette) {
                const count = data.activeColorCount != null ? data.activeColorCount : data.palette.length;
                colorsEl.textContent = `${count} colors`;
            }
            _setStatRated(deltaEl, 'deltaE', sessionState.getArchetypeDeltaE(), '\u0394E ');

            // DNA Fidelity display
            const dnaFidelityEl = document.getElementById('dna-fidelity-text');
            if (dnaFidelityEl && data.dnaFidelity) {
                const f = data.dnaFidelity;
                const score = Math.round(f.fidelity);
                _setStatRated(dnaFidelityEl, 'dna', score, 'DNA ');
                dnaFidelityEl.title = f.alerts.length
                    ? f.alerts.join('\n')
                    : 'No drift detected';
            }

            updateMatchScore();
            updateDNADisplay();
        });

        sessionState.on('processingStart', () => {
            const overlay = document.getElementById('processing-overlay');
            if (overlay) overlay.classList.add('visible');
        });

        sessionState.on('error', (err) => {
            const overlay = document.getElementById('processing-overlay');
            if (overlay) overlay.classList.remove('visible');
            _hideProgress();
            _showError(err.message || 'An unknown error occurred', err.stack);
        });

        // Wire Reread Document button — re-ingests from Photoshop
        const btnReread = document.getElementById('btn-reread');
        if (btnReread) {
            btnReread.addEventListener('click', () => {
                btnReread.disabled = true;
                ingestActiveDocument(true);
            });
        }

        // ─── Black Snap (preprocessing — load-time only) ─────────
        // Not a reactive knob: it must run once, on the full-resolution
        // source, before DNA/proxy/anything derives from it (see
        // SessionState._loadImageImpl). Changing it after a document is
        // already loaded can't take effect without rereading the document
        // from Photoshop — which also wipes palette edits (SessionState.reset()
        // is unconditional on reread). The knob-help bubble text is the only
        // warning given for this; toggling just rereads immediately.
        const chkBlackSnap = document.getElementById('chk-blackSnap');

        if (chkBlackSnap) {
            // Reflect the session's current value whenever a document loads
            // (covers both initial load and post-reread re-sync).
            sessionState.on('proxyReady', () => {
                chkBlackSnap.checked = !!sessionState.state.blackSnap;
            });

            chkBlackSnap.addEventListener('change', () => {
                sessionState.state.blackSnap = chkBlackSnap.checked;
                // No document loaded yet — nothing to reread, just set the
                // value for the next initial load.
                if (sessionState.proxyEngine) {
                    ingestActiveDocument(true);
                }
            });
        }

        // Black Snap darkness threshold (L* ceiling) — same load-time-only
        // nature as the checkbox above: a reread, not a reactive knob. 'input'
        // only updates the live label (cheap); 'change' (fires once, on
        // release) is what actually triggers the reread, so dragging the
        // slider doesn't fire a reread per pixel of movement.
        const knobBlackSnapLMax = document.getElementById('knob-blackSnapLMax');
        const blackSnapLMaxVal = document.getElementById('blackSnapLMax-val');

        if (knobBlackSnapLMax) {
            sessionState.on('proxyReady', () => {
                const v = sessionState.state.blackSnapLMax;
                knobBlackSnapLMax.value = v;
                if (blackSnapLMaxVal) blackSnapLMaxVal.textContent = v;
            });

            knobBlackSnapLMax.addEventListener('input', () => {
                if (blackSnapLMaxVal) blackSnapLMaxVal.textContent = knobBlackSnapLMax.value;
            });

            knobBlackSnapLMax.addEventListener('change', () => {
                const newValue = parseFloat(knobBlackSnapLMax.value);
                sessionState.state.blackSnapLMax = newValue;
                if (blackSnapLMaxVal) blackSnapLMaxVal.textContent = newValue;
                // Only matters (and only worth a reread) if Black Snap is
                // actually on — otherwise just store it for next time.
                if (sessionState.proxyEngine && sessionState.state.blackSnap) {
                    ingestActiveDocument(true);
                }
            });
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

        // Per-control help toggle: click ? button to show/hide inline help
        const explicitHelpIds = new Set(['filter-help-btn', 'sort-help-btn']);
        document.querySelectorAll('.knob-help-btn').forEach(btn => {
            if (explicitHelpIds.has(btn.id)) return;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Find the associated help text: walk from the knob-row, or from the button itself
                const row = btn.closest('.knob-row');
                let helpEl = null;
                let start = row || btn;
                let sibling = start.nextElementSibling;
                while (sibling && !sibling.classList.contains('knob-help')) {
                    sibling = sibling.nextElementSibling;
                }
                helpEl = sibling;
                if (helpEl) {
                    helpEl.classList.toggle('visible');
                    btn.classList.toggle('active', helpEl.classList.contains('visible'));
                }
            });
        });
        document.addEventListener('click', (e) => {
            if (!e.target.classList.contains('knob-help-btn')) {
                document.querySelectorAll('.knob-help.visible').forEach(el => el.classList.remove('visible'));
                document.querySelectorAll('.knob-help-btn.active').forEach(el => el.classList.remove('active'));
            }
        });

        // Show Traps toggle
        const btnTrapInspect = document.getElementById('btn-trap-inspect');
        const trapSlider = document.getElementById('knob-trapSize');
        if (btnTrapInspect && preview) {
            btnTrapInspect.addEventListener('click', () => {
                if (preview.isTrapOverlayActive()) {
                    preview.hideTrapOverlay();
                    btnTrapInspect.textContent = 'Show Traps';
                    btnTrapInspect.classList.remove('active');
                } else {
                    preview.showTrapOverlay();
                    if (preview.isTrapOverlayActive()) {
                        btnTrapInspect.textContent = 'Hide Traps';
                        btnTrapInspect.classList.add('active');
                    }
                }
            });

            // Disable while a palette swatch is highlighted; re-enable when cleared
            sessionState.on('highlightChanged', (data) => {
                const highlightActive = data.colorIndex >= 0 || !!data.ghostBuffer;
                if (highlightActive) {
                    if (btnTrapInspect.classList.contains('active')) {
                        btnTrapInspect.textContent = 'Show Traps';
                        btnTrapInspect.classList.remove('active');
                    }
                    btnTrapInspect.disabled = true;
                } else {
                    btnTrapInspect.disabled = !(sessionState.state.trapSize > 0);
                }
            });

            // Live overlay update + disabled state when trap slider changes
            if (trapSlider) {
                trapSlider.addEventListener('change', () => {
                    const hasTrap = sessionState.state.trapSize > 0;
                    btnTrapInspect.disabled = !hasTrap;
                    if (!hasTrap && preview.isTrapOverlayActive()) {
                        preview.hideTrapOverlay();
                        btnTrapInspect.textContent = 'Show Traps';
                        btnTrapInspect.classList.remove('active');
                        return;
                    }
                    if (preview.isTrapOverlayActive()) {
                        preview.showTrapOverlay();
                    }
                });
            }
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

    // blackSnap/blackSnapLMax must reset to defaults on an actual document
    // SWITCH, but not on a reread of the SAME document — the checkbox's and
    // slider's own change-triggered reread (and the plain "Reread Document"
    // button) all go through this same function, and all need whatever
    // value was just set to survive reset(). Must be computed before
    // currentDocId is overwritten below.
    let sameDocument = false;
    try {
        sameDocument = !!(currentDocId && app.activeDocument && app.activeDocument.id === currentDocId);
    } catch (_) {
        sameDocument = false;
    }
    const preservedBlackSnap = (sameDocument && sessionState) ? sessionState.state.blackSnap : false;
    const preservedBlackSnapLMax = (sameDocument && sessionState)
        ? sessionState.state.blackSnapLMax
        : Reveal.BlackSnap.DEFAULT_L_MAX;

    // Immediately clear stale content so old preview never flashes
    _clearUI();
    if (sessionState) {
        sessionState.reset();
        sessionState.state.blackSnap = preservedBlackSnap;
        sessionState.state.blackSnapLMax = preservedBlackSnapLMax;
    }


    _showProgress('Preparing\u2026', 0);
    await new Promise(r => setTimeout(r, 20)); // yield so progress bar paints

    try {
        const validation = validateDocument();
        if (!validation.ok) {
            if (showDialog) {
                showErrorDialog(validation.title, validation.message);
            }
            setStatus(validation.title);
            _hideProgress();
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
        _showProgress('Acquiring image data\u2026', 10);
        await new Promise(r => setTimeout(r, 20)); // yield so progress bar paints

        // Read full-res pixels — ProxyEngine handles downsampling internally.
        // PS GPU downsampling (targetSize) was tested but loses minority color
        // signals like green on the Jethro image. Photoshop's bicubic resample
        // averages out sparse green pixels that JS bilinear preserves.
        // The preservedUnifyThreshold fix helps but doesn't fully compensate.
        const { labPixels, width, height, originalWidth, originalHeight } =
            await PhotoshopBridge.getDocumentLab();
        logger.log(`[Navigator] Ingested ${width}x${height} from ${validation.info.name}`);

        // Must be set BEFORE loadImage() -- _loadImageImpl reads
        // this.imageResolution during the load itself (black snap's edge
        // radius, mechanical knobs' mesh dpi), not just afterward (trap
        // overlay, production commit). sessionState.reset() (called at the
        // top of this function) already zeroed it back to null; setting it
        // after loadImage would mean the load runs on unknown/stale data.
        // No fallback: validation.info.resolution is the real document
        // resolution (PhotoshopBridge reads doc.resolution directly), and
        // validateDocument() above already rejected the "no document" case.
        sessionState.imageResolution = validation.info.resolution;

        // ── Phases 2-3 are driven by SessionState.loadImage progress events ──
        // Progress screen stays visible until background scoring completes (scoringComplete event).
        await sessionState.loadImage(labPixels, width, height, originalWidth, originalHeight);
        _showProgress('Scoring archetypes\u2026', 85);

    } catch (err) {
        logger.log(`[Navigator] Ingest failed: ${err.message}`);
        if (showDialog) {
            showErrorDialog('Ingest Failed', err.message);
        }
        setStatus('Error: ' + err.message);
        _hideProgress();
    } finally {
        isIngesting = false;
    }
}

function updateDocumentHeader(info) {
    const nameEl = document.getElementById('doc-name');

    if (!info) {
        info = PhotoshopBridge.getDocumentInfo();
    }

    if (!info) {
        if (nameEl) nameEl.textContent = 'No document';
        return;
    }

    if (nameEl) nameEl.textContent = info.name;
}

const HEADER_STAT_IDS = [
    'stat-archetype-name', 'stat-sep-colors', 'stat-colors',
    'stat-sep-delta', 'stat-delta',
    'stat-sep-fidelity', 'dna-fidelity-text',
    'stat-sep-score', 'stat-score'
];

// Color-code a metric value: green = good, yellow = ok, red = bad.
// No labels — just the number in color. Thresholds calibrated for screen print.
function _rateColor(value, metric) {
    if (value == null || value !== value) return '#ccc';
    switch (metric) {
        case 'score':   // sortScore: lower = better
            if (value < 5)   return '#5cd65c';
            if (value < 8)   return '#8bd68b';
            if (value < 12)  return '#e0c97f';
            return '#e07f7f';
        case 'deltaE':  // mean ΔE: lower = better
            if (value < 6)   return '#5cd65c';
            if (value < 10)  return '#8bd68b';
            if (value < 15)  return '#e0c97f';
            return '#e07f7f';
        case 'dna':     // DNA fidelity: higher = better
            if (value > 80)  return '#5cd65c';
            if (value > 65)  return '#8bd68b';
            if (value > 50)  return '#e0c97f';
            return '#e07f7f';
        case 'match':   // Match %: higher = better
            if (value > 70)  return '#5cd65c';
            if (value > 55)  return '#8bd68b';
            if (value > 40)  return '#e0c97f';
            return '#e07f7f';
        default: return '#ccc';
    }
}

function _setStatRated(el, metric, value, prefix, suffix) {
    if (!el) return;
    if (value == null || value !== value) { el.textContent = ''; return; }
    const num = Number.isInteger(value) ? value.toString() : value.toFixed(1);
    el.textContent = `${prefix}${num}${suffix || ''}`;
    el.style.color = _rateColor(value, metric);
}

function _showHeaderStats(visible) {
    const display = visible ? '' : 'none';
    for (const id of HEADER_STAT_IDS) {
        const el = document.getElementById(id);
        if (el) el.style.display = display;
    }
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
        _setStatRated(scoreEl, 'match', match.score, 'Match ', '%');
    }

    // Update archetype name in stats line
    if (nameEl) {
        if (activeId === 'dynamic_interpolator') {
            nameEl.textContent = 'Chameleon';
        } else if (activeId === 'distilled') {
            nameEl.textContent = 'Distilled';
        } else {
            const Reveal = require('@electrosaur-labs/core');
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

// Phase swatch colors — one per progress step
const PHASE_COLORS = ['#e06060', '#e09040', '#d0c040', '#50b070', '#4090d0', '#8060c0'];
let _completedPhases = [];

function _showProgress(label, percent) {
    const bar = document.getElementById('ingest-progress');
    const fill = document.getElementById('ingest-progress-fill');
    const progressEl = document.getElementById('splash-progress');
    if (bar) bar.style.display = 'block';
    if (fill && percent != null) fill.style.width = percent + '%';

    if (progressEl) {
        const shortLabel = label.replace(/[\u2026.]+$/, '').trim();
        const pct = percent != null ? percent : 0;

        // If this is a new phase, move the previous one to [OK]
        const currentActive = progressEl.querySelector('.splash-active-text');
        if (currentActive && currentActive.textContent !== shortLabel.toUpperCase()) {
             _completedPhases.push(currentActive.textContent.toLowerCase());
        }

        let html = '<div class="splash-header">REVEAL CORE PROCESS LOG [v1.0.1]</div>';

        // Completed phases with [OK]
        for (let i = 0; i < _completedPhases.length; i++) {
            html += '<div class="splash-line">' +
                _completedPhases[i].toUpperCase() + ': <span class="splash-ok">[OK]</span></div>';
        }

        // Current phase with [IN PROGRESS...]
        html += '<div class="splash-line">' +
            shortLabel.toUpperCase() + ': <span class="splash-active">[IN PROGRESS...]</span>' +
            '<span class="splash-active-text" style="display:none">' + shortLabel.toUpperCase() + '</span></div>';

        // Progress bar
        html += '<div class="splash-bar"><div class="splash-bar-fill" style="width:' + pct + '%"></div></div>';

        // Date
        const now = new Date();
        const dateStr = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase() +
            ' | ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        html += '<div class="splash-date">' + dateStr + '</div>';

        progressEl.innerHTML = html;
    }
    setStatus(label);
}

function _updateScoringProgress(computed, total) {
    const progressEl = document.getElementById('splash-progress');
    if (!progressEl) return;
    
    // Ensure "SCORING ARCHETYPES" is the active line if not already
    const activeText = progressEl.querySelector('.splash-active-text');
    if (!activeText || activeText.textContent !== 'SCORING ARCHETYPES') {
        _showProgress('Scoring archetypes\u2026', 85);
    }

    const pct = total > 0 ? Math.round(85 + (computed / total) * 15) : 90;
    const fill = document.getElementById('ingest-progress-fill');
    if (fill) fill.style.width = pct + '%';
    // Update just the progress bar and active line inside splash
    const barFill = progressEl.querySelector('.splash-bar-fill');
    if (barFill) barFill.style.width = pct + '%';
    const activeLine = progressEl.querySelector('.splash-active');
    if (activeLine) activeLine.textContent = `[${computed}/${total}] IN PROGRESS...`;
}

function _hideProgress() {
    const bar = document.getElementById('ingest-progress');
    const fill = document.getElementById('ingest-progress-fill');
    if (fill) fill.style.width = '100%';
    setTimeout(() => {
        if (bar) bar.style.display = 'none';
        if (fill) fill.style.width = '0%';
    }, 300);
    _completedPhases = [];
    setStatus('');
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
    if (btn) btn.disabled = true;
    if (carouselEl) carouselEl.style.pointerEvents = 'none';

    // Yield to repaint before heavy I/O
    await new Promise(r => setTimeout(r, 50));

    try {
        const worker = new ProductionWorker(sessionState);
        const result = await worker.execute();

        logger.log(`[Navigator] Production render complete: ${result.layerCount} layers, ${result.elapsedMs}ms`);

        // Dismiss dialog — work is done
        _closeDialog();

    } catch (err) {
        // DIAGNOSTIC (2026-11-11): err.message has been showing up as the
        // literal string "undefined" — meaning err is NOT a standard Error
        // (or at least .message isn't populated). Dumping everything we can
        // get out of it to find out what it actually is before guessing
        // again at the root cause.
        let diag = `typeof=${typeof err}`;
        try { diag += ` name=${err && err.name}`; } catch (_) {}
        try { diag += ` number=${err && err.number}`; } catch (_) {}
        try { diag += ` description=${err && err.description}`; } catch (_) {}
        try { diag += ` keys=${err ? Object.getOwnPropertyNames(err).join(',') : 'n/a'}`; } catch (_) {}
        try { diag += ` json=${JSON.stringify(err)}`; } catch (_) {}
        try { diag += ` stack=${err && err.stack}`; } catch (_) {}
        logger.log('[Navigator] Production render failed: ' + err.message);
        logger.log('[Navigator] Production render failure DIAGNOSTIC: ' + diag);
        showErrorDialog('Production Failed', err.message);
        // Restore UI on failure
        if (btn) btn.disabled = false;
        if (carouselEl) carouselEl.style.pointerEvents = '';
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
    if (btn) btn.disabled = false;
    if (carouselEl) carouselEl.style.pointerEvents = '';
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
        placeholder.style.display = 'flex';
        placeholder.style.color = '';
        // Restore splash structure if it was replaced by an error message
        if (!placeholder.querySelector('#splash-progress')) {
            placeholder.innerHTML = '<div id="splash-progress"></div>';
        }
        const progress = placeholder.querySelector('#splash-progress');
        if (progress) progress.textContent = 'Loading\u2026';
    }

    // Clear carousel cards
    const carouselEl = document.getElementById('carousel');
    if (carouselEl) carouselEl.innerHTML = '';

    // Hide inline stats in header
    _showHeaderStats(false);

    // Hide finalize row
    const finalizeRow = document.getElementById('finalize-row');
    if (finalizeRow) finalizeRow.style.display = 'none';

    // Hide right panel and header controls (shown on proxyReady)
    const hudPanel = document.getElementById('hud-panel');
    if (hudPanel) hudPanel.style.display = 'none';
    const proxyResEl = document.getElementById('proxy-resolution');
    if (proxyResEl) { proxyResEl.style.display = 'none'; proxyResEl.value = '1000'; }
    Reveal.ProxyEngine.setProxyTargetSize(1000);
    const proxyResLabel = document.getElementById('proxy-resolution-label');
    if (proxyResLabel) proxyResLabel.style.display = 'none';
    const loupeLabel = document.getElementById('loupe-label');
    if (loupeLabel) loupeLabel.style.display = 'none';
    const loupeZoom = document.getElementById('loupe-zoom');
    if (loupeZoom) { loupeZoom.style.display = 'none'; loupeZoom.selectedIndex = 0; }
    const loupeHelpBtn = document.getElementById('loupe-help-btn');
    if (loupeHelpBtn) loupeHelpBtn.style.display = 'none';
    const btnTrapInspectReset = document.getElementById('btn-trap-inspect');
    if (btnTrapInspectReset) { btnTrapInspectReset.style.display = 'none'; btnTrapInspectReset.textContent = 'Show Traps'; btnTrapInspectReset.classList.remove('active'); }

    // Reset all pickers to first option (prevents stale browser/UXP cache)
    document.querySelectorAll('#knobs-panel select, #advanced-panel select').forEach(sel => { sel.selectedIndex = 0; });
    document.querySelectorAll('#knobs-panel input[type="checkbox"], #advanced-panel input[type="checkbox"]').forEach(chk => {
        chk.checked = chk.defaultChecked;
    });

    // Clear status
    setStatus('');
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

        // Show dialog immediately — user sees empty Navigator with status text.
        // Ingest runs inside the visible dialog; UI populates when ready.
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

        await ingestActiveDocument(false);

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
