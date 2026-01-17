#!/usr/bin/env node
/**
 * reveal-batch - Command-line batch processing for screen print color separation
 *
 * Uses @reveal/core engines for pure JavaScript posterization and separation.
 * Processes images with Sharp for file I/O and color space conversion.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');
const Reveal = require('@reveal/core');
const ImageProcessor = require('./ImageProcessor');

const program = new Command();

program
  .name('reveal-batch')
  .description('Batch process images for screen print color separation')
  .version('1.0.0');

program
  .command('process')
  .description('Process images for color separation')
  .argument('<input>', 'Input image file or directory')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('-c, --colors <number>', 'Number of colors (3-9)', '5')
  .option('-p, --preset <name>', 'Preset name (halftone-portrait, vibrant-graphic, etc.)')
  .option('--analyze', 'Auto-detect optimal color count', false)
  .option('--preview', 'Generate preview images', false)
  .option('--masks', 'Generate separation masks', false)
  .option('--width <number>', 'Max width for processing', '800')
  .option('--height <number>', 'Max height for processing', '800')
  .action(async (input, options) => {
    try {
      console.log(chalk.blue.bold('\n🎨 Reveal Batch Processor\n'));

      // Validate input
      if (!fs.existsSync(input)) {
        console.error(chalk.red(`Error: Input not found: ${input}`));
        process.exit(1);
      }

      // Parse options
      const colorCount = parseInt(options.colors, 10);
      if (isNaN(colorCount) || colorCount < 3 || colorCount > 9) {
        console.error(chalk.red('Error: Color count must be between 3 and 9'));
        process.exit(1);
      }

      const maxWidth = parseInt(options.width, 10);
      const maxHeight = parseInt(options.height, 10);

      // Create output directory
      if (!fs.existsSync(options.output)) {
        fs.mkdirSync(options.output, { recursive: true });
      }

      // Get list of files to process
      const files = [];
      const stats = fs.statSync(input);

      if (stats.isDirectory()) {
        const dirFiles = fs.readdirSync(input);
        for (const file of dirFiles) {
          if (/\.(jpg|jpeg|png|tif|tiff)$/i.test(file)) {
            files.push(path.join(input, file));
          }
        }
      } else if (stats.isFile()) {
        files.push(input);
      }

      if (files.length === 0) {
        console.error(chalk.red('Error: No valid image files found'));
        process.exit(1);
      }

      console.log(chalk.cyan(`Found ${files.length} image(s) to process\n`));

      // Process each file
      let successCount = 0;
      let errorCount = 0;

      for (const file of files) {
        try {
          console.log(chalk.yellow(`Processing: ${path.basename(file)}`));

          const processor = new ImageProcessor(file, {
            colorCount,
            preset: options.preset,
            autoDetect: options.analyze,
            maxWidth,
            maxHeight,
            outputDir: options.output,
            generatePreview: options.preview,
            generateMasks: options.masks
          });

          await processor.process();
          successCount++;
          console.log(chalk.green(`✓ Completed: ${path.basename(file)}\n`));

        } catch (error) {
          errorCount++;
          console.error(chalk.red(`✗ Failed: ${path.basename(file)}`));
          console.error(chalk.red(`  ${error.message}\n`));
        }
      }

      // Summary
      console.log(chalk.blue.bold('\n📊 Summary:'));
      console.log(chalk.green(`  ✓ Success: ${successCount}`));
      if (errorCount > 0) {
        console.log(chalk.red(`  ✗ Errors: ${errorCount}`));
      }
      console.log(chalk.cyan(`  📁 Output: ${options.output}\n`));

    } catch (error) {
      console.error(chalk.red(`\nFatal error: ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('analyze')
  .description('Analyze an image and recommend parameters')
  .argument('<input>', 'Input image file')
  .action(async (input) => {
    try {
      console.log(chalk.blue.bold('\n🔍 Image Analysis\n'));

      if (!fs.existsSync(input)) {
        console.error(chalk.red(`Error: File not found: ${input}`));
        process.exit(1);
      }

      const processor = new ImageProcessor(input, { maxWidth: 800, maxHeight: 800 });
      const analysis = await processor.analyze();

      console.log(chalk.cyan('Image Information:'));
      console.log(`  Dimensions: ${analysis.width}×${analysis.height}`);
      console.log(`  File size: ${(analysis.fileSize / 1024 / 1024).toFixed(2)} MB`);

      console.log(chalk.cyan('\nColor Analysis:'));
      console.log(`  Detected signature: ${chalk.yellow(analysis.signature)}`);
      console.log(`  Recommended preset: ${chalk.yellow(analysis.presetId)}`);
      console.log(`  Suggested colors: ${chalk.yellow(analysis.recommendedColors)}`);

      if (analysis.statistics) {
        console.log(chalk.cyan('\nStatistics:'));
        console.log(`  Max chroma: ${analysis.statistics.maxChroma.toFixed(1)}`);
        console.log(`  Dark pixels: ${(analysis.statistics.darkPixels || 0).toFixed(1)}%`);
        console.log(`  High chroma: ${(analysis.statistics.highChroma || 0).toFixed(1)}%`);
      }

      console.log('');

    } catch (error) {
      console.error(chalk.red(`\nError: ${error.message}`));
      process.exit(1);
    }
  });

program.parse();
