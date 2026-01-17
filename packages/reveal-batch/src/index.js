/**
 * reveal-batch - Main entry point
 *
 * Can be used as a library or CLI tool
 */

const ImageProcessor = require('./ImageProcessor');
const Reveal = require('@reveal/core');

module.exports = {
  ImageProcessor,
  Reveal
};
