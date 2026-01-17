/**
 * ImageHeuristicAnalyzer
 * Logic to detect 'Artistic Signatures' and set Golden Parameters.
 *
 * NOTE: Expects Lab pixels directly from Photoshop (3 bytes per pixel: L, a, b)
 * Photoshop encoding: L: 0-255 (0-100), a: 0-255 (-128 to +127), b: 0-255 (-128 to +127)
 */
const logger = require("../../utils/logger");

const ImageHeuristicAnalyzer = {
    analyze: function(pixels, width, height) {
        const startTime = performance.now();

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
        // Note: pixels are 3 bytes per pixel (L, a, b) from Photoshop in Lab mode
        const step = 3 * 40;
        for (let i = 0; i < pixels.length; i += step) {
            // Convert from Photoshop's byte encoding to perceptual ranges
            // L: 0-255 → 0-100, a: 0-255 → -128 to +127, b: 0-255 → -128 to +127
            const L = (pixels[i] / 255) * 100;
            const a = pixels[i + 1] - 128;
            const b = pixels[i + 2] - 128;

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
