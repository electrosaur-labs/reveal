/**
 * Analyze SP100 PSD files for distance metric breakdown
 * Uses @electrosaur-labs/psd-reader to read Lab PSDs and extracts DNA for each image
 */

const fs = require('fs');
const path = require('path');
const psdReader = require('@electrosaur-labs/psd-reader');
const ParameterGenerator = require('@electrosaur-labs/core').ParameterGenerator;

const SP100_INPUT_8BIT = path.join(__dirname, 'data/SP100/input');

/**
 * Extract DNA from Lab pixels (same logic as CQ100_Profiler)
 */
function extractDNA(labData, width, height, filename) {
    const pixelCount = width * height;

    let totalL = 0, totalC = 0, totalL_Sq = 0;
    let minL = 100, maxL = 0, maxC = 0;

    // Lab data from PSD reader is interleaved: L, a, b, L, a, b, ...
    // For 8-bit PSDs: L is 0-255 (maps to 0-100), a/b are 0-255 (maps to -128 to +127)
    for (let i = 0; i < pixelCount; i++) {
        // Convert from Photoshop byte encoding to perceptual ranges
        const L = (labData[i * 3] / 255) * 100;
        const a = labData[i * 3 + 1] - 128;
        const b = labData[i * 3 + 2] - 128;
        const C = Math.sqrt(a * a + b * b);

        totalL += L;
        totalL_Sq += L * L;
        totalC += C;

        if (L < minL) minL = L;
        if (L > maxL) maxL = L;
        if (C > maxC) maxC = C;
    }

    const avgL = totalL / pixelCount;
    const avgC = totalC / pixelCount;
    const variance = (totalL_Sq / pixelCount) - (avgL * avgL);
    const l_std_dev = Math.sqrt(variance);

    return {
        l: avgL,
        c: avgC,
        k: maxL - minL,  // contrast/range
        minL: minL,
        maxL: maxL,
        maxC: maxC,
        l_std_dev: l_std_dev,
        filename: filename
    };
}

/**
 * Find all 8-bit PSD files in SP100 input
 */
function findPsdFiles(baseDir) {
    const files = [];

    function scan(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                scan(fullPath);
            } else if (entry.name.endsWith('.psd') && fullPath.includes('8bit')) {
                files.push(fullPath);
            }
        }
    }

    scan(baseDir);
    return files;
}

/**
 * Main analysis
 */
async function analyze() {
    console.log('\n=== SP100 Distance Metric Analysis ===\n');

    const psdFiles = findPsdFiles(SP100_INPUT_8BIT);
    console.log(`Found ${psdFiles.length} 8-bit PSD files\n`);

    let cie76 = 0, cie94 = 0;
    const byArchetype = {};
    const details = [];

    for (const psdPath of psdFiles) {
        const filename = path.basename(psdPath, '.psd');

        try {
            // Read PSD
            const buffer = fs.readFileSync(psdPath);
            const psd = psdReader.readPsd(buffer);

            // Extract DNA
            const dna = extractDNA(psd.data, psd.width, psd.height, filename);

            // Get archetype from ParameterGenerator
            const config = ParameterGenerator.generate(dna);
            const archetype = config.meta?.archetype || 'Unknown';

            // Apply distance metric rule
            const peakChroma = dna.maxC || 0;
            const isPhotographic = archetype === 'Photographic';
            const metric = (peakChroma > 80 || isPhotographic) ? 'cie94' : 'cie76';

            if (metric === 'cie94') {
                cie94++;
            } else {
                cie76++;
            }

            // Track by archetype
            if (!byArchetype[archetype]) {
                byArchetype[archetype] = { cie76: 0, cie94: 0 };
            }
            byArchetype[archetype][metric]++;

            details.push({
                filename,
                archetype,
                peakChroma: peakChroma.toFixed(1),
                l_std_dev: dna.l_std_dev.toFixed(1),
                metric
            });

            // Progress indicator
            if (details.length % 20 === 0) {
                process.stdout.write(`  Processed ${details.length}/${psdFiles.length}\r`);
            }

        } catch (err) {
            console.error(`  Error processing ${filename}: ${err.message}`);
        }
    }

    // Print results
    const total = cie76 + cie94;
    console.log(`\nProcessed: ${total} images`);
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`CIE76 (Poster/Graphic): ${cie76} (${(100*cie76/total).toFixed(1)}%)`);
    console.log(`CIE94 (Photo/Tonal):    ${cie94} (${(100*cie94/total).toFixed(1)}%)`);
    console.log(`${'─'.repeat(50)}`);

    console.log('\nBy Archetype:');
    Object.keys(byArchetype).sort().forEach(arch => {
        const a = byArchetype[arch];
        console.log(`  ${arch.padEnd(18)} CIE76=${String(a.cie76).padStart(3)} CIE94=${String(a.cie94).padStart(3)}`);
    });

    // Show some examples
    console.log('\nSample CIE94 images (peakChroma > 80 OR Photographic):');
    details.filter(d => d.metric === 'cie94').slice(0, 5).forEach(d => {
        console.log(`  ${d.filename.substring(0, 50).padEnd(52)} Arch=${d.archetype.padEnd(15)} peakC=${d.peakChroma}`);
    });

    console.log('\nSample CIE76 images (peakChroma <= 80 AND not Photographic):');
    details.filter(d => d.metric === 'cie76').slice(0, 5).forEach(d => {
        console.log(`  ${d.filename.substring(0, 50).padEnd(52)} Arch=${d.archetype.padEnd(15)} peakC=${d.peakChroma}`);
    });
}

analyze().catch(err => {
    console.error('Analysis failed:', err);
    process.exit(1);
});
