/**
 * Palette — Mutable working set for the Recipe Engine.
 *
 * Produced by Engine.quantize(). The only mutable object in the pipeline.
 * Supports surgery operations: find, merge, remove, add, edit.
 *
 * Colors are stored in perceptual Lab ({ L, a, b }) internally.
 *
 * @module recipe/Palette
 */

const LabEncoding = require('../color/LabEncoding');

// Maximum ΔE for hex/Lab proximity matching
const DEFAULT_MATCH_THRESHOLD = 5;

// Valid PaletteEntry setter keys
const ENTRY_SETTABLE = new Set(['weight', 'name', 'lab', 'locked']);

class PaletteEntry {
    /**
     * @param {number} index - Position in palette
     * @param {Object} lab - { L, a, b } perceptual Lab
     * @param {Object} [opts] - Optional: name, coverage, weight
     */
    constructor(index, lab, opts = {}) {
        this.index = index;
        this.L = lab.L;
        this.a = lab.a;
        this.b = lab.b;
        this.name = opts.name || null;
        this.coverage = opts.coverage || 0;
        this.weight = opts.weight || 1.0;
        this.locked = false;

        // Compute RGB + hex
        const rgb = LabEncoding.labToRgb({ L: this.L, a: this.a, b: this.b });
        this.hex = LabEncoding.rgbToHex(rgb.r, rgb.g, rgb.b).toUpperCase();
    }

    /**
     * Set the SALIENCY weight for this color.
     * @param {number} w - Weight value (> 0)
     */
    setWeight(w) {
        if (typeof w !== 'number' || w <= 0) {
            throw new Error(`PaletteEntry.setWeight: weight must be a positive number, got ${w}`);
        }
        this.weight = w;
    }

    /**
     * Set a display name for this color.
     * @param {string} n - Name string
     */
    setName(n) {
        if (typeof n !== 'string') {
            throw new Error(`PaletteEntry.setName: name must be a string, got ${typeof n}`);
        }
        this.name = n;
    }

    /**
     * Nudge the Lab centroid.
     * @param {number} L - Lightness 0-100
     * @param {number} a - Green-red axis -128..+127
     * @param {number} b - Blue-yellow axis -128..+127
     */
    setLab(L, a, b) {
        if (typeof L !== 'number' || typeof a !== 'number' || typeof b !== 'number') {
            throw new Error('PaletteEntry.setLab: L, a, b must all be numbers');
        }
        if (L < 0 || L > 100) {
            throw new Error(`PaletteEntry.setLab: L must be 0-100, got ${L}`);
        }
        if (a < -128 || a > 127) {
            throw new Error(`PaletteEntry.setLab: a must be -128..+127, got ${a}`);
        }
        if (b < -128 || b > 127) {
            throw new Error(`PaletteEntry.setLab: b must be -128..+127, got ${b}`);
        }
        this.L = L;
        this.a = a;
        this.b = b;
        // Recompute hex
        const rgb = LabEncoding.labToRgb({ L, a, b });
        this.hex = LabEncoding.rgbToHex(rgb.r, rgb.g, rgb.b).toUpperCase();
    }

    /**
     * Lock this color to protect from merge/remove.
     */
    lock() {
        this.locked = true;
    }

    /**
     * Unlock this color.
     */
    unlock() {
        this.locked = false;
    }
}


class Palette {
    /**
     * Create a Palette from an array of Lab colors.
     *
     * @param {Array<Object>} labColors - Array of { L, a, b } perceptual Lab colors
     * @param {Object} [opts] - Optional metadata per color: { names, coverages }
     */
    constructor(labColors, opts = {}) {
        if (!Array.isArray(labColors) || labColors.length === 0) {
            throw new Error('Palette: labColors must be a non-empty array');
        }

        this._entries = labColors.map((lab, i) => {
            if (typeof lab.L !== 'number' || typeof lab.a !== 'number' || typeof lab.b !== 'number') {
                throw new Error(`Palette: color at index ${i} must have numeric L, a, b properties`);
            }
            return new PaletteEntry(i, lab, {
                name: opts.names ? opts.names[i] : null,
                coverage: opts.coverages ? opts.coverages[i] : 0
            });
        });
    }

    /**
     * Read-only snapshot of current palette entries.
     * Returns copies to prevent direct mutation of internal array.
     */
    get colors() {
        return this._entries.map(e => ({
            index: e.index,
            l: e.L,
            a: e.a,
            b: e.b,
            hex: e.hex,
            name: e.name,
            coverage: e.coverage,
            weight: e.weight,
            locked: e.locked
        }));
    }

    /**
     * Number of colors in the palette.
     */
    get length() {
        return this._entries.length;
    }

    /**
     * Find a color by hex, index, or Lab proximity.
     * Throws if no match found.
     *
     * @param {string|number|Object} query - Hex string, index number, or { l, a, b } object
     * @returns {PaletteEntry}
     */
    find(query) {
        const entry = this._resolve(query);
        if (!entry) {
            throw new Error(`Palette.find: no color matching "${JSON.stringify(query)}"`);
        }
        return entry;
    }

    /**
     * Check if a color exists without throwing.
     *
     * @param {string|number|Object} query
     * @returns {boolean}
     */
    has(query) {
        return this._resolve(query) !== null;
    }

    /**
     * Merge source color into target. Source is removed.
     * Throws if either color not found or if source is locked.
     *
     * @param {string|number|Object} sourceQuery
     * @param {string|number|Object} targetQuery
     */
    merge(sourceQuery, targetQuery) {
        const source = this.find(sourceQuery);
        const target = this.find(targetQuery);

        if (source === target) {
            throw new Error('Palette.merge: cannot merge a color into itself');
        }
        if (source.locked) {
            throw new Error(`Palette.merge: source color "${source.hex}" is locked`);
        }

        // Remove source, keep target
        this._entries = this._entries.filter(e => e !== source);
        this._reindex();
    }

    /**
     * Remove a color from the palette.
     * Throws if not found or if locked.
     *
     * @param {string|number|Object} query
     */
    remove(query) {
        const entry = this.find(query);

        if (entry.locked) {
            throw new Error(`Palette.remove: color "${entry.hex}" is locked`);
        }
        if (this._entries.length <= 1) {
            throw new Error('Palette.remove: cannot remove the last color');
        }

        this._entries = this._entries.filter(e => e !== entry);
        this._reindex();
    }

    /**
     * Add a color to the palette.
     *
     * @param {Object|string} color - { l, a, b, name? } or hex string
     */
    add(color) {
        let lab, name;

        if (typeof color === 'string') {
            // Hex string → RGB → Lab
            const hex = color.startsWith('#') ? color : '#' + color;
            if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) {
                throw new Error(`Palette.add: invalid hex color "${color}"`);
            }
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            lab = LabEncoding.rgbToLab({ r, g, b });
            name = null;
        } else if (color && typeof color === 'object') {
            // Accept both { L, a, b } and { l, a, b }
            const L = color.L !== undefined ? color.L : color.l;
            if (typeof L !== 'number' || typeof color.a !== 'number' || typeof color.b !== 'number') {
                throw new Error('Palette.add: color must have numeric L (or l), a, b properties');
            }
            lab = { L, a: color.a, b: color.b };
            name = color.name || null;
        } else {
            throw new Error(`Palette.add: expected hex string or {l, a, b} object, got ${typeof color}`);
        }

        const newIndex = this._entries.length;
        const entry = new PaletteEntry(newIndex, lab, { name });
        this._entries.push(entry);
        return entry;
    }

    // ─── Internal ───

    /**
     * Resolve a query to a PaletteEntry or null.
     * @private
     */
    _resolve(query) {
        if (typeof query === 'number') {
            // By index
            if (!Number.isInteger(query) || query < 0 || query >= this._entries.length) {
                return null;
            }
            return this._entries[query];
        }

        if (typeof query === 'string') {
            // By hex — find nearest within threshold
            const hex = query.toUpperCase().startsWith('#') ? query.toUpperCase() : '#' + query.toUpperCase();
            // First try exact match
            const exact = this._entries.find(e => e.hex === hex);
            if (exact) return exact;

            // Fuzzy: convert hex to Lab, find nearest
            if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
                const r = parseInt(hex.slice(1, 3), 16);
                const g = parseInt(hex.slice(3, 5), 16);
                const b = parseInt(hex.slice(5, 7), 16);
                const lab = LabEncoding.rgbToLab({ r, g, b });
                return this._findNearest(lab, DEFAULT_MATCH_THRESHOLD);
            }
            return null;
        }

        if (query && typeof query === 'object') {
            // By Lab proximity — accept { L, a, b } or { l, a, b }
            const L = query.L !== undefined ? query.L : query.l;
            if (typeof L !== 'number' || typeof query.a !== 'number') {
                return null;
            }
            return this._findNearest({ L, a: query.a, b: query.b || 0 }, Infinity);
        }

        return null;
    }

    /**
     * Find the nearest entry within a ΔE threshold.
     * @private
     */
    _findNearest(lab, maxDeltaE) {
        let best = null;
        let bestDist = maxDeltaE * maxDeltaE; // squared threshold

        for (const entry of this._entries) {
            const dL = entry.L - lab.L;
            const da = entry.a - lab.a;
            const db = entry.b - lab.b;
            const distSq = dL * dL + da * da + db * db;
            if (distSq < bestDist) {
                bestDist = distSq;
                best = entry;
            }
        }
        return best;
    }

    /**
     * Reindex entries after mutation.
     * @private
     */
    _reindex() {
        this._entries.forEach((e, i) => { e.index = i; });
    }
}

module.exports = { Palette, PaletteEntry };
