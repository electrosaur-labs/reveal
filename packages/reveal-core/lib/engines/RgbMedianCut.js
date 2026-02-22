/**
 * RgbMedianCut - Classic/Legacy RGB Median Cut Engine
 *
 * Extracted from PosterizationEngine.js. Contains the entire classic RGB
 * median cut color quantization pipeline: color extraction, bucket splitting,
 * hue-sector anchor protection, and pixel-to-palette mapping.
 *
 * All methods are static (no instance state).
 */

const logger = require("../utils/logger");

class RgbMedianCut {

    /**
     * Classic RGB posterization using median cut algorithm
     *
     * @param {Uint8ClampedArray} pixels - RGBA pixel data (width * height * 4)
     * @param {number} width - Image width in pixels
     * @param {number} height - Image height in pixels
     * @param {number} colorCount - Target number of colors (3-9)
     * @param {string} colorDistance - Distance metric ('cielab' or 'euclidean')
     * @returns {Object} - {pixels: Uint8ClampedArray, palette: Array<{r,g,b,count}>}
     */
    static _posterizeClassicRgb(pixels, width, height, colorCount, colorDistance = 'cielab') {

        // Validate inputs
        if (colorCount < 2 || colorCount > 16) {
            throw new Error(`Color count must be between 2 and 16 (got ${colorCount})`);
        }

        if (pixels.length !== width * height * 4) {
            throw new Error(`Pixel data length mismatch: expected ${width * height * 4}, got ${pixels.length}`);
        }

        // Extract unique colors and build color list
        const colorList = this._extractColors(pixels, width, height);

        // If image already has fewer colors than requested, return as-is
        if (colorList.length <= colorCount) {
            const palette = this._buildPalette(colorList);
            return { pixels: new Uint8ClampedArray(pixels), palette };
        }

        // Apply median cut algorithm to reduce colors
        const palette = this._medianCut(colorList, colorCount);

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

        // Extract unique colors
        const colors = this._extractColors(pixels, width, height);

        // If very few colors, use them directly
        if (colors.length <= 3) {
            return 3;
        }

        // Cluster colors by MIN_DISTANCE to find distinct color regions
        const MIN_DISTANCE = 10; // CIE76 ΔE distance
        const colorList = colors.map(c => ({ r: c.r, g: c.g, b: c.b }));
        const clusters = this._getDistinctColors(colorList, MIN_DISTANCE);
        const clusterCount = clusters.length;


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
                // Return exactly targetCount colors (keep the most important ones)
                return distinctColors.slice(0, targetCount);
            }

        }

        // If we couldn't reach target after MAX_ATTEMPTS, return what we have
        const finalPalette = buckets.map(bucket => this._averageBucket(bucket));
        const distinctColors = this._getDistinctColors(finalPalette, MIN_DISTANCE);
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
        return RgbMedianCut._getPosterizationEngine().labToRgb(avgLab);
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
}

// Lazy require to avoid circular dependency
RgbMedianCut._getPosterizationEngine = function() {
    if (!RgbMedianCut._PE) {
        RgbMedianCut._PE = require('./PosterizationEngine');
    }
    return RgbMedianCut._PE;
};

module.exports = RgbMedianCut;
