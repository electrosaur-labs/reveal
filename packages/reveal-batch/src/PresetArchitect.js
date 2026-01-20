/**
 * PresetArchitect.js
 * Reads Image Passports -> Clusters Data -> Generates Optimized Presets
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

// CONFIG
const PASSPORT_DIR = path.join(__dirname, '../data/CQ100_v4/input/psd'); // Where your .json files are
const TARGET_CLUSTERS = 5; // We want to force 5 distinct archetypes

class PresetArchitect {
    static run() {
        // 1. Ingest Data
        const points = this.loadPassports();
        console.log(chalk.bold(`\n🧠 Architecting Presets from ${points.length} passports...`));

        // 2. Perform Clustering (K-Means)
        const clusters = this.kMeans(points, TARGET_CLUSTERS);

        // 3. Generate Preset Definitions
        console.log(chalk.bold('\n✨ DISCOVERED ARCHETYPES & GENERATING CONFIG:'));

        const newPresets = {};

        clusters.forEach((cluster, idx) => {
            if (cluster.points.length === 0) return;

            // Calculate Centroid Stats
            const avgL = this.mean(cluster.points.map(p => p.l));
            const avgC = this.mean(cluster.points.map(p => p.c));
            const avgContrast = this.mean(cluster.points.map(p => p.contrast));

            // Derive Name & Strategy
            const archetype = this.nameArchetype(avgL, avgC, avgContrast);
            const config = this.generateConfig(archetype, avgL, avgC, avgContrast);

            console.log(chalk.cyan(`\n🔹 Cluster ${idx + 1}: "${archetype.name}" (${cluster.points.length} images)`));
            console.log(`   Centroid: L=${avgL.toFixed(1)}, C=${avgC.toFixed(1)}, Contrast=${avgContrast.toFixed(1)}`);
            console.log(`   Distance to ideal: ${archetype.confidence.toFixed(1)}`);
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

        // 4. Output Code
        const outputPath = path.join(__dirname, '../NewPresets.js');
        const code = `export const PRESETS = ${JSON.stringify(newPresets, null, 4)};`;
        fs.writeFileSync(outputPath, code);
        console.log(chalk.green(`\n✅ Generated '${outputPath}'. Copy this to your source.`));
    }

    // --- LOGIC CORE ---

    static loadPassports() {
        const files = fs.readdirSync(PASSPORT_DIR).filter(f => f.endsWith('.json'));
        return files.map(f => {
            const data = JSON.parse(fs.readFileSync(path.join(PASSPORT_DIR, f)));
            return {
                file: data.meta.filename,
                l: data.physical_dna.lightness.avg,
                c: data.physical_dna.chroma.avg,
                contrast: data.physical_dna.lightness.contrast_std_dev
            };
        });
    }

    // Simple K-Means implementation
    static kMeans(points, k) {
        // Init centroids randomly
        let centroids = points.slice(0, k).map(p => ({ ...p }));
        let clusters = Array(k).fill(0).map(() => ({ points: [], centroid: {} }));
        let iterations = 10;

        while (iterations--) {
            // Reset clusters
            clusters = clusters.map(c => ({ points: [], centroid: c.centroid }));

            // Assign points
            points.forEach(p => {
                let minDist = Infinity;
                let clusterIdx = 0;
                centroids.forEach((c, idx) => {
                    const dist = Math.sqrt(
                        Math.pow(p.l - c.l, 2) +
                        Math.pow(p.c - c.c, 2) +
                        Math.pow(p.contrast - c.contrast, 2)
                    );
                    if (dist < minDist) {
                        minDist = dist;
                        clusterIdx = idx;
                    }
                });
                clusters[clusterIdx].points.push(p);
            });

            // Recompute centroids
            centroids = clusters.map((cluster, idx) => {
                if (cluster.points.length === 0) return centroids[idx];
                return {
                    l: this.mean(cluster.points.map(p => p.l)),
                    c: this.mean(cluster.points.map(p => p.c)),
                    contrast: this.mean(cluster.points.map(p => p.contrast))
                };
            });
        }
        return clusters;
    }

    // Naming Logic based on Distance to Ideal Archetypes
    static nameArchetype(l, c, contrast) {

        // 1. Define the "Platonic Ideals" of our Presets
        // These are the center-points of the styles we *want* to find.
        const ARCHETYPES = [
            { id: "noir_shadow",       name: "Deep Shadow / Noir",    target: { l: 25, c: 10, k: 20 } }, // Dark, low color, high contrast
            { id: "muted_vintage",     name: "Muted / Vintage",       target: { l: 60, c: 10, k: 8  } }, // Mid-bright, grey, flat
            { id: "pastel_high_key",   name: "Pastel / High-Key",     target: { l: 85, c: 20, k: 10 } }, // Very bright, soft
            { id: "vibrant_hyper",     name: "Vibrant / Graphic",     target: { l: 50, c: 60, k: 25 } }, // Colorful!
            { id: "hard_commercial",   name: "Punchy / Commercial",   target: { l: 50, c: 30, k: 25 } }, // Standard but high contrast
            { id: "soft_ethereal",     name: "Soft / Ethereal",       target: { l: 65, c: 20, k: 8  } }, // Standard but low contrast
            { id: "cinematic_moody",   name: "Cinematic / Moody",     target: { l: 40, c: 25, k: 18 } }, // Darker standard, good color
            { id: "standard_balanced", name: "Standard / Balanced",   target: { l: 50, c: 25, k: 15 } }  // The dead center
        ];

        // 2. Find the Closest Match (Euclidean Distance)
        let bestMatch = null;
        let minDistance = Infinity;

        ARCHETYPES.forEach(arch => {
            // Weighted Distance: We care more about Chroma (c) and Contrast (k) distinguishing styles
            // than pure Lightness (l), so we weight them slightly higher.
            const dL = (l - arch.target.l) * 1.0;
            const dC = (c - arch.target.c) * 1.5; // Color drives style perception
            const dK = (contrast - arch.target.k) * 2.0; // Contrast defines "Vibe" (Soft vs Hard)

            const dist = Math.sqrt(dL*dL + dC*dC + dK*dK);

            if (dist < minDistance) {
                minDistance = dist;
                bestMatch = arch;
            }
        });

        // 3. Return the identity (with distance for debugging)
        return {
            id: bestMatch.id,
            name: bestMatch.name,
            confidence: minDistance
        };
    }

    // The Magic: Translating DNA to Engine Parameters
    static generateConfig(archetype, l, c, contrast) {
        const config = {
            id: archetype.id,
            name: archetype.name,
            targetColors: 8,
            blackBias: 2.0,
            saturationBoost: 1.0,
            rangeClamp: [0, 100],
            ditherType: 'BlueNoise' // Default safe choice
        };

        // Granular Tuning
        switch (archetype.id) {
            case 'hard_commercial':
                config.blackBias = 4.0;       // Deepen blacks for "Pop"
                config.saturationBoost = 1.1; // Slight boost
                config.ditherType = 'Atkinson'; // Sharper halftone look
                break;
            case 'soft_ethereal':
                config.blackBias = 1.5;       // Lift blacks
                config.rangeClamp = [5, 95];  // Soften extreme whites/blacks
                config.ditherType = 'BlueNoise';
                break;
            case 'cinematic_moody':
                config.blackBias = 5.0;       // Heavy shadows
                config.saturationBoost = 0.95; // Slightly desaturated
                break;
            case 'vibrant_hyper':
                config.saturationBoost = 1.25;
                config.ditherType = 'Bayer';  // Retro computer look matches vibrant
                break;
            case 'noir_shadow':
                config.blackBias = 8.0;       // Aggressive black
                config.targetColors = 6;      // Noir works better with fewer colors
                break;
            case 'pastel_high_key':
                config.blackBias = 1.0;       // Allow light greys
                config.saturationBoost = 1.2; // Pop the weak colors
                break;
            case 'muted_vintage':
                config.saturationBoost = 0.9; // Lean into the fade
                config.ditherType = 'BlueNoise'; // Smooth gradients
                break;
            // standard_balanced keeps defaults
        }

        return config;
    }

    static mean(arr) { return arr.reduce((a, b) => a + b, 0) / (arr.length || 1); }
}

PresetArchitect.run();
