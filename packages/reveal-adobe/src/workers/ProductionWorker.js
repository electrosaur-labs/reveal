/**
 * ProductionWorker - Background high-res rendering
 *
 * Offloads production posterization to prevent UI freeze.
 * Note: UXP plugins don't support Web Workers, so this is a conceptual
 * implementation that can be adapted to use async operations.
 *
 * @module ProductionWorker
 */

import { PosterizationEngine } from '@reveal/core/engines/PosterizationEngine.js';
import { SeparationEngine } from '@reveal/core/engines/SeparationEngine.js';

/**
 * Run production posterization (high-res, full pipeline)
 * @param {Object} payload - Render payload
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<Object>} Production result
 */
export async function renderProduction(payload, onProgress) {
    const { labPixels, width, height, config } = payload;

    console.log(`[ProductionWorker] Starting production render: ${width}x${height}`);

    try {
        // Progress: Starting
        if (onProgress) onProgress(0.1);

        // Run posterization
        const posterizeResult = await PosterizationEngine.posterize(
            labPixels,
            width,
            height,
            config.targetColors,
            config
        );

        if (onProgress) onProgress(0.5);

        // Run separation
        const separateResult = await SeparationEngine.separateImage(
            labPixels,
            posterizeResult.labPalette,
            width,
            height,
            config
        );

        if (onProgress) onProgress(0.9);

        // Apply post-processing
        const finalResult = await applyPostProcessing(
            separateResult,
            posterizeResult,
            config
        );

        if (onProgress) onProgress(1.0);

        console.log(`[ProductionWorker] Production render complete: ${finalResult.palette.length} colors`);

        return {
            palette: posterizeResult.labPalette,
            rgbPalette: posterizeResult.rgbPalette,
            colorIndices: finalResult.colorIndices,
            masks: finalResult.masks,
            statistics: posterizeResult.statistics,
            width,
            height
        };

    } catch (error) {
        console.error('[ProductionWorker] Render failed:', error);
        throw error;
    }
}

/**
 * Apply post-processing (minVolume, speckleRescue, shadowClamp)
 * @private
 */
async function applyPostProcessing(separateResult, posterizeResult, config) {
    let { colorIndices, masks } = separateResult;
    let { labPalette } = posterizeResult;

    const width = separateResult.width || config.width;
    const height = separateResult.height || config.height;

    // Apply minVolume pruning
    if (config.minVolume > 0) {
        const pruned = await applyMinVolumePruning(
            colorIndices,
            masks,
            labPalette,
            width,
            height,
            config.minVolume
        );
        colorIndices = pruned.colorIndices;
        masks = pruned.masks;
        labPalette = pruned.palette;
    }

    // Apply speckleRescue erosion
    if (config.speckleRescue > 0) {
        masks = await applySpeckleRescue(masks, width, height, config.speckleRescue);
    }

    // Apply shadowClamp
    if (config.shadowClamp > 0) {
        masks = await applyShadowClamp(masks, config.shadowClamp);
    }

    return {
        colorIndices,
        masks,
        palette: labPalette
    };
}

/**
 * Apply minVolume pruning to production result
 * @private
 */
async function applyMinVolumePruning(colorIndices, masks, palette, width, height, minVolumePercent) {
    console.log(`[ProductionWorker] Applying minVolume: ${minVolumePercent}%`);

    const totalPixels = width * height;
    const minPixels = Math.round(totalPixels * minVolumePercent / 100);

    // Count pixels per color
    const colorCounts = new Array(palette.length).fill(0);
    for (let i = 0; i < colorIndices.length; i++) {
        colorCounts[colorIndices[i]]++;
    }

    // Identify weak colors
    const weakIndices = [];
    const strongIndices = [];
    colorCounts.forEach((count, idx) => {
        if (count < minPixels && count > 0) {
            weakIndices.push(idx);
        } else if (count >= minPixels) {
            strongIndices.push(idx);
        }
    });

    if (weakIndices.length === 0) {
        console.log(`[ProductionWorker] No colors below threshold`);
        return { colorIndices, masks, palette };
    }

    console.log(`[ProductionWorker] Pruning ${weakIndices.length} weak colors`);

    // Build remapping table
    const remapTable = new Array(palette.length);
    for (let i = 0; i < remapTable.length; i++) {
        remapTable[i] = i;
    }

    // Remap weak to nearest strong
    for (const weakIdx of weakIndices) {
        const weakColor = palette[weakIdx];
        let nearestStrongIdx = strongIndices[0];
        let minDist = Infinity;

        for (const strongIdx of strongIndices) {
            const strongColor = palette[strongIdx];
            const dL = weakColor.L - strongColor.L;
            const da = weakColor.a - strongColor.a;
            const db = weakColor.b - strongColor.b;
            const dist = Math.sqrt(dL * dL + da * da + db * db);

            if (dist < minDist) {
                minDist = dist;
                nearestStrongIdx = strongIdx;
            }
        }

        remapTable[weakIdx] = nearestStrongIdx;
    }

    // Apply remapping
    const newColorIndices = new Uint8Array(colorIndices.length);
    for (let i = 0; i < colorIndices.length; i++) {
        newColorIndices[i] = remapTable[colorIndices[i]];
    }

    // Rebuild palette
    const newPalette = [];
    const indexMapping = new Map();

    for (let i = 0; i < palette.length; i++) {
        if (!weakIndices.includes(i)) {
            indexMapping.set(i, newPalette.length);
            newPalette.push(palette[i]);
        }
    }

    // Final remap to new indices
    for (let i = 0; i < newColorIndices.length; i++) {
        newColorIndices[i] = indexMapping.get(newColorIndices[i]);
    }

    // Rebuild masks
    const newMasks = [];
    for (let i = 0; i < newPalette.length; i++) {
        newMasks.push(new Uint8Array(totalPixels));
    }

    for (let i = 0; i < totalPixels; i++) {
        const colorIdx = newColorIndices[i];
        newMasks[colorIdx][i] = 255;
    }

    console.log(`[ProductionWorker] Pruned to ${newPalette.length} colors`);

    return {
        colorIndices: newColorIndices,
        masks: newMasks,
        palette: newPalette
    };
}

/**
 * Apply speckle rescue (erosion) to masks
 * @private
 */
async function applySpeckleRescue(masks, width, height, radiusPixels) {
    console.log(`[ProductionWorker] Applying speckleRescue: ${radiusPixels}px`);

    const erodedMasks = [];

    for (const mask of masks) {
        const eroded = erodeMask(mask, width, height, radiusPixels);
        erodedMasks.push(eroded);
    }

    return erodedMasks;
}

/**
 * Apply shadow clamp to masks
 * @private
 */
async function applyShadowClamp(masks, clampPercent) {
    console.log(`[ProductionWorker] Applying shadowClamp: ${clampPercent}%`);

    const clampValue = Math.round(clampPercent * 255 / 100);

    const clampedMasks = masks.map(mask => {
        const clamped = new Uint8Array(mask.length);
        for (let i = 0; i < mask.length; i++) {
            const val = mask[i];
            if (val > 0 && val < clampValue) {
                clamped[i] = clampValue;
            } else {
                clamped[i] = val;
            }
        }
        return clamped;
    });

    return clampedMasks;
}

/**
 * Erode mask using box kernel
 * @private
 */
function erodeMask(mask, width, height, radius) {
    const eroded = new Uint8Array(mask.length);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;

            if (mask[idx] === 0) {
                eroded[idx] = 0;
                continue;
            }

            // Check if all neighbors within radius are non-zero
            let allNeighborsSet = true;

            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    const nx = x + dx;
                    const ny = y + dy;

                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
                        allNeighborsSet = false;
                        break;
                    }

                    const nIdx = ny * width + nx;
                    if (mask[nIdx] === 0) {
                        allNeighborsSet = false;
                        break;
                    }
                }
                if (!allNeighborsSet) break;
            }

            eroded[idx] = allNeighborsSet ? 255 : 0;
        }
    }

    return eroded;
}
