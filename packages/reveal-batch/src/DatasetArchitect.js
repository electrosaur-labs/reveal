/**
 * DatasetArchitect.js
 * Analyzes a folder of images to verify if it meets the SP-50 diversity criteria.
 * Classifies images into Print Archetypes.
 *
 * SP-50 TARGET DISTRIBUTION:
 * - Vector/Flat:     20% (Logos, flat illustration, text)
 * - Vintage/Muted:   20% (Faded t-shirts, old posters, distress)
 * - Noir/Mono:       15% (Black & White, Ink drawings, High contrast)
 * - Neon/Vibrant:    15% (Concert posters, 80s aesthetics)
 * - Photographic:    30% (Standard photos - the "control" group)
 *
 * Usage:
 *   node src/DatasetArchitect.js [path-to-candidates]
 *
 * Example:
 *   node src/DatasetArchitect.js ./data/SP50_Candidates
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Default candidate directory
const DEFAULT_DIR = path.join(__dirname, '../data/SP50_Candidates');
const CANDIDATE_DIR = process.argv[2] || DEFAULT_DIR;

// SP-50 Target percentages
const TARGETS = {
    'Vector/Flat': 20,
    'Vintage/Muted': 20,
    'Noir/Mono': 15,
    'Neon/Vibrant': 15,
    'Photographic': 30
};

async function analyze() {
    console.log(`🏗️  SP-50 Dataset Architect`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Analyzing: ${CANDIDATE_DIR}\n`);

    if (!fs.existsSync(CANDIDATE_DIR)) {
        console.error(`❌ Directory not found: ${CANDIDATE_DIR}`);
        console.log(`\nCreate the directory and add candidate images:`);
        console.log(`  mkdir -p ${CANDIDATE_DIR}`);
        console.log(`  # Add .jpg, .png, .tif files`);
        process.exit(1);
    }

    const files = fs.readdirSync(CANDIDATE_DIR)
        .filter(f => f.match(/\.(jpg|jpeg|png|tif|tiff|ppm)$/i));

    if (files.length === 0) {
        console.error(`❌ No image files found in ${CANDIDATE_DIR}`);
        console.log(`\nSupported formats: .jpg, .jpeg, .png, .tif, .tiff, .ppm`);
        process.exit(1);
    }

    const stats = {
        'Vector/Flat': [],
        'Vintage/Muted': [],
        'Noir/Mono': [],
        'Neon/Vibrant': [],
        'Photographic': [],
        'Unknown': []
    };

    console.log(`Filename                     | Archetype       | C (Chroma) | K (Contrast) | L (Avg)`);
    console.log(`─────────────────────────────┼─────────────────┼────────────┼──────────────┼────────`);

    for (const file of files) {
        try {
            const filePath = path.join(CANDIDATE_DIR, file);
            const dna = await calculateDNA(filePath);
            const type = classify(dna);

            stats[type].push({ file, dna });
            console.log(
                `${pad(file, 28)} | ${pad(type, 15)} | ${pad(dna.c.toFixed(1), 10)} | ${pad(dna.k.toFixed(1), 12)} | ${dna.l.toFixed(1)}`
            );
        } catch (e) {
            console.error(`❌ ${file}: ${e.message}`);
            stats['Unknown'].push({ file, error: e.message });
        }
    }

    // Print balance report
    console.log(`\n${'━'.repeat(60)}`);
    console.log(`📊 DATASET BALANCE REPORT`);
    console.log(`${'━'.repeat(60)}`);

    const total = files.length;
    Object.keys(TARGETS).forEach(category => {
        const count = stats[category].length;
        const pct = ((count / total) * 100).toFixed(0);
        const target = TARGETS[category];
        const bar = '█'.repeat(Math.min(count, 30));
        const status = Math.abs(pct - target) <= 10 ? '✓' : '⚠️';

        console.log(`${status} ${pad(category, 15)}: ${pad(String(count), 3)} (${pad(pct + '%', 4)}) target: ${target}%  ${bar}`);
    });

    if (stats['Unknown'].length > 0) {
        console.log(`❌ Unknown:         ${stats['Unknown'].length} (errors)`);
    }

    // Recommendations
    console.log(`\n${'━'.repeat(60)}`);
    console.log(`🎯 SP-50 TARGETS vs ACTUAL`);
    console.log(`${'━'.repeat(60)}`);

    let recommendations = [];
    Object.keys(TARGETS).forEach(category => {
        const actual = (stats[category].length / total) * 100;
        const target = TARGETS[category];
        const diff = actual - target;

        if (diff < -10) {
            recommendations.push(`   ⬆️  Need MORE ${category} (+${Math.abs(diff).toFixed(0)}%)`);
        } else if (diff > 10) {
            recommendations.push(`   ⬇️  Too many ${category} (${diff.toFixed(0)}% over)`);
        }
    });

    if (recommendations.length === 0) {
        console.log(`   ✅ Dataset is well-balanced!`);
    } else {
        recommendations.forEach(r => console.log(r));
    }

    // List files by category
    console.log(`\n${'━'.repeat(60)}`);
    console.log(`📁 FILES BY CATEGORY`);
    console.log(`${'━'.repeat(60)}`);

    Object.keys(TARGETS).forEach(category => {
        if (stats[category].length > 0) {
            console.log(`\n${category}:`);
            stats[category].forEach(({ file, dna }) => {
                console.log(`   ${file} (C=${dna.c.toFixed(1)}, K=${dna.k.toFixed(1)})`);
            });
        }
    });

    console.log(`\n${'━'.repeat(60)}`);
    console.log(`Total: ${total} images analyzed`);
    console.log(`${'━'.repeat(60)}\n`);
}

/**
 * Calculate image DNA (simplified version without full Lab conversion)
 * Uses luminance and saturation approximations from RGB
 */
async function calculateDNA(filePath) {
    const { data, info } = await sharp(filePath)
        .resize(200, 200, { fit: 'inside' })  // Downsample for speed
        .raw()
        .toBuffer({ resolveWithObject: true });

    const pixels = info.width * info.height;
    const channels = info.channels;

    let totalL = 0;
    let totalC = 0;
    let minL = 100;
    let maxL = 0;
    let maxC = 0;
    const lValues = [];

    for (let i = 0; i < data.length; i += channels) {
        const r = data[i] / 255;
        const g = data[i + 1] / 255;
        const b = data[i + 2] / 255;

        // Luminance (approximate L from Lab)
        const L = (0.299 * r + 0.587 * g + 0.114 * b) * 100;

        // Chroma (saturation approximation)
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const C = (max - min) * 100;

        totalL += L;
        totalC += C;
        lValues.push(L);

        if (L < minL) minL = L;
        if (L > maxL) maxL = L;
        if (C > maxC) maxC = C;
    }

    const avgL = totalL / pixels;
    const avgC = totalC / pixels;
    const contrast = maxL - minL;  // K = dynamic range

    // Calculate L standard deviation (for Vector detection)
    const lVariance = lValues.reduce((sum, l) => sum + Math.pow(l - avgL, 2), 0) / pixels;
    const lStdDev = Math.sqrt(lVariance);

    return {
        l: avgL,
        c: avgC,
        k: contrast,
        maxC: maxC,
        minL: minL,
        maxL: maxL,
        l_std_dev: lStdDev
    };
}

/**
 * Classify image into SP-50 archetype based on DNA
 */
function classify(dna) {
    // 1. MONOCHROME / NOIR
    // Near-zero chroma = grayscale
    if (dna.c < 5) return 'Noir/Mono';

    // 2. VINTAGE / MUTED
    // Low Chroma AND Low Contrast (Washed out look)
    if (dna.c < 15 && dna.k < 40) return 'Vintage/Muted';

    // 3. NEON / VIBRANT
    // High Chroma, regardless of contrast
    if (dna.c > 45) return 'Neon/Vibrant';

    // 4. VECTOR / FLAT
    // Low variance in lightness = flat colors, distinct regions
    // Vectors have very distinct colors but often uniform regions
    if (dna.l_std_dev < 15) return 'Vector/Flat';

    // 5. PHOTOGRAPHIC (The Catch-all)
    // Everything else: balanced L, C, K
    return 'Photographic';
}

function pad(str, len) {
    str = String(str);
    return (str + ' '.repeat(len)).substring(0, len);
}

// Run if called directly
if (require.main === module) {
    analyze().catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { analyze, classify, calculateDNA };
