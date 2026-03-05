/**
 * @electrosaur-labs/psd-writer - Minimal PSD file writer for Lab color separations
 *
 * Uses local PSDWriter with RLE compression support.
 */

const PSDWriter = require('./PSDWriter');
const BinaryWriter = require('./BinaryWriter');

module.exports = {
    PSDWriter,
    BinaryWriter
};
