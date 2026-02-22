#!/usr/bin/env node
/**
 * Generate the silkscreen splash animated GIF.
 *
 * Scene: Looking down at a fine silkscreen mesh (green, tilted 22.5°).
 * "REVEAL" in single-line multicolor ink (one color per letter) sits UNDER
 * the mesh — realistic screen printing where ink is pushed THROUGH the mesh
 * by the squeegee, visible through the mesh openings. A yellow squeegee
 * blade wipes from top to bottom, uncovering the ink+mesh composite.
 *
 * Compositing (above squeegee, already wiped):
 *   mesh thread present → mesh color (threads on top)
 *   else if text present → ink color (visible through opening)
 *   else → dark background
 *
 * Output: src/squeegee.gif (512x512, ~36 frames)
 */
const fs = require('fs');
const path = require('path');
const { GifWriter } = require('omggif');

const W = 512, H = 512;
const FRAME_COUNT = 36;     // 4 hold + 26 wipe + 6 hold
const FRAME_DELAY = 10;     // centiseconds (100ms per frame)
const MESH_ANGLE = Math.PI / 8;   // 22.5° — slightly steeper for visual interest
const MESH_SPACING = 14;    // fine mesh (high mesh count)
const MESH_LINE_W = 2.0;    // thin threads

// ─── Color Palette (GIF indexed, 16 entries) ───
const PALETTE = [
    0x1e1e1e,   //  0: dark background
    0x1a4a18,   //  1: dark mesh shadow (green)
    0x2a8a28,   //  2: medium mesh (green)
    0x38d030,   //  3: bright mesh line (green)
    0xd0c020,   //  4: squeegee yellow
    0xe05040,   //  5: R ink (red)
    0xe09030,   //  6: E ink (orange)
    0xe0d040,   //  7: V ink (warm yellow — distinct from squeegee)
    0x40b868,   //  8: E ink (green)
    0x4090e0,   //  9: A ink (cyan)
    0x6060d0,   // 10: L ink (blue/indigo)
    0x183a14,   // 11: darker mesh
    0x2cb028,   // 12: mid-bright mesh
    0x282828,   // 13: slightly lighter bg
    0x988818,   // 14: squeegee edge (dark yellow)
    0x000000,   // 15: pure black (pad)
];

// ─── Per-letter ink color indices ───
const LETTER_COLORS = {
    R: 5,   // red
    E1: 6,  // orange (first E)
    V: 7,   // warm yellow
    E2: 8,  // green (second E)
    A: 9,   // cyan
    L: 10,  // blue/indigo
};

// ─── Bitmap font: 8x11 glyphs — wider, chunkier letterforms ───
const GLYPHS = {
    R: [
        '111111..',
        '11...011',
        '11...011',
        '11..011.',
        '111111..',
        '11.11...',
        '11..11..',
        '11...11.',
        '11...011',
        '11....11',
        '........',
    ],
    E: [
        '11111111',
        '11......',
        '11......',
        '11......',
        '1111111.',
        '11......',
        '11......',
        '11......',
        '11......',
        '11111111',
        '........',
    ],
    V: [
        '11....11',
        '11....11',
        '011..11.',
        '011..11.',
        '.011.11.',
        '.01111..',
        '..0111..',
        '..0111..',
        '...11...',
        '...11...',
        '........',
    ],
    A: [
        '...11...',
        '..0111..',
        '..1..1..',
        '.11..11.',
        '.11..11.',
        '011..011',
        '11111111',
        '11....11',
        '11....11',
        '11....11',
        '........',
    ],
    L: [
        '11......',
        '11......',
        '11......',
        '11......',
        '11......',
        '11......',
        '11......',
        '11......',
        '11......',
        '11111111',
        '........',
    ],
};

const GLYPH_W = 8, GLYPH_H = 11;
const SCALE = 8;             // 64×88 per character
const CHAR_W = GLYPH_W * SCALE;   // 64px
const CHAR_H = GLYPH_H * SCALE;   // 88px
const LETTER_GAP = 10;       // between characters
const BOLD_RADIUS = 5;       // thicker dilation for impact

// Layout: 6 characters + 5 gaps, centered in 512
const TEXT_W = 6 * CHAR_W + 5 * LETTER_GAP;  // 434
const BASE_X = Math.round((W - TEXT_W) / 2);  // 39
const BASE_Y = Math.round((H - CHAR_H) / 2); // 212

// Word: each entry is { char, colorIndex }
const WORD = [
    { char: 'R', colorIndex: LETTER_COLORS.R },
    { char: 'E', colorIndex: LETTER_COLORS.E1 },
    { char: 'V', colorIndex: LETTER_COLORS.V },
    { char: 'E', colorIndex: LETTER_COLORS.E2 },
    { char: 'A', colorIndex: LETTER_COLORS.A },
    { char: 'L', colorIndex: LETTER_COLORS.L },
];

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

        let idx = 0; // background (opening)
        if (dist1 < MESH_LINE_W * 0.4 || dist2 < MESH_LINE_W * 0.4) {
            idx = 3;  // bright mesh line (core)
        } else if (dist1 < MESH_LINE_W * 0.7 || dist2 < MESH_LINE_W * 0.7) {
            idx = 2;  // medium mesh
        } else if (dist1 < MESH_LINE_W * 1.2 || dist2 < MESH_LINE_W * 1.2) {
            idx = 1;  // dark mesh shadow
        }
        meshGrid[y * W + x] = idx;
    }
}

// ─── Precompute text bitmap (thin, pre-bold) ───
console.log('Rendering text...');
const textMap = new Uint8Array(W * H);

for (let i = 0; i < WORD.length; i++) {
    const { char, colorIndex } = WORD[i];
    const glyph = GLYPHS[char];
    if (!glyph) continue;
    const charX = BASE_X + i * (CHAR_W + LETTER_GAP);

    for (let gy = 0; gy < GLYPH_H; gy++) {
        const row = glyph[gy];
        for (let gx = 0; gx < GLYPH_W; gx++) {
            if (row[gx] !== '1') continue;
            for (let sy = 0; sy < SCALE; sy++) {
                for (let sx = 0; sx < SCALE; sx++) {
                    const px = charX + gx * SCALE + sx;
                    const py = BASE_Y + gy * SCALE + sy;
                    if (px >= 0 && px < W && py >= 0 && py < H) {
                        textMap[py * W + px] = colorIndex;
                    }
                }
            }
        }
    }
}

// ─── Bold pass: dilate text by BOLD_RADIUS pixels (circular) ───
console.log('Applying bold...');
const textBold = new Uint8Array(W * H);
const BR2 = BOLD_RADIUS * BOLD_RADIUS;

for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const color = textMap[y * W + x];
        if (color === 0) continue;
        for (let dy = -BOLD_RADIUS; dy <= BOLD_RADIUS; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= H) continue;
            for (let dx = -BOLD_RADIUS; dx <= BOLD_RADIUS; dx++) {
                if (dx * dx + dy * dy > BR2) continue; // circular kernel
                const nx = x + dx;
                if (nx < 0 || nx >= W) continue;
                if (textBold[ny * W + nx] === 0) {
                    textBold[ny * W + nx] = color;
                }
            }
        }
    }
}

// ─── Generate frames ───
const SQUEEGEE_H = 48;
const buf = Buffer.alloc(W * H * FRAME_COUNT + 1024 * FRAME_COUNT);
const gw = new GifWriter(buf, W, H, {
    palette: PALETTE,
    loop: 0,
});

console.log(`Generating ${FRAME_COUNT} frames at ${W}x${H}...`);

const WIPE_START = Math.round(H * 0.08);
const WIPE_END   = Math.round(H * 0.90);
const WIPE_RANGE = WIPE_END - WIPE_START;

for (let f = 0; f < FRAME_COUNT; f++) {
    let squeegeeY;
    if (f < 4) {
        squeegeeY = WIPE_START;
    } else if (f < 30) {
        const t = (f - 4) / 26;
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) * (-2 * t + 2) / 2;
        squeegeeY = WIPE_START + Math.round(eased * WIPE_RANGE);
    } else {
        squeegeeY = WIPE_END;
    }

    const frame = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const off = y * W + x;
            if (y >= squeegeeY && y < squeegeeY + SQUEEGEE_H && squeegeeY < WIPE_END) {
                // Squeegee blade
                const bladePos = y - squeegeeY;
                frame[off] = (bladePos < 4 || bladePos >= SQUEEGEE_H - 4) ? 14 : 4;
            } else if (y < squeegeeY) {
                // Above squeegee — ink visible THROUGH mesh openings
                if (meshGrid[off] > 0) {
                    frame[off] = meshGrid[off];      // mesh thread on top
                } else if (textBold[off] > 0) {
                    frame[off] = textBold[off];       // ink visible through opening
                } else {
                    frame[off] = 0;                   // dark background
                }
            } else {
                // Below squeegee — mesh only (no ink yet)
                frame[off] = meshGrid[off];
            }
        }
    }

    gw.addFrame(0, 0, W, H, frame, { delay: FRAME_DELAY });
    process.stdout.write(`\r  Frame ${f + 1}/${FRAME_COUNT}`);
}

console.log('\nEncoding...');
const gifData = buf.slice(0, gw.end());
const outPath = path.join(__dirname, '..', 'src', 'squeegee.gif');
fs.writeFileSync(outPath, gifData);
console.log(`Done: ${outPath} (${(gifData.length / 1024).toFixed(0)} KB)`);
