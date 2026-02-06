/**
 * PosterizationEngine - Color Quantization for Screen Printing
 *
 * Reduces images to limited color palettes (3-9 colors) using median cut algorithm.
 * Optimized for screen printing workflow - creates distinct, well-separated colors.
 *
 * Phase 2.5: Posterization Engine & Preview UI
 *
 * MODULAR ARCHITECTURE (v2.0):
 * - ColorSpace.js: Lab/RGB conversions and distance calculations
 * - HueAnalysis.js: Hue sector analysis and gap detection
 * - CentroidStrategies.js: Centroid selection strategies
 */

const logger = require("../utils/logger");

// Import modular components
const ColorSpace = require('./ColorSpace');
const HueAnalysis = require('./HueAnalysis');
const { CentroidStrategies } = require('./CentroidStrategies');
const PeakFinder = require('../analysis/PeakFinder');
const LabDistance = require('../color/LabDistance');

class PosterizationEngine {
    /**
     * MINIMUM VIABILITY THRESHOLDS
     *
     * Prevents "dust" (tiny stray color regions) from becoming separate screens.
     * Colors below these coverage thresholds are absorbed into neighbors or skipped.
     */
    static MIN_PRESERVED_COVERAGE = 0.001;  // 0.1% for preserved colors (white/black)
    static MIN_HUE_COVERAGE = 0.01;         // 1.0% for hue gap sectors
    static PRESERVED_UNIFY_THRESHOLD = 12.0; // ΔE to unify preserved colors with existing palette colors

    /**
     * CENTRALIZED TUNING PARAMETERS
     *
     * Balanced preset for complex images with skin tones, hair textures,
     * and dark backgrounds.
     *
     * Prevents "washout" by using Soft Peak centroid (top 5%) and Logic-Gated pruning.
     */
    static TUNING = {
        split: {
            highlightBoost: 2.2,    // Balanced multiplier for facial highlights
            vibrancyBoost: 1.6,     // Weights chroma-rich pixels (Greens/Skin)
            minVariance: 10         // Minimum variance to consider splitting
        },
        prune: {
            threshold: 9.0,         // Delta-E distance for merging
            hueLockAngle: 18,       // Degrees (Protects Green from Beige washout)
            whitePoint: 85,         // L-value protection floor for white layer
            shadowPoint: 15         // L-value ceiling for shadow protection (prevents merging L<15 with lighter colors)
        },
        centroid: {
            lWeight: 1.1,           // Saliency Lightness priority
            cWeight: 2.0,           // Saliency Chroma priority
            blackBias: 5.0          // Black boost multiplier (high priority for absolute black in halftones)
        }
    };

    /**
     * Normalize bitDepth from various input formats to a number
     *
     * Handles:
     * - Number: 8, 16 → returns as-is
     * - String: "bitDepth16", "bitDepth8" → extracts number
     * - String: "16", "8" → parses to number
     * - Undefined/null → defaults to 8
     *
     * @private
     * @param {number|string|undefined} input - Raw bitDepth value
     * @returns {number} - Normalized bit depth (8 or 16)
     */
    static _normalizeBitDepth(input) {
        if (typeof input === 'number') {
            return input;
        }
        if (typeof input === 'string') {
            // Handle "bitDepth16" or "bitDepth8" format from Photoshop
            const match = input.match(/(\d+)/);
            if (match) {
                return parseInt(match[1], 10);
            }
        }
        return 8; // Default
    }

    /**
     * Factory method: Posterize image using specified engine
     *
     * ENGINES:
     * - 'reveal': Lab Median Cut + Hue Gap Analysis (default, highest quality)
     * - 'balanced': Lab Median Cut only (fast, good quality)
     * - 'classic': RGB Median Cut (fastest, basic quality)
     * - 'stencil': Luminance-only quantization (monochrome separations)
     *
     * @param {Uint8ClampedArray|Float32Array} pixels - Pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} targetColors - Target palette size (1-20)
     * @param {Object} options - Engine options
     * @param {string} [options.engineType='reveal'] - Engine to use
     * @param {boolean} [options.enableGridOptimization=true] - Grid sampling (90% faster)
     * @param {boolean} [options.enableHueGapAnalysis] - Force-include missing hues (auto-enabled for 'reveal')
     * @param {number} [options.snapThreshold=8.0] - Perceptual snap threshold (ΔE)
     * @param {string} [options.format='lab'] - Input format ('lab' or 'rgb')
     * @param {boolean} [options.grayscaleOnly=false] - L-channel only mode
     * @param {boolean} [options.preserveWhite=true] - Force white into palette
     * @param {boolean} [options.preserveBlack=true] - Force black into palette
     * @returns {Object} - {palette, paletteLab, assignments, labPixels, metadata}
     */
    static posterize(pixels, width, height, targetColors, options = {}) {
        // Default values
        const engineType = options.engineType || 'reveal';
        const enableGridOptimization = options.enableGridOptimization !== undefined
            ? options.enableGridOptimization
            : true; // DEFAULT TO ON (Architect's requirement)
        const snapThreshold = options.snapThreshold !== undefined ? options.snapThreshold : 8.0;

        // Hue gap analysis: disabled by default to respect exact color count
        // User can re-enable via options.enableHueGapAnalysis = true if desired
        const enableHueGapAnalysis = options.enableHueGapAnalysis !== undefined
            ? options.enableHueGapAnalysis
            : false;

        // STRATEGY SELECTION: Use user-provided strategy or default to SALIENCY for reveal, VOLUMETRIC for others
        const strategyName = options.centroidStrategy || (engineType === 'reveal' ? 'SALIENCY' : 'VOLUMETRIC');
        const strategy = CentroidStrategies[strategyName] || CentroidStrategies.SALIENCY;

        // Validate strategy is a function
        if (typeof strategy !== 'function') {
            logger.error(`❌ Invalid strategy: ${strategyName} is not a function. Available: ${Object.keys(CentroidStrategies).join(', ')}`);
            throw new Error(`Invalid centroid strategy: ${strategyName}`);
        }

        logger.log(`\n=== Posterization Engine: ${engineType.toUpperCase()} ===`);
        logger.log(`  Target colors: ${targetColors}`);
        logger.log(`  Centroid Strategy: ${strategyName} (user-selected)`);
        logger.log(`  Grid optimization: ${enableGridOptimization ? 'ON' : 'OFF'}`);
        logger.log(`  Hue gap analysis: ${enableHueGapAnalysis ? 'ON' : 'OFF (respect exact color count)'}`);

        // Build tuning object from options if not provided
        // This allows presets to pass individual parameters (vibrancyBoost, highlightBoost, etc.)
        // without manually constructing the full tuning object
        const tuning = options.tuning || {
            split: {
                highlightBoost: options.highlightBoost !== undefined ? options.highlightBoost : this.TUNING.split.highlightBoost,
                vibrancyBoost: options.vibrancyBoost !== undefined ? options.vibrancyBoost : this.TUNING.split.vibrancyBoost,
                minVariance: this.TUNING.split.minVariance
            },
            prune: {
                threshold: options.paletteReduction !== undefined ? options.paletteReduction : this.TUNING.prune.threshold,
                hueLockAngle: options.hueLockAngle !== undefined ? options.hueLockAngle : this.TUNING.prune.hueLockAngle,
                whitePoint: options.highlightThreshold !== undefined ? options.highlightThreshold : this.TUNING.prune.whitePoint,
                shadowPoint: options.shadowPoint !== undefined ? options.shadowPoint : this.TUNING.prune.shadowPoint,
                isolationThreshold: options.isolationThreshold !== undefined ? options.isolationThreshold : 0.0
            },
            centroid: {
                lWeight: options.lWeight !== undefined ? options.lWeight : this.TUNING.centroid.lWeight,
                cWeight: options.cWeight !== undefined ? options.cWeight : this.TUNING.centroid.cWeight,
                blackBias: options.blackBias !== undefined ? options.blackBias : this.TUNING.centroid.blackBias,
                // Normalize bitDepth: handle "bitDepth16" string or number 16
                bitDepth: this._normalizeBitDepth(options.bitDepth),
                vibrancyMode: options.vibrancyMode || 'aggressive',  // 'aggressive', 'linear', 'exponential'
                vibrancyBoost: options.vibrancyBoost !== undefined ? options.vibrancyBoost : 2.2  // Exponential transform exponent
            }
        };

        // Log bitDepth source - either from passed tuning object or normalized from options
        const bitDepthSource = options.tuning ? 'tuning.centroid.bitDepth' : '_normalizeBitDepth(options.bitDepth)';
        logger.log(`[Tuning] bitDepth: ${tuning.centroid.bitDepth} (source: ${bitDepthSource}, options.bitDepth=${options.bitDepth}, tuning provided=${!!options.tuning})`);
        logger.log(`[Tuning] vibrancyMode: ${tuning.centroid.vibrancyMode}, vibrancyBoost: ${tuning.centroid.vibrancyBoost}`);

        // Dispatch to appropriate engine with strategy injection
        switch (engineType) {
            case 'reveal':
                return this._posterizeRevealMk1_0(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis, // Respect user setting (default: false)
                    snapThreshold,
                    strategy,
                    strategyName,  // Pass name for logging
                    tuning
                });

            case 'balanced':
                return this._posterizeBalanced(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis: false, // Always OFF for balanced
                    snapThreshold
                });

            case 'classic':
                return this._posterizeClassic(pixels, width, height, targetColors, options);

            case 'stencil':
                return this._posterizeStencil(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    grayscaleOnly: true // Force L-only
                });

            case 'lab-native':
                return this._posterizeLabNative(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis: false, // Keep it simple initially
                    strategy,
                    strategyName,
                    tuning
                });

            case 'forced-centroid':
                return this._posterizeForcedCentroid(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis: false,  // Disable for clinical mode
                    snapThreshold,
                    strategy,
                    strategyName,
                    tuning,
                    forcedCentroids: options.forcedCentroids || []  // NEW: anchor array
                });

            case 'reveal-mk1.5':
                return this._posterizeRevealMk1_5(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis: false,  // Disable for Mk 1.5
                    snapThreshold,
                    strategy,
                    strategyName,
                    tuning
                });

            default:
                logger.warn(`⚠️ Unknown engine type '${engineType}', falling back to 'reveal'`);
                return this._posterizeRevealMk1_0(pixels, width, height, targetColors, {
                    ...options,
                    enableGridOptimization,
                    enableHueGapAnalysis, // Respect user setting (default: false)
                    snapThreshold,
                    strategy,
                    strategyName,  // Pass name for logging
                    tuning
                });
        }
    }

    /**
     * Classic RGB Median Cut (internal method)
     *
     * @param {Uint8ClampedArray} pixels - RGBA pixel data (width * height * 4)
     * @param {number} width - Image width in pixels
     * @param {number} height - Image height in pixels
     * @param {number} colorCount - Target number of colors (3-9)
     * @param {string} colorDistance - Distance metric ('cielab' or 'euclidean')
     * @returns {Object} - {pixels: Uint8ClampedArray, palette: Array<{r,g,b,count}>}
     */
    static _posterizeClassicRgb(pixels, width, height, colorCount, colorDistance = 'cielab') {
        logger.log(`Posterizing ${width}x${height} image to ${colorCount} colors (distance: ${colorDistance})...`);

        // Validate inputs
        if (colorCount < 2 || colorCount > 16) {
            throw new Error(`Color count must be between 2 and 16 (got ${colorCount})`);
        }

        if (pixels.length !== width * height * 4) {
            throw new Error(`Pixel data length mismatch: expected ${width * height * 4}, got ${pixels.length}`);
        }

        // Extract unique colors and build color list
        const colorList = this._extractColors(pixels, width, height);
        logger.log(`Extracted ${colorList.length} unique colors`);

        // If image already has fewer colors than requested, return as-is
        if (colorList.length <= colorCount) {
            logger.log(`Image already has ${colorList.length} colors (≤ ${colorCount}), no quantization needed`);
            const palette = this._buildPalette(colorList);
            return { pixels: new Uint8ClampedArray(pixels), palette };
        }

        // Apply median cut algorithm to reduce colors
        const palette = this._medianCut(colorList, colorCount);
        logger.log(`Median cut produced ${palette.length} colors`);

        // Map each pixel to nearest palette color
        const posterized = this._mapToPalette(pixels, width, height, palette, colorDistance);

        return { pixels: posterized, palette };
    }

    /**
     * Analyze image and determine optimal palette size for screen printing
     *
     * Analyzes color complexity by clustering unique colors and mapping
     * cluster count to appropriate palette size (3-10 colors).
     *
     * @param {Uint8ClampedArray} pixels - RGBA pixel data (width * height * 4)
     * @param {number} width - Image width in pixels
     * @param {number} height - Image height in pixels
     * @returns {number} - Recommended palette size (3-10)
     */
    static analyzeOptimalColorCount(pixels, width, height) {
        logger.log(`Analyzing image complexity for ${width}x${height} image...`);

        // Extract unique colors
        const colors = this._extractColors(pixels, width, height);
        logger.log(`Found ${colors.length} unique colors`);

        // If very few colors, use them directly
        if (colors.length <= 3) {
            logger.log(`Image has ≤3 colors, recommending 3-color palette`);
            return 3;
        }

        // Cluster colors by MIN_DISTANCE to find distinct color regions
        const MIN_DISTANCE = 10; // CIE76 ΔE distance
        const colorList = colors.map(c => ({ r: c.r, g: c.g, b: c.b }));
        const clusters = this._getDistinctColors(colorList, MIN_DISTANCE);
        const clusterCount = clusters.length;

        logger.log(`Found ${clusterCount} distinct color clusters (MIN_DISTANCE=${MIN_DISTANCE} ΔE)`);

        // Map cluster count to palette size (tuned for screen printing workflow)
        let recommendedSize;
        if (clusterCount <= 3) {
            recommendedSize = 3;
        } else if (clusterCount <= 5) {
            recommendedSize = 4;
        } else if (clusterCount <= 8) {
            recommendedSize = 5;
        } else if (clusterCount <= 12) {
            recommendedSize = 6;
        } else if (clusterCount <= 18) {
            recommendedSize = 7;
        } else if (clusterCount <= 25) {
            recommendedSize = 8;
        } else if (clusterCount <= 35) {
            recommendedSize = 9;
        } else {
            recommendedSize = 10; // Cap at screen printing maximum
        }

        logger.log(`Recommending ${recommendedSize}-color palette (${clusterCount} clusters detected)`);
        return recommendedSize;
    }

    /**
     * Extract all colors from pixel data
     *
     * @private
     * @param {Uint8ClampedArray} pixels - RGBA pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @returns {Array<{r,g,b,count}>} - Array of unique colors with occurrence count
     */
    static _extractColors(pixels, width, height) {
        const colorMap = new Map();

        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const a = pixels[i + 3];

            // Skip fully transparent pixels
            if (a === 0) continue;

            const key = (r << 16) | (g << 8) | b;

            if (colorMap.has(key)) {
                colorMap.get(key).count++;
            } else {
                colorMap.set(key, { r, g, b, count: 1 });
            }
        }

        return Array.from(colorMap.values());
    }

    /**
     * Median cut color quantization algorithm
     *
     * Recursively splits color space into buckets, then averages each bucket.
     * Creates visually distinct colors ideal for screen printing.
     *
     * @private
     * @param {Array<{r,g,b,count}>} colors - List of unique colors
     * @param {number} targetCount - Target number of colors
     * @returns {Array<{r,g,b}>} - Palette of quantized colors
     */
    static _medianCut(colors, targetCount) {
        const MIN_DISTANCE = 12; // Minimum CIE76 ΔE distance between palette colors
        let buckets = [colors];
        let attempts = 0;
        const MAX_ATTEMPTS = 10;

        // Iteratively split and check distinctiveness until we get targetCount distinct colors
        while (attempts < MAX_ATTEMPTS) {
            attempts++;

            // Split buckets to target count (or higher to account for merging)
            // More aggressive splitting: add full attempt count to find all available colors
            const splitTarget = targetCount + attempts;
            buckets = this._splitToTarget(buckets, splitTarget);

            // Average each bucket to get candidate palette
            const candidatePalette = buckets.map(bucket => this._averageBucket(bucket));

            // Check if colors are distinct enough
            const distinctColors = this._getDistinctColors(candidatePalette, MIN_DISTANCE);

            if (distinctColors.length >= targetCount) {
                // Success! We have enough distinct colors
                logger.log(`Found ${distinctColors.length} distinct colors (target: ${targetCount}) after ${attempts} attempt(s)`);
                // Return exactly targetCount colors (keep the most important ones)
                return distinctColors.slice(0, targetCount);
            }

            logger.log(`Attempt ${attempts}: Only ${distinctColors.length} distinct colors (target: ${targetCount}), splitting further...`);
        }

        // If we couldn't reach target after MAX_ATTEMPTS, return what we have
        const finalPalette = buckets.map(bucket => this._averageBucket(bucket));
        const distinctColors = this._getDistinctColors(finalPalette, MIN_DISTANCE);
        logger.log(`After ${MAX_ATTEMPTS} attempts, returning ${distinctColors.length} distinct colors (target: ${targetCount})`);
        return distinctColors;
    }

    /**
     * Split buckets until reaching target count
     *
     * HUE-SECTOR ANCHOR PROTECTION: Inflates priority for buckets containing
     * green signals (sectors 3=Y-Green, 4=Green) to rescue minority colors
     * before they get averaged into larger volume-dominant buckets.
     *
     * Patent Claim: "Chromatic Priority Override" for minority color rescue
     *
     * @private
     * @param {Array<Array>} buckets - Current buckets
     * @param {number} targetCount - Target number of buckets
     * @returns {Array<Array>} - Split buckets
     */
    static _splitToTarget(buckets, targetCount) {
        const workingBuckets = [...buckets];

        // Protected hue sectors: Y-Green (3) and Green (4) = 90-150°
        const PROTECTED_SECTORS = [3, 4];
        const HUE_PRIORITY_MULTIPLIER = 10.0;

        while (workingBuckets.length < targetCount) {
            // Find bucket with highest priority (range × hue multiplier)
            let maxPriority = 0;
            let maxBucketIndex = 0;
            let maxChannel = 'r';

            workingBuckets.forEach((bucket, index) => {
                const ranges = this._getColorRanges(bucket);
                const widestChannel = ranges.widest.channel;
                const widestRange = ranges.widest.range;

                // Base priority is the widest range
                let priority = widestRange;

                // HUE-SECTOR ANCHOR PROTECTION: Check for protected hue sectors
                // If bucket contains green signal, inflate priority to force split
                for (const sector of PROTECTED_SECTORS) {
                    if (this._checkBucketForHueSector(bucket, sector, 2)) {
                        priority *= HUE_PRIORITY_MULTIPLIER;
                        logger.log(`[Green Rescue] 🌿 Found hue sector ${sector} in bucket ${index} - inflating priority ${HUE_PRIORITY_MULTIPLIER}×`);
                        break; // Only multiply once
                    }
                }

                if (priority > maxPriority) {
                    maxPriority = priority;
                    maxBucketIndex = index;
                    maxChannel = widestChannel;
                }
            });

            // If no bucket has range > 0, we can't split further
            if (maxPriority === 0) {
                break;
            }

            // Split the bucket with highest priority
            const bucketToSplit = workingBuckets[maxBucketIndex];
            const [bucket1, bucket2] = this._splitBucket(bucketToSplit, maxChannel);

            // Replace original bucket with two new buckets
            workingBuckets.splice(maxBucketIndex, 1, bucket1, bucket2);
        }

        return workingBuckets;
    }

    /**
     * Get distinct colors by removing colors that are too similar
     *
     * Uses greedy approach: keep first color, remove all similar colors, repeat.
     * Colors sorted by luminance so darker colors are preferred.
     *
     * @private
     * @param {Array<{r,g,b}>} palette - Candidate palette
     * @param {number} minDistance - Minimum distance between colors
     * @returns {Array<{r,g,b}>} - Distinct colors only
     */
    static _getDistinctColors(palette, minDistance) {
        // Sort by luminance (darker to lighter)
        const sorted = [...palette].sort((a, b) => {
            const lumA = 0.299 * a.r + 0.587 * a.g + 0.114 * a.b;
            const lumB = 0.299 * b.r + 0.587 * b.g + 0.114 * b.b;
            return lumA - lumB;
        });

        const distinct = [];
        const used = new Set();

        for (let i = 0; i < sorted.length; i++) {
            if (used.has(i)) continue;

            const color = sorted[i];
            distinct.push(color);

            // Mark similar colors as used
            for (let j = i + 1; j < sorted.length; j++) {
                if (used.has(j)) continue;

                const other = sorted[j];
                const distance = this._colorDistance(color, other);

                if (distance < minDistance) {
                    used.add(j);
                }
            }
        }

        return distinct;
    }

    /**
     * REVELATION HEURISTIC: Density Floor
     * Prunes palette colors with < 0.5% coverage and reassigns pixels.
     * This treats targetColorCount as a HINT rather than a mandate.
     *
     * @private
     * @param {Uint8Array} assignments - Pixel-to-palette index mappings
     * @param {Array<{L, a, b}>} palette - Lab palette
     * @param {number} threshold - Minimum coverage threshold (default: 0.005 = 0.5%)
     * @param {Set<number>} protectedIndices - Indices that should never be removed (preserved colors, substrate)
     * @returns {Object} - {palette, assignments, actualCount}
     */
    static _applyDensityFloor(assignments, palette, threshold = 0.005, protectedIndices = new Set()) {
        // Input validation
        if (!assignments || !palette || palette.length === 0) {
            logger.log('⚠️ Density floor: Invalid input, skipping');
            return { palette, assignments, actualCount: palette.length };
        }

        const totalPixels = assignments.length;
        const counts = new Array(palette.length).fill(0);

        // Count pixel occupancy for each palette color (skip transparent pixels = 255)
        for (let i = 0; i < totalPixels; i++) {
            const idx = assignments[i];

            // Skip transparent pixels (special value 255)
            if (idx === 255) {
                continue;
            }

            // Validate index bounds
            if (idx < 0 || idx >= palette.length) {
                logger.log(`⚠️ Density floor: Invalid assignment index ${idx} at pixel ${i}, skipping`);
                continue;
            }

            counts[idx]++;
        }

        // Find indices of colors that meet the threshold (or are protected with actual pixels)
        const viableIndices = [];
        counts.forEach((count, i) => {
            const coverage = count / totalPixels;

            // Protected indices (preserved colors, substrate) are kept ONLY if they have pixels
            if (protectedIndices.has(i)) {
                if (count > 0) {
                    // Protected color with actual pixel assignments - keep it
                    viableIndices.push(i);
                } else {
                    // Protected color with 0% coverage - remove it (creates empty mask)
                    logger.log(`Pruning protected "Ghost" color: Index ${i} (Coverage: 0.00%) - no pixels assigned`);
                }
                return;
            }

            // Non-protected colors must meet threshold
            if (coverage >= threshold) {
                viableIndices.push(i);
            } else {
                logger.log(`Pruning "Ghost" color: Index ${i} (Coverage: ${(coverage * 100).toPrecision(2)}%)`);
            }
        });

        // If all colors are viable, return original data
        if (viableIndices.length === palette.length) {
            return { palette, assignments, actualCount: palette.length };
        }

        // Edge case: All colors pruned (shouldn't happen in practice)
        if (viableIndices.length === 0) {
            logger.log('⚠️ Density floor: All colors pruned (edge case), keeping original palette');
            return { palette, assignments, actualCount: palette.length };
        }

        // Create the new, pruned palette
        const cleanPalette = viableIndices.map(idx => palette[idx]);
        const remappedAssignments = new Uint8Array(totalPixels);

        // Re-allocate pixels (preserve transparent pixels)
        for (let i = 0; i < totalPixels; i++) {
            const oldIdx = assignments[i];

            // Preserve transparent pixels (special value 255)
            if (oldIdx === 255) {
                remappedAssignments[i] = 255;
                continue;
            }

            // Validate index bounds
            if (oldIdx < 0 || oldIdx >= palette.length) {
                // Fallback: assign to first color in clean palette
                remappedAssignments[i] = 0;
                continue;
            }

            const newIdxInClean = viableIndices.indexOf(oldIdx);

            if (newIdxInClean !== -1) {
                // Pixel belongs to a survivor
                remappedAssignments[i] = newIdxInClean;
            } else {
                // Pixel belongs to a pruned color; find the nearest SURVIVING color
                const targetColor = palette[oldIdx];
                if (targetColor && cleanPalette.length > 0) {
                    remappedAssignments[i] = this._findNearestInPalette(targetColor, cleanPalette);
                } else {
                    // Fallback: assign to first color
                    remappedAssignments[i] = 0;
                }
            }
        }

        return {
            palette: cleanPalette,
            assignments: remappedAssignments,
            actualCount: cleanPalette.length
        };
    }

    /**
     * Helper to find the nearest color in a specific subset of the palette
     *
     * @private
     * @param {{L, a, b}} targetLab - Target Lab color
     * @param {Array<{L, a, b}>} subPalette - Subset of palette to search
     * @returns {number} - Index of nearest color in subPalette
     */
    static _findNearestInPalette(targetLab, subPalette) {
        // Input validation
        if (!targetLab || !subPalette || subPalette.length === 0) {
            return 0;  // Fallback to first color
        }

        let minDistance = Infinity;
        let closestIdx = 0;

        for (let i = 0; i < subPalette.length; i++) {
            const p = subPalette[i];
            if (!p) continue;  // Skip invalid entries

            // Standard Euclidean distance in Lab space
            const d = Math.sqrt(
                Math.pow(targetLab.L - p.L, 2) +
                Math.pow(targetLab.a - p.a, 2) +
                Math.pow(targetLab.b - p.b, 2)
            );
            if (d < minDistance) {
                minDistance = d;
                closestIdx = i;
            }
        }
        return closestIdx;
    }


    /**
     * Convert RGB to CIELAB color space (D65 illuminant, 2° observer)
     *
     * CIELAB is perceptually uniform - equal distances in LAB space correspond
     * to equal perceived color differences. Much better than RGB Euclidean distance.
     *
     * @private
     * @param {number} r - Red (0-255)
     * @param {number} g - Green (0-255)
     * @param {number} b - Blue (0-255)
     * @returns {{L: number, a: number, b: number}} - LAB values (L: 0-100, a: -128 to 127, b: -128 to 127)
     */
    static _rgbToLab(r, g, b) {
        // Step 1: RGB [0-255] → RGB [0-1]
        let R = r / 255;
        let G = g / 255;
        let B = b / 255;

        // Step 2: Apply gamma correction (sRGB → linear RGB)
        R = (R > 0.04045) ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
        G = (G > 0.04045) ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
        B = (B > 0.04045) ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;

        // Step 3: Linear RGB → XYZ (D65 illuminant matrix)
        let X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
        let Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
        let Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;

        // Step 4: Normalize to D65 white point
        X = X / 0.95047;
        Y = Y / 1.00000;
        Z = Z / 1.08883;

        // Step 5: XYZ → LAB
        const epsilon = 0.008856;
        const kappa = 903.3;

        const fx = (X > epsilon) ? Math.pow(X, 1/3) : (kappa * X + 16) / 116;
        const fy = (Y > epsilon) ? Math.pow(Y, 1/3) : (kappa * Y + 16) / 116;
        const fz = (Z > epsilon) ? Math.pow(Z, 1/3) : (kappa * Z + 16) / 116;

        const L = 116 * fy - 16;
        const a = 500 * (fx - fy);
        const b_lab = 200 * (fy - fz);

        return { L, a, b: b_lab };
    }

    /**
     * Calculate perceptual distance between two colors using CIE76 (CIELAB ΔE)
     *
     * More perceptually accurate than RGB Euclidean distance. Better handles
     * dark/light colors and matches human vision sensitivity.
     *
     * Scale: 0-2 = imperceptible, 5-10 = noticeable, 10+ = clearly different
     *
     * @private
     * @param {{r,g,b}} color1 - First color
     * @param {{r,g,b}} color2 - Second color
     * @returns {number} - Delta E (ΔE) distance
     */
    static _colorDistance(color1, color2) {
        const lab1 = this._rgbToLab(color1.r, color1.g, color1.b);
        const lab2 = this._rgbToLab(color2.r, color2.g, color2.b);

        const dL = lab1.L - lab2.L;
        const da = lab1.a - lab2.a;
        const db = lab1.b - lab2.b;

        return Math.sqrt(dL * dL + da * da + db * db);
    }

    /**
     * Get color ranges (min/max) for each channel in a bucket
     *
     * @private
     * @param {Array<{r,g,b,count}>} bucket - Colors in bucket
     * @returns {Object} - {r: {min, max, range}, g: {...}, b: {...}, widest: {channel, range}}
     */
    /**
     * Get perceptual color ranges in Lab space (ARCHITECT'S IMPROVEMENT)
     * @private
     * @param {Array<{r,g,b,count}>} bucket - Colors to analyze
     * @returns {Object} - Lab ranges with widest channel
     */
    static _getColorRanges(bucket) {
        // Convert all colors to Lab first
        const labColors = bucket.map(color => ({
            ...this._rgbToLab(color.r, color.g, color.b),
            count: color.count
        }));

        let lMin = 100, lMax = 0;
        let aMin = 128, aMax = -128;
        let bMin = 128, bMax = -128;

        labColors.forEach(lab => {
            lMin = Math.min(lMin, lab.L);
            lMax = Math.max(lMax, lab.L);
            aMin = Math.min(aMin, lab.a);
            aMax = Math.max(aMax, lab.a);
            bMin = Math.min(bMin, lab.b);
            bMax = Math.max(bMax, lab.b);
        });

        const lRange = lMax - lMin;
        const aRange = aMax - aMin;
        const bRange = bMax - bMin;

        // Find widest range (use Lab channel names)
        let widest = { channel: 'L', range: lRange };
        if (aRange > widest.range) widest = { channel: 'a', range: aRange };
        if (bRange > widest.range) widest = { channel: 'b', range: bRange };

        return {
            L: { min: lMin, max: lMax, range: lRange },
            a: { min: aMin, max: aMax, range: aRange },
            b: { min: bMin, max: bMax, range: bRange },
            widest,
            labColors // Return Lab colors for splitting
        };
    }

    /**
     * Split a bucket into two at the median of the specified Lab channel
     * (ARCHITECT'S IMPROVEMENT)
     *
     * @private
     * @param {Array<{r,g,b,count}>} bucket - Colors to split (RGB format)
     * @param {string} channel - Lab channel to split on ('L', 'a', or 'b')
     * @returns {Array<Array>} - [bucket1, bucket2] in RGB format
     */
    static _splitBucket(bucket, channel) {
        // Convert to Lab for sorting
        const labBucket = bucket.map(color => {
            const lab = this._rgbToLab(color.r, color.g, color.b);
            return {
                rgb: { r: color.r, g: color.g, b: color.b },
                count: color.count,
                lab: { L: lab.L, a: lab.a, b: lab.b }
            };
        });

        // Sort by Lab channel value
        const sorted = labBucket.sort((a, b) => a.lab[channel] - b.lab[channel]);

        // Split at median (weighted by pixel count)
        const totalPixels = sorted.reduce((sum, color) => sum + color.count, 0);
        let pixelSum = 0;
        let medianIndex = 0;

        for (let i = 0; i < sorted.length; i++) {
            pixelSum += sorted[i].count;
            if (pixelSum >= totalPixels / 2) {
                medianIndex = i;
                break;
            }
        }

        // Ensure we don't create empty buckets
        if (medianIndex === 0) medianIndex = 1;
        if (medianIndex === sorted.length) medianIndex = sorted.length - 1;

        // Return in original RGB format (strip Lab values)
        return [
            sorted.slice(0, medianIndex).map(c => ({ r: c.rgb.r, g: c.rgb.g, b: c.rgb.b, count: c.count })),
            sorted.slice(medianIndex).map(c => ({ r: c.rgb.r, g: c.rgb.g, b: c.rgb.b, count: c.count }))
        ];
    }

    /**
     * HUE-SECTOR ANCHOR PROTECTION: Check if bucket contains a specific hue sector
     *
     * This helper allows the engine to "see" chromatic signals (like green foliage)
     * before they get averaged into larger, volume-dominant buckets.
     *
     * Patent Claim: "Chromatic Priority Override" for minority color rescue
     *
     * @private
     * @param {Array<{r,g,b,count}>} bucket - Colors to check (RGB format)
     * @param {number} targetSector - Hue sector (0-11, where 4=Green 120-150°)
     * @param {number} [chromaThreshold=2] - Minimum chroma to count as signal
     * @returns {boolean} - True if bucket contains the target hue sector
     */
    static _checkBucketForHueSector(bucket, targetSector, chromaThreshold = 2) {
        // Sample up to 200 colors for efficiency
        const sampleSize = Math.min(bucket.length, 200);
        const step = Math.max(1, Math.floor(bucket.length / sampleSize));

        for (let i = 0; i < bucket.length; i += step) {
            const color = bucket[i];
            const lab = this._rgbToLab(color.r, color.g, color.b);

            // Calculate chroma (distance from neutral axis)
            const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);

            // Skip near-neutral colors
            if (chroma < chromaThreshold) continue;

            // Calculate hue angle in degrees (0-360)
            const hue = Math.atan2(lab.b, lab.a) * 180 / Math.PI;
            const normHue = hue < 0 ? hue + 360 : hue;

            // Determine sector (12 sectors, 30° each)
            const sector = Math.floor(normHue / 30) % 12;

            if (sector === targetSector) {
                return true;
            }
        }
        return false;
    }

    /**
     * Average all colors in a bucket to produce one representative color
     *
     * ARCHITECT'S IMPROVEMENT: Average in Lab space with vibrancy boost
     * - Converts RGB to Lab for perceptual averaging
     * - Applies chroma-based weighting: saturated colors count 2-3x more
     * - Converts back to RGB
     *
     * @private
     * @param {Array<{r,g,b,count}>} bucket - Colors to average
     * @returns {{r,g,b}} - Average color
     */
    static _averageBucket(bucket) {
        let totalWeight = 0;
        let sumL = 0, sumA = 0, sumB = 0;

        bucket.forEach(color => {
            const lab = this._rgbToLab(color.r, color.g, color.b);

            // Calculate chroma (saturation)
            const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);

            // VIBRANCY BOOST: Saturated colors count for 2x or 3x weight
            // weight = pixel_count × (1 + chroma/50)
            // Example: Gray (C=0) → 1.0x, Saturated (C=50) → 2.0x
            const weight = color.count * (1 + (chroma / 50));

            sumL += lab.L * weight;
            sumA += lab.a * weight;
            sumB += lab.b * weight;
            totalWeight += weight;
        });

        // Average in Lab space
        const avgLab = {
            L: sumL / totalWeight,
            a: sumA / totalWeight,
            b: sumB / totalWeight
        };

        // Convert back to RGB
        return this.labToRgb(avgLab);
    }

    /**
     * Map each pixel to nearest color in palette
     *
     * @private
     * @param {Uint8ClampedArray} pixels - Original RGBA pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Array<{r,g,b}>} palette - Target color palette
     * @returns {Uint8ClampedArray} - Posterized RGBA pixel data
     */
    static _mapToPalette(pixels, width, height, palette, colorDistance = 'cielab') {
        const result = new Uint8ClampedArray(pixels.length);

        // Pre-convert palette to LAB if using CIELAB distance
        const paletteLAB = colorDistance === 'cielab'
            ? palette.map(c => this._rgbToLab(c.r, c.g, c.b))
            : null;

        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const a = pixels[i + 3];

            // Preserve fully transparent pixels
            if (a === 0) {
                result[i] = 0;
                result[i + 1] = 0;
                result[i + 2] = 0;
                result[i + 3] = 0;
                continue;
            }

            // Find nearest palette color using selected distance method
            let minDistance = Infinity;
            let nearestColor = palette[0];

            if (colorDistance === 'cielab') {
                // CIELAB (CIE76) distance - perceptually uniform
                const pixelLAB = this._rgbToLab(r, g, b);

                palette.forEach((paletteColor, index) => {
                    const colorLAB = paletteLAB[index];
                    const dL = pixelLAB.L - colorLAB.L;
                    const da = pixelLAB.a - colorLAB.a;
                    const db = pixelLAB.b - colorLAB.b;
                    const distance = Math.sqrt(dL * dL + da * da + db * db);

                    if (distance < minDistance) {
                        minDistance = distance;
                        nearestColor = paletteColor;
                    }
                });
            } else {
                // RGB Euclidean distance - fast but less accurate
                palette.forEach(paletteColor => {
                    const dr = r - paletteColor.r;
                    const dg = g - paletteColor.g;
                    const db = b - paletteColor.b;
                    const distance = dr * dr + dg * dg + db * db;

                    if (distance < minDistance) {
                        minDistance = distance;
                        nearestColor = paletteColor;
                    }
                });
            }

            // Write nearest color
            result[i] = nearestColor.r;
            result[i + 1] = nearestColor.g;
            result[i + 2] = nearestColor.b;
            result[i + 3] = a;
        }

        return result;
    }

    /**
     * Build palette array from color list (for when no quantization needed)
     *
     * @private
     * @param {Array<{r,g,b,count}>} colors - Color list
     * @returns {Array<{r,g,b}>} - Palette (without count)
     */
    static _buildPalette(colors) {
        return colors.map(c => ({ r: c.r, g: c.g, b: c.b }));
    }

    /**
     * Convert palette to hex color strings for display
     *
     * @param {Array<{r,g,b}>} palette - Color palette
     * @returns {Array<string>} - Array of hex color strings (e.g., ["#FF0000", "#00FF00"])
     */
    static paletteToHex(palette) {
        return palette.map(color => {
            const r = color.r.toString(16).padStart(2, '0');
            const g = color.g.toString(16).padStart(2, '0');
            const b = color.b.toString(16).padStart(2, '0');
            return `#${r}${g}${b}`.toUpperCase();
        });
    }

    /**
     * Calculate perceptual distance (CIE76 ΔE) between two hex colors
     *
     * Used for real-time validation in the palette editor. Returns ΔE distance
     * where values < 12 indicate colors that are too perceptually similar.
     *
     * @param {string} hex1 - First color (e.g., "#FF0000")
     * @param {string} hex2 - Second color (e.g., "#FE0000")
     * @returns {number} - CIE76 ΔE distance (0 = identical, >12 = distinct)
     */
    static calculateHexDistance(hex1, hex2) {
        // Parse hex colors to RGB
        const rgb1 = {
            r: parseInt(hex1.slice(1, 3), 16),
            g: parseInt(hex1.slice(3, 5), 16),
            b: parseInt(hex1.slice(5, 7), 16)
        };
        const rgb2 = {
            r: parseInt(hex2.slice(1, 3), 16),
            g: parseInt(hex2.slice(3, 5), 16),
            b: parseInt(hex2.slice(5, 7), 16)
        };

        // Use existing color distance calculation
        return this._colorDistance(rgb1, rgb2);
    }

    // ========================================================================
    // Lab-Space Posterization + Perceptual Snap (Editorial Engine)
    // ========================================================================

    /**
     * Convert sRGB color to CIELAB color space
     *
     * Pipeline: sRGB → Linear RGB → XYZ → CIELAB
     * Uses D65 illuminant and sRGB color space matrices
     *
     * @param {Object} rgb - {r: 0-255, g: 0-255, b: 0-255}
     * @returns {Object} lab - {L: 0-100, a: -128 to 127, b: -128 to 127}
     */
    static rgbToLab(rgb) {
        // Step 1: sRGB to Linear RGB (inverse gamma correction)
        const r = this._gammaToLinear(rgb.r / 255);
        const g = this._gammaToLinear(rgb.g / 255);
        const b = this._gammaToLinear(rgb.b / 255);

        // Step 2: Linear RGB to XYZ (using sRGB matrix)
        let x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
        let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
        let z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;

        // Step 3: Normalize by D65 illuminant
        x = x / 0.95047;
        y = y / 1.00000;
        z = z / 1.08883;

        // Step 4: XYZ to Lab (CIE 1976)
        x = this._xyzToLabHelper(x);
        y = this._xyzToLabHelper(y);
        z = this._xyzToLabHelper(z);

        const L = 116 * y - 16;
        const a = 500 * (x - y);
        const b_value = 200 * (y - z);

        return { L, a, b: b_value };
    }

    /**
     * Convert CIELAB color to sRGB color space
     *
     * Pipeline: CIELAB → XYZ → Linear RGB → sRGB
     * Uses D65 illuminant and sRGB color space matrices
     *
     * @param {Object} lab - {L: 0-100, a: -128 to 127, b: -128 to 127}
     * @returns {Object} rgb - {r: 0-255, g: 0-255, b: 0-255}
     */
    static labToRgb(lab) {
        // GAMUT MAPPING: If Lab color is out of sRGB gamut, reduce chroma while preserving hue
        // This prevents yellow → orange shifts caused by hard clipping
        const MAX_ITERATIONS = 20;
        let currentLab = { L: lab.L, a: lab.a, b: lab.b };
        let iteration = 0;
        let inGamut = false;

        while (!inGamut && iteration < MAX_ITERATIONS) {
            // Step 1: Lab to XYZ
            let y = (currentLab.L + 16) / 116;
            let x = currentLab.a / 500 + y;
            let z = y - currentLab.b / 200;

            x = this._labToXyzHelper(x) * 0.95047;
            y = this._labToXyzHelper(y) * 1.00000;
            z = this._labToXyzHelper(z) * 1.08883;

            // Step 2: XYZ to Linear RGB
            let r = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
            let g = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
            let b = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

            // Step 3: Linear RGB to sRGB (gamma correction)
            r = this._linearToGamma(r);
            g = this._linearToGamma(g);
            b = this._linearToGamma(b);

            // Check if in gamut (all channels 0-1 range)
            if (r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1) {
                inGamut = true;
                // Step 4: Scale to 0-255
                return {
                    r: Math.round(r * 255),
                    g: Math.round(g * 255),
                    b: Math.round(b * 255)
                };
            }

            // Out of gamut: Reduce chroma by 5% while preserving hue
            currentLab.a *= 0.95;
            currentLab.b *= 0.95;
            iteration++;
        }

        // Fallback: If still out of gamut after iterations, clamp
        let y = (currentLab.L + 16) / 116;
        let x = currentLab.a / 500 + y;
        let z = y - currentLab.b / 200;

        x = this._labToXyzHelper(x) * 0.95047;
        y = this._labToXyzHelper(y) * 1.00000;
        z = this._labToXyzHelper(z) * 1.08883;

        let r = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
        let g = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
        let b = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;

        r = this._linearToGamma(r);
        g = this._linearToGamma(g);
        b = this._linearToGamma(b);

        // Clamp and scale to 0-255
        r = Math.max(0, Math.min(255, Math.round(r * 255)));
        g = Math.max(0, Math.min(255, Math.round(g * 255)));
        b = Math.max(0, Math.min(255, Math.round(b * 255)));

        return { r, g, b };
    }

    /**
     * Auto-detect substrate color from image corners (preview resolution)
     *
     * Samples 10×10 pixel blocks from each of the 4 corners (400 pixels total)
     * to establish substrate baseline. Corners typically contain background/substrate.
     *
     * This runs on preview resolution (800×800) for performance, with the detected
     * substrate color then applied to both preview and full-resolution processing.
     *
     * @param {Uint8Array} labBytes - Raw Lab bytes (0-255 encoding from UXP)
     * @param {number} width - Preview width (typically 800px)
     * @param {number} height - Preview height
     * @returns {{L: number, a: number, b: number}} Lab color in perceptual ranges
     *          (L: 0-100, a: -128 to +127, b: -128 to +127)
     */
    static autoDetectSubstrate(labBytes, width, height, bitDepth = 16) {
        const SAMPLE_SIZE = 10; // 10×10 blocks per corner
        let sumL = 0, sumA = 0, sumB = 0, count = 0;

        // Engine ONLY accepts 16-bit Lab input (callers convert 8-bit → 16-bit before calling)
        // bitDepth parameter is kept for logging but data is always 16-bit
        const maxValue = 32768;
        const neutralAB = 16384;
        const abScale = 128 / 16384;

        // Helper: Sample single pixel and accumulate
        const sample = (x, y) => {
            const i = (y * width + x) * 3;
            // Convert 16-bit Lab to perceptual ranges
            sumL += (labBytes[i] / maxValue) * 100;
            sumA += (labBytes[i + 1] - neutralAB) * abScale;
            sumB += (labBytes[i + 2] - neutralAB) * abScale;
            count++;
        };

        // Sample all 4 corners (10×10 each = 400 pixels total)
        for (let y = 0; y < SAMPLE_SIZE; y++) {
            for (let x = 0; x < SAMPLE_SIZE; x++) {
                sample(x, y);                              // Top-left
                sample(width - 1 - x, y);                  // Top-right
                sample(x, height - 1 - y);                 // Bottom-left
                sample(width - 1 - x, height - 1 - y);     // Bottom-right
            }
        }

        const detectedSubstrate = {
            L: sumL / count,
            a: sumA / count,
            b: sumB / count
        };

        logger.log(`✓ Substrate detected: L=${detectedSubstrate.L.toFixed(1)} a=${detectedSubstrate.a.toFixed(1)} b=${detectedSubstrate.b.toFixed(1)}`);

        return detectedSubstrate;
    }

    /**
     * sRGB gamma correction (inverse): sRGB → Linear RGB
     * @private
     */
    static _gammaToLinear(channel) {
        if (channel <= 0.04045) {
            return channel / 12.92;
        } else {
            return Math.pow((channel + 0.055) / 1.055, 2.4);
        }
    }

    /**
     * sRGB gamma correction (forward): Linear RGB → sRGB
     * @private
     */
    static _linearToGamma(channel) {
        if (channel <= 0.0031308) {
            return channel * 12.92;
        } else {
            return 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
        }
    }

    /**
     * XYZ to Lab helper function (CIE standard function)
     * @private
     */
    static _xyzToLabHelper(t) {
        const delta = 6 / 29;
        if (t > delta * delta * delta) {
            return Math.pow(t, 1 / 3);
        } else {
            return t / (3 * delta * delta) + 4 / 29;
        }
    }

    /**
     * Lab to XYZ helper function (CIE standard function inverse)
     * @private
     */
    static _labToXyzHelper(t) {
        const delta = 6 / 29;
        if (t > delta) {
            return t * t * t;
        } else {
            return 3 * delta * delta * (t - 4 / 29);
        }
    }

    /**
     * Calculate CIELAB ΔE SQUARED distance with L-channel emphasis (CIE76 modified)
     *
     * Over-weights the L (Lightness) channel to emphasize tonal contrast,
     * which creates the "bones" of the image in screen printing separations.
     * Shadows and highlights define subject structure.
     *
     * Performance: Returns SQUARED distance (no sqrt) - sufficient for comparisons.
     * When comparing distances, sqrt is unnecessary since sqrt(a) < sqrt(b) ⟺ a < b.
     *
     * Formula: ΔE² = 1.5*dL² + da² + db²
     * Standard CIE76: ΔE = sqrt(dL² + da² + db²)
     *
     * @param {Object} lab1 - {L, a, b}
     * @param {Object} lab2 - {L, a, b}
     * @returns {number} distanceSquared - Perceptual distance squared (L-weighted)
     */
    static calculateCIELABDistance(lab1, lab2, isGrayscale = false) {
        const deltaL = lab1.L - lab2.L;
        const deltaA = lab1.a - lab2.a;
        const deltaB = lab1.b - lab2.b;

        // Luma-aware weighting per Architect guidance:
        // Grayscale: L_WEIGHT = 3.0 (human vision extremely sensitive to luma steps)
        // Color: L_WEIGHT = 1.5 (balanced tonal structure)
        const L_WEIGHT = isGrayscale ? 3.0 : 1.5;

        // Return squared distance (no sqrt) - faster and sufficient for comparisons
        return L_WEIGHT * deltaL * deltaL + deltaA * deltaA + deltaB * deltaB;
    }

    /**
     * Apply perceptual snap threshold to collapse similar colors
     *
     * Philosophy: "The engine actively curates by removing subtle noise
     * and highlighting core structures (Fidelity to Feature)"
     *
     * @param {Array} palette - Array of Lab colors: [{L, a, b}, ...]
     * @param {number} threshold - ΔE threshold (default 8.0) - regular distance, will be squared for comparison
     * @param {boolean} isGrayscale - Grayscale mode flag
     * @param {number} vibrancyMultiplier - Vibrancy boost multiplier (deprecated, kept for compatibility)
     * @param {Function} strategy - Centroid strategy function
     * @param {Object} tuning - Tuning parameters for centroid calculation
     * @returns {Array} snappedPalette - Curated palette with similar colors merged
     */
    static applyPerceptualSnap(palette, threshold = 8.0, isGrayscale = false, vibrancyMultiplier = 2.0, strategy = null, tuning = null) {
        if (palette.length <= 1) {
            return palette;
        }

        const snapped = [];
        const merged = new Set();
        let totalMerged = 0;

        // Square the threshold for comparison with squared distances
        const thresholdSquared = threshold * threshold;

        for (let i = 0; i < palette.length; i++) {
            if (merged.has(i)) continue;

            // Start a new feature group with this color
            const featureGroup = [palette[i]];
            const featureIndices = [i];

            // Find all colors within snap threshold (using luma-aware distance)
            for (let j = i + 1; j < palette.length; j++) {
                if (merged.has(j)) continue;

                const deltaESquared = this.calculateCIELABDistance(palette[i], palette[j], isGrayscale);

                if (deltaESquared < thresholdSquared) {
                    featureGroup.push(palette[j]);
                    featureIndices.push(j);
                    merged.add(j);
                    totalMerged++;
                }
            }

            // Merge feature group into single representative color (centroid)
            const representative = this._calculateLabCentroid(featureGroup, isGrayscale, strategy, tuning);
            snapped.push(representative);

            if (featureGroup.length > 1) {
                logger.log(`Perceptual snap: Merged ${featureGroup.length} colors at indices [${featureIndices.join(',')}] (ΔE < ${threshold})`);
            }
        }

        if (totalMerged > 0) {
            logger.log(`✓ Perceptual snap: Collapsed ${totalMerged} similar colors (${palette.length} → ${snapped.length})`);
        } else {
            logger.log(`✓ Perceptual snap: All colors distinct (no merging needed)`);
        }

        return snapped;
    }

    /**
     * Calculate representative color for a group of colors in Lab space
     *
     * Grayscale mode: Average L (neutral gray)
     * Color mode: Pick MOST SATURATED color (highest chroma)
     *
     * @private
     */
    /**
     * STRATEGY-AWARE CENTROID CALCULATION
     *
     * Uses injected strategy to determine representative color for a bucket.
     * Falls back to VOLUMETRIC if no strategy provided (backward compatibility).
     *
     * @private
     * @param {Array} colors - Bucket colors
     * @param {boolean} grayscaleOnly - L-channel only mode
     * @param {Function} strategy - Centroid strategy function
     * @param {Object} tuning - Tuning parameters
     * @returns {{L: number, a: number, b: number}} - Representative color
     */
    static _calculateLabCentroid(colors, grayscaleOnly = false, strategy = null, tuning = null) {
        // Safety check: empty colors array
        if (!colors || colors.length === 0) {
            return { L: 50, a: 0, b: 0 }; // Neutral gray fallback
        }

        // Use injected strategy or fallback to VOLUMETRIC
        const centroidStrategy = strategy || CentroidStrategies.VOLUMETRIC;
        const weights = tuning ? tuning.centroid : this.TUNING.centroid;

        // Safety check: ensure strategy is a function
        if (typeof centroidStrategy !== 'function') {
            logger.warn(`⚠️ Invalid centroid strategy (not a function), falling back to VOLUMETRIC`);
            return CentroidStrategies.VOLUMETRIC(colors, weights);
        }

        if (grayscaleOnly) {
            // Grayscale mode: Use strategy but force a=b=0
            const result = centroidStrategy(colors, weights);
            return { L: result.L, a: 0, b: 0 };
        } else {
            // Color mode: Use strategy as-is
            return centroidStrategy(colors, weights);
        }
    }

    /**
     * HUE-AWARE PRIORITY MULTIPLIER: Maps Lab a/b coordinates to one of 12 hue sectors (30° each)
     *
     * Part of the Architect's "Hue Hunger" logic - enables priority multiplier to identify
     * which hue sectors exist in the image and which are covered by the current palette.
     *
     * Sector mapping (30° each):
     *  0: Red (0-30°)       6: Blue (180-210°)
     *  1: Orange (30-60°)   7: B-Purple (210-240°)
     *  2: Yellow (60-90°)   8: Purple (240-270°)
     *  3: Y-Green (90-120°) 9: Magenta (270-300°)
     *  4: Green (120-150°)  10: Pink (300-330°)
     *  5: Cyan (150-180°)   11: R-Pink (330-360°)
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
     * HUE-AWARE PRIORITY MULTIPLIER: Calculate metadata for median cut box
     *
     * Computes mean Lab values, hue sector, and variance for a box.
     * Used by priority calculator to determine split priority.
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
        const { colors } = box;

        if (colors.length === 0) {
            return { meanL: 0, meanA: 0, meanB: 0, sector: -1, variance: 0 };
        }

        // Use centralized tuning or fallback to defaults
        const config = tuning || this.TUNING;

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
            logger.log(`[Highlight Protection] ✨ Bright area detected (L=${meanL.toFixed(1)}) - ${highlightBoostValue}× boost applied`);
        }

        const baseVariance = grayscaleOnly ? varL : (varL + varA + varB);
        const variance = baseVariance * finalBoost;

        const sector = grayscaleOnly ? -1 : this._getHueSector(meanA, meanB);

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
                logger.log(`[Green Peek] Found color in sector ${sector}: L=${c.L.toFixed(1)}, a=${c.a.toFixed(1)}, b=${c.b.toFixed(1)}, chroma=${chroma.toFixed(1)}, hue=${normHue.toFixed(0)}°`);
                return true;
            }

            // ADDITIONAL CHECK: Any color with negative a* and positive b* is green-ish
            // This catches greens that might be classified in adjacent sectors
            if (c.a < -3 && c.b > 0 && chroma > 3) {
                logger.log(`[Green Peek] Found green-axis color: L=${c.L.toFixed(1)}, a=${c.a.toFixed(1)}, b=${c.b.toFixed(1)}, chroma=${chroma.toFixed(1)}`);
                return true;
            }
        }

        // Log diagnostic info if no green found
        if (lowChromaSkips > sampleSize * 0.8) {
            logger.log(`[Green Peek] Box has mostly low-chroma colors (${lowChromaSkips}/${sampleSize} skipped, threshold=${chromaThreshold})`);
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
                logger.log(`[Green Peek] Checking box with ${box.colors.length} colors (threshold=${GREEN_PEEK_THRESHOLD}, greenEnergy=${greenEnergy.toFixed(1)}%)`);
                const hasGreenSignal = this._boxContainsHueSector(box.colors, [3, 4], GREEN_PEEK_THRESHOLD);

                if (hasGreenSignal && greenEnergy > 0.1) {
                    multiplier = GREEN_PEEK_MULTIPLIER;
                    logger.log(`[Green Peek] 🌿 Box contains hidden green signal (${greenEnergy.toFixed(1)}% image energy) - ${multiplier}× boost`);
                    return basePriority * multiplier;  // Early return with boost
                } else if (hasGreenSignal) {
                    logger.log(`[Green Peek] ⚠️ Green signal found but image greenEnergy too low (${greenEnergy.toFixed(1)}%)`);
                }
            } else {
                logger.log(`[Green Peek] Skipped - green sectors already covered (3:${greenSector3Covered}, 4:${greenSector4Covered})`);
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
                    logger.log(`[Red Rescue] 🔴 Forcing split on Red bucket (${sourceEnergy.toFixed(1)}% energy) - ${multiplier}× boost`);
                } else if (isArchiveMode && isGreenSector) {
                    logger.log(`[Green Rescue] 🌿 Forcing split on ${sectorNames[boxSector]} bucket (${sourceEnergy.toFixed(1)}% energy) - ${multiplier}× boost`);
                } else {
                    logger.log(`[Hue Priority] ⭐ ${sectorNames[boxSector]} sector (${sourceEnergy.toFixed(1)}% energy) - ${multiplier}× boost`);
                }
            }
        }

        return basePriority * multiplier;
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
        const totalPixels = labPixels.length / 3;
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
        logger.log(`[Hue Analysis] Analyzing ${totalPixels} total pixels, ${chromaCount} with chroma > ${CHROMA_THRESHOLD} (avg chroma: ${avgChroma.toFixed(1)})`)

        // Convert counts to percentages
        const huePercentages = hueCounts.map(count => (count / totalPixels) * 100);

        logger.log(`[Hue Analysis] Image hue distribution (12 sectors, chroma > ${CHROMA_THRESHOLD}):`);
        const sectorNames = ['Red', 'Orange', 'Yellow', 'Y-Green', 'Green', 'Cyan',
                            'Blue', 'B-Purple', 'Purple', 'Magenta', 'Pink', 'R-Pink'];
        huePercentages.forEach((pct, idx) => {
            if (pct > 0.5) {  // Show all sectors with >0.5% presence
                logger.log(`  ${sectorNames[idx].padEnd(9)}: ${pct.toFixed(1)}%`);
            }
        });

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

        logger.log(`[Hue Analysis] Palette hue coverage:`);
        for (const color of palette) {
            const chroma = Math.sqrt(color.a * color.a + color.b * color.b);

            if (chroma > CHROMA_THRESHOLD) {
                const hue = Math.atan2(color.b, color.a) * 180 / Math.PI;
                const hueNorm = hue < 0 ? hue + 360 : hue;
                const sectorIdx = Math.floor(hueNorm / 30);
                const clampedIdx = Math.min(sectorIdx, 11);
                coveredSectors.add(clampedIdx);
                colorCountsBySector[clampedIdx]++;
                logger.log(`  ${sectorNames[clampedIdx].padEnd(9)} (${hueNorm.toFixed(1)}°): L=${color.L.toFixed(1)}, a=${color.a.toFixed(1)}, b=${color.b.toFixed(1)}, C=${chroma.toFixed(1)}`);
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
        const GAP_THRESHOLD = 2.0; // Sector must have >2% of image pixels to be considered significant
        const HEAVY_SECTOR_THRESHOLD = 20.0; // If sector has >20% of image, needs multiple palette colors
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
                    logger.log(`  ${sectorNames[i]}: ${imageHues[i].toFixed(1)}% of image but only ${colorsInSector} palette color(s) → needs more shades`);
                    gaps.push(i); // Add as gap to force second color
                }
            }
        }

        if (gaps.length > 0) {
            logger.log(`[Hue Analysis] ⚠️ Found ${gaps.length} hue gap(s):`);
            gaps.forEach(idx => {
                if (paletteCoverage.has(idx)) {
                    // Density gap
                    logger.log(`  ${sectorNames[idx]}: ${imageHues[idx].toFixed(1)}% of image, under-represented in palette (density gap)`);
                } else {
                    // Complete gap
                    logger.log(`  ${sectorNames[idx]}: ${imageHues[idx].toFixed(1)}% of image, 0 palette colors`);
                }
            });
        } else {
            logger.log(`[Hue Analysis] ✓ No hue gaps detected - palette covers all significant hue sectors`);
        }

        return gaps;
    }

    /**
     * Calculate perceptual distance (ΔE) between two Lab colors
     * @private
     * @param {{L: number, a: number, b: number}} lab1 - First Lab color
     * @param {{L: number, a: number, b: number}} lab2 - Second Lab color
     * @returns {number} - Perceptual distance (ΔE)
     */
    static _labDistance(lab1, lab2) {
        const dL = lab1.L - lab2.L;
        const da = lab1.a - lab2.a;
        const db = lab1.b - lab2.b;
        return Math.sqrt((dL * dL) + (da * da) + (db * db));
    }

    /**
     * PERCEPTUAL L-SCALING: Weighted Lab distance for shadow preservation
     *
     * The human eye is much more sensitive to lightness changes in dark areas
     * than in light areas. This prevents dark greens and shadows from being
     * washed out into a single flat black/dark-grey layer.
     *
     * @private
     * @param {{L: number, a: number, b: number}} lab1 - First Lab color
     * @param {{L: number, a: number, b: number}} lab2 - Second Lab color
     * @returns {number} - Weighted perceptual distance
     */
    static _weightedLabDistance(lab1, lab2) {
        const dL = lab1.L - lab2.L;
        const da = lab1.a - lab2.a;
        const db = lab1.b - lab2.b;

        // Increase the weight of L for darker colors to preserve shadow detail
        // When L < 40 (dark shadows), double the lightness weight
        // This makes the engine treat "dark green" and "black" as more distinct
        const avgL = (lab1.L + lab2.L) / 2;
        const lWeight = avgL < 40 ? 2.0 : 1.0;

        return Math.sqrt((dL * lWeight) ** 2 + da ** 2 + db ** 2);
    }

    /**
     * SOURCE-PIXEL SNAPPING: Snap mathematical Lab average to nearest actual source pixel
     *
     * THE "MUDDY" FIX: Prevents washed-out desaturated mid-tones from dominating
     * by ensuring all palette colors are REAL pixels from the source image.
     *
     * When a bucket is too large/diverse, averaging creates muddy colors.
     * This finds the actual pixel closest to the average, prioritizing chroma.
     *
     * @private
     * @param {{L: number, a: number, b: number}} targetLab - Mathematical average color
     * @param {Array<{L: number, a: number, b: number}>} bucket - Array of source pixels
     * @returns {{L: number, a: number, b: number}} - Nearest actual source pixel
     */
    static _snapToSource(targetLab, bucket) {
        if (!bucket || bucket.length === 0) {
            return targetLab;
        }

        let minDistanceSq = Infinity;
        let bestPixel = targetLab;

        // Search the bucket for the pixel that most closely matches the average
        // Use perceptual L-scaling to preserve shadow detail
        for (const pixel of bucket) {
            const dL = targetLab.L - pixel.L;
            const da = targetLab.a - pixel.a;
            const db = targetLab.b - pixel.b;

            // Apply L-scaling for dark colors (preserves shadow texture)
            const avgL = (targetLab.L + pixel.L) / 2;
            const lWeight = avgL < 40 ? 2.0 : 1.0;
            const distSq = (dL * lWeight) ** 2 + (da * da) + (db * db);

            // If this pixel is closer to the target, use it
            // (Chroma prioritization happens implicitly because high-chroma pixels
            // cluster away from neutral grays, so they're naturally "closer" in Lab space
            // when the target average is also chromatic)
            if (distSq < minDistanceSq) {
                minDistanceSq = distSq;
                bestPixel = { L: pixel.L, a: pixel.a, b: pixel.b };
            }
        }

        return bestPixel;
    }

    /**
     * Merge two Lab colors by keeping the one with higher saliency
     *
     * SALIENCY-BASED MERGE: When merging similar colors,
     * keep the one with the highest Saliency (L + Chroma weighted combination)
     * to maintain visual impact for both highlights and vibrant features.
     *
     * @private
     * @param {{L: number, a: number, b: number}} c1 - First color
     * @param {{L: number, a: number, b: number}} c2 - Second color
     * @returns {{L: number, a: number, b: number}} - Color with higher saliency
     */
    static _mergeLabColors(c1, c2) {
        // Calculate saliency scores for both colors
        const chroma1 = Math.sqrt(c1.a * c1.a + c1.b * c1.b);
        const chroma2 = Math.sqrt(c2.a * c2.a + c2.b * c2.b);

        // Saliency: (L × 1.5) + (Chroma × 2.5)
        // Favors both bright highlights and vibrant features
        const s1 = (c1.L * 1.5) + (chroma1 * 2.5);
        const s2 = (c2.L * 1.5) + (chroma2 * 2.5);

        // Keep the one with higher saliency
        return s1 > s2 ? c1 : c2;
    }

    /**
     * TUNING-AWARE PALETTE PRUNING
     *
     * Merges colors using centralized tuning parameters.
     * Applies hue lock, highlight protection, and saliency-based selection.
     *
     * @private
     * @param {Array<{L: number, a: number, b: number}>} paletteLab - Lab palette
     * @param {number} threshold - Minimum ΔE distance (defaults to TUNING.prune.threshold)
     * @param {number} highlightThreshold - L-value protection floor (defaults to TUNING.prune.whitePoint)
     * @param {number} targetCount - Stop when reaching this count
     * @param {Object} tuning - Tuning config (defaults to TUNING)
     * @returns {Array<{L: number, a: number, b: number}>} - Pruned palette
     */
    static _prunePalette(paletteLab, threshold = null, highlightThreshold = null, targetCount = 0, tuning = null) {
        const config = tuning || this.TUNING;
        const pruneThreshold = threshold !== null ? threshold : config.prune.threshold;
        const highlightProtect = highlightThreshold !== null ? highlightThreshold : config.prune.whitePoint;
        const shadowProtect = config.prune.shadowPoint;
        const hueLock = config.prune.hueLockAngle;

        let pruned = [...paletteLab];
        let iteration = 0;

        logger.log(`[Palette Pruning] Starting with ${pruned.length} colors, threshold: ΔE ${pruneThreshold.toFixed(1)}, hue lock: ${hueLock}°, shadow protect: L<${shadowProtect}, highlight protect: L>${highlightProtect}, target: ${targetCount}`);

        // HUE LOCK PROTECTION + SALIENCY-BASED PRUNING
        // Iterate through pairs, merging only when protection rules allow
        for (let i = 0; i < pruned.length; i++) {
            for (let j = i + 1; j < pruned.length; j++) {
                // STOP if we've reached target count
                if (targetCount > 0 && pruned.length <= targetCount) {
                    logger.log(`[Palette Pruning] ✓ Reached target count (${pruned.length}), stopping`);
                    return pruned;
                }

                const p1 = pruned[i];
                const p2 = pruned[j];

                // Calculate distance (with L-weighting for dark colors)
                const avgL = (p1.L + p2.L) / 2;
                const dist = avgL < 40 ? this._weightedLabDistance(p1, p2) : this._labDistance(p1, p2);

                if (dist < pruneThreshold) {
                    // Calculate chroma for both colors
                    const chroma1 = Math.sqrt(p1.a * p1.a + p1.b * p1.b);
                    const chroma2 = Math.sqrt(p2.a * p2.a + p2.b * p2.b);

                    // HUE LOCK: Calculate the angle difference in degrees
                    if (chroma1 > 5 && chroma2 > 5) { // Only for chromatic colors
                        const h1 = Math.atan2(p1.b, p1.a) * (180 / Math.PI);
                        const h2 = Math.atan2(p2.b, p2.a) * (180 / Math.PI);
                        let hueDiff = Math.abs(h1 - h2);
                        if (hueDiff > 180) hueDiff = 360 - hueDiff;

                        // PROTECTION: Use centralized hue lock threshold
                        if (hueDiff > hueLock) {
                            continue;
                        }
                    }

                    // HIGHLIGHT PROTECTION: Prevent merging bright highlights with darker colors
                    if ((p1.L > highlightProtect && p2.L <= highlightProtect) || (p1.L <= highlightProtect && p2.L > highlightProtect)) {
                        continue;
                    }

                    // MERGE: Keep the one with higher Saliency score
                    const s1 = (p1.L * 1.5) + (chroma1 * 2.5);
                    const s2 = (p2.L * 1.5) + (chroma2 * 2.5);

                    pruned[i] = s1 > s2 ? p1 : p2;
                    pruned.splice(j, 1);
                    j--; // Adjust index after removal
                    iteration++;

                    logger.log(`[Palette Pruning] Merge ${iteration}: ΔE ${dist.toFixed(1)}, kept saliency ${(s1 > s2 ? s1 : s2).toFixed(1)}`);
                }
            }
        }

        logger.log(`[Palette Pruning] ✓ Complete: ${paletteLab.length} → ${pruned.length} colors after ${iteration} merge(s)`);

        return pruned;
    }

    /**
     * SALIENCY-BASED MERGE (Alias for _mergeLabColors)
     *
     * Keeps the color with higher saliency score when merging.
     * Used by pruning logic.
     *
     * @private
     * @param {{L: number, a: number, b: number}} c1 - First color
     * @param {{L: number, a: number, b: number}} c2 - Second color
     * @returns {{L: number, a: number, b: number}} - Color with higher saliency
     */
    static _mergeBySaliency(c1, c2) {
        return this._mergeLabColors(c1, c2);
    }

    /**
     * GET SALIENCY WINNER
     *
     * Picks the "punchiest" color between two merging candidates.
     * Uses balanced formula: (L × 1.2) + (chroma × 2.0)
     *
     * This is an alternative to _mergeLabColors with a more conservative
     * balance between lightness and chroma for pruning operations.
     *
     * @private
     * @param {{L: number, a: number, b: number}} c1 - First color
     * @param {{L: number, a: number, b: number}} c2 - Second color
     * @returns {{L: number, a: number, b: number}} - Color with higher saliency
     */
    static _getSaliencyWinner(c1, c2) {
        const s1 = (c1.L * 1.2) + (Math.sqrt(c1.a ** 2 + c1.b ** 2) * 2.0);
        const s2 = (c2.L * 1.2) + (Math.sqrt(c2.a ** 2 + c2.b ** 2) * 2.0);
        return s1 > s2 ? c1 : c2;
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
        const MIN_HUE_COVERAGE = options.minHueCoverage ?? PosterizationEngine.MIN_HUE_COVERAGE;
        const totalPixels = labPixels.length / 3;

        const sectorNames = ['Red', 'Orange', 'Yellow', 'Y-Green', 'Green', 'Cyan',
                            'Blue', 'B-Purple', 'Purple', 'Magenta', 'Pink', 'R-Pink'];

        const binSamples = new Array(12).fill(null);

        // Diagnostic counters per sector
        const diagnostics = gaps.map(gapIdx => ({
            sector: sectorNames[gapIdx],
            totalScanned: 0,
            highChroma: 0,
            failedDistinctness: 0,
            candidates: []
        }));
        const diagMap = new Map(gaps.map((gapIdx, i) => [gapIdx, diagnostics[i]]));

        logger.log(`[Hue Gap Refinement] Scanning image for distinct colors in ${gaps.length} missing sector(s)...`);
        logger.log(`  Thresholds: Chroma ≥ ${CHROMA_THRESHOLD}, ΔE ≥ ${DISTINCTNESS_THRESHOLD}`);

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
                const dist = this._labDistance({L, a, b}, p);
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
        logger.log(`[Hue Gap Diagnostics] Analysis complete:`);
        for (const diag of diagnostics) {
            const found = binSamples[sectorNames.indexOf(diag.sector)] !== null;
            logger.log(`  ${diag.sector} (${diag.totalScanned} pixels scanned):`);
            logger.log(`    - High chroma (≥${CHROMA_THRESHOLD}): ${diag.highChroma} pixels`);
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
                logger.log(`  🗑️ Skipping ${sectorNames[gapIdx]} - below viability threshold (${diag.totalScanned} pixels, ${(coverage * 100).toFixed(3)}% < ${(MIN_HUE_COVERAGE * 100).toFixed(2)}%)`);
                skippedForViability++;
                continue;
            }

            logger.log(`  ✓ Force-including ${sectorNames[gapIdx]}: L=${sample.L.toFixed(1)}, a=${sample.a.toFixed(1)}, b=${sample.b.toFixed(1)}, C=${sample.chroma.toFixed(1)} (ΔE ≥ ${DISTINCTNESS_THRESHOLD}, coverage: ${(coverage * 100).toFixed(2)}%)`);
            forcedColors.push({L: sample.L, a: sample.a, b: sample.b});
        }

        // Sort by chroma (most saturated first)
        forcedColors.sort((a, b) => {
            const chromaA = Math.sqrt(a.a * a.a + a.b * a.b);
            const chromaB = Math.sqrt(b.a * b.a + b.b * b.b);
            return chromaB - chromaA;
        });

        if (forcedColors.length === 0 && skippedForViability > 0) {
            logger.log(`  ⚠️ All ${skippedForViability} gap candidate(s) below viability threshold - not worth burning screens for dust`);
        } else if (forcedColors.length === 0) {
            logger.log(`  ⚠️ No distinct colors found - all candidates too similar to existing palette`);
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

                    logger.log(`  ✓ Force-including ${sectorNames[sectorIdx]} (LIGHT): L=${bestLight.L.toFixed(1)}, a=${bestLight.a.toFixed(1)}, b=${bestLight.b.toFixed(1)}, C=${maxChromaLight.toFixed(1)}`);
                    logger.log(`  ✓ Force-including ${sectorNames[sectorIdx]} (DARK): L=${bestDark.L.toFixed(1)}, a=${bestDark.a.toFixed(1)}, b=${bestDark.b.toFixed(1)}, C=${maxChromaDark.toFixed(1)}`);
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
                    logger.log(`  ✓ Force-including ${sectorNames[sectorIdx]}: L=${best.L.toFixed(1)}, a=${best.a.toFixed(1)}, b=${best.b.toFixed(1)}, C=${bestChroma.toFixed(1)}, H=${bestHueNorm.toFixed(1)}° (center: ${sectorCenterAngle}°)`);
                }
            }
        }

        return forcedColors;
    }

    /**
     * Median cut quantization in CIELAB space with substrate-aware culling
     *
     * Finds perceptual boundaries by splitting in Lab space rather than RGB.
     * This aligns quantization with perceptual uniformity.
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
        logger.log(`[MedianCut] Received tuning: bitDepth=${tunedBitDepth}, vibrancyMode=${vibrancyMode}`);

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
            logger.log(`[MedianCut] Grayscale grid sampling (stride ${GRID_STRIDE}): ${totalPixels} pixels → ${sampledPixels} sampled → ${colors.length} unique L values`);
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
                logger.log(`[MedianCut] ✓ Substrate culling: Excluded ${culledCount} substrate pixels (${percent}%)`);
            }

            logger.log(`[MedianCut] Color grid sampling (stride ${GRID_STRIDE}): ${totalPixels} pixels → ${sampledPixels} sampled → ${colors.length} unique Lab colors`);
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

            logger.log(`[MedianCut] Lab ranges: L[${minL.toFixed(2)}, ${maxL.toFixed(2)}], a[${minA.toFixed(2)}, ${maxA.toFixed(2)}], b[${minB.toFixed(2)}, ${maxB.toFixed(2)}]`);
            logger.log(`[MedianCut] Color count: ${colors.length}`);

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
        const sectorEnergy = grayscaleOnly ? null : this._analyzeImageHueSectors(labPixels, hueChromaThreshold);
        const coveredSectors = new Set();

        // Start with single box containing all colors
        const boxes = [{ colors, depth: 0, grayscaleOnly }];


        // Split until we have targetColors boxes
        let splitIteration = 0;
        while (boxes.length < targetColors) {
            splitIteration++;

            // HUE-AWARE PRIORITY: Sort by priority (variance × hue hunger × vibrancy) instead of just population
            boxes.sort((a, b) => {
                const priorityB = this._calculateSplitPriority(b, sectorEnergy, coveredSectors, grayscaleOnly, 5.0, vibrancyMode, vibrancyBoost, highlightThreshold, highlightBoost, tuning);
                const priorityA = this._calculateSplitPriority(a, sectorEnergy, coveredSectors, grayscaleOnly, 5.0, vibrancyMode, vibrancyBoost, highlightThreshold, highlightBoost, tuning);
                return priorityB - priorityA;
            });

            const topBoxPriority = this._calculateSplitPriority(boxes[0], sectorEnergy, coveredSectors, grayscaleOnly, 5.0, vibrancyMode, vibrancyBoost, highlightThreshold, highlightBoost, tuning);
            logger.log(`[MedianCut] Iteration ${splitIteration}: ${boxes.length} boxes, top priority ${topBoxPriority.toFixed(1)} (${boxes[0].colors.length} pixels)`);

            // If largest box has only 1 color, can't split further
            if (boxes[0].colors.length === 1) {
                logger.log(`[MedianCut] Stopping: Largest box has only 1 pixel`);
                break;
            }

            // Split the largest box
            const box = boxes.shift();
            const [box1, box2] = this._splitBoxLab(box, grayscaleOnly, tuning);

            if (box1 && box2) {
                boxes.push(box1, box2);

                // HUE-AWARE PRIORITY: Track which hue sectors are now covered
                if (!grayscaleOnly && sectorEnergy) {
                    const meta1 = this._calculateBoxMetadata(box1, grayscaleOnly, vibrancyMode, vibrancyBoost, highlightThreshold, highlightBoost, tuning);
                    const meta2 = this._calculateBoxMetadata(box2, grayscaleOnly, vibrancyMode, vibrancyBoost, highlightThreshold, highlightBoost, tuning);
                    if (meta1.sector >= 0) coveredSectors.add(meta1.sector);
                    if (meta2.sector >= 0) coveredSectors.add(meta2.sector);
                }

                logger.log(`[MedianCut] ✓ Split successful: ${box.colors.length} → ${box1.colors.length} + ${box2.colors.length} pixels`);
            } else {
                // Split failed, put box back
                boxes.push(box);
                logger.log(`[MedianCut] ✗ Split failed: No variance to split on`);
                break;
            }
        }

        logger.log(`[MedianCut] Final: ${boxes.length} boxes after ${splitIteration} iterations`);

        // GREEN-PRIORITY CENTROID: Check if we need to rescue green signals
        // If a box has significant green content, extract green-only centroid
        // This prevents green from being averaged into orange/yellow
        // Note: is16Bit already declared earlier in this function
        const greenEnergy = sectorEnergy ? (sectorEnergy[3] + sectorEnergy[4]) : 0;  // Y-Green + Green
        const GREEN_RESCUE_THRESHOLD = 1.5;  // Activate if green > 1.5% of image
        const shouldRescueGreen = !grayscaleOnly && greenEnergy > GREEN_RESCUE_THRESHOLD && is16Bit;

        if (shouldRescueGreen) {
            logger.log(`[Green Rescue] 🌿 Activating Green-Priority Centroid (green energy: ${greenEnergy.toFixed(1)}%)`);
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
                logger.log(`[Green Rescue] Box ${idx} scan: ${greenColors.length} green pixels (${(greenRatio * 100).toFixed(1)}% of box)`);

                if (greenColors.length > bestGreenCount) {
                    bestGreenCount = greenColors.length;
                    bestGreenRatio = greenRatio;
                    bestGreenBoxIdx = idx;
                }
            });

            if (bestGreenBoxIdx >= 0) {
                logger.log(`[Green Rescue] Best green box: #${bestGreenBoxIdx} with ${bestGreenCount} green pixels (${(bestGreenRatio * 100).toFixed(1)}%)`);
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
                logger.log(`🔧 Isolation threshold: Filtered ${filtered} small clusters (< ${(isolationThreshold / 2500 * 100).toFixed(1)}% of pixels)`);
                logger.log(`   Remaining boxes: ${boxes.length} (down from ${originalBoxCount})`);
            } else {
                logger.log(`⚠️ Isolation threshold too aggressive: Would reduce ${originalBoxCount} boxes to ${filteredBoxes.length} (need ${targetColors})`);
                logger.log(`   Keeping all ${originalBoxCount} boxes to ensure minimum palette size`);
            }
        }

        // Calculate representative color for each box (centroid in Lab space)
        // Use injected strategy or fallback to VOLUMETRIC
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
                    logger.log(`[Green Rescue] ✅ Box ${idx}: FORCING green centroid from ${greenColors.length} pixels`);
                    return this._calculateLabCentroid(greenColors, grayscaleOnly, strategy, tuning);
                }
            }

            // Normal centroid calculation
            return this._calculateLabCentroid(box.colors, grayscaleOnly, strategy, tuning);
        });

        // Store colors array in palette for later hue gap analysis
        // This allows us to force-include gap colors AFTER perceptual snap
        palette._allColors = colors;
        palette._labPixels = labPixels;

        return palette;
    }

    /**
     * Split a box in Lab space by finding channel with highest variance
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

            // Apply weights to variance - cWeight makes chroma dominate
            const varL = colors.reduce((sum, c) => sum + (c.L - avgL) ** 2, 0) * lWeight;
            const varA = colors.reduce((sum, c) => sum + (c.a - avgA) ** 2, 0) * cWeight;
            const varB = colors.reduce((sum, c) => sum + (c.b - avgB) ** 2, 0) * cWeight;

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

            // If variance is 0 in all channels, all colors are identical - can't split
            if (maxVar === 0) {
                return [null, null];
            }

            // Sort by split channel
            colors.sort((a, b) => a[splitChannel] - b[splitChannel]);

            // Split at median
            const median = Math.floor(colors.length / 2);
            const colors1 = colors.slice(0, median);
            const colors2 = colors.slice(median);

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

    /**
     * Get adaptive snap threshold based on target colors and color space
     * @private
     * @param {number} baseThreshold - Base threshold from user (default 8.0)
     * @param {number} targetColors - Target number of colors
     * @param {boolean} isGrayscale - Whether image is grayscale
     * @param {number} lRange - L channel range (maxL - minL), used to calculate minimum spacing
     * @param {Object} colorSpaceExtent - For color mode: {lRange, aRange, bRange}
     * @returns {number} Adaptive threshold
     */
    static _getAdaptiveSnapThreshold(baseThreshold, targetColors, isGrayscale, lRange = 0, colorSpaceExtent = null) {
        // Grayscale images: Calculate threshold based on target color spacing
        // to avoid collapsing explicitly requested colors
        if (isGrayscale && lRange > 0) {
            // Target L spacing for requested color count
            const targetSpacing = lRange / Math.max(1, targetColors - 1);

            // Snap threshold must be LESS than half the target spacing
            // to avoid merging adjacent bands
            // With L_WEIGHT=3.0: deltaE = 1.73 * deltaL
            // So: threshold = 0.4 * targetSpacing * 1.73
            const threshold = 0.4 * targetSpacing * Math.sqrt(3.0);

            logger.log(`  Calculated snap threshold: ΔE ${threshold.toFixed(2)} (L spacing: ${targetSpacing.toFixed(2)})`);
            return threshold;
        } else if (isGrayscale) {
            // Fallback for grayscale without L range info
            return 2.0; // Per Architect: preserve all grayscale bands
        }

        // Color mode: Calculate threshold based on Lab space extent
        if (colorSpaceExtent) {
            // Estimate typical color spacing in 3D Lab space
            // Use diagonal of color space bounding box divided by target colors
            const labDiagonal = Math.sqrt(
                colorSpaceExtent.lRange * colorSpaceExtent.lRange * 1.5 + // L_WEIGHT=1.5 for color
                colorSpaceExtent.aRange * colorSpaceExtent.aRange +
                colorSpaceExtent.bRange * colorSpaceExtent.bRange
            );

            // Target spacing in 3D Lab space
            const targetSpacing = labDiagonal / Math.max(1, targetColors - 1);

            // Snap threshold: 40% of target spacing to avoid collapsing adjacent colors
            // BUT: Never exceed the user-specified base threshold (e.g., 8.0 ΔE)
            const adaptiveThreshold = 0.4 * targetSpacing;
            const threshold = Math.min(baseThreshold, adaptiveThreshold);

            logger.log(`  Calculated color snap threshold: ΔE ${threshold.toFixed(2)} (adaptive: ${adaptiveThreshold.toFixed(2)}, base: ${baseThreshold.toFixed(2)}, Lab diagonal: ${labDiagonal.toFixed(2)})`);
            return threshold;
        }

        // Fallback: Old adaptive thresholding based on target color count
        if (targetColors >= 9) {
            // High color count: User wants fidelity, reduce snap
            return Math.min(baseThreshold, 4.0);
        } else if (targetColors >= 6) {
            // Medium color count: Balanced approach
            return Math.min(baseThreshold, 6.0);
        } else {
            // Low color count: Aggressive reduction
            return baseThreshold; // Use default 8.0
        }
    }

    /**
     * Reveal Engine: Lab-space median cut with hue-aware gap analysis (internal method)
     *
     * Two-stage architecture:
     * Stage 1: Feature Detection (CIELAB finds boundaries)
     * Stage 2: Palette Assignment (artist declares colors - future enhancement)
     *
     * Philosophy: "CIELAB finds boundaries, snap curates, artist declares colors"
     *
     * @param {Uint8ClampedArray} pixels - RGBA or Lab pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} targetColors - Desired color count
     * @param {Object} options - Engine options
     * @param {number} [options.snapThreshold=8.0] - Perceptual snap threshold
     * @param {boolean} [options.enableHueGapAnalysis=true] - Force-include missing hues
     * @param {string} [options.format='lab'] - Input format ('lab' or 'rgb')
     * @param {boolean} [options.grayscaleOnly=false] - L-channel only mode
     * @param {boolean} [options.preserveWhite=true] - Force white into palette
     * @param {boolean} [options.preserveBlack=true] - Force black into palette
     * @returns {Object} {palette, paletteLab, assignments, labPixels, metadata}
     */
    static _posterizeRevealMk1_0(pixels, width, height, targetColors, options = {}) {
        // 🔧 LEGACY V1 MODE: CIE76 = "Dumb" Euclidean math, no smart features
        // When distanceMetric is cie76, force legacy v1 behavior:
        // - No perceptual snap (threshold = 0.0)
        // - No palette reduction merging
        // - No preserved color unification (threshold = 0.5)
        // - No density floor removal (threshold = 0.0)
        const distanceMetric = options.distanceMetric || 'cie76';
        const isLegacyV1Mode = distanceMetric === 'cie76';

        let snapThreshold = options.snapThreshold !== undefined ? options.snapThreshold : 8.0;
        let enablePaletteReduction = options.enablePaletteReduction !== undefined ? options.enablePaletteReduction : true;
        let paletteReduction = options.paletteReduction !== undefined ? options.paletteReduction : 8.0;
        let preservedUnifyThreshold = options.preservedUnifyThreshold !== undefined ? options.preservedUnifyThreshold : 12.0;
        let densityFloor = options.densityFloor !== undefined ? options.densityFloor : 0.005;

        if (isLegacyV1Mode) {
            logger.log(`🔧 LEGACY V1 MODE: CIE76 detected → Disabling Mk 1.5 "smart" features`);
            snapThreshold = 0.0;              // Kill perceptual snap
            enablePaletteReduction = false;   // Kill palette reduction
            preservedUnifyThreshold = 0.5;    // Kill white/black unification
            densityFloor = 0.0;               // Kill density floor removal

            // Update options object so these values are used throughout the function
            options.preservedUnifyThreshold = preservedUnifyThreshold;
            options.densityFloor = densityFloor;

            logger.log(`   snapThreshold: ${snapThreshold} (no merging)`);
            logger.log(`   enablePaletteReduction: ${enablePaletteReduction}`);
            logger.log(`   preservedUnifyThreshold: ${preservedUnifyThreshold} ΔE`);
            logger.log(`   densityFloor: ${densityFloor} (disabled)`);
        }


        const enableHueGapAnalysis = options.enableHueGapAnalysis !== undefined ? options.enableHueGapAnalysis : false;
        const grayscaleOnly = options.grayscaleOnly !== undefined ? options.grayscaleOnly : false;
        const preserveWhite = options.preserveWhite !== undefined ? options.preserveWhite : false;
        const preserveBlack = options.preserveBlack !== undefined ? options.preserveBlack : false;
        const vibrancyMode = options.vibrancyMode !== undefined ? options.vibrancyMode : 'aggressive';
        const vibrancyBoost = options.vibrancyBoost !== undefined ? options.vibrancyBoost : 2.0;
        const highlightThreshold = options.highlightThreshold !== undefined ? options.highlightThreshold : 92;
        const highlightBoost = options.highlightBoost !== undefined ? options.highlightBoost : 3.0;

        if (grayscaleOnly) {
            logger.log(`Starting Lab-space posterization: ${targetColors} target colors (GRAYSCALE ONLY)`);
            logger.log(`  Mode: Spot color separation workflow - quantizing L channel only (a=b=0)`);
        } else {
            logger.log(`Starting Lab-space posterization: ${targetColors} target colors`);
        }

        const preserveList = [];
        if (preserveWhite) preserveList.push('white');
        if (preserveBlack) preserveList.push('black');
        if (preserveList.length > 0) {
            logger.log(`  Preserve colors: ${preserveList.join(', ')} (excluded from quantization)`);
        }

        const startTime = performance.now();

        const isLabInput = options.format === 'lab';

        // IMPORTANT: Track source bit depth at function level for use in thresholds throughout.
        // 16-bit data is signal, not noise - use tighter thresholds to preserve subtle differences.
        const sourceBitDepth = options.bitDepth || 16;  // Default to 16 (engine expects 16-bit)
        const isEightBitSource = sourceBitDepth <= 8;

        // Step 1: Convert all pixels to Lab space (or use directly if Lab input)
        // Also track transparent pixels (alpha < threshold)
        let labPixels;
        let transparentPixels = new Set(); // Pixel indices that are transparent

        if (isLabInput) {
            // Pixels MUST be in 16-bit Lab format (callers convert 8-bit → 16-bit before calling)
            // 16-bit: L, a, b encoded as 0-32768 (neutral a/b = 16384)
            // Lab format has NO alpha channel - all pixels are opaque (3 channels: L, a, b)
            //
            // IMPORTANT: bitDepth tracks the ORIGINAL source bit depth (for decisions like
            // shadow/highlight gates), but the actual pixel data is ALWAYS 16-bit encoding.

            logger.log(`✓ Using 16-bit Lab pixels (original source: ${sourceBitDepth}-bit → Float32 perceptual ranges)`);
            labPixels = new Float32Array(pixels.length);

            // 8-BIT PARITY FIX: Compensate for quantization error in 8-bit sources
            // Even though data is now 16-bit, if the SOURCE was 8-bit it has coarser steps,
            // causing shadow pixels that should be L=5.8 to round up to L=6.3.
            // Use wider thresholds for 8-bit sources to catch this quantization noise.
            const shadowThreshold = isEightBitSource ? 7.5 : 6.0;
            const highlightThreshold = isEightBitSource ? 97.5 : 98.0;

            if (isEightBitSource) {
                logger.log(`  8-bit source: Using expanded gates (Shadow L<${shadowThreshold}, Highlight L>${highlightThreshold})`);
            } else {
                logger.log(`  16-bit source: Using standard gates (Shadow L<${shadowThreshold}, Highlight L>${highlightThreshold})`);
            }

            // 16-bit Lab constants (engine ONLY accepts 16-bit)
            // L: 0-32768 → 0-100
            // a/b: 0-32768 (neutral=16384) → -128 to +127
            const maxValue = 32768;
            const neutralAB = 16384;
            const abScale = 128 / 16384;  // Scale 16-bit a/b to -128..+127

            // Track min/max for diagnostics (BEFORE and AFTER conversion)
            let minLRaw = Infinity, maxLRaw = -Infinity;
            let minARaw = Infinity, maxARaw = -Infinity;
            let minBRaw = Infinity, maxBRaw = -Infinity;
            let minL = Infinity, maxL = -Infinity;
            let minA = Infinity, maxA = -Infinity;
            let minB = Infinity, maxB = -Infinity;

            for (let i = 0; i < pixels.length; i += 3) {
                // Track ORIGINAL raw values (16-bit encoding)
                minLRaw = Math.min(minLRaw, pixels[i]);
                maxLRaw = Math.max(maxLRaw, pixels[i]);
                minARaw = Math.min(minARaw, pixels[i + 1]);
                maxARaw = Math.max(maxARaw, pixels[i + 1]);
                minBRaw = Math.min(minBRaw, pixels[i + 2]);
                maxBRaw = Math.max(maxBRaw, pixels[i + 2]);

                // Convert 16-bit Lab to perceptual Lab ranges
                // L: 0-100, a: -128 to +127, b: -128 to +127
                labPixels[i] = (pixels[i] / maxValue) * 100;
                labPixels[i + 1] = (pixels[i + 1] - neutralAB) * abScale;
                labPixels[i + 2] = (pixels[i + 2] - neutralAB) * abScale;

                // THE SHADOW GATE (Final Calibration)
                // L < threshold is effectively black on a t-shirt.
                // We force these to True Black (0,0,0) to prevent the engine
                // from wasting a screen on "Dark Noise" (e.g., L=4.81).
                // 8-bit sources use L<7.5 to catch quantization-rounded shadow "scum".
                if (labPixels[i] < shadowThreshold) {
                    labPixels[i] = 0;
                    labPixels[i + 1] = 0;
                    labPixels[i + 2] = 0;
                }
                // THE HIGHLIGHT GATE (Kill Scum Dots)
                // L > threshold is effectively paper/white.
                // We force these to Pure White (100,0,0) so they become "Transparent/Background".
                // 8-bit sources use L>97.5 to catch quantization-rounded highlight "scum".
                else if (labPixels[i] > highlightThreshold) {
                    labPixels[i] = 100;
                    labPixels[i + 1] = 0;
                    labPixels[i + 2] = 0;
                }

                // Track converted ranges
                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
                minA = Math.min(minA, labPixels[i + 1]);
                maxA = Math.max(maxA, labPixels[i + 1]);
                minB = Math.min(minB, labPixels[i + 2]);
                maxB = Math.max(maxB, labPixels[i + 2]);
            }

            logger.log(`✓ Converted ${pixels.length / 3} Lab pixels from 16-bit encoding to perceptual ranges (source was ${sourceBitDepth}-bit)`);
            logger.log(`  RAW 16-bit values: L[${minLRaw}, ${maxLRaw}], a[${minARaw}, ${maxARaw}], b[${minBRaw}, ${maxBRaw}]`);
            logger.log(`  PERCEPTUAL ranges after conversion: L[${minL.toFixed(2)}, ${maxL.toFixed(2)}], a[${minA.toFixed(2)}, ${maxA.toFixed(2)}], b[${minB.toFixed(2)}, ${maxB.toFixed(2)}]`);
        } else {
            // Legacy path: Convert RGB to Lab, checking alpha channel
            const ALPHA_THRESHOLD = 10; // Pixels with alpha < 10 are considered transparent
            logger.log("Converting RGB → Lab...");
            labPixels = new Float32Array((pixels.length / 4) * 3);

            // 8-BIT PARITY FIX: Same thresholds apply to RGB sources
            // (RGB sources are typically always 8-bit anyway)
            const sourceBitDepth = options.bitDepth || 8;
            const isEightBitSource = sourceBitDepth <= 8;
            const shadowThreshold = isEightBitSource ? 7.5 : 6.0;
            const highlightThreshold = isEightBitSource ? 97.5 : 98.0;

            for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
                const alpha = pixels[i + 3];

                // Track transparent pixels
                if (alpha < ALPHA_THRESHOLD) {
                    transparentPixels.add(j / 3); // Store pixel index (not byte index)
                    // Still convert to Lab for consistency, but will exclude from quantization
                }

                const rgb = { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] };
                const lab = this.rgbToLab(rgb);
                labPixels[j] = lab.L;
                labPixels[j + 1] = lab.a;
                labPixels[j + 2] = lab.b;

                // THE SHADOW GATE (Final Calibration)
                // L < threshold is effectively black on a t-shirt.
                // We force these to True Black (0,0,0) to prevent the engine
                // from wasting a screen on "Dark Noise" (e.g., L=4.81).
                // 8-bit sources use L<7.5 to catch quantization-rounded shadow "scum".
                if (labPixels[j] < shadowThreshold) {
                    labPixels[j] = 0;
                    labPixels[j + 1] = 0;
                    labPixels[j + 2] = 0;
                }
                // THE HIGHLIGHT GATE (Kill Scum Dots)
                // L > threshold is effectively paper/white.
                // We force these to Pure White (100,0,0) so they become "Transparent/Background".
                // 8-bit sources use L>97.5 to catch quantization-rounded highlight "scum".
                else if (labPixels[j] > highlightThreshold) {
                    labPixels[j] = 100;
                    labPixels[j + 1] = 0;
                    labPixels[j + 2] = 0;
                }
            }

            if (transparentPixels.size > 0) {
                const percent = ((transparentPixels.size / (pixels.length / 4)) * 100).toFixed(1);
                logger.log(`✓ Found ${transparentPixels.size} transparent pixels (${percent}%) - will exclude from quantization`);
            }

            logger.log(`✓ Converted ${pixels.length / 4} pixels to Lab space`);
        }

        // Step 1.5: Separate preserved colors (white, black) from quantization
        let preservedPixelMap = new Map(); // colorName → pixel indices (using Set for O(1) lookup)
        let nonPreservedIndices = [];
        let actualTargetColors = targetColors;

        if (preserveWhite || preserveBlack || transparentPixels.size > 0) {
            // Thresholds for detecting preserved colors
            const WHITE_L_MIN = 95;
            const BLACK_L_MAX = 10;  // Increased from 5 to catch more near-black pixels
            // 16-BIT PRECISION FIX: 16-bit data is signal, not noise.
            // Use very small threshold for 16-bit to preserve subtle chroma in whites/blacks.
            // Note: Using 0.01 instead of 0 because the < comparison needs a positive value.
            const AB_THRESHOLD = isEightBitSource ? 5 : 0.01;

            // Sample some "black" pixels to see their actual L values (diagnostic)
            let blackLSamples = [];

            for (let i = 0; i < labPixels.length; i += 3) {
                const L = labPixels[i];
                const a = labPixels[i + 1];
                const b = labPixels[i + 2];
                const pixelIndex = i / 3;

                // Skip transparent pixels entirely
                if (transparentPixels.has(pixelIndex)) {
                    continue;
                }

                let isPreserved = false;

                // Check if pixel is white
                if (preserveWhite && L > WHITE_L_MIN && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                    if (!preservedPixelMap.has('white')) {
                        preservedPixelMap.set('white', new Set());
                    }
                    preservedPixelMap.get('white').add(pixelIndex);
                    isPreserved = true;
                }
                // Check if pixel is black
                else if (preserveBlack && L < BLACK_L_MAX && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                    if (!preservedPixelMap.has('black')) {
                        preservedPixelMap.set('black', new Set());
                    }
                    preservedPixelMap.get('black').add(pixelIndex);
                    isPreserved = true;

                    // Sample L values for diagnostic
                    if (blackLSamples.length < 10) {
                        blackLSamples.push(L.toFixed(2));
                    }
                }

                // Diagnostic: Sample near-black pixels that AREN'T being preserved
                if (preserveBlack && !isPreserved && L < BLACK_L_MAX + 5 && blackLSamples.length < 20) {
                    blackLSamples.push(`${L.toFixed(2)}(near)`);
                }

                if (!isPreserved) {
                    nonPreservedIndices.push(pixelIndex);
                }
            }

            // Log black detection diagnostics
            if (preserveBlack && blackLSamples.length > 0) {
                logger.log(`  Black pixel L values (sample): ${blackLSamples.slice(0, 10).join(', ')}`);
            }

            // Log preserved colors
            const totalPixels = labPixels.length / 3;

            // Log transparent pixels if present
            if (transparentPixels.size > 0) {
                const percent = ((transparentPixels.size / totalPixels) * 100).toFixed(1);
                logger.log(`✓ Excluded ${transparentPixels.size} transparent pixels (${percent}%)`);
            }

            preservedPixelMap.forEach((indices, colorName) => {
                const percent = ((indices.size / totalPixels) * 100).toFixed(1);
                logger.log(`✓ Preserved ${indices.size} ${colorName} pixels (${percent}%)`);
            });

            // Reserve palette slots for preserved colors (based on checkboxes, not detected pixels)
            let numPreserved = 0;
            if (preserveWhite) numPreserved++;
            if (preserveBlack) numPreserved++;

            if (numPreserved > 0) {
                actualTargetColors = targetColors - numPreserved;
                logger.log(`  Reserved ${numPreserved} palette slot(s) for preserved colors`);
                logger.log(`  Quantizing ${nonPreservedIndices.length} pixels to ${actualTargetColors} colors`);
            } else if (transparentPixels.size > 0) {
                logger.log(`  Quantizing ${nonPreservedIndices.length} non-transparent pixels to ${actualTargetColors} colors`);
            }
        } else {
            // No preservation: all non-transparent pixels participate in quantization
            for (let i = 0; i < labPixels.length / 3; i++) {
                if (!transparentPixels.has(i)) {
                    nonPreservedIndices.push(i);
                }
            }
        }

        // Extract non-preserved pixels for quantization
        let nonPreservedLabPixels = labPixels;
        if (nonPreservedIndices.length < labPixels.length / 3) {
            nonPreservedLabPixels = new Float32Array(nonPreservedIndices.length * 3);
            for (let i = 0; i < nonPreservedIndices.length; i++) {
                const srcIdx = nonPreservedIndices[i] * 3;
                nonPreservedLabPixels[i * 3] = labPixels[srcIdx];
                nonPreservedLabPixels[i * 3 + 1] = labPixels[srcIdx + 1];
                nonPreservedLabPixels[i * 3 + 2] = labPixels[srcIdx + 2];
            }
        }

        // Step 1.5: Substrate Detection (if Lab input, run on original pixels)
        // ENABLED BY DEFAULT: Only disable if explicitly set to 'none'
        let substrateLab = null;
        const substrateDisabled = options.substrateMode === 'none';

        if (isLabInput && !substrateDisabled) {
            // Auto-detect by default, or when explicitly set to 'auto'
            if (!options.substrateMode || options.substrateMode === 'auto') {
                substrateLab = this.autoDetectSubstrate(pixels, width, height, options.bitDepth || 8);
            } else if (options.substrateMode === 'white') {
                // Force white paper substrate
                substrateLab = { L: 100, a: 0, b: 0 };
                logger.log(`✓ Using forced white substrate: L=100 a=0 b=0`);
            } else if (options.substrateMode === 'black') {
                // Force black substrate (shirt, canvas, etc.)
                substrateLab = { L: 0, a: 0, b: 0 };
                logger.log(`✓ Using forced black substrate: L=0 a=0 b=0`);
            } else if (options.substrateLab) {
                // Use provided substrate color (custom Lab values)
                substrateLab = options.substrateLab;
                logger.log(`✓ Using provided substrate: L=${substrateLab.L.toFixed(1)} a=${substrateLab.a.toFixed(1)} b=${substrateLab.b.toFixed(1)}`);
            }
        } else if (isLabInput && substrateDisabled) {
            logger.log(`Substrate detection: DISABLED (explicitly set to 'none')`);
        }

        // SUBSTRATE COMPENSATION: If substrate will be added, increase target by 1
        // This ensures perceptual snapping doesn't reduce the final ink count
        // Example: User requests 10 inks
        //   - Generate 11 colors (to account for substrate)
        //   - Perceptual snap might reduce to 10
        //   - Add substrate → 11 total (10 inks + 1 substrate) ✓
        let medianCutTarget = actualTargetColors;
        if (substrateLab) {
            medianCutTarget = actualTargetColors + 1;
            logger.log(`  Substrate will be added → increasing median cut target: ${actualTargetColors} → ${medianCutTarget} colors`);
        }

        // Step 2: Run median cut in Lab space with substrate culling
        if (grayscaleOnly) {
            logger.log("Running median cut on L channel only (ignoring a/b)...");
        } else {
            if (substrateLab) {
                logger.log("Running median cut in Lab space with substrate-aware culling...");
            } else {
                logger.log("Running median cut in Lab space...");
            }
        }
        const initialPaletteLab = this.medianCutInLabSpace(
            nonPreservedLabPixels,
            medianCutTarget,
            grayscaleOnly,
            width,
            height,
            substrateLab,
            options.substrateTolerance || 3.5,
            vibrancyMode,
            vibrancyBoost,
            highlightThreshold,
            highlightBoost,
            options.strategy || null,
            options.tuning || null
        );
        logger.log(`✓ Initial palette: ${initialPaletteLab.length} colors`);

        // Step 3: Detect grayscale and apply adaptive perceptual snap
        // "Luma-Aware" Perceptual Snapping per Architect guidance
        const colorSpaceAnalysis = this._analyzeColorSpace(labPixels);
        const isGrayscale = grayscaleOnly || colorSpaceAnalysis.chromaRange < 10;

        // Calculate Lab ranges for adaptive threshold calculation
        let lRange = 0;
        let colorSpaceExtent = null;

        if (isGrayscale) {
            // Grayscale mode: Only need L range
            let minL = Infinity, maxL = -Infinity;
            for (let i = 0; i < labPixels.length; i += 3) {
                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
            }
            lRange = maxL - minL;
            logger.log(`  L channel range: [${minL.toFixed(2)}, ${maxL.toFixed(2)}] = ${lRange.toFixed(2)}`);
        } else {
            // Color mode: Need full Lab space extent
            let minL = Infinity, maxL = -Infinity;
            let minA = Infinity, maxA = -Infinity;
            let minB = Infinity, maxB = -Infinity;

            for (let i = 0; i < labPixels.length; i += 3) {
                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
                minA = Math.min(minA, labPixels[i + 1]);
                maxA = Math.max(maxA, labPixels[i + 1]);
                minB = Math.min(minB, labPixels[i + 2]);
                maxB = Math.max(maxB, labPixels[i + 2]);
            }

            colorSpaceExtent = {
                lRange: maxL - minL,
                aRange: maxA - minA,
                bRange: maxB - minB
            };

            logger.log(`  Lab space extent: L[${minL.toFixed(2)}, ${maxL.toFixed(2)}], a[${minA.toFixed(2)}, ${maxA.toFixed(2)}], b[${minB.toFixed(2)}, ${maxB.toFixed(2)}]`);
            logger.log(`  Ranges: ΔL=${colorSpaceExtent.lRange.toFixed(2)}, Δa=${colorSpaceExtent.aRange.toFixed(2)}, Δb=${colorSpaceExtent.bRange.toFixed(2)}`);
        }

        const adaptiveThreshold = this._getAdaptiveSnapThreshold(
            snapThreshold,
            targetColors,
            isGrayscale,
            lRange,
            colorSpaceExtent
        );

        if (grayscaleOnly) {
            logger.log(`  Grayscale-only mode: Force a=b=0 for all palette colors`);
            logger.log(`  Adaptive snap threshold: ΔE ${adaptiveThreshold.toFixed(1)}`);
        } else if (isGrayscale) {
            logger.log(`✓ Grayscale image detected (chroma range: ${colorSpaceAnalysis.chromaRange.toFixed(2)})`);
            logger.log(`  Adaptive snap threshold: ΔE ${adaptiveThreshold.toFixed(1)} (tightened for luma fidelity)`);
        } else {
            logger.log(`  Color image (chroma range: ${colorSpaceAnalysis.chromaRange.toFixed(2)})`);
            logger.log(`  Adaptive snap threshold: ΔE ${adaptiveThreshold.toFixed(1)}`);
        }

        let curatedPaletteLab = this.applyPerceptualSnap(
            initialPaletteLab,
            adaptiveThreshold,
            isGrayscale,
            vibrancyBoost,
            options.strategy || null,
            options.tuning || null
        );
        logger.log(`✓ Curated palette: ${curatedPaletteLab.length} colors`);

        // ARCHITECT'S PALETTE REDUCTION: Prune colors that are too similar
        // User-configurable threshold (6.0-15.0 ΔE, default: 10.0)
        // Balances screen printing practicality with color richness
        // ONLY prune if enabled AND we're over the target color count (don't reduce below user's request)
        if (enablePaletteReduction && curatedPaletteLab.length > targetColors) {
            const prunedPaletteLab = this._prunePalette(curatedPaletteLab, paletteReduction, highlightThreshold, targetColors, options.tuning || null);
            if (prunedPaletteLab.length < curatedPaletteLab.length) {
                logger.log(`✓ Palette pruned: ${curatedPaletteLab.length} → ${prunedPaletteLab.length} colors (merged similar colors for screen printing)`);
                curatedPaletteLab = prunedPaletteLab;
            }
        } else if (!enablePaletteReduction) {
            logger.log(`✓ Palette reduction disabled by user`);
        } else {
            logger.log(`✓ Palette at or below target (${curatedPaletteLab.length} ≤ ${targetColors}) - skipping pruning`);
        }

        // ARTIST-CENTRIC / HUE-AWARE MODEL: Check for hue gaps AFTER perceptual snap & pruning
        // This prevents forced colors from being merged away by the snap/prune process
        // CONDITIONAL: Only run if enableHueGapAnalysis is true (Reveal Mode)
        if (enableHueGapAnalysis && !grayscaleOnly) {
            if (!initialPaletteLab._allColors || !initialPaletteLab._labPixels) {
                logger.warn(`⚠️ [Hue-Aware Model] Cannot analyze hue gaps - palette data not preserved`);
                logger.warn(`   _allColors exists: ${!!initialPaletteLab._allColors}`);
                logger.warn(`   _labPixels exists: ${!!initialPaletteLab._labPixels}`);
            } else {
                logger.log(`\n[Hue-Aware Model] Analyzing palette for missing hue sectors...`);
                logger.log(`[Hue Analysis] Data available: ${initialPaletteLab._allColors.length} unique colors, ${initialPaletteLab._labPixels.length / 3} total pixels`);

                // Step 1: Analyze image hue distribution (12 sectors)
                // MUTED IMAGE RESCUE: Use lower chroma threshold for exponential vibrancy mode
                const hueChromaThreshold = vibrancyMode === 'exponential' ? 1.0 : 5.0;
                const imageHues = this._analyzeImageHueSectors(initialPaletteLab._labPixels, hueChromaThreshold);

                // Step 2: Check which sectors the curated palette covers
                const { coveredSectors, colorCountsBySector } = this._analyzePaletteHueCoverage(curatedPaletteLab, hueChromaThreshold);
                logger.log(`[Hue Analysis] Curated palette covers ${coveredSectors.size}/12 hue sectors`);

                // Step 3: Identify gaps (sectors with >2% image but 0 palette, OR >20% but only 1 color)
                const gaps = this._identifyHueGaps(imageHues, coveredSectors, colorCountsBySector);

                // Sort gaps by priority (image percentage, descending)
                gaps.sort((a, b) => imageHues[b] - imageHues[a]);

                // Step 4: Force-include colors for significant gaps
                // When hue gap analysis is enabled, ALLOW EXCEEDING target count for hue diversity
                if (gaps.length > 0) {
                    // Calculate available slots (target - current - preserved)
                    const numPreservedSlots = (preserveWhite ? 1 : 0) + (preserveBlack ? 1 : 0);
                    const availableSlots = actualTargetColors - curatedPaletteLab.length - numPreservedSlots;

                    // Determine how many gaps to fill
                    let gapsToFill;
                    if (availableSlots <= 0) {
                        // No slots available, but hue gap analysis is ENABLED
                        // Force-include gaps anyway (will exceed target count)
                        logger.log(`[Hue Analysis] No available slots (${curatedPaletteLab.length} colors + ${numPreservedSlots} preserved = ${curatedPaletteLab.length + numPreservedSlots}/${actualTargetColors})`);
                        logger.log(`[Hue Analysis] ⚠️ Will EXCEED target count to ensure hue diversity`);
                        gapsToFill = gaps; // Include ALL gaps (up to reasonable limit)
                        if (gapsToFill.length > 3) {
                            logger.log(`[Hue Analysis] Limiting to top 3 gaps (found ${gaps.length})`);
                            gapsToFill = gaps.slice(0, 3); // Reasonable limit: max 3 extra colors
                        }
                    } else {
                        // Limit gaps to available slots
                        gapsToFill = gaps.slice(0, availableSlots);
                        const skippedGaps = gaps.length - gapsToFill.length;

                        if (skippedGaps > 0) {
                            logger.log(`[Hue Analysis] Found ${gaps.length} gap(s) but only ${availableSlots} slot(s) available`);
                            logger.log(`[Hue Analysis] Force-including top ${gapsToFill.length} gap(s) by priority...`);
                        } else {
                            logger.log(`[Hue Analysis] Force-including ${gapsToFill.length} missing hue(s)...`);
                        }
                    }

                    // Use Architect's improved algorithm: scan actual image for distinct high-chroma colors
                    const candidateColors = this._findTrueMissingHues(labPixels, curatedPaletteLab, gapsToFill);

                    // CRITICAL FILTER: Verify each candidate is ≥15 ΔE from ALL existing palette colors
                    // This prevents adding near-duplicates that passed the threshold during scanning
                    const MIN_GAP_DISTANCE = 15.0;
                    const forcedColors = candidateColors.filter(candidate => {
                        const minDistanceFromPalette = Math.min(
                            ...curatedPaletteLab.map(p => this._labDistance(candidate, p))
                        );

                        if (minDistanceFromPalette < MIN_GAP_DISTANCE) {
                            const chroma = Math.sqrt(candidate.a * candidate.a + candidate.b * candidate.b);
                            logger.log(`  ✗ Rejected candidate (ΔE ${minDistanceFromPalette.toFixed(1)} < ${MIN_GAP_DISTANCE}): L=${candidate.L.toFixed(1)}, a=${candidate.a.toFixed(1)}, b=${candidate.b.toFixed(1)}, C=${chroma.toFixed(1)}`);
                            return false;
                        }
                        return true;
                    });

                    if (forcedColors.length === 0) {
                        logger.log(`[Hue Analysis] No distinct colors found for gaps (all candidates < ΔE ${MIN_GAP_DISTANCE} from palette)`);
                    } else {
                        // Add forced colors to curated palette (AFTER snap, so they won't be merged)
                        curatedPaletteLab = curatedPaletteLab.concat(forcedColors);
                        logger.log(`[Hue Analysis] ✓ Palette expanded: ${curatedPaletteLab.length - forcedColors.length} → ${curatedPaletteLab.length} colors (${candidateColors.length - forcedColors.length} candidates rejected)`);

                        // Re-check coverage
                        const { coveredSectors: newCoverage } = this._analyzePaletteHueCoverage(curatedPaletteLab);
                        logger.log(`[Hue Analysis] Final palette covers ${newCoverage.size}/12 hue sectors\n`);
                    }
                } else {
                    logger.log(`[Hue Analysis] ✓ No hue gaps detected - palette covers all significant sectors\n`);
                }
            }
        }

        // Step 3.5: Add preserved colors to palette (with Minimum Viability Threshold)
        // SPECKLE FILTER: Only add white/black if they represent significant coverage.
        // A 0.04% coverage layer is "dust" - it will wash out on a 230 mesh screen.
        // For a 1MP image, 0.1% = 1000 pixels. Anything less is invisible/unprintable.
        const MIN_PRESERVED_COVERAGE = PosterizationEngine.MIN_PRESERVED_COVERAGE;
        const totalPixels = labPixels.length / 3;

        const preservedColors = [];

        // Track which preserved colors actually made it (for later use)
        let actuallyPreservedWhite = false;
        let actuallyPreservedBlack = false;

        if (preserveWhite) {
            const pixelCount = preservedPixelMap.has('white') ? preservedPixelMap.get('white').size : 0;
            const coverage = pixelCount / totalPixels;

            if (coverage >= MIN_PRESERVED_COVERAGE) {
                const absoluteWhite = { L: 100, a: 0, b: 0 };
                // Read preservedUnifyThreshold from options (default: 12.0, Jethro: 0.5)
                const UNIFY_THRESHOLD = options.preservedUnifyThreshold !== undefined
                    ? options.preservedUnifyThreshold
                    : PosterizationEngine.PRESERVED_UNIFY_THRESHOLD;

                // Check if palette already has a highlight color close to white
                const existingMatch = curatedPaletteLab.find(color =>
                    PosterizationEngine._labDistance(color, absoluteWhite) < UNIFY_THRESHOLD
                );

                if (existingMatch) {
                    const deltaE = PosterizationEngine._labDistance(existingMatch, absoluteWhite);
                    logger.log(`  🔗 White unified with existing color (L=${existingMatch.L.toFixed(1)}, ΔE=${deltaE.toFixed(1)}, threshold=${UNIFY_THRESHOLD})`);
                } else {
                    preservedColors.push(absoluteWhite);
                    actuallyPreservedWhite = true;
                    logger.log(`  + Added white to palette (${pixelCount} pixels, ${(coverage * 100).toFixed(2)}%)`);
                }
            } else {
                logger.log(`  🗑️ Skipped white - below viability threshold (${pixelCount} pixels, ${(coverage * 100).toFixed(3)}% < ${(MIN_PRESERVED_COVERAGE * 100).toFixed(1)}%)`);
            }
        }
        if (preserveBlack) {
            const pixelCount = preservedPixelMap.has('black') ? preservedPixelMap.get('black').size : 0;
            const coverage = pixelCount / totalPixels;

            if (coverage >= MIN_PRESERVED_COVERAGE) {
                const absoluteBlack = { L: 0, a: 0, b: 0 };
                // Read preservedUnifyThreshold from options (default: 12.0, Jethro: 0.5)
                const UNIFY_THRESHOLD = options.preservedUnifyThreshold !== undefined
                    ? options.preservedUnifyThreshold
                    : PosterizationEngine.PRESERVED_UNIFY_THRESHOLD;

                // Check if palette already has a deep shadow color close to black
                const existingMatch = curatedPaletteLab.find(color =>
                    PosterizationEngine._labDistance(color, absoluteBlack) < UNIFY_THRESHOLD
                );

                if (existingMatch) {
                    const deltaE = PosterizationEngine._labDistance(existingMatch, absoluteBlack);
                    logger.log(`  🔗 Black unified with existing color (L=${existingMatch.L.toFixed(1)}, ΔE=${deltaE.toFixed(1)}, threshold=${UNIFY_THRESHOLD})`);
                } else {
                    preservedColors.push(absoluteBlack);
                    actuallyPreservedBlack = true;
                    logger.log(`  + Added black to palette (${pixelCount} pixels, ${(coverage * 100).toFixed(2)}%)`);
                }
            } else {
                logger.log(`  🗑️ Skipped black - below viability threshold (${pixelCount} pixels, ${(coverage * 100).toFixed(3)}% < ${(MIN_PRESERVED_COVERAGE * 100).toFixed(1)}%)`);
            }
        }

        // Step 3.6: Add substrate color to palette (if detected)
        // Substrate is added as a technical color for accurate pixel mapping
        // It represents the paper/medium itself, not an ink layer
        const substrateColors = [];
        if (substrateLab) {
            // Check if substrate is similar to any preserved color
            // If so, skip adding substrate to avoid duplicates (e.g., white substrate + preserveWhite)
            // SHADOW GATE FOR SUBSTRATE: If substrate is too dark (L < 6), skip it.
            // Dark substrates are effectively black and we already have preserved black.
            if (substrateLab.L < 6.0) {
                logger.log(`  ! Substrate (L=${substrateLab.L.toFixed(1)}) is too dark (L < 6) - skipping (Shadow Gate)`);
            }
            // HIGHLIGHT GATE FOR SUBSTRATE: If substrate is too bright (L > 98), skip it.
            // Bright substrates are effectively white/paper and we already have preserved white.
            else if (substrateLab.L > 98.0) {
                logger.log(`  ! Substrate (L=${substrateLab.L.toFixed(1)}) is too bright (L > 98) - skipping (Highlight Gate)`);
            } else {
                const DUPLICATE_THRESHOLD = 3.0; // ΔE threshold for considering colors identical
                let isDuplicate = false;

                for (const preserved of preservedColors) {
                    const dL = substrateLab.L - preserved.L;
                    const da = substrateLab.a - preserved.a;
                    const db = substrateLab.b - preserved.b;
                    const deltaE = Math.sqrt(dL * dL + da * da + db * db);

                    if (deltaE < DUPLICATE_THRESHOLD) {
                        isDuplicate = true;
                        logger.log(`  ! Substrate (L=${substrateLab.L.toFixed(1)} a=${substrateLab.a.toFixed(1)} b=${substrateLab.b.toFixed(1)}) is too similar to preserved color (ΔE=${deltaE.toFixed(2)}) - skipping to avoid duplicate`);
                        break;
                    }
                }

                if (!isDuplicate) {
                    substrateColors.push(substrateLab);
                    logger.log(`  + Added substrate to palette: L=${substrateLab.L.toFixed(1)} a=${substrateLab.a.toFixed(1)} b=${substrateLab.b.toFixed(1)} (paper/medium)`);
                }
            }
        }

        // Final palette: quantized colors + preserved colors + substrate
        let finalPaletteLab = [...curatedPaletteLab, ...preservedColors, ...substrateColors];
        logger.log(`✓ Final palette: ${finalPaletteLab.length} colors (${curatedPaletteLab.length} quantized + ${preservedColors.length} preserved + ${substrateColors.length} substrate)`);

        // Step 4: Convert palette back to RGB
        let paletteRgb = finalPaletteLab.map(lab => this.labToRgb(lab));

        // Step 5: Assign each pixel to nearest palette color (HARD SNAP - Zero Dither)
        // Every pixel belongs 100% to one feature color - no error diffusion, no dithering.
        // This ensures razor-sharp boundaries required for high-end spot color separations.
        // Lab = 3 channels (L,a,b), RGB = 4 channels (RGBA)
        // CRITICAL: Use Uint16Array to support palettes with >255 colors (quantized + preserved + substrate)
        let assignments = new Uint16Array(pixels.length / (isLabInput ? 3 : 4));

        // Calculate palette indices for preserved colors (based on actual inclusion, not checkbox state)
        // Use actuallyPreservedWhite/Black which account for the viability threshold
        let preservedColorIndex = curatedPaletteLab.length;
        const whiteIndex = actuallyPreservedWhite ? preservedColorIndex++ : -1;
        const blackIndex = actuallyPreservedBlack ? preservedColorIndex++ : -1;

        // PERFORMANCE OPTIMIZATION: Preview mode uses stride sampling
        // This reduces distance calculations (4× stride = 1/16 pixels computed)
        // For 800×600 preview: 480k → 30k distance calculations (at stride=4)
        // User-selectable: Standard=4 (fast), Fine=2 (slow), Finest=1 (slower)
        const isPreview = options.isPreview === true;
        const useStride = isPreview && options.optimizePreview !== false;
        const ASSIGNMENT_STRIDE = useStride ? (options.previewStride || 4) : 1;

        if (useStride) {
            const labels = { 4: 'Standard', 2: 'Fine', 1: 'Finest' };
            logger.log(`Assigning pixels to palette (preview mode with ${ASSIGNMENT_STRIDE}× stride)...`);
        } else {
            logger.log(`Assigning pixels to palette...`);
        }

        // STRIDE-AWARE 2D ASSIGNMENT (Optimized for UXP performance)
        // PRE-FETCH sets outside the loop to avoid "Property Bleed"
        const whiteSet = preservedPixelMap.get('white');
        const blackSet = preservedPixelMap.get('black');
        const paletteLength = finalPaletteLab.length;

        // 16-BIT INTEGER PRECISION FIX:
        // Pre-convert palette to 16-bit integer space ONCE to avoid floating-point
        // precision loss during comparison. This preserves subtle color differences
        // (especially chromatic zero-crossings where a*/b* values are near neutral).
        //
        // Engine 16-bit encoding: L: 0-32768, a/b: 0-32768 (16384=neutral)
        // Perceptual Lab: L: 0-100, a/b: -128 to +127
        const palette16 = finalPaletteLab.map(p => ({
            L: (p.L / 100) * 32768,
            a: (p.a + 128) * 128,  // Map -128..+127 to 0..32768
            b: (p.b + 128) * 128
        }));

        // Use raw 16-bit pixels if available (Lab input), otherwise fall back to labPixels
        const useInteger16 = isLabInput && pixels;

        for (let y = 0; y < height; y += ASSIGNMENT_STRIDE) {
            const rowOffset = y * width; // Pre-calculate row start

            for (let x = 0; x < width; x += ASSIGNMENT_STRIDE) {
                const anchorI = rowOffset + x;
                let anchorAssignment = 0;

                // --- STEP A: CALCULATE ANCHOR COLOR ---
                if (transparentPixels.has(anchorI)) {
                    anchorAssignment = 255; // Special value for transparent
                } else {
                    let isPreserved = false;

                    // Direct Set check (avoid Map lookup inside loop)
                    if (actuallyPreservedWhite && whiteSet && whiteSet.has(anchorI)) {
                        anchorAssignment = whiteIndex;
                        isPreserved = true;
                    } else if (actuallyPreservedBlack && blackSet && blackSet.has(anchorI)) {
                        anchorAssignment = blackIndex;
                        isPreserved = true;
                    }

                    if (!isPreserved) {
                        const idx = anchorI * 3;
                        let minDistance = Infinity;

                        if (useInteger16) {
                            // INTEGER 16-BIT DISTANCE (preserves full precision)
                            const rawL = pixels[idx];
                            const rawA = pixels[idx + 1];
                            const rawB = pixels[idx + 2];

                            for (let j = 0; j < paletteLength; j++) {
                                const target16 = palette16[j];
                                const dL = rawL - target16.L;
                                const dA = rawA - target16.a;
                                const dB = rawB - target16.b;

                                // Squared Euclidean distance (L weighted 1.5× for perceptual accuracy)
                                const dist = grayscaleOnly ? (dL * dL) : (1.5 * dL * dL + dA * dA + dB * dB);

                                if (dist < minDistance) {
                                    minDistance = dist;
                                    anchorAssignment = j;
                                }
                            }
                        } else {
                            // FLOAT DISTANCE (fallback for non-Lab inputs)
                            const pL = labPixels[idx];
                            const pA = labPixels[idx + 1];
                            const pB = labPixels[idx + 2];

                            for (let j = 0; j < paletteLength; j++) {
                                const target = finalPaletteLab[j];
                                const dL = pL - target.L;
                                const dA = pA - target.a;
                                const dB = pB - target.b;

                                // Squared Euclidean distance (L weighted 1.5× for perceptual accuracy)
                                const dist = grayscaleOnly ? (dL * dL) : (1.5 * dL * dL + dA * dA + dB * dB);

                                if (dist < minDistance) {
                                    minDistance = dist;
                                    anchorAssignment = j;
                                }
                            }
                        }
                    }
                }

                // --- STEP B: STAMP THE BLOCK ---
                // Stamp blocks row-by-row to maintain memory locality
                for (let bY = 0; bY < ASSIGNMENT_STRIDE && (y + bY) < height; bY++) {
                    const fillRow = (y + bY) * width;
                    for (let bX = 0; bX < ASSIGNMENT_STRIDE && (x + bX) < width; bX++) {
                        assignments[fillRow + (x + bX)] = anchorAssignment;
                    }
                }
            }
        }

        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(3);
        logger.log(`✓ Lab-space posterization complete in ${duration}s`);

        if (finalPaletteLab.length < targetColors) {
            logger.log(`ℹ Final palette: ${finalPaletteLab.length} colors (requested: ${targetColors})`);
        }

        // Apply density floor to remove ghost colors (<0.5% coverage by default)
        // IMPORTANT: Never remove preserved colors (white/black) or substrate
        // Use actuallyPreserved flags - if a color was skipped by viability threshold, don't protect it
        // Read densityFloor from options (default: 0.005 = 0.5%, Jethro: 0.0 = disabled)
        const densityFloorThreshold = options.densityFloor !== undefined ? options.densityFloor : 0.005;

        if (densityFloorThreshold > 0) {
            const protectedIndices = new Set();
            if (actuallyPreservedWhite) protectedIndices.add(whiteIndex);
            if (actuallyPreservedBlack) protectedIndices.add(blackIndex);
            if (substrateLab) protectedIndices.add(finalPaletteLab.length - 1);  // Substrate is always last

            const densityResult = this._applyDensityFloor(
                assignments,
                finalPaletteLab,
                densityFloorThreshold,
                protectedIndices
            );

            if (densityResult.actualCount < finalPaletteLab.length) {
                const removed = finalPaletteLab.length - densityResult.actualCount;
                logger.log(`✓ Density floor: Removed ${removed} ghost color(s) with < ${(densityFloorThreshold * 100).toFixed(1)}% coverage`);
                logger.log(`  Final palette: ${densityResult.actualCount} colors (down from ${finalPaletteLab.length})`);

                // Use the cleaned palette and remapped assignments
                finalPaletteLab = densityResult.palette;
                assignments = densityResult.assignments;

                // CRITICAL: Regenerate RGB palette to match filtered Lab palette
                paletteRgb = finalPaletteLab.map(lab => this.labToRgb(lab));
            }
        } else {
            logger.log(`✓ Density floor disabled (threshold: ${densityFloorThreshold})`);
        }

        // Track substrate index for UI filtering and layer identification
        const substrateIndex = substrateLab ? (curatedPaletteLab.length + preservedColors.length) : null;

        return {
            palette: paletteRgb,           // RGB version for UI display
            paletteLab: finalPaletteLab,   // Lab version for layer creation (NO CONVERSION NEEDED)
            assignments,
            labPixels,  // Lab pixel data for preview rendering
            substrateLab,  // Substrate anchor color (for UI display and full-res separation)
            substrateIndex,  // Index of substrate in palette (null if no substrate)
            metadata: {
                targetColors,
                finalColors: finalPaletteLab.length,
                snapThreshold,
                duration: parseFloat(duration)
            }
        };

    }

    /**
     * Reveal Mk 1.5 Engine: Deterministic Auto-Quantizer
     *
     * Pre-scans for "Identity Peaks" (high chroma + low volume + distinct from neighbors)
     * and automatically reserves palette slots for them before median cut runs.
     *
     * PURPOSE: Solves the "low-volume important color" problem without user input.
     * Auto-detects colors like Monroe blue (0.1% coverage) that would be lost in
     * probabilistic median cut.
     *
     * ALGORITHM:
     * 1. Convert to perceptual Lab space
     * 2. [NEW] Scan for identity peaks (C>30, vol<5%, ΔE>15)
     * 3. [NEW] Reserve N slots for detected peaks
     * 4. Run median cut on remaining budget
     * 5. Apply perceptual snap + palette reduction
     * 6. [NEW] Inject peaks into final palette
     * 7. [NEW] Protect peaks from density floor
     * 8. Standard pixel assignment
     *
     * @param {Uint16Array} pixels - 16-bit Lab pixel data (MUST be Lab format)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} targetColors - Total palette size
     * @param {Object} options - Engine options
     * @returns {Object} Standard posterization result with auto-anchor metadata
     */
    static _posterizeRevealMk1_5(pixels, width, height, targetColors, options = {}) {
        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_entry');
        logger.log(`🔵 CHECKPOINT 1: Entering _posterizeRevealMk1_5`);

        // CIE76 LEGACY V1 MODE DETECTION (same as _posterizeReveal)
        const distanceMetric = options.distanceMetric || 'cie76';
        const isLegacyV1Mode = distanceMetric === 'cie76';

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_metric_parsed');
        logger.log(`🔵 CHECKPOINT 2: distanceMetric=${distanceMetric}, isLegacyV1Mode=${isLegacyV1Mode}`);

        let snapThreshold = options.snapThreshold !== undefined ? options.snapThreshold : 8.0;
        let enablePaletteReduction = options.enablePaletteReduction !== undefined ? options.enablePaletteReduction : true;
        let paletteReduction = options.paletteReduction !== undefined ? options.paletteReduction : 8.0;
        let preservedUnifyThreshold = options.preservedUnifyThreshold !== undefined ? options.preservedUnifyThreshold : 12.0;
        let densityFloor = options.densityFloor !== undefined ? options.densityFloor : 0.005;

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_thresholds_set');
        logger.log(`🔵 CHECKPOINT 3: Initial thresholds set`);

        if (isLegacyV1Mode) {
            logger.log(`🔧 LEGACY V1 MODE (Mk 1.5): CIE76 detected → Disabling Mk 1.5 "smart" features`);
            snapThreshold = 0.0;              // Kill perceptual snap
            enablePaletteReduction = false;   // Kill palette reduction
            preservedUnifyThreshold = 0.5;    // Kill white/black unification
            densityFloor = 0.0;               // Kill density floor removal

            // Update options object so these values are used throughout the function
            options.snapThreshold = snapThreshold;
            options.enablePaletteReduction = enablePaletteReduction;
            options.paletteReduction = paletteReduction;
            options.preservedUnifyThreshold = preservedUnifyThreshold;
            options.densityFloor = densityFloor;

            logger.log(`   snapThreshold: ${snapThreshold} (no merging)`);
            logger.log(`   enablePaletteReduction: ${enablePaletteReduction} (no pruning)`);
            logger.log(`   preservedUnifyThreshold: ${preservedUnifyThreshold} (no white/black unification)`);
            logger.log(`   densityFloor: ${densityFloor} (no ghost removal)`);
        }

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_legacy_mode_done');
        logger.log(`🔵 CHECKPOINT 4: Legacy V1 mode processing complete`);

        const grayscaleOnly = options.grayscaleOnly !== undefined ? options.grayscaleOnly : false;
        const preserveWhite = options.preserveWhite !== undefined ? options.preserveWhite : false;
        const preserveBlack = options.preserveBlack !== undefined ? options.preserveBlack : false;
        const vibrancyMode = options.vibrancyMode !== undefined ? options.vibrancyMode : 'aggressive';
        const vibrancyBoost = options.vibrancyBoost !== undefined ? options.vibrancyBoost : 2.0;
        const highlightThreshold = options.highlightThreshold !== undefined ? options.highlightThreshold : 92;
        const highlightBoost = options.highlightBoost !== undefined ? options.highlightBoost : 3.0;

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_options_parsed');
        logger.log(`🔵 CHECKPOINT 5: Options parsed`);

        logger.log(`\n[Reveal Mk 1.5] Starting deterministic auto-quantizer: ${targetColors} target colors`);
        logger.log(`  Mode: Automatic outlier detection + median cut`);

        const preserveList = [];
        if (preserveWhite) preserveList.push('white');
        if (preserveBlack) preserveList.push('black');
        if (preserveList.length > 0) {
            logger.log(`  Preserve colors: ${preserveList.join(', ')}`);
        }

        const startTime = performance.now();

        logger.log(`🔵 CHECKPOINT 6: Starting performance timer`);

        const isLabInput = options.format === 'lab';
        if (!isLabInput) {
            throw new Error('[Reveal Mk 1.5] Requires Lab input format (RGB not supported)');
        }

        logger.log(`🔵 CHECKPOINT 7: Validated Lab input format`);

        const sourceBitDepth = options.bitDepth || 16;
        const isEightBitSource = sourceBitDepth <= 8;

        logger.log(`🔵 CHECKPOINT 8: Bit depth=${sourceBitDepth}`);

        // Step 1: Convert to perceptual Lab space (reuse _posterizeReveal logic)
        logger.log(`✓ Using 16-bit Lab pixels (original source: ${sourceBitDepth}-bit → Float32 perceptual ranges)`);

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_before_float32array');
        logger.log(`🔵 CHECKPOINT 9: About to allocate Float32Array(${pixels.length})`);
        const labPixels = new Float32Array(pixels.length);
        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_float32array_allocated');
        logger.log(`🔵 CHECKPOINT 10: Float32Array allocated successfully`);

        const shadowThreshold = isEightBitSource ? 7.5 : 6.0;
        const highlightThresholdGate = isEightBitSource ? 97.5 : 98.0;

        if (isEightBitSource) {
            logger.log(`  8-bit source: Using expanded gates (Shadow L<${shadowThreshold}, Highlight L>${highlightThresholdGate})`);
        } else {
            logger.log(`  16-bit source: Using standard gates (Shadow L<${shadowThreshold}, Highlight L>${highlightThresholdGate})`);
        }

        const maxValue = 32768;
        const neutralAB = 16384;
        const abScale = 128 / 16384;

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_before_pixel_loop');
        logger.log(`🔵 CHECKPOINT 11: Starting pixel conversion loop (${pixels.length / 3} pixels)`);

        for (let i = 0; i < pixels.length; i += 3) {
            labPixels[i] = (pixels[i] / maxValue) * 100;
            labPixels[i + 1] = (pixels[i + 1] - neutralAB) * abScale;
            labPixels[i + 2] = (pixels[i + 2] - neutralAB) * abScale;

            if (labPixels[i] < shadowThreshold) {
                labPixels[i] = 0;
                labPixels[i + 1] = 0;
                labPixels[i + 2] = 0;
            } else if (labPixels[i] > highlightThresholdGate) {
                labPixels[i] = 100;
                labPixels[i + 1] = 0;
                labPixels[i + 2] = 0;
            }
        }

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_pixel_loop_done');
        logger.log(`🔵 CHECKPOINT 12: Pixel conversion loop complete`);
        logger.log(`✓ Converted ${pixels.length / 3} Lab pixels to perceptual ranges`);

        // ========== [NEW] Hard Chromance Gate: Achromatic Purge ==========
        // Delete color data from low-chroma pixels (halftone noise suppression)
        const chromaGateThreshold = options.chromaGateThreshold !== undefined ? options.chromaGateThreshold : 0;

        if (chromaGateThreshold > 0) {
            let purgedCount = 0;
            logger.log(`\n[Hard Chromance Gate] Applying achromatic purge (C < ${chromaGateThreshold})`);

            for (let i = 0; i < labPixels.length; i += 3) {
                const a = labPixels[i + 1];
                const b = labPixels[i + 2];
                const chroma = Math.sqrt(a * a + b * b);

                // If chroma below threshold, physically delete color data (pure gray)
                if (chroma < chromaGateThreshold) {
                    labPixels[i + 1] = 0;  // a* = 0
                    labPixels[i + 2] = 0;  // b* = 0
                    purgedCount++;
                }
            }

            const purgedPercent = (purgedCount / (labPixels.length / 3)) * 100;
            logger.log(`✓ Achromatic purge complete: ${purgedCount} pixels (${purgedPercent.toFixed(1)}%) converted to pure gray`);
            logger.log(`  Goal: Make low-chroma halftone noise mathematically unable to join chromatic plates`);
        }
        // =================================================================

        logger.log(`🔵 CHECKPOINT 13: Starting peak detection setup`);

        // ========== [NEW] Mk 1.5: Auto-detect OR use pre-defined anchors ==========
        // Extract PeakFinder parameters from options (set by archetype)
        const peakFinderMaxPeaks = options.peakFinderMaxPeaks !== undefined ? options.peakFinderMaxPeaks : 1;
        const peakFinderPreferredSectors = options.peakFinderPreferredSectors || null;
        const peakFinderBlacklistedSectors = options.peakFinderBlacklistedSectors || [3, 4]; // Default: blacklist green

        // Check if archetype provides pre-defined forced centroids
        let forcedCentroids = [];
        let usedPredefinedAnchors = false;
        let detectedPeaks = []; // Initialize outside to avoid scoping issues

        // Support both forcedCentroids (camelCase) and forced_centroids (snake_case)
        const forcedCentroidsInput = options.forcedCentroids || options.forced_centroids;

        logger.log(`🔵 CHECKPOINT 14: forcedCentroidsInput=${forcedCentroidsInput ? forcedCentroidsInput.length : 'none'}`);

        if (forcedCentroidsInput && Array.isArray(forcedCentroidsInput) && forcedCentroidsInput.length > 0) {
            // Use pre-defined anchors from archetype (Golden Master mode)
            logger.log(`\n[Reveal Mk 1.5] Using ${forcedCentroidsInput.length} pre-defined forced centroids from archetype`);
            try {
                forcedCentroids = forcedCentroidsInput.map(anchor => {
                    const centroid = {
                        L: Number(anchor.L || anchor.l),
                        a: Number(anchor.a),
                        b: Number(anchor.b)
                    };
                    logger.log(`  Anchor: L=${centroid.L.toFixed(1)} a=${centroid.a.toFixed(1)} b=${centroid.b.toFixed(1)} (${anchor.name || 'UNNAMED'})`);
                    return centroid;
                });
                usedPredefinedAnchors = true;
            } catch (error) {
                logger.error(`  ✗ Error parsing forcedCentroids: ${error.message}`);
                logger.log(`  Falling back to auto-detection`);
            }
        }

        // Fall back to auto-detection if no valid pre-defined anchors
        if (!usedPredefinedAnchors) {
            const peakFinder = new PeakFinder({
                chromaThreshold: 30,
                volumeThreshold: 0.05,
                maxPeaks: peakFinderMaxPeaks,
                preferredSectors: peakFinderPreferredSectors,
                blacklistedSectors: peakFinderBlacklistedSectors
            });

            logger.log(`  PeakFinder config: maxPeaks=${peakFinderMaxPeaks}, blacklist=[${peakFinderBlacklistedSectors.join(',')}], preferred=${peakFinderPreferredSectors ? '[' + peakFinderPreferredSectors.join(',') + ']' : 'none'}`);

            // Pass bitDepth for adaptive thresholds (8.0 for 16-bit, 15.0 for 8-bit)
            detectedPeaks = peakFinder.findIdentityPeaks(labPixels, { bitDepth: sourceBitDepth });

            // Convert peaks to forcedCentroids format
            forcedCentroids = detectedPeaks.map(peak => ({
                L: peak.L,
                a: peak.a,
                b: peak.b
            }));

            logger.log(`\n[Reveal Mk 1.5] Auto-detected ${forcedCentroids.length} identity peaks`);
        }
        // =============================================================

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_peak_detection_done');
        logger.log(`🔵 CHECKPOINT 15: Peak detection complete, forcedCentroids=${forcedCentroids.length}`);

        // Step 1.5: Handle preserved colors (white/black)
        let preservedPixelMap = new Map();
        let nonPreservedIndices = [];

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_before_preserved_detection');
        logger.log(`🔵 CHECKPOINT 16: Starting preserved colors detection`);

        const WHITE_L_MIN = 95;
        const BLACK_L_MAX = 10;
        const AB_THRESHOLD = isEightBitSource ? 5 : 0.01;

        for (let i = 0; i < labPixels.length; i += 3) {
            const L = labPixels[i];
            const a = labPixels[i + 1];
            const b = labPixels[i + 2];
            const pixelIndex = i / 3;

            let isPreserved = false;

            if (preserveWhite && L > WHITE_L_MIN && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                if (!preservedPixelMap.has('white')) {
                    preservedPixelMap.set('white', new Set());
                }
                preservedPixelMap.get('white').add(pixelIndex);
                isPreserved = true;
            } else if (preserveBlack && L < BLACK_L_MAX && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                if (!preservedPixelMap.has('black')) {
                    preservedPixelMap.set('black', new Set());
                }
                preservedPixelMap.get('black').add(pixelIndex);
                isPreserved = true;
            }

            if (!isPreserved) {
                nonPreservedIndices.push(pixelIndex);
            }
        }

        const totalPixels = labPixels.length / 3;
        preservedPixelMap.forEach((indices, colorName) => {
            const percent = ((indices.size / totalPixels) * 100).toFixed(1);
            logger.log(`✓ Preserved ${indices.size} ${colorName} pixels (${percent}%)`);
        });

        // ========== [NEW] Slot reservation logic ==========
        let numPreserved = 0;
        if (preserveWhite) numPreserved++;
        if (preserveBlack) numPreserved++;

        const numForced = forcedCentroids.length;
        const medianCutTarget = Math.max(1, targetColors - numForced - numPreserved);

        logger.log(`\n[Slot Reservation]`);
        logger.log(`  Total budget:      ${targetColors} colors`);
        logger.log(`  Auto-anchors:      ${numForced} slots (identity peaks)`);
        logger.log(`  Preserved colors:  ${numPreserved} slots`);
        logger.log(`  Median cut budget: ${medianCutTarget} slots`);
        // ==================================================

        logger.log(`🔵 CHECKPOINT 17: Extracting non-preserved pixels`);

        // Extract non-preserved pixels for quantization
        let nonPreservedLabPixels = labPixels;
        if (nonPreservedIndices.length < labPixels.length / 3) {
            nonPreservedLabPixels = new Float32Array(nonPreservedIndices.length * 3);
            for (let i = 0; i < nonPreservedIndices.length; i++) {
                const srcIdx = nonPreservedIndices[i] * 3;
                nonPreservedLabPixels[i * 3] = labPixels[srcIdx];
                nonPreservedLabPixels[i * 3 + 1] = labPixels[srcIdx + 1];
                nonPreservedLabPixels[i * 3 + 2] = labPixels[srcIdx + 2];
            }
        }

        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_before_median_cut');
        logger.log(`🔵 CHECKPOINT 18: About to call medianCutInLabSpace with ${medianCutTarget} colors`);

        // Step 2: Run median cut with reduced target
        logger.log(`\nRunning median cut in Lab space (${medianCutTarget} colors)...`);
        const initialPaletteLab = this.medianCutInLabSpace(
            nonPreservedLabPixels,
            medianCutTarget,
            grayscaleOnly,
            width,
            height,
            null, // No substrate for Mk 1.5
            3.5,
            vibrancyMode,
            vibrancyBoost,
            highlightThreshold,
            highlightBoost,
            options.strategy || null,
            options.tuning || null
        );
        if (typeof localStorage !== 'undefined') localStorage.setItem('reveal_checkpoint', 'mk15_median_cut_done');
        logger.log(`🔵 CHECKPOINT 19: medianCutInLabSpace completed`);
        logger.log(`✓ Initial palette: ${initialPaletteLab.length} colors`);

        // Step 3: Apply perceptual snap
        const colorSpaceAnalysis = this._analyzeColorSpace(labPixels);
        const isGrayscale = grayscaleOnly || colorSpaceAnalysis.chromaRange < 10;

        let lRange = 0;
        let colorSpaceExtent = null;

        if (isGrayscale) {
            let minL = Infinity, maxL = -Infinity;
            for (let i = 0; i < labPixels.length; i += 3) {
                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
            }
            lRange = maxL - minL;
        } else {
            let minL = Infinity, maxL = -Infinity;
            let minA = Infinity, maxA = -Infinity;
            let minB = Infinity, maxB = -Infinity;

            for (let i = 0; i < labPixels.length; i += 3) {
                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
                minA = Math.min(minA, labPixels[i + 1]);
                maxA = Math.max(maxA, labPixels[i + 1]);
                minB = Math.min(minB, labPixels[i + 2]);
                maxB = Math.max(maxB, labPixels[i + 2]);
            }

            colorSpaceExtent = {
                lRange: maxL - minL,
                aRange: maxA - minA,
                bRange: maxB - minB
            };
        }

        const adaptiveThreshold = this._getAdaptiveSnapThreshold(
            snapThreshold,
            targetColors,
            isGrayscale,
            lRange,
            colorSpaceExtent
        );

        logger.log(`  Adaptive snap threshold: ΔE ${adaptiveThreshold.toFixed(1)}`);

        let snappedPaletteLab = this.applyPerceptualSnap(
            initialPaletteLab,
            adaptiveThreshold,
            isGrayscale,
            vibrancyBoost,
            options.strategy || null,
            options.tuning || null
        );
        logger.log(`✓ Snapped palette: ${snappedPaletteLab.length} colors`);

        // Step 4: Palette reduction (if over budget after snap)
        if (enablePaletteReduction && snappedPaletteLab.length > medianCutTarget) {
            const prunedPaletteLab = this._prunePalette(snappedPaletteLab, paletteReduction, highlightThreshold, medianCutTarget, options.tuning || null);
            if (prunedPaletteLab.length < snappedPaletteLab.length) {
                logger.log(`✓ Palette pruned: ${snappedPaletteLab.length} → ${prunedPaletteLab.length} colors`);
                snappedPaletteLab = prunedPaletteLab;
            }
        }

        // ========== [NEW] Anchor injection (after perceptual snap) ==========
        logger.log(`\n[Anchor Injection]`);
        const mergedPalette = [...snappedPaletteLab];
        let addedCount = 0;
        let skippedCount = 0;
        const anchorDuplicateThreshold = 3.0;

        for (const forced of forcedCentroids) {
            const isDuplicate = mergedPalette.some(color =>
                this._labDistance(color, forced) < anchorDuplicateThreshold
            );

            if (isDuplicate) {
                logger.log(`  ✗ Skipped peak (duplicate within ΔE ${anchorDuplicateThreshold})`);
                skippedCount++;
            } else {
                mergedPalette.push(forced);
                logger.log(`  ✓ Added peak: L=${forced.L.toFixed(1)} a=${forced.a.toFixed(1)} b=${forced.b.toFixed(1)}`);
                addedCount++;
            }
        }
        logger.log(`  Summary: ${addedCount} peaks added, ${skippedCount} skipped (duplicates)`);
        // ====================================================================

        // Step 5: Add preserved colors (white/black)
        const preservedColors = [];
        let actuallyPreservedWhite = false;
        let actuallyPreservedBlack = false;
        let whiteIndex = -1;
        let blackIndex = -1;

        if (preserveWhite) {
            const whitePixels = preservedPixelMap.get('white');
            if (whitePixels && whitePixels.size >= totalPixels * PosterizationEngine.MIN_PRESERVED_COVERAGE) {
                preservedColors.push({ L: 100, a: 0, b: 0 });
                whiteIndex = mergedPalette.length + preservedColors.length - 1;
                actuallyPreservedWhite = true;
                logger.log(`✓ Added white to palette (index ${whiteIndex})`);
            }
        }

        if (preserveBlack) {
            const blackPixels = preservedPixelMap.get('black');
            if (blackPixels && blackPixels.size >= totalPixels * PosterizationEngine.MIN_PRESERVED_COVERAGE) {
                preservedColors.push({ L: 0, a: 0, b: 0 });
                blackIndex = mergedPalette.length + preservedColors.length - 1;
                actuallyPreservedBlack = true;
                logger.log(`✓ Added black to palette (index ${blackIndex})`);
            }
        }

        const finalPaletteLab = [...mergedPalette, ...preservedColors];
        logger.log(`\n✓ Final palette before density floor: ${finalPaletteLab.length} colors`);

        // Step 6: Pixel assignment (with preview stride support)
        const paletteRgb = finalPaletteLab.map(lab => this.labToRgb(lab));
        const assignments = new Uint8Array(width * height);

        // PERFORMANCE OPTIMIZATION: Preview mode uses stride sampling
        // This reduces distance calculations (4× stride = 1/16 pixels computed)
        // User-selectable: Standard=4 (fast), Fine=2 (slow), Finest=1 (slower)
        const isPreview = options.isPreview === true;
        const useStride = isPreview && options.optimizePreview !== false;
        const ASSIGNMENT_STRIDE = useStride ? (options.previewStride || 4) : 1;

        if (useStride) {
            const labels = { 4: 'Standard', 2: 'Fine', 1: 'Finest' };
            logger.log(`Assigning pixels to palette (preview mode with ${ASSIGNMENT_STRIDE}× stride)...`);
        } else {
            logger.log(`Assigning pixels to palette...`);
        }

        const paletteLength = finalPaletteLab.length;

        // Extract distance options for accurate assignment
        const assignDistanceMetric = options.distanceMetric || 'squared';
        const lWeight = options.lWeight !== undefined ? options.lWeight : 1.0;
        const cWeight = options.cWeight !== undefined ? options.cWeight : 1.0;

        for (let y = 0; y < height; y += ASSIGNMENT_STRIDE) {
            for (let x = 0; x < width; x += ASSIGNMENT_STRIDE) {
                let anchorAssignment = 0;

                for (let bY = 0; bY < ASSIGNMENT_STRIDE && (y + bY) < height; bY += 2) {
                    for (let bX = 0; bX < ASSIGNMENT_STRIDE && (x + bX) < width; bX += 2) {
                        const pixelIndex = (y + bY) * width + (x + bX);
                        const preservedColorKey = [...preservedPixelMap.entries()].find(([_, indices]) => indices.has(pixelIndex));

                        if (preservedColorKey) {
                            const colorName = preservedColorKey[0];
                            if (colorName === 'white' && actuallyPreservedWhite) {
                                anchorAssignment = whiteIndex;
                            } else if (colorName === 'black' && actuallyPreservedBlack) {
                                anchorAssignment = blackIndex;
                            }
                        } else {
                            let minDistance = Infinity;
                            const idx = pixelIndex * 3;

                            const pL = labPixels[idx];
                            const pA = labPixels[idx + 1];
                            const pB = labPixels[idx + 2];

                            for (let j = 0; j < paletteLength; j++) {
                                const target = finalPaletteLab[j];

                                let dist;
                                if (grayscaleOnly) {
                                    const dL = pL - target.L;
                                    dist = dL * dL;
                                } else {
                                    // Use proper distance metric from options
                                    if (assignDistanceMetric === 'cie76') {
                                        dist = LabDistance.cie76SquaredInline(pL, pA, pB, target.L, target.a, target.b);
                                    } else if (assignDistanceMetric === 'cie94') {
                                        const C1 = Math.sqrt(pA * pA + pB * pB);
                                        dist = LabDistance.cie94SquaredInline(pL, pA, pB, target.L, target.a, target.b, C1);
                                    } else if (assignDistanceMetric === 'cie2000') {
                                        dist = LabDistance.cie2000SquaredInline(pL, pA, pB, target.L, target.a, target.b);
                                    } else {
                                        // Squared Euclidean with weights
                                        const dL = pL - target.L;
                                        const dA = pA - target.a;
                                        const dB = pB - target.b;
                                        const dC = Math.sqrt(dA * dA + dB * dB);
                                        dist = (lWeight * dL * dL) + (cWeight * dC * dC);
                                    }
                                }

                                if (dist < minDistance) {
                                    minDistance = dist;
                                    anchorAssignment = j;
                                }
                            }
                        }
                    }
                }

                for (let bY = 0; bY < ASSIGNMENT_STRIDE && (y + bY) < height; bY++) {
                    const fillRow = (y + bY) * width;
                    for (let bX = 0; bX < ASSIGNMENT_STRIDE && (x + bX) < width; bX++) {
                        assignments[fillRow + (x + bX)] = anchorAssignment;
                    }
                }
            }
        }

        const endTime = performance.now();
        const duration = ((endTime - startTime) / 1000).toFixed(3);
        logger.log(`\n✓ Reveal Mk 1.5 complete in ${duration}s`);

        // ========== [NEW] Protect anchors from density floor ==========
        const protectedIndices = new Set();
        if (actuallyPreservedWhite) protectedIndices.add(whiteIndex);
        if (actuallyPreservedBlack) protectedIndices.add(blackIndex);

        // Protect auto-detected peaks from density floor removal
        for (let i = snappedPaletteLab.length; i < mergedPalette.length; i++) {
            protectedIndices.add(i);
            logger.log(`  Protected auto-anchor at index ${i} from density floor`);
        }
        // ==============================================================

        const densityResult = this._applyDensityFloor(
            assignments,
            finalPaletteLab,
            0.005,
            protectedIndices
        );

        let finalPaletteLabFiltered = finalPaletteLab;
        let assignmentsFiltered = assignments;

        if (densityResult.actualCount < finalPaletteLab.length) {
            const removed = finalPaletteLab.length - densityResult.actualCount;
            logger.log(`✓ Density floor: Removed ${removed} ghost color(s) with < 0.5% coverage`);
            logger.log(`  Final palette: ${densityResult.actualCount} colors`);

            finalPaletteLabFiltered = densityResult.palette;
            assignmentsFiltered = densityResult.assignments;
        }

        const paletteRgbFiltered = finalPaletteLabFiltered.map(lab => this.labToRgb(lab));

        return {
            palette: paletteRgbFiltered,
            paletteLab: finalPaletteLabFiltered,
            assignments: assignmentsFiltered,
            labPixels,
            substrateLab: null,
            substrateIndex: null,
            metadata: {
                targetColors,
                finalColors: finalPaletteLabFiltered.length,
                autoAnchors: addedCount,
                skippedAnchors: skippedCount,
                detectedPeaks: detectedPeaks.map(p => ({
                    L: p.L.toFixed(1),
                    a: p.a.toFixed(1),
                    b: p.b.toFixed(1),
                    chroma: p.chroma.toFixed(1),
                    volume: (p.volume * 100).toFixed(2) + '%'
                })),
                snapThreshold,
                duration: parseFloat(duration),
                engineType: 'reveal-mk1.5'
            }
        };
    }

    /**
     * Balanced Engine: Lab Median Cut without hue gap analysis (internal method)
     * Faster than Reveal, better quality than Classic
     *
     * @param {Uint8ClampedArray} pixels - Pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} targetColors - Target palette size
     * @param {Object} options - Engine options
     * @returns {Object} - {palette, paletteLab, assignments, labPixels, metadata}
     */
    static _posterizeBalanced(pixels, width, height, targetColors, options = {}) {
        // Same as _posterizeReveal but with enableHueGapAnalysis forced to false
        return this._posterizeRevealMk1_0(pixels, width, height, targetColors, {
            ...options,
            enableHueGapAnalysis: false
        });
    }

    /**
     * Classic Engine: RGB Median Cut (internal method)
     * Fastest, good for quick previews
     *
     * @param {Uint8ClampedArray} pixels - Pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} targetColors - Target palette size
     * @param {Object} options - Engine options
     * @returns {Object} - {palette, paletteLab, assignments, labPixels, metadata}
     */
    static _posterizeClassic(pixels, width, height, targetColors, options = {}) {
        const isLabInput = options.format === 'lab';
        const preserveWhite = options.preserveWhite !== undefined ? options.preserveWhite : true;
        const preserveBlack = options.preserveBlack !== undefined ? options.preserveBlack : true;

        // Convert Lab to RGB if needed
        // NOTE: Classic engine uses RGB median cut internally, but Lab→RGB conversion
        // is done here for legacy compatibility. Engine still expects 16-bit Lab input.
        let rgbPixels;
        if (isLabInput) {
            logger.log('Converting 16-bit Lab pixels to RGB for Classic engine...');
            rgbPixels = new Uint8ClampedArray((pixels.length / 3) * 4);

            // Engine ONLY accepts 16-bit Lab input
            const maxValue = 32768;
            const neutralAB = 16384;
            const abScale = 128 / 16384;

            for (let i = 0, j = 0; i < pixels.length; i += 3, j += 4) {
                const L = (pixels[i] / maxValue) * 100;
                const a = (pixels[i + 1] - neutralAB) * abScale;
                const b = (pixels[i + 2] - neutralAB) * abScale;
                const rgb = this.labToRgb({ L, a, b });
                rgbPixels[j] = rgb.r;
                rgbPixels[j + 1] = rgb.g;
                rgbPixels[j + 2] = rgb.b;
                rgbPixels[j + 3] = 255; // Opaque
            }
        } else {
            rgbPixels = pixels;
        }

        // Call original RGB median cut
        const result = this._posterizeClassicRgb(rgbPixels, width, height, targetColors, 'cielab');

        // Convert result to Lab palette
        const paletteLab = result.palette.map(rgb => this.rgbToLab(rgb));

        // Generate assignments (map each pixel to nearest palette color)
        const numPixels = width * height;
        const assignments = new Uint8Array(numPixels);

        for (let i = 0; i < numPixels; i++) {
            const pixelIndex = i * 4;
            const r = rgbPixels[pixelIndex];
            const g = rgbPixels[pixelIndex + 1];
            const b = rgbPixels[pixelIndex + 2];

            // Find nearest palette color using RGB Euclidean distance
            let minDist = Infinity;
            let closestIndex = 0;

            for (let p = 0; p < result.palette.length; p++) {
                const pr = result.palette[p].r;
                const pg = result.palette[p].g;
                const pb = result.palette[p].b;
                const dist = Math.sqrt(
                    (r - pr) ** 2 +
                    (g - pg) ** 2 +
                    (b - pb) ** 2
                );

                if (dist < minDist) {
                    minDist = dist;
                    closestIndex = p;
                }
            }

            assignments[i] = closestIndex;
        }

        // Apply density floor to remove ghost colors (<0.5% coverage)
        // IMPORTANT: Never remove preserved colors (white/black)
        const protectedIndices = new Set();
        // Note: Classic engine doesn't track white/black indices separately like Reveal does,
        // so we rely on preserveWhite/preserveBlack flags for intent but don't protect specific indices
        // in the palette. This is acceptable since Classic uses RGB median cut which doesn't
        // guarantee white/black are in specific positions.

        const densityResult = this._applyDensityFloor(
            assignments,
            paletteLab,
            0.005,  // 0.5% threshold
            protectedIndices
        );

        if (densityResult.actualCount < paletteLab.length) {
            const removed = paletteLab.length - densityResult.actualCount;
            logger.log(`✓ Density floor: Removed ${removed} ghost color(s) with < 0.5% coverage`);
            logger.log(`  Final palette: ${densityResult.actualCount} colors (down from ${paletteLab.length})`);

            // Use the cleaned palette and remapped assignments
            const cleanPaletteRgb = densityResult.palette.map(lab => this.labToRgb(lab));

            return {
                palette: cleanPaletteRgb,
                paletteLab: densityResult.palette,
                assignments: densityResult.assignments,
                labPixels: null, // Classic doesn't preserve Lab pixels
                metadata: {
                    engine: 'classic',
                    targetColors,
                    finalColors: densityResult.actualCount
                }
            };
        }

        return {
            palette: result.palette,
            paletteLab,
            assignments,
            labPixels: null, // Classic doesn't preserve Lab pixels
            metadata: {
                engine: 'classic',
                targetColors,
                finalColors: result.palette.length
            }
        };
    }

    /**
     * Stencil Engine: Luminance-only quantization (internal method)
     * Monochrome separations (L-channel only, a=b=0)
     *
     * @param {Uint8ClampedArray} pixels - Pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} targetColors - Target palette size
     * @param {Object} options - Engine options
     * @returns {Object} - {palette, paletteLab, assignments, labPixels, metadata}
     */
    static _posterizeStencil(pixels, width, height, targetColors, options = {}) {
        logger.log('Stencil engine: Quantizing L-channel only (a=b=0)');

        return this._posterizeRevealMk1_0(pixels, width, height, targetColors, {
            ...options,
            grayscaleOnly: true,
            enableHueGapAnalysis: false
        });
    }

    /**
     * LEGACY: Backward compatibility wrapper for posterizeWithLabMedianCut
     * @deprecated Use posterize() with engineType='reveal' instead
     *
     * @param {Uint8ClampedArray} pixels - Pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {number} targetColors - Target palette size
     * @param {number} snapThreshold - Perceptual snap threshold
     * @param {Object} options - Engine options
     * @returns {Object} - {palette, paletteLab, assignments, labPixels, metadata}
     */
    static posterizeWithLabMedianCut(pixels, width, height, targetColors, snapThreshold = 8.0, options = {}) {
        logger.warn('⚠️ posterizeWithLabMedianCut() is deprecated. Use posterize({engineType: "reveal"}) instead.');
        return this.posterize(pixels, width, height, targetColors, {
            ...options,
            engineType: 'reveal',
            snapThreshold
        });
    }

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

// Export for use in plugin
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PosterizationEngine;
}
