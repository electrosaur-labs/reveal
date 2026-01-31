/**
 * HueAnalysis - Hue Sector Analysis and Gap Detection
 *
 * Implements the "Artist-Centric / Hue-Aware Model" for color quantization:
 * - Divides color wheel into 12 sectors (30° each)
 * - Analyzes image hue distribution
 * - Detects missing hue sectors in palette
 * - Forces vibrant accent colors into palette
 *
 * Extracted from PosterizationEngine for modularity.
 */

const logger = require("../utils/logger");
const { labDistance } = require('./ColorSpace');

/**
 * Sector names for the 12 hue sectors (30° each)
 */
const SECTOR_NAMES = ['Red', 'Orange', 'Yellow', 'Y-Green', 'Green', 'Cyan',
                      'Blue', 'B-Purple', 'Purple', 'Magenta', 'Pink', 'R-Pink'];

/**
 * Default chroma threshold for considering a color as chromatic (not grayscale)
 * For 16-bit archives, use 1.5 to capture muted greens (chroma 2-4)
 */
const DEFAULT_CHROMA_THRESHOLD = 5;

/**
 * Get appropriate chroma threshold based on DNA
 * 16-bit archives need lower threshold to detect muted colors
 *
 * @param {Object} [dna] - Image DNA with bitDepth
 * @returns {number} Chroma threshold (1.5 for 16-bit, 5.0 for 8-bit)
 */
function getChromaThreshold(dna) {
    if (dna && dna.bitDepth === 16) {
        return 1.5; // Archive mode: detect muted greens (chroma 2-4)
    }
    return DEFAULT_CHROMA_THRESHOLD;
}

/**
 * Get hue sector (0-11) from Lab a/b coordinates
 *
 * Sector mapping (30° each):
 *  0: Red (0-30°)      6: Blue (180-210°)
 *  1: Orange (30-60°)  7: B-Purple (210-240°)
 *  2: Yellow (60-90°)  8: Purple (240-270°)
 *  3: Y-Green (90-120°) 9: Magenta (270-300°)
 *  4: Green (120-150°) 10: Pink (300-330°)
 *  5: Cyan (150-180°)  11: R-Pink (330-360°)
 *
 * @param {number} a - Lab a* channel (-128 to +127)
 * @param {number} b - Lab b* channel (-128 to +127)
 * @param {number} [chromaThreshold=5] - Minimum chroma to consider chromatic
 * @returns {number} Sector index 0-11, or -1 if grayscale
 */
function getHueSector(a, b, chromaThreshold = DEFAULT_CHROMA_THRESHOLD) {
    const chroma = Math.sqrt(a * a + b * b);

    if (chroma <= chromaThreshold) {
        return -1; // Grayscale, no hue
    }

    let angle = Math.atan2(b, a) * (180 / Math.PI); // Radians to degrees
    if (angle < 0) angle += 360; // Normalize to 0-360°
    return Math.min(Math.floor(angle / 30), 11); // Divide into 12 sectors
}

/**
 * Analyze image hue distribution across 12 sectors
 *
 * Divides color wheel into 12 sectors (30° each) and counts pixels in each.
 * Only counts pixels with chroma > 5 (excludes near-grays).
 *
 * @param {Float32Array|Uint16Array} labPixels - Flat array: [L, a, b, L, a, b, ...]
 * @returns {Array<number>} - 12 element array with pixel PERCENTAGES per sector
 */
function analyzeImageHueSectors(labPixels) {
    const hueCounts = new Array(12).fill(0);
    const totalPixels = labPixels.length / 3;
    let chromaSum = 0;
    let chromaCount = 0;

    for (let i = 0; i < labPixels.length; i += 3) {
        const a = labPixels[i + 1];
        const b = labPixels[i + 2];
        const chroma = Math.sqrt(a * a + b * b);

        if (chroma > DEFAULT_CHROMA_THRESHOLD) {
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
    logger.log(`[Hue Analysis] Analyzing ${totalPixels} total pixels, ${chromaCount} with chroma > ${DEFAULT_CHROMA_THRESHOLD} (avg chroma: ${avgChroma.toFixed(1)})`);

    // Convert counts to percentages
    const huePercentages = hueCounts.map(count => (count / totalPixels) * 100);

    logger.log(`[Hue Analysis] Image hue distribution (12 sectors, chroma > ${DEFAULT_CHROMA_THRESHOLD}):`);
    huePercentages.forEach((pct, idx) => {
        if (pct > 0.5) {  // Show all sectors with >0.5% presence
            logger.log(`  ${SECTOR_NAMES[idx].padEnd(9)}: ${pct.toFixed(1)}%`);
        }
    });

    return huePercentages;
}

/**
 * Analyze palette hue coverage across 12 sectors
 *
 * Checks which of the 12 hue sectors are represented in the palette.
 *
 * @param {Array} palette - Array of Lab colors: [{L, a, b}, ...]
 * @returns {{coveredSectors: Set<number>, colorCountsBySector: Array<number>}}
 */
function analyzePaletteHueCoverage(palette) {
    const coveredSectors = new Set();
    const colorCountsBySector = new Array(12).fill(0); // Count colors per sector

    logger.log(`[Hue Analysis] Palette hue coverage:`);
    for (const color of palette) {
        const chroma = Math.sqrt(color.a * color.a + color.b * color.b);

        if (chroma > DEFAULT_CHROMA_THRESHOLD) {
            const hue = Math.atan2(color.b, color.a) * 180 / Math.PI;
            const hueNorm = hue < 0 ? hue + 360 : hue;
            const sectorIdx = Math.floor(hueNorm / 30);
            const clampedIdx = Math.min(sectorIdx, 11);
            coveredSectors.add(clampedIdx);
            colorCountsBySector[clampedIdx]++;
            logger.log(`  ${SECTOR_NAMES[clampedIdx].padEnd(9)} (${hueNorm.toFixed(1)}°): L=${color.L.toFixed(1)}, a=${color.a.toFixed(1)}, b=${color.b.toFixed(1)}, C=${chroma.toFixed(1)}`);
        }
    }

    return { coveredSectors, colorCountsBySector };
}

/**
 * Identify hue gaps in the palette
 *
 * Finds hue sectors with significant image presence (>2%) but no palette representation.
 *
 * @param {Array<number>} imageHues - Percentage of pixels in each sector
 * @param {Set<number>} paletteCoverage - Set of sectors covered by palette
 * @param {Array<number>|null} paletteColorCountsBySector - Color counts per sector
 * @returns {Array<number>} - Array of gap sector indices
 */
function identifyHueGaps(imageHues, paletteCoverage, paletteColorCountsBySector = null) {
    const GAP_THRESHOLD = 2.0; // Sector must have >2% of image pixels to be considered significant
    const HEAVY_SECTOR_THRESHOLD = 20.0; // If sector has >20% of image, needs multiple palette colors

    const gaps = [];

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
                logger.log(`  ${SECTOR_NAMES[i]}: ${imageHues[i].toFixed(1)}% of image but only ${colorsInSector} palette color(s) → needs more shades`);
                gaps.push(i); // Add as gap to force second color
            }
        }
    }

    if (gaps.length > 0) {
        logger.log(`[Hue Analysis] ⚠️ Found ${gaps.length} hue gap(s):`);
        gaps.forEach(idx => {
            if (paletteCoverage.has(idx)) {
                // Density gap
                logger.log(`  ${SECTOR_NAMES[idx]}: ${imageHues[idx].toFixed(1)}% of image, under-represented in palette (density gap)`);
            } else {
                // Complete gap
                logger.log(`  ${SECTOR_NAMES[idx]}: ${imageHues[idx].toFixed(1)}% of image, 0 palette colors`);
            }
        });
    } else {
        logger.log(`[Hue Analysis] ✓ No hue gaps detected - palette covers all significant hue sectors`);
    }

    return gaps;
}

/**
 * Find true missing hue colors from image pixels
 *
 * Scans image for high-chroma colors in missing sectors that are distinct
 * from the existing palette. Applies viability threshold to filter out dust.
 *
 * @param {Float32Array|Uint16Array} labPixels - Flat array: [L, a, b, L, a, b, ...]
 * @param {Array} currentPalette - Existing palette colors [{L, a, b}, ...]
 * @param {Array<number>} gaps - Missing hue sector indices
 * @param {Object} options - Tuning parameters
 * @param {number} options.chromaThreshold - Minimum chroma (default: 12)
 * @param {number} options.distinctnessThreshold - Minimum ΔE from palette (default: 15)
 * @param {number} options.minHueCoverage - Minimum coverage (default: 0.0025 = 0.25%)
 * @returns {Array} - Distinct high-chroma colors for missing sectors
 */
function findTrueMissingHues(labPixels, currentPalette, gaps, options = {}) {
    logger.log(`🔍🔍🔍 DEBUG: findTrueMissingHues() called with ${gaps.length} gaps: ${gaps.map(g => SECTOR_NAMES[g]).join(', ')}`);

    // Configurable thresholds (lowered from 15/20 to 12/15 for better detection)
    const CHROMA_THRESH = options.chromaThreshold ?? 12;
    const DISTINCTNESS_THRESHOLD = options.distinctnessThreshold ?? 15;

    // VIABILITY THRESHOLD: 1.0% minimum coverage
    // Don't add a diversity color if it only exists as speckles/noise.
    // A hue that covers <1.0% of the image is not worth burning a screen for.
    const MIN_HUE_COVERAGE = options.minHueCoverage ?? 0.01;
    const totalPixels = labPixels.length / 3;

    const binSamples = new Array(12).fill(null);

    // Diagnostic counters per sector
    const diagnostics = gaps.map(gapIdx => ({
        sector: SECTOR_NAMES[gapIdx],
        totalScanned: 0,
        highChroma: 0,
        failedDistinctness: 0,
        candidates: []
    }));
    const diagMap = new Map(gaps.map((gapIdx, i) => [gapIdx, diagnostics[i]]));

    logger.log(`[Hue Gap Refinement] Scanning image for distinct colors in ${gaps.length} missing sector(s)...`);
    logger.log(`  Thresholds: Chroma ≥ ${CHROMA_THRESH}, ΔE ≥ ${DISTINCTNESS_THRESHOLD}`);

    // Track if we're using yellow-specific scoring
    let yellowScoringApplied = false;
    let yellowCandidatesFound = 0;
    let yellowComparisons = 0;

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

        if (chroma < CHROMA_THRESH) continue; // Ignore neutral/muddy colors

        diag.highChroma++;

        // DEBUG: Track yellow candidates
        const isYellow = binIdx === 2; // Sector 2 = Yellow (60-90°)
        if (isYellow) {
            yellowCandidatesFound++;
            if (yellowCandidatesFound <= 3) {
                logger.log(`[Yellow Debug] Candidate #${yellowCandidatesFound}: L=${L.toFixed(1)}, C=${chroma.toFixed(1)}, H=${hue.toFixed(1)}°, binSamples[2]=${binSamples[2] ? 'EXISTS' : 'EMPTY'}`);
            }
        }

        // If this bin already has a sample, decide whether to replace it
        // For Yellow sector (60-90°): use lightness+hue scoring instead of chroma
        if (binSamples[binIdx]) {
            if (isYellow) {
                yellowComparisons++;
                // YELLOW-SPECIFIC: Score by lightness + hue accuracy, not chroma
                yellowScoringApplied = true;
                const targetYellow = 90;
                const hueDistCurrent = Math.abs(hue - targetYellow);
                const hueDistExisting = Math.abs(binSamples[binIdx].hue - targetYellow);

                const scoreCurrent = L * 10 + (15 - hueDistCurrent) * 5 + chroma * 0.1;
                const scoreExisting = binSamples[binIdx].L * 10 + (15 - hueDistExisting) * 5 + binSamples[binIdx].chroma * 0.1;

                if (yellowComparisons <= 3) {
                    logger.log(`[Yellow Debug] Comparison #${yellowComparisons}:`);
                    logger.log(`  Current: L=${L.toFixed(1)}, H=${hue.toFixed(1)}°, Score=${scoreCurrent.toFixed(1)}`);
                    logger.log(`  Existing: L=${binSamples[binIdx].L.toFixed(1)}, H=${binSamples[binIdx].hue.toFixed(1)}°, Score=${scoreExisting.toFixed(1)}`);
                    logger.log(`  Decision: ${scoreExisting >= scoreCurrent ? 'KEEP existing' : 'REPLACE with current'}`);
                }

                if (scoreExisting >= scoreCurrent) continue; // Keep existing
            } else {
                // Non-yellow: Keep highest chroma (original behavior)
                if (binSamples[binIdx].chroma >= chroma) continue;
            }
        }

        // Check if this color is distinct from current palette
        let minDistanceFromPalette = Infinity;
        for (const p of currentPalette) {
            const dist = labDistance({L, a, b}, p);
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
            binSamples[binIdx] = {L, a, b, chroma, hue};
        } else {
            diag.failedDistinctness++;
        }
    }

    // Output diagnostic information for each missing sector
    logger.log(`[Yellow Debug Summary] Yellow candidates found: ${yellowCandidatesFound}, Comparisons: ${yellowComparisons}`);
    if (yellowScoringApplied) {
        logger.log(`[Yellow Scan Priority] ⭐ Applied lightness-first scoring during Yellow sector scan`);
    } else if (yellowCandidatesFound > 0) {
        logger.log(`[Yellow Scan Priority] ⚠️ Found ${yellowCandidatesFound} yellow candidates but no comparisons happened (only 1 made it to binSamples?)`);
    }
    logger.log(`[Hue Gap Diagnostics] Analysis complete:`);
    for (const diag of diagnostics) {
        const found = binSamples[SECTOR_NAMES.indexOf(diag.sector)] !== null;
        logger.log(`  ${diag.sector} (${diag.totalScanned} pixels scanned):`);
        logger.log(`    - High chroma (≥${CHROMA_THRESH}): ${diag.highChroma} pixels`);
        logger.log(`    - Failed distinctness (ΔE <${DISTINCTNESS_THRESHOLD}): ${diag.failedDistinctness} pixels`);
        if (diag.candidates.length > 0) {
            logger.log(`    - Sample candidates (top ${diag.candidates.length}):`);
            for (const c of diag.candidates) {
                const status = c.passed ? '✓' : '✗';
                logger.log(`      ${status} L=${c.L}, a=${c.a}, b=${c.b}, C=${c.chroma}, minΔE=${c.minΔE}`);
            }
        }
        logger.log(`    - Result: ${found ? '✓ Color found' : '✗ No suitable color'}`);
    }

    // Return only the vibrant, distinct missing hues (sorted by chroma)
    // VIABILITY CHECK: Only include if the sector has sufficient coverage
    const forcedColors = [];
    let skippedForViability = 0;

    for (const gapIdx of gaps) {
        if (binSamples[gapIdx] === null) continue;

        const sample = binSamples[gapIdx];
        const diag = diagMap.get(gapIdx);

        // Calculate coverage based on totalScanned pixels in this sector
        const coverage = diag.totalScanned / totalPixels;

        if (coverage < MIN_HUE_COVERAGE) {
            // This "gap" is just noise - not enough pixels to warrant a screen
            logger.log(`  🗑️ Skipping ${SECTOR_NAMES[gapIdx]} - below viability threshold (${diag.totalScanned} pixels, ${(coverage * 100).toFixed(3)}% < ${(MIN_HUE_COVERAGE * 100).toFixed(2)}%)`);
            skippedForViability++;
            continue;
        }

        // Calculate hue for diagnostic logging
        const hue = (Math.atan2(sample.b, sample.a) * 180 / Math.PI + 360) % 360;

        logger.log(`  ✓ Force-including ${SECTOR_NAMES[gapIdx]}: L=${sample.L.toFixed(1)}, a=${sample.a.toFixed(1)}, b=${sample.b.toFixed(1)}, C=${sample.chroma.toFixed(1)}, H=${hue.toFixed(1)}° (ΔE ≥ ${DISTINCTNESS_THRESHOLD}, coverage: ${(coverage * 100).toFixed(2)}%)`);
        forcedColors.push({L: sample.L, a: sample.a, b: sample.b});
    }

    // Sort by chroma (most saturated first)
    // EXCEPT for Yellow (sector 2): prioritize lightness and hue accuracy
    const yellowCandidates = [];

    forcedColors.sort((a, b) => {
        const chromaA = Math.sqrt(a.a * a.a + a.b * a.b);
        const chromaB = Math.sqrt(b.a * b.a + b.b * b.b);

        // Calculate hue angles
        const hueA = (Math.atan2(a.b, a.a) * 180 / Math.PI + 360) % 360;
        const hueB = (Math.atan2(b.b, b.a) * 180 / Math.PI + 360) % 360;

        // Detect Yellow sector (60-90°) - use special scoring
        const isYellowA = hueA >= 60 && hueA <= 90;
        const isYellowB = hueB >= 60 && hueB <= 90;

        if (isYellowA && isYellowB) {
            // YELLOW-SPECIFIC SCORING:
            // Yellow's identity is BRIGHTNESS (L) + HUE ACCURACY, not chroma
            // Target hue: 90° (pure yellow in Lab space)
            const targetYellow = 90;
            const hueDistA = Math.abs(hueA - targetYellow);
            const hueDistB = Math.abs(hueB - targetYellow);

            // Score = L * 10 + (15 - hueDist) * 5 + C * 0.1
            // This heavily weights lightness, then hue accuracy, with chroma as tiebreaker
            const scoreA = a.L * 10 + (15 - hueDistA) * 5 + chromaA * 0.1;
            const scoreB = b.L * 10 + (15 - hueDistB) * 5 + chromaB * 0.1;

            // Track for diagnostic logging (store both candidates)
            yellowCandidates.push({
                L: a.L.toFixed(1),
                h: hueA.toFixed(1),
                C: chromaA.toFixed(1),
                score: scoreA.toFixed(1)
            });
            yellowCandidates.push({
                L: b.L.toFixed(1),
                h: hueB.toFixed(1),
                C: chromaB.toFixed(1),
                score: scoreB.toFixed(1)
            });

            return scoreB - scoreA;  // Higher score wins
        } else if (isYellowA) {
            return -1;  // Yellow gets priority over non-yellows
        } else if (isYellowB) {
            return 1;
        } else {
            // Non-yellow colors: use chroma as before
            return chromaB - chromaA;
        }
    });

    // Log Yellow-specific scoring if we had yellow candidates
    if (yellowCandidates.length > 0) {
        logger.log(`[Yellow Priority] Applied lightness-first scoring for ${yellowCandidates.length} yellow candidate(s):`);
        // Remove duplicates and show unique candidates
        const unique = Array.from(new Map(yellowCandidates.map(c => [c.L + c.h, c])).values());
        unique.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
        for (const c of unique.slice(0, 3)) {
            logger.log(`  L=${c.L}, H=${c.h}°, C=${c.C} → Score: ${c.score}`);
        }
    }

    if (forcedColors.length === 0 && skippedForViability > 0) {
        logger.log(`  ⚠️ All ${skippedForViability} gap candidate(s) below viability threshold - not worth burning screens for dust`);
    } else if (forcedColors.length === 0) {
        logger.log(`  ⚠️ No distinct colors found - all candidates too similar to existing palette`);
    }

    return forcedColors;
}

/**
 * @deprecated Use findTrueMissingHues instead
 * Old hue gap filling (kept for reference/backwards compatibility)
 */
function forceIncludeHueGaps(colors, gaps, imageHues = null) {
    const HEAVY_SECTOR_THRESHOLD = 20.0; // If sector >20%, add TWO colors (light + dark)
    const forcedColors = [];

    for (const sectorIdx of gaps) {
        // Find all colors in this sector
        const sectorColors = colors.filter(color => {
            const chroma = Math.sqrt(color.a * color.a + color.b * color.b);
            if (chroma <= DEFAULT_CHROMA_THRESHOLD) return false;

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

                logger.log(`  ✓ Force-including ${SECTOR_NAMES[sectorIdx]} (LIGHT): L=${bestLight.L.toFixed(1)}, a=${bestLight.a.toFixed(1)}, b=${bestLight.b.toFixed(1)}, C=${maxChromaLight.toFixed(1)}`);
                logger.log(`  ✓ Force-including ${SECTOR_NAMES[sectorIdx]} (DARK): L=${bestDark.L.toFixed(1)}, a=${bestDark.a.toFixed(1)}, b=${bestDark.b.toFixed(1)}, C=${maxChromaDark.toFixed(1)}`);
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
                logger.log(`  ✓ Force-including ${SECTOR_NAMES[sectorIdx]}: L=${best.L.toFixed(1)}, a=${best.a.toFixed(1)}, b=${best.b.toFixed(1)}, C=${bestChroma.toFixed(1)}, H=${bestHueNorm.toFixed(1)}° (center: ${sectorCenterAngle}°)`);
            }
        }
    }

    return forcedColors;
}

module.exports = {
    SECTOR_NAMES,
    DEFAULT_CHROMA_THRESHOLD,
    CHROMA_THRESHOLD: DEFAULT_CHROMA_THRESHOLD,  // Backward compatibility alias
    getChromaThreshold,
    getHueSector,
    analyzeImageHueSectors,
    analyzePaletteHueCoverage,
    identifyHueGaps,
    findTrueMissingHues,
    forceIncludeHueGaps,  // Deprecated but kept for compatibility

    // Aliases for PosterizationEngine compatibility
    _getHueSector: getHueSector,
    _analyzeImageHueSectors: analyzeImageHueSectors,
    _analyzePaletteHueCoverage: analyzePaletteHueCoverage,
    _identifyHueGaps: identifyHueGaps,
    _findTrueMissingHues: findTrueMissingHues,
    _forceIncludeHueGaps: forceIncludeHueGaps
};
