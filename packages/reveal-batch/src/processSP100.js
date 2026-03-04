/**
 * SP-100 Dataset Processor
 *
 * Batch processes Lab PSDs using posterize-psd.js
 *
 * Input:  data/SP100/input/{source}/psd/{8bit|16bit}/*.psd
 * Output: data/SP100/output/{source}/psd/{8bit|16bit}/*.psd + *.json
 *
 * Usage: node src/processSP100.js [source] [bitDepth]
 *   source:   'met', 'rijks', or 'all' (default: 'all')
 *   bitDepth: '8', '16', or 'all' (default: 'all')
 *
 * Examples:
 *   node src/processSP100.js              # Process all sources, all bit depths
 *   node src/processSP100.js met          # Process only 'met' source
 *   node src/processSP100.js all 16       # Process all sources, 16-bit only
 *   node src/processSP100.js rijks 8      # Process 'rijks' source, 8-bit only
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { posterizePsd } = require('./posterize-psd');

/**
 * Process all PSDs in a directory
 * @param {Object} [cliOptions] - Options to pass through to posterizePsd
 * @param {string} [cliOptions.archetype] - Archetype ID override
 */
async function processDirectory(inputDir, outputDir, bitDepth, sourceName, cliOptions = {}) {
    if (!fs.existsSync(inputDir)) {
        return [];
    }

    const files = fs.readdirSync(inputDir)
        .filter(f => /\.psd$/i.test(f))
        .sort();

    if (files.length === 0) {
        return [];
    }

    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log(chalk.bold(`\n📁 ${sourceName.toUpperCase()} / ${bitDepth}-bit`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(`Input:  ${inputDir}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Files:  ${files.length} PSDs\n`);

    const results = [];

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const inputPath = path.join(inputDir, file);

        console.log(chalk.bold(`[${i + 1}/${files.length}] ${file}`));

        try {
            const result = await posterizePsd(inputPath, outputDir, bitDepth, cliOptions);
            results.push({
                success: true,
                filename: result.filename,
                source: sourceName,
                bitDepth: bitDepth,
                colors: result.colors,
                dna: result.dna
            });
        } catch (error) {
            console.error(chalk.red(`  Error: ${error.message}`));
            results.push({
                success: false,
                filename: path.basename(file, '.psd'),
                source: sourceName,
                bitDepth: bitDepth,
                error: error.message
            });
        }
    }

    return results;
}

/**
 * Process a source (met, rijks, etc.)
 */
async function processSource(sourceName, bitDepths, baseDir, cliOptions = {}) {
    const results = [];

    for (const bitDepth of bitDepths) {
        const inputDir = path.join(baseDir, 'input', sourceName, 'psd', `${bitDepth}bit`);
        // When archetype override is set, output to flat archetype-named directory
        const outputDir = cliOptions.archetype
            ? path.join(baseDir, 'output', 'psd', cliOptions.archetype)
            : path.join(baseDir, 'output', sourceName, 'psd', `${bitDepth}bit`);

        const dirResults = await processDirectory(inputDir, outputDir, bitDepth, sourceName, cliOptions);
        results.push(...dirResults);
    }

    return results;
}

/**
 * Main batch processing
 */
async function main() {
    // Parse --archetype flag from anywhere in args
    const rawArgs = process.argv.slice(2);
    let archetype = null;
    const positionalArgs = [];
    for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === '--archetype' && i + 1 < rawArgs.length) {
            archetype = rawArgs[i + 1];
            i++;
        } else if (rawArgs[i].startsWith('--archetype=')) {
            archetype = rawArgs[i].split('=')[1];
        } else {
            positionalArgs.push(rawArgs[i]);
        }
    }

    const sourceArg = positionalArgs[0] || 'all';
    const bitDepthArg = positionalArgs[1] || 'all';
    const baseDir = path.join(__dirname, '../data/SP100');
    const inputBaseDir = path.join(baseDir, 'input');

    console.log(chalk.bold(`\n🎨 SP-100 Dataset Processor`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));

    // Determine sources to process
    let sources = [];
    if (sourceArg === 'all') {
        if (fs.existsSync(inputBaseDir)) {
            sources = fs.readdirSync(inputBaseDir)
                .filter(f => fs.statSync(path.join(inputBaseDir, f)).isDirectory())
                .filter(f => f !== 'psd');
        }
    } else {
        sources = [sourceArg];
    }

    // Determine bit depths to process
    let bitDepths = [];
    if (bitDepthArg === 'all') {
        bitDepths = [8, 16];
    } else {
        bitDepths = [parseInt(bitDepthArg, 10)];
    }

    console.log(`Sources:    ${sources.join(', ') || 'none found'}`);
    console.log(`Bit depths: ${bitDepths.join(', ')}`);
    if (archetype) console.log(`Archetype:  ${archetype} (override)`);

    if (sources.length === 0) {
        console.log(chalk.yellow(`\nNo source directories found in ${inputBaseDir}`));
        return;
    }

    const allResults = [];
    const startTime = Date.now();

    for (const source of sources) {
        const sourceDir = path.join(inputBaseDir, source);
        if (!fs.existsSync(sourceDir)) {
            console.log(chalk.yellow(`Source directory not found: ${sourceDir}`));
            continue;
        }

        const cliOptions = archetype ? { archetype } : {};
        const results = await processSource(source, bitDepths, baseDir, cliOptions);
        allResults.push(...results);
    }

    // Summary report
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successResults = allResults.filter(r => r.success);
    const failedResults = allResults.filter(r => !r.success);

    console.log(chalk.bold(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`));
    console.log(chalk.bold(`📊 SUMMARY`));
    console.log(chalk.bold(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`));
    console.log(`Total:     ${allResults.length} images`);
    console.log(chalk.green(`Success:   ${successResults.length}`));
    console.log(chalk.red(`Failed:    ${failedResults.length}`));
    console.log(`Time:      ${elapsed}s`);
    if (allResults.length > 0) {
        console.log(`Avg:       ${(elapsed / allResults.length).toFixed(2)}s per image\n`);
    }

    // Source distribution
    if (successResults.length > 0) {
        const sourceCounts = {};
        successResults.forEach(r => {
            const key = `${r.source}/${r.bitDepth}bit`;
            sourceCounts[key] = (sourceCounts[key] || 0) + 1;
        });

        console.log(chalk.bold(`Source Distribution:`));
        Object.entries(sourceCounts).forEach(([key, count]) => {
            console.log(`  ${key}: ${count} images`);
        });
        console.log();

        // Color distribution
        const colorCounts = {};
        successResults.forEach(r => {
            colorCounts[r.colors] = (colorCounts[r.colors] || 0) + 1;
        });

        console.log(chalk.bold(`Color Count Distribution:`));
        Object.entries(colorCounts)
            .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
            .forEach(([colors, count]) => {
                const pct = ((count / successResults.length) * 100).toFixed(1);
                console.log(`  ${colors} colors: ${count} images (${pct}%)`);
            });
        console.log();
    }

    // Save report
    const reportPath = path.join(baseDir, 'output', 'batch-report.json');
    if (!fs.existsSync(path.dirname(reportPath))) {
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    }

    fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        sources: sources,
        bitDepths: bitDepths,
        total: allResults.length,
        success: successResults.length,
        failed: failedResults.length,
        elapsedSeconds: parseFloat(elapsed),
        sourceDistribution: successResults.reduce((acc, r) => {
            const key = `${r.source}/${r.bitDepth}bit`;
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {}),
        colorDistribution: successResults.reduce((acc, r) => {
            acc[r.colors] = (acc[r.colors] || 0) + 1;
            return acc;
        }, {}),
        results: successResults,
        errors: failedResults.map(r => ({
            filename: r.filename,
            source: r.source,
            bitDepth: r.bitDepth,
            error: r.error
        }))
    }, null, 2));

    console.log(chalk.green(`✓ Report saved: ${reportPath}\n`));

    if (failedResults.length > 0) {
        console.log(chalk.yellow(`Failed files:`));
        failedResults.forEach(r => {
            console.log(`  - [${r.source}/${r.bitDepth}bit] ${r.filename}: ${r.error}`);
        });
        console.log();
    }
}

// Run if called directly
if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(`\n❌ Fatal error: ${err.message}`));
        console.error(err.stack);
        process.exit(1);
    });
}

module.exports = { processSource, processDirectory };
