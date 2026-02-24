/**
 * CentroidStrategies - Centroid Selection Methods for Median Cut
 *
 * STRATEGY PATTERN: Defines how representative colors are chosen from median cut buckets.
 * Each strategy balances different priorities (stability vs vibrancy).
 *
 * NOTE: Input data is ALWAYS in perceptual Lab space (L: 0-100, a/b: -128 to +127)
 * regardless of source bit depth. The engine normalizes all data before processing.
 * The bitDepth flag indicates SOURCE precision for threshold adjustments:
 * - 8-bit sources: Use wider thresholds to filter quantization noise
 * - 16-bit sources: Use tighter thresholds to preserve subtle signals
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
 * Critical for halftone-heavy images.
 *
 * 8-BIT PARITY FIXES:
 * - BROWN-DAMPENER: Penalizes low-chroma warm pixels (sectors 0,1) to prevent
 *   8-bit quantization noise from creating "Muddy Brown" centroids.
 * - ADAPTIVE NEUTRALITY: Wider neutral zone (chroma < 5.0) for 8-bit sources
 *   to catch grays with slight warm drift.
 *
 * 16-BIT PRECISION FIXES:
 * - Zero neutrality threshold: 16-bit data is SIGNAL, not noise.
 * - Tighter thresholds to preserve subtle chromatic differences.
 *
 * EXPONENTIAL VIBRANCY MODE:
 * - Applies chroma^(1/vibrancyBoost) to rescue low-chroma colors in muted images.
 * - Gives relatively higher weight to desaturated colors vs saturated ones.
 *
 * AGGRESSIVE VIBRANCY MODE:
 * - Multiplies a* values by 1.6× during centroid averaging.
 * - Pushes pink (a=+30) toward red (a=+48) in the final centroid.
 * - Critical for Minkler-style graphics where reds get "bully-averaged" by pink pixels.
 *
 * @param {Array} bucket - Array of Lab colors with count: [{L, a, b, count}, ...]
 * @param {Object} weights - Strategy weights {lWeight, cWeight, blackBias, bitDepth, vibrancyMode, vibrancyBoost}
 * @returns {{L: number, a: number, b: number}} - Representative Lab color (perceptual space)
 */
function SALIENCY(bucket, weights) {
    // Data is ALWAYS in perceptual space (neutral a/b = 0)
    if (!bucket || bucket.length === 0) return { L: 50, a: 0, b: 0 };

    const blackBias = weights.blackBias || 5.0;  // Configurable black boost multiplier
    const is16Bit = weights.bitDepth === 16;
    const isEightBit = !is16Bit;
    const vibrancyMode = weights.vibrancyMode || 'aggressive';
    const vibrancyBoost = weights.vibrancyBoost || 2.2;
    const lWeight = weights.lWeight || 1.0;
    const cWeight = weights.cWeight || 1.0;

    // 🔧 ACHROMATIC EXCLUSION WALL (V1 LEGACY MODE)
    // Filter out near-neutral pixels (chroma < 15.0) from saliency consideration
    // This prevents halftone gray backgrounds from competing for color slots
    // Activated when cWeight is high (≥ 2.5), indicating precision color work
    const achromaticFloor = cWeight >= 2.5 ? 15.0 : 0.0;
    const eligibleBucket = achromaticFloor > 0
        ? bucket.filter(p => Math.sqrt(p.a * p.a + p.b * p.b) >= achromaticFloor)
        : bucket;

    // If all pixels filtered out (achromatic bucket), fall back to volumetric average
    if (eligibleBucket.length === 0) {
        let sumL = 0, sumA = 0, sumB = 0, totalWeight = 0;
        bucket.forEach(p => {
            const weight = p.count || 1;
            sumL += p.L * weight;
            sumA += p.a * weight;
            sumB += p.b * weight;
            totalWeight += weight;
        });
        return { L: sumL / totalWeight, a: sumA / totalWeight, b: sumB / totalWeight };
    }

    // Helper: Get hue sector (0-11) from Lab a/b coordinates
    // Sectors 0 (Red) and 1 (Orange) are the "warm/brown" sectors
    const getHueSector = (a, b) => {
        const hueAngle = Math.atan2(b, a) * (180 / Math.PI);
        const normalizedHue = (hueAngle + 360) % 360;
        return Math.floor(normalizedHue / 30);
    };

    const scored = eligibleBucket.map(p => {
        const chroma = Math.sqrt(p.a * p.a + p.b * p.b);
        const sector = getHueSector(p.a, p.b);

        // EXPONENTIAL VIBRANCY MODE: Transform chroma to give relatively higher
        // weight to low-chroma colors in muted images. This "rescues" subtle colors
        // that would otherwise be lost in the averaging.
        // chroma^(1/boost) where boost=2.2 gives:
        //   chroma=5  → 2.0  (40% of original)
        //   chroma=30 → 4.4  (15% of original)
        //   chroma=100→ 6.3  (6% of original)
        let chromaValue = chroma;
        if (vibrancyMode === 'exponential' && chroma > 0) {
            chromaValue = Math.pow(chroma, 1 / vibrancyBoost);
        }

        // BROWN-DAMPENER: If in warm sectors (0=Red, 1=Orange) but chroma is low (< 8),
        // it's likely 8-bit quantization noise drifting neutral grays toward brown.
        // Penalize the chroma weight to prevent these from stealing centroid attention.
        // Only active for 8-bit sources - 16-bit data is SIGNAL.
        const chromaWeight = (isEightBit && chroma < 8 && (sector === 0 || sector === 1))
            ? cWeight * 0.5  // Halve chroma weight for suspected brown noise
            : cWeight;

        // BLACK PROTECTION: If the pixel is very dark, give it a massive score
        // to ensure the centroid snaps to Black rather than Grey.
        // Inversely proportional to lightness: L=0 gets max boost, L=10 gets 0
        // Uses configurable blackBias multiplier for tuning intensity
        const blackBoost = p.L < 10 ? (10 - p.L) * blackBias : 0;

        // 🔧 CHROMA DOMINANCE (V1 LEGACY MODE)
        // When cWeight ≥ 2.5, make chroma the primary factor in saliency scoring
        // This ensures vibrant colors win over neutral tones regardless of volume
        return {
            p,
            score: (p.L * lWeight) + (chromaValue * chromaWeight) + blackBoost
        };
    }).sort((a, b) => b.score - a.score);

    // Adaptive top-slice: Tighter for vibrant graphics (2%) vs photos (5%)
    const slicePercent = weights.isVibrant ? 0.02 : 0.05;
    const sampleSize = Math.max(1, Math.min(50, Math.floor(scored.length * slicePercent)));
    let sumL = 0, sumA = 0, sumB = 0;

    // AGGRESSIVE VIBRANCY MODE: Boost a* values during averaging to rescue reds from pink dilution
    // Only applied when:
    // 1. vibrancyMode is 'aggressive'
    // 2. a* is positive (reds/pinks, not greens/cyans)
    // 3. a* is in the "pink zone" (< 50) where dilution typically occurs
    // This pushes pink centroids (a=+30) toward red (a=+48) without over-saturating already-red colors
    const isAggressive = vibrancyMode === 'aggressive';

    for (let i = 0; i < sampleSize; i++) {
        sumL += scored[i].p.L;
        const rawA = scored[i].p.a;
        // Only boost positive a* values in pink zone (a < 50) to push toward red
        // Don't boost already-saturated reds (a >= 50) or greens (a < 0)
        const shouldBoostA = isAggressive && rawA > 0 && rawA < 50;
        sumA += shouldBoostA ? rawA * 1.6 : rawA;
        sumB += scored[i].p.b;
    }

    let finalLab = { L: sumL / sampleSize, a: sumA / sampleSize, b: sumB / sampleSize };

    // ADAPTIVE NEUTRALITY GATE: If the resulting color is very low saturation,
    // force it to be a perfect neutral (a=0, b=0).
    // 8-bit sources use a wider threshold (5.0) to catch grays with warm drift.
    // 16-bit sources use threshold 0.0: 16-bit data is SIGNAL, not noise.
    // Patent Claim: "Zero-threshold bypass for 16-bit archival signals"
    const neutralityThreshold = isEightBit ? 5.0 : 0.0;
    const finalChroma = Math.sqrt(finalLab.a**2 + finalLab.b**2);
    if (finalChroma < neutralityThreshold) {
        finalLab.a = 0;
        finalLab.b = 0;
    }

    return finalLab;
}

/**
 * THE "ROBUST" STRATEGY (Population Mean + Black Protection)
 *
 * Designed for warm specialist archetypes where SALIENCY's top-5% slice
 * inflates centroids far beyond the actual color mass. Validated against
 * Photoshop's Indexed Color (adaptive median cut) on the horse image:
 *
 *   PS bright gold:  a*=2,  b*=80, C=80, H=88° (pure yellow axis)
 *   SALIENCY output: a*=50, b*=123, C=134, H=68° (orange, 1.7x C inflation)
 *
 * The top-5% slice selects the highest-chroma pixels in each bucket. Those
 * tend to be the most orange (high a*), not the most yellow (high b*, low a*).
 * The actual pixel population is much more yellow — a weighted average matches PS.
 *
 * Strategy: pixel-count-weighted average (like VOLUMETRIC) plus:
 * - CHROMA WINSORIZATION: Cap at P75 before averaging to tame gamut-clipped
 *   outliers (C≈135 → C≈80) while preserving hue angle.
 * - BLACK PROTECTION: Massive score boost for L<10 pixels ensures dark buckets
 *   snap to black rather than averaging into gray (from SALIENCY).
 * - ACHROMATIC EXCLUSION: Filters low-chroma pixels when cWeight >= 2.5
 *   to prevent neutral background leaking into chromatic centroids.
 * - NEUTRALITY GATE: Sub-threshold chroma snaps to perfect neutral (from SALIENCY).
 *
 * @param {Array} bucket - Array of Lab colors with count: [{L, a, b, count}, ...]
 * @param {Object} weights - Strategy weights {lWeight, cWeight, blackBias, bitDepth}
 * @returns {{L: number, a: number, b: number}} - Representative Lab color (perceptual space)
 */
function ROBUST_SALIENCY(bucket, weights) {
    if (!bucket || bucket.length === 0) return { L: 50, a: 0, b: 0 };

    const blackBias = weights.blackBias || 5.0;
    const is16Bit = weights.bitDepth === 16;
    const isEightBit = !is16Bit;
    const cWeight = weights.cWeight || 1.0;
    const vibrancyBoost = weights.vibrancyBoost || 1.0;

    // CHROMA WINSORIZATION: Cap extreme chroma at P90 while preserving hue angle.
    // Gamut-clipped pixels (b=128, C≈135) keep their hue direction but get
    // capped magnitude, preventing centroid chroma inflation.
    // P90 (not P75) to avoid over-muting warm tones — only clips true outliers.
    const chromas = bucket.map(p => Math.sqrt(p.a * p.a + p.b * p.b));
    const sortedChromas = [...chromas].sort((a, b) => a - b);
    const p90Idx = Math.min(sortedChromas.length - 1, Math.floor(sortedChromas.length * 0.90));
    const chromaCap = sortedChromas[p90Idx];

    const workingBucket = bucket.map((p, i) => {
        if (chromas[i] <= chromaCap || chromaCap === 0) return p;
        const scale = chromaCap / chromas[i];
        return { L: p.L, a: p.a * scale, b: p.b * scale, count: p.count };
    });

    // ACHROMATIC EXCLUSION WALL (same as SALIENCY)
    const achromaticFloor = cWeight >= 2.5 ? 15.0 : 0.0;
    let eligibleBucket = achromaticFloor > 0
        ? workingBucket.filter(p => Math.sqrt(p.a * p.a + p.b * p.b) >= achromaticFloor)
        : workingBucket;

    // If all pixels filtered out, fall back to full volumetric average
    if (eligibleBucket.length === 0) {
        let sumL = 0, sumA = 0, sumB = 0, totalWeight = 0;
        workingBucket.forEach(p => {
            const weight = p.count || 1;
            sumL += p.L * weight;
            sumA += p.a * weight;
            sumB += p.b * weight;
            totalWeight += weight;
        });
        return { L: sumL / totalWeight, a: sumA / totalWeight, b: sumB / totalWeight };
    }

    // GREEN EXCLUSION: When a bucket spans the green-yellow boundary (has both
    // a*<0 and a*>0 pixels with high b*), the green background drags the centroid
    // away from the true yellow/gold. Filter out negative-a* pixels so the centroid
    // reflects the warm (positive-a*) majority. This matches PS Indexed Color which
    // produces bright gold at a*≈7 rather than green-yellow at a*≈-26.
    // Only active when cWeight >= 2.5 (precision color work).
    if (cWeight >= 2.5) {
        const hasWarm = eligibleBucket.some(p => p.a > 0 && p.b > 30);
        const hasCool = eligibleBucket.some(p => p.a < -5 && p.b > 20);
        if (hasWarm && hasCool) {
            const warmOnly = eligibleBucket.filter(p => p.a >= 0);
            if (warmOnly.length > 0) {
                eligibleBucket = warmOnly;
            }
        }
    }

    // POPULATION-WEIGHTED AVERAGE with BLACK PROTECTION
    // Unlike SALIENCY's top-5% slice, we average ALL eligible pixels weighted by count.
    // This matches Photoshop's Indexed Color behavior for warm tones.
    // Black protection adds extra weight to very dark pixels (L<10) to ensure
    // dark buckets snap to black rather than averaging into gray.
    let sumL = 0, sumA = 0, sumB = 0, totalWeight = 0;

    for (let i = 0; i < eligibleBucket.length; i++) {
        const p = eligibleBucket[i];
        let weight = p.count || 1;

        // BLACK PROTECTION: Boost weight for very dark pixels
        // so dark buckets snap to Black instead of averaging to Gray.
        if (p.L < 10) {
            weight *= (1 + (10 - p.L) * blackBias);
        }

        sumL += p.L * weight;
        sumA += p.a * weight;
        sumB += p.b * weight;
        totalWeight += weight;
    }

    let finalLab = { L: sumL / totalWeight, a: sumA / totalWeight, b: sumB / totalWeight };

    // VIBRANCY CONTROL: Continuous chroma scaling around the population mean.
    //   vibrancyBoost < 1.0 → dampen chroma (chroma-conservative, prevents neon overshoot)
    //   vibrancyBoost = 1.0 → neutral (pure population mean)
    //   vibrancyBoost > 1.0 → boost toward P90 (recover vivid tones averaging suppresses)
    // Preserves hue angle. Boost capped at P90, dampen floors at vibrancyBoost × centroidC.
    if (vibrancyBoost !== 1.0) {
        const centroidC = Math.sqrt(finalLab.a ** 2 + finalLab.b ** 2);
        if (centroidC > 5.0) {
            let targetC;
            if (vibrancyBoost > 1.0) {
                // Boost: interpolate toward P90, capped at P90
                targetC = centroidC + (chromaCap - centroidC) * (vibrancyBoost - 1.0);
                targetC = Math.min(targetC, chromaCap);
            } else {
                // Dampen: scale chroma directly (0.8 → 80% of centroid chroma)
                targetC = centroidC * vibrancyBoost;
            }
            if (targetC !== centroidC) {
                const scale = targetC / centroidC;
                finalLab.a *= scale;
                finalLab.b *= scale;
            }
        }
    }

    // ADAPTIVE NEUTRALITY GATE (same as SALIENCY)
    const neutralityThreshold = isEightBit ? 5.0 : 0.0;
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
 * NOTE: Input data is ALWAYS in perceptual space (L: 0-100, a/b: -128 to +127)
 * regardless of source bit depth.
 *
 * @param {Array} bucket - Array of Lab colors with count: [{L, a, b, count}, ...]
 * @param {Object} weights - Strategy weights (unused but accepted for API consistency)
 * @returns {{L: number, a: number, b: number}} - Representative Lab color (perceptual space)
 */
function VOLUMETRIC(bucket, weights) {
    // Data is ALWAYS in perceptual space (neutral a/b = 0)
    // weights parameter is accepted for API consistency with SALIENCY
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
    ROBUST_SALIENCY,
    VOLUMETRIC
};

module.exports = {
    CentroidStrategies,
    SALIENCY,
    ROBUST_SALIENCY,
    VOLUMETRIC
};
