/**
 * Production Archetype Mapper v2.2
 * Implements the 40/45/15 scoring split:
 * - 40%: Structural DNA (L, C, K, L-StdDev)
 * - 45%: Sector Affinity (12-Sector Hue Weights/Chroma)
 * - 15%: Pattern/Signature (Entropy & Temperature)
 */
class ArchetypeMapper {
    constructor(archetypes) {
        this.archetypes = archetypes;
        this.decayConstant = 0.05; // Adjusts sensitivity of the decay curve

        // TODO: Move these profiles into the archetype JSON files (e.g. "scoring" section)
        // so they are auto-discovered with the archetype. _deriveProfile() handles
        // archetypes not listed here, but the hardcoded map diverges from the JSONs.
        this.ARCHETYPE_PROFILES = {
            'cool_recovery': {
                chromaProfile: 'moderate',  // cMax 20-50
                tonalRange: 'dark',          // lMean < 50
                expects_outlier: true        // Small weight but high chroma
            },
            'hot_yellow': {
                chromaProfile: 'extreme',    // cMax > 70
                tonalRange: 'bright',        // lMean > 55
                expects_dominance: true      // Single sector > 40%
            },
            'neon': {
                chromaProfile: 'extreme',    // cMax > 70
                tonalRange: 'bright',        // lMean > 50
                expects_flat: true           // Low l_std_dev
            },
            'dark_portrait': {
                chromaProfile: 'low',        // cMax < 30
                tonalRange: 'dark',          // lMean < 50
                expects_warm: true           // temperature_bias > 0.4
            },
            'cinematic': {
                chromaProfile: 'low',        // cMax < 30
                tonalRange: 'dark',          // lMean < 45
                expects_cool: true           // temperature_bias < 0
            },
            'faded_vintage': {
                chromaProfile: 'low',        // cMax < 25
                tonalRange: 'mid',           // lMean 50-65
                expects_warm: true           // temperature_bias > 0
            },
            'detail_recovery': {
                chromaProfile: 'very_low',   // cMax < 20
                tonalRange: 'mid-bright',    // lMean > 50
                expects_monochrome: true,    // hue_entropy < 0.3
                rewards_high_texture: true   // Boost for high-relief subjects (σL > 18)
            },
            'black_and_white': {
                chromaProfile: 'achromatic', // cMax < 5
                tonalRange: 'any',
                expects_monochrome: true     // hue_entropy < 0.1
            },
            'fine_art_scan': {
                chromaProfile: 'moderate',   // cMax 15-50
                tonalRange: 'mid',           // lMean 40-65
                expects_diversity: true      // hue_entropy > 0.6
            },
            'warm_photo': {
                chromaProfile: 'moderate',   // cMax 40-85
                tonalRange: 'mid',           // lMean 45-65
                expects_diversity: true      // hue_entropy > 0.7 (multi-hue subjects)
            },
            'full_spectrum': {
                chromaProfile: 'any',        // No chroma preference
                tonalRange: 'any',           // No tonal preference
                expects_high_entropy: true,  // hue_entropy > 0.85
                max_sector_gate: 0.25        // Hard gate: no sector can hold > 25%
            },
            'bold_poster': {
                chromaProfile: 'low',        // Poster inks on paper: avg cMax ~30
                tonalRange: 'mid-bright',    // lMean 50-70
                expects_warm: true,          // Most posters are warm-toned
                expects_dominance: true      // Poster color is concentrated (psw > 0.4)
            },
            'sunlit': {
                chromaProfile: 'low',        // cMax < 30
                tonalRange: 'mid-bright',    // lMean 50-70
                expects_warm: true,          // temperature_bias > 0.4
                max_l_std_dev_gate: 32.0     // Penalty for high-contrast posters (σL > 32)
            },
            'old_master': {
                chromaProfile: 'low',        // cMax < 30 (deep shadow palette)
                tonalRange: 'dark',          // lMean < 50
                expects_warm: true           // temperature_bias > 0.4
            },
            'painterly': {
                chromaProfile: 'moderate',   // cMax 20-50 (varied painterly chroma)
                tonalRange: 'mid-bright',    // lMean 50-70
                expects_diversity: true      // hue_entropy > 0.7
            }
        };
    }

    getBestMatch(dna) {
        // Pure scoring path — no override gates
        const results = this.archetypes.map(archetype => {
            const structuralScore = this.calculateStructuralScore(dna, archetype);
            const sectorScore = this.calculateSectorAffinity(dna, archetype);
            const patternScore = this.calculatePatternScore(dna, archetype);

            // Final Weighted Score (Normalized to 0-100)
            const totalScore = (structuralScore * 0.40) +
                               (sectorScore * 0.45) +
                               (patternScore * 0.15);

            return {
                id: archetype.id,
                score: parseFloat(totalScore.toFixed(2)),
                breakdown: {
                    structural: parseFloat(structuralScore.toFixed(1)),
                    sectorAffinity: parseFloat(sectorScore.toFixed(1)),
                    pattern: parseFloat(patternScore.toFixed(1))
                }
            };
        });

        return results.sort((a, b) => b.score - a.score)[0];
    }

    /**
     * Get top N archetype matches sorted by score descending.
     * Pure scoring — no override gates.
     *
     * @param {Object} dna - DNA v2.0 object
     * @param {number} [n=3] - Number of top matches to return
     * @returns {Array<{id, score, breakdown}>} Top N matches
     */
    getTopMatches(dna, n = 3) {
        const results = this.archetypes.map(archetype => {
            const structuralScore = this.calculateStructuralScore(dna, archetype);
            const sectorScore = this.calculateSectorAffinity(dna, archetype);
            const patternScore = this.calculatePatternScore(dna, archetype);

            const totalScore = (structuralScore * 0.40) +
                               (sectorScore * 0.45) +
                               (patternScore * 0.15);

            return {
                id: archetype.id,
                score: parseFloat(totalScore.toFixed(2)),
                breakdown: {
                    structural: parseFloat(structuralScore.toFixed(1)),
                    sectorAffinity: parseFloat(sectorScore.toFixed(1)),
                    pattern: parseFloat(patternScore.toFixed(1))
                }
            };
        });

        results.sort((a, b) => b.score - a.score);
        return results.slice(0, n);
    }

    // 40% Weight: Structural Distance (Weighted Euclidean)
    calculateStructuralScore(dna, archetype) {
        const dims = ['l', 'c', 'k', 'l_std_dev'];
        let distanceSq = 0;

        dims.forEach(dim => {
            const weight = archetype.weights?.[dim] || 1.0;
            const delta = dna.global[dim] - archetype.centroid[dim];
            distanceSq += weight * Math.pow(delta, 2);
        });

        const distance = Math.sqrt(distanceSq);
        // Exponential decay: converts distance (0 to ∞) to similarity (100 to 0)
        return 100 * Math.exp(-this.decayConstant * distance);
    }

    // 45% Weight: Sector Affinity Voting (Enhanced)
    calculateSectorAffinity(dna, archetype) {
        let affinity = 50; // Baseline
        const profile = this.ARCHETYPE_PROFILES[archetype.id]
            || this._deriveProfile(archetype);

        let totalWeight = 0;
        let weightedAffinity = 0;

        // Iterate through sectors and vote
        Object.keys(dna.sectors).forEach(sectorName => {
            const sector = dna.sectors[sectorName];
            let sectorAffinity = 50; // Neutral

            // Bonus for preferred sectors
            if (archetype.preferred_sectors?.includes(sectorName)) {
                sectorAffinity += 30;
            }

            // Chroma and tonal bonuses only apply to preferred sectors
            // (prevents non-target sectors from inflating scores)
            const isPreferred = archetype.preferred_sectors?.includes(sectorName);
            if (!archetype.preferred_sectors || isPreferred) {
                // Chroma alignment
                if (profile.chromaProfile === 'extreme' && sector.cMax > 70) {
                    sectorAffinity += 25;
                } else if (profile.chromaProfile === 'moderate' && sector.cMax >= 20 && sector.cMax <= 60) {
                    sectorAffinity += 15;
                } else if (profile.chromaProfile === 'low' && sector.cMax < 30) {
                    sectorAffinity += 15;
                } else if (profile.chromaProfile === 'very_low' && sector.cMax < 20) {
                    sectorAffinity += 20;
                } else if (profile.chromaProfile === 'achromatic' && sector.cMax < 5) {
                    sectorAffinity += 30;
                }

                // Lightness alignment
                if (profile.tonalRange === 'dark' && sector.lMean < 50) {
                    sectorAffinity += 10;
                } else if (profile.tonalRange === 'mid' && sector.lMean >= 40 && sector.lMean <= 65) {
                    sectorAffinity += 10;
                } else if (profile.tonalRange === 'mid-bright' && sector.lMean >= 50 && sector.lMean <= 70) {
                    sectorAffinity += 10;
                } else if (profile.tonalRange === 'bright' && sector.lMean > 55) {
                    sectorAffinity += 10;
                }
            }

            // Weighted voting (sectors with more pixels vote stronger)
            weightedAffinity += sectorAffinity * sector.weight;
            totalWeight += sector.weight;
        });

        // Calculate final affinity
        affinity = totalWeight > 0 ? weightedAffinity / totalWeight : 50;

        // Pattern-specific bonuses
        if (profile.expects_outlier) {
            // Blue outlier in warm image: small weight but high chroma
            const hasOutlier = Object.keys(dna.sectors).some(name => {
                const s = dna.sectors[name];
                return archetype.preferred_sectors?.includes(name) &&
                       s.weight < 0.15 && s.cMax > 40;
            });
            if (hasOutlier) affinity += 20;
        }

        if (profile.expects_dominance) {
            // Single sector dominates (> 40%) AND is a preferred sector
            const hasDominance = dna.global.primary_sector_weight > 0.4 &&
                archetype.preferred_sectors?.includes(dna.dominant_sector);
            if (hasDominance) affinity += 15;
        }

        if (profile.max_chroma_gate) {
            // Hard gate: penalize if global chroma exceeds threshold
            if (dna.global.c > profile.max_chroma_gate) {
                affinity -= 30; // Not desaturated enough
            } else {
                affinity += 20; // Bonus for truly low-chroma images
            }
        }

        if (profile.max_l_std_dev_gate) {
            // Penalty-only gate: block high-texture images from flat archetypes
            if (dna.global.l_std_dev > profile.max_l_std_dev_gate) {
                affinity -= 30; // Too much texture for flat archetype
            }
            // No bonus for passing — prevents poaching from other archetypes
        }

        if (profile.rewards_high_texture) {
            // Boost for high-relief subjects (sculptures, textured objects)
            if (dna.global.l_std_dev > 18.0) {
                affinity += 20;
            }
        }

        if (profile.max_sector_gate) {
            // Hard gate: penalize if ANY sector exceeds the max allowed weight
            if (dna.global.primary_sector_weight > profile.max_sector_gate) {
                affinity -= 30; // Strong penalty for sector-dominant images
            } else {
                affinity += 20; // Bonus for truly spread-thin images
            }
        }

        if (profile.expects_high_entropy) {
            // Bonus for very high entropy images (> 0.85)
            if (dna.global.hue_entropy > 0.85) {
                affinity += 25;
            } else if (dna.global.hue_entropy < 0.75) {
                affinity -= 20; // Hard penalty for low-entropy images
            }
        }

        return Math.max(0, Math.min(100, affinity));
    }

    // Fallback for archetypes without profiles
    _basicSectorAffinity(dna, archetype) {
        let affinity = 50;

        if (archetype.preferred_sectors) {
            Object.keys(dna.sectors).forEach(name => {
                const sector = dna.sectors[name];
                if (archetype.preferred_sectors.includes(name)) {
                    affinity += sector.weight * 100;
                }
            });
        }

        return Math.max(0, Math.min(100, affinity));
    }

    // 15% Weight: Pattern & Signature Match
    calculatePatternScore(dna, archetype) {
        let score = 50; // Baseline

        // Entropy matching
        const entropyDelta = Math.abs(dna.global.hue_entropy - archetype.centroid.hue_entropy);
        const entropyWeight = archetype.weights?.hue_entropy || 2.0;
        const entropyScore = 100 * Math.exp(-0.5 * entropyWeight * entropyDelta);

        // Temperature matching
        const tempDelta = Math.abs(dna.global.temperature_bias - archetype.centroid.temperature_bias);
        const tempWeight = archetype.weights?.temperature_bias || 1.5;
        const tempScore = 100 * Math.exp(-0.5 * tempWeight * tempDelta);

        // Primary sector weight matching
        const sectorWeightDelta = Math.abs(
            dna.global.primary_sector_weight - archetype.centroid.primary_sector_weight
        );
        const sectorWeightWeight = archetype.weights?.primary_sector_weight || 2.5;
        const sectorWeightScore = 100 * Math.exp(-0.5 * sectorWeightWeight * sectorWeightDelta);

        // Weighted average
        score = (entropyScore * 0.4) + (tempScore * 0.3) + (sectorWeightScore * 0.3);

        // Pattern bonuses
        const profile = this.ARCHETYPE_PROFILES[archetype.id]
            || this._deriveProfile(archetype);
        if (profile) {
            if (profile.expects_monochrome && dna.global.hue_entropy < 0.3) {
                score += 20;
            }
            if (profile.expects_diversity && dna.global.hue_entropy > 0.7) {
                score += 15;
            }
            if (profile.expects_warm && dna.global.temperature_bias > 0.4) {
                score += 10;
            }
            if (profile.expects_cool && dna.global.temperature_bias < -0.3) {
                score += 10;
            }
        }

        return Math.max(0, Math.min(100, score));
    }

    // Auto-derive profile flags from archetype centroid values
    _deriveProfile(archetype) {
        const c = archetype.centroid;
        const profile = {};

        // chromaProfile from centroid.c
        if (c.c < 5)        profile.chromaProfile = 'achromatic';
        else if (c.c < 15)  profile.chromaProfile = 'very_low';
        else if (c.c < 30)  profile.chromaProfile = 'low';
        else if (c.c < 60)  profile.chromaProfile = 'moderate';
        else                 profile.chromaProfile = 'extreme';

        // tonalRange from centroid.l
        if (c.l < 45)            profile.tonalRange = 'dark';
        else if (c.l < 55)       profile.tonalRange = 'mid';
        else if (c.l < 70)       profile.tonalRange = 'mid-bright';
        else                      profile.tonalRange = 'bright';

        // Boolean flags from centroid dimensions
        if (c.temperature_bias > 0.3)  profile.expects_warm = true;
        if (c.temperature_bias < -0.3) profile.expects_cool = true;
        if (c.hue_entropy < 0.3)       profile.expects_monochrome = true;
        if (c.hue_entropy > 0.7)       profile.expects_diversity = true;
        if (c.primary_sector_weight > 0.4) profile.expects_dominance = true;
        if (c.l_std_dev > 20)          profile.rewards_high_texture = true;

        // Derived gates (only for extreme centroids)
        if (c.l_std_dev < 12) profile.max_l_std_dev_gate = c.l_std_dev + 5;

        return profile;
    }
}

module.exports = ArchetypeMapper;
