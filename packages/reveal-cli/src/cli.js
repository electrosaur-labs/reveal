/**
 * cli.js — Command-line interface for Reveal color separation
 *
 * Parses arguments, orchestrates pipeline, dispatches output writers.
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const { ingest } = require('./ingest');
const { processSingle, computeDna, autoDetectArchetype, listArchetypes, PSEUDO_IDS } = require('./pipeline');
const { loadRecipe, saveRecipe, mergeRecipeWithCli } = require('./recipe');
const { writeFlat } = require('./output/flat');
const { writePsd } = require('./output/psd');
const { writeOra } = require('./output/ora');
const { writePlates } = require('./output/plates');
const { writeSidecar } = require('./output/sidecar');

const program = new Command();

program
    .name('reveal')
    .description('Color separation engine — posterize images for screen printing')
    .version('1.0.0')
    .argument('<input>', 'Input image (PNG, TIFF, JPEG, or Lab PSD)')
    .option('-o, --output <path>', 'Output path or directory')
    .option('-a, --archetype <name>', 'Archetype ID (default: auto-detect)')
    .option('-c, --colors <n>', 'Target color count (2-12)', parseInt)
    .option('-f, --format <types...>', 'Output formats: psd, ora, plates (repeatable or comma-separated)')
    .option('--trap <pixels>', 'Trap width in pixels', parseInt)
    .option('--min-volume <percent>', 'Minimum coverage threshold (0-5%)', parseFloat)
    .option('--speckle-rescue <pixels>', 'Despeckle threshold (0-10px)', parseFloat)
    .option('--shadow-clamp <percent>', 'Ink body clamp (0-20%)', parseFloat)
    .option('--single', 'Single archetype mode (default if --archetype provided)')
    .option('--compare', 'Compare mode: Chameleon, Distilled, Salamander + top DNA match (default)')
    .option('--recipe <path>', 'Load settings from recipe JSON')
    .option('--save-recipe <path>', 'Save effective settings to recipe JSON')
    .option('--list-archetypes', 'Print available archetypes and exit')
    .option('--no-json', 'Suppress JSON sidecar')
    .option('-q, --quiet', 'Errors only')
    .option('-v, --verbose', 'Detailed diagnostics')
    .action(run);

// Standalone --list-archetypes (no input required)
if (process.argv.includes('--list-archetypes')) {
    const groups = listArchetypes();
    for (const [group, ids] of Object.entries(groups)) {
        console.log(`\n${group.toUpperCase()}:`);
        for (const id of ids) {
            console.log(`  ${id}`);
        }
    }
    process.exit(0);
}

const VALID_FORMATS = new Set(['psd', 'ora', 'plates']);

/**
 * Normalize --format values: accept repeatable flags and comma-separated lists.
 * e.g. ['psd', 'ora,plates'] → Set{'psd', 'ora', 'plates'}
 */
function parseFormats(rawFormats) {
    if (!rawFormats) return new Set();
    const formats = new Set();
    for (const item of rawFormats) {
        for (const f of item.split(',')) {
            const trimmed = f.trim().toLowerCase();
            if (trimmed) {
                if (!VALID_FORMATS.has(trimmed)) {
                    throw new Error(`Unknown format "${trimmed}". Valid: ${[...VALID_FORMATS].join(', ')}`);
                }
                formats.add(trimmed);
            }
        }
    }
    return formats;
}

async function run(inputFile, options) {
    const log = options.quiet ? () => {} : (msg) => process.stderr.write(msg + '\n');
    const verbose = options.verbose ? (msg) => process.stderr.write(`  [verbose] ${msg}\n`) : () => {};
    const startTime = Date.now();

    try {
        // Validation
        if (options.compare && (options.single || options.archetype)) {
            throw new Error('--compare and --single/--archetype are mutually exclusive');
        }
        if (options.single && !options.archetype) {
            throw new Error('--single requires --archetype (which archetype to use?)');
        }
        if (options.colors !== undefined && (options.colors < 2 || options.colors > 12)) {
            throw new Error('Colors must be 2-12');
        }

        // Normalize --format: accept repeatable and comma-separated
        const formats = parseFormats(options.format);

        // Load recipe and merge with CLI
        let mergedOptions = { ...options };
        if (options.recipe) {
            const recipe = loadRecipe(options.recipe);
            mergedOptions = mergeRecipeWithCli(recipe, {
                archetype: options.archetype,
                colors: options.colors,
                trap: options.trap,
                minVolume: options.minVolume,
                speckleRescue: options.speckleRescue,
                shadowClamp: options.shadowClamp,
            });
            // Merge recipe outputs with CLI formats
            const recipeFormats = recipe.outputs || [];
            mergedOptions.formats = new Set([...formats, ...recipeFormats]);
            mergedOptions.single = options.single || !!mergedOptions.archetype;
            mergedOptions.compare = options.compare;
            mergedOptions.output = options.output || recipe.outputDir;
            mergedOptions.quiet = options.quiet;
            mergedOptions.verbose = options.verbose;
            mergedOptions.json = options.json;
            mergedOptions.saveRecipe = options.saveRecipe;
            log(`Loaded recipe: ${options.recipe}`);
        } else {
            mergedOptions.formats = formats;
            mergedOptions.single = options.single || !!options.archetype;
        }

        // Ingest
        log(`Reading: ${inputFile}`);
        const { lab16bit, width, height, inputFormat } = await ingest(inputFile);
        log(`Image: ${width}×${height} (${inputFormat})`);
        verbose(`Pixel count: ${width * height}`);

        const basename = path.basename(inputFile, path.extname(inputFile));
        const inputDir = path.dirname(path.resolve(inputFile));

        if (mergedOptions.single) {
            await runSingle(lab16bit, width, height, basename, inputDir, inputFormat, mergedOptions, log, verbose, inputFile);
        } else {
            await runCompare(lab16bit, width, height, basename, inputDir, inputFormat, mergedOptions, log, verbose, inputFile);
        }

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log(`\nDone in ${elapsed}s`);

    } catch (err) {
        process.stderr.write(`Error: ${err.message}\n`);
        if (options.verbose) process.stderr.write(err.stack + '\n');
        process.exit(1);
    }
}

async function runSingle(lab16bit, width, height, basename, inputDir, inputFormat, options, log, verbose, inputFile) {
    const onProgress = (phase, msg) => {
        verbose(`[${phase}] ${msg}`);
    };

    const result = await processSingle(lab16bit, width, height, {
        archetype: options.archetype,
        colors: options.colors,
        minVolume: options.minVolume,
        speckleRescue: options.speckleRescue,
        shadowClamp: options.shadowClamp,
        trap: options.trap,
        onProgress,
    });

    log(`Archetype: ${result.config.meta?.archetypeId || 'unknown'} (score: ${result.config.meta?.matchScore || 'n/a'})`);
    log(`Palette: ${result.paletteLab.length} colors`);

    const outputFiles = [];
    const outputDir = options.output ? path.resolve(options.output) : inputDir;
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // Flat image (default output) — preserve 16-bit depth for PSD/TIFF input
    const sixteenBit = inputFormat === 'psd' || inputFormat === 'tiff';
    const flatPath = path.join(outputDir, `${basename}_reveal.png`);
    await writeFlat(result.colorIndices, result.paletteLab, width, height, flatPath, { sixteenBit });
    log(`Wrote: ${flatPath}${sixteenBit ? ' (16-bit)' : ''}`);
    outputFiles.push(flatPath);

    // PSD
    if (options.formats.has('psd')) {
        const psdPath = path.join(outputDir, `${basename}_reveal.psd`);
        const size = await writePsd(result.paletteLab, result.paletteRgb, result.masks, result.colorIndices, width, height, psdPath);
        log(`Wrote: ${psdPath} (${(size / 1024).toFixed(1)} KB)`);
        outputFiles.push(psdPath);
    }

    // ORA
    if (options.formats.has('ora')) {
        const oraPath = path.join(outputDir, `${basename}_reveal.ora`);
        const size = await writeOra(result.paletteLab, result.paletteRgb, result.masks, result.colorIndices, width, height, oraPath, result.hexColors);
        log(`Wrote: ${oraPath} (${(size / 1024).toFixed(1)} KB)`);
        outputFiles.push(oraPath);
    }

    // Plates
    if (options.formats.has('plates')) {
        const plateDir = options.output ? path.resolve(options.output) : inputDir;
        const platePaths = await writePlates(result.masks, result.hexColors, width, height, plateDir, basename);
        for (const p of platePaths) log(`Wrote: ${p}`);
        outputFiles.push(...platePaths);
    }

    // JSON sidecar
    if (options.json !== false) {
        const jsonPath = path.join(outputDir, `${basename}_reveal.json`);
        writeSidecar(jsonPath, result, {
            inputFile: path.basename(inputFile),
            outputFiles: outputFiles.map(f => path.basename(f)),
            trap: options.trap || 0,
        });
        log(`Wrote: ${jsonPath}`);
        outputFiles.push(jsonPath);
    }

    // Save recipe
    if (options.saveRecipe) {
        saveRecipe(options.saveRecipe, {
            archetype: result.config.meta?.archetypeId,
            colors: result.paletteLab.length,
            trap: options.trap,
            minVolume: result.config.minVolume,
            speckleRescue: result.config.speckleRescue,
            shadowClamp: result.config.shadowClamp,
        });
        log(`Saved recipe: ${options.saveRecipe}`);
    }
}

async function runCompare(lab16bit, width, height, basename, inputDir, inputFormat, options, log, verbose, inputFile) {
    // Shared DNA computation
    log('Computing DNA...');
    const dna = computeDna(lab16bit, width, height);

    // Auto-detect top archetype
    const { archetypeId: topMatch } = autoDetectArchetype(dna, width, height);

    const archetypes = ['chameleon', 'distilled', 'salamander', topMatch];
    // Deduplicate if top match is one of the pseudos
    const uniqueArchetypes = [...new Set(archetypes)];

    const rootOutputDir = options.output ? path.resolve(options.output) : inputDir;
    const parentDir = path.join(rootOutputDir, `${basename}_reveal`);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });

    const summaryRows = [];

    for (const archId of uniqueArchetypes) {
        const subDir = path.join(parentDir, archId);
        if (!fs.existsSync(subDir)) fs.mkdirSync(subDir, { recursive: true });

        log(`\n--- ${archId} ---`);

        const result = await processSingle(lab16bit, width, height, {
            archetype: archId,
            colors: options.colors,
            minVolume: options.minVolume,
            speckleRescue: options.speckleRescue,
            shadowClamp: options.shadowClamp,
            trap: options.trap,
            dna, // Shared DNA
            onProgress: (phase, msg) => verbose(`[${archId}/${phase}] ${msg}`),
        });

        // Write outputs in subdirectory — preserve 16-bit depth for PSD/TIFF input
        const sixteenBit = inputFormat === 'psd' || inputFormat === 'tiff';
        const subFlatPath = path.join(subDir, `${basename}.png`);
        await writeFlat(result.colorIndices, result.paletteLab, width, height, subFlatPath, { sixteenBit });

        // If this is the top DNA match, ALSO write to the root output directory
        // to satisfy integration tests and provide a convenient "best" result.
        if (archId === topMatch) {
            const rootFlatPath = path.join(rootOutputDir, `${basename}_reveal.png`);
            await writeFlat(result.colorIndices, result.paletteLab, width, height, rootFlatPath, { sixteenBit });
            log(`Wrote top match to root: ${rootFlatPath}`);

            const rootOutputFiles = [path.basename(rootFlatPath)];

            // Write requested formats to root too
            if (options.formats.has('psd')) {
                const rootPsdPath = path.join(rootOutputDir, `${basename}_reveal.psd`);
                await writePsd(result.paletteLab, result.paletteRgb, result.masks, result.colorIndices, width, height, rootPsdPath);
                rootOutputFiles.push(path.basename(rootPsdPath));
            }

            if (options.formats.has('ora')) {
                const rootOraPath = path.join(rootOutputDir, `${basename}_reveal.ora`);
                await writeOra(result.paletteLab, result.paletteRgb, result.masks, result.colorIndices, width, height, rootOraPath, result.hexColors);
                rootOutputFiles.push(path.basename(rootOraPath));
            }

            if (options.formats.has('plates')) {
                const rootPlatePaths = await writePlates(result.masks, result.hexColors, width, height, rootOutputDir, basename);
                rootOutputFiles.push(...rootPlatePaths.map(p => path.basename(p)));
            }

            if (options.json !== false) {
                const rootJsonPath = path.join(rootOutputDir, `${basename}_reveal.json`);
                writeSidecar(rootJsonPath, result, {
                    inputFile: path.basename(inputFile),
                    outputFiles: rootOutputFiles,
                    trap: options.trap || 0,
                });
            }

            // Save recipe if requested
            if (options.saveRecipe) {
                saveRecipe(options.saveRecipe, {
                    archetype: result.config.meta?.archetypeId,
                    colors: result.paletteLab.length,
                    trap: options.trap,
                    minVolume: result.config.minVolume,
                    speckleRescue: result.config.speckleRescue,
                    shadowClamp: result.config.shadowClamp,
                });
            }
        }

        if (options.formats.has('psd')) {
            await writePsd(result.paletteLab, result.paletteRgb, result.masks, result.colorIndices, width, height,
                path.join(subDir, `${basename}.psd`));
        }

        if (options.formats.has('ora')) {
            await writeOra(result.paletteLab, result.paletteRgb, result.masks, result.colorIndices, width, height,
                path.join(subDir, `${basename}.ora`), result.hexColors);
        }

        if (options.formats.has('plates')) {
            await writePlates(result.masks, result.hexColors, width, height, subDir, basename);
        }

        if (options.json !== false) {
            writeSidecar(path.join(subDir, `${basename}.json`), result, {
                inputFile: `${basename}${path.extname(basename)}`,
                trap: options.trap || 0,
            });
        }

        summaryRows.push({
            archetype: archId,
            score: result.config.meta?.matchScore || 'n/a',
            colors: result.paletteLab.length,
            dir: archId + '/',
        });

        log(`  ${result.paletteLab.length} colors → ${subDir}/`);
    }

    // Summary table
    log('\n┌─────────────────────┬────────┬────────┐');
    log('│ Archetype           │ Score  │ Colors │');
    log('├─────────────────────┼────────┼────────┤');
    for (const row of summaryRows) {
        const name = row.archetype.padEnd(19);
        const score = String(row.score).padStart(6);
        const colors = String(row.colors).padStart(6);
        log(`│ ${name} │ ${score} │ ${colors} │`);
    }
    log('└─────────────────────┴────────┴────────┘');
    log(`\nOutput: ${parentDir}/`);
}

program.parse();
