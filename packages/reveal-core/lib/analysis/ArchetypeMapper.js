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

        // Archetype expectations for sector affinity scoring
        this.ARCHETYPE_PROFILES = {
            'blue_rescue': {
                chromaProfile: 'moderate',  // cMax 20-50
                tonalRange: 'dark',          // lMean < 50
                expects_outlier: true        // Small weight but high chroma
            },
            'warm_tonal_optimized': {
                chromaProfile: 'moderate',   // cMax 25-60
                tonalRange: 'mid-bright',    // lMean 50-70
                expects_diversity: false     // Focused on yellow/orange
            },
            'thermonuclear_yellow': {
                chromaProfile: 'extreme',    // cMax > 70
                tonalRange: 'bright',        // lMean > 55
                expects_dominance: true      // Single sector > 40%
            },
            'neon_graphic': {
                chromaProfile: 'extreme',    // cMax > 70
                tonalRange: 'bright',        // lMean > 50
                expects_flat: true           // Low l_std_dev
            },
            'cinematic_moody': {
                chromaProfile: 'low',        // cMax < 30
                tonalRange: 'dark',          // lMean < 45
                expects_cool: true           // temperature_bias < 0
            },
            'muted_vintage': {
                chromaProfile: 'low',        // cMax < 25
                tonalRange: 'mid',           // lMean 50-65
                expects_warm: true           // temperature_bias > 0
            },
            'structural_outlier_rescue': {
                chromaProfile: 'very_low',   // cMax < 20
                tonalRange: 'mid-bright',    // lMean > 50
                expects_monochrome: true     // hue_entropy < 0.3
            },
            'silver_gelatin': {
                chromaProfile: 'achromatic', // cMax < 5
                tonalRange: 'any',
                expects_monochrome: true     // hue_entropy < 0.1
            },
            'subtle_naturalist': {
                chromaProfile: 'moderate',   // cMax 15-50
                tonalRange: 'mid',           // lMean 40-65
                expects_diversity: true      // hue_entropy > 0.6
            }
        };
    }

    getBestMatch(dna) {
        // HIGH-CHROMA PRIORITY GATE: Clinical Graphic Override
        // Force Sovereign 10-Color Lock for images with extreme peak chroma.
        // Catches graphics with halftone backgrounds where average chroma is artificially
        // low due to neutral grays, but peak chroma reveals vibrant outliers.
        // Example: Jethro Monroe scan with maxC=91.3 but avgC=16.1 (gray halftone dilution)
        if (dna.maxC !== undefined && dna.maxC > 90.0) {
            const jethroArchetype = this.archetypes.find(a => a.id === 'jethro_monroe_clinical');
            if (jethroArchetype) {
                return {
                    id: jethroArchetype.id,
                    score: 95.0, // High confidence for override
                    breakdown: {
                        structural: 95.0,
                        sectorAffinity: 95.0,
                        pattern: 95.0
                    }
                };
            }
        }

        // PRODUCTION OVERRIDE: Blue Outlier Rescue (Horse/Sky Issue)
        // Force Blue Rescue if blue sector is significant but dominated by warm tones
        // CHROMA-AWARE GATING: Distinguish intentional blue (sky) from sensor noise (salt)
        const blueWeight = (dna.sectors?.blue?.weight || 0) +
                          (dna.sectors?.cyan?.weight || 0) +
                          (dna.sectors?.azure?.weight || 0);
        const dominantIsWarm = ['orange', 'yellow', 'red', 'chartreuse'].includes(dna.dominant_sector);

        // Clinical Fix: Check chroma to distinguish sky (high-chroma) from salt (low-chroma)
        const blueChroma = Math.max(
            dna.sectors?.blue?.cMax || 0,
            dna.sectors?.cyan?.cMax || 0,
            dna.sectors?.azure?.cMax || 0
        );
        const intentionalBlue = blueChroma > 25; // Noise is rarely this vibrant

        // Hybrid Gate: Require BOTH weight AND chroma
        const isBlueOutlier = blueWeight > 0.10 && dominantIsWarm && intentionalBlue;

        if (isBlueOutlier) {
            const blueRescue = this.archetypes.find(a => a.id === 'blue_rescue');
            if (blueRescue) {
                return {
                    id: blueRescue.id,
                    score: 90.0, // High confidence for override
                    breakdown: {
                        structural: 85.0,
                        sectorAffinity: 95.0,
                        pattern: 90.0
                    }
                };
            }
        }

        // Normal scoring path
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
        const profile = this.ARCHETYPE_PROFILES[archetype.id];

        if (!profile) {
            // No specific profile, just check preferred sectors
            return this._basicSectorAffinity(dna, archetype);
        }

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
            // Single sector dominates (> 40%)
            const hasDominance = dna.global.primary_sector_weight > 0.4;
            if (hasDominance) affinity += 15;
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
        const profile = this.ARCHETYPE_PROFILES[archetype.id];
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
}

module.exports = ArchetypeMapper;
