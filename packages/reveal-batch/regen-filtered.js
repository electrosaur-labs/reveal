#!/usr/bin/env node
/**
 * Regenerate only images that had preprocessing applied
 * These need to be re-processed with the fixed 16-bit Lab bilateral filter
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');

// Import the processing function directly from reveal-batch-preprocess
// We need to extract processImage - for now, we'll call the batch script with a temp dir

function findFilteredImages(dir) {
    const results = [];

    function scan(currentDir) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                scan(fullPath);
            } else if (entry.name.endsWith('.json') && !entry.name.includes('batch-report')) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const json = JSON.parse(content);
                    if (json.preprocessing?.applied === true) {
                        const outputDir = path.dirname(fullPath);
                        const basename = path.basename(fullPath, '.json');

                        const relativePath = path.relative(dataDir, outputDir);
                        const parts = relativePath.split(path.sep);

                        const dataset = parts[0];
                        const bitDepth = parts[2];

                        let inputPath;
                        if (dataset === 'SP100') {
                            const subdir = parts[4] || '';
                            inputPath = path.join(dataDir, dataset, 'input', subdir, 'psd', bitDepth, `${basename}.psd`);
                        } else {
                            inputPath = path.join(dataDir, dataset, 'input', 'psd', bitDepth, `${basename}.psd`);
                        }

                        results.push({
                            jsonPath: fullPath,
                            outputDir: outputDir,
                            basename: basename,
                            inputPath: inputPath,
                            bitDepth: bitDepth,
                            dataset: dataset
                        });
                    }
                } catch (e) {
                    // Skip invalid JSON
                }
            }
        }
    }

    scan(dir);
    return results;
}

// Group images by input directory for batch processing
function groupByInputDir(items) {
    const groups = new Map();

    for (const item of items) {
        const inputDir = path.dirname(item.inputPath);
        if (!groups.has(inputDir)) {
            groups.set(inputDir, {
                inputDir,
                outputDir: item.outputDir,
                files: []
            });
        }
        groups.get(inputDir).files.push(item.basename);
    }

    return Array.from(groups.values());
}

async function main() {
    const filtered = findFilteredImages(dataDir);
    console.log(`Found ${filtered.length} images that had preprocessing applied.\n`);

    if (process.argv.includes('--list')) {
        filtered.forEach((f, i) => {
            const exists = fs.existsSync(f.inputPath) ? '✓' : '✗';
            console.log(`${i + 1}. [${exists}] ${f.basename} (${f.bitDepth})`);
            console.log(`   Input:  ${f.inputPath}`);
            console.log(`   Output: ${f.outputDir}`);
        });
        console.log(`\nRun without --list to regenerate.`);
        return;
    }

    // Group by input directory
    const groups = groupByInputDir(filtered);

    console.log(`Grouped into ${groups.length} batch operations:\n`);
    groups.forEach((g, i) => {
        console.log(`${i + 1}. ${g.inputDir}`);
        console.log(`   → ${g.outputDir}`);
        console.log(`   Files: ${g.files.join(', ')}`);
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`To regenerate, run reveal-batch-preprocess.js for each group:`);
    console.log(`${'='.repeat(60)}\n`);

    for (const group of groups) {
        // Create a temp directory with just the files we need
        const tempDir = path.join(__dirname, '.regen-temp');
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true });
        }
        fs.mkdirSync(tempDir, { recursive: true });

        // Symlink just the files we need
        for (const basename of group.files) {
            const src = path.join(group.inputDir, `${basename}.psd`);
            const dst = path.join(tempDir, `${basename}.psd`);
            if (fs.existsSync(src)) {
                fs.symlinkSync(src, dst);
            }
        }

        console.log(`\nProcessing batch: ${group.files.length} files from ${group.inputDir}`);
        console.log(`Output: ${group.outputDir}`);

        // Run the batch processor
        const { execSync } = require('child_process');
        try {
            execSync(`node src/reveal-batch-preprocess.js "${tempDir}" "${group.outputDir}"`, {
                cwd: __dirname,
                stdio: 'inherit'
            });
        } catch (e) {
            console.error(`Error processing batch: ${e.message}`);
        }

        // Cleanup temp dir
        fs.rmSync(tempDir, { recursive: true });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Regeneration complete!`);
}

main().catch(console.error);
