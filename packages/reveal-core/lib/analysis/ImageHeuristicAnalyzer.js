/**
 * ImageHeuristicAnalyzer
 * Logic to detect 'Artistic Signatures' and set Golden Parameters.
 *
 * SUPPORTS BOTH 8-BIT AND 16-BIT LAB INPUT:
 * - 8-bit: L: 0-255 (0-100), a: 0-255 (-128 to +127), b: 0-255 (-128 to +127)
 * - 16-bit: L: 0-32768 (0-100), a: 0-32768 (16384=neutral), b: 0-32768 (16384=neutral)
 *
 * The analyzer auto-detects bit depth from the input array type or pixel value ranges.
 */
const logger = require("../utils/logger");

const ImageHeuristicAnalyzer = {
    /**
     * Analyze image for artistic signatures
     * @param {Uint8Array|Uint16Array} pixels - Lab pixel data (3 values per pixel)
     * @param {number} width - Image width
     * @param {number} height - Image height
     * @param {Object} [options] - Analysis options
     * @param {number} [options.bitDepth] - Force bit depth (8 or 16), auto-detected if not provided
     * @returns {Object} Analysis result with label, presetId, and timing
     */
    analyze: function(pixels, width, height, options = {}) {
        const startTime = performance.now();

        // AUTO-DETECT BIT DEPTH from array type or explicit option
        // Uint16Array indicates 16-bit, Uint8Array indicates 8-bit
        // Can be overridden with options.bitDepth
        let bitDepth = options.bitDepth;
        if (!bitDepth) {
            if (pixels instanceof Uint16Array) {
                bitDepth = 16;
            } else if (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) {
                bitDepth = 8;
            } else {
                // For generic arrays, check if any value exceeds 255
                const sampleMax = Math.max(pixels[0] || 0, pixels[1] || 0, pixels[2] || 0);
                bitDepth = sampleMax > 255 ? 16 : 8;
            }
        }

        const is16Bit = bitDepth === 16;
        logger.log(`[ImageHeuristicAnalyzer] Analyzing ${is16Bit ? '16-bit' : '8-bit'} Lab data`);

        // Set conversion constants based on bit depth
        // 8-bit:  L: 0-255 → 0-100, a/b: 0-255 (128=neutral)
        // 16-bit: L: 0-32768 → 0-100, a/b: 0-32768 (16384=neutral)
        const maxL = is16Bit ? 32768 : 255;
        const neutralAB = is16Bit ? 16384 : 128;
        const abScale = is16Bit ? (128 / 16384) : 1;

        let stats = {
            total: 0,
            absoluteBlacks: 0,   // L < 5 (Halftone dots)
            highChromaCount: 0,  // C > 35 (Vibrant features)
            warmShadowHues: 0,   // 10-60° in darks (Skin/Brown drift)
            coolShadowHues: 0,   // 200-260° in darks (Blue/Navy drift)
            neutralDarks: 0,     // L < 20 AND C < 10 (Neutral shadows)
            highlightCount: 0,   // L > 80 (Bright/pastel/high-key)
            maxChroma: 0
        };

        // Standard step-sampling (every 40th pixel) is blindingly fast (~10ms)
        // Note: pixels are 3 values per pixel (L, a, b) in Lab mode
        const step = 3 * 40;
        for (let i = 0; i < pixels.length; i += step) {
            // Convert from bit-depth encoding to perceptual ranges
            // L: 0-100, a: -128 to +127, b: -128 to +127
            const L = (pixels[i] / maxL) * 100;
            const a = (pixels[i + 1] - neutralAB) * abScale;
            const b = (pixels[i + 2] - neutralAB) * abScale;

            const chroma = Math.sqrt(a**2 + b**2);

            stats.total++;
            if (L < 5) stats.absoluteBlacks++;
            if (L > 80) stats.highlightCount++;
            if (chroma > 35) stats.highChromaCount++;
            if (chroma > stats.maxChroma) stats.maxChroma = chroma;

            // SHADOW TINT ANALYSIS (The Jethro Fix)
            if (L < 20) {
                if (chroma < 8) {
                    stats.neutralDarks++;
                } else {
                    const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
                    if (hue > 10 && hue < 60) stats.warmShadowHues++;
                    if (hue > 200 && hue < 260) stats.coolShadowHues++;
                }
            }
        }

        logger.log("[ImageHeuristicAnalyzer] Stats:", stats);

        const result = this._matchSignature(stats);
        const elapsed = performance.now() - startTime;

        result.timing = elapsed;
        logger.log(`[ImageHeuristicAnalyzer] Analysis completed in ${elapsed.toFixed(2)}ms`);

        return result;
    },

    _matchSignature: function(stats) {
        const totalSamples = stats.total;
        const darkNeutralRatio = stats.neutralDarks / totalSamples;
        const skinToneRatio = stats.warmShadowHues / totalSamples;
        const absoluteBlackRatio = stats.absoluteBlacks / totalSamples;

        // --- STEP 1: DEFINE ANATOMICAL THRESHOLDS ---
        // A portrait usually has 15-40% "warm/skin" pixels.
        // A black-and-white or dark landscape usually has < 5%.
        const isHumanPalette = skinToneRatio > 0.12;
        const hasSignificantInk = darkNeutralRatio > 0.08 || absoluteBlackRatio > 0.03;

        // --- STEP 2: ASSIGN PRESETS ---

        // CASE A: The "True Jethro"
        // Both black ink signatures AND human skin tones are present.
        if (hasSignificantInk && isHumanPalette) {
            logger.log("[ImageHeuristicAnalyzer] Detected: Halftone Portrait (ink + skin tones)");
            return {
                label: "Halftone Portrait",
                presetId: "halftone-portrait"
            };
        }

        // CASE B: The "Noir/Low-Key"
        // High dark neutral density, but NO human skin tones.
        // (This stops the false-positive portrait triggers).
        if (hasSignificantInk && !isHumanPalette) {
            logger.log("[ImageHeuristicAnalyzer] Detected: Deep Shadow / Noir (ink without skin tones)");
            return {
                label: "Deep Shadow / Noir",
                presetId: "deep-shadow-noir"
            };
        }

        // CASE C: The "Vibrant Graphic"
        if (stats.maxChroma > 45) {
            logger.log("[ImageHeuristicAnalyzer] Detected: Vibrant Graphic (high chroma)");
            return {
                label: "Vibrant Graphic",
                presetId: "vibrant-graphic"
            };
        }

        // CASE D: High Key / Pastel
        if (stats.highlightCount / totalSamples > 0.5) {
            logger.log("[ImageHeuristicAnalyzer] Detected: Pastel / High-Key (>50% highlights)");
            return {
                label: "Pastel / High-Key",
                presetId: "pastel-high-key"
            };
        }

        // DEFAULT FALLBACK
        logger.log("[ImageHeuristicAnalyzer] Detected: Standard Default");
        return {
            label: "Standard Default",
            presetId: "standard-image"
        };
    }
};

module.exports = ImageHeuristicAnalyzer;
