/**
 * SeparationEngine - Core Unit Tests
 *
 * Tests for: input validation, synchronous mapping, layer mask generation,
 * despeckle, pruneWeakColors, separateImage, distance metric selection,
 * and hexToRgb. Complements separation-engine.test.js (dithering-focused).
 */

import { describe, it, expect } from 'vitest';

const SeparationEngine = require('../../lib/engines/SeparationEngine');
const { perceptualToEngine16 } = require('../../lib/color/LabEncoding');

// --- Helpers ---

/** Convert perceptual Lab to 16-bit engine encoding */
const labTo16bit = (L, a, b) => {
    const e = perceptualToEngine16(L, a, b);
    return { L: e.L16, a: e.a16, b: e.b16 };
};

/** Build a Uint16Array of 16-bit Lab pixels from perceptual values */
const createLab16Pixels = (values) => {
    const buf = new Uint16Array(values.length * 3);
    for (let i = 0; i < values.length; i++) {
        const e = labTo16bit(values[i].L, values[i].a, values[i].b);
        buf[i * 3]     = e.L;
        buf[i * 3 + 1] = e.a;
        buf[i * 3 + 2] = e.b;
    }
    return buf;
};

/** Build a uniform-color image (all pixels identical) */
const uniformImage = (L, a, b, count) => {
    const values = [];
    for (let i = 0; i < count; i++) values.push({ L, a, b });
    return createLab16Pixels(values);
};

// Reusable palettes
const BW_PALETTE = [
    { L: 0, a: 0, b: 0 },   // black
    { L: 100, a: 0, b: 0 }  // white
];

const RGB_PALETTE = [
    { L: 53,  a: 80,  b: 67 },   // red
    { L: 88,  a: -86, b: 83 },   // green
    { L: 32,  a: 79,  b: -108 }  // blue
];

// ─────────────────────────────────────────────────
// Input Validation (mapPixelsToPaletteAsync)
// ─────────────────────────────────────────────────

describe('SeparationEngine - Input Validation', () => {
    it('rejects null rawBytes', async () => {
        await expect(
            SeparationEngine.mapPixelsToPaletteAsync(null, BW_PALETTE, null, 1, 1)
        ).rejects.toThrow('rawBytes must be a typed array');
    });

    it('rejects plain Array rawBytes', async () => {
        await expect(
            SeparationEngine.mapPixelsToPaletteAsync([1, 2, 3], BW_PALETTE, null, 1, 1)
        ).rejects.toThrow('rawBytes must be a typed array');
    });

    it('rejects rawBytes with fewer than 3 values', async () => {
        await expect(
            SeparationEngine.mapPixelsToPaletteAsync(new Uint16Array([1, 2]), BW_PALETTE, null, 1, 1)
        ).rejects.toThrow('at least one pixel');
    });

    it('rejects null palette', async () => {
        const px = uniformImage(50, 0, 0, 1);
        await expect(
            SeparationEngine.mapPixelsToPaletteAsync(px, null, null, 1, 1)
        ).rejects.toThrow('labPalette must be a non-empty array');
    });

    it('rejects empty palette', async () => {
        const px = uniformImage(50, 0, 0, 1);
        await expect(
            SeparationEngine.mapPixelsToPaletteAsync(px, [], null, 1, 1)
        ).rejects.toThrow('labPalette must be a non-empty array');
    });

    it('accepts Uint8Array rawBytes', async () => {
        const px = new Uint8Array([127, 128, 128]); // 1 pixel
        const result = await SeparationEngine.mapPixelsToPaletteAsync(px, BW_PALETTE, null, 1, 1);
        expect(result.length).toBe(1);
    });

    it('accepts Uint8ClampedArray rawBytes', async () => {
        const px = new Uint8ClampedArray([127, 128, 128]);
        const result = await SeparationEngine.mapPixelsToPaletteAsync(px, BW_PALETTE, null, 1, 1);
        expect(result.length).toBe(1);
    });
});

// ─────────────────────────────────────────────────
// mapPixelsToPalette (synchronous)
// ─────────────────────────────────────────────────

describe('SeparationEngine.mapPixelsToPalette (sync)', () => {
    it('maps each pixel to nearest palette color', () => {
        // dark pixel → black (index 0), bright pixel → white (index 1)
        const px = createLab16Pixels([
            { L: 10, a: 0, b: 0 },
            { L: 90, a: 0, b: 0 }
        ]);
        const indices = SeparationEngine.mapPixelsToPalette(px, BW_PALETTE, 2, 1);
        expect(indices[0]).toBe(0);
        expect(indices[1]).toBe(1);
    });

    it('returns Uint8Array of correct length', () => {
        const px = uniformImage(50, 0, 0, 25);
        const indices = SeparationEngine.mapPixelsToPalette(px, BW_PALETTE, 5, 5);
        expect(indices).toBeInstanceOf(Uint8Array);
        expect(indices.length).toBe(25);
    });

    it('spatial locality: adjacent identical pixels map to same index', () => {
        // 100 identical pixels — spatial locality shortcut should fire
        const px = uniformImage(20, 0, 0, 100);
        const indices = SeparationEngine.mapPixelsToPalette(px, BW_PALETTE, 10, 10);
        for (let i = 0; i < 100; i++) {
            expect(indices[i]).toBe(0); // all black
        }
    });

    it('works with CIE94 distance metric', () => {
        const px = createLab16Pixels([
            { L: 10, a: 0, b: 0 },
            { L: 90, a: 0, b: 0 }
        ]);
        const indices = SeparationEngine.mapPixelsToPalette(px, BW_PALETTE, 2, 1, {
            distanceMetric: 'cie94'
        });
        expect(indices[0]).toBe(0);
        expect(indices[1]).toBe(1);
    });

    it('maps chromatic pixels to nearest color in multi-color palette', () => {
        // Pure red pixel should map to red palette entry
        const px = createLab16Pixels([{ L: 53, a: 80, b: 67 }]);
        const indices = SeparationEngine.mapPixelsToPalette(px, RGB_PALETTE, 1, 1);
        expect(indices[0]).toBe(0); // red
    });
});

// ─────────────────────────────────────────────────
// _mapPixelsNearestNeighbor (async, CIE76 / CIE94 / CIE2000)
// ─────────────────────────────────────────────────

describe('SeparationEngine - Distance Metric Selection', () => {
    const px = createLab16Pixels([
        { L: 10, a: 0, b: 0 },
        { L: 90, a: 0, b: 0 }
    ]);

    it('CIE76 (default) maps dark→black, bright→white', async () => {
        const r = await SeparationEngine.mapPixelsToPaletteAsync(px, BW_PALETTE, null, 2, 1, {
            ditherType: 'none', distanceMetric: 'cie76'
        });
        expect(r[0]).toBe(0);
        expect(r[1]).toBe(1);
    });

    it('CIE94 maps dark→black, bright→white', async () => {
        const r = await SeparationEngine.mapPixelsToPaletteAsync(px, BW_PALETTE, null, 2, 1, {
            ditherType: 'none', distanceMetric: 'cie94'
        });
        expect(r[0]).toBe(0);
        expect(r[1]).toBe(1);
    });

    it('CIE2000 maps dark→black, bright→white', async () => {
        const r = await SeparationEngine.mapPixelsToPaletteAsync(px, BW_PALETTE, null, 2, 1, {
            ditherType: 'none', distanceMetric: 'cie2000'
        });
        expect(r[0]).toBe(0);
        expect(r[1]).toBe(1);
    });

    it('all three metrics agree on strongly separated colors', async () => {
        const testPx = createLab16Pixels([
            { L: 5, a: 0, b: 0 },
            { L: 50, a: 80, b: 67 },
            { L: 95, a: 0, b: 0 }
        ]);
        const palette = [
            { L: 0, a: 0, b: 0 },
            { L: 53, a: 80, b: 67 },
            { L: 100, a: 0, b: 0 }
        ];

        const r76 = await SeparationEngine.mapPixelsToPaletteAsync(testPx, palette, null, 3, 1, { distanceMetric: 'cie76' });
        const r94 = await SeparationEngine.mapPixelsToPaletteAsync(testPx, palette, null, 3, 1, { distanceMetric: 'cie94' });
        const r2k = await SeparationEngine.mapPixelsToPaletteAsync(testPx, palette, null, 3, 1, { distanceMetric: 'cie2000' });

        for (let i = 0; i < 3; i++) {
            expect(r76[i]).toBe(r94[i]);
            expect(r94[i]).toBe(r2k[i]);
        }
    });
});

// ─────────────────────────────────────────────────
// hexToRgb
// ─────────────────────────────────────────────────

describe('SeparationEngine.hexToRgb', () => {
    it('parses #RRGGBB format', () => {
        expect(SeparationEngine.hexToRgb('#FF0000')).toEqual({ r: 255, g: 0, b: 0 });
        expect(SeparationEngine.hexToRgb('#00FF00')).toEqual({ r: 0, g: 255, b: 0 });
        expect(SeparationEngine.hexToRgb('#0000FF')).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('parses RRGGBB without hash', () => {
        expect(SeparationEngine.hexToRgb('5E4A25')).toEqual({ r: 94, g: 74, b: 37 });
    });

    it('is case-insensitive', () => {
        expect(SeparationEngine.hexToRgb('#ff8800')).toEqual(SeparationEngine.hexToRgb('#FF8800'));
    });

    it('returns null for invalid input', () => {
        expect(SeparationEngine.hexToRgb('#GG0000')).toBeNull();
        expect(SeparationEngine.hexToRgb('')).toBeNull();
        expect(SeparationEngine.hexToRgb('#FFF')).toBeNull(); // 3-char shorthand not supported
    });
});

// ─────────────────────────────────────────────────
// generateLayerMask
// ─────────────────────────────────────────────────

describe('SeparationEngine.generateLayerMask', () => {
    it('produces 255 for matching pixels and 0 for others', () => {
        const indices = new Uint8Array([0, 1, 0, 1, 2, 0]);
        const mask = SeparationEngine.generateLayerMask(indices, 0, 3, 2);
        expect(mask.length).toBe(6);
        expect(mask[0]).toBe(255);
        expect(mask[1]).toBe(0);
        expect(mask[2]).toBe(255);
        expect(mask[3]).toBe(0);
        expect(mask[4]).toBe(0);
        expect(mask[5]).toBe(255);
    });

    it('returns all-zero mask for non-existent index', () => {
        const indices = new Uint8Array([0, 0, 0, 0]);
        const mask = SeparationEngine.generateLayerMask(indices, 5, 2, 2);
        expect(mask.every(v => v === 0)).toBe(true);
    });

    it('returns all-255 mask for sole index', () => {
        const indices = new Uint8Array([3, 3, 3, 3]);
        const mask = SeparationEngine.generateLayerMask(indices, 3, 2, 2);
        expect(mask.every(v => v === 255)).toBe(true);
    });
});

// ─────────────────────────────────────────────────
// _despeckleMask
// ─────────────────────────────────────────────────

describe('SeparationEngine._despeckleMask', () => {
    it('removes clusters smaller than threshold', () => {
        // 5x5 mask: single isolated pixel at (0,0), large block elsewhere
        const mask = new Uint8Array(25);
        mask[0] = 255; // isolated 1px cluster at (0,0)
        // 3x3 block at (2,2) → 9 pixels
        for (let y = 2; y <= 4; y++) {
            for (let x = 2; x <= 4; x++) {
                mask[y * 5 + x] = 255;
            }
        }

        const result = SeparationEngine._despeckleMask(mask, 5, 5, 5);
        expect(result.clustersRemoved).toBe(1);
        expect(result.pixelsRemoved).toBe(1);
        expect(mask[0]).toBe(0);          // isolated pixel removed
        expect(mask[2 * 5 + 2]).toBe(255); // large block preserved
    });

    it('preserves all clusters when all exceed threshold', () => {
        // 4x4 fully white mask → 1 cluster of 16 pixels
        const mask = new Uint8Array(16).fill(255);
        const result = SeparationEngine._despeckleMask(mask, 4, 4, 5);
        expect(result.clustersRemoved).toBe(0);
        expect(result.pixelsRemoved).toBe(0);
    });

    it('handles empty mask', () => {
        const mask = new Uint8Array(9);
        const result = SeparationEngine._despeckleMask(mask, 3, 3, 3);
        expect(result.clustersRemoved).toBe(0);
        expect(result.pixelsRemoved).toBe(0);
    });

    it('uses 8-connectivity (diagonal neighbors count)', () => {
        // 3x3 mask: 2 diagonally-adjacent pixels should be 1 cluster
        const mask = new Uint8Array(9);
        mask[0] = 255; // (0,0)
        mask[4] = 255; // (1,1) — diagonal neighbor of (0,0)
        const result = SeparationEngine._despeckleMask(mask, 3, 3, 3);
        // 2 pixels connected diagonally form 1 cluster of size 2 (< threshold 3)
        expect(result.clustersRemoved).toBe(1);
        expect(result.pixelsRemoved).toBe(2);
    });
});

// ─────────────────────────────────────────────────
// _despeckleMaskBySpan — the Rule-of-7 "mesh opening" test.
//
// Unlike _despeckleMask (area), this must catch elements that are too
// NARROW even when they have plenty of total pixel area — the exact
// failure mode area-based despeckle misses (a thin hairline/sliver).
// ─────────────────────────────────────────────────

describe('SeparationEngine._despeckleMaskBySpan', () => {
    it('keeps a compact block that meets the minimum span', () => {
        // 10x10 solid block — easily contains an inscribed 6px disk.
        const width = 12, height = 12;
        const mask = new Uint8Array(width * height);
        for (let y = 1; y <= 10; y++) {
            for (let x = 1; x <= 10; x++) mask[y * width + x] = 255;
        }

        const result = SeparationEngine._despeckleMaskBySpan(mask, width, height, 6);
        expect(result.clustersRemoved).toBe(0);
        expect(mask[5 * width + 5]).toBe(255);
    });

    it('removes a thin sliver that has MORE area than the required span^2 but is nowhere wide enough', () => {
        // A 2px-wide x 40px-long sliver: area = 80, which would SURVIVE an
        // area-based despeckle at threshold 6*6=36 (80 >= 36), but its width
        // (2px) is far below the required 6px span in its narrow dimension.
        const width = 45, height = 10;
        const mask = new Uint8Array(width * height);
        for (let x = 2; x < 42; x++) {
            mask[4 * width + x] = 255;
            mask[5 * width + x] = 255;
        }
        expect(mask.filter(v => v === 255).length).toBe(80); // sanity: area check would pass

        const result = SeparationEngine._despeckleMaskBySpan(mask, width, height, 6);
        expect(result.clustersRemoved).toBe(1);
        expect(result.pixelsRemoved).toBe(80);
        expect(mask.every(v => v === 0)).toBe(true);
    });

    it('keeps the compact blob and removes the thin sliver in the same mask', () => {
        const width = 50, height = 20;
        const mask = new Uint8Array(width * height);

        // Compact 8x8 blob (meets span 6) at top-left.
        for (let y = 1; y <= 8; y++) {
            for (let x = 1; x <= 8; x++) mask[y * width + x] = 255;
        }
        // Thin 1px-wide, 30px-long line (fails span 6) across the bottom.
        for (let x = 10; x < 40; x++) mask[15 * width + x] = 255;

        const result = SeparationEngine._despeckleMaskBySpan(mask, width, height, 6);
        expect(result.clustersRemoved).toBe(1);
        expect(result.pixelsRemoved).toBe(30);
        expect(mask[4 * width + 4]).toBe(255);   // compact blob survives
        expect(mask[15 * width + 25]).toBe(0);   // thin line removed
    });

    it('LINE rule: keeps a thin but clearly elongated stroke that fails the dot rule', () => {
        // requiredSpan=10 -> dot needs a 10px inscribed disk. A 6px-wide,
        // 60px-long straight stroke never fits one (max local width ~6px),
        // but it's unambiguously a continuous line, not an isolated speck.
        // Margined away from the canvas edge so the distance transform sees
        // real background on every side (a shape touching the array bounds
        // has no background pixel to measure against on that side, which
        // would artificially inflate its apparent width).
        const width = 80, height = 20;
        const mask = new Uint8Array(width * height);
        for (let y = 7; y < 13; y++) {
            for (let x = 10; x < 70; x++) mask[y * width + x] = 255;
        }

        const result = SeparationEngine._despeckleMaskBySpan(mask, width, height, 10);
        expect(result.clustersRemoved).toBe(0);
        expect(mask[9 * width + 40]).toBe(255);
    });

    it('LINE rule: still removes a thin blob of similar width that is NOT elongated', () => {
        // Same ~6px width as the surviving stroke above, but only 8px long —
        // short bounding-box diagonal means this reads as a blob, not a line,
        // so it must still be despeckled even though it "has some width."
        const width = 20, height = 20;
        const mask = new Uint8Array(width * height);
        for (let y = 5; y < 11; y++) {
            for (let x = 5; x < 13; x++) mask[y * width + x] = 255;
        }

        const result = SeparationEngine._despeckleMaskBySpan(mask, width, height, 10);
        expect(result.clustersRemoved).toBe(1);
        expect(mask[7 * width + 8]).toBe(0);
    });

    it('is a no-op when minSpanPx <= 1', () => {
        const mask = new Uint8Array(16);
        mask[0] = 255;
        const result = SeparationEngine._despeckleMaskBySpan(mask, 4, 4, 1);
        expect(result.clustersRemoved).toBe(0);
        expect(mask[0]).toBe(255);
    });

    it('handles an empty mask', () => {
        const mask = new Uint8Array(100);
        const result = SeparationEngine._despeckleMaskBySpan(mask, 10, 10, 6);
        expect(result.clustersRemoved).toBe(0);
        expect(result.pixelsRemoved).toBe(0);
    });

    it('keeps a square block that meets the span and removes a clearly-smaller one', () => {
        // Two separate square blocks: side S (must survive) and side S/2
        // (clearly too small in both dims — not a tight boundary case).
        const width = 40, height = 20;
        const S = 8;
        const mask = new Uint8Array(width * height);

        // Block A: S x S — must survive (inscribed disk of diameter S fits).
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) mask[y * width + x] = 255;
        // Block B: (S/2) x (S/2) — clearly too small, must be removed.
        for (let y = 0; y < S / 2; y++) for (let x = 20; x < 20 + S / 2; x++) mask[y * width + x] = 255;

        const result = SeparationEngine._despeckleMaskBySpan(mask, width, height, S);
        expect(result.clustersRemoved).toBe(1);
        expect(mask[3 * width + 3]).toBe(255);     // Block A survives
        expect(mask[1 * width + 21]).toBe(0);      // Block B removed
    });
});

// ─────────────────────────────────────────────────
// pruneWeakColors
// ─────────────────────────────────────────────────

describe('SeparationEngine.pruneWeakColors', () => {
    const palette5 = [
        { L: 0, a: 0, b: 0 },    // black  - 40%
        { L: 100, a: 0, b: 0 },  // white  - 30%
        { L: 50, a: 80, b: 67 }, // red    - 20%
        { L: 50, a: -60, b: 50 },// green  - 9%
        { L: 50, a: 0, b: -80 }, // blue   - 1%
    ];

    // 100 pixels: 40 black, 30 white, 20 red, 9 green, 1 blue
    const buildIndices = () => {
        const idx = new Uint8ClampedArray(100);
        let p = 0;
        for (let i = 0; i < 40; i++) idx[p++] = 0;
        for (let i = 0; i < 30; i++) idx[p++] = 1;
        for (let i = 0; i < 20; i++) idx[p++] = 2;
        for (let i = 0; i < 9; i++)  idx[p++] = 3;
        for (let i = 0; i < 1; i++)  idx[p++] = 4;
        return idx;
    };

    it('merges colors below minVolume threshold', () => {
        const result = SeparationEngine.pruneWeakColors(
            palette5, buildIndices(), 10, 10, 5 // 5% threshold → blue (1%) is weak
        );
        expect(result.mergedCount).toBe(1);
        expect(result.prunedPalette.length).toBe(4);
        // Blue (1%) should be merged into its nearest strong neighbor
        expect(result.details[0].weakIndex).toBe(4);
    });

    it('returns unchanged palette when no colors are weak', () => {
        const result = SeparationEngine.pruneWeakColors(
            palette5, buildIndices(), 10, 10, 0.5 // 0.5% threshold → all are strong
        );
        expect(result.mergedCount).toBe(0);
        expect(result.prunedPalette).toBe(palette5); // same reference
    });

    it('never prunes below 4 colors', () => {
        // Set threshold very high (50%) — would prune 3 of 5 colors → only 2 strong
        // Safety check should promote weak colors back to keep at least 4
        const result = SeparationEngine.pruneWeakColors(
            palette5, buildIndices(), 10, 10, 50 // 50% threshold
        );
        expect(result.prunedPalette.length).toBeGreaterThanOrEqual(4);
    });

    it('remapped indices use compact 0-based numbering', () => {
        const result = SeparationEngine.pruneWeakColors(
            palette5, buildIndices(), 10, 10, 5
        );
        const maxIdx = Math.max(...result.remappedIndices);
        expect(maxIdx).toBe(result.prunedPalette.length - 1);
    });

    it('handles maxColors cap by demoting excess strong colors', () => {
        const result = SeparationEngine.pruneWeakColors(
            palette5, buildIndices(), 10, 10, 0.5, { maxColors: 3 }
        );
        // maxColors=3 demotes 2 strong → weak, but MIN_COLORS=4 safety promotes 1 back
        expect(result.prunedPalette.length).toBeLessThanOrEqual(4);
        expect(result.mergedCount).toBeGreaterThan(0);
    });

    it('handles all-zero palette with no strong colors gracefully', () => {
        const emptyIndices = new Uint8ClampedArray(100); // all index 0
        const singlePalette = [{ L: 50, a: 0, b: 0 }];
        const result = SeparationEngine.pruneWeakColors(
            singlePalette, emptyIndices, 10, 10, 50
        );
        // Single color can't be pruned into nothing
        expect(result.prunedPalette.length).toBeGreaterThanOrEqual(1);
    });
});

// ─────────────────────────────────────────────────
// separateImage (full workflow)
// ─────────────────────────────────────────────────

describe('SeparationEngine.separateImage', () => {
    it('rejects missing labPalette', async () => {
        const px = uniformImage(50, 0, 0, 4);
        await expect(
            SeparationEngine.separateImage(px, 2, 2, ['#000'], null, null)
        ).rejects.toThrow('requires a valid Lab Palette');
    });

    it('produces layers with name, labColor, hex, mask, width, height', async () => {
        // 4 pixels: 2 black, 2 white
        const px = createLab16Pixels([
            { L: 5, a: 0, b: 0 },
            { L: 95, a: 0, b: 0 },
            { L: 5, a: 0, b: 0 },
            { L: 95, a: 0, b: 0 }
        ]);
        const layers = await SeparationEngine.separateImage(
            px, 2, 2, ['#000000', '#FFFFFF'], null, BW_PALETTE
        );
        expect(layers.length).toBe(2);
        for (const layer of layers) {
            expect(layer).toHaveProperty('name');
            expect(layer).toHaveProperty('labColor');
            expect(layer).toHaveProperty('hex');
            expect(layer).toHaveProperty('mask');
            expect(layer).toHaveProperty('width', 2);
            expect(layer).toHaveProperty('height', 2);
        }
    });

    it('skips layers with <0.1% coverage', async () => {
        // 1000 black pixels + 0 white → white layer should be skipped
        const px = uniformImage(5, 0, 0, 1000);
        const layers = await SeparationEngine.separateImage(
            px, 100, 10, ['#000000', '#FFFFFF'], null, BW_PALETTE
        );
        // Only black layer should be present
        expect(layers.length).toBe(1);
        expect(layers[0].hex).toBe('#000000');
    });

    it('calls onProgress callback', async () => {
        const px = uniformImage(50, 0, 0, 100);
        const calls = [];
        await SeparationEngine.separateImage(
            px, 10, 10, ['#000000', '#FFFFFF'], null, BW_PALETTE,
            { onProgress: (p) => calls.push(p) }
        );
        expect(calls.length).toBeGreaterThan(0);
    });

    it('applies shadowClamp option', async () => {
        // With dithering, some mask values might be non-255 non-0
        // Create a scenario where mask values exist between 0 and threshold
        // Using nearest-neighbor all mask values are 255 or 0, so shadowClamp is a no-op
        // Just verify it doesn't crash
        const px = createLab16Pixels([
            { L: 5, a: 0, b: 0 },
            { L: 95, a: 0, b: 0 }
        ]);
        const layers = await SeparationEngine.separateImage(
            px, 2, 1, ['#000000', '#FFFFFF'], null, BW_PALETTE,
            { shadowClamp: 10 }
        );
        expect(layers.length).toBeGreaterThan(0);
    });

    it('applies speckleRescue option', async () => {
        // Create image where despeckle would remove isolated pixels
        // 10x10 all black except 1 white pixel → white layer has 1px cluster
        const values = [];
        for (let i = 0; i < 100; i++) values.push({ L: 5, a: 0, b: 0 });
        values[50] = { L: 95, a: 0, b: 0 }; // single white pixel
        const px = createLab16Pixels(values);

        const layers = await SeparationEngine.separateImage(
            px, 10, 10, ['#000000', '#FFFFFF'], null, BW_PALETTE,
            { speckleRescue: 5 } // remove clusters < 5 pixels
        );
        // White layer's single pixel should be despeckled away → only black layer
        expect(layers.length).toBe(1);
        expect(layers[0].hex).toBe('#000000');
    });
});
