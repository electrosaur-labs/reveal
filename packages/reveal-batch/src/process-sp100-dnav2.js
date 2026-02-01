/**
 * SP-100 Rich DNA v2.0 Batch Processor
 *
 * Processes all 16-bit SP100 museum PSDs with Rich DNA v2.0, archetype-based
 * configuration, and thumbnail preservation.
 *
 * Output: data/SP100/output/16bit/dnav2/*.psd + *.json
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { posterizePsd } = require('./posterize-psd');

async function main() {
    const baseDir = path.join(__dirname, '..', 'data', 'SP100');
    const outputDir = path.join(baseDir, 'output', '16bit', 'dnav2');

    // Find all 16-bit PSDs
    const sources = ['aic', 'met', 'minkler', 'rijks'];
    const allFiles = [];

    for (const source of sources) {
        const inputDir = path.join(baseDir, 'input', source, 'psd', '16bit');
        if (fs.existsSync(inputDir)) {
            const files = fs.readdirSync(inputDir)
                .filter(f => /\.psd$/i.test(f))
                .map(f => ({ source, file: f, path: path.join(inputDir, f) }));
            allFiles.push(...files);
        }
    }

    console.log(chalk.bold('\n🎨 SP-100 Rich DNA v2.0 Batch Processor'));
    console.log(chalk.bold('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    console.log(`Total files: ${allFiles.length} 16-bit PSDs`);
    console.log(`Output:      ${outputDir}\n`);

    // Ensure output directory exists
    fs.mkdirSync(outputDir, { recursive: true });

    const results = {
        total: allFiles.length,
        success: 0,
        failed: 0,
        details: []
    };

    const startTime = Date.now();

    for (let i = 0; i < allFiles.length; i++) {
        const { source, file, path: inputPath } = allFiles[i];

        console.log(chalk.bold(`\n[${i + 1}/${allFiles.length}] ${source}/${file}`));

        try {
            const result = await posterizePsd(inputPath, outputDir, 16);
            results.success++;
            results.details.push({
                success: true,
                source,
                filename: result.filename,
                colors: result.colors,
                archetype: result.archetype,
                avgDeltaE: result.avgDeltaE,
                integrity: result.integrity
            });
        } catch (error) {
            console.error(chalk.red(`  ❌ Error: ${error.message}`));
            results.failed++;
            results.details.push({
                success: false,
                source,
                filename: path.basename(file, '.psd'),
                error: error.message
            });
        }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Write summary
    const summaryPath = path.join(outputDir, 'batch-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));

    console.log(chalk.bold('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.bold('📊 Batch Processing Complete\n'));
    console.log(`Total:   ${results.total}`);
    console.log(chalk.green(`Success: ${results.success}`));
    console.log(chalk.red(`Failed:  ${results.failed}`));
    console.log(`Time:    ${elapsed}s`);
    console.log(`\nSummary: ${summaryPath}`);
}

main().catch(console.error);
