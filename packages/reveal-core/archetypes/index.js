/**
 * Archetypes Bundle - For UXP/Browser Environments
 * Auto-exports all archetype configurations as a JS module
 * (UXP doesn't have fs, so we can't dynamically load JSON files)
 */

// Import all archetype JSON files
const standardBalanced = require('./standard-balanced.json');
const softEthereal = require('./soft-ethereal.json');
const cinematicMoody = require('./cinematic-moody.json');
const brightDesaturated = require('./bright-desaturated.json');
const hardCommercial = require('./hard-commercial.json');
const mutedVintage = require('./muted-vintage.json');
const neonGraphic = require('./neon-graphic.json');
const noirShadow = require('./noir-shadow.json');
const pastelHighKey = require('./pastel-high-key.json');
const pureGraphic = require('./pure-graphic.json');
const silverGelatin = require('./silver-gelatin.json');
const vibrantHyper = require('./vibrant-hyper.json');
const vibrantTonal = require('./vibrant-tonal.json');
const warmTonalOptimized = require('./warm-tonal-optimized.json');
const yellowDominant = require('./yellow-dominant.json');

// Export array of all archetypes
module.exports = [
    standardBalanced,
    softEthereal,
    cinematicMoody,
    brightDesaturated,
    hardCommercial,
    mutedVintage,
    neonGraphic,
    noirShadow,
    pastelHighKey,
    pureGraphic,
    silverGelatin,
    vibrantHyper,
    vibrantTonal,
    warmTonalOptimized,
    yellowDominant
];
