/**
 * SuggestionManager — Suggested color & ghost preview state for Navigator
 *
 * Owns cached suggestion colors, checked suggestions (user-promoted colors),
 * and ghost preview rendering. SessionState delegates suggestion operations here.
 */

const EventEmitter = require('./EventEmitter');
const Reveal = require('@electrosaur-labs/core');
const { applySuggestionGhost } = require('../utils/pixelProcessing');

// ΔE² threshold for "same suggestion" identity matching (4² = 16)
const SUGGESTION_MATCH_DE_SQ = 16;

class SuggestionManager extends EventEmitter {

    constructor() {
        super();
        this._proxyEngine = null;
        this._cachedSuggestions = null;
        this._checkedSuggestions = [];
        this._ghostLabColor = null;
        this._ghostMode = null;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    /** Bind to a ProxyEngine instance (called once per image load). */
    initialize(proxyEngine) {
        this._proxyEngine = proxyEngine;
    }

    reset() {
        this._proxyEngine = null;
        this._cachedSuggestions = null;
        this._checkedSuggestions = [];
        this._ghostLabColor = null;
        this._ghostMode = null;
    }

    /** Clear suggestions + ghost but preserve proxyEngine binding. */
    clearForSwap() {
        this._cachedSuggestions = null;
        this._checkedSuggestions = [];
        this._ghostLabColor = null;
        this._ghostMode = null;
    }

    // ─── State Access ────────────────────────────────────────

    get cachedSuggestions() { return this._cachedSuggestions; }
    set cachedSuggestions(v) { this._cachedSuggestions = v; }

    get checkedSuggestions() { return this._checkedSuggestions; }
    set checkedSuggestions(v) { this._checkedSuggestions = v; }

    get ghostLabColor() { return this._ghostLabColor || null; }
    get ghostMode() { return this._ghostMode || null; }

    // ─── Suggestion Colors ───────────────────────────────────

    /**
     * Get suggested colors that the engine found but couldn't include.
     * Surfaces underrepresented sectors, unmatched peaks, and chroma outliers.
     * @returns {Array<{L, a, b, source, reason, impactScore}>}
     */
    getSuggestedColors() {
        if (!this._proxyEngine) return [];
        if (this._cachedSuggestions) return this._cachedSuggestions;
        this._cachedSuggestions = this._proxyEngine.getSuggestedColors();
        return this._cachedSuggestions;
    }

    /** Mark a suggested color as "must be in final palette". */
    addCheckedSuggestion(labColor) {
        this._checkedSuggestions.push({ L: labColor.L, a: labColor.a, b: labColor.b });
    }

    /** Remove a checked suggestion by proximity (ΔE < 4). */
    removeCheckedSuggestion(labColor) {
        for (let i = 0; i < this._checkedSuggestions.length; i++) {
            const c = this._checkedSuggestions[i];
            const dL = labColor.L - c.L, da = labColor.a - c.a, db = labColor.b - c.b;
            if (dL * dL + da * da + db * db < SUGGESTION_MATCH_DE_SQ) {
                this._checkedSuggestions.splice(i, 1);
                return;
            }
        }
    }

    /** Check if a suggestion is already checked (ΔE < 4). */
    isSuggestionChecked(labColor) {
        for (const c of this._checkedSuggestions) {
            const dL = labColor.L - c.L, da = labColor.a - c.a, db = labColor.b - c.b;
            if (dL * dL + da * da + db * db < SUGGESTION_MATCH_DE_SQ) return true;
        }
        return false;
    }

    // ─── Ghost Preview ───────────────────────────────────────

    /**
     * Generate ghost preview: show which pixels a suggested color would capture.
     * For each pixel, checks if labColor is closer than the pixel's current assignment.
     * Pixels that would be captured → shown in labColor's RGB at full brightness.
     * Non-captured pixels: 'integrated' mode keeps palette color, 'solo' mode dims to #282828.
     *
     * @param {{L: number, a: number, b: number}} labColor - The suggested Lab color
     * @param {'integrated'|'solo'} [mode='integrated'] - Rendering mode
     * @returns {Uint8ClampedArray|null} RGBA buffer, or null if not ready
     */
    generateSuggestionGhostPreview(labColor, mode = 'integrated') {
        if (!this._proxyEngine || !this._proxyEngine.separationState) return null;

        const state = this._proxyEngine.separationState;
        const { colorIndices, palette, rgbPalette, width, height } = state;
        if (!colorIndices || !palette || !rgbPalette) return null;

        const proxyBuffer = this._proxyEngine.proxyBuffer;
        if (!proxyBuffer) return null;

        const pixelCount = width * height;
        const rgba = new Uint8ClampedArray(pixelCount * 4);
        const sugRgb = Reveal.labToRgbD50({ L: labColor.L, a: labColor.a, b: labColor.b });
        const solo = (mode === 'solo');

        // Pre-fill integrated mode with palette colors + alpha
        if (!solo) {
            for (let i = 0; i < pixelCount; i++) {
                const ci = colorIndices[i];
                const c = rgbPalette[ci];
                const off4 = i * 4;
                rgba[off4]     = c.r;
                rgba[off4 + 1] = c.g;
                rgba[off4 + 2] = c.b;
                rgba[off4 + 3] = 255;
            }
        } else {
            for (let i = 0; i < pixelCount; i++) {
                rgba[i * 4 + 3] = 255;
            }
        }

        applySuggestionGhost(rgba, pixelCount, proxyBuffer, colorIndices, palette, labColor, sugRgb, solo);

        return rgba;
    }

    /**
     * Set a suggestion ghost preview (triggered by clicking a suggested swatch).
     * Emits `ghostChanged` with a ghost buffer instead of a color index.
     * @param {{L: number, a: number, b: number}} labColor
     * @param {'integrated'|'solo'} [mode='integrated']
     */
    setSuggestionGhost(labColor, mode = 'integrated') {
        const ghostBuffer = this.generateSuggestionGhostPreview(labColor, mode);
        if (ghostBuffer) {
            this._ghostLabColor = { L: labColor.L, a: labColor.a, b: labColor.b };
            this._ghostMode = mode;
            this.emit('ghostChanged', { colorIndex: -2, ghostBuffer });
        }
    }

    /** Clear ghost state (called when highlight changes). */
    clearGhost() {
        this._ghostLabColor = null;
        this._ghostMode = null;
    }

    // ─── Serialization ───────────────────────────────────────

    snapshot() {
        return {
            checkedSuggestions: this._checkedSuggestions.map(c => ({ ...c }))
        };
    }

    restore(data) {
        if (!data) {
            this._cachedSuggestions = null;
            this._checkedSuggestions = [];
            return;
        }
        this._cachedSuggestions = null;
        this._checkedSuggestions = (data.checkedSuggestions || []).map(c => ({ ...c }));
    }
}

module.exports = SuggestionManager;
