/**
 * app.js — Reveal App frontend
 *
 * Vanilla JS, no framework. Canvas rendering via putImageData.
 * WebSocket for progressive card delivery from the server.
 */

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const statusBar = document.getElementById('status-bar');
const cardsContainer = document.getElementById('cards');
const userPick = document.getElementById('user-pick');
const archetypeSelect = document.getElementById('archetype-select');
const previewSection = document.getElementById('preview-section');
const previewTitle = document.getElementById('preview-title');
const previewCanvas = document.getElementById('preview-canvas');
const previewPalette = document.getElementById('preview-palette');
const exportBtn = document.getElementById('export-btn');
const formatSelect = document.getElementById('format-select');

let ws = null;
let cards = [];
let selectedIndex = -1;

// ─── WebSocket ───

function connectWs() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
            case 'status':
                showStatus(msg.message);
                break;
            case 'card':
                addCard(msg);
                break;
            case 'ready':
                showStatus(`Done — ${msg.cardCount} archetypes computed`);
                userPick.hidden = false;
                break;
            case 'error':
                showStatus(`Error: ${msg.message}`);
                dropZone.classList.remove('processing');
                break;
        }
    };

    ws.onclose = () => setTimeout(connectWs, 2000);
}

connectWs();

// ─── File handling ───

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFile(fileInput.files[0]);
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
});

async function uploadFile(file) {
    // Reset UI
    cards = [];
    selectedIndex = -1;
    cardsContainer.innerHTML = '';
    cardsContainer.hidden = false;
    previewSection.hidden = true;
    userPick.hidden = true;
    dropZone.classList.add('processing');

    const form = new FormData();
    form.append('image', file);

    showStatus(`Uploading ${file.name}...`);

    try {
        const res = await fetch('/ingest', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) showStatus(`Error: ${data.error}`);
    } catch (err) {
        showStatus(`Upload failed: ${err.message}`);
    }

    dropZone.classList.remove('processing');
}

// ─── Card rendering ───

function addCard(cardData) {
    cards.push(cardData);
    const idx = cards.length - 1;

    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.index = idx;

    // Canvas preview thumbnail
    const canvas = document.createElement('canvas');
    canvas.className = 'card-preview';
    canvas.width = cardData.previewWidth;
    canvas.height = cardData.previewHeight;
    renderRgba(canvas, cardData.previewRgba, cardData.previewWidth, cardData.previewHeight);

    // Info
    const info = document.createElement('div');
    info.className = 'card-info';

    const label = document.createElement('div');
    label.className = 'card-label';
    label.textContent = cardData.label || 'User Pick';

    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = formatArchetypeName(cardData.archetypeName || cardData.archetypeId);

    info.appendChild(label);
    info.appendChild(name);

    if (cardData.matchScore !== null && cardData.matchScore !== undefined) {
        const score = document.createElement('div');
        score.className = 'card-score';
        score.textContent = `Score: ${cardData.matchScore.toFixed(1)}`;
        info.appendChild(score);
    }

    const colors = document.createElement('div');
    colors.className = 'card-score';
    colors.textContent = `${cardData.colorCount} colors`;
    info.appendChild(colors);

    // Swatches
    const swatches = document.createElement('div');
    swatches.className = 'card-swatches';
    for (const hex of cardData.hexColors) {
        const sw = document.createElement('div');
        sw.className = 'swatch';
        sw.style.backgroundColor = hex;
        sw.title = hex;
        swatches.appendChild(sw);
    }

    // Dismiss button
    const dismiss = document.createElement('button');
    dismiss.className = 'card-dismiss';
    dismiss.textContent = '\u00d7';
    dismiss.title = 'Dismiss';
    dismiss.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissCard(idx);
    });

    card.appendChild(dismiss);
    card.appendChild(canvas);
    card.appendChild(info);
    card.appendChild(swatches);

    card.addEventListener('click', () => selectCard(idx));

    cardsContainer.appendChild(card);

    // Auto-select first card
    if (idx === 0) selectCard(0);
}

function dismissCard(idx) {
    const cardEl = cardsContainer.querySelector(`.card[data-index="${idx}"]`);
    if (cardEl) cardEl.remove();
    cards[idx] = null;

    // If dismissed card was selected, clear selection
    if (selectedIndex === idx) {
        selectedIndex = -1;
        previewSection.hidden = true;
        exportBtn.disabled = true;
    }
}

function selectCard(idx) {
    selectedIndex = idx;
    const cardData = cards[idx];

    // Highlight selected card
    document.querySelectorAll('.card').forEach((el, i) => {
        el.classList.toggle('selected', i === idx);
    });

    // Show large preview
    previewSection.hidden = false;
    previewTitle.textContent = `${cardData.label || 'User Pick'}: ${formatArchetypeName(cardData.archetypeName || cardData.archetypeId)}`;

    previewCanvas.width = cardData.previewWidth;
    previewCanvas.height = cardData.previewHeight;
    renderRgba(previewCanvas, cardData.previewRgba, cardData.previewWidth, cardData.previewHeight);

    // Palette details
    previewPalette.innerHTML = '';
    for (let i = 0; i < cardData.hexColors.length; i++) {
        const sw = document.createElement('div');
        sw.className = 'preview-swatch';

        const color = document.createElement('div');
        color.className = 'preview-swatch-color';
        color.style.backgroundColor = cardData.hexColors[i];

        const hex = document.createElement('span');
        hex.textContent = cardData.hexColors[i];

        const pct = document.createElement('span');
        pct.className = 'preview-swatch-pct';
        pct.textContent = cardData.coverage[i] !== undefined
            ? `${(cardData.coverage[i] * 100).toFixed(1)}%`
            : '';

        sw.appendChild(color);
        sw.appendChild(hex);
        sw.appendChild(pct);
        previewPalette.appendChild(sw);
    }

    exportBtn.disabled = false;
}

// ─── Canvas rendering ───

function renderRgba(canvas, base64Rgba, width, height) {
    const ctx = canvas.getContext('2d');
    const bytes = Uint8Array.from(atob(base64Rgba), c => c.charCodeAt(0));
    const imageData = new ImageData(new Uint8ClampedArray(bytes.buffer), width, height);
    ctx.putImageData(imageData, 0, 0);
}

// ─── User pick ───

// Load archetype list
fetch('/archetypes')
    .then(res => res.json())
    .then(groups => {
        for (const [group, archetypes] of Object.entries(groups)) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = group.charAt(0).toUpperCase() + group.slice(1);
            for (const arch of archetypes) {
                const opt = document.createElement('option');
                opt.value = arch.id;
                opt.textContent = arch.name;
                optgroup.appendChild(opt);
            }
            archetypeSelect.appendChild(optgroup);
        }
    });

archetypeSelect.addEventListener('change', () => {
    const id = archetypeSelect.value;
    if (!id || !ws) return;
    ws.send(JSON.stringify({ type: 'pick-archetype', archetypeId: id }));
});

// ─── Export ───

exportBtn.addEventListener('click', async () => {
    console.log('[export] Button clicked, selectedIndex=', selectedIndex);
    if (selectedIndex < 0) {
        console.log('[export] No card selected, aborting');
        return;
    }
    exportBtn.disabled = true;
    exportBtn.textContent = 'Exporting...';
    showStatus(`Exporting card ${selectedIndex}...`);

    const format = formatSelect.value;
    try {
        console.log('[export] POST /export', { cardIndex: selectedIndex, format });
        const res = await fetch('/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cardIndex: selectedIndex, format }),
        });
        const data = await res.json();
        console.log('[export] Response:', res.status, data);
        if (res.ok) {
            showStatus(`Exported: ${data.path}`);
        } else {
            showStatus(`Export error: ${data.error}`);
        }
    } catch (err) {
        console.error('[export] Fetch error:', err);
        showStatus(`Export failed: ${err.message}`);
    }

    exportBtn.disabled = false;
    exportBtn.textContent = 'Export';
});

// ─── Helpers ───

function showStatus(msg) {
    statusBar.hidden = false;
    statusBar.textContent = msg;
}

function formatArchetypeName(id) {
    return id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
