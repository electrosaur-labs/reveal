/**
 * MedianFilter - Pre-posterization salt & pepper noise removal
 *
 * Unlike blur/bilateral filters (which average and create muddy transitions),
 * a median filter is a non-linear rank filter that replaces each pixel with
 * the median value of its neighborhood.
 *
 * WHY IT WORKS:
 * - White noise spikes are outliers
 * - Median filter "votes them out" of existence
 * - Replaces outliers with surrounding tone WITHOUT softening edges
 * - Prevents noise from becoming distinct palette colors
 *
 * USE CASES:
 * - Sensor noise in organic photos (almonds, skin tones)
 * - Film grain in archival scans
 * - JPEG compression artifacts
 *
 * DO NOT USE FOR:
 * - Intentional halftone patterns (would destroy them)
 * - Vector graphics (unnecessary)
 * - Already clean synthetic images
 */

class MedianFilter {
    /**
     * Apply 3×3 median filter to Lab pixel buffer
     *
     * Algorithm:
     * 1. For each pixel, collect 9 neighbors (3×3 window)
     * 2. Sort L, a, b channels independently
     * 3. Replace pixel with median (5th value after sort)
     * 4. Edge pixels use clamped coordinates (mirror boundary)
     *
     * @param {Uint16Array} labBuffer - 16-bit Lab planar buffer [L, a, b, L, a, b, ...]
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {Uint16Array} Filtered Lab buffer (new array)
     */
    static apply3x3(labBuffer, width, height) {
        const pixelCount = width * height;
        const filtered = new Uint16Array(labBuffer.length);

        // Process each pixel
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                const labIdx = idx * 3;

                // Collect 3×3 neighborhood values for each channel
                const neighborsL = [];
                const neighborsA = [];
                const neighborsB = [];

                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        // Clamp coordinates to image bounds (mirror boundary)
                        const nx = Math.max(0, Math.min(width - 1, x + dx));
                        const ny = Math.max(0, Math.min(height - 1, y + dy));
                        const nIdx = (ny * width + nx) * 3;

                        neighborsL.push(labBuffer[nIdx]);
                        neighborsA.push(labBuffer[nIdx + 1]);
                        neighborsB.push(labBuffer[nIdx + 2]);
                    }
                }

                // Sort and extract median (5th value in sorted 9-element array)
                neighborsL.sort((a, b) => a - b);
                neighborsA.sort((a, b) => a - b);
                neighborsB.sort((a, b) => a - b);

                filtered[labIdx] = neighborsL[4];     // Median L
                filtered[labIdx + 1] = neighborsA[4]; // Median a
                filtered[labIdx + 2] = neighborsB[4]; // Median b
            }
        }

        return filtered;
    }

    /**
     * Check if median pass is recommended based on image characteristics
     *
     * @param {Object} dna - DNA analysis result
     * @param {Object} config - Current configuration
     * @returns {boolean} Whether to apply median filter
     */
    static shouldApply(dna, config) {
        // Explicit override takes precedence
        if (config.medianPass !== undefined) {
            return config.medianPass;
        }

        // Auto-detection based on archetype
        const archetype = (config.id || '').toLowerCase();

        // NEVER apply to intentional halftones or graphics
        if (archetype.includes('jethro') ||
            archetype.includes('graphic') ||
            archetype.includes('neon') ||
            archetype.includes('vector') ||
            archetype.includes('commercial')) {
            return false;
        }

        // ALWAYS apply to organic/natural photos (sensor noise likely)
        if (archetype.includes('naturalist') ||
            archetype.includes('cinematic') ||
            archetype.includes('photo')) {
            return true;
        }

        // Default: OFF (safer to preserve intentional texture)
        return false;
    }
}

module.exports = MedianFilter;
