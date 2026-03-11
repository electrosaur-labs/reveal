#!/usr/bin/env node
/**
 * reveal-batch.js — Generic batch posterizer for Lab PSDs
 *
 * Processes all Lab PSDs in an input directory through the Reveal separation engine.
 * Delegates per-file processing to posterize-psd.js.
 *
 * Usage: node reveal-batch.js <input-dir> <output-dir> [--archetype <id>]
 *
 * Input:  Directory containing Lab PSDs (8-bit or 16-bit)
 * Output: Directory for separated PSDs and validation JSONs
 */
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { posterizePsd } = require('./posterize-psd');

async function main() {
    const args = process.argv.slice(2);

    // Parse --archetype and --quantizer flags
    let archetype = null;
    let quantizer = null;
    const positionalArgs = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--archetype' && i + 1 < args.length) {
            archetype = args[i + 1];
            i++;
        } else if (args[i].startsWith('--archetype=')) {
            archetype = args[i].split('=')[1];
        } else if (args[i] === '--quantizer' && i + 1 < args.length) {
            quantizer = args[i + 1];
            i++;
        } else if (args[i].startsWith('--quantizer=')) {
            quantizer = args[i].split('=')[1];
        } else {
            positionalArgs.push(args[i]);
        }
    }

    if (positionalArgs.length < 2) {
        console.log(chalk.yellow(`
Usage: node reveal-batch.js <input-dir> <output-dir> [--archetype <id>] [--quantizer <type>]

Arguments:
  input-dir    Directory containing Lab PSDs (8-bit or 16-bit)
  output-dir   Directory for separated PSDs and validation JSONs
  --archetype  Optional archetype override (chameleon, distilled, salamander, or JSON id)
  --quantizer  Optional quantizer override (median-cut or wu)

Example:
  node reveal-batch.js data/CQ100_v4/input/psd/16bit data/CQ100_v4/output/psd
  node reveal-batch.js data/SP100/input/met/psd/16bit data/SP100/output/met --archetype salamander
`));
        process.exit(1);
    }

    const inputDir = path.resolve(positionalArgs[0]);
    const outputDir = path.resolve(positionalArgs[1]);

    if (!fs.existsSync(inputDir)) {
        console.error(chalk.red(`Error: Input directory not found: ${inputDir}`));
        process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const files = fs.readdirSync(inputDir).filter(f => f.endsWith('.psd')).sort();
    if (files.length === 0) {
        console.error(chalk.red(`Error: No PSD files found in ${inputDir}`));
        process.exit(1);
    }

    console.log(chalk.bold(`\nReveal Batch Processor`));
    console.log(chalk.bold(`${'━'.repeat(50)}\n`));
    console.log(`Input:  ${inputDir}`);
    console.log(`Output: ${outputDir}`);
    console.log(`Files:  ${files.length} images`);
    if (archetype) console.log(`Archetype: ${archetype} (override)`);
    console.log();

    const results = [];
    const startTime = Date.now();

    let skipped = 0;
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const basename = path.basename(file, '.psd');
        const outputPsd = path.join(outputDir, `${basename}.psd`);
        const outputJson = path.join(outputDir, `${basename}.json`);

        // Skip if both output PSD and JSON already exist
        if (fs.existsSync(outputPsd) && fs.existsSync(outputJson)) {
            skipped++;
            console.log(chalk.gray(`[${i + 1}/${files.length}] ${file} — skipped (already processed)`));
            results.push({ success: true, filename: basename, colors: null, skipped: true });
            continue;
        }

        console.log(chalk.bold(`[${i + 1}/${files.length}] ${file}`));

        try {
            const result = await posterizePsd(
                path.join(inputDir, file),
                outputDir,
                null, // auto-detect bit depth
                { ...(archetype ? { archetype } : {}), ...(quantizer ? { quantizer } : {}) }
            );
            results.push(result);
        } catch (error) {
            console.error(chalk.red(`  Error: ${error.message}`));
            results.push({ success: false, filename: file, error: error.message });
        }
    }
    if (skipped > 0) console.log(chalk.gray(`\nSkipped ${skipped} already-processed files`));

    // Summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const successResults = results.filter(r => r.success);
    const failedResults = results.filter(r => !r.success);

    console.log(chalk.bold(`\n${'━'.repeat(50)}`));
    console.log(chalk.bold(`SUMMARY\n`));
    console.log(`Total:   ${files.length} images`);
    console.log(chalk.green(`Success: ${successResults.length}`));
    if (failedResults.length > 0) console.log(chalk.red(`Failed:  ${failedResults.length}`));
    console.log(`Time:    ${elapsed}s (${(elapsed / files.length).toFixed(2)}s/image)\n`);

    // Save batch report
    const reportPath = path.join(outputDir, 'batch-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        inputDir, outputDir,
        total: files.length,
        success: successResults.length,
        failed: failedResults.length,
        elapsedSeconds: parseFloat(elapsed),
        results: successResults.map(r => ({ filename: r.filename, colors: r.colors })),
        errors: failedResults.map(r => ({ filename: r.filename, error: r.error }))
    }, null, 2));

    console.log(chalk.green(`Report: ${reportPath}\n`));

    if (failedResults.length > 0) {
        failedResults.forEach(r => console.log(chalk.red(`  ${r.filename}: ${r.error}`)));
        console.log();
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error(chalk.red(`Fatal: ${err.message}`));
        process.exit(1);
    });
}
