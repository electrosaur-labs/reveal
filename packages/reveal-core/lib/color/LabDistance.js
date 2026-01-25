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
    CIE94: 'cie94',
    CIE2000: 'cie2000'
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
// CIE2000 Distance Functions
// ============================================================================

/**
 * CIE2000 (ΔE*00) - State-of-the-art perceptual distance metric
 *
 * The most accurate color difference formula, addressing:
 * - Perceptual non-uniformity across the entire Lab gamut
 * - Blue-purple region inaccuracies in earlier formulas
 * - Neutral color handling improvements
 *
 * Best for:
 * - Complex 16-bit files with subtle gradients
 * - Museum-grade art reproduction
 * - Blue/violet tones that confuse CIE94
 *
 * Note: ~3-4x slower than CIE94 due to additional calculations.
 *
 * @param {Object} lab1 - First color { L, a, b }
 * @param {Object} lab2 - Second color { L, a, b }
 * @param {boolean} [squared=false] - Return squared distance (approximation)
 * @returns {number} - ΔE*00 distance
 */
function cie2000(lab1, lab2, squared = false) {
    const dist = cie2000Inline(lab1.L, lab1.a, lab1.b, lab2.L, lab2.a, lab2.b);
    return squared ? dist * dist : dist;
}

/**
 * CIE2000 inline variant for hot loops
 *
 * Full implementation of CIEDE2000 formula per CIE Technical Report.
 * Uses kL=kC=kH=1 (reference conditions).
 *
 * @param {number} L1 - First color lightness
 * @param {number} a1 - First color a component
 * @param {number} b1 - First color b component
 * @param {number} L2 - Second color lightness
 * @param {number} a2 - Second color a component
 * @param {number} b2 - Second color b component
 * @returns {number} - ΔE*00 distance
 */
function cie2000Inline(L1, a1, b1, L2, a2, b2) {
    const RAD2DEG = 180 / Math.PI;
    const DEG2RAD = Math.PI / 180;

    // Step 1: Calculate C'i and h'i
    const avgL = (L1 + L2) / 2;
    const C1 = Math.sqrt(a1 * a1 + b1 * b1);
    const C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const avgC = (C1 + C2) / 2;

    // G factor for a' adjustment
    const avgC7 = Math.pow(avgC, 7);
    const G = 0.5 * (1 - Math.sqrt(avgC7 / (avgC7 + 6103515625))); // 25^7 = 6103515625

    // Adjusted a' values
    const a1p = a1 * (1 + G);
    const a2p = a2 * (1 + G);

    // C' values
    const C1p = Math.sqrt(a1p * a1p + b1 * b1);
    const C2p = Math.sqrt(a2p * a2p + b2 * b2);
    const avgCp = (C1p + C2p) / 2;

    // h' values (in degrees, 0-360)
    let h1p = Math.atan2(b1, a1p) * RAD2DEG;
    if (h1p < 0) h1p += 360;
    let h2p = Math.atan2(b2, a2p) * RAD2DEG;
    if (h2p < 0) h2p += 360;

    // Step 2: Calculate Δh', ΔL', ΔC', and ΔH'
    const dLp = L2 - L1;
    const dCp = C2p - C1p;

    // Δh' calculation (handling hue wraparound)
    let dhp;
    const hpDiff = h2p - h1p;
    if (C1p * C2p === 0) {
        dhp = 0;
    } else if (Math.abs(hpDiff) <= 180) {
        dhp = hpDiff;
    } else if (hpDiff > 180) {
        dhp = hpDiff - 360;
    } else {
        dhp = hpDiff + 360;
    }

    // ΔH' (perceptual hue difference)
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2 * DEG2RAD);

    // Step 3: Calculate average hue h̄'
    let avgHp;
    if (C1p * C2p === 0) {
        avgHp = h1p + h2p;
    } else if (Math.abs(hpDiff) <= 180) {
        avgHp = (h1p + h2p) / 2;
    } else if (h1p + h2p < 360) {
        avgHp = (h1p + h2p + 360) / 2;
    } else {
        avgHp = (h1p + h2p - 360) / 2;
    }

    // Step 4: Calculate weighting functions
    const T = 1
        - 0.17 * Math.cos((avgHp - 30) * DEG2RAD)
        + 0.24 * Math.cos(2 * avgHp * DEG2RAD)
        + 0.32 * Math.cos((3 * avgHp + 6) * DEG2RAD)
        - 0.20 * Math.cos((4 * avgHp - 63) * DEG2RAD);

    const avgL50 = avgL - 50;
    const SL = 1 + (0.015 * avgL50 * avgL50) / Math.sqrt(20 + avgL50 * avgL50);
    const SC = 1 + 0.045 * avgCp;
    const SH = 1 + 0.015 * avgCp * T;

    // Step 5: Calculate rotation term RT
    const avgCp7 = Math.pow(avgCp, 7);
    const RC = 2 * Math.sqrt(avgCp7 / (avgCp7 + 6103515625));
    const dTheta = 30 * Math.exp(-Math.pow((avgHp - 275) / 25, 2));
    const RT = -RC * Math.sin(2 * dTheta * DEG2RAD);

    // Step 6: Calculate total difference (kL=kC=kH=1 for reference conditions)
    const dLpSL = dLp / SL;
    const dCpSC = dCp / SC;
    const dHpSH = dHp / SH;

    return Math.sqrt(
        dLpSL * dLpSL +
        dCpSC * dCpSC +
        dHpSH * dHpSH +
        RT * dCpSC * dHpSH
    );
}

/**
 * CIE2000 squared distance (approximation) - inline variant
 *
 * Returns the squared ΔE*00 for use in comparisons.
 * Note: Since CIE2000 includes a rotation term (RT), squaring is
 * an approximation, but valid for nearest-neighbor comparisons.
 *
 * @param {number} L1 - First color lightness
 * @param {number} a1 - First color a component
 * @param {number} b1 - First color b component
 * @param {number} L2 - Second color lightness
 * @param {number} a2 - Second color a component
 * @param {number} b2 - Second color b component
 * @returns {number} - Squared ΔE*00 distance (approximation)
 */
function cie2000SquaredInline(L1, a1, b1, L2, a2, b2) {
    const dist = cie2000Inline(L1, a1, b1, L2, a2, b2);
    return dist * dist;
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
 * @param {string} [config.metric='cie76'] - Distance metric ('cie76', 'cie94', or 'cie2000')
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

    if (metric === DistanceMetric.CIE2000) {
        return (lab1, lab2) => cie2000(lab1, lab2, squared);
    }

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
 * @param {string} [options.distanceMetric] - 'cie76', 'cie94', or 'cie2000'
 * @param {Object} [options.cie94Params] - CIE94 parameters
 * @returns {Object} - Normalized distance configuration
 */
function normalizeDistanceConfig(options = {}) {
    const metric = options.distanceMetric || DistanceMetric.CIE76;
    const cie94Params = { ...DEFAULT_CIE94_PARAMS, ...options.cie94Params };

    return {
        metric,
        cie94Params,
        isCIE76: metric === DistanceMetric.CIE76,
        isCIE94: metric === DistanceMetric.CIE94,
        isCIE2000: metric === DistanceMetric.CIE2000
    };
}

// ============================================================================
// Native 16-bit Integer Distance Functions
// ============================================================================

/**
 * 16-bit Lab encoding constants
 * L: 0-32768 (32768 = 100%)
 * a, b: 0-32768 (16384 = neutral/0)
 */
const LAB16_L_MAX = 32768;
const LAB16_AB_NEUTRAL = 16384;

// Scale factors for converting thresholds
// Perceptual L (0-100) to 16-bit: multiply by 327.68
// Perceptual a/b (-128 to +127) to 16-bit offset: multiply by 128
const L_SCALE = LAB16_L_MAX / 100;       // 327.68
const AB_SCALE = LAB16_AB_NEUTRAL / 128; // 128

/**
 * CIE76 squared distance in native 16-bit integer space
 *
 * Computes distance directly on 16-bit Lab values without conversion.
 * For nearest-neighbor comparisons, relative ordering is preserved.
 *
 * @param {number} L1 - First color L (0-32768)
 * @param {number} a1 - First color a (0-32768, 16384=neutral)
 * @param {number} b1 - First color b (0-32768, 16384=neutral)
 * @param {number} L2 - Second color L (0-32768)
 * @param {number} a2 - Second color a (0-32768, 16384=neutral)
 * @param {number} b2 - Second color b (0-32768, 16384=neutral)
 * @returns {number} - Squared distance in 16-bit² units
 */
function cie76SquaredInline16(L1, a1, b1, L2, a2, b2) {
    const dL = L1 - L2;
    const da = a1 - a2;
    const db = b1 - b2;
    return dL * dL + da * da + db * db;
}

/**
 * CIE76 weighted squared distance in native 16-bit integer space
 *
 * Applies L-weighting for shadow preservation, computed in 16-bit space.
 * Shadow threshold is 13107 (= 40% L in 16-bit units).
 *
 * @param {number} L1 - First color L (0-32768)
 * @param {number} a1 - First color a (0-32768, 16384=neutral)
 * @param {number} b1 - First color b (0-32768, 16384=neutral)
 * @param {number} L2 - Second color L (0-32768)
 * @param {number} a2 - Second color a (0-32768, 16384=neutral)
 * @param {number} b2 - Second color b (0-32768, 16384=neutral)
 * @param {number} [shadowThreshold16=13107] - L threshold in 16-bit units (default: 40%)
 * @param {number} [shadowWeight=2.0] - L multiplier when avgL < threshold
 * @returns {number} - Squared weighted distance in 16-bit² units
 */
function cie76WeightedSquaredInline16(L1, a1, b1, L2, a2, b2, shadowThreshold16 = 13107, shadowWeight = 2.0) {
    const dL = L1 - L2;
    const da = a1 - a2;
    const db = b1 - b2;

    // Apply increased L weight for dark colors (shadow preservation)
    const avgL = (L1 + L2) >> 1;  // Integer division by 2
    const lWeight = avgL < shadowThreshold16 ? shadowWeight : 1.0;

    const wdL = dL * lWeight;
    return wdL * wdL + da * da + db * db;
}

/**
 * CIE94 squared distance in native 16-bit integer space
 *
 * Applies chroma-dependent weighting computed in 16-bit space.
 * k1/k2 coefficients are pre-scaled for 16-bit chroma range.
 *
 * 16-bit chroma: C16 = √((a-16384)² + (b-16384)²), max ≈ 23170
 * Perceptual chroma: C = 0-~180
 * Scale factor: 23170/180 ≈ 128.7
 *
 * k1_16 = k1 / 128 = 0.045 / 128 = 0.000352
 * k2_16 = k2 / 128 = 0.015 / 128 = 0.000117
 *
 * @param {number} L1 - First color L (0-32768)
 * @param {number} a1 - First color a (0-32768, 16384=neutral)
 * @param {number} b1 - First color b (0-32768, 16384=neutral)
 * @param {number} L2 - Second color L (0-32768)
 * @param {number} a2 - Second color a (0-32768, 16384=neutral)
 * @param {number} b2 - Second color b (0-32768, 16384=neutral)
 * @param {number} C1 - Pre-computed chroma of first color (in 16-bit units)
 * @param {number} k1_16 - Scaled k1 coefficient (default: 0.000352)
 * @param {number} k2_16 - Scaled k2 coefficient (default: 0.000117)
 * @returns {number} - Squared CIE94 distance in 16-bit² units
 */
function cie94SquaredInline16(L1, a1, b1, L2, a2, b2, C1, k1_16 = 0.000352, k2_16 = 0.000117) {
    const dL = L1 - L2;
    const da = a1 - a2;
    const db = b1 - b2;

    // Chroma of second color (offset from neutral)
    const a2off = a2 - LAB16_AB_NEUTRAL;
    const b2off = b2 - LAB16_AB_NEUTRAL;
    const C2 = Math.sqrt(a2off * a2off + b2off * b2off);

    // Chroma difference
    const dC = C1 - C2;

    // Hue difference squared (derived from dH² = da² + db² - dC²)
    const dHSquared = Math.max(0, da * da + db * db - dC * dC);

    // Weighting factors (using C1 as reference)
    const SC = 1 + k1_16 * C1;
    const SH = 1 + k2_16 * C1;

    // Weighted components
    const dLterm = dL;           // SL = 1
    const dCterm = dC / SC;
    const dHterm = Math.sqrt(dHSquared) / SH;

    return dLterm * dLterm + dCterm * dCterm + dHterm * dHterm;
}

/**
 * Pre-computes 16-bit chroma values for a Lab palette
 *
 * Chroma is computed as distance from neutral (16384) in a/b space.
 *
 * @param {Array<{L, a, b}>} labPalette16 - Lab palette in 16-bit values
 * @returns {Float32Array} - Pre-computed chroma values in 16-bit units
 */
function preparePaletteChroma16(labPalette16) {
    const chroma = new Float32Array(labPalette16.length);
    for (let i = 0; i < labPalette16.length; i++) {
        const p = labPalette16[i];
        const aOff = p.a - LAB16_AB_NEUTRAL;
        const bOff = p.b - LAB16_AB_NEUTRAL;
        chroma[i] = Math.sqrt(aOff * aOff + bOff * bOff);
    }
    return chroma;
}

/**
 * Default CIE94 parameters scaled for 16-bit space
 * @constant
 */
const DEFAULT_CIE94_PARAMS_16 = {
    k1: 0.000352,  // 0.045 / 128
    k2: 0.000117   // 0.015 / 128
};

/**
 * Snap threshold in 16-bit² units
 *
 * Perceptual ΔE = 2.0 → ΔE² = 4.0
 * In 16-bit space with balanced L/a/b contribution:
 * - L contributes: (2.0 * 327.68)² / 3 ≈ 143,000
 * - a,b contribute: (2.0 * 128)² / 3 * 2 ≈ 44,000
 * Total ≈ 187,000 (use 180,000 as conservative threshold)
 */
const SNAP_THRESHOLD_SQ_16 = 180000;

// ============================================================================
// Exports
// ============================================================================

module.exports = {
    // Constants
    DistanceMetric,
    DEFAULT_CIE94_PARAMS,
    DEFAULT_CIE94_PARAMS_16,
    SNAP_THRESHOLD_SQ_16,
    LAB16_L_MAX,
    LAB16_AB_NEUTRAL,
    L_SCALE,
    AB_SCALE,

    // CIE76 functions (perceptual space)
    cie76,
    cie76Weighted,
    cie76SquaredInline,
    cie76WeightedSquaredInline,

    // CIE94 functions (perceptual space)
    cie94,
    cie94SquaredInline,

    // CIE2000 functions (perceptual space)
    cie2000,
    cie2000Inline,
    cie2000SquaredInline,

    // Native 16-bit integer functions
    cie76SquaredInline16,
    cie76WeightedSquaredInline16,
    cie94SquaredInline16,
    preparePaletteChroma16,

    // Factory & helpers
    createDistanceCalculator,
    preparePaletteChroma,
    normalizeDistanceConfig
};
