/**
 * LabMedianCut - Lab-space Median Cut Quantization
 *
 * Extracted from PosterizationEngine.js — the core Lab-space median cut
 * quantization algorithm with substrate culling, green rescue, and
 * hue-aware split priority.
 *
 * STATIC METHODS (no instance state):
 * - medianCutInLabSpace()      Core Lab quantization with substrate culling, green rescue
 * - _splitBoxLab()             Variance-weighted Lab box splitting
 * - _calculateBoxMetadata()    Box metadata with vibrancy/highlight boost
 * - _calculateSplitPriority()  Hue-aware priority multiplier
 * - _boxContainsHueSector()    Check box for specific hue sectors
 * - _analyzeColorSpace()       Grayscale detection via chroma range
 */

const logger = require("../utils/logger");
const { CentroidStrategies } = require('./CentroidStrategies');
const HueGapRecovery = require('./HueGapRecovery');
const PaletteOps = require('./PaletteOps');

/**
 * Safety-net fallback tuning — must mirror PosterizationEngine.TUNING.
 * Not imported directly to avoid circular dependency (PosterizationEngine → LabMedianCut).
 * In practice, callers always pass tuning explicitly; this only fires if tuning is null.
 * See PosterizationEngine.TUNING for rationale on each value.
 */
const DEFAULT_TUNING = {
    split: { highlightBoost: 2.2, vibrancyBoost: 1.6, minVariance: 10 },
    prune: { threshold: 9.0, hueLockAngle: 18, whitePoint: 85, shadowPoint: 15 },
    centroid: { lWeight: 1.1, cWeight: 2.0, blackBias: 5.0 }
};

class LabMedianCut {

    /**
     * Calculate metadata for a color box (mean Lab, hue sector, variance)
     *
     * Used by median cut to evaluate box importance and determine split priority.
     * Applies vibrancy and highlight boost to variance calculation.
     *
     * Variance calculation:
     * - Grayscale mode: Only L variance (ignores chroma)
     * - Color mode: Sum of L, a, b variances (full perceptual variance)
     *
     * @private
     * @param {Object} box - Box containing colors array: [{ L, a, b, count }, ...]
     * @param {boolean} grayscaleOnly - If true, ignore chroma channels
     * @returns {Object} { meanL, meanA, meanB, sector, variance }
     */
    static _calculateBoxMetadata(box, grayscaleOnly = false, vibrancyMode = 'aggressive', vibrancyMultiplier = 2.0, highlightThreshold = 92, highlightBoost = 3.0, tuning = null) {
        if (!box || !box.colors) {
            return { meanL: 0, meanA: 0, meanB: 0, sector: -1, variance: 0 };
        }
        const { colors } = box;

        if (colors.length === 0) {
            return { meanL: 0, meanA: 0, meanB: 0, sector: -1, variance: 0 };
        }

        // Use centralized tuning or fallback to defaults
        const config = tuning || DEFAULT_TUNING;

        // Calculate means
        const meanL = colors.reduce((sum, c) => sum + c.L, 0) / colors.length;
        const meanA = colors.reduce((sum, c) => sum + c.a, 0) / colors.length;
        const meanB = colors.reduce((sum, c) => sum + c.b, 0) / colors.length;

        // Calculate variance (sum of squared deviations)
        let varL = 0, varA = 0, varB = 0;
        let chromaSum = 0;
        for (const c of colors) {
            varL += (c.L - meanL) ** 2;
            if (!grayscaleOnly) {
                varA += (c.a - meanA) ** 2;
                varB += (c.b - meanB) ** 2;
                // Calculate average chroma for vibrancy boost
                const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
                chromaSum += chroma;
            }
        }

        // SALIENCY & HUE PRESERVATION MODEL
        // Multi-priority split logic: Both highlights AND vibrant accents get protection

        const avgChroma = grayscaleOnly ? 0 : chromaSum / colors.length;

        // FIXED VIBRANCY BOOST: Uses centralized tuning (default: 1.6×)
        // Weights chroma-rich pixels (greens, skin tones) without over-emphasizing
        const vibrancyBoost = avgChroma > 10 ? config.split.vibrancyBoost : 1.0;

        // BALANCED HIGHLIGHT PROTECTION: Uses centralized tuning (default: 2.2×)
        // Protects facial highlights without overwhelming vibrant features
        const highlightBoostValue = meanL > config.prune.whitePoint ? config.split.highlightBoost : 1.0;

        // CRITICAL: Use Math.max() so either feature can win independently
        // This prevents the highlight budget from consuming the vibrant accent slots
        const finalBoost = Math.max(vibrancyBoost, highlightBoostValue);

        // Log when highlight boost is active
        if (highlightBoostValue > 1.0 && highlightBoostValue >= vibrancyBoost) {
        }

        const baseVariance = grayscaleOnly ? varL : (varL + varA + varB);
        const variance = baseVariance * finalBoost;

        const sector = grayscaleOnly ? -1 : HueGapRecovery._getHueSector(meanA, meanB);

        return { meanL, meanA, meanB, sector, variance };
    }

    /**
     * GREEN PEEK: Check if a box contains any colors in specific hue sectors
     *
     * This is critical for detecting "hidden" green signals that get averaged
     * into blue-gray boxes. The box's MEAN might be neutral, but individual
     * colors could still be green foliage that needs isolation.
     *
     * Patent Claim: "Chromatic Inflation Factor" for hidden hue signals
     *
     * @private
     * @param {Array} colors - Box colors: [{L, a, b, count}, ...]
     * @param {Array<number>} targetSectors - Hue sectors to detect (e.g., [3, 4] for green)
     * @param {number} chromaThreshold - Minimum chroma to consider (default 2.0)
     * @returns {boolean} True if box contains any colors in target sectors
     */
    static _boxContainsHueSector(colors, targetSectors, chromaThreshold = 2.0) {
        // Sample up to 100 colors for efficiency
        const sampleSize = Math.min(colors.length, 100);
        const step = Math.max(1, Math.floor(colors.length / sampleSize));

        let greenCandidates = 0;
        let lowChromaSkips = 0;

        for (let i = 0; i < colors.length; i += step) {
            const c = colors[i];
            const chroma = Math.sqrt(c.a * c.a + c.b * c.b);

            // Skip near-neutral colors
            if (chroma < chromaThreshold) {
                lowChromaSkips++;
                continue;
            }

            // Calculate hue angle in degrees (0-360)
            const hue = Math.atan2(c.b, c.a) * 180 / Math.PI;
            const normHue = hue < 0 ? hue + 360 : hue;

            // Determine sector (12 sectors, 30° each)
            const sector = Math.floor(normHue / 30) % 12;

            // For green detection, also check for negative a* (the green axis)
            // Green colors have a < 0 in perceptual Lab space
            if (targetSectors.includes(sector)) {
                greenCandidates++;
                return true;
            }

            // ADDITIONAL CHECK: Any color with negative a* and positive b* is green-ish
            // This catches greens that might be classified in adjacent sectors
            if (c.a < -3 && c.b > 0 && chroma > 3) {
                return true;
            }
        }

        // Log diagnostic info if no green found
        if (lowChromaSkips > sampleSize * 0.8) {
        }

        return false;
    }

    /**
     * HUE-AWARE PRIORITY MULTIPLIER: Calculate split priority using Hue Hunger
     *
     * ARCHITECT'S "SECRET SAUCE": Priority = Variance × (1 + HueHunger)
     *
     * This transforms median cut from statistical dominance to perceptual importance.
     * Boxes in uncovered hue sectors with significant source energy get 5× priority boost,
     * forcing the algorithm to naturally discover vibrant accents instead of just
     * splitting neutral backgrounds.
     *
     * Example:
     * - Image: 90% gray, 10% vibrant red
     * - Without priority: Gray box has 900 variance, red box has 100 variance → gray splits first
     * - With priority: Red sector uncovered + >5% energy → red gets 100 × 5.0 = 500 priority
     * - Result: Red box splits first, gets 1-2 palette slots (desired behavior)
     *
     * @private
     * @param {Object} box - Box to evaluate
     * @param {Float32Array} sectorEnergy - Source energy per sector (0-100%), or null if disabled
     * @param {Set<number>} coveredSectors - Sectors already in palette
     * @param {boolean} grayscaleOnly - If true, ignore hue priority
     * @param {number} hueMultiplier - Multiplier for uncovered sectors (default 5.0)
     * @returns {number} Priority value (higher = split sooner)
     */
    static _calculateSplitPriority(box, sectorEnergy, coveredSectors, grayscaleOnly, hueMultiplier = 5.0, vibrancyMode = 'aggressive', vibrancyMultiplier = 2.0, highlightThreshold = 92, highlightBoost = 3.0, tuning = null) {
        const metadata = this._calculateBoxMetadata(box, grayscaleOnly, vibrancyMode, vibrancyMultiplier, highlightThreshold, highlightBoost, tuning);

        // Base priority: perceptual variance
        let basePriority = metadata.variance;

        // Early exit for grayscale or no hue priority
        if (grayscaleOnly || !sectorEnergy) {
            return basePriority;
        }

        // NEUTRAL SUPPRESSION: Reduce split priority for achromatic boxes.
        // In images with large neutral fractions (e.g., white substrate, gray
        // backgrounds), neutral L-variance overwhelms chromatic signals and
        // consumes most color slots. This penalty ensures chromatic content
        // gets sufficient splits even when outnumbered by neutrals.
        // The 0.25× factor means a neutral box needs 4× more variance than
        // a chromatic box to win a split — this roughly compensates for
        // neutrals' inflated L-range spanning the full 0-100 scale.
        const meanChroma = Math.sqrt(metadata.meanA ** 2 + metadata.meanB ** 2);
        if (meanChroma < 10.0) {
            basePriority *= 0.25;
        }

        // Apply Hue-Aware multiplier
        let multiplier = 1.0;
        const boxSector = metadata.sector;
        const sectorNames = ['Red', 'Orange', 'Yellow', 'Y-Green', 'Green', 'Cyan',
                           'Blue', 'B-Purple', 'Purple', 'Magenta', 'Pink', 'R-Pink'];

        // GREEN PEEK: Check if this box CONTAINS green signals even if the mean isn't green
        // This is critical because green foliage often gets mixed into blue-gray boxes
        // Patent Claim: "Chromatic Inflation Factor" for hidden hue signals
        const is16Bit = tuning && tuning.centroid && tuning.centroid.bitDepth === 16;
        const isArchiveMode = vibrancyMode === 'exponential' || is16Bit;
        const GREEN_PEEK_THRESHOLD = is16Bit ? 0.5 : 2.0;  // Very low chroma threshold for 16-bit
        const GREEN_PEEK_MULTIPLIER = 8.0;

        // Log Green Peek status for debugging
        const greenSector3Covered = coveredSectors.has(3);
        const greenSector4Covered = coveredSectors.has(4);
        const greenEnergy = Math.max(sectorEnergy[3] || 0, sectorEnergy[4] || 0);

        if (isArchiveMode) {
            if (!greenSector3Covered && !greenSector4Covered) {
                // Check if box contains ANY green signals (sectors 3 or 4)
                const hasGreenSignal = this._boxContainsHueSector(box.colors, [3, 4], GREEN_PEEK_THRESHOLD);

                if (hasGreenSignal && greenEnergy > 0.1) {
                    multiplier = GREEN_PEEK_MULTIPLIER;
                    return basePriority * multiplier;  // Early return with boost
                } else if (hasGreenSignal) {
                }
            } else {
            }
        }

        if (boxSector >= 0) {
            const sourceEnergy = sectorEnergy[boxSector];

            // RED RESCUE: JPEG artifacts compress reds into "muddy pink" volumes
            // that mathematically out-vote the true reds. We use aggressive settings
            // for Red sector (0) to force isolation before averaging kills it.
            // Patent Claim: "Chromatic Inflation Factor" for artifact-compressed primaries
            const isRedSector = boxSector === 0;
            const RED_RESCUE_THRESHOLD = 2.0;      // Lower threshold for reds (2% vs 5%)
            const RED_RESCUE_MULTIPLIER = 10.0;    // Minimum boost for reds (10×)
            const isGreenSector = boxSector === 3 || boxSector === 4; // Y-Green or Green
            const GREEN_RESCUE_THRESHOLD = is16Bit ? 0.5 : 1.5;    // Even lower for 16-bit archives
            const GREEN_RESCUE_MULTIPLIER = 10.0;  // Match Red Rescue strength

            // Determine thresholds and multipliers based on rescue type
            let significanceThreshold = 5.0;
            let sectorMultiplier = hueMultiplier;

            if (isRedSector) {
                significanceThreshold = RED_RESCUE_THRESHOLD;
                sectorMultiplier = Math.max(RED_RESCUE_MULTIPLIER, hueMultiplier);
            } else if (isArchiveMode && isGreenSector) {
                significanceThreshold = GREEN_RESCUE_THRESHOLD;
                sectorMultiplier = Math.max(GREEN_RESCUE_MULTIPLIER, hueMultiplier);
            }

            // CRITICAL: If sector has significant energy but isn't covered yet
            if (sourceEnergy > significanceThreshold && !coveredSectors.has(boxSector)) {
                multiplier = sectorMultiplier;

                if (isRedSector) {
                } else if (isArchiveMode && isGreenSector) {
                } else {
                }
            }
        }

        return basePriority * multiplier;
    }

    /**
     * LAB-SPACE MEDIAN CUT: Core quantization algorithm
     *
     * ARCHITECT'S MODEL: Recursive Lab-space partitioning with hue-aware priority
     *
     * Grid sampling (stride 4) reduces computation by 90% with negligible quality impact.
     * Colors are deduplicated to prevent zero-variance boxes that can't be split.
     *
     * If substrateLab is provided, pixels within SUBSTRATE_TOLERANCE distance of the
     * substrate color are excluded from quantization (substrate culling), preventing
     * the background from stealing palette slots.
     *
     * @param {Float32Array} labPixels - Flat array: [L, a, b, L, a, b, ...]
     * @param {number} targetColors - Desired color count
     * @param {boolean} grayscaleOnly - If true, ignore a/b channels and quantize L only
     * @param {number|null} width - Image width (unused, kept for compatibility)
     * @param {number|null} height - Image height (unused, kept for compatibility)
     * @param {{L: number, a: number, b: number}|null} substrateLab - Substrate color to cull
     * @param {number} substrateTolerance - ΔE threshold for substrate culling (default: 3.5)
     * @returns {Array} palette - Array of Lab colors: [{L, a, b}, ...]
     */
    static medianCutInLabSpace(labPixels, targetColors, grayscaleOnly = false, width = null, height = null, substrateLab = null, substrateTolerance = 3.5, vibrancyMode = 'aggressive', vibrancyBoost = 2.0, highlightThreshold = 92, highlightBoost = 3.0, strategy = null, tuning = null) {
        // DEBUG: Log tuning object to verify bitDepth is received
        const tunedBitDepth = tuning && tuning.centroid && tuning.centroid.bitDepth;

        // ARTIST-CENTRIC MODEL: Grid Sampling Optimization
        // Instead of scanning all 640,000 pixels, use stride 4 (every 4th pixel)
        // This reduces computation by 90% with negligible quality impact
        const GRID_STRIDE = 4;
        const totalPixels = labPixels.length / 3;

        // Convert flat array to color array with deduplication
        // Deduplication is critical: without it, large regions of identical colors
        // create zero-variance boxes that can't be split
        let colors = [];

        if (grayscaleOnly) {
            // Grayscale mode: Deduplicate by L value only
            // Many pixels share the same L value (e.g., 200k white pixels all L=100)
            const lMap = new Map();

            // Grid sampling: Only process every GRID_STRIDE-th pixel
            for (let i = 0; i < labPixels.length; i += 3 * GRID_STRIDE) {
                const L = labPixels[i];
                const key = L.toFixed(2); // Round to 2 decimals to handle float precision

                if (lMap.has(key)) {
                    lMap.get(key).count++;
                } else {
                    lMap.set(key, { L, a: 0, b: 0, count: 1 });
                }
            }

            colors = Array.from(lMap.values());

            // CRITICAL FIX: Sort colors array to ensure deterministic ordering
            // Sort by L value for grayscale mode
            colors.sort((a, b) => a.L - b.L);

            const sampledPixels = Math.floor(totalPixels / GRID_STRIDE);
        } else {
            // Color mode: Deduplicate by full Lab triplet
            // Identical colors (same L, a, b) must be deduplicated to avoid zero variance
            const labMap = new Map();

            // SUBSTRATE CULLING: Use provided tolerance from options
            // User can adjust via UI slider (typical: 3.0-4.0 for clean backgrounds)
            let culledCount = 0;

            // Grid sampling: Only process every GRID_STRIDE-th pixel
            for (let i = 0; i < labPixels.length; i += 3 * GRID_STRIDE) {
                const L = labPixels[i];
                const a = labPixels[i + 1];
                const b = labPixels[i + 2];

                // SUBSTRATE CULLING: Skip pixels within tolerance of substrate
                if (substrateLab) {
                    const dL = L - substrateLab.L;
                    const da = a - substrateLab.a;
                    const db = b - substrateLab.b;
                    const distSq = (dL * dL) + (da * da) + (db * db);

                    if (distSq < substrateTolerance * substrateTolerance) {
                        culledCount++;
                        continue; // Skip this pixel - it's substrate
                    }
                }

                // Create unique key from Lab values (rounded to 2 decimals for float precision)
                const key = `${L.toFixed(2)},${a.toFixed(2)},${b.toFixed(2)}`;

                if (labMap.has(key)) {
                    labMap.get(key).count++;
                } else {
                    labMap.set(key, { L, a, b, count: 1 });
                }
            }

            colors = Array.from(labMap.values());

            // CRITICAL FIX: Sort colors array to ensure deterministic ordering
            // Map iteration order is insertion-order, which can vary between environments
            // Sort by L, then a, then b to guarantee identical behavior in UI and batch
            colors.sort((a, b) => {
                if (a.L !== b.L) return a.L - b.L;
                if (a.a !== b.a) return a.a - b.a;
                return a.b - b.b;
            });

            const sampledPixels = Math.floor(totalPixels / GRID_STRIDE);

            if (substrateLab && culledCount > 0) {
                const percent = ((culledCount / sampledPixels) * 100).toFixed(1);
            }

        }

        // DEBUG: Check Lab value ranges (avoid stack overflow with large arrays)
        if (colors.length > 0) {
            let minL = colors[0].L, maxL = colors[0].L;
            let minA = colors[0].a, maxA = colors[0].a;
            let minB = colors[0].b, maxB = colors[0].b;

            for (let i = 1; i < colors.length; i++) {
                if (colors[i].L < minL) minL = colors[i].L;
                if (colors[i].L > maxL) maxL = colors[i].L;
                if (colors[i].a < minA) minA = colors[i].a;
                if (colors[i].a > maxA) maxA = colors[i].a;
                if (colors[i].b < minB) minB = colors[i].b;
                if (colors[i].b > maxB) maxB = colors[i].b;
            }


            // Check for zero variance (all pixels identical)
            const rangeL = maxL - minL;
            const rangeA = maxA - minA;
            const rangeB = maxB - minB;

            if (rangeL < 0.01 && rangeA < 0.01 && rangeB < 0.01) {
                logger.warn(`⚠️ WARNING: All pixels are essentially identical!`);
                logger.warn(`   This will result in only 1 color in the palette.`);
                logger.warn(`   Check if your document has actual color variation.`);
            } else if (rangeL < 1.0 && rangeA < 1.0 && rangeB < 1.0) {
                logger.warn(`⚠️ WARNING: Very low color variance detected!`);
                logger.warn(`   This may result in fewer colors than requested.`);
            }
        }

        // HUE-AWARE PRIORITY: Analyze source image hue distribution
        // This powers the "hunger" multiplier that forces hue diversity
        // MUTED IMAGE RESCUE: For exponential vibrancy (muted archives) OR 16-bit sources,
        // use lower chroma threshold to detect desaturated greens (chroma 2-4) that would
        // otherwise be classified as neutral. 16-bit data is SIGNAL, not noise.
        const is16Bit = tuning && tuning.centroid && tuning.centroid.bitDepth === 16;
        const hueChromaThreshold = (vibrancyMode === 'exponential' || is16Bit) ? 1.0 : 5.0;
        const sectorEnergy = grayscaleOnly ? null : HueGapRecovery._analyzeImageHueSectors(labPixels, hueChromaThreshold);
        const coveredSectors = new Set();

        // Start with initial box(es) — optionally pre-isolate neutrals
        // When neutralIsolationThreshold > 0, split colors into neutral vs chromatic
        // boxes BEFORE the median cut loop. This prevents the neutral majority (often
        // 65%+ of pixels) from consuming split budget and dragging centroids toward
        // low chroma. The neutral box gets its own splits for tonal ramps while
        // chromatic colors compete only among themselves.
        const neutralIsolationThreshold = tuning?.split?.neutralIsolationThreshold ?? 0;
        let boxes;
        if (!grayscaleOnly && neutralIsolationThreshold > 0) {
            const neutralColors = [];
            const chromaticColors = [];
            for (const c of colors) {
                if (Math.sqrt(c.a * c.a + c.b * c.b) < neutralIsolationThreshold) {
                    neutralColors.push(c);
                } else {
                    chromaticColors.push(c);
                }
            }
            if (neutralColors.length > 0 && chromaticColors.length > 0) {
                boxes = [
                    { colors: neutralColors, depth: 0, grayscaleOnly },
                    { colors: chromaticColors, depth: 0, grayscaleOnly }
                ];
            } else {
                boxes = [{ colors, depth: 0, grayscaleOnly }];
            }
        } else {
            boxes = [{ colors, depth: 0, grayscaleOnly }];
        }

        // Split until we have targetColors boxes
        const splitMode = tuning?.split?.splitMode || 'median';
        const quantizer = tuning?.split?.quantizer || 'median-cut';
        logger.log(`[medianCut] quantizer=${quantizer}, splitMode=${splitMode}, targetColors=${targetColors}, colors=${colors.length}`);
        let splitIteration = 0;

        if (quantizer === 'wu' && !grayscaleOnly) {
            // ── WU HISTOGRAM-BASED SPLITTING ──
            // Build 3D histogram in Lab space, compute cumulative moments,
            // then split by maximizing variance reduction (O(1) per candidate).
            boxes = this._splitLoopWu(colors, targetColors, tuning, sectorEnergy, coveredSectors, boxes);
        } else {
            // ── ORIGINAL MEDIAN CUT SPLITTING ──
            while (boxes.length < targetColors) {
                splitIteration++;

                if (splitMode === 'variance') {
                    // VARIANCE MODE: Sort by pure SSE — split the box with highest internal error
                    boxes.sort((a, b) => this._calculateBoxSSE(b, tuning) - this._calculateBoxSSE(a, tuning));
                } else {
                    // DEFAULT: HUE-AWARE PRIORITY: Sort by priority (variance × hue hunger × vibrancy)
                    boxes.sort((a, b) => {
                        const priorityB = this._calculateSplitPriority(b, sectorEnergy, coveredSectors, grayscaleOnly, 5.0, vibrancyMode, vibrancyBoost, highlightThreshold, highlightBoost, tuning);
                        const priorityA = this._calculateSplitPriority(a, sectorEnergy, coveredSectors, grayscaleOnly, 5.0, vibrancyMode, vibrancyBoost, highlightThreshold, highlightBoost, tuning);
                        return priorityB - priorityA;
                    });
                }

                // If largest box has only 1 color, can't split further
                if (boxes[0].colors.length === 1) {
                    break;
                }

                // Split the highest-priority box
                const box = boxes.shift();
                const [box1, box2] = this._splitBoxLab(box, grayscaleOnly, tuning);

                if (box1 && box2) {
                    boxes.push(box1, box2);

                    // Track which hue sectors are now covered
                    if (!grayscaleOnly && sectorEnergy) {
                        const COVERAGE_CHROMA_MIN = 10.0;
                        const meta1 = this._calculateBoxMetadata(box1, grayscaleOnly, vibrancyMode, vibrancyBoost, highlightThreshold, highlightBoost, tuning);
                        const meta2 = this._calculateBoxMetadata(box2, grayscaleOnly, vibrancyMode, vibrancyBoost, highlightThreshold, highlightBoost, tuning);
                        if (meta1.sector >= 0) {
                            const c1 = Math.sqrt(meta1.meanA ** 2 + meta1.meanB ** 2);
                            if (c1 >= COVERAGE_CHROMA_MIN) coveredSectors.add(meta1.sector);
                        }
                        if (meta2.sector >= 0) {
                            const c2 = Math.sqrt(meta2.meanA ** 2 + meta2.meanB ** 2);
                            if (c2 >= COVERAGE_CHROMA_MIN) coveredSectors.add(meta2.sector);
                        }
                    }

                } else {
                    // Split failed, put box back
                    boxes.push(box);
                    break;
                }
            }
        }


        // GREEN-PRIORITY CENTROID: Check if we need to rescue green signals
        // If a box has significant green content, extract green-only centroid
        // This prevents green from being averaged into orange/yellow
        // Note: is16Bit already declared earlier in this function
        const greenEnergy = sectorEnergy ? (sectorEnergy[3] + sectorEnergy[4]) : 0;  // Y-Green + Green
        const GREEN_RESCUE_THRESHOLD = 1.5;  // Activate if green > 1.5% of image
        const shouldRescueGreen = !grayscaleOnly && greenEnergy > GREEN_RESCUE_THRESHOLD && is16Bit;

        if (shouldRescueGreen) {
        }

        // PRE-SCAN: Find the box with most green content for forced rescue
        let bestGreenBoxIdx = -1;
        let bestGreenCount = 0;
        let bestGreenRatio = 0;

        if (shouldRescueGreen) {
            boxes.forEach((box, idx) => {
                const greenColors = box.colors.filter(c => {
                    const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
                    if (chroma < 0.5) return false;
                    const hue = Math.atan2(c.b, c.a) * (180 / Math.PI);
                    const normalizedHue = hue < 0 ? hue + 360 : hue;
                    const sector = Math.floor(normalizedHue / 30);
                    return sector === 3 || sector === 4;  // Y-Green or Green
                });
                const greenRatio = box.colors.length > 0 ? greenColors.length / box.colors.length : 0;

                if (greenColors.length > bestGreenCount) {
                    bestGreenCount = greenColors.length;
                    bestGreenRatio = greenRatio;
                    bestGreenBoxIdx = idx;
                }
            });

            if (bestGreenBoxIdx >= 0) {
            }
        }

        // 🔧 PEAK ELIGIBILITY FLOOR (V1 LEGACY MODE)
        // Filter out boxes that are too small (< isolationThreshold % of total pixels)
        // This prevents 16-bit sensor noise and tiny clusters from becoming "identity peaks"
        // isolationThreshold: 25.0 = 1.0% minimum cluster size
        const isolationThreshold = tuning?.prune?.isolationThreshold || 0.0;
        if (isolationThreshold > 0) {
            const minPixels = totalPixels * (isolationThreshold / 2500);  // 25.0 → 1.0% of image
            const originalBoxCount = boxes.length;
            const filteredBoxes = boxes.filter(box => box.colors.length >= minPixels);

            // SAFETY: Only apply filter if we have at least targetColors boxes remaining
            // If isolation threshold is too aggressive, keep all boxes to avoid empty palette
            if (filteredBoxes.length >= targetColors) {
                boxes = filteredBoxes;
                const filtered = originalBoxCount - boxes.length;
            } else {
            }
        }

        // Calculate representative color for each box (centroid in Lab space)
        // Use injected strategy or fallback to VOLUMETRIC
        // splitMode is orthogonal to centroid strategy — Wu decides how to PARTITION,
        // the archetype's strategy decides how to PICK the representative color.
        const palette = boxes.map((box, idx) => {
            // GREEN-PRIORITY CENTROID: Force green centroid for the box with most green content
            // Threshold lowered: ANY green content qualifies if this is the best green box
            if (shouldRescueGreen && idx === bestGreenBoxIdx && bestGreenCount > 5) {
                const greenColors = box.colors.filter(c => {
                    const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
                    if (chroma < 0.5) return false;
                    const hue = Math.atan2(c.b, c.a) * (180 / Math.PI);
                    const normalizedHue = hue < 0 ? hue + 360 : hue;
                    const sector = Math.floor(normalizedHue / 30);
                    return sector === 3 || sector === 4;
                });

                if (greenColors.length > 0) {
                    return PaletteOps._calculateLabCentroid(greenColors, grayscaleOnly, strategy, tuning);
                }
            }

            // Normal centroid calculation
            return PaletteOps._calculateLabCentroid(box.colors, grayscaleOnly, strategy, tuning);
        });

        // NaN check — catch bad centroids before they propagate
        for (let i = 0; i < palette.length; i++) {
            const c = palette[i];
            if (!c || isNaN(c.L) || isNaN(c.a) || isNaN(c.b)) {
                logger.error(`[medianCut] NaN palette entry at index ${i}: L=${c?.L} a=${c?.a} b=${c?.b}, box had ${boxes[i]?.colors?.length} colors`);
            }
        }

        // Store colors array in palette for later hue gap analysis
        // This allows us to force-include gap colors AFTER perceptual snap
        palette._allColors = colors;
        palette._labPixels = labPixels;

        return palette;
    }

    // ═══════════════════════════════════════════════════════════════════
    // WU HISTOGRAM-BASED QUANTIZATION
    // Xiaolin Wu, "Efficient Statistical Computations for Optimal Color
    // Quantization," Graphics Gems vol. II, Academic Press, 1991.
    //
    // Operates on a 3D Lab histogram with cumulative moment tables.
    // Splits minimize total within-box variance (SSE), unlike median cut
    // which splits at the median position.
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Wu histogram-based splitting loop.
     * Replaces the median cut loop when quantizer === 'wu'.
     *
     * @param {Array<{L, a, b, count}>} colors - Deduplicated, culled colors
     * @param {number} targetColors - Desired box count
     * @param {Object} tuning - Tuning parameters
     * @param {Float32Array|null} sectorEnergy - 12-element hue sector energy
     * @param {Set<number>} coveredSectors - Already-covered hue sectors
     * @param {Array} initialBoxes - Pre-split boxes (from neutral isolation)
     * @returns {Array} boxes - Array of {colors} box objects
     */
    static _splitLoopWu(colors, targetColors, tuning, sectorEnergy, coveredSectors, initialBoxes) {
        const BINS = 33; // 0 = boundary, 1-32 = data bins
        const BIN_COUNT = 32;

        const vibrancyBoost = tuning?.split?.vibrancyBoost ?? 0;

        // ── Step 1: Build 3D histogram ──
        // 5 moment arrays: count, sumL, sumA, sumB, sumSq
        const size = BINS * BINS * BINS;
        const wt = new Float64Array(size);  // pixel count
        const mL = new Float64Array(size);  // sum of L
        const mA = new Float64Array(size);  // sum of a
        const mB = new Float64Array(size);  // sum of b
        const m2 = new Float64Array(size);  // sum of weighted L² + a² + b²

        // Find Lab ranges for binning
        let minL = Infinity, maxL = -Infinity;
        let minA = Infinity, maxA = -Infinity;
        let minB = Infinity, maxB = -Infinity;
        for (let i = 0; i < colors.length; i++) {
            const c = colors[i];
            if (c.L < minL) minL = c.L;
            if (c.L > maxL) maxL = c.L;
            if (c.a < minA) minA = c.a;
            if (c.a > maxA) maxA = c.a;
            if (c.b < minB) minB = c.b;
            if (c.b > maxB) maxB = c.b;
        }

        // Bin width (avoid division by zero for uniform channels)
        const rangeL = maxL - minL || 1;
        const rangeA = maxA - minA || 1;
        const rangeB = maxB - minB || 1;

        // Map color to histogram bin indices (1-32)
        const colorBins = new Uint8Array(colors.length * 3);
        for (let i = 0; i < colors.length; i++) {
            const c = colors[i];
            const bl = Math.min(BIN_COUNT, Math.max(1, 1 + Math.floor((c.L - minL) / rangeL * (BIN_COUNT - 1))));
            const ba = Math.min(BIN_COUNT, Math.max(1, 1 + Math.floor((c.a - minA) / rangeA * (BIN_COUNT - 1))));
            const bb = Math.min(BIN_COUNT, Math.max(1, 1 + Math.floor((c.b - minB) / rangeB * (BIN_COUNT - 1))));
            colorBins[i * 3] = bl;
            colorBins[i * 3 + 1] = ba;
            colorBins[i * 3 + 2] = bb;

            const idx = bl * BINS * BINS + ba * BINS + bb;
            const w = c.count || 1;

            // Chroma-weighted variance: bias toward vivid colors
            let chromaW = 1.0;
            if (vibrancyBoost > 0) {
                const chroma = Math.sqrt(c.a * c.a + c.b * c.b);
                chromaW = 1.0 + vibrancyBoost * chroma / 128;
            }

            wt[idx] += w;
            mL[idx] += c.L * w;
            mA[idx] += c.a * w;
            mB[idx] += c.b * w;
            m2[idx] += chromaW * w * (c.L * c.L + c.a * c.a + c.b * c.b);
        }

        // ── Step 2: Compute 3D cumulative moments ──
        this._wuCumulativeMoments(wt, mL, mA, mB, m2, BINS);

        // ── Step 3: Initialize Wu boxes ──
        // If neutral isolation created multiple initial boxes, map them to Wu box bounds
        let wuBoxes;
        if (initialBoxes.length > 1) {
            // Multiple initial boxes from neutral isolation — find bounds per box
            wuBoxes = initialBoxes.map(ibox => {
                let r0 = BIN_COUNT, r1 = 0, g0 = BIN_COUNT, g1 = 0, b0 = BIN_COUNT, b1 = 0;
                for (let i = 0; i < colors.length; i++) {
                    const c = colors[i];
                    const inBox = ibox.colors.some(ic => ic.L === c.L && ic.a === c.a && ic.b === c.b);
                    if (inBox) {
                        const bl = colorBins[i * 3], ba = colorBins[i * 3 + 1], bb = colorBins[i * 3 + 2];
                        if (bl < r0) r0 = bl; if (bl > r1) r1 = bl;
                        if (ba < g0) g0 = ba; if (ba > g1) g1 = ba;
                        if (bb < b0) b0 = bb; if (bb > b1) b1 = bb;
                    }
                }
                return { r0: r0 - 1, r1, g0: g0 - 1, g1, b0: b0 - 1, b1 };
            });
        } else {
            // Single box spanning full range
            wuBoxes = [{ r0: 0, r1: BIN_COUNT, g0: 0, g1: BIN_COUNT, b0: 0, b1: BIN_COUNT }];
        }

        // Compute initial variances
        const variances = wuBoxes.map(box => this._wuVariance(box, wt, mL, mA, mB, m2, BINS));

        // ── Step 4: Iterative splitting ──
        while (wuBoxes.length < targetColors) {
            // Find box with highest variance
            let bestIdx = -1, bestVar = 0;
            for (let i = 0; i < wuBoxes.length; i++) {
                // Apply hue-sector priority boost
                let priority = variances[i];
                if (sectorEnergy && priority > 0) {
                    const centroid = this._wuBoxCentroid(wuBoxes[i], wt, mL, mA, mB, BINS);
                    const chroma = Math.sqrt(centroid.a * centroid.a + centroid.b * centroid.b);
                    if (chroma >= 10) {
                        const hue = ((Math.atan2(centroid.b, centroid.a) * 180 / Math.PI) + 360) % 360;
                        const sector = Math.floor(hue / 30) % 12;
                        if (!coveredSectors.has(sector) && sectorEnergy[sector] > 0) {
                            priority *= 5.0; // Boost uncovered sectors
                        }
                    }
                }
                if (priority > bestVar) {
                    bestVar = priority;
                    bestIdx = i;
                }
            }

            if (bestIdx < 0 || bestVar <= 0) break;

            // Try to cut this box
            const cut = this._wuCut(wuBoxes[bestIdx], wt, mL, mA, mB, m2, BINS);
            if (!cut) {
                // Can't split — mark variance as 0 and try next
                variances[bestIdx] = 0;
                continue;
            }

            const [box1, box2] = cut;
            wuBoxes[bestIdx] = box1;
            variances[bestIdx] = this._wuVariance(box1, wt, mL, mA, mB, m2, BINS);
            wuBoxes.push(box2);
            variances.push(this._wuVariance(box2, wt, mL, mA, mB, m2, BINS));

            // Track hue sector coverage
            if (sectorEnergy) {
                for (const box of [box1, box2]) {
                    const cent = this._wuBoxCentroid(box, wt, mL, mA, mB, BINS);
                    const c = Math.sqrt(cent.a * cent.a + cent.b * cent.b);
                    if (c >= 10) {
                        const h = ((Math.atan2(cent.b, cent.a) * 180 / Math.PI) + 360) % 360;
                        coveredSectors.add(Math.floor(h / 30) % 12);
                    }
                }
            }
        }

        // ── Step 5: Map Wu boxes back to color arrays ──
        // Each color gets assigned to its containing Wu box.
        // Use >= on lower bound to avoid boundary cracks from splitting.
        const boxColors = wuBoxes.map(() => []);
        for (let i = 0; i < colors.length; i++) {
            const bl = colorBins[i * 3], ba = colorBins[i * 3 + 1], bb = colorBins[i * 3 + 2];
            let assigned = false;
            for (let j = 0; j < wuBoxes.length; j++) {
                const box = wuBoxes[j];
                if (bl > box.r0 && bl <= box.r1 &&
                    ba > box.g0 && ba <= box.g1 &&
                    bb > box.b0 && bb <= box.b1) {
                    boxColors[j].push(colors[i]);
                    assigned = true;
                    break;
                }
            }
            // Fallback: color fell through boundary crack — assign to nearest box
            if (!assigned) {
                const c = colors[i];
                let bestJ = 0, bestDist = Infinity;
                for (let j = 0; j < wuBoxes.length; j++) {
                    const cent = this._wuBoxCentroid(wuBoxes[j], wt, mL, mA, mB, BINS);
                    const dL = c.L - cent.L, da = c.a - cent.a, db = c.b - cent.b;
                    const dist = dL * dL + da * da + db * db;
                    if (dist < bestDist) { bestDist = dist; bestJ = j; }
                }
                boxColors[bestJ].push(c);
            }
        }

        // Diagnostics: check for unassigned colors
        let unassignedCount = 0;
        const totalColorCount = colors.reduce((s, c) => s + (c.count || 1), 0);
        const assignedColorCount = boxColors.reduce((s, bc) => s + bc.reduce((s2, c) => s2 + (c.count || 1), 0), 0);
        if (assignedColorCount < totalColorCount) {
            unassignedCount = totalColorCount - assignedColorCount;
            logger.warn(`[Wu] WARNING: ${unassignedCount} pixels in unassigned colors (${colors.length} deduped colors, ${wuBoxes.length} boxes)`);
        }
        const emptyBoxes = boxColors.filter(bc => bc.length === 0).length;
        if (emptyBoxes > 0) {
            logger.warn(`[Wu] ${emptyBoxes} empty boxes out of ${wuBoxes.length}`);
        }
        logger.log(`[Wu] Split into ${wuBoxes.length} boxes, ${boxColors.filter(bc => bc.length > 0).length} non-empty, ${colors.length} deduped colors`);

        // Convert to the box format expected by downstream code
        return boxColors
            .filter(c => c.length > 0)
            .map(c => ({ colors: c, depth: 0, grayscaleOnly: false }));
    }

    /**
     * Compute 3D cumulative moment tables (prefix sums).
     * After this, Vol() queries return sums for any sub-box in O(1).
     */
    static _wuCumulativeMoments(wt, mL, mA, mB, m2, BINS) {
        // Running area and line accumulators for each moment
        const areaWt = new Float64Array(BINS);
        const areaL = new Float64Array(BINS);
        const areaA = new Float64Array(BINS);
        const areaB = new Float64Array(BINS);
        const area2 = new Float64Array(BINS);

        for (let r = 1; r < BINS; r++) {
            areaWt.fill(0); areaL.fill(0); areaA.fill(0); areaB.fill(0); area2.fill(0);

            for (let g = 1; g < BINS; g++) {
                let lineWt = 0, lineL = 0, lineA = 0, lineB = 0, line2 = 0;

                for (let b = 1; b < BINS; b++) {
                    const idx = r * BINS * BINS + g * BINS + b;
                    const prevR = (r - 1) * BINS * BINS + g * BINS + b;

                    lineWt += wt[idx]; lineL += mL[idx]; lineA += mA[idx]; lineB += mB[idx]; line2 += m2[idx];
                    areaWt[b] += lineWt; areaL[b] += lineL; areaA[b] += lineA; areaB[b] += lineB; area2[b] += line2;

                    wt[idx] = wt[prevR] + areaWt[b];
                    mL[idx] = mL[prevR] + areaL[b];
                    mA[idx] = mA[prevR] + areaA[b];
                    mB[idx] = mB[prevR] + areaB[b];
                    m2[idx] = m2[prevR] + area2[b];
                }
            }
        }
    }

    /**
     * 3D inclusion-exclusion volume query.
     * Returns the sum of moment array `mmt` over the box region.
     */
    static _wuVol(box, mmt, BINS) {
        const { r0, r1, g0, g1, b0, b1 } = box;
        const S = BINS * BINS;
        return mmt[r1 * S + g1 * BINS + b1]
             - mmt[r1 * S + g1 * BINS + b0]
             - mmt[r1 * S + g0 * BINS + b1]
             + mmt[r1 * S + g0 * BINS + b0]
             - mmt[r0 * S + g1 * BINS + b1]
             + mmt[r0 * S + g1 * BINS + b0]
             + mmt[r0 * S + g0 * BINS + b1]
             - mmt[r0 * S + g0 * BINS + b0];
    }

    /**
     * Compute variance (SSE) of a Wu box using moment tables.
     * Variance = m2 - (mL² + mA² + mB²) / wt
     */
    static _wuVariance(box, wt, mL, mA, mB, m2, BINS) {
        const vol = this._wuVol(box, wt, BINS);
        if (vol <= 0) return 0;
        const sL = this._wuVol(box, mL, BINS);
        const sA = this._wuVol(box, mA, BINS);
        const sB = this._wuVol(box, mB, BINS);
        const s2 = this._wuVol(box, m2, BINS);
        return s2 - (sL * sL + sA * sA + sB * sB) / vol;
    }

    /**
     * Compute weighted centroid of a Wu box from moment tables.
     */
    static _wuBoxCentroid(box, wt, mL, mA, mB, BINS) {
        const vol = this._wuVol(box, wt, BINS);
        if (vol <= 0) return { L: 50, a: 0, b: 0 };
        return {
            L: this._wuVol(box, mL, BINS) / vol,
            a: this._wuVol(box, mA, BINS) / vol,
            b: this._wuVol(box, mB, BINS) / vol
        };
    }

    /**
     * Find the best split for a Wu box across all 3 axes.
     * Returns [box1, box2] or null if no valid split exists.
     */
    static _wuCut(box, wt, mL, mA, mB, m2, BINS) {
        const { r0, r1, g0, g1, b0, b1 } = box;

        // Try each axis, pick the one with best variance reduction
        let bestAxis = -1, bestPos = -1, bestMetric = -Infinity;

        // Axis 0: L (r)
        if (r1 > r0 + 1) {
            const result = this._wuMaximize(box, 0, wt, mL, mA, mB, m2, BINS);
            if (result && result.metric > bestMetric) {
                bestMetric = result.metric; bestAxis = 0; bestPos = result.pos;
            }
        }
        // Axis 1: a (g)
        if (g1 > g0 + 1) {
            const result = this._wuMaximize(box, 1, wt, mL, mA, mB, m2, BINS);
            if (result && result.metric > bestMetric) {
                bestMetric = result.metric; bestAxis = 1; bestPos = result.pos;
            }
        }
        // Axis 2: b (b)
        if (b1 > b0 + 1) {
            const result = this._wuMaximize(box, 2, wt, mL, mA, mB, m2, BINS);
            if (result && result.metric > bestMetric) {
                bestMetric = result.metric; bestAxis = 2; bestPos = result.pos;
            }
        }

        if (bestAxis < 0) return null;

        // Create two child boxes
        const box1 = { r0, r1, g0, g1, b0, b1 };
        const box2 = { r0, r1, g0, g1, b0, b1 };

        if (bestAxis === 0) { box1.r1 = bestPos; box2.r0 = bestPos; }
        else if (bestAxis === 1) { box1.g1 = bestPos; box2.g0 = bestPos; }
        else { box1.b1 = bestPos; box2.b0 = bestPos; }

        return [box1, box2];
    }

    /**
     * Find the best split position along one axis using Wu's Bottom/Top decomposition.
     * Maximizes sum of (channel_sum² / count) across both halves.
     *
     * @param {Object} box - Wu box bounds
     * @param {number} axis - 0=L(r), 1=a(g), 2=b(b)
     * @returns {{pos, metric}|null} Best split position and metric, or null
     */
    static _wuMaximize(box, axis, wt, mL, mA, mB, m2, BINS) {
        const { r0, r1, g0, g1, b0, b1 } = box;

        // Total moments for the whole box
        const wholeWt = this._wuVol(box, wt, BINS);
        const wholeL = this._wuVol(box, mL, BINS);
        const wholeA = this._wuVol(box, mA, BINS);
        const wholeB = this._wuVol(box, mB, BINS);

        if (wholeWt <= 0) return null;

        // Determine sweep range
        let lo, hi;
        if (axis === 0) { lo = r0 + 1; hi = r1; }
        else if (axis === 1) { lo = g0 + 1; hi = g1; }
        else { lo = b0 + 1; hi = b1; }

        let bestMetric = -Infinity, bestPos = -1;

        // Sweep through candidate split positions
        for (let pos = lo; pos < hi; pos++) {
            // Build a temporary "bottom half" box: [original low .. pos]
            const half = { r0, r1, g0, g1, b0, b1 };
            if (axis === 0) half.r1 = pos;
            else if (axis === 1) half.g1 = pos;
            else half.b1 = pos;

            const halfWt = this._wuVol(half, wt, BINS);
            if (halfWt <= 0) continue;

            const halfL = this._wuVol(half, mL, BINS);
            const halfA = this._wuVol(half, mA, BINS);
            const halfB = this._wuVol(half, mB, BINS);

            // Top half is whole minus bottom
            const topWt = wholeWt - halfWt;
            if (topWt <= 0) continue;

            const topL = wholeL - halfL;
            const topA = wholeA - halfA;
            const topB = wholeB - halfB;

            // Metric: sum of (channel_sum² / count) for both halves
            // Maximizing this minimizes total within-box variance
            const metric = (halfL * halfL + halfA * halfA + halfB * halfB) / halfWt
                         + (topL * topL + topA * topA + topB * topB) / topWt;

            if (metric > bestMetric) {
                bestMetric = metric;
                bestPos = pos;
            }
        }

        return bestPos >= 0 ? { pos: bestPos, metric: bestMetric } : null;
    }

    /**
     * WU SSE: Calculate total Sum of Squared Error for a box across all Lab channels.
     *
     * SSE = Σ(x - mean)² for each channel, weighted by lWeight/cWeight.
     * Used as box priority in Wu variance mode — the box with highest SSE
     * gets split first, concentrating error reduction where it matters most.
     *
     * @private
     * @param {Object} box - Box containing colors array: [{ L, a, b, count }, ...]
     * @param {Object} tuning - Tuning parameters with centroid.lWeight and centroid.cWeight
     * @returns {number} Total weighted SSE across L, a, b channels
     */
    static _calculateBoxSSE(box, tuning = null) {
        const { colors } = box;
        if (!colors || colors.length === 0) return 0;

        const lWeight = tuning?.centroid?.lWeight ?? 1.0;
        const cWeight = tuning?.centroid?.cWeight ?? 1.0;

        // Compute weighted means
        let totalCount = 0, sumL = 0, sumA = 0, sumB = 0;
        for (let i = 0; i < colors.length; i++) {
            const w = colors[i].count || 1;
            sumL += colors[i].L * w;
            sumA += colors[i].a * w;
            sumB += colors[i].b * w;
            totalCount += w;
        }
        const meanL = sumL / totalCount;
        const meanA = sumA / totalCount;
        const meanB = sumB / totalCount;

        // Compute weighted SSE
        let sse = 0;
        for (let i = 0; i < colors.length; i++) {
            const w = colors[i].count || 1;
            const dL = colors[i].L - meanL;
            const dA = colors[i].a - meanA;
            const dB = colors[i].b - meanB;
            sse += w * (lWeight * dL * dL + cWeight * (dA * dA + dB * dB));
        }
        return sse;
    }

    /**
     * Split a box in Lab space by finding channel with highest variance.
     *
     * Supports two split modes:
     * - 'median' (default): Split at the median index (equal population halves)
     * - 'variance': Wu-style SSE-minimizing split — scans all candidate split points
     *   and picks the one that minimizes total SSE of the two resulting sub-boxes.
     *
     * @private
     */
    static _splitBoxLab(box, grayscaleOnly = false, tuning = null) {
        const { colors } = box;

        if (colors.length < 2) {
            return [null, null];
        }

        // Extract weights from tuning (default: lWeight=1.0, cWeight=1.0)
        // V1 LEGACY: cWeight=2.5 makes chroma the "absolute king" of splits
        const lWeight = tuning?.centroid?.lWeight ?? 1.0;
        const cWeight = tuning?.centroid?.cWeight ?? 1.0;

        if (grayscaleOnly) {
            // Grayscale mode: Only split on L channel
            const avgL = colors.reduce((sum, c) => sum + c.L, 0) / colors.length;
            const varL = colors.reduce((sum, c) => sum + (c.L - avgL) ** 2, 0);

            // If variance is 0, all colors are identical - can't split
            if (varL === 0) {
                return [null, null];
            }

            // Sort by L channel
            colors.sort((a, b) => a.L - b.L);

            // Split at median
            const median = Math.floor(colors.length / 2);
            const colors1 = colors.slice(0, median);
            const colors2 = colors.slice(median);

            return [
                { colors: colors1, depth: box.depth + 1, grayscaleOnly },
                { colors: colors2, depth: box.depth + 1, grayscaleOnly }
            ];
        } else {
            // Color mode: Calculate WEIGHTED variance in each Lab channel
            // V1 LEGACY: cWeight amplifies chroma (a, b) importance vs lightness
            const avgL = colors.reduce((sum, c) => sum + c.L, 0) / colors.length;
            const avgA = colors.reduce((sum, c) => sum + c.a, 0) / colors.length;
            const avgB = colors.reduce((sum, c) => sum + c.b, 0) / colors.length;

            // Apply weights to variance - cWeight makes chroma dominate.
            // bWeight (optional) further boosts b-axis splits.
            const bWeight = tuning?.centroid?.bWeight ?? 1.0;
            const chromaAxisWeight = tuning?.split?.chromaAxisWeight ?? 0;

            // WARM A-AXIS BOOST: In warm hue boxes (hue 20-80°, chroma > 15),
            // the b-axis has ~5x more raw variance than a, so b wins every split.
            // This prevents yellow (low a*, high b*) from separating from orange
            // (high a*, moderate b*). PS Indexed Color makes this split naturally.
            // Boost a-axis variance in warm boxes to let it compete with b.
            const warmABoost = tuning?.split?.warmABoost ?? 1.0;
            let aAxisMultiplier = 1.0;
            if (warmABoost > 1.0) {
                const meanChroma = Math.sqrt(avgA * avgA + avgB * avgB);
                const meanHue = ((Math.atan2(avgB, avgA) * 180 / Math.PI) + 360) % 360;
                if (meanChroma > 15 && meanHue >= 20 && meanHue <= 75) {
                    aAxisMultiplier = warmABoost;
                }
            }

            const varL = colors.reduce((sum, c) => sum + (c.L - avgL) ** 2, 0) * lWeight;
            const varA = colors.reduce((sum, c) => sum + (c.a - avgA) ** 2, 0) * cWeight * aAxisMultiplier;
            const varB = colors.reduce((sum, c) => sum + (c.b - avgB) ** 2, 0) * cWeight * bWeight;

            // C* (chroma magnitude) as virtual 4th split axis
            // When enabled, allows splitting along chroma gradient (e.g. C=5→C=145)
            // independent of hue angle — critical for warm images with smooth chroma ramps
            let varC = 0;
            if (chromaAxisWeight > 0) {
                let chromaSum = 0;
                for (let i = 0; i < colors.length; i++) {
                    chromaSum += Math.sqrt(colors[i].a * colors[i].a + colors[i].b * colors[i].b);
                }
                const avgC = chromaSum / colors.length;
                for (let i = 0; i < colors.length; i++) {
                    const c = Math.sqrt(colors[i].a * colors[i].a + colors[i].b * colors[i].b);
                    varC += (c - avgC) ** 2;
                }
                varC *= chromaAxisWeight;
            }

            // Choose channel with highest WEIGHTED variance
            let splitChannel = 'L';
            let maxVar = varL;
            if (varA > maxVar) {
                splitChannel = 'a';
                maxVar = varA;
            }
            if (varB > maxVar) {
                splitChannel = 'b';
                maxVar = varB;
            }
            if (varC > maxVar) {
                splitChannel = 'C';
                maxVar = varC;
            }

            // If variance is 0 in all channels, all colors are identical - can't split
            if (maxVar === 0) {
                return [null, null];
            }

            // Sort by split channel (C* sorts by chroma magnitude)
            if (splitChannel === 'C') {
                colors.sort((x, y) => Math.sqrt(x.a * x.a + x.b * x.b) - Math.sqrt(y.a * y.a + y.b * y.b));
            } else {
                colors.sort((a, b) => a[splitChannel] - b[splitChannel]);
            }

            // WU VARIANCE MODE: Find SSE-minimizing split point using prefix sums
            const splitMode = tuning?.split?.splitMode || 'median';
            let splitIdx;

            if (splitMode === 'variance' && colors.length > 2) {
                // Build prefix sums (count-weighted) for SSE computation
                // SSE = sumSq - sum²/count for each half
                const n = colors.length;
                const prefSumL = new Float64Array(n + 1);
                const prefSumA = new Float64Array(n + 1);
                const prefSumB = new Float64Array(n + 1);
                const prefSumSqL = new Float64Array(n + 1);
                const prefSumSqA = new Float64Array(n + 1);
                const prefSumSqB = new Float64Array(n + 1);
                const prefCount = new Float64Array(n + 1);

                for (let i = 0; i < n; i++) {
                    const w = colors[i].count || 1;
                    prefSumL[i + 1] = prefSumL[i] + colors[i].L * w;
                    prefSumA[i + 1] = prefSumA[i] + colors[i].a * w;
                    prefSumB[i + 1] = prefSumB[i] + colors[i].b * w;
                    prefSumSqL[i + 1] = prefSumSqL[i] + colors[i].L * colors[i].L * w;
                    prefSumSqA[i + 1] = prefSumSqA[i] + colors[i].a * colors[i].a * w;
                    prefSumSqB[i + 1] = prefSumSqB[i] + colors[i].b * colors[i].b * w;
                    prefCount[i + 1] = prefCount[i] + w;
                }

                const totalN = prefCount[n];

                // Scan all candidate split points, pick the one minimizing total SSE
                let bestSSE = Infinity;
                splitIdx = Math.floor(n / 2); // fallback to median

                for (let k = 1; k < n; k++) {
                    const leftN = prefCount[k];
                    const rightN = totalN - leftN;
                    if (leftN === 0 || rightN === 0) continue;

                    // Left SSE: sumSq - sum²/count (across L, a, b weighted)
                    const sseLeftL = prefSumSqL[k] - (prefSumL[k] * prefSumL[k]) / leftN;
                    const sseLeftA = prefSumSqA[k] - (prefSumA[k] * prefSumA[k]) / leftN;
                    const sseLeftB = prefSumSqB[k] - (prefSumB[k] * prefSumB[k]) / leftN;

                    // Right SSE
                    const rSumL = prefSumL[n] - prefSumL[k];
                    const rSumA = prefSumA[n] - prefSumA[k];
                    const rSumB = prefSumB[n] - prefSumB[k];
                    const rSumSqL = prefSumSqL[n] - prefSumSqL[k];
                    const rSumSqA = prefSumSqA[n] - prefSumSqA[k];
                    const rSumSqB = prefSumSqB[n] - prefSumSqB[k];

                    const sseRightL = rSumSqL - (rSumL * rSumL) / rightN;
                    const sseRightA = rSumSqA - (rSumA * rSumA) / rightN;
                    const sseRightB = rSumSqB - (rSumB * rSumB) / rightN;

                    // Total weighted SSE
                    const totalSSE = lWeight * (sseLeftL + sseRightL)
                                   + cWeight * (sseLeftA + sseRightA + sseLeftB + sseRightB);

                    if (totalSSE < bestSSE) {
                        bestSSE = totalSSE;
                        splitIdx = k;
                    }
                }
            } else {
                // Default median split
                splitIdx = Math.floor(colors.length / 2);
            }

            const colors1 = colors.slice(0, splitIdx);
            const colors2 = colors.slice(splitIdx);

            return [
                { colors: colors1, depth: box.depth + 1 },
                { colors: colors2, depth: box.depth + 1 }
            ];
        }
    }

    /**
     * Analyze color space to detect grayscale images
     * @private
     * @param {Float32Array} labPixels - Lab pixel data (3 floats per pixel: L, a, b)
     * @returns {Object} { chromaRange } - Maximum chroma range (a or b)
     */
    static _analyzeColorSpace(labPixels) {
        let minA = Infinity, maxA = -Infinity;
        let minB = Infinity, maxB = -Infinity;

        for (let i = 0; i < labPixels.length; i += 3) {
            const a = labPixels[i + 1];
            const b = labPixels[i + 2];

            minA = Math.min(minA, a);
            maxA = Math.max(maxA, a);
            minB = Math.min(minB, b);
            maxB = Math.max(maxB, b);
        }

        const rangeA = maxA - minA;
        const rangeB = maxB - minB;
        const chromaRange = Math.max(rangeA, rangeB);

        return { chromaRange, rangeA, rangeB };
    }
}

module.exports = LabMedianCut;
