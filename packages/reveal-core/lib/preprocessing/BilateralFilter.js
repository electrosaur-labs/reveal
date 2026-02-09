/**
 * BilateralFilter.js - Edge-preserving image preprocessing
 *
 * Bilateral filter implementation for noise reduction while preserving edges.
 * Part of the 3-Level Perceptual Rescue System:
 *   Level 1: DNA (Archetype Detection)
 *   Level 2: Entropy (Bilateral Filter) - this module
 *   Level 3: Complexity (CIE2000 Override)
 *
 * ARCHITECTURE NOTE:
 * The engine operates exclusively in 16-bit Lab color space. Use the Lab functions:
 *   - calculateEntropyScoreLab() - entropy from 16-bit Lab L channel
 *   - applyBilateralFilterLab() - filter 16-bit Lab data in-place
 *
 * The 8-bit RGBA functions are provided for external tools only (not used by engine).
 *
 * @module reveal-core/preprocessing
 */

/**
 * Preprocessing intensity presets
 */
const PreprocessingIntensity = {
    OFF: 'off',
    AUTO: 'auto',
    LIGHT: 'light',
    HEAVY: 'heavy'
};

/**
 * Calculate entropy score from 8-bit RGBA image data
 * NOTE: For engine use, prefer calculateEntropyScoreLab() which works with 16-bit Lab.
 *
 * @deprecated Use calculateEntropyScoreLab for engine pipelines
 * @param {Uint8ClampedArray} imageData - RGBA pixel data (4 bytes per pixel)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} [sampleRate=4] - Sample every Nth pixel for speed
 * @returns {number} Entropy score (0-100, higher = noisier)
 */
function calculateEntropyScore(imageData, width, height, sampleRate = 4) {
    let totalVariance = 0;
    let sampleCount = 0;

    // Sample pixels with step for performance
    for (let y = 1; y < height - 1; y += sampleRate) {
        for (let x = 1; x < width - 1; x += sampleRate) {
            const idx = (y * width + x) * 4;
            const centerL = imageData[idx]; // Use R channel as luminance proxy

            // Calculate local variance in 3x3 neighborhood
            let sum = 0;
            let sumSq = 0;
            let n = 0;

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nIdx = ((y + dy) * width + (x + dx)) * 4;
                    const val = imageData[nIdx];
                    sum += val;
                    sumSq += val * val;
                    n++;
                }
            }

            const mean = sum / n;
            const variance = (sumSq / n) - (mean * mean);
            totalVariance += Math.sqrt(variance);
            sampleCount++;
        }
    }

    // Normalize to 0-100 scale
    const avgVariance = totalVariance / Math.max(1, sampleCount);
    return Math.min(100, avgVariance * 2);
}

/**
 * Apply optimized bilateral filter to 8-bit RGBA image data
 * NOTE: For engine use, prefer applyBilateralFilterLab() which works with 16-bit Lab.
 *
 * @deprecated Use applyBilateralFilterLab for engine pipelines
 * @param {Uint8ClampedArray} imageData - RGBA pixel data (modified in place)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} [radius=4] - Filter radius in pixels
 * @param {number} [sigmaR=30] - Range sigma (color similarity)
 * @returns {void} Modifies imageData in place
 */
function applyBilateralFilter(imageData, width, height, radius = 4, sigmaR = 30) {
    // Pre-compute exponent lookup table for range weighting
    const expLUT = new Float32Array(256);
    const sigmaR2x2 = 2 * sigmaR * sigmaR;
    for (let d = 0; d < 256; d++) {
        expLUT[d] = Math.exp(-(d * d) / sigmaR2x2);
    }

    // Clone original for reading
    const original = new Uint8ClampedArray(imageData);

    // Spatial stepping based on radius for performance
    const step = radius > 3 ? 2 : 1;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const centerR = original[idx];
            const centerG = original[idx + 1];
            const centerB = original[idx + 2];

            let sumR = 0, sumG = 0, sumB = 0;
            let weightSum = 0;

            // Neighborhood iteration with stepping
            for (let dy = -radius; dy <= radius; dy += step) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;

                for (let dx = -radius; dx <= radius; dx += step) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= width) continue;

                    const nIdx = (ny * width + nx) * 4;
                    const nR = original[nIdx];
                    const nG = original[nIdx + 1];
                    const nB = original[nIdx + 2];

                    // Color distance (range weight)
                    const colorDist = Math.abs(centerR - nR) +
                                     Math.abs(centerG - nG) +
                                     Math.abs(centerB - nB);
                    const rangeWeight = expLUT[Math.min(255, Math.floor(colorDist / 3))];

                    // Spatial weight (simplified - could add Gaussian)
                    const spatialWeight = 1.0;

                    const weight = rangeWeight * spatialWeight;
                    sumR += nR * weight;
                    sumG += nG * weight;
                    sumB += nB * weight;
                    weightSum += weight;
                }
            }

            // Write filtered values
            if (weightSum > 0) {
                imageData[idx] = Math.round(sumR / weightSum);
                imageData[idx + 1] = Math.round(sumG / weightSum);
                imageData[idx + 2] = Math.round(sumB / weightSum);
            }
            // Alpha unchanged: imageData[idx + 3]
        }
    }
}

/**
 * Get filter parameters based on entropy score and bit depth
 *
 * sigmaR is in 16-bit L units (0-32768 range), no internal scaling:
 * - 16-bit: sigmaR = 5000 (~15% of L range, smooths 10-20% noise spikes)
 * - 8-bit: sigmaR = 3000 (more conservative for compression artifacts)
 *
 * @param {number} entropyScore - Entropy score from calculateEntropyScore
 * @param {number} [peakChroma=0] - Peak chroma value from DNA analysis
 * @param {boolean} [is16Bit=false] - Whether source is 16-bit
 * @returns {Object} Filter parameters { radius, sigmaR }
 */
function getFilterParams(entropyScore, peakChroma = 0, is16Bit = false) {
    // sigmaR in 16-bit L units (0-32768 range)
    // Controls how much L difference is considered "similar" vs "edge"
    // - Lower values = more edge preservation, less noise smoothing
    // - Higher values = more noise smoothing, but risks blurring edges
    //
    // For 16-bit: ~5000 = ~15% of L range, effectively smooths 10-20% noise spikes
    // For 8-bit (upscaled to 16-bit): ~3000 = more conservative for compression artifacts
    const baseSigmaR = is16Bit ? 5000 : 3000;

    // Light filter for moderate entropy
    if (entropyScore <= 40) {
        return { radius: 3, sigmaR: baseSigmaR };
    }
    // Heavy filter for high entropy - increase radius but keep sigmaR
    return { radius: 5, sigmaR: baseSigmaR };
}

/**
 * Determine if preprocessing should be applied based on DNA and entropy
 * Implements the archetype-based decision logic:
 * - Vector/Flat: NEVER filter (preserves sharp edges)
 * - Low entropy (< 25): Skip (already clean)
 * - Photographic: Filter if entropy > 25
 * - Noir/Mono: Filter if entropy > 25 (grayscale noise)
 * - Vintage/Muted: Filter if entropy > 25
 * - Neon/Vibrant: Filter if entropy > 30 (higher threshold)
 *
 * Bit-depth aware thresholds (DNA-driven recommendation):
 * - 8-bit: threshold = 15 (compression artifacts are normal, avoid "plastic" look)
 * - 16-bit: threshold = 2 (high SNR, any spike is likely dust/sensor noise)
 *
 * @param {Object} dna - DNA analysis result
 * @param {string} dna.archetype - Detected archetype
 * @param {number} [dna.maxC] - Peak chroma
 * @param {number} entropyScore - Entropy score from calculateEntropyScore
 * @param {boolean} [is16Bit=false] - Whether source is 16-bit (affects threshold)
 * @returns {Object} Decision result
 * @returns {boolean} returns.shouldProcess - Whether to apply filter
 * @returns {string} returns.reason - Explanation for the decision
 * @returns {number} [returns.radius] - Filter radius if shouldProcess=true
 * @returns {number} [returns.sigmaR] - Filter sigmaR if shouldProcess=true
 */
function shouldPreprocess(dna, entropyScore, is16Bit = false) {
    const archetype = (dna.archetype || '').toLowerCase();
    const peakChroma = dna.maxC || 0;

    // Bit-depth aware "very low" threshold:
    // - 8-bit: 15 (compression artifacts are inherent, don't over-filter)
    // - 16-bit: 2 (high SNR scans, any detected noise is likely junk)
    let veryLowThreshold = is16Bit ? 2 : 15;
    const bitDepthLabel = is16Bit ? '16-bit' : '8-bit';

    // Apply detailRescue: Lower entropy threshold to preserve fine details
    if (dna.detailRescue !== undefined && dna.detailRescue > 0) {
        const originalThreshold = veryLowThreshold;
        veryLowThreshold = Math.max(0, veryLowThreshold - dna.detailRescue);
        console.log(`🔍 detailRescue: Entropy threshold ${originalThreshold} → ${veryLowThreshold} (reduced by ${dna.detailRescue})`);
    }

    // Vector/Flat: NEVER filter - preserves sharp edges
    if (archetype.includes('vector') || archetype.includes('flat')) {
        return {
            shouldProcess: false,
            reason: 'Vector/Flat - preserving sharp edges'
        };
    }

    // Very low entropy: Skip (image is already clean)
    if (entropyScore < veryLowThreshold) {
        return {
            shouldProcess: false,
            reason: `Very low entropy (${entropyScore.toFixed(1)}, ${bitDepthLabel}) - already clean`
        };
    }

    // Both 8-bit and 16-bit: filter when entropy is above threshold
    // The veryLowThreshold check above already filtered out clean images
    // At this point, entropy >= threshold so we should process
    const params = getFilterParams(entropyScore, peakChroma, is16Bit);
    return {
        shouldProcess: true,
        reason: `${bitDepthLabel} noise reduction (entropy ${entropyScore.toFixed(1)})`,
        ...params
    };
}

/**
 * Create preprocessing configuration based on DNA analysis
 * This is called by ParameterGenerator to include preprocessing in the config
 *
 * @param {Object} dna - DNA analysis result
 * @param {Uint8ClampedArray|Uint16Array} [imageData] - Optional pixel data for entropy calculation
 *        - Uint8ClampedArray: 8-bit RGBA (4 bytes per pixel)
 *        - Uint16Array: 16-bit Lab (3 values per pixel)
 * @param {number} [width] - Image width (required if imageData provided)
 * @param {number} [height] - Image height (required if imageData provided)
 * @param {string} [intensityOverride] - Manual override: 'off', 'auto', 'light', 'heavy'
 * @returns {Object} Preprocessing configuration
 */
function createPreprocessingConfig(dna, imageData = null, width = 0, height = 0, intensityOverride = 'auto') {
    // Handle manual overrides
    if (intensityOverride === 'off') {
        return {
            enabled: false,
            intensity: 'off',
            reason: 'Disabled by user'
        };
    }

    if (intensityOverride === 'light') {
        return {
            enabled: true,
            intensity: 'light',
            radius: 3,
            sigmaR: 30,
            reason: 'Light filter (user override)'
        };
    }

    if (intensityOverride === 'heavy') {
        return {
            enabled: true,
            intensity: 'heavy',
            radius: 5,
            sigmaR: 45,
            reason: 'Heavy filter (user override)'
        };
    }

    // Auto mode: Calculate entropy if image data provided
    let entropyScore = 0;
    let is16Bit = false;
    if (imageData && width > 0 && height > 0) {
        // Detect data format based on array type and length
        const pixelCount = width * height;
        const isLab16 = imageData instanceof Uint16Array && imageData.length === pixelCount * 3;
        const isRGBA8 = (imageData instanceof Uint8Array || imageData instanceof Uint8ClampedArray) &&
                        imageData.length === pixelCount * 4;

        if (isLab16) {
            // 16-bit Lab data (3 values per pixel: L, a, b)
            entropyScore = calculateEntropyScoreLab(imageData, width, height);
            is16Bit = true;
        } else if (isRGBA8) {
            // 8-bit RGBA data (4 bytes per pixel)
            entropyScore = calculateEntropyScore(imageData, width, height);
            is16Bit = false;
        } else {
            // Unknown format - try Lab16 first (more common in modern pipeline)
            // Check if it could be Lab16 with different array type
            if (imageData.length === pixelCount * 3) {
                entropyScore = calculateEntropyScoreLab(imageData, width, height);
                is16Bit = true;  // Assume 16-bit for 3-channel data
            } else if (imageData.length === pixelCount * 4) {
                entropyScore = calculateEntropyScore(imageData, width, height);
                is16Bit = false;
            }
            // Otherwise leave entropyScore at 0 (unknown format)
        }
    }

    // Make decision based on DNA, entropy, and bit depth
    const decision = shouldPreprocess(dna, entropyScore, is16Bit);

    if (!decision.shouldProcess) {
        return {
            enabled: false,
            intensity: 'off',
            entropyScore,
            reason: decision.reason
        };
    }

    // Determine intensity level from params
    const intensity = decision.radius >= 5 ? 'heavy' : 'light';

    return {
        enabled: true,
        intensity,
        radius: decision.radius,
        sigmaR: decision.sigmaR,
        entropyScore,
        reason: decision.reason
    };
}

/**
 * RevealPreProcessor class for stateful preprocessing operations
 */
class RevealPreProcessor {
    constructor(options = {}) {
        this.intensity = options.intensity || 'auto';
        this.entropyThreshold = options.entropyThreshold || 25;
    }

    /**
     * Process image data with bilateral filter
     *
     * @param {Uint8ClampedArray} imageData - RGBA pixel data
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Object} dna - DNA analysis result
     * @returns {Object} Processing result
     */
    process(imageData, width, height, dna) {
        const config = createPreprocessingConfig(
            dna,
            imageData,
            width,
            height,
            this.intensity
        );

        if (!config.enabled) {
            return {
                processed: false,
                config,
                imageData
            };
        }

        // Apply bilateral filter (modifies in place)
        applyBilateralFilter(imageData, width, height, config.radius, config.sigmaR);

        return {
            processed: true,
            config,
            imageData
        };
    }
}

/**
 * Calculate entropy score from 16-bit Lab data
 * Measures local variance in L channel (luminance) to detect noise vs texture
 *
 * @param {Uint16Array} labData - Lab pixel data (3 values per pixel: L, a, b), 16-bit encoding
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} [sampleRate=4] - Sample every Nth pixel for speed
 * @returns {number} Entropy score (0-100, higher = noisier)
 */
function calculateEntropyScoreLab(labData, width, height, sampleRate = 4) {
    // Validate input
    if (!labData || !labData.length || width <= 0 || height <= 0) {
        return 0;  // Return 0 for invalid input (no entropy detected)
    }

    const expectedLength = width * height * 3;
    if (labData.length < expectedLength) {
        console.warn(`calculateEntropyScoreLab: data length ${labData.length} < expected ${expectedLength}`);
        return 0;  // Return 0 for malformed data
    }

    // REFACTORED: Detect noise across ALL Lab channels (L, a, b)
    // This ensures chromatic noise (e.g., Missing Green issue) triggers the filter
    // Returns the MAXIMUM entropy found in any channel

    // 16-bit Lab scaling for consistent entropy scores
    const lScale = 255 / 32768;   // L: 0-32768 → 0-255
    const abScale = 255 / 32768;  // a/b: 0-32768 → 0-255 (same range)

    let maxChannelEntropy = 0;

    // Check each channel independently
    for (let channel = 0; channel < 3; channel++) {
        let totalVariance = 0;
        let sampleCount = 0;
        const scale = (channel === 0) ? lScale : abScale;

        // Sample pixels with step for performance
        for (let y = 1; y < height - 1; y += sampleRate) {
            for (let x = 1; x < width - 1; x += sampleRate) {
                const idx = (y * width + x) * 3 + channel;
                const centerVal = labData[idx] * scale;

                // Calculate local variance in 3x3 neighborhood
                let sum = 0;
                let sumSq = 0;
                let n = 0;

                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nIdx = ((y + dy) * width + (x + dx)) * 3 + channel;
                        const val = labData[nIdx] * scale;
                        sum += val;
                        sumSq += val * val;
                        n++;
                    }
                }

                const mean = sum / n;
                const variance = (sumSq / n) - (mean * mean);
                // Guard against floating-point errors
                if (variance > 0 && !isNaN(variance)) {
                    totalVariance += Math.sqrt(variance);
                }
                sampleCount++;
            }
        }

        // Normalize this channel's entropy to 0-100 scale
        const avgVariance = totalVariance / Math.max(1, sampleCount);
        const channelEntropy = Math.min(100, avgVariance * 2);

        // Track the maximum entropy across all channels
        if (!isNaN(channelEntropy) && channelEntropy > maxChannelEntropy) {
            maxChannelEntropy = channelEntropy;
        }
    }

    return maxChannelEntropy;
}

/**
 * Apply optimized bilateral filter to 16-bit Lab data
 * Edge-preserving smoothing using spatial and range Gaussian weights
 * Works on L channel for smoothing, preserves a/b hue channels
 *
 * @param {Uint16Array} labData - Lab pixel data (3 values per pixel), modified in place
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {number} [radius=4] - Filter radius in pixels
 * @param {number} [sigmaR=3000] - Range sigma in 16-bit L units (no internal scaling)
 * @returns {void} Modifies labData in place
 */
function applyBilateralFilterLab(labData, width, height, radius = 4, sigmaR = 3000) {
    // sigmaR is expected to be in 16-bit units (0-32768 range)
    // Caller provides appropriate value based on bit depth:
    // - 16-bit source: sigmaR = 5000 (~15% of L range, smooths 10-20% noise)
    // - 8-bit source: sigmaR = 3000 (more conservative for compression artifacts)
    // NO internal scaling - caller is responsible for providing correct units
    const sigmaR2x2 = 2 * sigmaR * sigmaR;

    // Pre-compute exponent lookup table for range weighting
    // Quantize L differences to 256 buckets for LUT (covers typical differences)
    const expLUT = new Float32Array(256);
    const lutScale = 256 / 32768;  // Map 16-bit range to LUT
    for (let i = 0; i < 256; i++) {
        const d = i / lutScale;  // Convert back to 16-bit difference
        expLUT[i] = Math.exp(-(d * d) / sigmaR2x2);
    }

    // Clone original for reading
    const original = new Uint16Array(labData);

    // Spatial stepping based on radius for performance
    const step = radius > 3 ? 2 : 1;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 3;
            const centerL = original[idx];
            const centerA = original[idx + 1];
            const centerB = original[idx + 2];

            let sumL = 0, sumA = 0, sumB = 0;
            let weightSum = 0;

            // Neighborhood iteration with stepping
            for (let dy = -radius; dy <= radius; dy += step) {
                const ny = y + dy;
                if (ny < 0 || ny >= height) continue;

                for (let dx = -radius; dx <= radius; dx += step) {
                    const nx = x + dx;
                    if (nx < 0 || nx >= width) continue;

                    const nIdx = (ny * width + nx) * 3;
                    const nL = original[nIdx];
                    const nA = original[nIdx + 1];
                    const nB = original[nIdx + 2];

                    // PATENT-READY: 3D Lab distance for range weighting
                    // This ensures chromatic noise (a/b channels) is also filtered
                    const dL = centerL - nL;
                    const dA = centerA - nA;
                    const dB = centerB - nB;
                    const colorDist = Math.sqrt(dL * dL + dA * dA + dB * dB);

                    // Map to LUT (calibrated for 16-bit 3D distance)
                    const lutIdx = Math.min(255, Math.floor(colorDist * lutScale));
                    const rangeWeight = expLUT[lutIdx];

                    // Spatial weight (simplified - could add Gaussian)
                    const spatialWeight = 1.0;

                    const weight = rangeWeight * spatialWeight;
                    sumL += nL * weight;
                    sumA += nA * weight;
                    sumB += nB * weight;
                    weightSum += weight;
                }
            }

            // Write filtered values
            if (weightSum > 0) {
                labData[idx] = Math.round(sumL / weightSum);
                labData[idx + 1] = Math.round(sumA / weightSum);
                labData[idx + 2] = Math.round(sumB / weightSum);
            }
        }
    }
}

module.exports = {
    // PRIMARY API: 16-bit Lab (engine always uses these)
    calculateEntropyScoreLab,
    applyBilateralFilterLab,

    // DEPRECATED: 8-bit RGBA (for external tools only, not used by engine)
    calculateEntropyScore,
    applyBilateralFilter,

    // Decision logic
    shouldPreprocess,
    getFilterParams,
    createPreprocessingConfig,

    // Class
    RevealPreProcessor,

    // Constants
    PreprocessingIntensity
};
