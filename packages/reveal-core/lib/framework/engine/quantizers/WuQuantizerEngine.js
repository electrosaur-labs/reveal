const LabMedianCut = require('../../../engines/LabMedianCut');

class WuQuantizerEngine {
    static quantize(pixels, config) {
        // --- FIXED: Wu is implemented as a splitMode in LabMedianCut ---
        const params = config || {};
        const targetColors = params.targetColors || 8;

        // Ensure splitMode is variance for Wu algorithm
        const wuConfig = {
            ...params,
            splitMode: 'variance'
        };

        // Reuse LabMedianCut logic with variance split mode
        return LabMedianCut.medianCutInLabSpace(
            pixels,
            targetColors,
            params.grayscaleOnly || false,
            null, // width
            null, // height
            params.substrate || null,
            params.substrateTolerance || 2.0,
            params.vibrancyMode || 'moderate',
            params.vibrancyBoost || 1.4,
            params.highlightThreshold || 90,
            params.highlightBoost || 1.5,
            params.strategy || params.centroidStrategy || 'SALIENCY',
            wuConfig
        );
    }
}

module.exports = WuQuantizerEngine;
