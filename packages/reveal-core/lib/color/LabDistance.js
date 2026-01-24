/**
 * LabDistance - Centralized Lab Color Distance Calculations
 *
 * Provides configurable distance metrics for CIELAB color space:
 * - CIE76: Standard Euclidean distance (fast, good for most cases)
 * - CIE94: Improved perceptual weighting (better for saturated colors)
 *
 * All functions support both object and inline variants for flexibility
 * between readable code and hot-loop performance.
 *
 * @module LabDistance
 */

/**
 * Available distance metric types
 * @constant
 */
const DistanceMetric = {
    CIE76: 'cie76',
    CIE94: 'cie94'
};

/**
 * Default CIE94 parameters (graphic arts application)
 * @constant
 */
const DEFAULT_CIE94_PARAMS = {
    kL: 1,      // Lightness weighting factor
    k1: 0.045,  // Chroma weighting coefficient for SC
    k2: 0.015   // Chroma weighting coefficient for SH
};

// ============================================================================
// CIE76 Distance Functions
// ============================================================================

/**
 * CIE76 (ΔE*ab) - Standard Euclidean distance in CIELAB space
 *
 * Formula: ΔE = √((L₂-L₁)² + (a₂-a₁)² + (b₂-b₁)²)
 *
 * Interpretation:
 * - ΔE < 1: Not perceptible by human eyes
 * - 1 < ΔE < 2: Perceptible through close observation
 * - 2 < ΔE < 10: Perceptible at a glance
 * - 10 < ΔE < 50: Colors are more similar than opposite
 * - ΔE > 50: Colors are opposite
 *
 * @param {Object} lab1 - First color { L, a, b }
 * @param {Object} lab2 - Second color { L, a, b }
 * @param {boolean} [squared=false] - Return squared distance (faster for comparisons)
 * @returns {number} - ΔE distance (or squared distance if squared=true)
 */
function cie76(lab1, lab2, squared = false) {
    const dL = lab1.L - lab2.L;
    const da = lab1.a - lab2.a;
    const db = lab1.b - lab2.b;
    const distSq = dL * dL + da * da + db * db;
    return squared ? distSq : Math.sqrt(distSq);
}

/**
 * CIE76 with perceptual L-weighting for shadow preservation
 *
 * The human eye is more sensitive to lightness changes in dark areas.
 * This variant applies dynamic L-weighting to preserve shadow detail.
 *
 * @param {Object} lab1 - First color { L, a, b }
 * @param {Object} lab2 - Second color { L, a, b }
 * @param {boolean} [squared=false] - Return squared distance
 * @param {number} [shadowThreshold=40] - L threshold for increased weighting
 * @param {number} [shadowWeight=2.0] - L multiplier when avgL < threshold
 * @returns {number} - Weighted ΔE distance
 */
function cie76Weighted(lab1, lab2, squared = false, shadowThreshold = 40, shadowWeight = 2.0) {
    const dL = lab1.L - lab2.L;
    const da = lab1.a - lab2.a;
    const db = lab1.b - lab2.b;

    // Apply increased L weight for dark colors (shadow preservation)
    const avgL = (lab1.L + lab2.L) / 2;
    const lWeight = avgL < shadowThreshold ? shadowWeight : 1.0;

    const distSq = (dL * lWeight) ** 2 + da * da + db * db;
    return squared ? distSq : Math.sqrt(distSq);
}

/**
 * CIE76 squared distance - inline variant for hot loops
 *
 * Avoids function call overhead and object destructuring.
 * Use when processing millions of pixels.
 *
 * @param {number} L1 - First color lightness
 * @param {number} a1 - First color a component
 * @param {number} b1 - First color b component
 * @param {number} L2 - Second color lightness
 * @param {number} a2 - Second color a component
 * @param {number} b2 - Second color b component
 * @returns {number} - Squared ΔE distance
 */
function cie76SquaredInline(L1, a1, b1, L2, a2, b2) {
    const dL = L1 - L2;
    const da = a1 - a2;
    const db = b1 - b2;
    return dL * dL + da * da + db * db;
}

/**
 * CIE76 weighted squared distance - inline variant for hot loops
 *
 * @param {number} L1 - First color lightness
 * @param {number} a1 - First color a component
 * @param {number} b1 - First color b component
 * @param {number} L2 - Second color lightness
 * @param {number} a2 - Second color a component
 * @param {number} b2 - Second color b component
 * @param {number} lWeight - L channel weight multiplier
 * @returns {number} - Squared weighted ΔE distance
 */
function cie76WeightedSquaredInline(L1, a1, b1, L2, a2, b2, lWeight) {
    const dL = L1 - L2;
    const da = a1 - a2;
    const db = b1 - b2;
    return (dL * lWeight) ** 2 + da * da + db * db;
}

// ============================================================================
// CIE94 Distance Functions
// ============================================================================

/**
 * CIE94 (ΔE*94) - Improved perceptual distance metric
 *
 * Addresses CIE76's non-uniformity in high-chroma regions by applying
 * chroma-dependent weighting to the chromatic components.
 *
 * Formula:
 *   ΔE*94 = √( (ΔL/SL)² + (ΔC/SC)² + (ΔH/SH)² )
 *
 * Where:
 *   C1 = √(a1² + b1²)           - Chroma of first color
 *   ΔC = C1 - C2                - Chroma difference
 *   ΔH = √(Δa² + Δb² - ΔC²)     - Hue difference
 *   SC = 1 + k1·C1              - Chroma-dependent scaling
 *   SH = 1 + k2·C1              - Hue-dependent scaling
 *   SL = 1                      - Lightness scaling (typically 1 for graphic arts)
 *
 * Default params (k1=0.045, k2=0.015) are for graphic arts applications.
 * Textile industry uses k1=0.048, k2=0.014.
 *
 * @param {Object} lab1 - First color { L, a, b }
 * @param {Object} lab2 - Second color { L, a, b }
 * @param {boolean} [squared=false] - Return squared distance
 * @param {Object} [params] - CIE94 parameters { kL, k1, k2 }
 * @returns {number} - ΔE*94 distance
 */
function cie94(lab1, lab2, squared = false, params = DEFAULT_CIE94_PARAMS) {
    const { kL = 1, k1 = 0.045, k2 = 0.015 } = params;

    const dL = lab1.L - lab2.L;
    const da = lab1.a - lab2.a;
    const db = lab1.b - lab2.b;

    // Chroma of both colors
    const C1 = Math.sqrt(lab1.a * lab1.a + lab1.b * lab1.b);
    const C2 = Math.sqrt(lab2.a * lab2.a + lab2.b * lab2.b);
    const dC = C1 - C2;

    // Hue difference (derived from dH² = da² + db² - dC²)
    // Clamp to prevent NaN from floating point errors
    const dHSquared = Math.max(0, da * da + db * db - dC * dC);
    const dH = Math.sqrt(dHSquared);

    // Weighting factors (using C1 as reference per CIE94 spec)
    const SL = 1;           // Lightness scaling
    const SC = 1 + k1 * C1; // Chroma-dependent
    const SH = 1 + k2 * C1; // Hue-dependent

    // Weighted squared differences
    const distSq = (dL / (kL * SL)) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2;

    return squared ? distSq : Math.sqrt(distSq);
}

/**
 * CIE94 squared distance - inline variant for hot loops
 *
 * Optimized for performance with pre-computed chroma values.
 * Use preparePaletteForCIE94() to pre-compute chroma.
 *
 * @param {number} L1 - First color lightness
 * @param {number} a1 - First color a component
 * @param {number} b1 - First color b component
 * @param {number} L2 - Second color lightness
 * @param {number} a2 - Second color a component
 * @param {number} b2 - Second color b component
 * @param {number} C1 - Pre-computed chroma of first color (optional, computed if 0)
 * @param {number} k1 - Chroma coefficient (default 0.045)
 * @param {number} k2 - Hue coefficient (default 0.015)
 * @returns {number} - Squared ΔE*94 distance
 */
function cie94SquaredInline(L1, a1, b1, L2, a2, b2, C1 = 0, k1 = 0.045, k2 = 0.015) {
    // Compute C1 if not provided
    if (C1 === 0) {
        C1 = Math.sqrt(a1 * a1 + b1 * b1);
    }

    const dL = L1 - L2;
    const da = a1 - a2;
    const db = b1 - b2;

    const C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const dC = C1 - C2;

    // dH² = da² + db² - dC²
    const dHSquared = Math.max(0, da * da + db * db - dC * dC);

    // Weighting factors
    const SC = 1 + k1 * C1;
    const SH = 1 + k2 * C1;

    // Return squared distance
    return dL * dL + (dC / SC) ** 2 + (dHSquared / (SH * SH));
}

// ============================================================================
// Factory & Configuration
// ============================================================================

/**
 * Creates a configured distance calculator function
 *
 * Returns a distance function pre-configured with the specified metric
 * and parameters. Useful for passing to algorithms that need a distance function.
 *
 * @param {Object} config - Configuration options
 * @param {string} [config.metric='cie76'] - Distance metric ('cie76' or 'cie94')
 * @param {boolean} [config.squared=false] - Return squared distance
 * @param {boolean} [config.weighted=false] - Use L-weighting (CIE76 only)
 * @param {number} [config.shadowThreshold=40] - L threshold for weighting
 * @param {number} [config.shadowWeight=2.0] - Weight multiplier for shadows
 * @param {Object} [config.cie94Params] - CIE94 parameters { kL, k1, k2 }
 * @returns {Function} - Distance function (lab1, lab2) => number
 *
 * @example
 * const dist = createDistanceCalculator({ metric: 'cie94', squared: true });
 * const d = dist({ L: 50, a: 10, b: 20 }, { L: 55, a: 15, b: 25 });
 */
function createDistanceCalculator(config = {}) {
    const {
        metric = DistanceMetric.CIE76,
        squared = false,
        weighted = false,
        shadowThreshold = 40,
        shadowWeight = 2.0,
        cie94Params = DEFAULT_CIE94_PARAMS
    } = config;

    if (metric === DistanceMetric.CIE94) {
        return (lab1, lab2) => cie94(lab1, lab2, squared, cie94Params);
    }

    // CIE76 (default)
    if (weighted) {
        return (lab1, lab2) => cie76Weighted(lab1, lab2, squared, shadowThreshold, shadowWeight);
    }
    return (lab1, lab2) => cie76(lab1, lab2, squared);
}

/**
 * Pre-computes chroma values for a Lab palette
 *
 * Used to optimize CIE94 calculations in hot loops by avoiding
 * repeated sqrt() calls for palette colors.
 *
 * @param {Array<{L, a, b}>} labPalette - Lab color palette
 * @returns {Float32Array} - Pre-computed chroma values
 */
function preparePaletteChroma(labPalette) {
    const chroma = new Float32Array(labPalette.length);
    for (let i = 0; i < labPalette.length; i++) {
        const p = labPalette[i];
        chroma[i] = Math.sqrt(p.a * p.a + p.b * p.b);
    }
    return chroma;
}

/**
 * Creates a distance configuration object from options
 *
 * Normalizes various option formats into a consistent config object.
 *
 * @param {Object} options - Raw options from user/API
 * @param {string} [options.distanceMetric] - 'cie76' or 'cie94'
 * @param {Object} [options.cie94Params] - CIE94 parameters
 * @returns {Object} - Normalized distance configuration
 */
function normalizeDistanceConfig(options = {}) {
    const metric = options.distanceMetric || DistanceMetric.CIE76;
    const cie94Params = { ...DEFAULT_CIE94_PARAMS, ...options.cie94Params };

    return {
        metric,
        cie94Params,
        isCIE94: metric === DistanceMetric.CIE94
    };
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
    // Constants
    DistanceMetric,
    DEFAULT_CIE94_PARAMS,

    // CIE76 functions
    cie76,
    cie76Weighted,
    cie76SquaredInline,
    cie76WeightedSquaredInline,

    // CIE94 functions
    cie94,
    cie94SquaredInline,

    // Factory & helpers
    createDistanceCalculator,
    preparePaletteChroma,
    normalizeDistanceConfig
};
