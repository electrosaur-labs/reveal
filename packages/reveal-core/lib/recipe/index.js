/**
 * Recipe Engine — Public API
 *
 * Four types for scriptable color separation:
 *   Image  — Immutable input (pixels + DNA)
 *   Engine — Reusable configuration
 *   Palette — Mutable working set (from quantize)
 *   Result  — Output with post-processing knobs
 *
 * @module recipe
 */

const Image = require('./Image');
const Engine = require('./Engine');
const { Palette, PaletteEntry } = require('./Palette');
const Result = require('./Result');

module.exports = { Image, Engine, Palette, PaletteEntry, Result };
