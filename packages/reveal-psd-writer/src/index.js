/**
 * @reveal/psd-writer - Minimal PSD file writer for Lab color separations
 *
 * ARCHITECTURE: This package now re-exports from @reveal/core for better
 * separation of concerns. Format logic lives in core, this package provides
 * backward compatibility and convenience exports.
 */

const PSDWriter = require('@reveal/core/lib/formats/psd/PSDWriter');
const BinaryWriter = require('@reveal/core/lib/formats/psd/BinaryWriter');

module.exports = {
    PSDWriter,
    BinaryWriter
};
