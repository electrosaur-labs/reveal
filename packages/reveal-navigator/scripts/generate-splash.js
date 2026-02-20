#!/usr/bin/env node
/**
 * Generate the silkscreen splash animated GIF.
 *
 * Scene: Looking down at a coarse silkscreen mesh (yellow, tilted 17°).
 * RE/VE/AL in bold multicolor ink sits on top of mesh, with a dark outline
 * for contrast. A yellow squeegee blade wipes from top to bottom,
 * uncovering the text+mesh composite.
 *
 * Output: src/squeegee.gif (512x512, ~36 frames)
 */
const fs = require('fs');
const path = require('path');
const { GifWriter } = require('omggif');

const W = 512, H = 512;
const FRAME_COUNT = 36;     // 4 hold + 26 wipe + 6 hold
const FRAME_DELAY = 10;     // centiseconds (100ms per frame)
const MESH_ANGLE = 17 * Math.PI / 180;
const MESH_SPACING = 28;    // coarse mesh
const MESH_LINE_W = 4.0;    // extra-thick thread width

// ─── Color Palette (GIF indexed) ───
// 16 colors as packed 0xRRGGBB integers (omggif format)
const PALETTE = [
    0x1e1e1e,   // 0: dark background
    0x453a18,   // 1: dark mesh shadow
    0x8a7a28,   // 2: medium mesh
    0xd0b030,   // 3: bright mesh line
    0x181818,   // 4: squeegee black
    0xe05040,   // 5: red (RE)
    0x4090e0,   // 6: blue (VE)
    0x40b868,   // 7: green (AL)
    0xffffff,   // 8: white (unused, pad)
    0x604818,   // 9: darker mesh
    0xb09828,   // 10: mid-bright mesh
    0x282828,   // 11: slightly lighter bg
    0xb04030,   // 12: dark red
    0x3070b0,   // 13: dark blue
    0x309050,   // 14: dark green
    0x303030,   // 15: squeegee edge (dark gray)
];

// ─── Bitmap font: 7x10 glyphs for R, E, V, A, L ───
const GLYPHS = {
    R: [
        '111110.',
        '1....11',
        '1....11',
        '1...11.',
        '111110.',
        '1..11..',
        '1...11.',
        '1....11',
        '1....11',
        '.......',
    ],
    E: [
        '1111111',
        '1......',
        '1......',
        '1......',
        '111111.',
        '1......',
        '1......',
        '1......',
        '1111111',
        '.......',
    ],
    V: [
        '1.....1',
        '1.....1',
        '.1...1.',
        '.1...1.',
        '..1.1..',
        '..1.1..',
        '...1...',
        '...1...',
        '...1...',
        '.......',
    ],
    A: [
        '..111..',
        '.1...1.',
        '1.....1',
        '1.....1',
        '1111111',
        '1.....1',
        '1.....1',
        '1.....1',
        '1.....1',
        '.......',
    ],
    L: [
        '1......',
        '1......',
        '1......',
        '1......',
        '1......',
        '1......',
        '1......',
        '1......',
        '1111111',
        '.......',
    ],
};

const GLYPH_W = 7, GLYPH_H = 10;
const SCALE = 10;  // Each glyph pixel = 10x10 output pixels
const CHAR_W = GLYPH_W * SCALE;  // 70px per character
const CHAR_H = GLYPH_H * SCALE;  // 100px per character
const LETTER_GAP = 18;            // gap between letters in a pair
const LINE_GAP = 24;              // gap between lines

// Bold/outline radii (output pixels)
const BOLD_RADIUS = 3;     // thicken strokes by 3px each side (10→16px)
const OUTLINE_RADIUS = 3;  // dark outline around bold text

// Layout: 3 lines centered in 512x512
const LINE_W = CHAR_W * 2 + LETTER_GAP;
const BLOCK_H = CHAR_H * 3 + LINE_GAP * 2;
const BASE_X = Math.round((W - LINE_W) / 2);
const BASE_Y = Math.round((H - BLOCK_H) / 2) - 15;

const LINES = [
    { chars: 'RE', color: 5 },
    { chars: 'VE', color: 6 },
    { chars: 'AL', color: 7 },
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

        let idx = 0; // background
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

for (let lineIdx = 0; lineIdx < LINES.length; lineIdx++) {
    const { chars, color } = LINES[lineIdx];
    const lineY = BASE_Y + lineIdx * (CHAR_H + LINE_GAP);

    for (let ci = 0; ci < chars.length; ci++) {
        const ch = chars[ci];
        const glyph = GLYPHS[ch];
        if (!glyph) continue;
        const charX = BASE_X + ci * (CHAR_W + LETTER_GAP);

        for (let gy = 0; gy < GLYPH_H; gy++) {
            const row = glyph[gy];
            for (let gx = 0; gx < GLYPH_W; gx++) {
                if (row[gx] !== '1') continue;
                for (let sy = 0; sy < SCALE; sy++) {
                    for (let sx = 0; sx < SCALE; sx++) {
                        const px = charX + gx * SCALE + sx;
                        const py = lineY + gy * SCALE + sy;
                        if (px >= 0 && px < W && py >= 0 && py < H) {
                            textMap[py * W + px] = color;
                        }
                    }
                }
            }
        }
    }
}

// ─── Bold pass: dilate text by BOLD_RADIUS pixels ───
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
                if (dx * dx + dy * dy > BR2) continue; // circular
                const nx = x + dx;
                if (nx < 0 || nx >= W) continue;
                if (textBold[ny * W + nx] === 0) {
                    textBold[ny * W + nx] = color;
                }
            }
        }
    }
}

// ─── Outline pass: dilate bold text by OUTLINE_RADIUS pixels ───
console.log('Applying outline...');
const outlineMap = new Uint8Array(W * H);
const OR2 = OUTLINE_RADIUS * OUTLINE_RADIUS;

for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        if (textBold[y * W + x] === 0) continue;
        for (let dy = -OUTLINE_RADIUS; dy <= OUTLINE_RADIUS; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= H) continue;
            for (let dx = -OUTLINE_RADIUS; dx <= OUTLINE_RADIUS; dx++) {
                if (dx * dx + dy * dy > OR2) continue;
                const nx = x + dx;
                if (nx < 0 || nx >= W) continue;
                const off = ny * W + nx;
                if (textBold[off] === 0 && outlineMap[off] === 0) {
                    outlineMap[off] = 1;
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

const WIPE_START = Math.round(H * 0.08);   // start a little below the top
const WIPE_END   = Math.round(H * 0.90);   // end a little above the bottom
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
            if (y >= squeegeeY && y < squeegeeY + SQUEEGEE_H && squeegeeY < H) {
                // Squeegee blade
                frame[off] = 4;
            } else if (y < squeegeeY) {
                // Above squeegee: text (bold) > outline (dark) > mesh
                if (textBold[off]) {
                    frame[off] = textBold[off];
                } else if (outlineMap[off]) {
                    frame[off] = 0; // dark outline
                } else {
                    frame[off] = meshGrid[off]; // mesh visible through
                }
            } else {
                // Below squeegee: mesh only
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
