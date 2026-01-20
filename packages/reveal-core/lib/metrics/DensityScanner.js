/**
 * DensityScanner - Detects isolated pixel clusters below print density threshold
 *
 * Uses iterative stack-based flood fill with 8-way connectivity to identify
 * connected components in layer masks. Clusters smaller than the threshold
 * are considered unprintable ("density floor breaches").
 *
 * Industry standard: 4-pixel minimum for 230 mesh screens
 */

class DensityScanner {
    /**
     * Scan a layer mask for unprintable pixel clusters
     *
     * @param {Uint8Array} mask - Layer mask (0-255 values)
     * @param {number} width - Image width in pixels
     * @param {number} height - Image height in pixels
     * @param {number} threshold - Minimum connected component size (default: 4)
     * @returns {Object} { breachCount, breachVolume }
     */
    static scan(mask, width, height, threshold = 4) {
        const pixelCount = width * height;
        const visited = new Uint8Array(pixelCount);
        let breachCount = 0;
        let totalBreachPixels = 0;

        // Reusable stack for iterative flood fill (prevents stack overflow)
        const stack = new Uint32Array(pixelCount);

        for (let i = 0; i < pixelCount; i++) {
            // Skip empty pixels or already visited
            if (mask[i] === 0 || visited[i] === 1) continue;

            // Start new connected component with iterative flood fill
            let componentSize = 0;
            let stackPtr = 0;

            stack[stackPtr++] = i;
            visited[i] = 1;

            // Iterative flood fill using explicit stack
            while (stackPtr > 0) {
                const idx = stack[--stackPtr];
                componentSize++;

                const x = idx % width;
                const y = Math.floor(idx / width);

                // Check 8 neighbors (diagonal connectivity counts)
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;

                        const nx = x + dx;
                        const ny = y + dy;

                        // Bounds check
                        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                            const nIdx = ny * width + nx;

                            // Add unvisited neighbor to stack
                            if (mask[nIdx] > 0 && visited[nIdx] === 0) {
                                visited[nIdx] = 1;
                                stack[stackPtr++] = nIdx;
                            }
                        }
                    }
                }
            }

            // Check if component is below print density threshold
            if (componentSize < threshold) {
                breachCount++;
                totalBreachPixels += componentSize;
            }
        }

        return {
            breachCount: breachCount,
            breachVolume: totalBreachPixels
        };
    }
}

module.exports = DensityScanner;
