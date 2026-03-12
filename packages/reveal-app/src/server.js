/**
 * reveal-app server — Local web UI for Reveal color separation.
 *
 * Serves static frontend on localhost, handles file upload + processing.
 * Progressive results via WebSocket (each archetype card lights up as it completes).
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const { ingest } = require('./ingest-adapter');
const { processArchetypeComparison } = require('./app-pipeline');

const PORT = parseInt(process.env.PORT || '3700', 10);
const upload = multer({ dest: path.join(__dirname, '..', '.uploads'), limits: { fileSize: 500 * 1024 * 1024 } });

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// Log all requests
app.use((req, res, next) => {
    console.log(`[http] ${req.method} ${req.url}`);
    next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Track active sessions
let currentSession = null;

wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'pick-archetype' && currentSession) {
                handleUserPick(ws, msg.archetypeId);
            }
        } catch (e) {
            // ignore malformed messages
        }
    });
});

function broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const ws of wss.clients) {
        if (ws.readyState === 1) ws.send(payload);
    }
}

// POST /ingest — upload an image, start processing
app.post('/ingest', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const filePath = req.file.path;
    const originalName = req.file.originalname;

    try {
        broadcast({ type: 'status', message: `Ingesting ${originalName}...` });

        const { lab16bit, width, height, inputFormat } = await ingest(filePath, originalName);
        broadcast({ type: 'status', message: `Ingested: ${width}x${height} ${inputFormat}` });

        // Store session for user-pick
        currentSession = { lab16bit, width, height, filePath, originalName };

        // Run the 3+1 comparison (auto, chameleon, distilled)
        // Results streamed progressively via broadcast
        const results = await processArchetypeComparison(lab16bit, width, height, {
            onCardReady: (card) => broadcast({ type: 'card', ...card }),
            onProgress: (msg) => broadcast({ type: 'status', message: msg }),
        });

        currentSession.results = results;
        broadcast({ type: 'ready', cardCount: results.length });

        res.json({ ok: true, width, height, format: inputFormat, cards: results.length });
    } catch (err) {
        broadcast({ type: 'error', message: err.message });
        res.status(500).json({ error: err.message });
    } finally {
        // Clean up uploaded file
        try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    }
});

// Handle user archetype pick (the +1)
async function handleUserPick(ws, archetypeId) {
    if (!currentSession) return;

    const { lab16bit, width, height } = currentSession;
    broadcast({ type: 'status', message: `Processing ${archetypeId}...` });

    try {
        const { processSingleCard } = require('./app-pipeline');
        const cardIndex = currentSession.results ? currentSession.results.length : 4;
        const card = await processSingleCard(lab16bit, width, height, archetypeId, cardIndex);
        broadcast({ type: 'card', ...card });
        broadcast({ type: 'status', message: `${archetypeId} ready` });
    } catch (err) {
        broadcast({ type: 'error', message: `Failed: ${err.message}` });
    }
}

// GET /archetypes — list all available archetypes
app.get('/archetypes', (req, res) => {
    const { listArchetypes } = require('./app-pipeline');
    res.json(listArchetypes());
});

// POST /export — export a separation as PSD
app.post('/export', express.json(), async (req, res) => {
    console.log('[export] POST /export received', req.body);

    if (!currentSession || !currentSession.results) {
        console.log('[export] No active session or results');
        return res.status(400).json({ error: 'No active session' });
    }

    const { cardIndex, format = 'ora' } = req.body;
    console.log(`[export] cardIndex=${cardIndex}, format=${format}, results.length=${currentSession.results.length}`);
    const result = currentSession.results[cardIndex];
    if (!result) {
        console.log(`[export] Invalid card index ${cardIndex}`);
        return res.status(400).json({ error: 'Invalid card index' });
    }

    console.log(`[export] Exporting ${result.archetypeId} as ${format} (${result.colorCount} colors, ${currentSession.width}x${currentSession.height})`);

    try {
        const { exportSeparation } = require('./export-adapter');
        const outPath = await exportSeparation(result, currentSession, format);
        console.log(`[export] Written: ${outPath}`);
        res.json({ ok: true, path: outPath });
    } catch (err) {
        console.error(`[export] Error:`, err);
        res.status(500).json({ error: err.message });
    }
});

server.listen(PORT, '0.0.0.0', () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n  Reveal App → ${url}\n`);

    // Auto-open browser if --open flag
    if (process.argv.includes('--open')) {
        const { exec } = require('child_process');
        const cmd = process.platform === 'darwin' ? 'open' :
                    process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${cmd} ${url}`);
    }
});
