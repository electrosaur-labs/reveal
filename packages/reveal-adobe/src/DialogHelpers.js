/**
 * DialogHelpers - DOM-only dialog utilities
 *
 * No mutable state dependencies. Pure DOM manipulation for showing
 * error/success dialogs and managing preview section visibility.
 */

const Reveal = require("@reveal/core");
const logger = Reveal.logger;

/**
 * Show custom error dialog (more readable than alert)
 */
function showError(title, message, errorList = null) {
    const errorDialog = document.getElementById('errorDialog');
    const errorTitle = document.getElementById('errorTitle');
    const errorMessage = document.getElementById('errorMessage');
    const errorDetails = document.getElementById('errorDetails');
    const errorListEl = document.getElementById('errorList');

    if (!errorDialog) {
        logger.error("Error dialog not found!");
        alert(`${title}: ${message}`);
        return;
    }

    if (errorTitle) errorTitle.textContent = title;
    if (errorMessage) errorMessage.textContent = message;

    if (errorList && errorList.length > 0 && errorListEl) {
        errorListEl.innerHTML = '';
        errorList.forEach(err => {
            const li = document.createElement('li');
            li.textContent = err;
            li.style.marginBottom = '8px';
            errorListEl.appendChild(li);
        });
        errorListEl.style.display = 'block';
        if (errorDetails) errorDetails.style.display = 'none';
    } else {
        if (errorListEl) errorListEl.style.display = 'none';
        if (errorDetails) errorDetails.style.display = 'none';
    }

    errorDialog.showModal();

    const btnErrorOk = document.getElementById('btnErrorOk');
    if (btnErrorOk) {
        btnErrorOk.onclick = () => {
            errorDialog.close();
        };
    }
}

/**
 * Show error dialog with custom styling
 *
 * @param {string} title - Error title
 * @param {string} message - Error message
 * @param {string} details - Optional details (e.g., error code)
 */
function showErrorDialog(title, message, details = null) {
    const errorDialog = document.getElementById('errorDialog');
    const errorTitle = document.getElementById('errorTitle');
    const errorMessage = document.getElementById('errorMessage');
    const errorDetails = document.getElementById('errorDetails');
    const errorListEl = document.getElementById('errorList');

    if (!errorDialog) {
        logger.error('Error dialog element not found, falling back to alert');
        alert(`${title}\n\n${message}${details ? '\n\n' + details : ''}`);
        return;
    }

    errorTitle.textContent = title;
    errorMessage.textContent = message;

    if (errorListEl) errorListEl.style.display = 'none';

    if (details) {
        errorDetails.textContent = details;
        errorDetails.style.display = 'block';
    } else {
        errorDetails.style.display = 'none';
    }

    errorDialog.showModal();

    const btnOk = document.getElementById('btnErrorOk');
    const closeHandler = () => {
        errorDialog.close();
        btnOk.removeEventListener('click', closeHandler);
    };
    btnOk.addEventListener('click', closeHandler);
}

/**
 * Show success dialog after separation completes
 *
 * @param {number} layerCount - Number of layers created
 * @param {Object} palette - Palette used for separation {hexColors: [...]}
 * @param {number} separationStartTime - Timestamp when separation started
 */
function showSuccessDialog(layerCount, palette, separationStartTime) {
    try {
        const PhotoshopAPI = require("./api/PhotoshopAPI");
        let GoldenStatsCapture = null;
        try {
            GoldenStatsCapture = require("./core/GoldenStatsCapture");
        } catch (e) {
            // GoldenStatsCapture may not exist
        }

        const successDialog = document.getElementById('successDialog');

        if (!successDialog) {
            logger.error('Success dialog element not found!');
            alert(`Separation complete! Created ${layerCount} layers.\n\nSuccess dialog not available - check console for errors.`);
            return;
        }

        const layerCountEl = document.getElementById('layerCount');
        const btnDone = document.getElementById('btnSuccessDone');
        const btnCaptureStats = document.getElementById('btnCaptureGoldenStats');
        const captureStatus = document.getElementById('captureStatus');

        if (!layerCountEl || !btnDone || !btnCaptureStats || !captureStatus) {
            logger.error('Missing required elements!');
            alert(`Separation complete! Created ${layerCount} layers.`);
            return;
        }

        layerCountEl.textContent = layerCount;
        captureStatus.textContent = '';

        if (successDialog.open) {
            successDialog.close();
        }
        successDialog.showModal();

        btnDone.onclick = () => {
            successDialog.close();
        };

        btnCaptureStats.onclick = async () => {
        try {
            btnCaptureStats.disabled = true;
            btnCaptureStats.textContent = 'Capturing Statistics...';
            captureStatus.textContent = 'Analyzing separated layers...';

            const processingTimeMs = Date.now() - separationStartTime;

            const doc = PhotoshopAPI.getActiveDocument();
            const fixtureName = doc ? doc.name : 'unknown.png';

            const paletteData = palette.hexColors.map((hex, index) => {
                const r = parseInt(hex.substring(1, 3), 16);
                const g = parseInt(hex.substring(3, 5), 16);
                const b = parseInt(hex.substring(5, 7), 16);

                const layerName = `Color ${index + 1} - ${hex.toUpperCase()}`;

                return {
                    name: layerName,
                    hex: hex,
                    rgb: [r, g, b]
                };
            });

            const stats = await GoldenStatsCapture.captureStats({
                fixtureName: fixtureName,
                palette: paletteData,
                processingTimeMs: processingTimeMs
            });

            captureStatus.textContent = 'Writing to console...';

            const suggestedFilename = fixtureName.replace('.png', '-golden.json').replace('.psd', '-golden.json');
            const json = GoldenStatsCapture.exportToJSON(stats);

            captureStatus.innerHTML = `✓ JSON written to console!<br>Save as: ${suggestedFilename}`;
            captureStatus.style.color = '#2d9d78';
            captureStatus.style.fontWeight = '500';
            captureStatus.style.lineHeight = '1.4';

            btnCaptureStats.textContent = 'Capture Again';
            btnCaptureStats.disabled = false;

        } catch (error) {
            logger.error('Error capturing golden stats:', error);
            captureStatus.textContent = `Error: ${error.message}`;
            captureStatus.style.color = '#d7373f';

            btnCaptureStats.textContent = 'Retry Capture';
            btnCaptureStats.disabled = false;
        }
    };

    } catch (error) {
        logger.error('Error in showSuccessDialog:', error);
        alert(`Separation complete! Created ${layerCount} layers.\n\nError showing success dialog: ${error.message}`);
    }
}

/**
 * UXP-safe select option replacement.
 * innerHTML on <select> can corrupt the dropdown in UXP. Use DOM methods instead.
 * @param {HTMLSelectElement} selectEl
 * @param {Array<{value: string, text: string, selected?: boolean}>} options
 */
function replaceSelectOptions(selectEl, options) {
    while (selectEl.firstChild) {
        selectEl.removeChild(selectEl.firstChild);
    }
    options.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.text;
        if (opt.selected) option.selected = true;
        selectEl.appendChild(option);
    });
}

/**
 * Show preview section and hide parameter entry
 */
function showPreviewSection() {
    const paramSections = document.querySelectorAll('.form-section');
    paramSections.forEach(section => {
        if (!section.closest('#previewSection')) {
            section.style.display = 'none';
        }
    });

    const infoBox = document.querySelector('.info-box');
    if (infoBox && !infoBox.closest('#previewSection')) {
        infoBox.style.display = 'none';
    }

    const versionBadge = document.querySelector('.version-badge');
    if (versionBadge) {
        versionBadge.style.display = 'none';
    }

    const dialog = document.getElementById('mainDialog');
    if (dialog) {
        dialog.style.width = '520px';
    } else {
        logger.error("Could not find mainDialog element!");
    }

    const previewSection = document.getElementById('previewSection');
    previewSection.style.display = 'block';
    previewSection.style.width = '100%';
    previewSection.style.minWidth = '400px';

    const previewGrid = document.querySelector('.preview-grid');
    if (previewGrid) {
        previewGrid.style.display = 'flex';
        previewGrid.style.flexWrap = 'wrap';
        previewGrid.style.width = '100%';
        previewGrid.style.minWidth = '400px';
        previewGrid.style.gap = '16px';
    }

    const previewItems = document.querySelectorAll('.preview-item');
    previewItems.forEach(item => {
        item.style.minHeight = '150px';
        item.style.flex = '0 0 calc(50% - 8px)';
        item.style.width = 'calc(50% - 8px)';
        item.style.maxWidth = 'calc(50% - 8px)';
        item.style.padding = '12px';
        item.style.border = '2px solid #e1e1e1';
        item.style.borderRadius = '6px';
        item.style.background = '#fafafa';
    });

    document.getElementById('btnNext').style.display = 'none';
    document.getElementById('btnUseColors').style.display = 'block';

    document.querySelector('.reveal-title').textContent = 'Reveal - Color Selection';
    document.querySelector('.version-badge').textContent = 'Phase 2.5: Posterization Preview';
}

/**
 * Display posterization previews
 */
function displayPreviews(originalPixels, originalWidth, originalHeight, previews, docInfo) {

    const previewOriginal = document.getElementById('previewOriginal');
    const preview3 = document.getElementById('preview3');
    const preview5 = document.getElementById('preview5');
    const preview7 = document.getElementById('preview7');

    if (previewOriginal) previewOriginal.style.display = 'none';
    if (preview3) preview3.style.display = 'none';
    if (preview5) preview5.style.display = 'none';
    if (preview7) preview7.style.display = 'none';

    document.getElementById('originalInfo').textContent =
        `${docInfo.width} × ${docInfo.height}px (${docInfo.colorMode}, ${docInfo.bitDepth})`;

    showPreviewSection();

    previews.forEach(preview => {

        const paletteDiv = document.getElementById(`palette${preview.colorCount}`);
        if (!paletteDiv) {
            logger.error(`Palette div not found: palette${preview.colorCount}`);
            return;
        }

        const swatchesHTML = preview.hexColors.map(hex => `
            <div style="display: flex; flex-direction: column; align-items: center; gap: 4px;">
                <div class="color-swatch"
                     style="width: 48px; height: 48px; min-width: 48px; min-height: 48px;
                            background-color: ${hex}; border: 1px solid #cacaca;
                            border-radius: 3px; box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.1);
                            display: block;"
                     title="${hex}">
                </div>
                <div style="font-size: 10px; text-align: center; margin-top: 4px; color: #323232;">
                    ${hex}
                </div>
            </div>
        `).join('');

        paletteDiv.innerHTML = swatchesHTML;

    });

    const dialog = document.getElementById('mainDialog');
    const previewGrid = document.querySelector('.preview-grid');
    const previewSection = document.getElementById('previewSection');
    const previewItems = document.querySelectorAll('.preview-item');

    previewItems.forEach((item, i) => {
        const styles = window.getComputedStyle(item);
    });

    const palette3 = document.getElementById('palette3');
    const palette5 = document.getElementById('palette5');
    const palette7 = document.getElementById('palette7');

    if (palette3.children.length > 0) {
        const firstSwatch = palette3.children[0].querySelector('.color-swatch');
        if (firstSwatch) {
        }
    }
}

module.exports = {
    showError,
    showErrorDialog,
    showSuccessDialog,
    replaceSelectOptions,
    showPreviewSection,
    displayPreviews
};
