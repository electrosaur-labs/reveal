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
 * Get filter parameters based on entropy score and optional peak chroma
 *
 * @param {number} entropyScore - Entropy score from calculateEntropyScore
 * @param {number} [peakChroma=0] - Peak chroma value from DNA analysis
 * @returns {Object} Filter parameters { radius, sigmaR }
 */
function getFilterParams(entropyScore, peakChroma = 0) {
    // Light filter for moderate entropy (25-40)
    if (entropyScore <= 40) {
        return { radius: 3, sigmaR: 30 };
    }
    // Heavy filter for high entropy (> 40)
    return { radius: 5, sigmaR: 45 };
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
 * @param {Object} dna - DNA analysis result
 * @param {string} dna.archetype - Detected archetype
 * @param {number} [dna.maxC] - Peak chroma
 * @param {number} entropyScore - Entropy score from calculateEntropyScore
 * @returns {Object} Decision result
 * @returns {boolean} returns.shouldProcess - Whether to apply filter
 * @returns {string} returns.reason - Explanation for the decision
 * @returns {number} [returns.radius] - Filter radius if shouldProcess=true
 * @returns {number} [returns.sigmaR] - Filter sigmaR if shouldProcess=true
 */
function shouldPreprocess(dna, entropyScore) {
    const archetype = (dna.archetype || '').toLowerCase();
    const peakChroma = dna.maxC || 0;

    // Vector/Flat: NEVER filter - preserves sharp edges
    if (archetype.includes('vector') || archetype.includes('flat')) {
        return {
            shouldProcess: false,
            reason: 'Vector/Flat - preserving sharp edges'
        };
    }

    // Very low entropy: Skip (image is already clean)
    if (entropyScore < 15) {
        return {
            shouldProcess: false,
            reason: `Very low entropy (${entropyScore.toFixed(1)}) - already clean`
        };
    }

    // Neon/Vibrant: Higher threshold (entropy > 30)
    if (archetype.includes('neon') || archetype.includes('vibrant')) {
        if (entropyScore > 30) {
            const params = getFilterParams(entropyScore, peakChroma);
            return {
                shouldProcess: true,
                reason: `Neon/Vibrant + high entropy (${entropyScore.toFixed(1)})`,
                ...params
            };
        }
        return {
            shouldProcess: false,
            reason: `Neon/Vibrant - entropy acceptable (${entropyScore.toFixed(1)})`
        };
    }

    // Standard threshold for other archetypes (entropy > 25)
    if (entropyScore < 25) {
        return {
            shouldProcess: false,
            reason: `Low entropy (${entropyScore.toFixed(1)}) - acceptable`
        };
    }

    // Photographic: Filter if entropy > 25
    if (archetype.includes('photo')) {
        const params = getFilterParams(entropyScore, peakChroma);
        return {
            shouldProcess: true,
            reason: `Photographic + entropy ${entropyScore.toFixed(1)}`,
            ...params
        };
    }

    // Noir/Mono: Filter if entropy > 25 (grayscale noise)
    if (archetype.includes('noir') || archetype.includes('mono')) {
        const params = getFilterParams(entropyScore, peakChroma);
        return {
            shouldProcess: true,
            reason: `Noir/Mono - grayscale noise (${entropyScore.toFixed(1)})`,
            ...params
        };
    }

    // Vintage/Muted: Filter if entropy > 25
    if (archetype.includes('vintage') || archetype.includes('muted')) {
        const params = getFilterParams(entropyScore, peakChroma);
        return {
            shouldProcess: true,
            reason: `Vintage/Muted - texture noise (${entropyScore.toFixed(1)})`,
            ...params
        };
    }

    // Default: Filter if entropy > 25
    const params = getFilterParams(entropyScore, peakChroma);
    return {
        shouldProcess: true,
        reason: `High entropy (${entropyScore.toFixed(1)})`,
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
    if (imageData && width > 0 && height > 0) {
        // Detect data format based on array type and length
        const pixelCount = width * height;
        const isLab16 = imageData instanceof Uint16Array && imageData.length === pixelCount * 3;
        const isRGBA8 = (imageData instanceof Uint8Array || imageData instanceof Uint8ClampedArray) &&
                        imageData.length === pixelCount * 4;

        if (isLab16) {
            // 16-bit Lab data (3 values per pixel: L, a, b)
            entropyScore = calculateEntropyScoreLab(imageData, width, height);
        } else if (isRGBA8) {
            // 8-bit RGBA data (4 bytes per pixel)
            entropyScore = calculateEntropyScore(imageData, width, height);
        } else {
            // Unknown format - try Lab16 first (more common in modern pipeline)
            // Check if it could be Lab16 with different array type
            if (imageData.length === pixelCount * 3) {
                entropyScore = calculateEntropyScoreLab(imageData, width, height);
            } else if (imageData.length === pixelCount * 4) {
                entropyScore = calculateEntropyScore(imageData, width, height);
            }
            // Otherwise leave entropyScore at 0 (unknown format)
        }
    }

    // Make decision based on DNA and entropy
    const decision = shouldPreprocess(dna, entropyScore);

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

    let totalVariance = 0;
    let sampleCount = 0;

    // 16-bit Lab: L is 0-32768, scale to 0-255 for consistent entropy scores
    const lScale = 255 / 32768;

    // Sample pixels with step for performance
    for (let y = 1; y < height - 1; y += sampleRate) {
        for (let x = 1; x < width - 1; x += sampleRate) {
            const idx = (y * width + x) * 3;
            const centerL = labData[idx] * lScale;  // Scale 16-bit L to 8-bit range

            // Calculate local variance in 3x3 neighborhood
            let sum = 0;
            let sumSq = 0;
            let n = 0;

            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nIdx = ((y + dy) * width + (x + dx)) * 3;
                    const val = labData[nIdx] * lScale;
                    sum += val;
                    sumSq += val * val;
                    n++;
                }
            }

            const mean = sum / n;
            const variance = (sumSq / n) - (mean * mean);
            // Guard against floating-point errors that could make variance slightly negative
            if (variance > 0 && !isNaN(variance)) {
                totalVariance += Math.sqrt(variance);
            }
            sampleCount++;
        }
    }

    // Normalize to 0-100 scale
    const avgVariance = totalVariance / Math.max(1, sampleCount);
    const result = Math.min(100, avgVariance * 2);
    return isNaN(result) ? 0 : result;
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
 * @param {number} [sigmaR=30] - Range sigma (color similarity, scaled for 16-bit)
 * @returns {void} Modifies labData in place
 */
function applyBilateralFilterLab(labData, width, height, radius = 4, sigmaR = 30) {
    // Scale sigmaR for 16-bit L values (0-32768 instead of 0-255)
    // 8-bit sigmaR=30 → 16-bit sigmaR ~= 30 * (32768/255) ~= 3857
    const sigmaR16 = sigmaR * (32768 / 255);
    const sigmaR2x2 = 2 * sigmaR16 * sigmaR16;

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

                    // Color distance in L channel (primary filter target)
                    const lDist = Math.abs(centerL - nL);
                    const lutIdx = Math.min(255, Math.floor(lDist * lutScale));
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
