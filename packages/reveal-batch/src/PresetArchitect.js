/**
 * PresetArchitect.js
 * Reads Image Passports -> Clusters Data -> Generates Optimized Presets
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

// CONFIG
const PASSPORT_DIR = path.join(__dirname, '../data/CQ100_v4/output/8bit/preprocessed'); // Where your .json passport files are
const ARCHETYPE_DIR = path.join(__dirname, '../../reveal-core/archetypes');
const TARGET_CLUSTERS = 5; // We want to force 5 distinct archetypes

class PresetArchitect {
    /**
     * Load all archetype definitions from JSON files
     */
    static loadArchetypes() {
        const files = fs.readdirSync(ARCHETYPE_DIR).filter(f => f.endsWith('.json'));
        const archetypes = [];

        for (const file of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(ARCHETYPE_DIR, file), 'utf-8'));

                // Validate required fields
                if (!data.id || !data.name || !data.centroid || !data.parameters) {
                    console.warn(chalk.yellow(`⚠️  Skipping ${file}: missing required fields`));
                    continue;
                }

                // Set default weights if not specified
                data.weights = data.weights || { l: 1.0, c: 1.5, k: 2.0, l_std_dev: 1.0 };

                archetypes.push(data);
            } catch (err) {
                console.error(chalk.red(`❌ Failed to load ${file}: ${err.message}`));
            }
        }

        console.log(chalk.green(`✓ Loaded ${archetypes.length} archetypes from ${ARCHETYPE_DIR}`));
        return archetypes;
    }

    static run() {
        // 1. Load archetypes from JSON
        const ARCHETYPES = this.loadArchetypes();

        if (ARCHETYPES.length === 0) {
            console.error(chalk.red('❌ No archetypes loaded! Cannot proceed.'));
            process.exit(1);
        }

        // 2. Ingest passport data
        const points = this.loadPassports();
        console.log(chalk.bold(`\n🧠 Architecting Presets from ${points.length} passports...`));

        // 3. Perform Clustering (K-Means)
        const clusters = this.kMeans(points, TARGET_CLUSTERS);

        // 4. Generate Preset Definitions
        console.log(chalk.bold('\n✨ DISCOVERED ARCHETYPES & GENERATING CONFIG:'));

        const newPresets = {};

        clusters.forEach((cluster, idx) => {
            if (cluster.points.length === 0) return;

            // Calculate 4D Centroid (DNA average)
            const clusterDNA = {
                l: this.mean(cluster.points.map(p => p.l)),
                c: this.mean(cluster.points.map(p => p.c)),
                k: this.mean(cluster.points.map(p => p.k)),
                l_std_dev: this.mean(cluster.points.map(p => p.l_std_dev))
            };

            // Match to closest archetype using 4D distance
            const archetype = this.nameArchetype(clusterDNA, ARCHETYPES);
            const config = this.generateConfig(archetype, clusterDNA);

            console.log(chalk.cyan(`\n🔹 Cluster ${idx + 1}: "${archetype.name}" (${cluster.points.length} images)`));
            console.log(`   Centroid: L=${clusterDNA.l.toFixed(1)}, C=${clusterDNA.c.toFixed(1)}, K=${clusterDNA.k.toFixed(1)}, σL=${clusterDNA.l_std_dev.toFixed(1)}`);
            console.log(`   Distance to archetype: ${archetype.confidence.toFixed(1)}`);
            console.log(`   Sample images: ${cluster.points.slice(0, 5).map(p => p.file).join(', ')}`);

            // Handle ID collisions by appending suffix
            let uniqueId = archetype.id;
            let counter = 2;
            while (newPresets[uniqueId]) {
                uniqueId = `${archetype.id}_${counter}`;
                console.log(chalk.yellow(`   ⚠️  Collision detected! Using ID: ${uniqueId}`));
                counter++;
            }

            // Update config with unique ID if needed
            if (uniqueId !== archetype.id) {
                config.id = uniqueId;
            }

            newPresets[uniqueId] = config;
        });

        // 5. Output Code
        const outputPath = path.join(__dirname, '../NewPresets.js');
        const code = `export const PRESETS = ${JSON.stringify(newPresets, null, 4)};`;
        fs.writeFileSync(outputPath, code);
        console.log(chalk.green(`\n✅ Generated '${outputPath}'. Copy this to your source.`));
    }

    // --- LOGIC CORE ---

    static loadPassports() {
        const files = fs.readdirSync(PASSPORT_DIR).filter(f => f.endsWith('.json') && f !== 'batch-report.json');
        return files.map(f => {
            const data = JSON.parse(fs.readFileSync(path.join(PASSPORT_DIR, f)));
            return {
                file: data.meta.filename,
                l: data.dna.l,
                c: data.dna.c,
                k: data.dna.k,
                l_std_dev: data.dna.l_std_dev
            };
        });
    }

    // Simple K-Means implementation (4D clustering)
    static kMeans(points, k) {
        // Init centroids randomly
        let centroids = points.slice(0, k).map(p => ({ ...p }));
        let clusters = Array(k).fill(0).map(() => ({ points: [], centroid: {} }));
        let iterations = 10;

        while (iterations--) {
            // Reset clusters
            clusters = clusters.map(c => ({ points: [], centroid: c.centroid }));

            // Assign points to nearest centroid (4D)
            points.forEach(p => {
                let minDist = Infinity;
                let clusterIdx = 0;
                centroids.forEach((c, idx) => {
                    const dist = Math.sqrt(
                        Math.pow(p.l - c.l, 2) +
                        Math.pow(p.c - c.c, 2) +
                        Math.pow(p.k - c.k, 2) +
                        Math.pow(p.l_std_dev - c.l_std_dev, 2)  // NEW: 4th dimension
                    );
                    if (dist < minDist) {
                        minDist = dist;
                        clusterIdx = idx;
                    }
                });
                clusters[clusterIdx].points.push(p);
            });

            // Recalculate centroids (4D mean)
            centroids = clusters.map((cluster, idx) => {
                if (cluster.points.length === 0) return centroids[idx];
                return {
                    l: this.mean(cluster.points.map(p => p.l)),
                    c: this.mean(cluster.points.map(p => p.c)),
                    k: this.mean(cluster.points.map(p => p.k)),
                    l_std_dev: this.mean(cluster.points.map(p => p.l_std_dev))
                };
            });
        }
        return clusters;
    }

    /**
     * Find the closest matching archetype using weighted Euclidean distance
     * Matches using 4D DNA: L (lightness), C (chroma), K (contrast), l_std_dev (flatness)
     *
     * @param {Object} imageDNA - { l, c, k, l_std_dev }
     * @param {Array} ARCHETYPES - Array of archetype definitions from JSON
     * @returns {Object} Best matching archetype with confidence score
     */
    static nameArchetype(imageDNA, ARCHETYPES) {
        let bestMatch = null;
        let minDistance = Infinity;

        ARCHETYPES.forEach(arch => {
            const centroid = arch.centroid;
            const weights = arch.weights;

            // Weighted Euclidean Distance in 4D space
            // Using squared distance for comparison (faster, equivalent ordering)
            const dSquared =
                weights.l * Math.pow(imageDNA.l - centroid.l, 2) +
                weights.c * Math.pow(imageDNA.c - centroid.c, 2) +
                weights.k * Math.pow(imageDNA.k - centroid.k, 2) +
                weights.l_std_dev * Math.pow(imageDNA.l_std_dev - centroid.l_std_dev, 2);

            const distance = Math.sqrt(dSquared);

            if (distance < minDistance) {
                minDistance = distance;
                bestMatch = arch;
            }
        });

        // Return archetype with confidence score
        return {
            ...bestMatch,  // Spread all archetype properties
            confidence: minDistance
        };
    }

    /**
     * Generate preset config from archetype
     * No more switch statement - parameters come from JSON!
     * @param {Object} archetype - Matched archetype from JSON
     * @param {Object} clusterDNA - Actual cluster centroid (for logging/debugging)
     */
    static generateConfig(archetype, clusterDNA) {
        return {
            id: archetype.id,
            name: archetype.name,
            description: archetype.description || '',
            ...archetype.parameters  // All parameters from JSON
        };
    }

    static mean(arr) { return arr.reduce((a, b) => a + b, 0) / (arr.length || 1); }
}

PresetArchitect.run();
