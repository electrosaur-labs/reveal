#!/usr/bin/env node
/**
 * Generate the silkscreen splash animated GIF.
 *
 * Scene: Looking down at a fine silkscreen mesh (green, tilted 37°).
 * "REVEAL" in solid yellow ink sits UNDER the mesh — realistic screen
 * printing where ink is pushed THROUGH the mesh by the squeegee,
 * visible through the mesh openings. A yellow squeegee blade wipes from
 * top to bottom, uncovering the ink+mesh composite.
 *
 * Text is rasterized from Anton Regular (TTF) via opentype.js.
 *
 * Compositing (above squeegee, already wiped):
 *   mesh thread present → mesh color (threads on top of ink)
 *   inkMap (REVEAL) → visible through mesh openings
 *   else → dark background
 *
 * Output: src/squeegee.gif (512x320, ~16 frames, ~200-300 KB)
 */
const fs = require('fs');
const path = require('path');
const { GifWriter } = require('omggif');
const opentype = require('opentype.js');

const W = 512, H = 320;
const FRAME_COUNT = 16;     // 2 hold + 13 wipe + 1 final hold
const FRAME_DELAY = 10;     // centiseconds (100ms per frame)
const MESH_ANGLE = -19 * Math.PI / 180;  // 19° clockwise
const MESH_SPACING = 14;    // scaled from 28 at 1024 → 14 at 512
const MESH_LINE_W = 0.5;    // scaled from 1.0

// ─── Color Palette (GIF indexed, 8 entries) ───
const PALETTE = [
    0x1e1e1e,   // 0: dark background
    0x1a4a18,   // 1: dark mesh shadow (green)
    0x2a8a28,   // 2: medium mesh (green)
    0x38d030,   // 3: bright mesh line (green)
    0xd0c020,   // 4: squeegee yellow
    0xffdd00,   // 5: REVEAL ink (bright yellow)
    0x988818,   // 6: squeegee edge (dark yellow)
    0x000000,   // 7: pure black (pad)
];

const INK_COLOR = 5;  // solid yellow for all letters

// ─── Load Anton font ───
const fontPath = path.join(__dirname, '..', 'src', 'Anton-Regular.ttf');
if (!fs.existsSync(fontPath)) {
    console.error('Anton-Regular.ttf not found at ' + fontPath);
    process.exit(1);
}
const font = opentype.loadSync(fontPath);
console.log('Loaded Anton Regular');

// ─── Scanline rasterizer ───

/**
 * Rasterize an opentype.js Path into a bitmap using scanline fill.
 */
function rasterizePath(bitmap, w, h, pathObj, colorIndex) {
    const segments = [];
    let cx = 0, cy = 0;
    let startX = 0, startY = 0;

    for (const cmd of pathObj.commands) {
        switch (cmd.type) {
            case 'M':
                cx = cmd.x; cy = cmd.y;
                startX = cx; startY = cy;
                break;
            case 'L':
                segments.push({ x1: cx, y1: cy, x2: cmd.x, y2: cmd.y });
                cx = cmd.x; cy = cmd.y;
                break;
            case 'Q': {
                const steps = 10;
                for (let t = 0; t < steps; t++) {
                    const t0 = t / steps, t1 = (t + 1) / steps;
                    const x0 = (1-t0)*(1-t0)*cx + 2*(1-t0)*t0*cmd.x1 + t0*t0*cmd.x;
                    const y0 = (1-t0)*(1-t0)*cy + 2*(1-t0)*t0*cmd.y1 + t0*t0*cmd.y;
                    const x1 = (1-t1)*(1-t1)*cx + 2*(1-t1)*t1*cmd.x1 + t1*t1*cmd.x;
                    const y1 = (1-t1)*(1-t1)*cy + 2*(1-t1)*t1*cmd.y1 + t1*t1*cmd.y;
                    segments.push({ x1: x0, y1: y0, x2: x1, y2: y1 });
                }
                cx = cmd.x; cy = cmd.y;
                break;
            }
            case 'C': {
                const steps = 14;
                for (let t = 0; t < steps; t++) {
                    const t0 = t / steps, t1 = (t + 1) / steps;
                    const x0 = (1-t0)**3*cx + 3*(1-t0)**2*t0*cmd.x1 + 3*(1-t0)*t0**2*cmd.x2 + t0**3*cmd.x;
                    const y0 = (1-t0)**3*cy + 3*(1-t0)**2*t0*cmd.y1 + 3*(1-t0)*t0**2*cmd.y2 + t0**3*cmd.y;
                    const x1 = (1-t1)**3*cx + 3*(1-t1)**2*t1*cmd.x1 + 3*(1-t1)*t1**2*cmd.x2 + t1**3*cmd.x;
                    const y1 = (1-t1)**3*cy + 3*(1-t1)**2*t1*cmd.y1 + 3*(1-t1)*t1**2*cmd.y2 + t1**3*cmd.y;
                    segments.push({ x1: x0, y1: y0, x2: x1, y2: y1 });
                }
                cx = cmd.x; cy = cmd.y;
                break;
            }
            case 'Z':
                if (cx !== startX || cy !== startY) {
                    segments.push({ x1: cx, y1: cy, x2: startX, y2: startY });
                }
                cx = startX; cy = startY;
                break;
        }
    }

    // Scanline fill using even-odd rule
    let minY = h, maxY = 0;
    for (const s of segments) {
        const lo = Math.floor(Math.min(s.y1, s.y2));
        const hi = Math.ceil(Math.max(s.y1, s.y2));
        if (lo < minY) minY = lo;
        if (hi > maxY) maxY = hi;
    }
    minY = Math.max(0, minY);
    maxY = Math.min(h - 1, maxY);

    for (let y = minY; y <= maxY; y++) {
        const scanY = y + 0.5;
        const crossings = [];

        for (const s of segments) {
            const { x1, y1, x2, y2 } = s;
            if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
                const t = (scanY - y1) / (y2 - y1);
                crossings.push(x1 + t * (x2 - x1));
            }
        }

        crossings.sort((a, b) => a - b);

        for (let i = 0; i + 1 < crossings.length; i += 2) {
            const xStart = Math.max(0, Math.ceil(crossings[i]));
            const xEnd = Math.min(w - 1, Math.floor(crossings[i + 1]));
            for (let x = xStart; x <= xEnd; x++) {
                bitmap[y * w + x] = colorIndex;
            }
        }
    }
}

// ─── Build text bitmap ───
const inkMap = new Uint8Array(W * H);    // REVEAL: under the mesh

// ── Measure text ──
const REVEAL_SIZE = 180;    // bumped from 160 for more presence at 512px
const revealText = 'REVEAL';
const revealBBox = font.getPath(revealText, 0, 0, REVEAL_SIZE).getBoundingBox();
const revealWidth = revealBBox.x2 - revealBBox.x1;
const revealHeight = revealBBox.y2 - revealBBox.y1;

// Center REVEAL in canvas
const revealX = Math.round((W - revealWidth) / 2) - Math.round(revealBBox.x1);
const revealBaselineY = Math.round((H - revealHeight) / 2) - Math.round(revealBBox.y1);

console.log(`REVEAL: ${revealWidth.toFixed(0)}x${revealHeight.toFixed(0)}px at (${revealX}, ${revealBaselineY})`);

// ── Rasterize REVEAL ──
console.log('Rasterizing REVEAL...');
const revealGlyphs = font.stringToGlyphs(revealText);
let cursorX = revealX;
for (let i = 0; i < revealGlyphs.length; i++) {
    const glyph = revealGlyphs[i];
    const charPath = glyph.getPath(cursorX, revealBaselineY, REVEAL_SIZE);
    rasterizePath(inkMap, W, H, charPath, INK_COLOR);
    cursorX += (glyph.advanceWidth / font.unitsPerEm) * REVEAL_SIZE;
}

// ─── Precompute mesh grid ───
console.log('Computing mesh...');
const meshGrid = new Uint8Array(W * H);
const cosA = Math.cos(MESH_ANGLE), sinA = Math.sin(MESH_ANGLE);

for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const d1 = Math.abs((-sinA * x + cosA * y) % MESH_SPACING);
        const dist1 = Math.min(d1, MESH_SPACING - d1);
        const d2 = Math.abs((cosA * x + sinA * y) % MESH_SPACING);
        const dist2 = Math.min(d2, MESH_SPACING - d2);

        let idx = 0;
        if (dist1 < MESH_LINE_W * 0.4 || dist2 < MESH_LINE_W * 0.4) {
            idx = 3;
        } else if (dist1 < MESH_LINE_W * 0.7 || dist2 < MESH_LINE_W * 0.7) {
            idx = 2;
        } else if (dist1 < MESH_LINE_W * 1.2 || dist2 < MESH_LINE_W * 1.2) {
            idx = 1;
        }
        meshGrid[y * W + x] = idx;
    }
}

// ─── Generate frames ───
const SQUEEGEE_H = 24;     // scaled from 48 at 1024
const buf = Buffer.alloc(W * H * FRAME_COUNT + 4096 * FRAME_COUNT);
const gw = new GifWriter(buf, W, H, {
    palette: PALETTE,
    loop: 0,
});

console.log(`Generating ${FRAME_COUNT} frames at ${W}x${H}...`);

const WIPE_START = Math.round(H * 0.05);
const WIPE_END   = Math.round(H * 0.85);
const WIPE_RANGE = WIPE_END - WIPE_START;

for (let f = 0; f < FRAME_COUNT; f++) {
    let squeegeeY;
    if (f < 2) {
        // 2 hold frames at start (200ms)
        squeegeeY = WIPE_START;
    } else if (f < 15) {
        // 13 wipe frames (1300ms)
        const t = (f - 2) / 13;
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) / 2;
        squeegeeY = WIPE_START + Math.round(eased * WIPE_RANGE);
    } else {
        // 1 final hold frame (200ms)
        squeegeeY = WIPE_END;
    }

    const frame = new Uint8Array(W * H);
    const isFinal = (f === FRAME_COUNT - 1);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const off = y * W + x;

            if (!isFinal && y >= squeegeeY && y < squeegeeY + SQUEEGEE_H && squeegeeY < WIPE_END) {
                // Squeegee blade (hidden on final frame)
                const bladePos = y - squeegeeY;
                frame[off] = (bladePos < 2 || bladePos >= SQUEEGEE_H - 2) ? 6 : 4;
            } else if (isFinal || y < squeegeeY) {
                // Wiped area — mesh on top, ink visible through openings
                if (meshGrid[off] > 0) {
                    frame[off] = meshGrid[off];
                } else if (inkMap[off] > 0) {
                    frame[off] = inkMap[off];
                } else {
                    frame[off] = 0;
                }
            } else {
                // Below squeegee — mesh only (no ink yet)
                frame[off] = meshGrid[off];
            }
        }
    }

    const delay = (f === FRAME_COUNT - 1) ? 50 : FRAME_DELAY;  // 500ms final hold
    gw.addFrame(0, 0, W, H, frame, { delay });
    process.stdout.write(`\r  Frame ${f + 1}/${FRAME_COUNT}`);
}

console.log('\nEncoding...');
const gifData = buf.slice(0, gw.end());
const outPath = path.join(__dirname, '..', 'src', 'squeegee.gif');
fs.writeFileSync(outPath, gifData);
console.log(`Done: ${outPath} (${(gifData.length / 1024).toFixed(0)} KB)`);
