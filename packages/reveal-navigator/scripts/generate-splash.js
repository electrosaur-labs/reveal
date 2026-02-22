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
const FRAME_COUNT = 31;     // 4 hold + 26 wipe + 1 long hold (2s reading pause)
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
    0xff2020,   //  5: R ink (bright red)
    0xff8800,   //  6: E ink (vivid orange)
    0xffdd00,   //  7: V ink (bright yellow)
    0x00cc44,   //  8: E ink (vivid green)
    0x00aaff,   //  9: A ink (bright cyan)
    0x4444ff,   // 10: L ink (vivid blue)
    0x183a14,   // 11: darker mesh
    0x2cb028,   // 12: mid-bright mesh
    0xffffff,   // 13: tagline text (white)
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

// ─── Small 5x7 font for tagline ───
const TAG_GLYPHS = {
    R: ['.111.','1...1','1...1','1111.','1.1..','1..1.','1...1'],
    E: ['11111','1....','1....','1111.','1....','1....','11111'],
    D: ['1111.','1...1','1...1','1...1','1...1','1...1','1111.'],
    U: ['1...1','1...1','1...1','1...1','1...1','1...1','.111.'],
    C: ['.1111','1....','1....','1....','1....','1....','.1111'],
    T: ['11111','..1..','..1..','..1..','..1..','..1..','..1..'],
    I: ['111','010','010','010','010','010','111'],
    O: ['.111.','1...1','1...1','1...1','1...1','1...1','.111.'],
    N: ['1...1','11..1','11..1','1.1.1','1..11','1..11','1...1'],
    S: ['.1111','1....','1....','.111.','....1','....1','1111.'],
    V: ['1...1','1...1','1...1','.1.1.','.1.1.','..1..','..1..'],
    L: ['1....','1....','1....','1....','1....','1....','11111'],
    A: ['..1..','.1.1.','1...1','1...1','11111','1...1','1...1'],
};
const TAG_GW = 5, TAG_GH = 7;
const TAG_SCALE = 3;          // 15×21 per character
const TAG_CHAR_W = TAG_GW * TAG_SCALE;  // 15px
const TAG_CHAR_H = TAG_GH * TAG_SCALE;  // 21px
const TAG_LETTER_GAP = 3;    // between characters
const TAG_WORD_GAP = 12;     // between words
const TAG_BOLD_RADIUS = 1;   // subtle thickening
const TAG_COLOR = 13;        // light gray
const TAGLINE = 'REDUCTION IS REVELATION';

// Layout: main "REVEAL" centered, tagline below
const TEXT_W = 6 * CHAR_W + 5 * LETTER_GAP;  // 434
const TAG_GAP = 24;          // gap between REVEAL and tagline

// Measure tagline width
let taglineWidth = 0;
for (let i = 0; i < TAGLINE.length; i++) {
    if (TAGLINE[i] === ' ') { taglineWidth += TAG_WORD_GAP; continue; }
    const g = TAG_GLYPHS[TAGLINE[i]];
    if (!g) continue;
    if (i > 0 && TAGLINE[i - 1] !== ' ') taglineWidth += TAG_LETTER_GAP;
    taglineWidth += g[0].length * TAG_SCALE;
}

// Vertically center the combined block (REVEAL + gap + tagline)
const BLOCK_H = CHAR_H + TAG_GAP + TAG_CHAR_H;
const BASE_X = Math.round((W - TEXT_W) / 2);
const BASE_Y = Math.round((H - BLOCK_H) / 2);
const TAG_X = Math.round((W - taglineWidth) / 2);
const TAG_Y = BASE_Y + CHAR_H + TAG_GAP;

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

// ─── Render tagline: "REDUCTION IS REVELATION" ───
console.log('Rendering tagline...');
let cursorX = TAG_X;
for (let i = 0; i < TAGLINE.length; i++) {
    const ch = TAGLINE[i];
    if (ch === ' ') { cursorX += TAG_WORD_GAP; continue; }
    const glyph = TAG_GLYPHS[ch];
    if (!glyph) continue;
    if (i > 0 && TAGLINE[i - 1] !== ' ') cursorX += TAG_LETTER_GAP;
    const glyphW = glyph[0].length;
    for (let gy = 0; gy < TAG_GH; gy++) {
        const row = glyph[gy];
        for (let gx = 0; gx < glyphW; gx++) {
            if (row[gx] !== '1') continue;
            for (let sy = 0; sy < TAG_SCALE; sy++) {
                for (let sx = 0; sx < TAG_SCALE; sx++) {
                    const px = cursorX + gx * TAG_SCALE + sx;
                    const py = TAG_Y + gy * TAG_SCALE + sy;
                    if (px >= 0 && px < W && py >= 0 && py < H) {
                        textMap[py * W + px] = TAG_COLOR;
                    }
                }
            }
        }
    }
    cursorX += glyphW * TAG_SCALE;
}

// ─── Bold pass: dilate text by BOLD_RADIUS pixels (circular) ───
// Main text gets full BOLD_RADIUS, tagline gets TAG_BOLD_RADIUS
console.log('Applying bold...');
const textBold = new Uint8Array(W * H);
const BR2 = BOLD_RADIUS * BOLD_RADIUS;

const TBR2 = TAG_BOLD_RADIUS * TAG_BOLD_RADIUS;

for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const color = textMap[y * W + x];
        if (color === 0) continue;
        // Use smaller radius for tagline text
        const isTag = (color === TAG_COLOR);
        const rad = isTag ? TAG_BOLD_RADIUS : BOLD_RADIUS;
        const r2 = isTag ? TBR2 : BR2;
        for (let dy = -rad; dy <= rad; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= H) continue;
            for (let dx = -rad; dx <= rad; dx++) {
                if (dx * dx + dy * dy > r2) continue;
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
const WIPE_END   = Math.round(H * 0.78);
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
                // Above squeegee — ink on top of mesh
                if (textBold[off] > 0) {
                    frame[off] = textBold[off];       // ink on top
                } else if (meshGrid[off] > 0) {
                    frame[off] = meshGrid[off];       // mesh visible where no ink
                } else {
                    frame[off] = 0;                   // dark background
                }
            } else {
                // Below squeegee — mesh only (no ink yet)
                frame[off] = meshGrid[off];
            }
        }
    }

    // Last frame gets a 2-second pause for reading
    const delay = (f === FRAME_COUNT - 1) ? 200 : FRAME_DELAY;
    gw.addFrame(0, 0, W, H, frame, { delay });
    process.stdout.write(`\r  Frame ${f + 1}/${FRAME_COUNT}`);
}

console.log('\nEncoding...');
const gifData = buf.slice(0, gw.end());
const outPath = path.join(__dirname, '..', 'src', 'squeegee.gif');
fs.writeFileSync(outPath, gifData);
console.log(`Done: ${outPath} (${(gifData.length / 1024).toFixed(0)} KB)`);
