/**
 * ParameterGenerator v4.0 - DNA v2.0 Data-Driven Archetype System
 * Maps Image DNA to archetype parameters using JSON-defined archetypes
 *
 * CHANGELOG:
 * - v1.x-3.x: Hardcoded archetype classification and parameter overrides
 * - v4.0: DATA-DRIVEN - Loads archetypes from JSON, uses 4D weighted distance matching
 *
 * DNA v2.0 ARCHITECTURE:
 * 1. Load archetype definitions from JSON files (reveal-core/archetypes/*.json)
 * 2. Match image DNA to nearest archetype using 4D weighted Euclidean distance
 * 3. Use archetype parameters directly (NO dynamic overrides)
 * 4. Fixed parameters per archetype ensure predictable, testable behavior
 *
 * BENEFITS:
 * - No "Thermonuclear" morphing or conditional override logic
 * - Archetypes are version-controlled and self-documenting
 * - Adding new archetypes requires zero code changes
 * - Predictable behavior: same DNA always maps to same parameters
 * - Testable: can validate archetype matching independently
 */

const ArchetypeLoader = require('./ArchetypeLoader');
const BilateralFilter = require('../preprocessing/BilateralFilter');
const ExpressionEvaluator = require('./ExpressionEvaluator');

/**
 * @typedef {Object} RevealConfig
 * Complete configuration output from ParameterGenerator.generate().
 * Fields are grouped by CONFIG_CATEGORIES for pipeline routing.
 *
 * STRUCTURAL — changes require full re-posterization:
 * @property {number} targetColors - Target palette size (3-10)
 * @property {string} engineType - 'reveal'|'reveal-mk1.5'|'balanced'|'classic'|'stencil'|'distilled'
 * @property {string} centroidStrategy - 'SALIENCY'|'ROBUST_SALIENCY'|'VOLUMETRIC'
 * @property {string} distanceMetric - 'cie76'|'cie94'|'cie2000'
 * @property {number} lWeight - Lightness weight for centroid saliency (default 1.2)
 * @property {number} cWeight - Chroma weight for centroid saliency (default 2.0)
 * @property {number} bWeight - Blue axis weight (default 1.0)
 * @property {number} blackBias - Black pixel boost in saliency (default 3.0)
 * @property {string} vibrancyMode - 'subtle'|'moderate'|'aggressive'|'exponential'
 * @property {number} vibrancyBoost - Vibrancy multiplier (default 1.4)
 * @property {number} highlightThreshold - L-value floor for white detection (default 90)
 * @property {number} highlightBoost - Highlight saliency boost (default 1.5)
 * @property {number} paletteReduction - ΔE merge threshold for pruning (default 6.0)
 * @property {boolean} enablePaletteReduction - Enable ΔE-based palette pruning
 * @property {string} substrateMode - 'auto'|'force'|'off'
 * @property {number} substrateTolerance - Substrate detection tolerance (default 2.0)
 * @property {boolean} enableHueGapAnalysis - Inject missing hue sectors
 * @property {number} hueLockAngle - Hue protection zone in degrees (default 20)
 * @property {number} shadowPoint - L-value ceiling for shadow protection (default 15)
 * @property {string} colorMode - 'color'|'grayscale'
 * @property {boolean} preserveWhite - Force white into palette
 * @property {boolean} preserveBlack - Force black into palette
 * @property {boolean} ignoreTransparent - Skip transparent pixels
 * @property {number} neutralCentroidClampThreshold - Neutral centroid clamping (fixed at 0.5)
 * @property {number} neutralSovereigntyThreshold - Neutral sovereignty pixel threshold
 * @property {number} chromaGate - cWeight multiplier for high-chroma images (default 1.0)
 * @property {string} preprocessingIntensity - 'off'|'auto'|'light'|'heavy'
 * @property {number} refinementPasses - K-means refinement passes (0=skip, default 1)
 * @property {string} splitMode - 'median'|'variance'
 * @property {number} chromaAxisWeight - Chroma as virtual split axis (0=off)
 * @property {number} neutralIsolationThreshold - Pre-isolate neutrals below this C*
 * @property {number} warmABoost - Warm a* boost multiplier (default 1.0)
 * @property {number} peakFinderMaxPeaks - Max identity peaks (default 1)
 * @property {Array<number>} peakFinderBlacklistedSectors - Sectors excluded from peak detection
 * @property {number} shadowChromaGateL - Shadow chroma gate L ceiling (0=off)
 *
 * MECHANICAL — mask/preview re-render only (fast path):
 * @property {number} minVolume - Ghost plate removal threshold (0-5%)
 * @property {number} speckleRescue - Morphological despeckle radius (0-10px)
 * @property {number} shadowClamp - Minimum mask density clamp (0-20%)
 *
 * PRODUCTION — affects production render only:
 * @property {number} [trapSize] - Trap size (set at session level, not by archetype)
 * @property {number} [meshSize] - Screen mesh TPI (set at session level, default 230)
 * @property {string} ditherType - Dither algorithm ('atkinson'|'floyd-steinberg'|'bayer'|'stucki'|'none')
 *
 * STRUCTURAL (preprocessing):
 * @property {number} detailRescue - BilateralFilter entropy threshold reduction (0-20)
 * @property {boolean} medianPass - Enable/disable median filter pass
 *
 * METADATA:
 * @property {string} id - Matched archetype ID
 * @property {string} name - Matched archetype name
 * @property {Array<number>} rangeClamp - [minL, maxL] from DNA
 * @property {Object} meta - Archetype matching metadata
 * @property {Object} preprocessing - BilateralFilter configuration
 */

class ParameterGenerator {

    /**
     * Canonical groupings of config fields by how they affect the pipeline.
     * Used by SessionState (navigator) to route parameter changes to the correct
     * update path (re-posterize vs re-render vs commit-only).
     */
    static CONFIG_CATEGORIES = {
        /** Fields that change quantization — require full re-posterization */
        STRUCTURAL: [
            'targetColors', 'engineType', 'centroidStrategy', 'distanceMetric',
            'lWeight', 'cWeight', 'blackBias',
            'vibrancyMode', 'vibrancyBoost',
            'highlightThreshold', 'highlightBoost',
            'paletteReduction', 'enablePaletteReduction',
            'substrateMode', 'substrateTolerance',
            'enableHueGapAnalysis', 'hueLockAngle',
            'shadowPoint', 'colorMode',
            'preserveWhite', 'preserveBlack', 'ignoreTransparent',
            'neutralSovereigntyThreshold',
            'chromaGate', 'preprocessingIntensity',
            'refinementPasses', 'splitMode', 'quantizer',
            'detailRescue', 'medianPass',
        ],
        /** Post-separation knobs — mask/preview re-render only (fast path) */
        MECHANICAL: ['minVolume', 'speckleRescue', 'shadowClamp'],
        /** Affect production render only — meaningless at proxy resolution */
        PRODUCTION: ['trapSize', 'meshSize', 'ditherType'],
    };

    /**
     * Default values for knobs not driven by archetypes.
     * Archetype configs don't define mechanical/production knobs —
     * these defaults prevent stale values from leaking across swaps.
     */
    static KNOB_DEFAULTS = {
        MECHANICAL: { minVolume: 0, speckleRescue: 0, shadowClamp: 0 },
        PRODUCTION: { trapSize: 0, meshSize: 230 },
    };

    /**
     * Extract the mechanical + production knobs from a config or state object.
     * Canonical helper — use instead of cherry-picking individual fields.
     *
     * @param {Object} source - Config object or reactive state
     * @returns {{minVolume: number, speckleRescue: number, shadowClamp: number, trapSize: number}}
     */
    static extractMechanicalKnobs(source) {
        return {
            minVolume: source.minVolume || 0,
            speckleRescue: source.speckleRescue || 0,
            shadowClamp: source.shadowClamp || 0,
            trapSize: source.trapSize || 0,
        };
    }

    /**
     * Generate configuration from DNA analysis using data-driven archetypes
     *
     * @param {Object} dna - DNA analysis result
     * @param {Object} [options] - Generation options
     * @param {Uint8ClampedArray} [options.imageData] - RGBA data for entropy calculation
     * @param {number} [options.width] - Image width
     * @param {number} [options.height] - Image height
     * @param {string} [options.preprocessingIntensity='auto'] - 'off', 'auto', 'light', 'heavy'
     * @param {string} [options.manualArchetypeId] - Optional manual archetype ID to bypass DNA matching
     * @returns {Object} Complete configuration from matched archetype
     */
    static generate(dna, options = {}) {
        // 1. Match DNA to nearest archetype using 4D weighted distance
        // If manualArchetypeId is provided, bypass DNA matching
        const archetype = ArchetypeLoader.matchArchetype(dna, options.manualArchetypeId);

        // 2. Clone archetype parameters (deep copy to avoid mutations)
        let params = JSON.parse(JSON.stringify(archetype.parameters));

        // 2.3. Evaluate dynamic expressions in archetype parameters
        // String values like "channels + 2" are evaluated against image context.
        // Non-string values pass through unchanged.
        if (options.image) {
            params = ExpressionEvaluator.evaluate(params, {
                image: options.image,
                channels: params.targetColors,
                press: options.press
            });
        }

        // 2.5. DNA v2.0 CONDITIONAL OVERRIDES
        // Apply chromatic fingerprint-based adjustments for specific scenarios
        if (dna.version === "2.0" && dna.sectors) {
            this._applyDNAv2Overrides(params, dna, archetype);
        }

        // 2.6. Apply chromaGate: Boost cWeight for high-chroma images
        this._applyChromaGate(params, dna);

        // 3. Set bit depth metadata for distance metric selection
        // DNAGenerator stores bitDepth in metadata.bitDepth, not at top level
        const bitDepth = dna.bitDepth || (dna.metadata && dna.metadata.bitDepth) || 8;

        // 4. Configure preprocessing (conditional based on image entropy)
        const preprocessingIntensity = options.preprocessingIntensity || params.preprocessingIntensity || 'auto';

        // Apply detailRescue: Pass it to BilateralFilter via dna object
        const dnaWithOverrides = {
            ...dna,
            archetype: archetype.name,
            detailRescue: params.detailRescue  // Lower entropy threshold to preserve details
        };

        const preprocessing = BilateralFilter.createPreprocessingConfig(
            dnaWithOverrides,
            options.imageData || null,
            options.width || 0,
            options.height || 0,
            preprocessingIntensity
        );

        if (preprocessing.enabled) {
        }

        // 5. Normalize archetype values to engine-canonical forms
        // Dither types: archetypes may use PascalCase ("FloydSteinberg", "Atkinson")
        // but SeparationEngine expects kebab-case ("floyd-steinberg", "atkinson")
        const DITHER_NORMALIZE = {
            'floydsteinberg': 'floyd-steinberg',
            'floyd-steinberg': 'floyd-steinberg',
            'atkinson': 'atkinson',
            'stucki': 'stucki',
            'bayer': 'bayer',
            'none': 'none'
        };
        const rawDither = (params.ditherType || 'atkinson').toLowerCase();
        const normalizedDither = DITHER_NORMALIZE[rawDither] || rawDither;

        // Preprocessing: normalize "none" → "off" (canonical off state)
        const rawPreproc = preprocessingIntensity;
        const normalizedPreproc = rawPreproc === 'none' ? 'off' : rawPreproc;

        // 6. Build complete configuration
        const config = {
            // Identity
            id: archetype.id,
            name: archetype.name,
            engineType: archetype.engine === 'distilled' ? 'distilled' : 'reveal-mk1.5',

            // NOTE: bitDepth is intentionally NOT included here.
            // ParameterGenerator has no opinion on bit depth — the caller knows their data.
            // ProxyEngine sets bitDepth:16 in PROXY_SAFE_OVERRIDES (Navigator reads true
            // 16-bit Lab via componentSize:16, confirmed working 2026-02-16).
            // Batch callers pass bitDepth:16 explicitly in their opts.
            // Without bitDepth:16, the engine uses 8-bit thresholds (brown-dampener active),
            // which mangles warm centroid placement on 16-bit data.

            // Core parameters — DNA-driven adaptive color count is the primary driver.
            // Archetype provides min/max bounds; targetColorsSlider is fallback only
            // when DNA lacks sector data (legacy simplified DNA).
            targetColors: this._computeAdaptiveColorCount(dna, archetype)
                || params.targetColorsSlider || params.targetColors || 8,
            ditherType: normalizedDither,
            distanceMetric: params.distanceMetric || 'cie76',

            // Saliency weights
            lWeight: params.lWeight || 1.2,
            cWeight: params.cWeight || 2.0,
            bWeight: params.bWeight !== undefined ? params.bWeight : 1.0,
            blackBias: params.blackBias || 3.0,

            // Vibrancy
            vibrancyMode: params.vibrancyMode || 'moderate',
            vibrancyBoost: params.vibrancyBoost || 1.4,

            // Highlights
            highlightThreshold: params.highlightThreshold || 90,
            highlightBoost: params.highlightBoost || 1.5,

            // Color merging
            paletteReduction: params.paletteReduction || 6.0,
            enablePaletteReduction: params.enablePaletteReduction !== undefined ? params.enablePaletteReduction : true,

            // Substrate
            substrateMode: params.substrateMode || 'auto',
            substrateTolerance: params.substrateTolerance || 2.0,

            // Hue analysis
            enableHueGapAnalysis: params.enableHueGapAnalysis !== undefined ? params.enableHueGapAnalysis : true,
            hueLockAngle: params.hueLockAngle || 20,

            // Shadow/highlight points
            shadowPoint: params.shadowPoint || 15,

            // Color mode
            colorMode: params.colorMode || 'color',

            // Preservation flags
            preserveWhite: params.preserveWhite !== undefined ? params.preserveWhite : true,
            preserveBlack: params.preserveBlack !== undefined ? params.preserveBlack : true,
            ignoreTransparent: params.ignoreTransparent !== undefined ? params.ignoreTransparent : true,

            // Engine selection (engineType already set above from archetype.engine)
            centroidStrategy: params.centroidStrategy || 'SALIENCY',

            // Neutral clamping (DNA v2.0 feature)
            neutralCentroidClampThreshold: 0.5,  // Fixed safety floor — not user-tunable
            neutralSovereigntyThreshold: params.neutralSovereigntyThreshold || 0,

            // Median cut split strategy: 'variance' (Wu SSE-minimizing) or 'median' (standard)
            splitMode: params.splitMode || 'median',

            // Quantizer algorithm: 'wu' (default) or 'median-cut'
            quantizer: params.quantizer || 'wu',

            // Chroma split axis + neutral isolation (median cut enhancements)
            chromaAxisWeight: params.chromaAxisWeight !== undefined ? params.chromaAxisWeight : 0,
            neutralIsolationThreshold: params.neutralIsolationThreshold !== undefined ? params.neutralIsolationThreshold : 0,
            warmABoost: params.warmABoost !== undefined ? params.warmABoost : 1.0,

            // PeakFinder tuning (Mk 1.5 identity peak detection)
            peakFinderMaxPeaks: params.peakFinderMaxPeaks !== undefined ? params.peakFinderMaxPeaks : 1,
            peakFinderBlacklistedSectors: params.peakFinderBlacklistedSectors !== undefined ? params.peakFinderBlacklistedSectors : [3, 4],

            // Conditional overrides (DNA v2.0 surgical fixes)
            // Provide sensible defaults so state/UI always has a value
            shadowClamp: params.shadowClamp !== undefined ? params.shadowClamp : 0,
            chromaGate: params.chromaGate !== undefined ? params.chromaGate : 1.0,
            detailRescue: params.detailRescue !== undefined ? params.detailRescue : 0,
            speckleRescue: params.speckleRescue !== undefined ? params.speckleRescue : 0,
            medianPass: params.medianPass !== undefined ? params.medianPass : false,
            minVolume: params.minVolume !== undefined ? params.minVolume : 0,

            // Shadow chroma gate: dark low-chroma pixels → achromatic before median cut
            // Prevents dark backgrounds from consuming palette slots (e.g. "brown" plate)
            shadowChromaGateL: params.shadowChromaGateL !== undefined ? params.shadowChromaGateL : 0,

            // Preprocessing intensity (user-selectable, drives BilateralFilter)
            preprocessingIntensity: normalizedPreproc,

            // K-means refinement passes (0 = skip, 1 = default, 2+ = extra convergence)
            refinementPasses: params.refinementPasses !== undefined ? params.refinementPasses : 1,

            // Screen mesh — NOT set here; meshSize is a session-level equipment
            // setting (physical screen), not an archetype/image property.
            // Default 230 TPI is applied in SessionState.

            // Legacy fields
            rangeClamp: [dna.minL || 0, dna.maxL || 100],

            // Metadata
            meta: {
                archetype: archetype.name,
                archetypeId: archetype.id,
                peakChroma: dna.maxC || dna.c || 0,
                isPhoto: archetype.name.includes('Photo') || archetype.name.includes('Cinematic'),
                isGraphic: archetype.name.includes('Graphic') || archetype.name.includes('Neon'),
                isArchive: bitDepth === 16,
                bitDepth: bitDepth,

                // Archetype matching details (DNA v1.0 or v2.0)
                matchVersion: archetype.matchVersion || '1.0',
                matchDistance: archetype.matchDistance || 0,  // DNA v1.0 legacy
                matchScore: archetype.matchScore,              // DNA v2.0 total score
                matchBreakdown: archetype.matchBreakdown,      // DNA v2.0 score components
                matchRanking: archetype.matchRanking           // DNA v2.0 full ranked list
            },

            // Preprocessing
            preprocessing
        };

        // Log configuration selection
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 25;
        const meanC = dna.c || 0;
        const peakChroma = dna.maxC || meanC;

        return config;
    }

    /**
     * Compute adaptive target color count from image DNA sectors.
     *
     * Algorithm:
     * - Count hue sectors with >3% pixel coverage
     * - +1 if significant neutral mass (>10% pixels outside any sector)
     * - +1 if wide tonal range (l_std_dev > 22)
     * - +1 if high hue entropy (>0.7)
     * - Clamp to [5, 10]
     *
     * @param {Object} dna - DNA v2.0 analysis with sectors
     * @param {Object} archetype - Matched archetype definition
     * @returns {number|null} Adaptive count, or null if DNA lacks sectors
     */
    static _computeAdaptiveColorCount(dna, archetype) {
        if (!dna.sectors || !dna.global) return null;

        const SECTOR_MIN_COVERAGE = 0.03;
        const NEUTRAL_MASS_THRESHOLD = 0.10;

        // Count occupied sectors
        let occupiedSectors = 0;
        let totalSectorWeight = 0;
        for (const sector of Object.values(dna.sectors)) {
            if (sector.weight > SECTOR_MIN_COVERAGE) occupiedSectors++;
            totalSectorWeight += sector.weight;
        }

        let count = occupiedSectors;

        // Neutral mass: tiered contribution — large neutral mass spanning wide
        // tonal range needs separate light/mid/dark neutral bands
        const neutralMass = 1.0 - totalSectorWeight;
        if (neutralMass > NEUTRAL_MASS_THRESHOLD) count++;
        if (neutralMass > 0.25) count++;
        if (neutralMass > 0.40) count++;

        // Tonal range bonus
        if (dna.global.l_std_dev > 22) count++;

        // Entropy bonus
        if (dna.global.hue_entropy > 0.7) count++;

        // Hue spread bonus — occupied sectors spanning wide hue arc need
        // distinct palette slots to avoid merging perceptually distant hues
        const SECTOR_CENTER = {
            red: 0, orange: 30, yellow: 60, chartreuse: 90,
            green: 120, cyan: 150, azure: 180, blue: 210,
            purple: 240, magenta: 270, pink: 300, rose: 330
        };
        const occupiedAngles = [];
        for (const [name, sector] of Object.entries(dna.sectors)) {
            if (sector.weight > SECTOR_MIN_COVERAGE && SECTOR_CENTER[name] !== undefined) {
                occupiedAngles.push(SECTOR_CENTER[name]);
            }
        }
        if (occupiedAngles.length >= 3) {
            occupiedAngles.sort((a, b) => a - b);
            // Find largest gap on the hue wheel — spread = 360 - largest gap
            let maxGap = 0;
            for (let i = 1; i < occupiedAngles.length; i++) {
                maxGap = Math.max(maxGap, occupiedAngles[i] - occupiedAngles[i - 1]);
            }
            // Wrap-around gap
            maxGap = Math.max(maxGap, 360 - occupiedAngles[occupiedAngles.length - 1] + occupiedAngles[0]);
            const hueSpread = 360 - maxGap;
            if (hueSpread > 150) count++;
        }

        const minColors = archetype.parameters?.minColors || 4;
        const maxColors = archetype.parameters?.maxColors || 12;
        return Math.max(minColors, Math.min(maxColors, Math.round(count)));
    }

    /**
     * DEPRECATED: Legacy archetype classification (kept for backward compatibility)
     * Use ArchetypeLoader.matchArchetype() instead
     */
    /**
     * DOMINANT SECTOR TRAIT LOOKUP TABLE
     * Maps each of the 12 hue sectors to surgical parameter overrides
     *
     * This is the "brain" of the Parameter Generator - it applies specific
     * protections based on the image's dominant color personality
     */
    static getDominantSectorTrait(sector) {
        const TRAIT_TABLE = {
            red: {
                name: 'Crimson Guard',
                overrides: { lWeight: 1.0, cWeight: 4.5 },
                purpose: 'Protects deep reds from shifting toward brown in shadows'
            },
            orange: {
                name: 'Amber Lock',
                overrides: { lWeight: 1.0, paletteReduction: 6.5 },
                purpose: 'Lowers L-priority to preserve texture while maintaining 8-screen efficiency'
            },
            yellow: {
                name: 'Yellow Protect',
                overrides: { hueLockAngle: 30, substrateTolerance: 1.2, paletteReduction: 6.0 },
                purpose: 'Tighter tolerance to save highlight detail; safeguards yellow sovereignty within 8-color budget'
            },
            chartreuse: {
                name: 'Neon Bloom',
                overrides: { enableHueGapAnalysis: true, paletteReduction: 6.0 },
                purpose: 'Ensures chartreuse outliers don\'t trigger screen bloat while preserving high-vis greens'
            },
            green: {
                name: 'Forest Depth',
                overrides: { lWeight: 1.4, blackBias: 7.0 },
                purpose: 'Maintains structural detail in dark foliage and green gradients'
            },
            cyan: {
                name: 'Ice/Sky Focus',
                overrides: { neutralSovereigntyThreshold: 0, cWeight: 3.5 },
                purpose: 'Ensures sky and water outliers aren\'t locked out by neutral axis'
            },
            azure: {
                name: 'Spring Clarity',
                overrides: { paletteReduction: 6.0, cWeight: 3.5 },
                purpose: 'Keeps spring-green/teal distinct from pure green while maintaining efficiency'
            },
            blue: {
                name: 'Blue Rescue',
                overrides: { neutralSovereigntyThreshold: 0, enableHueGapAnalysis: true },
                purpose: 'The Waterloo fix; forces engine to find blue even in neutral scans'
            },
            purple: {
                name: 'Shadow Hue',
                overrides: { blackBias: 8.0, lWeight: 1.2 },
                purpose: 'Prevents purples from disappearing into black ink plate'
            },
            magenta: {
                name: 'Punch Recovery',
                overrides: { paletteReduction: 6.0 },
                purpose: 'Maintains micro-detail in magentas without wasting screens'
            },
            pink: {
                name: 'Skin/Petal Soft',
                overrides: { lWeight: 1.6, paletteReduction: 6.0 },
                purpose: 'Prioritizes tonal smoothness over raw chroma for skin tones and flowers'
            },
            rose: {
                name: 'Deep Garnet',
                overrides: { lWeight: 1.1, cWeight: 4.0 },
                purpose: 'Keeps dark reds from becoming muddy or black'
            }
        };

        return TRAIT_TABLE[sector] || null;
    }

    /**
     * DNA v2.0 CONDITIONAL OVERRIDES - THREE-LEVEL TRAIT STACK
     * Apply chromatic fingerprint-based parameter adjustments
     *
     * HIERARCHY (Specific Wins):
     * Level 1: Archetype baseline (from JSON)
     * Level 2: Dominant Sector Trait (surgical overrides for specific hues)
     * Level 3: Entropy Delta (diversity adjustments)
     *
     * @private
     */
    static _applyDNAv2Overrides(params, dna, archetype) {
        // Only apply overrides to certain archetypes that benefit from refinement
        const refinableArchetypes = [
            'fine_art_scan',
            'warm_tonal_optimized',
            'detail_recovery',
            'vivid_photo',          // Add vibrant tonal
            'vivid_poster',          // Add vibrant graphic
            'neon'            // Add neon graphic
        ];

        if (!refinableArchetypes.includes(archetype.id)) {
            return; // Skip overrides for specialized archetypes
        }


        // Access DNA v2.0 fields from global object if available, fallback to top-level
        const hue_entropy = dna.global?.hue_entropy ?? dna.hue_entropy;
        const temperature_bias = dna.global?.temperature_bias ?? dna.temperature_bias;

        if (hue_entropy !== undefined) {
        }
        if (temperature_bias !== undefined) {
        }

        // LEVEL 2: DOMINANT SECTOR TRAIT (Surgical Overrides)
        // Apply hue-specific protections based on dominant color personality
        if (dna.dominant_sector && dna.dominant_sector !== 'none') {
            const dominantWeight = dna.sectors[dna.dominant_sector]?.weight || 0;

            // Only apply trait if sector is truly dominant (> 20%)
            if (dominantWeight > 0.2) {
                const trait = this.getDominantSectorTrait(dna.dominant_sector);
                if (trait) {

                    // Apply trait overrides (merge, don't replace)
                    Object.keys(trait.overrides).forEach(key => {
                        const value = trait.overrides[key];
                        if (typeof value === 'number') {
                            // For numeric values, use the trait value if it's stronger
                            params[key] = value;
                        } else {
                            // For booleans/strings, trait wins
                            params[key] = value;
                        }
                    });
                }
            }
        }

        // LEVEL 3: ENTROPY DELTA (Diversity Adjustments)
        // Adjust merging behavior based on color diversity

        // Low Entropy (< 0.3): Limited Palette - Focus on tonal ramps
        if (hue_entropy !== undefined && hue_entropy < 0.3) {
            params.lWeight = Math.max(params.lWeight || 1.2, 1.8);  // Prioritize lightness
            params.paletteReduction = Math.max(params.paletteReduction || 6.0, 8.0);  // Aggressive merging
            params.enableHueGapAnalysis = false;  // Don't force hue diversity
        }

        // High Entropy (> 0.8): Rainbow Protection - Preserve diversity
        else if (hue_entropy !== undefined && hue_entropy > 0.8) {
            params.enableHueGapAnalysis = true;  // Force hue gap detection
            params.paletteReduction = Math.min(params.paletteReduction || 6.0, 4.0);  // Gentler merging
        }

        // SPECIAL CASE: Cool Outlier Protection (Blue Door Fix)
        // Protect minority cool colors in warm-dominant images
        const coolPresence = (dna.sectors?.blue?.weight || 0) +
                            (dna.sectors?.cyan?.weight || 0) +
                            (dna.sectors?.azure?.weight || 0);

        if (coolPresence > 0.05 && temperature_bias !== undefined && temperature_bias > 0.5) {
            params.neutralSovereigntyThreshold = 0;  // Don't neutralize cool colors
            params.enableHueGapAnalysis = true;      // Force cool color slots
        }

    }

    /**
     * Apply chromaGate: Boost cWeight for high-chroma images
     * Fixes ΔE > 20 failures in vibrant images (snails, ducks, sweets)
     */
    static _applyChromaGate(params, dna) {
        if (!params.chromaGate || dna.maxC === undefined) {
            return;
        }

        const highChromaThreshold = 60; // Images with maxC > 60 are considered high-chroma

        if (dna.maxC > highChromaThreshold) {
            const originalCWeight = params.cWeight || 1.0;
            params.cWeight = originalCWeight * params.chromaGate;

        }
    }

    /**
     * Convert a ParameterGenerator config to PosterizationEngine options.
     *
     * Eliminates the manual 20-30 line params object construction that every
     * batch script was doing. Maps config field names to engine field names
     * (e.g. targetColors → targetColorsSlider) and uses vibrancyBoost directly
     * (not the legacy saturationBoost alias).
     *
     * @param {Object} config - Output from ParameterGenerator.generate()
     * @param {Object} [overrides={}] - Caller-specific overrides (e.g. { bitDepth: 16, format: 'lab' })
     * @returns {Object} Engine-ready options for posterizeImage() / separateImage()
     */
    static toEngineOptions(config, overrides = {}) {
        return {
            // Core (both names for compatibility — batch uses targetColorsSlider,
            // ProxyEngine uses targetColors)
            targetColors: config.targetColors,
            targetColorsSlider: config.targetColors,
            format: 'lab',
            engineType: config.engineType || 'reveal',
            centroidStrategy: config.centroidStrategy || 'SALIENCY',

            // Distance metric
            distanceMetric: config.distanceMetric || 'cie76',
            ditherType: config.ditherType || 'atkinson',

            // Saliency weights
            lWeight: config.lWeight,
            cWeight: config.cWeight,
            bWeight: config.bWeight,
            blackBias: config.blackBias,

            // Vibrancy — use canonical name directly, NOT saturationBoost
            vibrancyMode: config.vibrancyMode,
            vibrancyBoost: config.vibrancyBoost,

            // Highlights
            highlightThreshold: config.highlightThreshold,
            highlightBoost: config.highlightBoost,

            // Palette reduction
            enablePaletteReduction: config.enablePaletteReduction,
            paletteReduction: config.paletteReduction,
            snapThreshold: config.snapThreshold,
            densityFloor: config.densityFloor,

            // Substrate
            substrateMode: config.substrateMode,
            substrateTolerance: config.substrateTolerance,

            // Hue analysis
            enableHueGapAnalysis: config.enableHueGapAnalysis,
            hueLockAngle: config.hueLockAngle,

            // Shadow/highlight
            shadowPoint: config.shadowPoint,

            // Color mode
            colorMode: config.colorMode || 'color',

            // Preservation
            preserveWhite: config.preserveWhite,
            preserveBlack: config.preserveBlack,
            ignoreTransparent: config.ignoreTransparent,

            // Mechanical knobs (post-separation)
            shadowClamp: config.shadowClamp,
            chromaGate: config.chromaGate,
            detailRescue: config.detailRescue,
            speckleRescue: config.speckleRescue,
            medianPass: config.medianPass,
            minVolume: config.minVolume,

            // Shadow chroma gate
            shadowChromaGateL: config.shadowChromaGateL,

            // Neutral clamping
            neutralCentroidClampThreshold: config.neutralCentroidClampThreshold,
            neutralSovereigntyThreshold: config.neutralSovereigntyThreshold,

            // Chroma split axis + neutral isolation + warm axis boost
            chromaAxisWeight: config.chromaAxisWeight,
            neutralIsolationThreshold: config.neutralIsolationThreshold,
            warmABoost: config.warmABoost,

            // PeakFinder tuning
            peakFinderMaxPeaks: config.peakFinderMaxPeaks,
            peakFinderBlacklistedSectors: config.peakFinderBlacklistedSectors,

            // K-means refinement
            refinementPasses: config.refinementPasses,

            // Quantization strategy
            splitMode: config.splitMode || 'median',
            quantizer: config.quantizer || 'wu',

            // Screen mesh — passed through if caller provides it (session-level, not archetype).
            // Maps meshSize (config/UI name) → meshCount (SeparationEngine name).
            ...(config.meshSize !== undefined ? { meshCount: config.meshSize } : {}),

            // Caller-specific overrides (bitDepth, format, etc.)
            ...overrides
        };
    }

    static getArchetype(dna) {
        console.warn('⚠️ getArchetype() is deprecated. Use ArchetypeLoader.matchArchetype() instead.');
        const archetype = ArchetypeLoader.matchArchetype(dna);
        return archetype.name;
    }

    /**
     * DEPRECATED: Legacy strategy mapper (kept for backward compatibility)
     * Parameters are now embedded in archetype JSON files
     */
    static getStrategy(archetype, dna) {
        console.warn('⚠️ getStrategy() is deprecated. Parameters are now in archetype JSON files.');
        return {
            dither: 'atkinson',
            bias: 3.0
        };
    }
}

module.exports = ParameterGenerator;
