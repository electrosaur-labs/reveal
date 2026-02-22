const logger = require("../utils/logger");

/**
 * HueGapRecovery - Hue sector analysis and gap recovery
 *
 * Extracted from PosterizationEngine.js. All methods are static.
 * Provides hue sector mapping, image/palette hue analysis,
 * gap identification, and missing hue recovery.
 */
class HueGapRecovery {

    /**
     * Map Lab a/b coordinates to one of 12 hue sectors (30 each):
     *  0: Red (0-30)       6: Blue (180-210)
     *  1: Orange (30-60)   7: B-Purple (210-240)
     *  2: Yellow (60-90)   8: Purple (240-270)
     *  3: Y-Green (90-120) 9: Magenta (270-300)
     *  4: Green (120-150)  10: Pink (300-330)
     *  5: Cyan (150-180)   11: R-Pink (330-360)
     *
     * @private
     * @param {number} a - Lab a* channel (-128 to +127)
     * @param {number} b - Lab b* channel (-128 to +127)
     * @returns {number} Sector index 0-11, or -1 if grayscale
     */
    static _getHueSector(a, b) {
        const CHROMA_THRESHOLD = 5; // Match existing analysis threshold
        const chroma = Math.sqrt(a * a + b * b);

        if (chroma <= CHROMA_THRESHOLD) {
            return -1; // Grayscale, no hue
        }

        let angle = Math.atan2(b, a) * (180 / Math.PI); // Radians to degrees
        if (angle < 0) angle += 360; // Normalize to 0-360°
        return Math.min(Math.floor(angle / 30), 11); // Divide into 12 sectors
    }

    /**
     * ARTIST-CENTRIC / HUE-AWARE MODEL: Analyze image hue distribution
     *
     * Divides color wheel into 12 sectors (30° each) and counts pixels in each.
     * Only counts pixels with chroma > 10 (excludes near-grays).
     *
     * @private
     * @param {Float32Array} labPixels - Flat array: [L, a, b, L, a, b, ...]
     * @param {number} [chromaThreshold=5] - Minimum chroma to count (lower for muted images)
     * @returns {Array<number>} - 12 element array with pixel counts per sector
     */
    static _analyzeImageHueSectors(labPixels, chromaThreshold = 5) {
        // MUTED IMAGE RESCUE: For archives with lowChromaDensity > 0.6, use threshold 1.0
        // to detect desaturated greens (chroma 2-4) that would otherwise be ignored
        const CHROMA_THRESHOLD = chromaThreshold;
        const hueCounts = new Array(12).fill(0);
        let chromaSum = 0;
        let chromaCount = 0;

        for (let i = 0; i < labPixels.length; i += 3) {
            const a = labPixels[i + 1];
            const b = labPixels[i + 2];
            const chroma = Math.sqrt(a * a + b * b);

            if (chroma > CHROMA_THRESHOLD) {
                chromaSum += chroma;
                chromaCount++;

                // Calculate hue angle: atan2(b, a) gives -180 to +180
                const hue = Math.atan2(b, a) * 180 / Math.PI;
                const hueNorm = hue < 0 ? hue + 360 : hue; // Normalize to 0-360
                const sectorIdx = Math.floor(hueNorm / 30); // 12 sectors of 30° each
                hueCounts[Math.min(sectorIdx, 11)]++; // Clamp to 0-11
            }
        }

        const avgChroma = chromaCount > 0 ? chromaSum / chromaCount : 0;

        // Normalize by chromatic pixel count, not total pixels.
        // Substrate (paper white) and achromatic pixels carry no hue information —
        // including them in the denominator suppresses minority hue sectors.
        const denominator = chromaCount > 0 ? chromaCount : 1;
        const huePercentages = hueCounts.map(count => (count / denominator) * 100);

        return huePercentages;
    }

    /**
     * ARTIST-CENTRIC / HUE-AWARE MODEL: Analyze palette hue coverage
     *
     * Checks which of the 12 hue sectors are represented in the palette.
     *
     * @private
     * @param {Array} palette - Array of Lab colors: [{L, a, b}, ...]
     * @param {number} [chromaThreshold=5] - Minimum chroma to count (lower for muted images)
     * @returns {Set<number>} - Set of sector indices (0-11) covered by palette
     */
    static _analyzePaletteHueCoverage(palette, chromaThreshold = 5) {
        const CHROMA_THRESHOLD = chromaThreshold; // Match image analysis threshold
        const coveredSectors = new Set();
        const colorCountsBySector = new Array(12).fill(0); // Count colors per sector
        const sectorNames = ['Red', 'Orange', 'Yellow', 'Y-Green', 'Green', 'Cyan',
                            'Blue', 'B-Purple', 'Purple', 'Magenta', 'Pink', 'R-Pink'];

        for (const color of palette) {
            const chroma = Math.sqrt(color.a * color.a + color.b * color.b);

            if (chroma > CHROMA_THRESHOLD) {
                const hue = Math.atan2(color.b, color.a) * 180 / Math.PI;
                const hueNorm = hue < 0 ? hue + 360 : hue;
                const sectorIdx = Math.floor(hueNorm / 30);
                const clampedIdx = Math.min(sectorIdx, 11);
                coveredSectors.add(clampedIdx);
                colorCountsBySector[clampedIdx]++;
            }
        }

        return { coveredSectors, colorCountsBySector };
    }

    /**
     * ARTIST-CENTRIC / HUE-AWARE MODEL: Identify hue gaps
     *
     * Finds hue sectors with significant image presence (>5%) but no palette representation.
     *
     * @private
     * @param {Array<number>} imageHues - Percentage of pixels in each sector
     * @param {Set<number>} paletteCoverage - Set of sectors covered by palette
     * @returns {Array<number>} - Array of gap sector indices
     */
    static _identifyHueGaps(imageHues, paletteCoverage, paletteColorCountsBySector = null) {
        const GAP_THRESHOLD = 1.0; // Sector must have >1% of chromatic pixels to be considered significant
        const HEAVY_SECTOR_THRESHOLD = 40.0; // If sector has >40% of chromatic pixels, needs multiple palette colors
        const gaps = [];
        const sectorNames = ['Red', 'Orange', 'Yellow', 'Y-Green', 'Green', 'Cyan',
                            'Blue', 'B-Purple', 'Purple', 'Magenta', 'Pink', 'R-Pink'];

        for (let i = 0; i < imageHues.length; i++) {
            // Check for complete gaps (sector present but not covered)
            if (imageHues[i] > GAP_THRESHOLD && !paletteCoverage.has(i)) {
                gaps.push(i);
            }
            // Check for heavy sectors that need multiple colors
            // If sector has >20% of image, it needs multiple shades even if one color exists
            else if (imageHues[i] > HEAVY_SECTOR_THRESHOLD && paletteCoverage.has(i)) {
                // Count how many palette colors are in this sector
                const colorsInSector = paletteColorCountsBySector ? paletteColorCountsBySector[i] : 1;
                if (colorsInSector < 2) {
                    gaps.push(i); // Add as gap to force second color
                }
            }
        }

        if (gaps.length > 0) {
            gaps.forEach(idx => {
                if (paletteCoverage.has(idx)) {
                    // Density gap
                } else {
                    // Complete gap
                }
            });
        } else {
        }

        return gaps;
    }

    /**
     * ARCHITECT'S IMPROVED HUE GAP REFINEMENT
     *
     * Scans the actual image for high-chroma colors in missing hue sectors
     * that are perceptually distinct from the current palette.
     *
     * This approach is superior to sampling from median cut's deduplicated colors
     * because it directly analyzes the image for vibrant, distinct hues.
     *
     * @private
     * @param {Float32Array} labPixels - Raw Lab pixel data
     * @param {Array} currentPalette - Current palette [{L, a, b}, ...]
     * @param {Array<number>} gaps - Missing hue sector indices
     * @param {Object} options - Tuning parameters
     * @param {number} options.chromaThreshold - Minimum chroma (default: 12)
     * @param {number} options.distinctnessThreshold - Minimum ΔE from palette (default: 15)
     * @returns {Array} - Distinct high-chroma colors for missing sectors
     */
    static _findTrueMissingHues(labPixels, currentPalette, gaps, options = {}) {
        // Configurable thresholds (lowered from 15/20 to 12/15 for better detection)
        const CHROMA_THRESHOLD = options.chromaThreshold ?? 12;
        const DISTINCTNESS_THRESHOLD = options.distinctnessThreshold ?? 15;

        // VIABILITY THRESHOLD: 0.25% minimum coverage
        // Don't add a diversity color if it only exists as speckles/noise.
        // A hue that covers <0.25% of the image is not worth burning a screen for.
        const MIN_HUE_COVERAGE = options.minHueCoverage ?? 0.01;
        const totalPixels = labPixels.length / 3;

        const sectorNames = ['Red', 'Orange', 'Yellow', 'Y-Green', 'Green', 'Cyan',
                            'Blue', 'B-Purple', 'Purple', 'Magenta', 'Pink', 'R-Pink'];

        const binSamples = new Array(12).fill(null);

        // Count chromatic pixels for viability normalization.
        // Substrate (paper white) and achromatic pixels carry no hue —
        // including them inflates the denominator and suppresses minority hues.
        let chromaticPixelCount = 0;
        for (let i = 0; i < labPixels.length; i += 3) {
            const a = labPixels[i + 1];
            const b = labPixels[i + 2];
            if (Math.sqrt(a * a + b * b) > CHROMA_THRESHOLD) chromaticPixelCount++;
        }
        const viabilityDenominator = chromaticPixelCount > 0 ? chromaticPixelCount : totalPixels;

        // Diagnostic counters per sector
        const diagnostics = gaps.map(gapIdx => ({
            sector: sectorNames[gapIdx],
            totalScanned: 0,
            highChroma: 0,
            failedDistinctness: 0,
            candidates: []
        }));
        const diagMap = new Map(gaps.map((gapIdx, i) => [gapIdx, diagnostics[i]]));


        // Scan image for high-chroma colors in missing sectors
        for (let i = 0; i < labPixels.length; i += 3) {
            const L = labPixels[i];
            const a = labPixels[i + 1];
            const b = labPixels[i + 2];
            const chroma = Math.sqrt(a * a + b * b);

            const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
            const binIdx = Math.floor(hue / 30);

            // Only consider missing sectors
            if (!gaps.includes(binIdx)) continue;

            const diag = diagMap.get(binIdx);
            diag.totalScanned++;

            if (chroma < CHROMA_THRESHOLD) continue; // Ignore neutral/muddy colors

            diag.highChroma++;

            // If this bin already has a sample, only replace if this one is more saturated
            if (binSamples[binIdx] && binSamples[binIdx].chroma >= chroma) continue;

            // Check if this color is distinct from current palette
            let minDistanceFromPalette = Infinity;
            for (const p of currentPalette) {
                const dL = L - p.L;
                const da = a - p.a;
                const db = b - p.b;
                const dist = Math.sqrt(dL * dL + da * da + db * db);
                minDistanceFromPalette = Math.min(minDistanceFromPalette, dist);
            }

            const isDistinct = minDistanceFromPalette > DISTINCTNESS_THRESHOLD;

            // Store candidate for diagnostics (top 3 per sector)
            if (diag.candidates.length < 3) {
                diag.candidates.push({
                    L: L.toFixed(1),
                    a: a.toFixed(1),
                    b: b.toFixed(1),
                    chroma: chroma.toFixed(1),
                    minΔE: minDistanceFromPalette.toFixed(1),
                    passed: isDistinct
                });
            }

            if (isDistinct) {
                binSamples[binIdx] = {L, a, b, chroma};
            } else {
                diag.failedDistinctness++;
            }
        }

        // Output diagnostic information for each missing sector
        for (const diag of diagnostics) {
            const found = binSamples[sectorNames.indexOf(diag.sector)] !== null;
            if (diag.candidates.length > 0) {
                for (const c of diag.candidates) {
                    const status = c.passed ? '\u2713' : '\u2717';
                }
            }
        }

        // Return only the vibrant, distinct missing hues (sorted by chroma)
        // VIABILITY CHECK: Only include if the sector has sufficient coverage
        const forcedColors = [];
        let skippedForViability = 0;

        for (const gapIdx of gaps) {
            if (binSamples[gapIdx] === null) continue;

            const sample = binSamples[gapIdx];
            const diag = diagMap.get(gapIdx);

            // Calculate coverage relative to chromatic pixels (not total).
            // Substrate and achromatic pixels don't carry hue information.
            const coverage = diag.totalScanned / viabilityDenominator;

            if (coverage < MIN_HUE_COVERAGE) {
                // This "gap" is just noise - not enough pixels to warrant a screen
                skippedForViability++;
                continue;
            }

            forcedColors.push({L: sample.L, a: sample.a, b: sample.b});
        }

        // Sort by chroma (most saturated first)
        forcedColors.sort((a, b) => {
            const chromaA = Math.sqrt(a.a * a.a + a.b * a.b);
            const chromaB = Math.sqrt(b.a * b.a + b.b * b.b);
            return chromaB - chromaA;
        });

        if (forcedColors.length === 0 && skippedForViability > 0) {
        } else if (forcedColors.length === 0) {
        }

        return forcedColors;
    }

    /**
     * DEPRECATED: Old hue gap filling (kept for reference)
     * @deprecated Use _findTrueMissingHues instead
     */
    static _forceIncludeHueGaps(colors, gaps, imageHues = null) {
        const CHROMA_THRESHOLD = 5; // Match image analysis threshold
        const HEAVY_SECTOR_THRESHOLD = 20.0; // If sector >20%, add TWO colors (light + dark)
        const forcedColors = [];
        const sectorNames = ['Red', 'Orange', 'Yellow', 'Y-Green', 'Green', 'Cyan',
                            'Blue', 'B-Purple', 'Purple', 'Magenta', 'Pink', 'R-Pink'];

        for (const sectorIdx of gaps) {
            // Find all colors in this sector
            const sectorColors = colors.filter(color => {
                const chroma = Math.sqrt(color.a * color.a + color.b * color.b);
                if (chroma <= CHROMA_THRESHOLD) return false;

                const hue = Math.atan2(color.b, color.a) * 180 / Math.PI;
                const hueNorm = hue < 0 ? hue + 360 : hue;
                const colorSector = Math.floor(hueNorm / 30);
                return Math.min(colorSector, 11) === sectorIdx;
            });

            if (sectorColors.length > 0) {
                const isHeavySector = imageHues && imageHues[sectorIdx] > HEAVY_SECTOR_THRESHOLD;

                if (isHeavySector && sectorColors.length > 1) {
                    // Heavy sector: Add TWO colors (light shade + dark shade)
                    // Sort by lightness
                    sectorColors.sort((a, b) => b.L - a.L);

                    // Pick lightest high-chroma color
                    const lightColors = sectorColors.slice(0, Math.ceil(sectorColors.length * 0.3));
                    let maxChromaLight = -1;
                    let bestLight = lightColors[0];
                    for (const color of lightColors) {
                        const chroma = Math.sqrt(color.a * color.a + color.b * color.b);
                        if (chroma > maxChromaLight) {
                            maxChromaLight = chroma;
                            bestLight = color;
                        }
                    }

                    // Pick darkest high-chroma color
                    const darkColors = sectorColors.slice(Math.floor(sectorColors.length * 0.7));
                    let maxChromaDark = -1;
                    let bestDark = darkColors[0];
                    for (const color of darkColors) {
                        const chroma = Math.sqrt(color.a * color.a + color.b * color.b);
                        if (chroma > maxChromaDark) {
                            maxChromaDark = chroma;
                            bestDark = color;
                        }
                    }

                    forcedColors.push({ L: bestLight.L, a: bestLight.a, b: bestLight.b });
                    forcedColors.push({ L: bestDark.L, a: bestDark.a, b: bestDark.b });

                } else {
                    // Normal sector: Add ONE color
                    // STRATEGY: Pick color closest to sector CENTER with high chroma
                    // This ensures perceptual distinctness from adjacent sectors

                    const sectorCenterAngle = (sectorIdx * 30) + 15; // e.g., Purple sector 8 → 255°
                    let bestScore = -1;
                    let best = sectorColors[0];

                    for (const color of sectorColors) {
                        const chroma = Math.sqrt(color.a * color.a + color.b * color.b);
                        const hue = Math.atan2(color.b, color.a) * 180 / Math.PI;
                        const hueNorm = hue < 0 ? hue + 360 : hue;

                        // Angular distance from sector center (normalize to 0-15°)
                        let angleDist = Math.abs(hueNorm - sectorCenterAngle);
                        if (angleDist > 180) angleDist = 360 - angleDist; // Handle wraparound

                        // Score = chroma * (1 - distance_from_center)
                        // Favors high chroma colors near sector center
                        const centerBonus = 1.0 - (angleDist / 15.0);
                        const score = chroma * centerBonus;

                        if (score > bestScore) {
                            bestScore = score;
                            best = color;
                        }
                    }

                    const bestChroma = Math.sqrt(best.a * best.a + best.b * best.b);
                    const bestHue = Math.atan2(best.b, best.a) * 180 / Math.PI;
                    const bestHueNorm = bestHue < 0 ? bestHue + 360 : bestHue;

                    forcedColors.push({ L: best.L, a: best.a, b: best.b });
                }
            }
        }

        return forcedColors;
    }
}

module.exports = HueGapRecovery;
