/**
 * MechanicalFilters - Production Quality Control post-processing filters
 *
 * Pure functions operating on typed arrays — zero state dependencies.
 * These are "mechanical knobs" applied after separation to tune print quality.
 */

/**
 * shadowClamp: Enforce minimum ink density floor
 * Operates on per-color coverage, not individual pixels
 * Clamps thin/watery shadows to ensure printable density
 */
function applyShadowClamp(assignments, paletteSize, clampPercent) {
    if (clampPercent === 0) return assignments;

    const clampThreshold = clampPercent / 100;
    const colorCounts = new Array(paletteSize).fill(0);
    for (let i = 0; i < assignments.length; i++) {
        colorCounts[assignments[i]]++;
    }

    const totalPixels = assignments.length;
    const colorCoverages = colorCounts.map(count => count / totalPixels);

    const thinColors = new Set();
    const strongColors = [];
    colorCoverages.forEach((coverage, colorIdx) => {
        if (coverage > 0 && coverage < clampThreshold) {
            thinColors.add(colorIdx);
        } else if (coverage > 0) {
            strongColors.push(colorIdx);
        }
    });

    if (thinColors.size === 0) {
        return assignments;
    }

    if (strongColors.length === 0) {
        return assignments;
    }

    const result = new Uint8Array(assignments.length);
    for (let i = 0; i < assignments.length; i++) {
        const colorIdx = assignments[i];
        if (thinColors.has(colorIdx)) {
            result[i] = strongColors[0];
        } else {
            result[i] = colorIdx;
        }
    }

    return result;
}

/**
 * minVolume: Remove "ghost plates" with insufficient coverage
 * Remaps weak colors to nearest strong color in frozen palette
 */
function applyMinVolume(assignments, labPalette, minVolumePercent) {
    if (minVolumePercent === 0) return assignments;

    const paletteSize = labPalette.length;
    const totalPixels = assignments.length;
    const minPixels = Math.round(totalPixels * (minVolumePercent / 100));

    const colorCounts = new Array(paletteSize).fill(0);
    for (let i = 0; i < assignments.length; i++) {
        colorCounts[assignments[i]]++;
    }

    const weakColors = new Set();
    const strongColors = [];
    colorCounts.forEach((count, colorIdx) => {
        if (count > 0 && count < minPixels) {
            weakColors.add(colorIdx);
        } else if (count >= minPixels) {
            strongColors.push(colorIdx);
        }
    });

    if (weakColors.size === 0) {
        return assignments;
    }

    const remapTable = new Array(paletteSize);
    weakColors.forEach(weakIdx => {
        let nearestStrongIdx = strongColors[0];
        let minDistance = Infinity;

        const weakLab = labPalette[weakIdx];
        strongColors.forEach(strongIdx => {
            const strongLab = labPalette[strongIdx];
            const dL = weakLab.L - strongLab.L;
            const da = weakLab.a - strongLab.a;
            const db = weakLab.b - strongLab.b;
            const distance = Math.sqrt(dL*dL + da*da + db*db);

            if (distance < minDistance) {
                minDistance = distance;
                nearestStrongIdx = strongIdx;
            }
        });

        remapTable[weakIdx] = nearestStrongIdx;
    });

    const result = new Uint8Array(assignments);
    for (let i = 0; i < result.length; i++) {
        const colorIdx = result[i];
        if (weakColors.has(colorIdx)) {
            result[i] = remapTable[colorIdx];
        }
    }

    return result;
}

/**
 * speckleRescue: Remove isolated pixel clusters smaller than threshold
 * Morphological opening operation (erosion + dilation)
 */
function applySpeckleRescue(assignments, width, height, radiusPixels) {
    if (radiusPixels === 0) return assignments;

    const result = new Uint8Array(assignments);
    let removedCount = 0;

    for (let y = radiusPixels; y < height - radiusPixels; y++) {
        for (let x = radiusPixels; x < width - radiusPixels; x++) {
            const idx = y * width + x;
            const color = result[idx];

            let sameColorCount = 0;
            for (let dy = -radiusPixels; dy <= radiusPixels; dy++) {
                for (let dx = -radiusPixels; dx <= radiusPixels; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nIdx = (y + dy) * width + (x + dx);
                    if (result[nIdx] === color) {
                        sameColorCount++;
                    }
                }
            }

            const totalNeighbors = (radiusPixels * 2 + 1) * (radiusPixels * 2 + 1) - 1;
            if (sameColorCount < totalNeighbors * 0.3) {
                const neighborColors = new Map();
                for (let dy = -radiusPixels; dy <= radiusPixels; dy++) {
                    for (let dx = -radiusPixels; dx <= radiusPixels; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nIdx = (y + dy) * width + (x + dx);
                        const nColor = result[nIdx];
                        neighborColors.set(nColor, (neighborColors.get(nColor) || 0) + 1);
                    }
                }

                let maxCount = 0;
                let majorityColor = color;
                neighborColors.forEach((count, nColor) => {
                    if (count > maxCount) {
                        maxCount = count;
                        majorityColor = nColor;
                    }
                });

                if (majorityColor !== color) {
                    result[idx] = majorityColor;
                    removedCount++;
                }
            }
        }
    }

    return result;
}

module.exports = {
    applyShadowClamp,
    applyMinVolume,
    applySpeckleRescue
};
