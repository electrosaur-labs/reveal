/**
 * ParameterGenerator v3.0 - Expert System Configurator
 * Maps Image DNA to ALL tunable UI parameters
 *
 * CHANGELOG:
 * - v1.3: Chroma Driver for color budgeting
 * - v1.4: Saliency Rescue threshold raised to maxC > 80
 * - v1.5: Dither logic based on l_std_dev instead of k
 * - v1.7: Archetype classification with per-archetype strategies
 * - v1.8: Added distanceMetric selection (CIE76 vs CIE94) based on chroma
 * - v1.9: Simplified distanceMetric selection using peakChroma threshold
 * - v2.0: Added preprocessing configuration (bilateral filter based on entropy)
 * - v3.0: Full parameter mapping - DNA drives ALL UI sliders
 *
 * DISTANCE METRIC SELECTION:
 * - 16-bit images → CIE2000 (museum grade precision) [CONFIG ONLY - see note]
 * - peakChroma > 80 OR isPhotographic → CIE94 (perceptual)
 * - Otherwise → CIE76 (graphic, faster)
 *
 * NOTE: The engine currently uses L-weighted Euclidean distance (CIE76-like) for
 * all pixel assignments. The distanceMetric config is stored for future implementation
 * of CIE94/CIE2000. The current integer 16-bit path provides excellent precision
 * without the performance cost of full CIE2000 trigonometric calculations.
 *
 * FULL PARAMETER MAPPING (v3.0):
 * | DNA Condition           | Parameter          | Value              |
 * |-------------------------|--------------------|--------------------|
 * | isPhoto                 | lWeight            | 1.4                |
 * | isGraphic               | lWeight            | 1.1                |
 * | isArchive               | cWeight            | 2.3                |
 * | bitDepth === 16         | distanceMetric     | 'cie2000'          |
 * | lowChromaDensity > 0.6  | vibrancyMode       | 'exponential'      |
 * | isArchive               | paletteReduction   | 6.5                |
 * | meanL < 30              | substrateMode      | 'black'            |
 * | meanL > 70              | substrateMode      | 'white'            |
 * | meanL < 40              | blackBias          | 8.0                |
 * | isPhoto                 | ditherType         | 'blue-noise'       |
 * | isGraphic               | ditherType         | 'none' or 'atkinson'|
 *
 * ARCHETYPES:
 * - Vector/Flat:    Low variation (l_std_dev < 15). Logos, icons, text.
 * - Vintage/Muted:  Low variation + moderate chroma. Lithographs, WPA posters.
 * - Noir/Mono:      Low chroma + high contrast. B&W photos, woodcuts.
 * - Neon/Vibrant:   Extreme chroma (c > 60). Pop art, neon signs.
 * - Photographic:   High variation + moderate chroma. Natural photos.
 */

const BilateralFilter = require('../preprocessing/BilateralFilter');
const ConstraintEvaluator = require('./ConstraintEvaluator');

// Node.js modules - only available in Node environment
let fs, path;
try {
    fs = require('fs');
    path = require('path');
} catch (e) {
    // Running in browser/UXP - archetype loading not available
    fs = null;
    path = null;
}

class DynamicConfigurator {

    /**
     * Get nested value from DNA object
     * @param {Object} dna - DNA object
     * @param {string} path - Property path (e.g., "sectors.yellow.lMean")
     * @returns {*} Value at path or undefined
     */
    static getNestedValue(dna, path) {
        const parts = path.split('.');
        let value = dna;
        for (const part of parts) {
            if (value === undefined || value === null) {
                return undefined;
            }
            value = value[part];
        }
        return value;
    }

    /**
     * Scale a value based on input/output ranges
     * @param {number} inputValue - Input value
     * @param {Array} inputRange - [min, max] input range
     * @param {Array} outputRange - [min, max] output range
     * @param {boolean} clamp - Whether to clamp output to range
     * @returns {number} Scaled value
     */
    static scaleValue(inputValue, inputRange, outputRange, clamp = true) {
        const [inMin, inMax] = inputRange;
        const [outMin, outMax] = outputRange;

        let normalized = (inputValue - inMin) / (inMax - inMin);
        if (clamp) {
            normalized = Math.max(0, Math.min(1, normalized));
        }

        return outMin + normalized * (outMax - outMin);
    }

    /**
     * Apply DNA scales to parameters (continuous adjustments)
     * @param {Object} params - Parameter object (modified in place)
     * @param {Array} scales - Array of scale definitions
     * @param {Object} dna - DNA object
     */
    static applyDNAScales(params, scales, dna) {
        if (!scales || !Array.isArray(scales)) {
            return;
        }

        for (const scale of scales) {
            const inputValue = this.getNestedValue(dna, scale.by);
            if (inputValue === undefined || inputValue === null) {
                console.warn(`⚠️  DNA scale: property "${scale.by}" not found in DNA, skipping`);
                continue;
            }

            const scaledValue = this.scaleValue(
                inputValue,
                scale.inputRange,
                scale.outputRange,
                scale.clamp !== false // Default to true
            );

            params[scale.param] = scaledValue;

            if (scale.name) {
                console.log(`🎚️  DNA Scale: ${scale.name} → ${scale.param}=${scaledValue.toFixed(2)} (input: ${inputValue.toFixed(1)})`);
            }
        }
    }

    /**
     * Apply DNA constraints to parameters (conditional overrides)
     * @param {Object} params - Parameter object (modified in place)
     * @param {Array} constraints - Array of constraint definitions
     * @param {Object} dna - DNA object
     */
    static applyDNAConstraints(params, constraints, dna) {
        if (!constraints || !Array.isArray(constraints)) {
            return;
        }

        const evaluator = new ConstraintEvaluator();

        // Sort by priority (higher priority = later application = wins)
        const sortedConstraints = [...constraints].sort((a, b) => {
            const aPriority = a.priority || 100;
            const bPriority = b.priority || 100;
            return aPriority - bPriority;
        });

        for (const constraint of sortedConstraints) {
            try {
                const condition = evaluator.evaluate(constraint.if, dna);

                if (condition) {
                    console.log(`✅ DNA Constraint: ${constraint.name || 'unnamed'} (condition met)`);

                    // Apply all parameter overrides in "then" block
                    Object.assign(params, constraint.then);
                }
            } catch (error) {
                console.warn(`⚠️  Failed to evaluate constraint "${constraint.name}": ${error.message}`);
            }
        }
    }

    /**
     * Normalize DNA to ensure backward compatibility
     * Converts v2.0 DNA to include legacy fields if missing
     * @param {Object} dna - DNA object (may be v1.0 or v2.0)
     * @returns {Object} Normalized DNA with legacy fields
     */
    static normalizeDNA(dna) {
        // If already has legacy fields, return as-is
        if ('l' in dna && 'c' in dna && 'k' in dna) {
            return dna;
        }

        // v2.0 format: extract legacy fields from global
        if (dna.global) {
            return {
                ...dna,
                l: dna.global.l,
                c: dna.global.c,
                k: dna.global.k,
                l_std_dev: dna.global.l_std_dev,
                maxC: dna.global.maxC,
                maxCHue: dna.global.maxCHue,
                minL: dna.global.minL,
                maxL: dna.global.maxL
            };
        }

        return dna;
    }

    /**
     * Load archetype configurations from JSON files
     * Only works in Node.js environment (not browser/UXP)
     * @returns {Array|null} Array of archetype configs or null if unavailable
     */
    static loadArchetypes() {
        // Check if fs/path are available (Node.js only)
        if (!fs || !path) {
            return null;  // Silently fall back to legacy generation
        }

        try {
            const archetypeDir = path.join(__dirname, '../../archetypes');

            if (!fs.existsSync(archetypeDir)) {
                return null;
            }

            const files = fs.readdirSync(archetypeDir).filter(f => f.endsWith('.json') && f !== 'schema.json');
            const archetypes = [];

            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(archetypeDir, file), 'utf-8'));
                    if (data.id && data.centroid && data.weights && data.parameters) {
                        archetypes.push(data);
                    }
                } catch (err) {
                    console.warn(`⚠️  Failed to load ${file}: ${err.message}`);
                }
            }

            return archetypes.length > 0 ? archetypes : null;
        } catch (err) {
            return null;  // Silently fall back to legacy
        }
    }

    /**
     * Find nearest archetype using 4D weighted Euclidean distance
     * @param {Object} dna - Image DNA
     * @param {Array} archetypes - Array of archetype configs
     * @returns {Object} Nearest archetype with distance
     */
    static findNearestArchetype(dna, archetypes) {
        const l = dna.l || 50;
        const c = dna.c || 20;
        const k = dna.k || 60;
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 25;

        let nearest = null;
        let minDistance = Infinity;

        for (const arch of archetypes) {
            const centroid = arch.centroid;
            const weights = arch.weights;

            const dSquared =
                weights.l * Math.pow(l - centroid.l, 2) +
                weights.c * Math.pow(c - centroid.c, 2) +
                weights.k * Math.pow(k - centroid.k, 2) +
                weights.l_std_dev * Math.pow(l_std_dev - centroid.l_std_dev, 2);

            const distance = Math.sqrt(dSquared);

            if (distance < minDistance) {
                minDistance = distance;
                nearest = arch;
            }
        }

        return { archetype: nearest, distance: minDistance };
    }

    /**
     * Apply dynamic morphing to archetype baseline parameters
     * Adjusts parameters based on DNA deviations from archetype centroid
     *
     * @param {Object} baseParams - Baseline parameters from archetype
     * @param {Object} dna - Image DNA
     * @param {Object} archetype - Matched archetype
     * @returns {Object} Morphed parameters
     */
    static applyDynamicMorphing(baseParams, dna, archetype) {
        const params = { ...baseParams };
        const morphs = [];

        // Extract DNA values
        const maxC = dna.maxC || 0;
        const minL = dna.minL || 0;
        const maxL = dna.maxL || 100;
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 25;
        const meanC = dna.c || 20;
        const k = dna.k || 60;
        const yellowDominance = dna.yellowDominance || 0;

        // ================================================================
        // MORPH 1: Chroma Sovereignty Scaling
        // If maxC significantly exceeds archetype centroid, boost cWeight
        // ================================================================
        if (maxC > 100) {
            const chromaDeviation = maxC - (archetype?.centroid?.c || 25);
            if (chromaDeviation > 50) {
                const boostFactor = Math.min((chromaDeviation - 50) / 50, 2.0);
                const originalCWeight = params.cWeight;
                params.cWeight = Math.min(6.5, params.cWeight + (boostFactor * 1.5));
                params.lWeight = Math.max(0.2, params.lWeight - (boostFactor * 0.3));
                morphs.push(`maxC spike (${maxC.toFixed(0)}) → cWeight ${originalCWeight.toFixed(1)}→${params.cWeight.toFixed(1)}`);
            }
        }

        // ================================================================
        // MORPH 2: Shadow Gate Calibration
        // Ultra-low minL requires tighter shadowPoint to prevent tonal noise
        // ================================================================
        if (minL < 2) {
            const originalShadowPoint = params.shadowPoint;
            params.shadowPoint = Math.max(2, Math.min(params.shadowPoint, 5));
            if (originalShadowPoint !== params.shadowPoint) {
                morphs.push(`ultra-low minL (${minL.toFixed(1)}) → shadowPoint ${originalShadowPoint}→${params.shadowPoint}`);
            }
        }

        // ================================================================
        // MORPH 3: Flatness Override (Dither & Hue Lock)
        // Ultra-flat images need clean edges and wider hue locks
        // ================================================================
        if (l_std_dev < 8) {
            if (params.ditherType !== 'none') {
                params.ditherType = 'none';
                morphs.push(`ultra-flat (σL=${l_std_dev.toFixed(1)}) → ditherType=none`);
            }
            if (params.hueLockAngle < 35) {
                const originalAngle = params.hueLockAngle;
                params.hueLockAngle = Math.max(params.hueLockAngle, 35);
                morphs.push(`ultra-flat → hueLockAngle ${originalAngle}→${params.hueLockAngle}`);
            }
        }

        // ================================================================
        // MORPH 4: Highlight Threshold (White Protection)
        // Near-100 maxL requires tighter highlight protection
        // ================================================================
        if (maxL > 98) {
            const originalThreshold = params.highlightThreshold;
            params.highlightThreshold = Math.max(96, params.highlightThreshold);
            if (originalThreshold !== params.highlightThreshold) {
                morphs.push(`peak whites (${maxL.toFixed(0)}) → highlightThreshold ${originalThreshold}→${params.highlightThreshold}`);
            }
        }

        // ================================================================
        // MORPH 5: Vibrancy Floor (Low Chroma Nullification)
        // If image is genuinely desaturated (not just averaging), reduce vibrancy
        // ================================================================
        if (meanC < 12 && maxC < 80) {
            const originalBoost = params.vibrancyBoost;
            params.vibrancyBoost = Math.max(0.8, Math.min(params.vibrancyBoost, 1.0));
            params.vibrancyThreshold = Math.max(params.vibrancyThreshold || 0, 18);
            if (originalBoost !== params.vibrancyBoost) {
                morphs.push(`low chroma (C=${meanC.toFixed(1)}) → vibrancyBoost ${originalBoost.toFixed(1)}→${params.vibrancyBoost.toFixed(1)}`);
            }
        }

        // ================================================================
        // MORPH 6: Extreme Contrast Boost
        // Very high K requires stronger black protection
        // ================================================================
        if (k > 95) {
            const originalBias = params.blackBias;
            params.blackBias = Math.max(params.blackBias, 4.5);
            if (originalBias !== params.blackBias) {
                morphs.push(`extreme contrast (K=${k.toFixed(0)}) → blackBias ${originalBias.toFixed(1)}→${params.blackBias.toFixed(1)}`);
            }
        }

        // ================================================================
        // MORPH 7: NUCLEAR YELLOW-PROTECT (Force Sovereignty)
        // Orange (C=141, H=63°) is "blinding" the engine to Yellow (C=93, H=72°)
        // Even with high lWeight, the 63-point b* difference overwhelms L difference
        // Solution: EXTREME L weighting + disable hue-gap optimization
        // Yellow Zone: 70-95° (pure yellows, not oranges at 60° or greens at 110°)
        //
        // ENHANCED: Also triggers on yellowDominance score (>15 = significant yellow presence)
        // When yellowDominance is HIGH (>20), apply THERMONUCLEAR settings
        // ================================================================
        const maxCHue = dna.maxCHue || 0;
        const isYellowSpike = maxCHue >= 70 && maxCHue <= 95;
        const isYellowDominant = yellowDominance > 15;

        if ((isYellowSpike && maxC > 80) || isYellowDominant) {
            const thermonuclear = yellowDominance > 20;  // Ultra-aggressive mode

            console.log(`\n☢️☢️☢️ ${thermonuclear ? 'THERMONUCLEAR' : 'NUCLEAR'} YELLOW MORPH TRIGGERED ☢️☢️☢️`);
            console.log(`  Hue: ${maxCHue.toFixed(1)}° (target: 70-95°)`);
            console.log(`  maxC: ${maxC.toFixed(1)} (threshold: 80)`);
            console.log(`  avgC: ${meanC.toFixed(1)}`);
            console.log(`  yellowDominance: ${yellowDominance.toFixed(1)}% (threshold: 15)`);
            if (thermonuclear) {
                console.log(`  🔥 THERMONUCLEAR MODE: yellowDominance > 20% - MAXIMUM AGGRESSION`);
            }
            console.log(`  Base archetype: ${archetype ? archetype.name : 'unknown'}`);
            console.log(`  Base params BEFORE morph:`);
            console.log(`    lWeight: ${params.lWeight}`);
            console.log(`    cWeight: ${params.cWeight}`);
            console.log(`    centroidStrategy: ${params.centroidStrategy}`);
            console.log(`    paletteReduction: ${params.paletteReduction}`);
            console.log(`    hueLockAngle: ${params.hueLockAngle}`);
            console.log(`    enableHueGapAnalysis: ${params.enableHueGapAnalysis}`);

            // Force SALIENCY to find highlights over volume
            // (prevents 59.6% white substrate from dominating)
            if (params.centroidStrategy !== 'SALIENCY') {
                morphs.push(`yellow spike → centroidStrategy=SALIENCY`);
                params.centroidStrategy = 'SALIENCY';
                console.log(`  ✓ Forced centroidStrategy = SALIENCY`);
            } else {
                console.log(`  ✓ Already using SALIENCY strategy`);
            }

            // TARGETED YELLOW PROTECTION: Balance palette diversity with yellow sovereignty
            // Strategy: Use MODERATE weights for palette discovery (so we get diverse colors)
            //           Apply NUCLEAR protection via pixel assignment hue anchoring (already in engine)
            //
            // OLD APPROACH (too broad): lWeight=15, cWeight=1 → Found 3 yellows, collapsed everything else
            // NEW APPROACH: lWeight=5, cWeight=2.5 → Diverse palette + targeted yellow protection
            const originalLWeight = params.lWeight;
            const originalCWeight = params.cWeight;

            if (thermonuclear) {
                // THERMONUCLEAR: Strong L-bias but not extreme (preserve palette diversity)
                params.lWeight = 5.0;   // Strong L-sensitivity for yellow/orange separation
                params.cWeight = 2.5;   // Moderate chroma weight (allows vibrant colors to survive)
                morphs.push(`🔥 THERMONUCLEAR yellow weights → lWeight=5.0, cWeight=2.5 (balanced L supremacy)`);
            } else {
                // NUCLEAR: Moderate boost
                params.lWeight = 3.5;   // Elevated L-weight
                params.cWeight = 3.0;   // Keep chroma importance
                morphs.push(`nuclear yellow weights → lWeight=3.5, cWeight=3.0 (moderate L boost)`);
            }

            // PREVENT MERGING: Yellow and Orange are separate species
            if (params.hueLockAngle < 90) {
                morphs.push(`yellow sovereignty → hueLockAngle=90° (effectively disables warm-quadrant pruning)`);
                params.hueLockAngle = 90;
            }

            // DISABLE ALL PRUNING: Forbid consolidation entirely
            if (params.paletteReduction > 0) {
                morphs.push(`yellow preserve → paletteReduction=0 (DISABLE all pruning)`);
                params.paletteReduction = 0;
            }

            // KEEP HUE-GAP ANALYSIS ENABLED: We need it to find blues/purples!
            // The ghost shield (in PosterizationEngine) already protects gap-filled colors from pruning
            // So we don't need to disable hue gap analysis entirely
            if (!params.enableHueGapAnalysis) {
                morphs.push(`yellow + diversity → enableHueGapAnalysis=true (find ALL hue gaps)`);
                params.enableHueGapAnalysis = true;
            }

            // VIBRANCY MORPH: Exponential boost widens distance from muddy browns
            params.vibrancyMode = 'exponential';
            const targetVibrancyBoost = thermonuclear ? 1.8 : 1.5;
            if (params.vibrancyBoost < targetVibrancyBoost) {
                params.vibrancyBoost = targetVibrancyBoost;
                morphs.push(`yellow vibrancy → vibrancyBoost=${targetVibrancyBoost}, mode=exponential`);
            }

            // DIAGNOSTIC: Log final morphed parameters
            console.log(`\n  FINAL MORPHED PARAMETERS (Palette Discovery):`);
            console.log(`    lWeight: ${params.lWeight} ${thermonuclear ? '🔥🔥🔥' : '⚡'} (moderate for diversity)`);
            console.log(`    cWeight: ${params.cWeight} ${thermonuclear ? '🔥🔥🔥' : '⚡'} (allows vibrant colors)`);
            console.log(`    centroidStrategy: ${params.centroidStrategy} ⚡`);
            console.log(`    paletteReduction: ${params.paletteReduction} ⚡`);
            console.log(`    hueLockAngle: ${params.hueLockAngle} ⚡`);
            console.log(`    enableHueGapAnalysis: ${params.enableHueGapAnalysis} ⚡`);
            console.log(`    vibrancyMode: ${params.vibrancyMode}`);
            console.log(`    vibrancyBoost: ${params.vibrancyBoost} ${thermonuclear ? '🔥' : ''}`);
            console.log(`  NOTE: Nuclear yellow protection via 1024× hue anchoring in pixel assignment`);
            console.log(`☢️☢️☢️ END ${thermonuclear ? 'THERMONUCLEAR' : 'NUCLEAR'} YELLOW MORPH ☢️☢️☢️\n`);
        }

        // ================================================================
        // MORPH 7B: HIGH-CHROMA NON-YELLOW SPIKES (Other vibrant colors)
        // For blues, greens, magentas with extreme chroma but NOT in yellow zone
        // ================================================================
        else if (maxC > 120) {
            console.log(`⚡ High-Chroma Spike (non-yellow): maxC=${maxC.toFixed(0)}, hue=${maxCHue.toFixed(0)}°`);

            // Force SALIENCY
            if (params.centroidStrategy !== 'SALIENCY') {
                morphs.push(`chroma spike → centroidStrategy=SALIENCY`);
                params.centroidStrategy = 'SALIENCY';
            }

            // Switch from "Chroma-Chasing" to "Tonal Ladder" for extreme spikes
            if (maxC > 130) {
                // Discovery Phase: LOW L-weight lets centroids find vibrant colors without grouping by brightness
                params.lWeight = 1.2;
                // Chroma chase: Find the saturation spikes first
                params.cWeight = 5.0;
                // Tone down aggressive boost to keep midtones natural
                params.vibrancyBoost = 1.2;
                // Force assignment engine to favor bright highlight plates
                params.highlightBoost = 3.0;
                morphs.push(`extreme chroma (${maxC.toFixed(0)}) → tonal ladder mode: lWeight=1.2, cWeight=5.0, highlightBoost=3.0`);
            } else {
                // Standard high-chroma handling (for maxC 120-130)
                params.cWeight = Math.min(6.0, params.cWeight + 3.0);
                params.lWeight = Math.max(0.3, params.lWeight - 0.5);
                morphs.push(`non-yellow spike → cWeight=${params.cWeight.toFixed(1)}, lWeight=${params.lWeight.toFixed(1)}`);
            }

            // Moderate hue protection
            params.hueLockAngle = Math.max(params.hueLockAngle, 35);
            params.paletteReduction = Math.min(params.paletteReduction, 4.0);
        }

        // ================================================================
        // MORPH 8: ADAPTIVE HUE PROTECTION (High Dynamic Range)
        // High K requires wider hue locks and lower palette reduction
        // Prevents vibrant spikes from merging into neutral midtones
        // ================================================================
        if (k > 90) {
            const originalAngle = params.hueLockAngle;
            const originalReduction = params.paletteReduction;

            params.hueLockAngle = Math.max(params.hueLockAngle, 35);
            params.paletteReduction = Math.min(params.paletteReduction, 4.0);

            if (originalAngle !== params.hueLockAngle || originalReduction !== params.paletteReduction) {
                morphs.push(`high K (${k.toFixed(0)}) → hueLockAngle ${originalAngle}→${params.hueLockAngle}, paletteReduction ${originalReduction.toFixed(1)}→${params.paletteReduction.toFixed(1)}`);
            }
        }

        // ================================================================
        // MORPH 9: AUTO-DITHER FOR TONAL COMPLEXITY
        // Complex photographic images need dithering for smooth gradients
        // ================================================================
        if (l_std_dev > 15 && params.ditherType === 'none') {
            params.ditherType = 'BlueNoise';
            morphs.push(`complex tones (σL=${l_std_dev.toFixed(1)}) → ditherType=BlueNoise`);
        }

        // ================================================================
        // MORPH 10: HIGHLIGHT BOOST FOR YELLOW DETECTION
        // Increase highlight sensitivity for capturing small bright yellow areas
        // ================================================================
        if (maxC > 100 && meanC < 30) {
            const originalHighlightBoost = params.highlightBoost;
            params.highlightBoost = Math.max(params.highlightBoost, 2.2);

            if (originalHighlightBoost !== params.highlightBoost) {
                morphs.push(`yellow spike potential → highlightBoost ${originalHighlightBoost.toFixed(1)}→${params.highlightBoost.toFixed(1)}`);
            }
        }

        // Log morphs if any were applied
        if (morphs.length > 0) {
            console.log(`🔀 Dynamic Morphs (${morphs.length}):`);
            morphs.forEach(m => console.log(`   - ${m}`));
        }

        // DIAGNOSTIC: Final parameter check before return
        console.log(`\n📤 RETURNING PARAMETERS TO ENGINE:`);
        console.log(`   lWeight: ${params.lWeight}`);
        console.log(`   cWeight: ${params.cWeight}`);
        console.log(`   centroidStrategy: ${params.centroidStrategy}`);
        console.log(`   paletteReduction: ${params.paletteReduction}`);
        console.log(`   hueLockAngle: ${params.hueLockAngle}`);
        console.log(`   enableHueGapAnalysis: ${params.enableHueGapAnalysis}\n`);

        return params;
    }

    /**
     * Generate configuration using archetype baselines with dynamic morphing
     * @param {Object} dna - Image DNA (v1.0 or v2.0)
     * @param {Array} archetypes - Loaded archetype configurations
     * @param {Object} options - Generation options
     * @param {boolean} options.skipLegacyMorphing - Skip legacy morphing (for testing constraints)
     * @returns {Object} Complete configuration with morphed parameters
     */
    static generateFromArchetypes(dna, archetypes, options = {}) {
        // ================================================================
        // 0. NORMALIZE DNA (Ensure backward compatibility)
        // ================================================================
        dna = this.normalizeDNA(dna);

        // ================================================================
        // 1. FIND NEAREST ARCHETYPE (Baseline)
        // ================================================================
        const { archetype, distance } = this.findNearestArchetype(dna, archetypes);

        console.log(`🎯 Matched Archetype: ${archetype.name} (distance: ${distance.toFixed(1)})`);

        // ================================================================
        // 2. MAX CHROMA OVERRIDE (Before morphing)
        // Force vibrant_tonal for extreme chroma spikes
        // ================================================================
        const maxC = dna.maxC || 0;
        const k = dna.k || 0;
        let selectedArchetype = archetype;

        if (maxC > 120 && k > 80) {
            const vibrantTonal = archetypes.find(a => a.id === 'vibrant_tonal');
            if (vibrantTonal) {
                console.log(`⚡ Max Chroma Override: maxC=${maxC.toFixed(1)}, K=${k.toFixed(1)} → Vibrant Tonal (was: ${archetype.name})`);
                selectedArchetype = vibrantTonal;
            }
        }

        // ================================================================
        // 3. START WITH ARCHETYPE BASELINE
        // ================================================================
        let params = { ...selectedArchetype.parameters };

        // ================================================================
        // 4. APPLY DNA SCALES (Continuous adjustments)
        // ================================================================
        if (selectedArchetype.dna_scales) {
            console.log(`🎚️  Applying DNA scales...`);
            this.applyDNAScales(params, selectedArchetype.dna_scales, dna);
        }

        // ================================================================
        // 5. APPLY DNA CONSTRAINTS (Conditional overrides)
        // ================================================================
        if (selectedArchetype.dna_constraints) {
            console.log(`📋 Evaluating DNA constraints...`);
            this.applyDNAConstraints(params, selectedArchetype.dna_constraints, dna);
        }

        // ================================================================
        // 6. APPLY LEGACY MORPHING (During migration only)
        // ================================================================
        if (!options.skipLegacyMorphing) {
            params = this.applyDynamicMorphing(params, dna, selectedArchetype);
        } else {
            console.log(`⏭️  Skipping legacy morphing (constraint-only mode)`);
        }

        // ================================================================
        // 7. PREPROCESSING CONFIGURATION
        // ================================================================
        const preprocessingIntensity = options.preprocessingIntensity || 'auto';
        const preprocessing = BilateralFilter.createPreprocessingConfig(
            { ...dna, archetype: selectedArchetype.name },
            options.imageData || null,
            options.width || 0,
            options.height || 0,
            preprocessingIntensity
        );

        if (preprocessing.enabled) {
            console.log(`🔧 Preprocessing: ${preprocessing.intensity} (${preprocessing.reason})`);
        }

        // ================================================================
        // 8. LOG CONFIGURATION
        // ================================================================
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 25;
        const meanC = dna.c || 20;
        console.log(`🧬 DNA: L=${dna.l?.toFixed(1)}, C=${meanC.toFixed(1)}, K=${k.toFixed(1)}, σL=${l_std_dev.toFixed(1)}, maxC=${maxC.toFixed(1)}`);

        // ================================================================
        // 9. RETURN COMPLETE CONFIGURATION
        // ================================================================
        return {
            // Identity
            id: selectedArchetype.id,
            name: selectedArchetype.name,
            description: selectedArchetype.description || '',

            // All parameters from archetype (with morphing applied)
            ...params,

            // Legacy fields
            rangeClamp: [dna.minL || 0, dna.maxL || 100],

            // Metadata
            meta: {
                archetype: selectedArchetype.name,
                archetypeId: selectedArchetype.id,
                peakChroma: maxC,
                distance: distance,
                bitDepth: dna.bitDepth || 8
            },

            // Preprocessing
            preprocessing
        };
    }

    /**
     * Generate configuration from DNA analysis
     *
     * @param {Object} dna - DNA analysis result
     * @param {Object} [options] - Generation options
     * @param {Uint8ClampedArray} [options.imageData] - RGBA data for entropy calculation
     * @param {number} [options.width] - Image width
     * @param {number} [options.height] - Image height
     * @param {string} [options.preprocessingIntensity='auto'] - 'off', 'auto', 'light', 'heavy'
     * @returns {Object} Complete configuration including ALL tunable parameters
     */
    static generate(dna, options = {}) {
        // ================================================================
        // 0. TRY ARCHETYPE-BASED GENERATION (New System)
        // ================================================================
        const archetypes = this.loadArchetypes();

        if (archetypes) {
            // Use archetype baseline + dynamic morphing approach
            return this.generateFromArchetypes(dna, archetypes, options);
        }

        // ================================================================
        // FALLBACK: Legacy hardcoded generation
        // ================================================================
        console.log('ℹ️  Using legacy parameter generation (archetypes not found)');

        // ================================================================
        // 1. CLASSIFY ARCHETYPE
        // ================================================================
        let archetype = this.getArchetype(dna);

        // ================================================================
        // 2. DERIVE FLAGS FROM DNA
        // ================================================================
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 50;
        const meanL = dna.l || 50;
        const meanC = dna.c || 20;
        const peakChroma = dna.maxC || 0;
        const bitDepth = dna.bitDepth || 8;
        const lowChromaDensity = dna.lowChromaDensity || 0;  // % of pixels with C < 15
        const k = dna.k || 0;

        // ================================================================
        // MAX CHROMA OVERRIDE: Force vibrant_tonal for extreme chroma spikes
        // Even if average C is low, peak chroma > 120 indicates neon/yellow spikes
        // ================================================================
        if (peakChroma > 120 && k > 80) {
            console.log(`⚡ Max Chroma Override: maxC=${peakChroma.toFixed(1)}, K=${k.toFixed(1)} → Vibrant Tonal (was: ${archetype})`);
            archetype = 'Vibrant Tonal';
        }

        // Derived classification flags
        const isPhoto = archetype === 'Photographic' || (l_std_dev > 25 && meanC > 15 && meanC < 50);
        const isGraphic = archetype === 'Vector/Flat' || l_std_dev < 15;
        const isArchive = bitDepth === 16 && meanC < 30 && l_std_dev > 20;  // 16-bit + muted + detailed
        const isNoir = archetype === 'Noir/Mono' || (meanC < 10 && dna.k > 60);
        const isVibrant = archetype === 'Neon/Vibrant' || archetype === 'Vibrant Tonal' || meanC > 60;

        // ================================================================
        // 3. SALIENCY WEIGHTS (lWeight, cWeight)
        // ================================================================
        let lWeight = 1.1;  // Default balanced
        let cWeight = 2.0;  // Default balanced

        if (isPhoto) {
            lWeight = 1.4;  // Photos: favor brighter pixels for skin tones
            cWeight = 2.0;
        } else if (isGraphic) {
            lWeight = 1.1;  // Graphics: balanced
            cWeight = 1.8;
        } else if (isArchive) {
            lWeight = 1.2;
            cWeight = 2.3;  // Archives: protect subtle chroma variations
        } else if (isNoir) {
            lWeight = 1.5;  // Noir: strong L priority for tonal separation
            cWeight = 1.2;
        }

        // ================================================================
        // 4. VIBRANCY SETTINGS
        // ================================================================
        // Vibrancy modes:
        // - 'aggressive': Multiplies a* by 1.6× during averaging (protects reds from pink dilution)
        // - 'exponential': Transforms chroma^(1/boost) in scoring (rescues low-chroma colors)
        // - 'linear': No transformation (already vibrant images)
        let vibrancyMode = 'aggressive';  // Default
        let vibrancyBoost = 1.6;

        // HIGH PEAK CHROMA OVERRIDE: If image has vibrant color spikes (maxC > 80),
        // use aggressive mode to protect those colors from being averaged away.
        // This is critical for Minkler-style graphics with bold primaries.
        if (peakChroma > 80) {
            // Vibrant spikes need aggressive a* protection
            vibrancyMode = 'aggressive';
            vibrancyBoost = isArchive ? 2.2 : 1.8;  // Archives get stronger boost
            // CHROMA PRIORITY: Boost cWeight to 2.8 so saturated reds beat pale pinks
            // The higher cWeight ensures vibrant colors "win" the centroid vote
            cWeight = 2.8;
        } else if (lowChromaDensity > 0.6 || isArchive) {
            // Truly muted images (no vibrant spikes): exponential boost to rescue color
            vibrancyMode = 'exponential';
            vibrancyBoost = 2.2;
        } else if (isVibrant) {
            // Already vibrant: gentle linear
            vibrancyMode = 'linear';
            vibrancyBoost = 1.2;
        } else if (meanC < 15) {
            // Low chroma: stronger boost
            vibrancyBoost = 2.0;
        }

        // ================================================================
        // 5. HIGHLIGHT SETTINGS
        // ================================================================
        let highlightThreshold = 85;
        let highlightBoost = 2.2;

        if (isPhoto) {
            highlightThreshold = 85;  // Photos: protect facial highlights
            highlightBoost = 1.8;
        } else if (isGraphic) {
            highlightThreshold = 90;  // Graphics: only extreme whites
            highlightBoost = 2.2;
        } else if (isNoir) {
            highlightThreshold = 80;  // Noir: protect more highlights
            highlightBoost = 3.0;
        }

        // ================================================================
        // 6. DISTANCE METRIC SELECTION
        // ================================================================
        let distanceMetric;
        if (bitDepth === 16) {
            distanceMetric = 'cie2000';  // 16-bit: museum grade precision
        } else if (isGraphic) {
            distanceMetric = 'cie76';    // Graphics: fast, sufficient
        } else if (peakChroma > 80 || isPhoto) {
            distanceMetric = 'cie94';    // Saturated/Photos: perceptual
        } else {
            distanceMetric = 'cie76';    // Default: fast
        }

        // ================================================================
        // 7. PALETTE REDUCTION THRESHOLD
        // ================================================================
        let paletteReduction = 10.0;  // Default ΔE threshold

        if (isArchive) {
            paletteReduction = 6.5;   // Archives: preserve subtle differences
        } else if (isGraphic) {
            paletteReduction = 12.0;  // Graphics: merge more aggressively
        } else if (isPhoto) {
            paletteReduction = 8.0;   // Photos: moderate
        }

        // ================================================================
        // 8. SUBSTRATE MODE (based on mean lightness)
        // ================================================================
        let substrateMode = 'auto';

        if (meanL < 30) {
            substrateMode = 'black';  // Dark image: likely black substrate
        } else if (meanL > 70) {
            substrateMode = 'white';  // Light image: white paper
        }

        // ================================================================
        // 9. BLACK BIAS (halftone protection)
        // ================================================================
        const strategy = this.getStrategy(archetype, dna);
        let blackBias = strategy.bias;

        // Override based on meanL
        if (meanL < 40) {
            blackBias = Math.max(blackBias, 8.0);  // Dark images need strong protection
        } else if (meanL > 60) {
            blackBias = Math.min(blackBias, 3.0);  // Light images: relax
        }

        // ================================================================
        // 10. DITHER TYPE
        // ================================================================
        let ditherType = strategy.dither;

        // Override based on archetype
        if (isPhoto && ditherType === 'atkinson') {
            ditherType = 'blue-noise';  // Photos need smooth gradients
        } else if (isGraphic && peakChroma < 40) {
            ditherType = 'none';  // Flat graphics: no dither needed
        }

        // ================================================================
        // 11. COLOR COUNT LOGIC (The "Chroma Driver")
        // ================================================================
        let idealColors = isPhoto ? 10 : 8;  // Photos start at 10 for better gradation
        if (meanC > 20) idealColors = 10;
        if (meanC > 50) idealColors = 12;

        // Saliency Rescue: Hidden color spike in muted image
        if (meanC < 12 && peakChroma > 80) {
            console.log(`🚑 Saliency Rescue: ${dna.filename || 'unknown'} (High Value Spike)`);
            idealColors = 10;
        }

        const finalColors = Math.max(4, Math.min(idealColors, 12));

        // ================================================================
        // 12. PREPROCESSING CONFIGURATION
        // ================================================================
        const preprocessingIntensity = options.preprocessingIntensity || 'auto';
        const preprocessing = BilateralFilter.createPreprocessingConfig(
            { ...dna, archetype },
            options.imageData || null,
            options.width || 0,
            options.height || 0,
            preprocessingIntensity
        );

        if (preprocessing.enabled) {
            console.log(`🔧 Preprocessing: ${preprocessing.intensity} (${preprocessing.reason})`);
        }

        // ================================================================
        // LOG CONFIGURATION
        // ================================================================
        console.log(`🧬 DNA: StdDev=${l_std_dev.toFixed(1)} C=${meanC.toFixed(1)} peakC=${peakChroma.toFixed(1)} -> Archetype: ${archetype}, Metric: ${distanceMetric}`);

        // ================================================================
        // RETURN COMPLETE CONFIGURATION
        // ================================================================
        return {
            // Identity
            id: `auto_${archetype.toLowerCase().replace('/', '_')}`,
            name: "Dynamic Bespoke",

            // Core posterization
            targetColors: finalColors,
            ditherType: ditherType,
            distanceMetric: distanceMetric,

            // Saliency weights
            lWeight: lWeight,
            cWeight: cWeight,
            blackBias: blackBias,

            // Vibrancy
            vibrancyMode: vibrancyMode,
            vibrancyBoost: vibrancyBoost,
            saturationBoost: vibrancyBoost,  // Legacy alias

            // Highlights
            highlightThreshold: highlightThreshold,
            highlightBoost: highlightBoost,

            // Color merging
            paletteReduction: paletteReduction,

            // Substrate
            substrateMode: substrateMode,

            // Legacy fields
            rangeClamp: [dna.minL, dna.maxL],

            // Metadata
            meta: {
                archetype,
                peakChroma,
                isPhoto,
                isGraphic,
                isArchive,
                bitDepth
            },

            // Preprocessing
            preprocessing
        };
    }

    /**
     * THE ARCHETYPE CLASSIFIER
     * Based on Tonal Variation (StdDev) and Chroma Intensity
     */
    static getArchetype(dna) {
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 50;
        const c = dna.c || 0;
        const k = dna.k || 0;

        // 1. VECTOR / FLAT
        // Extremely low variation. Flat fields of color.
        // Captures Logos, Text, Icons.
        if (l_std_dev < 15) {
            return 'Vector/Flat';
        }

        // 2. VINTAGE / MUTED
        // Discrete Ink Layers (Low Variation) + Muted Palette (Mod Chroma).
        // Captures WPA Posters, Lithographs.
        if (l_std_dev < 25 && c < 45) {
            return 'Vintage/Muted';
        }

        // 3. NOIR / MONO
        // High Contrast, Low Chroma.
        // Captures Black & White photography or Woodcuts.
        if (c < 10 && k > 60) {
            return 'Noir/Mono';
        }

        // 4. NEON / VIBRANT
        // High Variation (Complex) + Extreme Chroma.
        // Captures Pop Art, Neon Signs, Saturated Photos.
        if (c > 60) {
            return 'Neon/Vibrant';
        }

        // 5. PHOTOGRAPHIC (The Catch-All)
        // High Variation + Moderate Chroma.
        // Natural lighting, continuous tones.
        return 'Photographic';
    }

    /**
     * STRATEGY MAPPER
     * Assigns the correct Dither and Bias to each Archetype
     *
     * Note: Distance metric is now determined at generate() level using:
     *   peakChroma > 80 OR isPhotographic → CIE94, else CIE76
     */
    static getStrategy(archetype, dna) {
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 50;

        switch (archetype) {
            case 'Vector/Flat':
                return {
                    dither: 'atkinson',      // Crisp edges
                    bias: 1.0                // Precision (Don't bias blacks heavily)
                };

            case 'Vintage/Muted':
                return {
                    dither: 'atkinson',      // Retain the "Cut Paper" look
                    bias: 3.0                // Smooth out paper grain in solids
                };

            case 'Noir/Mono':
                return {
                    dither: 'blue-noise',    // Smooth shadow gradients
                    bias: 5.0                // Protect deep blacks at all costs
                };

            case 'Neon/Vibrant':
                return {
                    dither: 'blue-noise',    // Smooth gradients needed for neon glows
                    bias: 2.0
                };

            case 'Vibrant Tonal':
                return {
                    dither: 'blue-noise',    // Smooth gradients for chroma spikes
                    bias: 4.0                // Protect chroma spikes from halftone loss
                };

            case 'Photographic':
            default:
                // Check for "Texture Rescue" (Heavy Grain)
                if (l_std_dev > 45) {
                    return { dither: 'blue-noise', bias: 5.0 };
                }
                return {
                    dither: 'blue-noise',    // Standard Photo setting
                    bias: 2.0
                };
        }
    }
}

module.exports = DynamicConfigurator;
