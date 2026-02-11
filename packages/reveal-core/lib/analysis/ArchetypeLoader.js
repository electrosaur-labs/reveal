/**
 * ArchetypeLoader.js
 * Loads and matches archetype definitions from JSON files
 *
 * Works in both Node.js (batch processing) and browser/UXP (Adobe plugin) environments
 * Supports both DNA v1.0 (4D) and DNA v2.0 (7D + 12-sector hue analysis)
 *
 * Discovery: Both environments auto-discover all *.json files in archetypes/.
 * - Node.js: fs.readdirSync at runtime
 * - Webpack/UXP: require.context() resolved at build time
 */

const ArchetypeMapper = require('./ArchetypeMapper');

// Conditional imports for Node.js environment only
// Note: webpack fallback { fs: false } provides an empty object {}, not false,
// so we must check for actual functionality, not just truthiness.
let fs, path;
try {
    fs = require('fs');
    path = require('path');
    if (typeof fs.readdirSync !== 'function') fs = null;
    if (typeof path.join !== 'function') path = null;
} catch (e) {
    // Browser/UXP environment - fs/path not available
    fs = null;
    path = null;
}

// Webpack: auto-discover all archetype JSON files at build time
// require.context(directory, useSubdirs, regExp) — excludes schema.json
let archetypeContext;
try {
    archetypeContext = require.context('../../archetypes', false, /^\.\/(?!schema\b).*\.json$/);
} catch (e) {
    // Node.js: require.context not available (webpack-only API)
    archetypeContext = null;
}

const DEFAULT_WEIGHTS = { l: 0.5, c: 1.5, k: 1.0, l_std_dev: 2.0 };

class ArchetypeLoader {
    static archetypes = null;

    /**
     * Ensure archetype has default weights for DNA v1.0 backward compatibility
     */
    static _applyDefaults(archetype) {
        if (!archetype.weights) {
            archetype.weights = { ...DEFAULT_WEIGHTS };
        }
        return archetype;
    }

    /**
     * Load all archetype JSON files
     * @returns {Array} Array of archetype objects sorted alphabetically by ID
     */
    static loadArchetypes() {
        if (this.archetypes) {
            return this.archetypes;
        }

        if (fs && path) {
            // Node.js: scan archetypes directory at runtime
            const archetypesDir = path.join(__dirname, '../../archetypes');

            if (!fs.existsSync(archetypesDir)) {
                console.warn(`⚠️ Archetypes directory not found: ${archetypesDir}`);
                return this.getFallbackArchetype();
            }

            const files = fs.readdirSync(archetypesDir)
                .filter(f => f.endsWith('.json') && f !== 'schema.json');

            this.archetypes = files.map(file => {
                const content = fs.readFileSync(path.join(archetypesDir, file), 'utf8');
                return this._applyDefaults(JSON.parse(content));
            });
        } else if (archetypeContext) {
            // Webpack/UXP: use require.context (resolved at build time)
            this.archetypes = archetypeContext.keys().map(key =>
                this._applyDefaults(archetypeContext(key))
            );
        } else {
            console.warn('⚠️ No archetype discovery method available, using fallback');
            return [this.getFallbackArchetype()];
        }

        // Sort alphabetically by ID for deterministic ordering
        this.archetypes.sort((a, b) => a.id.localeCompare(b.id));

        console.log(`✓ Loaded ${this.archetypes.length} archetypes` +
            (fs ? ` from ${path.join(__dirname, '../../archetypes')}` : ' (bundled)'));

        return this.archetypes;
    }

    /**
     * Match DNA to nearest archetype
     * Supports both DNA v1.0 (4D: L/C/K/σL) and DNA v2.0 (7D + 12-sector hue analysis)
     * @param {Object} dna - DNA object (v1.0 or v2.0)
     * @param {string} [manualArchetypeId] - Optional manual archetype ID to bypass DNA matching
     * @returns {Object} Matched archetype
     */
    static matchArchetype(dna, manualArchetypeId = null) {
        const archetypes = this.loadArchetypes();

        if (archetypes.length === 0) {
            console.warn('⚠️ No archetypes loaded, using fallback');
            return this.getFallbackArchetype();
        }

        // MANUAL SELECTION BYPASS: If user explicitly selected an archetype, skip DNA matching
        if (manualArchetypeId) {
            const manualArchetype = archetypes.find(a => a.id === manualArchetypeId);
            if (manualArchetype) {
                console.log(`🛑 DNA Matcher Bypassed. Loading Sovereign Static Settings.`);
                console.log(`   User-selected archetype: ${manualArchetype.name}`);
                console.log(`   Parameters locked: ${manualArchetype.parameters?.distanceMetric}, ` +
                           `cWeight=${manualArchetype.parameters?.cWeight}, ` +
                           `vibrancyBoost=${manualArchetype.parameters?.vibrancyBoost}`);
                return manualArchetype;
            } else {
                console.warn(`⚠️ Manual archetype not found: ${manualArchetypeId}, falling back to DNA matching`);
            }
        }

        // Detect DNA version
        const isDnaV2 = dna.version === '2.0' && dna.global && dna.sectors;

        if (isDnaV2) {
            // DNA v2.0: Use sophisticated multi-factor scoring
            return this._matchDnaV2(dna, archetypes);
        } else {
            // DNA v1.0: Use legacy 4D weighted Euclidean distance
            return this._matchDnaV1(dna, archetypes);
        }
    }

    /**
     * Match DNA v2.0 using ArchetypeMapper (40/45/15 scoring)
     * @private
     */
    static _matchDnaV2(dna, archetypes) {
        const mapper = new ArchetypeMapper(archetypes);
        const allMatches = mapper.getTopMatches(dna, archetypes.length);
        const result = allMatches[0];

        const archetype = archetypes.find(a => a.id === result.id);

        // Enhanced logging for DNA v2.0
        console.log(`🎯 Matched archetype: ${archetype.name} (score: ${result.score})`);
        console.log(`   DNA v2.0 Breakdown:`);
        console.log(`   • Structural:     ${result.breakdown.structural.toFixed(1)}/100 (40% weight)`);
        console.log(`   • Sector Affinity: ${result.breakdown.sectorAffinity.toFixed(1)}/100 (45% weight)`);
        console.log(`   • Pattern Match:   ${result.breakdown.pattern.toFixed(1)}/100 (15% weight)`);
        console.log(`   DNA Signature: L=${dna.global.l.toFixed(1)} C=${dna.global.c.toFixed(1)} ` +
                    `K=${dna.global.k.toFixed(1)} σL=${dna.global.l_std_dev.toFixed(1)}`);
        console.log(`   Entropy=${dna.global.hue_entropy.toFixed(3)} ` +
                    `Temp=${dna.global.temperature_bias.toFixed(2)} ` +
                    `Dominant=${dna.dominant_sector || 'none'}`);

        // Attach matching details to archetype for validation JSON
        archetype.matchScore = result.score;
        archetype.matchBreakdown = result.breakdown;
        archetype.matchVersion = '2.0';
        archetype.matchRanking = allMatches;

        return archetype;
    }

    /**
     * Match DNA v1.0 using legacy 4D weighted Euclidean distance
     * @private
     */
    static _matchDnaV1(dna, archetypes) {
        const l = dna.l || 50;
        const c = dna.c || 20;
        const k = dna.k || 50;
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 25;

        let bestMatch = null;
        let minDistance = Infinity;

        for (const archetype of archetypes) {
            const centroid = archetype.centroid;
            const weights = archetype.weights;

            // 4D weighted Euclidean distance
            const dSquared =
                weights.l * Math.pow(l - centroid.l, 2) +
                weights.c * Math.pow(c - centroid.c, 2) +
                weights.k * Math.pow(k - centroid.k, 2) +
                weights.l_std_dev * Math.pow(l_std_dev - centroid.l_std_dev, 2);

            const distance = Math.sqrt(dSquared);

            if (distance < minDistance) {
                minDistance = distance;
                bestMatch = archetype;
            }
        }

        console.log(`🎯 Matched archetype: ${bestMatch.name} (DNA v1.0, distance: ${minDistance.toFixed(2)})`);

        // Attach matching details to archetype for validation JSON
        bestMatch.matchDistance = minDistance;
        bestMatch.matchVersion = '1.0';

        return bestMatch;
    }

    /**
     * Fallback archetype if JSON files not available
     */
    static getFallbackArchetype() {
        return {
            id: 'standard_balanced',
            name: 'Standard Balanced',
            description: 'Fallback archetype',
            centroid: { l: 50, c: 25, k: 50, l_std_dev: 25 },
            weights: { l: 0.5, c: 1.5, k: 1.0, l_std_dev: 2.0 },
            parameters: {
                targetColorsSlider: 10,
                ditherType: 'blue-noise',
                distanceMetric: 'cie76',
                lWeight: 1.2,
                cWeight: 2.0,
                blackBias: 3.0,
                vibrancyMode: 'moderate',
                vibrancyBoost: 1.4,
                highlightThreshold: 90,
                highlightBoost: 1.5,
                enablePaletteReduction: true,
                paletteReduction: 6.0,
                substrateMode: 'auto',
                substrateTolerance: 2.0,
                shadowPoint: 15,
                enableHueGapAnalysis: true,
                hueLockAngle: 20,
                colorMode: 'color',
                preserveWhite: true,
                preserveBlack: true,
                ignoreTransparent: true,
                maskProfile: 'Gray Gamma 2.2',
                neutralCentroidClampThreshold: 0.5,
                preprocessingIntensity: 'auto'
            }
        };
    }

    /**
     * Clear cached archetypes (for testing)
     */
    static clearCache() {
        this.archetypes = null;
    }
}

module.exports = ArchetypeLoader;
