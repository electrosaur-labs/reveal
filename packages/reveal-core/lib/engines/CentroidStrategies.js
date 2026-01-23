/**
 * CentroidStrategies - Centroid Selection Methods for Median Cut
 *
 * STRATEGY PATTERN: Defines how representative colors are chosen from median cut buckets.
 * Each strategy balances different priorities (stability vs vibrancy).
 *
 * Extracted from PosterizationEngine for modularity.
 */

/**
 * THE "HANDMADE" STRATEGY (Saliency)
 *
 * Averages the top 5% of pixels by saliency to capture the 'soul' of the color.
 * Prevents stray outliers while maintaining vibrancy.
 *
 * BLACK PROTECTION: Adds massive boost for very dark pixels (L<10) to ensure
 * the centroid snaps to Black rather than averaging it into Grey.
 * Critical for halftone-heavy images like JethroAsMonroe.tif.
 *
 * 8-BIT PARITY FIXES:
 * - BROWN-DAMPENER: Penalizes low-chroma warm pixels (sectors 0,1) to prevent
 *   8-bit quantization noise from creating "Muddy Brown" centroids.
 * - ADAPTIVE NEUTRALITY: Wider neutral zone (chroma < 5.0) for 8-bit sources
 *   to catch grays with slight warm drift.
 *
 * @param {Array} bucket - Array of Lab colors with count: [{L, a, b, count}, ...]
 * @param {Object} weights - Strategy weights {lWeight, cWeight, blackBias, bitDepth}
 * @returns {{L: number, a: number, b: number}} - Representative Lab color
 */
function SALIENCY(bucket, weights) {
    if (!bucket || bucket.length === 0) return { L: 50, a: 0, b: 0 };

    const blackBias = weights.blackBias || 5.0;  // Configurable black boost multiplier
    const isEightBit = (weights.bitDepth || 8) <= 8;

    // Helper: Get hue sector (0-11) from Lab a/b coordinates
    // Sectors 0 (Red) and 1 (Orange) are the "warm/brown" sectors
    const getHueSector = (a, b) => {
        const hueAngle = Math.atan2(b, a) * (180 / Math.PI);
        const normalizedHue = (hueAngle + 360) % 360;
        return Math.floor(normalizedHue / 30);
    };

    const scored = bucket.map(p => {
        const chroma = Math.sqrt(p.a * p.a + p.b * p.b);
        const sector = getHueSector(p.a, p.b);

        // BROWN-DAMPENER: If in warm sectors (0=Red, 1=Orange) but chroma is low (< 8),
        // it's likely 8-bit quantization noise drifting neutral grays toward brown.
        // Penalize the chroma weight to prevent these from stealing centroid attention.
        // Only active for 8-bit sources.
        const chromaWeight = (isEightBit && chroma < 8 && (sector === 0 || sector === 1))
            ? weights.cWeight * 0.5  // Halve chroma weight for suspected brown noise
            : weights.cWeight;

        // BLACK PROTECTION: If the pixel is very dark, give it a massive score
        // to ensure the centroid snaps to Black rather than Grey.
        // Inversely proportional to lightness: L=0 gets max boost, L=10 gets 0
        // Uses configurable blackBias multiplier for tuning intensity
        const blackBoost = p.L < 10 ? (10 - p.L) * blackBias : 0;

        return {
            p,
            score: (p.L * weights.lWeight) + (chroma * chromaWeight) + blackBoost
        };
    }).sort((a, b) => b.score - a.score);

    const sampleSize = Math.max(1, Math.min(50, Math.floor(scored.length * 0.05)));
    let sumL = 0, sumA = 0, sumB = 0;

    for (let i = 0; i < sampleSize; i++) {
        sumL += scored[i].p.L;
        sumA += scored[i].p.a;
        sumB += scored[i].p.b;
    }

    let finalLab = { L: sumL / sampleSize, a: sumA / sampleSize, b: sumB / sampleSize };

    // ADAPTIVE NEUTRALITY GATE: If the resulting color is very low saturation,
    // force it to be a perfect neutral (a=0, b=0).
    // 8-bit sources use a wider threshold (5.0) to catch grays with warm drift.
    // 16-bit sources use the standard threshold (3.0).
    const neutralityThreshold = isEightBit ? 5.0 : 3.0;
    const finalChroma = Math.sqrt(finalLab.a**2 + finalLab.b**2);
    if (finalChroma < neutralityThreshold) {
        finalLab.a = 0;
        finalLab.b = 0;
    }

    return finalLab;
}

/**
 * THE "BALANCED" STRATEGY (Volumetric)
 *
 * Standard weighted average by pixel count.
 * Stable and representative, respects pixel frequency.
 *
 * @param {Array} bucket - Array of Lab colors with count: [{L, a, b, count}, ...]
 * @param {Object} weights - Strategy weights (unused but accepted for API consistency)
 * @returns {{L: number, a: number, b: number}} - Representative Lab color
 */
function VOLUMETRIC(bucket, weights) {
    // weights parameter is unused but accepted for API consistency with SALIENCY
    if (!bucket || bucket.length === 0) return { L: 50, a: 0, b: 0 };

    let totalWeight = 0, sumL = 0, sumA = 0, sumB = 0;
    bucket.forEach(p => {
        const weight = p.count || 1;
        sumL += p.L * weight;
        sumA += p.a * weight;
        sumB += p.b * weight;
        totalWeight += weight;
    });
    return { L: sumL / totalWeight, a: sumA / totalWeight, b: sumB / totalWeight };
}

/**
 * All available centroid strategies
 */
const CentroidStrategies = {
    SALIENCY,
    VOLUMETRIC
};

module.exports = {
    CentroidStrategies,
    SALIENCY,
    VOLUMETRIC
};
