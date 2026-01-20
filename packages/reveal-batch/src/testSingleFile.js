/**
 * Test processing a single file to debug PSD generation
 */

const fs = require('fs');
const path = require('path');
const PosterizationEngine = require('@reveal/core/lib/engines/PosterizationEngine');
const PSDReader = require('@reveal/core/lib/formats/psd/PSDReader');
const PSDWriter = require('@reveal/core/lib/formats/psd/PSDWriter');
const ParameterGenerator = require('@reveal/core/lib/analysis/ParameterGenerator');
const LabConverter = require('@reveal/core/lib/utils/LabConverter');

const INPUT_FILE = 'crepe_paper.psd';
const INPUT_DIR = path.join(__dirname, '../data/CQ100_v4/input/psd');
const OUTPUT_DIR = path.join(__dirname, '../data/CQ100_v4/output/psd');

async function testSingleFile() {
    console.log(`🧪 Testing single file: ${INPUT_FILE}\n`);

    const inputPath = path.join(INPUT_DIR, INPUT_FILE);
    const outputPath = path.join(OUTPUT_DIR, INPUT_FILE);
    const jsonPath = outputPath.replace('.psd', '.json');

    // 1. Read input PSD
    console.log('📖 Reading input PSD...');
    const inputBuffer = fs.readFileSync(inputPath);
    const reader = new PSDReader(inputBuffer);
    const psdData = reader.parse();

    console.log(`   Width: ${psdData.width}, Height: ${psdData.height}`);
    console.log(`   Color Mode: ${psdData.colorMode}, Bits: ${psdData.bitsPerChannel}`);

    // 2. Get Lab pixels
    console.log('\n🎨 Extracting Lab pixels...');
    const labPixels = reader.getLabPixels();
    console.log(`   Got ${labPixels.length} bytes (${labPixels.length / 3} pixels)`);

    // 3. Generate DNA
    console.log('\n🧬 Generating image DNA...');
    const dna = LabConverter.generateDNA(labPixels, psdData.width, psdData.height);
    console.log(`   L: ${dna.l}, C: ${dna.c}, K: ${dna.k}`);
    console.log(`   maxC: ${dna.maxC}, minL: ${dna.minL}, maxL: ${dna.maxL}`);

    // 4. Generate dynamic configuration
    console.log('\n⚙️  Generating dynamic configuration...');
    const config = ParameterGenerator.generate(dna);
    console.log(`   Configuration: ${config.name}`);
    console.log(`   Target Colors: ${config.targetColors}`);
    console.log(`   Black Bias: ${config.blackBias}`);
    console.log(`   Dither: ${config.ditherType}`);

    // 5. Run posterization engine
    console.log('\n🎯 Running posterization...');
    const result = PosterizationEngine.posterize(
        labPixels,
        psdData.width,
        psdData.height,
        config.targetColors,
        {
            engineType: 'reveal',
            centroidStrategy: 'SALIENCY',
            lWeight: 1.1,
            cWeight: 2.0,
            substrateMode: 'auto',
            substrateTolerance: 2,
            vibrancyMode: 'aggressive',
            vibrancyBoost: 1.6,
            highlightThreshold: 85,
            highlightBoost: 1,
            enablePaletteReduction: true,
            paletteReduction: 10,
            hueLockAngle: 20,
            shadowPoint: 15,
            colorMode: 'color',
            preserveWhite: true,
            preserveBlack: true,
            blackBias: config.blackBias,
            ignoreTransparent: true,
            enableHueGapAnalysis: true,
            ditherType: config.ditherType,
            maskProfile: 'Gray Gamma 2.2'
        }
    );

    console.log(`   Generated ${result.palette.length} colors`);

    // 6. Create output PSD
    console.log('\n📝 Creating output PSD...');
    const writer = new PSDWriter({
        width: psdData.width,
        height: psdData.height,
        colorMode: 'lab',
        bitsPerChannel: 16  // Use 16-bit to match input
    });

    // Add background layer (original image)
    writer.addPixelLayer({
        name: 'Background',
        pixels: labPixels,
        visible: true
    });

    // Filter out layers with 0% coverage
    const validLayers = result.layers.filter(layer => layer.coverage > 0);
    console.log(`   ${result.layers.length} total layers, ${validLayers.length} with coverage > 0`);

    // Sort by lightness (high to low)
    validLayers.sort((a, b) => b.color.L - a.color.L);

    // Add color separation layers
    for (const layer of validLayers) {
        const hexColor = `#${layer.rgbColor.r.toString(16).padStart(2, '0')}${layer.rgbColor.g.toString(16).padStart(2, '0')}${layer.rgbColor.b.toString(16).padStart(2, '0')}`;
        const layerName = `Ink ${layer.index + 1} (${hexColor})`;

        console.log(`   Adding layer: ${layerName} - L=${layer.color.L.toFixed(1)}, Coverage=${layer.coverage.toFixed(2)}%`);

        writer.addFillLayer({
            name: layerName,
            color: layer.color,
            mask: layer.mask
        });
    }

    // 7. Write PSD file
    console.log('\n💾 Writing PSD file...');
    const psdBuffer = writer.write();
    fs.writeFileSync(outputPath, psdBuffer);

    const sizeKB = (psdBuffer.length / 1024).toFixed(2);
    console.log(`   ✓ Saved: ${outputPath} (${sizeKB} KB)`);

    // 8. Save metadata JSON
    console.log('\n📊 Saving metadata...');
    const metadata = {
        meta: {
            filename: INPUT_FILE,
            timestamp: new Date().toISOString(),
            width: psdData.width,
            height: psdData.height,
            outputFile: INPUT_FILE
        },
        dna,
        configuration: config,
        palette: result.palette.map((color, idx) => ({
            name: `Ink ${idx + 1} (#${color.rgbColor.r.toString(16).padStart(2, '0')}${color.rgbColor.g.toString(16).padStart(2, '0')}${color.rgbColor.b.toString(16).padStart(2, '0')})`,
            lab: { L: color.L, a: color.a, b: color.b },
            rgb: color.rgbColor,
            hex: `#${color.rgbColor.r.toString(16).padStart(2, '0')}${color.rgbColor.g.toString(16).padStart(2, '0')}${color.rgbColor.b.toString(16).padStart(2, '0')}`,
            coverage: `${result.layers[idx].coverage.toFixed(2)}%`
        })),
        metrics: result.metrics,
        timing: result.timing
    };

    fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2));
    console.log(`   ✓ Saved: ${jsonPath}`);

    console.log('\n✅ Test complete!');
    console.log('\nNow check the output file in Photoshop:');
    console.log(`   ${outputPath}`);
}

testSingleFile().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
