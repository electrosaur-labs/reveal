/**
 * ImageProcessor - Handles image I/O and processing with Sharp + @reveal/core
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const Reveal = require('@reveal/core');
const LabConverter = require('@reveal/core/lib/utils/LabConverter');

class ImageProcessor {
  constructor(inputPath, options = {}) {
    this.inputPath = inputPath;
    this.options = {
      colorCount: options.colorCount || 5,
      preset: options.preset || null,
      autoDetect: options.autoDetect || false,
      maxWidth: options.maxWidth || 800,
      maxHeight: options.maxHeight || 800,
      outputDir: options.outputDir || './output',
      generatePreview: options.generatePreview || false,
      generateMasks: options.generateMasks || false
    };

    this.basename = path.basename(inputPath, path.extname(inputPath));
  }

  /**
   * Load image and convert to Lab color space
   */
  async loadImage() {
    const image = sharp(this.inputPath);
    const metadata = await image.metadata();

    // Calculate scale to fit within max dimensions
    const scale = Math.min(
      1.0,
      this.options.maxWidth / metadata.width,
      this.options.maxHeight / metadata.height
    );

    const scaledWidth = Math.round(metadata.width * scale);
    const scaledHeight = Math.round(metadata.height * scale);

    // Convert to Lab color space
    // Sharp outputs Lab as 3 channels: L (0-100), a (-128 to 127), b (-128 to 127)
    const labBuffer = await image
      .resize(scaledWidth, scaledHeight, { fit: 'inside' })
      .toColorspace('lab')
      .raw()
      .toBuffer();

    // Convert Sharp Lab format to Photoshop encoding (0-255)
    const labPixels = LabConverter.sharpToPhotoshop(labBuffer);

    return {
      pixels: labPixels,
      width: scaledWidth,
      height: scaledHeight,
      originalWidth: metadata.width,
      originalHeight: metadata.height,
      fileSize: metadata.size
    };
  }

  /**
   * Analyze image and recommend parameters
   */
  async analyze() {
    const { pixels, width, height, originalWidth, originalHeight, fileSize } = await this.loadImage();

    // Run heuristic analysis
    const analysis = Reveal.analyzeImage(pixels, width, height);

    return {
      width: originalWidth,
      height: originalHeight,
      fileSize,
      signature: analysis.label,
      presetId: analysis.presetId,
      recommendedColors: this.getRecommendedColorCount(analysis.presetId),
      statistics: analysis.statistics
    };
  }

  /**
   * Get recommended color count for preset
   */
  getRecommendedColorCount(presetId) {
    const recommendations = {
      'halftone-portrait': 5,
      'vibrant-graphic': 7,
      'deep-shadow-noir': 4,
      'pastel-high-key': 6,
      'standard-image': 5
    };
    return recommendations[presetId] || 5;
  }

  /**
   * Process image through full workflow
   */
  async process() {
    const startTime = Date.now();

    // Load image
    console.log('  Loading image...');
    const { pixels, width, height } = await this.loadImage();

    // Auto-detect or use specified color count
    let colorCount = this.options.colorCount;
    let presetParams = null;

    if (this.options.autoDetect) {
      console.log('  Analyzing image...');
      const analysis = Reveal.analyzeImage(pixels, width, height);
      colorCount = this.getRecommendedColorCount(analysis.presetId);
      presetParams = Reveal.getPresetParameters(analysis.presetId);
      console.log(`  Detected: ${analysis.label} → ${colorCount} colors`);
    } else if (this.options.preset) {
      presetParams = Reveal.getPresetParameters(this.options.preset);
      if (!presetParams) {
        throw new Error(`Unknown preset: ${this.options.preset}`);
      }
    }

    // Posterize
    console.log(`  Posterizing to ${colorCount} colors...`);
    const posterResult = await Reveal.posterizeImage(
      pixels,
      width,
      height,
      colorCount,
      presetParams || {}
    );

    // Generate preview if requested
    if (this.options.generatePreview) {
      console.log('  Generating preview...');
      const previewRGBA = Reveal.generatePreview(
        pixels,
        posterResult.labPalette,
        posterResult.rgbPalette
      );

      // Convert RGBA to PNG
      const previewPath = path.join(this.options.outputDir, `${this.basename}-preview.png`);
      await sharp(Buffer.from(previewRGBA), {
        raw: { width, height, channels: 4 }
      })
        .png()
        .toFile(previewPath);
    }

    // Generate separation masks if requested
    if (this.options.generateMasks) {
      console.log('  Generating separation masks...');
      const separation = await Reveal.separateImage(pixels, posterResult.labPalette);

      for (let i = 0; i < posterResult.labPalette.length; i++) {
        const mask = Reveal.generateMask(separation.colorIndices, i, width, height);
        const color = posterResult.rgbPalette[i];
        const colorHex = `${color.r.toString(16).padStart(2, '0')}${color.g.toString(16).padStart(2, '0')}${color.b.toString(16).padStart(2, '0')}`;

        const maskPath = path.join(
          this.options.outputDir,
          `${this.basename}-mask-${i + 1}-${colorHex}.png`
        );

        await sharp(Buffer.from(mask), {
          raw: { width, height, channels: 1 }
        })
          .png()
          .toFile(maskPath);
      }
    }

    // Save palette info
    const infoPath = path.join(this.options.outputDir, `${this.basename}-palette.json`);
    fs.writeFileSync(infoPath, JSON.stringify({
      colors: posterResult.rgbPalette.map((rgb, i) => ({
        index: i,
        rgb,
        lab: posterResult.labPalette[i],
        hex: `#${rgb.r.toString(16).padStart(2, '0')}${rgb.g.toString(16).padStart(2, '0')}${rgb.b.toString(16).padStart(2, '0')}`
      })),
      statistics: posterResult.statistics,
      processingTime: Date.now() - startTime
    }, null, 2));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`  Processing time: ${elapsed}s`);
  }
}

module.exports = ImageProcessor;
