/**
 * DynamicConfigurator v1.7
 * Driven by Archetype Classification (Tonal Variation vs Chroma)
 *
 * CHANGELOG:
 * - v1.3: Chroma Driver for color budgeting
 * - v1.4: Saliency Rescue threshold raised to maxC > 80
 * - v1.5: Dither logic based on l_std_dev instead of k
 * - v1.7: Archetype classification with per-archetype strategies
 *
 * ARCHETYPES:
 * - Vector/Flat:    Low variation (l_std_dev < 15). Logos, icons, text.
 * - Vintage/Muted:  Low variation + moderate chroma. Lithographs, WPA posters.
 * - Noir/Mono:      Low chroma + high contrast. B&W photos, woodcuts.
 * - Neon/Vibrant:   Extreme chroma (c > 60). Pop art, neon signs.
 * - Photographic:   High variation + moderate chroma. Natural photos.
 */
class DynamicConfigurator {

    static generate(dna) {
        // 1. CLASSIFY ARCHETYPE
        const archetype = this.getArchetype(dna);

        // 2. DEFINE STRATEGY MAP
        const strategy = this.getStrategy(archetype, dna);

        console.log(`🧬 DNA: StdDev=${dna.l_std_dev?.toFixed(1) || '?'} C=${dna.c?.toFixed(1) || '?'} -> Archetype: ${archetype}`);

        // 3. COLOR COUNT LOGIC (The "Chroma Driver")
        // Independent of archetype, driven by color complexity
        let idealColors = 8;
        if (dna.c > 20) idealColors = 10;
        if (dna.c > 50) idealColors = 12;

        // Saliency Rescue: Hidden color spike in muted image
        if (dna.c < 12 && dna.maxC > 80) {
            console.log(`🚑 Saliency Rescue: ${dna.filename || 'unknown'} (High Value Spike)`);
            idealColors = 10;
        }

        const finalColors = Math.max(4, Math.min(idealColors, 12));

        return {
            id: `auto_${archetype.toLowerCase().replace('/', '_')}`,
            name: "Dynamic Bespoke",
            targetColors: finalColors,
            blackBias: strategy.bias,
            saturationBoost: (dna.c < 15) ? 1.15 : 1.0,
            ditherType: strategy.dither,
            rangeClamp: [dna.minL, dna.maxL],
            meta: { archetype }
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
     */
    static getStrategy(archetype, dna) {
        const l_std_dev = dna.l_std_dev !== undefined ? dna.l_std_dev : 50;

        switch (archetype) {
            case 'Vector/Flat':
                return {
                    dither: 'atkinson', // Crisp edges
                    bias: 1.0           // Precision (Don't bias blacks heavily)
                };

            case 'Vintage/Muted':
                return {
                    dither: 'atkinson', // Retain the "Cut Paper" look
                    bias: 3.0           // Smooth out paper grain in solids
                };

            case 'Noir/Mono':
                // Default to BlueNoise for smooth shadow gradients
                return {
                    dither: 'blue-noise',
                    bias: 5.0           // Protect deep blacks at all costs
                };

            case 'Neon/Vibrant':
                return {
                    dither: 'blue-noise', // Smooth gradients needed for neon glows
                    bias: 2.0
                };

            case 'Photographic':
            default:
                // Check for "Texture Rescue" (Heavy Grain)
                if (l_std_dev > 45) {
                    return { dither: 'blue-noise', bias: 5.0 };
                }
                return {
                    dither: 'blue-noise', // Standard Photo setting
                    bias: 2.0
                };
        }
    }
}

module.exports = DynamicConfigurator;
