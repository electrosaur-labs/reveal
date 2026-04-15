/**
 * StencilEngine - Deterministic 1D Luminance Quantization
 *
 * Special-purpose engine for Black/White and Grayscale modes.
 * Maps pixels strictly to the L* axis, bypassing 3D median-cut quantization.
 * Ensures mathematical parity with pyreveal StencilEngine.
 */

const LabEncoding = require('../color/LabEncoding');
const { L_SCALE } = LabEncoding;

class StencilEngine {
    /**
     * @param {Uint16Array} pixels - 16-bit Lab pixel data (3 ch, interleaved)
     * @param {number} width
     * @param {number} height
     * @param {number} targetColors
     * @param {Object} options
     * @returns {Object} Separation result
     */
    static posterize(pixels, width, height, targetColors, options = {}) {
        const startTime = Date.now();
        const colorMode = options.colorMode || 'grayscale';
        
        let paletteLab = [];
        if (colorMode === 'bw') {
            // Strict 2-color thresholding (Black/White)
            paletteLab = [
                { L: 0, a: 0, b: 0 },
                { L: 100, a: 0, b: 0 }
            ];
        } else {
            // Linear grayscale distribution
            const levels = Math.max(2, targetColors);
            for (let i = 0; i < levels; i++) {
                const L = (i / (levels - 1)) * 100;
                paletteLab.push({ L, a: 0, b: 0 });
            }
        }

        const nPixels = width * height;
        const assignments = new Uint8Array(nPixels);
        const paletteLength = paletteLab.length;
        const threshold = 16384; // 50% luminance in 16-bit space (0..32768)

        if (colorMode === 'bw') {
            for (let i = 0; i < nPixels; i++) {
                const L16 = pixels[i * 3];
                // Map to Black (idx 0) or White (idx 1)
                assignments[i] = L16 < threshold ? 0 : 1;
            }
        } else {
            // Linear quantization: spread 32768 across palette slots
            const step = 32768 / (paletteLength - 1);
            for (let i = 0; i < nPixels; i++) {
                const L16 = pixels[i * 3];
                // Round to nearest level
                const idx = Math.max(0, Math.min(paletteLength - 1, Math.round(L16 / step)));
                assignments[i] = idx;
            }
        }

        // Convert Lab to RGB for UI/Display
        // We defer requiring PosterizationEngine to avoid circular dependency
        const PosterizationEngine = require('./PosterizationEngine');
        const palette = paletteLab.map(c => PosterizationEngine.labToRgb(c));

        const duration = (Date.now() - startTime) / 1000;

        return {
            palette,
            paletteLab,
            assignments,
            labPixels: pixels,
            metadata: {
                engine: 'stencil',
                colorMode,
                targetColors,
                finalColors: paletteLength,
                duration: duration
            }
        };
    }
}

module.exports = StencilEngine;
