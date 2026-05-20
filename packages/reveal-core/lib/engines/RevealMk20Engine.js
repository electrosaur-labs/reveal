/**
 * RevealMk20Engine - Reveal Mk 2.0 Posterization Engine
 *
 * Continuous DNA-driven quantizer. Replaces two Mk1.5 bespoke mechanisms
 * with principled DNA-12 alternatives:
 *
 * 1. PeakFinder → options.dnaCentroid (dominant sector centroid pre-computed
 *    by ParameterGenerator — no image rescan).
 * 2. Highlight Rescue → _rescueHighlightsSectors() — checks all 12 DNA sectors
 *    for bright, under-represented hues (not just warm yellows).
 *
 * Called by PosterizationEngine.posterize() for engineType 'reveal-mk2'.
 */

const logger = require('../utils/logger');
const LabDistance = require('../color/LabDistance');
const LabEncoding = require('../color/LabEncoding');
const { LAB16_AB_NEUTRAL, L_SCALE, AB_SCALE } = LabEncoding;
const LabMedianCut = require('./LabMedianCut');
const PaletteOps = require('./PaletteOps');
const HueGapRecovery = require('./HueGapRecovery');

const MIN_PRESERVED_COVERAGE = 0.001;

class RevealMk20Engine {
    static posterize(pixels, width, height, targetColors, options = {}) {
        const distanceMetric = options.distanceMetric || 'cie76';
        const isLegacyV1Mode = distanceMetric === 'cie76';

        let snapThreshold = options.snapThreshold !== undefined ? options.snapThreshold : 8.0;
        let enablePaletteReduction = options.enablePaletteReduction !== undefined ? options.enablePaletteReduction : true;
        let paletteReduction = options.paletteReduction !== undefined ? options.paletteReduction : 8.0;
        let preservedUnifyThreshold = options.preservedUnifyThreshold !== undefined ? options.preservedUnifyThreshold : 12.0;
        let densityFloor = options.densityFloor !== undefined ? options.densityFloor : 0.005;

        if (isLegacyV1Mode) {
            snapThreshold = 0.0;
            enablePaletteReduction = false;
            preservedUnifyThreshold = 0.5;
            densityFloor = 0.0;
            options.snapThreshold = snapThreshold;
            options.enablePaletteReduction = enablePaletteReduction;
            options.paletteReduction = paletteReduction;
            options.preservedUnifyThreshold = preservedUnifyThreshold;
            options.densityFloor = densityFloor;
        }

        const grayscaleOnly = options.grayscaleOnly !== undefined ? options.grayscaleOnly : false;
        const preserveWhite = options.preserveWhite !== undefined ? options.preserveWhite : false;
        const preserveBlack = options.preserveBlack !== undefined ? options.preserveBlack : false;
        const vibrancyMode = options.vibrancyMode !== undefined ? options.vibrancyMode : 'aggressive';
        const vibrancyBoost = options.vibrancyBoost !== undefined ? options.vibrancyBoost : 2.0;
        const highlightThreshold = options.highlightThreshold !== undefined ? options.highlightThreshold : 92;
        const highlightBoost = options.highlightBoost !== undefined ? options.highlightBoost : 3.0;

        const startTime = performance.now();

        if (options.format !== 'lab') {
            throw new Error('[Reveal Mk 2.0] Requires Lab input format (RGB not supported)');
        }

        const sourceBitDepth = options.bitDepth || 16;
        const isEightBitSource = sourceBitDepth <= 8;

        // Step 1: Convert to perceptual Lab + shadow/highlight snap
        const labPixels = new Float32Array(pixels.length);
        const shadowThreshold = isEightBitSource ? 7.5 : 6.0;
        const highlightThresholdGate = isEightBitSource ? 97.5 : 98.0;

        for (let i = 0; i < pixels.length; i += 3) {
            labPixels[i]     = pixels[i] / L_SCALE;
            labPixels[i + 1] = (pixels[i + 1] - LAB16_AB_NEUTRAL) / AB_SCALE;
            labPixels[i + 2] = (pixels[i + 2] - LAB16_AB_NEUTRAL) / AB_SCALE;

            if (labPixels[i] < shadowThreshold) {
                labPixels[i] = 0; labPixels[i + 1] = 0; labPixels[i + 2] = 0;
            } else if (labPixels[i] > highlightThresholdGate) {
                labPixels[i] = 100; labPixels[i + 1] = 0; labPixels[i + 2] = 0;
            }
        }

        // Hard Chroma Gate
        const chromaGateThreshold = options.chromaGateThreshold !== undefined ? options.chromaGateThreshold : 0;
        if (chromaGateThreshold > 0) {
            for (let i = 0; i < labPixels.length; i += 3) {
                const a = labPixels[i + 1], b = labPixels[i + 2];
                if (Math.sqrt(a * a + b * b) < chromaGateThreshold) {
                    labPixels[i + 1] = 0; labPixels[i + 2] = 0;
                }
            }
        }

        // Shadow Chroma Gate
        const shadowChromaGateL = options.shadowChromaGateL !== undefined ? options.shadowChromaGateL : 0;
        if (shadowChromaGateL > 0) {
            for (let i = 0; i < labPixels.length; i += 3) {
                if (labPixels[i] < shadowChromaGateL) {
                    const a = labPixels[i + 1], b = labPixels[i + 2];
                    if (Math.sqrt(a * a + b * b) < 20) {
                        labPixels[i + 1] = 0; labPixels[i + 2] = 0;
                    }
                }
            }
        }

        // Chromatic anchor: use pre-computed DNA centroid instead of PeakFinder.
        // Explicit forcedCentroids (manual UI override) take priority over dnaCentroid.
        let forcedCentroids = [];
        let usedPredefinedAnchors = false;
        let dnaCentroidUsed = false;

        const forcedCentroidsInput = options.forcedCentroids || options.forced_centroids;
        if (forcedCentroidsInput && Array.isArray(forcedCentroidsInput) && forcedCentroidsInput.length > 0) {
            try {
                forcedCentroids = forcedCentroidsInput.map(anchor => ({
                    L: Number(anchor.L || anchor.l),
                    a: Number(anchor.a),
                    b: Number(anchor.b)
                }));
                usedPredefinedAnchors = true;
            } catch (error) {
                logger.error(`  ✗ Error parsing forcedCentroids: ${error.message}`);
            }
        }

        if (!usedPredefinedAnchors && options.dnaCentroid) {
            forcedCentroids = [options.dnaCentroid];
            dnaCentroidUsed = true;
            logger.log(`[Mk2.0] DNA centroid anchor: L=${options.dnaCentroid.L.toFixed(1)} a=${options.dnaCentroid.a.toFixed(1)} b=${options.dnaCentroid.b.toFixed(1)}`);
        }

        // Preserved colors (white/black)
        const preservedPixelMap = new Map();
        const nonPreservedIndices = [];

        const WHITE_L_MIN = 95;
        const BLACK_L_MAX = 10;
        const AB_THRESHOLD = isEightBitSource ? 5 : 0.01;

        for (let i = 0; i < labPixels.length; i += 3) {
            const L = labPixels[i], a = labPixels[i + 1], b = labPixels[i + 2];
            const pixelIndex = i / 3;
            let isPreserved = false;

            if (preserveWhite && L > WHITE_L_MIN && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                if (!preservedPixelMap.has('white')) preservedPixelMap.set('white', new Set());
                preservedPixelMap.get('white').add(pixelIndex);
                isPreserved = true;
            } else if (preserveBlack && L < BLACK_L_MAX && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                if (!preservedPixelMap.has('black')) preservedPixelMap.set('black', new Set());
                preservedPixelMap.get('black').add(pixelIndex);
                isPreserved = true;
            }

            if (!isPreserved) nonPreservedIndices.push(pixelIndex);
        }

        const totalPixels = labPixels.length / 3;

        let numPreserved = 0;
        if (preserveWhite) numPreserved++;
        if (preserveBlack) numPreserved++;

        const medianCutTarget = Math.max(1, targetColors - numPreserved);

        const numForced = forcedCentroids.length;
        logger.log(`[Mk2.0] Slot budget: targetColors=${targetColors}, numForced=${numForced}, numPreserved=${numPreserved} → medianCutTarget=${medianCutTarget}`);

        // Extract non-preserved pixels
        let nonPreservedLabPixels = labPixels;
        if (nonPreservedIndices.length < labPixels.length / 3) {
            nonPreservedLabPixels = new Float32Array(nonPreservedIndices.length * 3);
            for (let i = 0; i < nonPreservedIndices.length; i++) {
                const srcIdx = nonPreservedIndices[i] * 3;
                nonPreservedLabPixels[i * 3]     = labPixels[srcIdx];
                nonPreservedLabPixels[i * 3 + 1] = labPixels[srcIdx + 1];
                nonPreservedLabPixels[i * 3 + 2] = labPixels[srcIdx + 2];
            }
        }

        // Neutral Sovereignty
        const neutralSovereigntyThreshold = options.neutralSovereigntyThreshold || 0;
        let sovereignNeutralCentroid = null;
        let medianCutPixels = nonPreservedLabPixels;
        let adjustedMedianCutTarget = medianCutTarget;

        if (neutralSovereigntyThreshold > 0 && !grayscaleOnly) {
            let neutralSumL = 0, neutralSumA = 0, neutralSumB = 0, neutralCount = 0, chromaticCount = 0;

            for (let i = 0; i < nonPreservedLabPixels.length; i += 3) {
                const a = nonPreservedLabPixels[i + 1], b = nonPreservedLabPixels[i + 2];
                if (Math.sqrt(a * a + b * b) < neutralSovereigntyThreshold) {
                    neutralSumL += nonPreservedLabPixels[i];
                    neutralSumA += a; neutralSumB += b; neutralCount++;
                } else {
                    chromaticCount++;
                }
            }

            const neutralFraction = neutralCount / (neutralCount + chromaticCount);
            if (neutralCount > 0 && chromaticCount > 0 && neutralFraction > 0.20) {
                sovereignNeutralCentroid = {
                    L: neutralSumL / neutralCount,
                    a: neutralSumA / neutralCount,
                    b: neutralSumB / neutralCount
                };
                const chromaticPixels = new Float32Array(chromaticCount * 3);
                let writeIdx = 0;
                for (let i = 0; i < nonPreservedLabPixels.length; i += 3) {
                    const a = nonPreservedLabPixels[i + 1], b = nonPreservedLabPixels[i + 2];
                    if (Math.sqrt(a * a + b * b) >= neutralSovereigntyThreshold) {
                        chromaticPixels[writeIdx]     = nonPreservedLabPixels[i];
                        chromaticPixels[writeIdx + 1] = a;
                        chromaticPixels[writeIdx + 2] = b;
                        writeIdx += 3;
                    }
                }
                medianCutPixels = chromaticPixels;
                adjustedMedianCutTarget = Math.max(1, medianCutTarget - 1);
                logger.log(`[Mk2.0] Neutral sovereignty: ${(neutralFraction * 100).toFixed(1)}% neutral → 1 neutral slot + ${adjustedMedianCutTarget} chromatic slots`);
            }
        }

        // Step 2: Median cut
        let initialPaletteLab = LabMedianCut.medianCutInLabSpace(
            medianCutPixels, adjustedMedianCutTarget, grayscaleOnly, width, height,
            forcedCentroids.length > 0 ? forcedCentroids : null,
            3.5, vibrancyMode, vibrancyBoost, highlightThreshold, highlightBoost,
            options.strategy || null, options.tuning || null
        );

        logger.log(`[Mk2.0] Median cut produced ${initialPaletteLab.length} colors`);

        // K-means refinement (1 pass default, matching Mk1.5)
        const defaultPasses = (options.tuning?.split?.splitMode === 'variance') ? 3 : 1;
        const refinementPasses = options.refinementPasses !== undefined ? options.refinementPasses : defaultPasses;
        if (!grayscaleOnly && initialPaletteLab.length > 1 && refinementPasses > 0) {
            const kmeansPixels = sovereignNeutralCentroid ? medianCutPixels : nonPreservedLabPixels;
            for (let pass = 0; pass < refinementPasses; pass++) {
                initialPaletteLab = PaletteOps._refineKMeans(kmeansPixels, initialPaletteLab, options.tuning || null);
            }
        }

        if (sovereignNeutralCentroid) initialPaletteLab.push(sovereignNeutralCentroid);

        // Highlight Rescue: generalised to all bright DNA sectors
        const highlightRescueThreshold = options.highlightRescueThreshold !== undefined
            ? options.highlightRescueThreshold : (neutralSovereigntyThreshold > 0 ? 85 : 0);

        if (highlightRescueThreshold > 0 && !grayscaleOnly && initialPaletteLab.length > 2 && options.dnaSectors) {
            this._rescueHighlightsSectors(initialPaletteLab, medianCutPixels, options.dnaSectors, highlightRescueThreshold);
        }

        // Step 3: Perceptual snap
        const colorSpaceAnalysis = LabMedianCut._analyzeColorSpace(labPixels);
        const isGrayscale = grayscaleOnly || colorSpaceAnalysis.chromaRange < 10;

        let lRange = 0, colorSpaceExtent = null;
        if (isGrayscale) {
            let minL = Infinity, maxL = -Infinity;
            for (let i = 0; i < labPixels.length; i += 3) {
                if (labPixels[i] < minL) minL = labPixels[i];
                if (labPixels[i] > maxL) maxL = labPixels[i];
            }
            lRange = maxL - minL;
        } else {
            let minL = Infinity, maxL = -Infinity;
            let minA = Infinity, maxA = -Infinity;
            let minB = Infinity, maxB = -Infinity;
            for (let i = 0; i < labPixels.length; i += 3) {
                if (labPixels[i]     < minL) minL = labPixels[i];
                if (labPixels[i]     > maxL) maxL = labPixels[i];
                if (labPixels[i + 1] < minA) minA = labPixels[i + 1];
                if (labPixels[i + 1] > maxA) maxA = labPixels[i + 1];
                if (labPixels[i + 2] < minB) minB = labPixels[i + 2];
                if (labPixels[i + 2] > maxB) maxB = labPixels[i + 2];
            }
            colorSpaceExtent = { lRange: maxL - minL, aRange: maxA - minA, bRange: maxB - minB };
        }

        const adaptiveThreshold = PaletteOps._getAdaptiveSnapThreshold(snapThreshold, targetColors, isGrayscale, lRange, colorSpaceExtent);
        let snappedPaletteLab = PaletteOps.applyPerceptualSnap(
            initialPaletteLab, adaptiveThreshold, isGrayscale, vibrancyBoost,
            options.strategy || null, options.tuning || null
        );

        // Step 4: Palette reduction
        if (enablePaletteReduction && snappedPaletteLab.length > medianCutTarget) {
            const pruned = PaletteOps._prunePalette(snappedPaletteLab, paletteReduction, highlightThreshold, medianCutTarget, options.tuning || null, distanceMetric);
            if (pruned.length < snappedPaletteLab.length) snappedPaletteLab = pruned;
        }

        if (enablePaletteReduction) {
            const dedupThreshold = Math.max(paletteReduction, 2.0);
            const deduped = PaletteOps._prunePalette(snappedPaletteLab, dedupThreshold, highlightThreshold, 0, options.tuning || null, distanceMetric);
            if (deduped.length < snappedPaletteLab.length) {
                logger.log(`[Mk2.0] Similarity prune: ${snappedPaletteLab.length} → ${deduped.length}`);
                snappedPaletteLab = deduped;
            }
        }

        // Step 4.5: Hue gap analysis
        const enableHueGapAnalysis = options.enableHueGapAnalysis !== undefined ? options.enableHueGapAnalysis : false;
        if (enableHueGapAnalysis && !grayscaleOnly && initialPaletteLab._labPixels) {
            const hueChromaThreshold = vibrancyMode === 'exponential' ? 1.0 : 5.0;
            const imageHues = HueGapRecovery._analyzeImageHueSectors(initialPaletteLab._labPixels, hueChromaThreshold);
            const { coveredSectors, colorCountsBySector } = HueGapRecovery._analyzePaletteHueCoverage(snappedPaletteLab, hueChromaThreshold);
            const gaps = HueGapRecovery._identifyHueGaps(imageHues, coveredSectors, colorCountsBySector);
            gaps.sort((a, b) => imageHues[b] - imageHues[a]);

            if (gaps.length > 0) {
                const gapsToFill = gaps.length > 3 ? gaps.slice(0, 3) : gaps;
                const candidateColors = HueGapRecovery._findTrueMissingHues(labPixels, snappedPaletteLab, gapsToFill);
                const MIN_GAP_DISTANCE = 15.0;
                const forcedColors = candidateColors.filter(c =>
                    Math.min(...snappedPaletteLab.map(p => PaletteOps._labDistance(c, p))) >= MIN_GAP_DISTANCE
                );
                if (forcedColors.length > 0) {
                    forcedColors.forEach(c => { c._minVolumeExempt = true; });
                    snappedPaletteLab = snappedPaletteLab.concat(forcedColors);
                }
            }
        }

        // Anchor injection (ΔE<3.0 duplicate check)
        const mergedPalette = [...snappedPaletteLab];
        let addedCount = 0, skippedCount = 0;
        const anchorDuplicateThreshold = 3.0;

        for (const forced of forcedCentroids) {
            const isDuplicate = mergedPalette.some(c => PaletteOps._labDistance(c, forced) < anchorDuplicateThreshold);
            if (isDuplicate) {
                skippedCount++;
            } else {
                forced._minVolumeExempt = true;
                mergedPalette.push(forced);
                addedCount++;
            }
        }

        // Step 5: Add preserved colors
        const preservedColors = [];
        let actuallyPreservedWhite = false, actuallyPreservedBlack = false;
        let whiteIndex = -1, blackIndex = -1;

        if (preserveWhite) {
            const whitePixels = preservedPixelMap.get('white');
            if (whitePixels && whitePixels.size >= totalPixels * MIN_PRESERVED_COVERAGE) {
                preservedColors.push({ L: 100, a: 0, b: 0 });
                whiteIndex = mergedPalette.length + preservedColors.length - 1;
                actuallyPreservedWhite = true;
            }
        }

        if (preserveBlack) {
            const blackPixels = preservedPixelMap.get('black');
            if (blackPixels && blackPixels.size >= totalPixels * MIN_PRESERVED_COVERAGE) {
                preservedColors.push({ L: 0, a: 0, b: 0 });
                blackIndex = mergedPalette.length + preservedColors.length - 1;
                actuallyPreservedBlack = true;
            }
        }

        // Final safety-net dedup
        {
            const finalDedupThreshold = enablePaletteReduction ? Math.max(paletteReduction, 2.0) : 2.0;
            const dedupFinal = PaletteOps._prunePalette(mergedPalette, finalDedupThreshold, highlightThreshold, 0, options.tuning || null, distanceMetric);
            if (dedupFinal.length < mergedPalette.length) {
                logger.log(`[Mk2.0] Final dedup: ${mergedPalette.length} → ${dedupFinal.length}`);
                mergedPalette.length = 0;
                mergedPalette.push(...dedupFinal);
                if (actuallyPreservedWhite) whiteIndex = mergedPalette.length + preservedColors.findIndex(c => c.L === 100);
                if (actuallyPreservedBlack) blackIndex = mergedPalette.length + preservedColors.findIndex(c => c.L === 0);
            }
        }

        const finalPaletteLab = [...mergedPalette, ...preservedColors];

        // Step 6: Pixel assignment
        const assignments = new Uint8Array(width * height);
        const isPreview = options.isPreview === true;
        const useStride = isPreview && options.optimizePreview !== false;
        const ASSIGNMENT_STRIDE = useStride ? (options.previewStride || 4) : 1;
        const paletteLength = finalPaletteLab.length;
        const assignDistanceMetric = options.distanceMetric || 'squared';
        const lWeight = options.lWeight !== undefined ? options.lWeight : 1.0;
        const cWeight = options.cWeight !== undefined ? options.cWeight : 1.0;

        for (let y = 0; y < height; y += ASSIGNMENT_STRIDE) {
            for (let x = 0; x < width; x += ASSIGNMENT_STRIDE) {
                let anchorAssignment = 0;

                for (let bY = 0; bY < ASSIGNMENT_STRIDE && (y + bY) < height; bY += 2) {
                    for (let bX = 0; bX < ASSIGNMENT_STRIDE && (x + bX) < width; bX += 2) {
                        const pixelIndex = (y + bY) * width + (x + bX);
                        const preservedColorKey = [...preservedPixelMap.entries()].find(([, indices]) => indices.has(pixelIndex));

                        if (preservedColorKey) {
                            if (preservedColorKey[0] === 'white' && actuallyPreservedWhite) anchorAssignment = whiteIndex;
                            else if (preservedColorKey[0] === 'black' && actuallyPreservedBlack) anchorAssignment = blackIndex;
                        } else {
                            let minDistance = Infinity;
                            const idx = pixelIndex * 3;
                            const pL = labPixels[idx], pA = labPixels[idx + 1], pB = labPixels[idx + 2];

                            for (let j = 0; j < paletteLength; j++) {
                                const target = finalPaletteLab[j];
                                let dist;
                                if (grayscaleOnly) {
                                    const dL = pL - target.L; dist = dL * dL;
                                } else if (assignDistanceMetric === 'cie76') {
                                    dist = LabDistance.cie76SquaredInline(pL, pA, pB, target.L, target.a, target.b);
                                } else if (assignDistanceMetric === 'cie94') {
                                    dist = LabDistance.cie94SquaredInline(pL, pA, pB, target.L, target.a, target.b, Math.sqrt(pA * pA + pB * pB));
                                } else if (assignDistanceMetric === 'cie2000') {
                                    dist = LabDistance.cie2000SquaredInline(pL, pA, pB, target.L, target.a, target.b);
                                } else {
                                    const dL = pL - target.L, dA = pA - target.a, dB = pB - target.b;
                                    dist = (lWeight * dL * dL) + (cWeight * (dA * dA + dB * dB));
                                }
                                if (dist < minDistance) { minDistance = dist; anchorAssignment = j; }
                            }
                        }
                    }
                }

                for (let bY = 0; bY < ASSIGNMENT_STRIDE && (y + bY) < height; bY++) {
                    const fillRow = (y + bY) * width;
                    for (let bX = 0; bX < ASSIGNMENT_STRIDE && (x + bX) < width; bX++) {
                        assignments[fillRow + (x + bX)] = anchorAssignment;
                    }
                }
            }
        }

        const endTime = performance.now();

        // Density floor
        let finalPaletteLabFiltered = finalPaletteLab;
        let assignmentsFiltered = assignments;

        if (densityFloor > 0) {
            const protectedIndices = new Set();
            if (actuallyPreservedWhite) protectedIndices.add(whiteIndex);
            if (actuallyPreservedBlack) protectedIndices.add(blackIndex);

            const densityResult = PaletteOps._applyDensityFloor(assignments, finalPaletteLab, densityFloor, protectedIndices);
            if (densityResult.actualCount < finalPaletteLab.length) {
                finalPaletteLabFiltered = densityResult.palette;
                assignmentsFiltered = densityResult.assignments;
            }
        }

        return {
            palette: finalPaletteLabFiltered.map(lab => LabEncoding.labToRgb(lab)),
            paletteLab: finalPaletteLabFiltered,
            assignments: assignmentsFiltered,
            labPixels,
            substrateLab: null,
            substrateIndex: null,
            metadata: {
                targetColors,
                finalColors: finalPaletteLabFiltered.length,
                autoAnchors: addedCount,
                skippedAnchors: skippedCount,
                dnaCentroidUsed,
                snapThreshold,
                duration: parseFloat(((endTime - startTime) / 1000).toFixed(3)),
                engineType: 'reveal-mk2'
            }
        };
    }

    /**
     * Generalised highlight rescue: checks all DNA sectors for bright,
     * under-represented hues and forces a palette slot for each.
     *
     * Unlike the Mk1.5 warm-yellow-only filter, this rescues any hue sector
     * where the palette fails to cover bright pixels. One coverage scan is
     * shared across all qualifying sectors.
     *
     * @param {Array} paletteLab - Palette to mutate
     * @param {Float32Array} pixelSource - Chromatic pixels (perceptual Lab)
     * @param {Object} dnaSectors - DNA-12 sector map
     * @param {number} threshold - L* floor for highlight detection
     */
    static _rescueHighlightsSectors(paletteLab, pixelSource, dnaSectors, threshold) {
        const MIN_SECTOR_WEIGHT = 0.005; // 0.5% of total pixels
        const MIN_SECTOR_CHROMA = 15;    // must have meaningful chroma
        const COVERAGE_DE_THRESHOLD = 20;

        // Find sectors that are bright, present, and under-represented in palette
        const candidates = [];
        for (const [name, sector] of Object.entries(dnaSectors)) {
            if (sector.lMean <= threshold) continue;
            if (sector.weight < MIN_SECTOR_WEIGHT) continue;
            if (sector.cMean < MIN_SECTOR_CHROMA) continue;

            const centroid = { L: sector.lMean, a: sector.aMean, b: sector.bMean };

            let nearestDE = Infinity;
            for (const color of paletteLab) {
                const dL = centroid.L - color.L, da = centroid.a - color.a, db = centroid.b - color.b;
                const de = Math.sqrt(dL * dL + da * da + db * db);
                if (de < nearestDE) nearestDE = de;
            }

            if (nearestDE > COVERAGE_DE_THRESHOLD) {
                candidates.push({ name, centroid, weight: sector.weight, nearestDE });
            }
        }

        if (candidates.length === 0) return;

        // One coverage scan shared across all candidates
        const palLen = paletteLab.length;
        const slotCounts = new Array(palLen).fill(0);
        const pixelTotal = pixelSource.length / 3;

        for (let pi = 0; pi < pixelSource.length; pi += 3) {
            const pL = pixelSource[pi], pa = pixelSource[pi + 1], pb = pixelSource[pi + 2];
            let bestD = Infinity, bestJ = 0;
            for (let j = 0; j < palLen; j++) {
                const c = paletteLab[j];
                const d = (pL - c.L) ** 2 + (pa - c.a) ** 2 + (pb - c.b) ** 2;
                if (d < bestD) { bestD = d; bestJ = j; }
            }
            slotCounts[bestJ]++;
        }

        // Rescue most-significant sectors first; never replace the same slot twice
        candidates.sort((a, b) => b.weight - a.weight);
        const replacedSlots = new Set();

        for (const candidate of candidates) {
            let minCount = Infinity, minIdx = -1;
            for (let j = 0; j < palLen; j++) {
                if (replacedSlots.has(j)) continue;
                if (paletteLab[j]._minVolumeExempt) continue;
                if (slotCounts[j] < minCount) { minCount = slotCounts[j]; minIdx = j; }
            }

            if (minIdx < 0) break;

            logger.log(`[Mk2.0] Highlight rescue: sector=${candidate.name} weight=${(candidate.weight * 100).toFixed(1)}% nearestDE=${candidate.nearestDE.toFixed(1)} → replacing slot ${minIdx + 1} (${(minCount / pixelTotal * 100).toFixed(1)}% coverage)`);

            paletteLab[minIdx] = candidate.centroid;
            replacedSlots.add(minIdx);
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = RevealMk20Engine;
}
