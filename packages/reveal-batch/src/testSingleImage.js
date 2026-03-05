#!/usr/bin/env node
/**
 * Test single image processing
 */

const fs = require('fs');
const path = require('path');
const Reveal = require('@electrosaur-labs/core');
const PosterizationEngine = Reveal.engines.PosterizationEngine;
const ParameterGenerator = Reveal.ParameterGenerator;
const PSDWriter = require('@electrosaur-labs/psd-writer');

const IMAGE_NAME = 'shopping_bags';
const INPUT_DIR = path.join(__dirname, '../data/CQ100_v4/input/tiff');
const OUTPUT_DIR = path.join(__dirname, '../data/CQ100_v4/output/psd');

async function processImage() {
    console.log(`\n🧪 Testing single image: ${IMAGE_NAME}`);

    // 1. Load Lab TIFF
    const labPath = path.join(INPUT_DIR, `${IMAGE_NAME}.tiff`);
    console.log(`📂 Loading: ${labPath}`);

    const labBuffer = fs.readFileSync(labPath);
    const labData = PosterizationEngine.loadLabTiff(labBuffer);

    console.log(`   Dimensions: ${labData.width}×${labData.height}`);

    // 2. Generate DNA-based configuration
    const dna = {
        l: 77.5,
        c: 68.8,
        k: 71.8,
        maxC: 92.4,
        minL: 27.8,
        maxL: 99.6,
        filename: IMAGE_NAME
    };

    const config = ParameterGenerator.generate(dna);
    console.log(`🧬 DNA Config: ${config.name}`);
    console.log(`   Target Colors: ${config.targetColors}`);
    console.log(`   Black Bias: ${config.blackBias}`);
    console.log(`   Dither: ${config.ditherType}`);

    // 3. Run posterization
    console.log(`\n🎨 Running posterization...`);
    const result = PosterizationEngine.posterize(
        labData.pixels,
        labData.width,
        labData.height,
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
            ignoreTransparent: true,
            enableHueGapAnalysis: true,
            ditherType: config.ditherType,
            blackBias: config.blackBias,
            saturationBoost: config.saturationBoost,
            rangeClamp: config.rangeClamp
        }
    );

    console.log(`✓ Posterization complete`);
    console.log(`   Final palette: ${result.palette.length} colors`);

    // 4. Show coverage for each color
    console.log(`\n📊 Color Coverage:`);
    result.palette.forEach((color, i) => {
        console.log(`   Ink ${i + 1}: ${color.coverage} - ${color.hex}`);
    });

    // 5. Write PSD
    const psdPath = path.join(OUTPUT_DIR, `${IMAGE_NAME}.psd`);
    console.log(`\n💾 Writing PSD: ${psdPath}`);

    const psdBuffer = PSDWriter.write(result, labData.width, labData.height, {
        documentName: IMAGE_NAME,
        colorMode: 'lab16'
    });

    fs.writeFileSync(psdPath, psdBuffer);
    console.log(`✓ PSD written: ${psdBuffer.length} bytes`);

    // 6. Write sidecar JSON
    const jsonPath = path.join(OUTPUT_DIR, `${IMAGE_NAME}.json`);
    const sidecar = {
        meta: {
            filename: `${IMAGE_NAME}.ppm`,
            timestamp: new Date().toISOString(),
            width: labData.width,
            height: labData.height,
            outputFile: `${IMAGE_NAME}.psd`
        },
        dna,
        configuration: config,
        input_parameters: {
            configType: 'dynamic',
            configId: config.id,
            targetColors: config.targetColors,
            targetColorsSlider: config.targetColors,
            blackBias: config.blackBias,
            ditherType: config.ditherType,
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
            ignoreTransparent: true,
            enableHueGapAnalysis: true
        },
        palette: result.palette,
        metrics: result.metrics,
        timing: result.timing
    };

    fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2));
    console.log(`✓ Sidecar written: ${jsonPath}`);

    console.log(`\n✅ Test complete!`);
}

processImage().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
