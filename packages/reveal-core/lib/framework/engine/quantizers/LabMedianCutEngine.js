const RevealCore = require('../../../../index');
const LabMedianCut = require('../../../engines/LabMedianCut');

class LabMedianCutEngine {
    static quantize(pixels, config) {
        // --- FIXED: No redundant normalization. Pixels arrive pre-normalized (perceptual) from PipelineEngine. ---
        const params = config || {};

        // LabMedianCut._calculateBoxMetadata accesses config.split.vibrancyBoost etc.
        const nestedConfig = {
            split: {
                highlightBoost: params.highlightBoost !== undefined ? params.highlightBoost : 2.2,
                vibrancyBoost: params.vibrancyBoost !== undefined ? params.vibrancyBoost : 1.6,
                minVariance: params.minVariance || 10,
                chromaAxisWeight: params.chromaAxisWeight || 0,
                neutralIsolationThreshold: params.neutralIsolationThreshold || 0,
                warmABoost: params.warmABoost || 1.0,
                splitMode: params.splitMode || 'median',
                quantizer: params.quantizer || 'median-cut'
            },
            prune: {
                threshold: params.paletteReduction || 9.0,
                hueLockAngle: params.hueLockAngle || 18,
                whitePoint: params.highlightThreshold || 85,
                shadowPoint: params.shadowPoint || 15,
                isolationThreshold: params.isolationThreshold || 0.0
            },
            centroid: {
                lWeight: params.lWeight !== undefined ? params.lWeight : 1.1,
                cWeight: params.cWeight !== undefined ? params.cWeight : 2.0,
                blackBias: params.blackBias !== undefined ? params.blackBias : 5.0,
                vibrancyMode: params.vibrancyMode || 'aggressive',
                vibrancyBoost: params.vibrancyBoost !== undefined ? params.vibrancyBoost : 1.6,
                bitDepth: params.bitDepth || 16
            }
        };

        const strategy = params.strategy || params.centroidStrategy || 'SALIENCY';

        return LabMedianCut.medianCutInLabSpace(
            pixels,
            params.targetColors || 8,
            params.grayscaleOnly || false,
            null, // width
            null, // height
            params.substrate || null,
            params.substrateTolerance || 2.0,
            params.vibrancyMode || 'moderate',
            params.vibrancyBoost || 1.4,
            params.highlightThreshold || 90,
            params.highlightBoost || 1.5,
            strategy, 
            nestedConfig
        );
    }
}

module.exports = LabMedianCutEngine;
