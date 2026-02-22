const LabDistance = require('../color/LabDistance');

class PixelAssignment {
    /**
     * Re-assign pixels to palette with a new stride (for preview quality changes).
     *
     * This is a lightweight method that only re-runs the pixel assignment loop
     * without regenerating the palette. Use this when changing preview quality
     * (Standard/Fine/Finest) after initial posterization.
     *
     * @param {Uint8ClampedArray|Uint16Array} labPixels - Lab pixel data (3 values per pixel: L, a, b)
     * @param {Array<{L: number, a: number, b: number}>} paletteLab - Palette colors in Lab (perceptual ranges)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} stride - Assignment stride (4=Standard, 2=Fine, 1=Finest)
     * @param {number} bitDepth - Original source bit depth (for logging only; data is always 16-bit)
     * @param {Object} options - Distance metric and weight options
     * @param {string} options.distanceMetric - Distance metric (cie76, cie94, cie2000, or squared)
     * @param {number} options.lWeight - Lightness weight for distance calculation
     * @param {number} options.cWeight - Chroma weight for distance calculation
     * @returns {Uint16Array} - Pixel-to-palette assignments
     */
    static reassignWithStride(labPixels, paletteLab, width, height, stride = 1, bitDepth = 16, options = {}) {
        const assignments = new Uint16Array(width * height);
        const paletteLen = paletteLab.length;

        // Extract distance options with defaults
        const distanceMetric = options.distanceMetric || 'squared';
        const lWeight = options.lWeight !== undefined ? options.lWeight : 1.0;
        const cWeight = options.cWeight !== undefined ? options.cWeight : 1.0;

        // 16-BIT INTEGER PRECISION FIX:
        // Pre-convert palette to 16-bit integer space ONCE to preserve precision.
        // Engine 16-bit encoding: L: 0-32768, a/b: 0-32768 (16384=neutral)
        // Perceptual Lab: L: 0-100, a/b: -128 to +127
        const palette16 = paletteLab.map(p => ({
            L: (p.L / 100) * 32768,
            a: (p.a + 128) * 128,  // Map -128..+127 to 0..32768
            b: (p.b + 128) * 128
        }));

        // Also keep Float32 Lab values for proper distance calculations
        const paletteFloat = paletteLab.map(p => ({
            L: p.L,
            a: p.a,
            b: p.b
        }));

        for (let y = 0; y < height; y += stride) {
            const rowOffset = y * width;

            for (let x = 0; x < width; x += stride) {
                const anchorI = rowOffset + x;
                const idx = anchorI * 3;

                // Read raw 16-bit values and convert to Float32 Lab for accurate distance
                const rawL = labPixels[idx];
                const rawA = labPixels[idx + 1];
                const rawB = labPixels[idx + 2];

                // Convert to perceptual Lab (Float32)
                const pixelLab = {
                    L: (rawL / 32768) * 100,
                    a: (rawA / 128) - 128,
                    b: (rawB / 128) - 128
                };

                // Find nearest palette color using proper distance metric and weights
                let minDist = Infinity, anchorAssignment = 0;
                for (let j = 0; j < paletteLen; j++) {
                    const target = paletteFloat[j];

                    let dist;
                    if (distanceMetric === 'cie76') {
                        dist = LabDistance.cie76SquaredInline(pixelLab.L, pixelLab.a, pixelLab.b, target.L, target.a, target.b);
                    } else if (distanceMetric === 'cie94') {
                        const C1 = Math.sqrt(pixelLab.a * pixelLab.a + pixelLab.b * pixelLab.b);
                        dist = LabDistance.cie94SquaredInline(pixelLab.L, pixelLab.a, pixelLab.b, target.L, target.a, target.b, C1);
                    } else if (distanceMetric === 'cie2000') {
                        dist = LabDistance.cie2000SquaredInline(pixelLab.L, pixelLab.a, pixelLab.b, target.L, target.a, target.b);
                    } else {
                        // Squared Euclidean with weights (default)
                        const dL = pixelLab.L - target.L;
                        const dA = pixelLab.a - target.a;
                        const dB = pixelLab.b - target.b;
                        const chromaDist = Math.sqrt(dA * dA + dB * dB);
                        dist = (lWeight * dL * dL) + (cWeight * chromaDist * chromaDist);
                    }

                    if (dist < minDist) { minDist = dist; anchorAssignment = j; }
                }

                // Stamp the stride×stride block
                for (let bY = 0; bY < stride && (y + bY) < height; bY++) {
                    const fillRow = (y + bY) * width;
                    for (let bX = 0; bX < stride && (x + bX) < width; bX++) {
                        assignments[fillRow + (x + bX)] = anchorAssignment;
                    }
                }
            }
        }

        return assignments;
    }
}

module.exports = PixelAssignment;
