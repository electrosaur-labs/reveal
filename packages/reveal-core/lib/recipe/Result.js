/**
 * Result — Separation output for the Recipe Engine.
 *
 * Produced by Engine.separate(). Contains the color index map,
 * palette snapshot, and lazy mask generation.
 * Mechanical knobs operate on this object without re-separating.
 *
 * @module recipe/Result
 */

const MechanicalKnobs = require('../engines/MechanicalKnobs');

// Valid knob keys
const VALID_KNOBS = new Set(['minVolume', 'speckleRescue', 'shadowClamp']);

// Knob ranges
const KNOB_RANGES = {
    minVolume:      { min: 0, max: 5,  label: 'minVolume (0-5%)' },
    speckleRescue:  { min: 0, max: 10, label: 'speckleRescue (0-10px)' },
    shadowClamp:    { min: 0, max: 20, label: 'shadowClamp (0-20%)' }
};

class Result {
    /**
     * @param {Object} opts
     * @param {Uint8Array} opts.colorIndices - Per-pixel palette index
     * @param {Array<Object>} opts.labPalette - Lab palette [{ L, a, b }, ...]
     * @param {number} opts.width - Image width
     * @param {number} opts.height - Image height
     * @param {Object} [opts.metadata] - Archetype, quantizer, DNA, timing info
     */
    constructor(opts) {
        if (!opts.colorIndices || !(opts.colorIndices instanceof Uint8Array)) {
            throw new Error('Result: colorIndices must be a Uint8Array');
        }
        if (!Array.isArray(opts.labPalette) || opts.labPalette.length === 0) {
            throw new Error('Result: labPalette must be a non-empty array');
        }
        if (!opts.width || !opts.height) {
            throw new Error('Result: width and height are required');
        }

        const expectedPixels = opts.width * opts.height;
        if (opts.colorIndices.length !== expectedPixels) {
            throw new Error(
                `Result: colorIndices length ${opts.colorIndices.length} does not match ` +
                `width×height (${opts.width}×${opts.height} = ${expectedPixels})`
            );
        }

        /** @type {Uint8Array} Per-pixel palette index */
        this.colorIndices = opts.colorIndices;

        /** @type {Array<Object>} Lab palette snapshot */
        this.palette = opts.labPalette.map(c => ({ L: c.L, a: c.a, b: c.b }));

        /** @type {number} */
        this.width = opts.width;

        /** @type {number} */
        this.height = opts.height;

        /** @type {Object} */
        this.metadata = opts.metadata || {};

        // Baseline snapshot for knob reset
        this._baseline = new Uint8Array(this.colorIndices);
    }

    /**
     * Apply mechanical knobs to the color index map.
     * Operates on the baseline (clean) state — each call resets to baseline first.
     * Throws on unrecognized keys or out-of-range values.
     *
     * @param {Object} settings - { minVolume?, speckleRescue?, shadowClamp? }
     */
    applyKnobs(settings) {
        if (!settings || typeof settings !== 'object') {
            throw new Error('Result.applyKnobs: settings must be an object');
        }

        // Validate keys
        for (const key of Object.keys(settings)) {
            if (!VALID_KNOBS.has(key)) {
                throw new Error(
                    `Result.applyKnobs: unrecognized knob "${key}". ` +
                    `Valid knobs: ${[...VALID_KNOBS].join(', ')}`
                );
            }
        }

        // Validate ranges
        for (const [key, value] of Object.entries(settings)) {
            if (typeof value !== 'number') {
                throw new Error(`Result.applyKnobs: ${key} must be a number, got ${typeof value}`);
            }
            const range = KNOB_RANGES[key];
            if (value < range.min || value > range.max) {
                throw new Error(
                    `Result.applyKnobs: ${key} must be ${range.min}-${range.max}, got ${value}`
                );
            }
        }

        // Reset to baseline before applying
        this.colorIndices.set(this._baseline);

        const pixelCount = this.width * this.height;

        // Apply in order: minVolume → speckleRescue → shadowClamp
        if (settings.minVolume !== undefined && settings.minVolume > 0) {
            MechanicalKnobs.applyMinVolume(
                this.colorIndices, this.palette, pixelCount, settings.minVolume
            );
        }

        // speckleRescue and shadowClamp operate on per-color masks
        const needsMasks = (settings.speckleRescue > 0) || (settings.shadowClamp > 0);
        if (needsMasks) {
            const masks = this._generateMasks();

            if (settings.speckleRescue !== undefined && settings.speckleRescue > 0) {
                MechanicalKnobs.applySpeckleRescue(
                    masks, this.colorIndices, this.width, this.height, settings.speckleRescue
                );
            }

            if (settings.shadowClamp !== undefined && settings.shadowClamp > 0) {
                MechanicalKnobs.applyShadowClamp(
                    masks, this.colorIndices, this.palette, this.width, this.height, settings.shadowClamp
                );
            }

            // Rebuild colorIndices from mutated masks
            this._rebuildIndicesFromMasks(masks);
        }
    }

    /**
     * Generate a binary mask for a single color (lazy).
     *
     * @param {number} colorIndex - Palette index
     * @returns {Uint8Array} Binary mask: 255 where color present, 0 elsewhere
     */
    /**
     * Generate per-color binary masks from colorIndices.
     * @private
     * @returns {Array<Uint8Array>}
     */
    _generateMasks() {
        const pixelCount = this.width * this.height;
        const masks = [];
        for (let c = 0; c < this.palette.length; c++) {
            masks.push(new Uint8Array(pixelCount));
        }
        for (let i = 0; i < pixelCount; i++) {
            const idx = this.colorIndices[i];
            if (idx < masks.length) {
                masks[idx][i] = 255;
            }
        }
        return masks;
    }

    /**
     * Rebuild colorIndices from mutated masks (winner-takes-all).
     * @private
     * @param {Array<Uint8Array>} masks
     */
    _rebuildIndicesFromMasks(masks) {
        const pixelCount = this.width * this.height;
        for (let i = 0; i < pixelCount; i++) {
            // Find first mask with value > 0 (masks are mutually exclusive after knobs)
            let found = false;
            for (let c = 0; c < masks.length; c++) {
                if (masks[c][i] > 0) {
                    this.colorIndices[i] = c;
                    found = true;
                    break;
                }
            }
            // If no mask claims this pixel (despeckled away), keep existing index
        }
    }

    getMask(colorIndex) {
        if (!Number.isInteger(colorIndex) || colorIndex < 0 || colorIndex >= this.palette.length) {
            throw new Error(
                `Result.getMask: colorIndex must be 0-${this.palette.length - 1}, got ${colorIndex}`
            );
        }

        const mask = new Uint8Array(this.width * this.height);
        for (let i = 0; i < this.colorIndices.length; i++) {
            if (this.colorIndices[i] === colorIndex) {
                mask[i] = 255;
            }
        }
        return mask;
    }
}

module.exports = Result;
