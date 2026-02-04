/**
 * ArchetypeLoader.js
 * Loads and matches archetype definitions from JSON files
 *
 * Works in both Node.js (batch processing) and browser/UXP (Adobe plugin) environments
 * Supports both DNA v1.0 (4D) and DNA v2.0 (7D + 12-sector hue analysis)
 */

const ArchetypeMapper = require('./ArchetypeMapper');

// Conditional imports for Node.js environment only
let fs, path;
try {
    fs = require('fs');
    path = require('path');
} catch (e) {
    // Browser/UXP environment - fs/path not available
    // Archetypes will be loaded from pre-imported JSON
}

class ArchetypeLoader {
    static archetypes = null;

    /**
     * Load all archetype JSON files
     * @returns {Array} Array of archetype objects
     */
    static loadArchetypes() {
        if (this.archetypes) {
            return this.archetypes;
        }

        // Check if running in Node.js environment
        if (fs && path) {
            // Node.js: Load from filesystem
            const archetypesDir = path.join(__dirname, '../../archetypes');

            if (!fs.existsSync(archetypesDir)) {
                console.warn(`⚠️ Archetypes directory not found: ${archetypesDir}`);
                return this.getBuiltInArchetypes();
            }

            const files = fs.readdirSync(archetypesDir)
                .filter(f => f.endsWith('.json') && f !== 'schema.json');

            this.archetypes = files.map(file => {
                const content = fs.readFileSync(path.join(archetypesDir, file), 'utf8');
                const archetype = JSON.parse(content);

                // Set default weights if not specified
                if (!archetype.weights) {
                    archetype.weights = {
                        l: 0.5,
                        c: 1.5,
                        k: 1.0,
                        l_std_dev: 2.0
                    };
                }

                return archetype;
            });

            console.log(`✓ Loaded ${this.archetypes.length} archetypes from ${archetypesDir}`);
        } else {
            // Browser/UXP: Use built-in archetypes
            this.archetypes = this.getBuiltInArchetypes();
            console.log(`✓ Loaded ${this.archetypes.length} built-in archetypes`);
        }

        return this.archetypes;
    }

    /**
     * Get built-in archetypes for browser/UXP environments
     * These are the core archetypes bundled with the code
     */
    static getBuiltInArchetypes() {
        // Import archetypes directly for browser/UXP builds
        return [
            require('../../archetypes/subtle-naturalist.json'),
            require('../../archetypes/structural-outlier-rescue.json'),
            require('../../archetypes/blue-rescue.json'),
            require('../../archetypes/silver-gelatin.json'),
            require('../../archetypes/neon-graphic.json'),
            require('../../archetypes/cinematic-moody.json'),
            require('../../archetypes/muted-vintage.json'),
            require('../../archetypes/pastel-high-key.json'),
            require('../../archetypes/noir-shadow.json'),
            require('../../archetypes/pure-graphic.json'),
            require('../../archetypes/vibrant-tonal.json'),
            require('../../archetypes/warm-tonal-optimized.json'),
            require('../../archetypes/thermonuclear-yellow.json')
        ].map(archetype => {
            // Set default weights if not specified (DNA v1.0 backward compatibility)
            if (!archetype.weights) {
                archetype.weights = {
                    l: 0.5,
                    c: 1.5,
                    k: 1.0,
                    l_std_dev: 2.0
                };
            }
            return archetype;
        });
    }

    /**
     * Match DNA to nearest archetype
     * Supports both DNA v1.0 (4D: L/C/K/σL) and DNA v2.0 (7D + 12-sector hue analysis)
     * @param {Object} dna - DNA object (v1.0 or v2.0)
     * @returns {Object} Matched archetype
     */
    static matchArchetype(dna) {
        const archetypes = this.loadArchetypes();

        if (archetypes.length === 0) {
            console.warn('⚠️ No archetypes loaded, using fallback');
            return this.getFallbackArchetype();
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
        const result = mapper.getBestMatch(dna);

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
