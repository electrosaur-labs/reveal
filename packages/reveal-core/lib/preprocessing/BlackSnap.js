/**
 * BlackSnap.js - Edge-aware near-black snap for line art (opt-in)
 *
 * For line-art / engraving-style content, thin dark strokes get diffused
 * across several near-black palette entries during quantization and then
 * fragmented by dithering + Rule-of-7 despeckle. Snapping near-black EDGE
 * pixels to pure black before quantization gives the hatching a single,
 * stable target color so it survives as one clean ink.
 *
 * Restricted to EDGES (not a global near-black snap): a flat dark fill
 * (a robe, a smoke cloud) has no strong local lightness jump at its
 * interior pixels, so those are left alone — only thin strokes and the
 * boundary of dark shapes qualify. A thin hatching line is all edge, so
 * the whole line snaps.
 *
 * Must run ONCE, on the full-resolution source, before both the proxy
 * preview and the production separation derive from it — applying it
 * independently in two places risks the exact kind of silent drift the
 * Rule-of-7 dpi mismatch caused (see MechanicalKnobs/MeshPhysics).
 *
 * @module reveal-core/preprocessing
 */

const { engine16ToPerceptual, LAB16_AB_NEUTRAL } = require('../color/LabEncoding');

const DEFAULT_L_MAX = 32;          // perceptual L* ceiling for "near black"
const DEFAULT_CHROMA_MAX = 11;     // perceptual chroma ceiling for "near black"
const DEFAULT_EDGE_DELTA_L = 25;   // perceptual delta-L threshold for "on an edge"
const DEFAULT_RADIUS_MM = 0.2;     // edge-detection neighborhood radius, physical units
const DEFAULT_DPI = 300;

// Pure black in engine 16-bit encoding (L16=0, a16/b16=neutral).
const BLACK_L16 = 0;
const BLACK_A16 = LAB16_AB_NEUTRAL;
const BLACK_B16 = LAB16_AB_NEUTRAL;

/**
 * Convert a physical radius (mm) to pixels at the given DPI — same
 * physical-unit convention as MeshPhysics, so this can't silently
 * disagree with document resolution the way a fixed-pixel constant would.
 *
 * @param {number} radiusMm
 * @param {number} dpi
 * @returns {number} Radius in pixels, >= 1
 */
function radiusPxFromMm(radiusMm, dpi) {
    const d = dpi > 0 ? dpi : DEFAULT_DPI;
    return Math.max(1, Math.round((radiusMm * d) / 25.4));
}

/**
 * Edge-aware near-black snap. Mutates `labData` in place (engine 16-bit
 * Lab: L 0-32768, a/b 0-32768, neutral=16384).
 *
 * @param {Uint16Array} labData
 * @param {number} width
 * @param {number} height
 * @param {Object} [options]
 * @param {number} [options.lMax=32] - Perceptual L* ceiling for "near black"
 * @param {number} [options.chromaMax=11] - Perceptual chroma ceiling for "near black"
 * @param {number} [options.edgeDeltaL=25] - Perceptual delta-L threshold for "on an edge"
 * @param {number} [options.radiusMm=0.2] - Edge-detection neighborhood radius, physical mm
 * @param {number} [options.dpi=300] - Document DPI, for converting radiusMm to pixels
 * @returns {{snappedPixels: number, snappedPercent: number, radiusPx: number}}
 */
function applyBlackSnap(labData, width, height, options = {}) {
    const lMax = options.lMax ?? DEFAULT_L_MAX;
    const chromaMax = options.chromaMax ?? DEFAULT_CHROMA_MAX;
    const edgeDeltaL = options.edgeDeltaL ?? DEFAULT_EDGE_DELTA_L;
    const radiusMm = options.radiusMm ?? DEFAULT_RADIUS_MM;
    const dpi = options.dpi ?? DEFAULT_DPI;
    const radiusPx = radiusPxFromMm(radiusMm, dpi);

    const pixelCount = width * height;
    const L = new Float32Array(pixelCount);
    const isNearBlack = new Uint8Array(pixelCount);

    for (let i = 0; i < pixelCount; i++) {
        const off = i * 3;
        const p = engine16ToPerceptual(labData[off], labData[off + 1], labData[off + 2]);
        L[i] = p.L;
        const chroma = Math.sqrt(p.a * p.a + p.b * p.b);
        if (p.L < lMax && chroma < chromaMax) isNearBlack[i] = 1;
    }

    // Separable max filter (dilation): max over a (2r+1)x(2r+1) neighborhood
    // via two 1D sliding-window maxima — O(width*height) regardless of
    // radius, not O(width*height*radius^2).
    const maxL = _maxFilterSeparable(L, width, height, radiusPx);

    let snappedPixels = 0;
    for (let i = 0; i < pixelCount; i++) {
        if (!isNearBlack[i]) continue;
        if (maxL[i] - L[i] > edgeDeltaL) {
            const off = i * 3;
            labData[off] = BLACK_L16;
            labData[off + 1] = BLACK_A16;
            labData[off + 2] = BLACK_B16;
            snappedPixels++;
        }
    }

    return {
        snappedPixels,
        snappedPercent: pixelCount > 0 ? (snappedPixels / pixelCount) * 100 : 0,
        radiusPx
    };
}

/**
 * 2D max filter via two 1D sliding-window maxima — dilation is separable:
 * max over a square neighborhood = (max over rows) then (max over columns).
 */
function _maxFilterSeparable(values, width, height, radius) {
    const temp = new Float32Array(width * height);
    const out = new Float32Array(width * height);

    for (let y = 0; y < height; y++) {
        _slidingMax1D(values, y * width, width, 1, radius, temp, y * width);
    }
    for (let x = 0; x < width; x++) {
        _slidingMax1D(temp, x, height, width, radius, out, x);
    }

    return out;
}

/**
 * Sliding-window maximum over `n` samples (stride `stride`, starting at
 * `srcOffset`), window radius `radius` (clamped at the array bounds),
 * written into `dst` at the same positions. Monotonic-deque algorithm —
 * O(n) regardless of radius.
 */
function _slidingMax1D(src, srcOffset, n, stride, radius, dst, dstOffset) {
    const deque = new Int32Array(n);
    let head = 0, tail = 0;

    for (let i = 0; i < n + radius; i++) {
        if (i < n) {
            const v = src[srcOffset + i * stride];
            while (tail > head && src[srcOffset + deque[tail - 1] * stride] <= v) tail--;
            deque[tail++] = i;
        }

        const center = i - radius;
        if (center >= 0 && center < n) {
            const windowStart = center - radius;
            while (deque[head] < windowStart) head++;
            dst[dstOffset + center * stride] = src[srcOffset + deque[head] * stride];
        }
    }
}

module.exports = {
    applyBlackSnap,
    radiusPxFromMm,
    DEFAULT_L_MAX,
    DEFAULT_CHROMA_MAX,
    DEFAULT_EDGE_DELTA_L,
    DEFAULT_RADIUS_MM,
    DEFAULT_DPI,
};
