/**
 * Image — Immutable input for the Recipe Engine.
 *
 * Wraps Lab pixel data, dimensions, and computed DNA.
 * Frozen for the lifetime of a recipe execution.
 * The recipe receives this as a read-only argument.
 *
 * @module recipe/Image
 */

const DNAGenerator = require('../analysis/DNAGenerator');

// Keys allowed in the constructor options
const ALLOWED_KEYS = new Set([
    'labPixels', 'width', 'height', 'bitDepth', 'colorSpace', 'filename'
]);

class Image {
    /**
     * @param {Object} opts
     * @param {Uint16Array|Float32Array} opts.labPixels - Raw Lab pixel data (L,a,b triples)
     * @param {number} opts.width - Image width in pixels
     * @param {number} opts.height - Image height in pixels
     * @param {number} [opts.bitDepth=16] - Bit depth (8 or 16)
     * @param {string} [opts.colorSpace='Lab'] - Color space identifier
     * @param {string} [opts.filename] - Optional source filename
     */
    constructor(opts) {
        // Validate: no unrecognized keys
        for (const key of Object.keys(opts)) {
            if (!ALLOWED_KEYS.has(key)) {
                throw new Error(`Image: unrecognized option "${key}". Valid options: ${[...ALLOWED_KEYS].join(', ')}`);
            }
        }

        // Validate required fields
        if (!opts.labPixels) {
            throw new Error('Image: labPixels is required');
        }
        if (!opts.width || !Number.isInteger(opts.width) || opts.width <= 0) {
            throw new Error(`Image: width must be a positive integer, got ${opts.width}`);
        }
        if (!opts.height || !Number.isInteger(opts.height) || opts.height <= 0) {
            throw new Error(`Image: height must be a positive integer, got ${opts.height}`);
        }

        const expectedLength = opts.width * opts.height * 3;
        if (opts.labPixels.length !== expectedLength) {
            throw new Error(
                `Image: labPixels length ${opts.labPixels.length} does not match ` +
                `width×height×3 (${opts.width}×${opts.height}×3 = ${expectedLength})`
            );
        }

        const bitDepth = opts.bitDepth || 16;
        if (bitDepth !== 8 && bitDepth !== 16) {
            throw new Error(`Image: bitDepth must be 8 or 16, got ${bitDepth}`);
        }

        /** @type {Uint16Array|Float32Array} */
        this.labPixels = opts.labPixels;

        /** @type {number} */
        this.width = opts.width;

        /** @type {number} */
        this.height = opts.height;

        /** @type {number} */
        this.bitDepth = bitDepth;

        /** @type {string} */
        this.colorSpace = opts.colorSpace || 'Lab';

        /** @type {string|undefined} */
        this.filename = opts.filename;

        // Compute DNA from pixels
        const dnaGen = new DNAGenerator();
        const dna = dnaGen.generate(this.labPixels, this.width, this.height, {
            bitDepth: this.bitDepth
        });

        /** @type {Object} DNA v2.0 structure */
        this.dna = dna;

        /** @type {Object} 12 hue sectors from DNA */
        this.sectors = dna.sectors;

        // Freeze the object — immutable after construction
        Object.freeze(this);
    }
}

module.exports = Image;
