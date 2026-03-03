/**
 * RevealMk15Engine - Reveal Mk 1.5 Posterization Engine
 *
 * Deterministic Auto-Quantizer with Identity Peaks, Neutral Sovereignty,
 * and Highlight Rescue. Lab-only input.
 *
 * Extracted from PosterizationEngine.js for maintainability.
 * Called by PosterizationEngine.posterize() for engineType 'reveal-mk1.5' and 'reveal-mk2'.
 */

const logger = require('../utils/logger');
const PeakFinder = require('../analysis/PeakFinder');
const LabDistance = require('../color/LabDistance');
const LabEncoding = require('../color/LabEncoding');
const { LAB16_AB_NEUTRAL, L_SCALE, AB_SCALE } = LabEncoding;
const LabMedianCut = require('./LabMedianCut');
const PaletteOps = require('./PaletteOps');
const HueGapRecovery = require('./HueGapRecovery');

const MIN_PRESERVED_COVERAGE = 0.001; // 0.1% for preserved colors (white/black)

class RevealMk15Engine {
    /**
     * Reveal Mk 1.5 Engine: Deterministic Auto-Quantizer with Identity Peaks
     *
     * @param {Uint16Array} pixels - 16-bit Lab pixel data (3 channels interleaved)
     * @param {number} width
     * @param {number} height
     * @param {number} targetColors
     * @param {Object} options
     * @returns {Object} - {palette, paletteLab, assignments, labPixels, metadata}
     */
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

        const isLabInput = options.format === 'lab';
        if (!isLabInput) {
            throw new Error('[Reveal Mk 1.5] Requires Lab input format (RGB not supported)');
        }

        const sourceBitDepth = options.bitDepth || 16;
        const isEightBitSource = sourceBitDepth <= 8;

        // Step 1: Convert to perceptual Lab space
        const labPixels = new Float32Array(pixels.length);
        const shadowThreshold = isEightBitSource ? 7.5 : 6.0;
        const highlightThresholdGate = isEightBitSource ? 97.5 : 98.0;

        for (let i = 0; i < pixels.length; i += 3) {
            labPixels[i] = pixels[i] / L_SCALE;
            labPixels[i + 1] = (pixels[i + 1] - LAB16_AB_NEUTRAL) / AB_SCALE;
            labPixels[i + 2] = (pixels[i + 2] - LAB16_AB_NEUTRAL) / AB_SCALE;

            if (labPixels[i] < shadowThreshold) {
                labPixels[i] = 0;
                labPixels[i + 1] = 0;
                labPixels[i + 2] = 0;
            } else if (labPixels[i] > highlightThresholdGate) {
                labPixels[i] = 100;
                labPixels[i + 1] = 0;
                labPixels[i + 2] = 0;
            }
        }

        // Hard Chroma Gate
        const chromaGateThreshold = options.chromaGateThreshold !== undefined ? options.chromaGateThreshold : 0;

        if (chromaGateThreshold > 0) {
            for (let i = 0; i < labPixels.length; i += 3) {
                const a = labPixels[i + 1];
                const b = labPixels[i + 2];
                const chroma = Math.sqrt(a * a + b * b);
                if (chroma < chromaGateThreshold) {
                    labPixels[i + 1] = 0;
                    labPixels[i + 2] = 0;
                }
            }
        }

        // Shadow Chroma Gate
        const shadowChromaGateL = options.shadowChromaGateL !== undefined ? options.shadowChromaGateL : 0;

        if (shadowChromaGateL > 0) {
            for (let i = 0; i < labPixels.length; i += 3) {
                if (labPixels[i] < shadowChromaGateL) {
                    const a = labPixels[i + 1];
                    const b = labPixels[i + 2];
                    const chroma = Math.sqrt(a * a + b * b);
                    if (chroma < 20) {
                        labPixels[i + 1] = 0;
                        labPixels[i + 2] = 0;
                    }
                }
            }
        }

        // Identity Peak detection
        const peakFinderMaxPeaks = options.peakFinderMaxPeaks !== undefined ? options.peakFinderMaxPeaks : 1;
        const peakFinderPreferredSectors = options.peakFinderPreferredSectors || null;
        const peakFinderBlacklistedSectors = options.peakFinderBlacklistedSectors || [3, 4];

        let forcedCentroids = [];
        let usedPredefinedAnchors = false;
        let detectedPeaks = [];

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

        if (!usedPredefinedAnchors) {
            const peakFinder = new PeakFinder({
                chromaThreshold: 30,
                volumeThreshold: 0.05,
                maxPeaks: peakFinderMaxPeaks,
                preferredSectors: peakFinderPreferredSectors,
                blacklistedSectors: peakFinderBlacklistedSectors
            });

            detectedPeaks = peakFinder.findIdentityPeaks(labPixels, { bitDepth: sourceBitDepth });

            forcedCentroids = detectedPeaks.map(peak => ({
                L: peak.L,
                a: peak.a,
                b: peak.b
            }));

            logger.log(`[Mk1.5] PeakFinder: ${detectedPeaks.length} peaks at ${width}x${height} (bitDepth=${sourceBitDepth}): ${detectedPeaks.map(p => `L=${p.L.toFixed(1)} a=${p.a.toFixed(1)} b=${p.b.toFixed(1)} C=${(Math.sqrt(p.a*p.a+p.b*p.b)).toFixed(1)}`).join(', ') || 'none'}`);
        }

        // Preserved colors (white/black)
        let preservedPixelMap = new Map();
        let nonPreservedIndices = [];

        const WHITE_L_MIN = 95;
        const BLACK_L_MAX = 10;
        const AB_THRESHOLD = isEightBitSource ? 5 : 0.01;

        for (let i = 0; i < labPixels.length; i += 3) {
            const L = labPixels[i];
            const a = labPixels[i + 1];
            const b = labPixels[i + 2];
            const pixelIndex = i / 3;

            let isPreserved = false;

            if (preserveWhite && L > WHITE_L_MIN && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                if (!preservedPixelMap.has('white')) {
                    preservedPixelMap.set('white', new Set());
                }
                preservedPixelMap.get('white').add(pixelIndex);
                isPreserved = true;
            } else if (preserveBlack && L < BLACK_L_MAX && Math.abs(a) < AB_THRESHOLD && Math.abs(b) < AB_THRESHOLD) {
                if (!preservedPixelMap.has('black')) {
                    preservedPixelMap.set('black', new Set());
                }
                preservedPixelMap.get('black').add(pixelIndex);
                isPreserved = true;
            }

            if (!isPreserved) {
                nonPreservedIndices.push(pixelIndex);
            }
        }

        const totalPixels = labPixels.length / 3;

        // Slot reservation
        // NOTE: Forced centroids (PeakFinder peaks) are NOT deducted from the
        // median cut budget. They are injected AFTER median cut with duplicate
        // checking. If median cut already found the peak color, the forced
        // centroid is skipped (no wasted slot).
        let numPreserved = 0;
        if (preserveWhite) numPreserved++;
        if (preserveBlack) numPreserved++;

        const numForced = forcedCentroids.length;
        const medianCutTarget = Math.max(1, targetColors - numPreserved);

        logger.log(`[Mk1.5] Slot budget: targetColors=${targetColors}, numForced=${numForced}, numPreserved=${numPreserved} → medianCutTarget=${medianCutTarget}`);

        // Extract non-preserved pixels
        let nonPreservedLabPixels = labPixels;
        if (nonPreservedIndices.length < labPixels.length / 3) {
            nonPreservedLabPixels = new Float32Array(nonPreservedIndices.length * 3);
            for (let i = 0; i < nonPreservedIndices.length; i++) {
                const srcIdx = nonPreservedIndices[i] * 3;
                nonPreservedLabPixels[i * 3] = labPixels[srcIdx];
                nonPreservedLabPixels[i * 3 + 1] = labPixels[srcIdx + 1];
                nonPreservedLabPixels[i * 3 + 2] = labPixels[srcIdx + 2];
            }
        }

        // NEUTRAL SOVEREIGNTY: Extract near-neutral pixels and give them a fixed
        // 1-slot allocation. Prevents neutral majority from consuming split budget.
        const neutralSovereigntyThreshold = options.neutralSovereigntyThreshold || 0;
        let sovereignNeutralCentroid = null;
        let medianCutPixels = nonPreservedLabPixels;
        let adjustedMedianCutTarget = medianCutTarget;

        if (neutralSovereigntyThreshold > 0 && !grayscaleOnly) {
            let neutralSumL = 0, neutralSumA = 0, neutralSumB = 0, neutralCount = 0;
            let chromaticCount = 0;

            for (let i = 0; i < nonPreservedLabPixels.length; i += 3) {
                const a = nonPreservedLabPixels[i + 1];
                const b = nonPreservedLabPixels[i + 2];
                const chroma = Math.sqrt(a * a + b * b);
                if (chroma < neutralSovereigntyThreshold) {
                    neutralSumL += nonPreservedLabPixels[i];
                    neutralSumA += a;
                    neutralSumB += b;
                    neutralCount++;
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
                    const a = nonPreservedLabPixels[i + 1];
                    const b = nonPreservedLabPixels[i + 2];
                    const chroma = Math.sqrt(a * a + b * b);
                    if (chroma >= neutralSovereigntyThreshold) {
                        chromaticPixels[writeIdx] = nonPreservedLabPixels[i];
                        chromaticPixels[writeIdx + 1] = a;
                        chromaticPixels[writeIdx + 2] = b;
                        writeIdx += 3;
                    }
                }

                medianCutPixels = chromaticPixels;
                adjustedMedianCutTarget = Math.max(1, medianCutTarget - 1);

                logger.log(`[Mk1.5] Neutral sovereignty: ${(neutralFraction * 100).toFixed(1)}% neutral (C<${neutralSovereigntyThreshold}), extracted → 1 neutral slot + ${adjustedMedianCutTarget} chromatic slots`);
            }
        }

        // Step 2: Median cut with reduced target
        let initialPaletteLab = LabMedianCut.medianCutInLabSpace(
            medianCutPixels,
            adjustedMedianCutTarget,
            grayscaleOnly,
            width,
            height,
            null,
            3.5,
            vibrancyMode,
            vibrancyBoost,
            highlightThreshold,
            highlightBoost,
            options.strategy || null,
            options.tuning || null
        );

        logger.log(`[Mk1.5] Median cut produced ${initialPaletteLab.length} colors: ${initialPaletteLab.map(c => `L=${c.L.toFixed(1)} a=${c.a.toFixed(1)} b=${c.b.toFixed(1)}`).join(' | ')}`);

        // K-means refinement
        const mk15DefaultPasses = (options.tuning?.split?.splitMode === 'variance') ? 3 : 1;
        const refinementPasses = options.refinementPasses !== undefined ? options.refinementPasses : mk15DefaultPasses;
        if (!grayscaleOnly && initialPaletteLab.length > 1 && refinementPasses > 0) {
            const kmeansPixels = sovereignNeutralCentroid ? medianCutPixels : nonPreservedLabPixels;
            for (let pass = 0; pass < refinementPasses; pass++) {
                initialPaletteLab = PaletteOps._refineKMeans(kmeansPixels, initialPaletteLab, options.tuning || null);
            }
        }

        // Inject sovereign neutral centroid AFTER K-means (frozen, not refined)
        if (sovereignNeutralCentroid) {
            initialPaletteLab.push(sovereignNeutralCentroid);
        }

        // HIGHLIGHT RESCUE: Detect bright warm highlights that median cut missed.
        const highlightRescueThreshold = options.highlightRescueThreshold !== undefined
            ? options.highlightRescueThreshold : (neutralSovereigntyThreshold > 0 ? 85 : 0);

        if (highlightRescueThreshold > 0 && !grayscaleOnly && initialPaletteLab.length > 2) {
            this._rescueHighlights(initialPaletteLab, medianCutPixels, highlightRescueThreshold);
        }

        // Step 3: Perceptual snap
        const colorSpaceAnalysis = LabMedianCut._analyzeColorSpace(labPixels);
        const isGrayscale = grayscaleOnly || colorSpaceAnalysis.chromaRange < 10;

        let lRange = 0;
        let colorSpaceExtent = null;

        if (isGrayscale) {
            let minL = Infinity, maxL = -Infinity;
            for (let i = 0; i < labPixels.length; i += 3) {
                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
            }
            lRange = maxL - minL;
        } else {
            let minL = Infinity, maxL = -Infinity;
            let minA = Infinity, maxA = -Infinity;
            let minB = Infinity, maxB = -Infinity;

            for (let i = 0; i < labPixels.length; i += 3) {
                minL = Math.min(minL, labPixels[i]);
                maxL = Math.max(maxL, labPixels[i]);
                minA = Math.min(minA, labPixels[i + 1]);
                maxA = Math.max(maxA, labPixels[i + 1]);
                minB = Math.min(minB, labPixels[i + 2]);
                maxB = Math.max(maxB, labPixels[i + 2]);
            }

            colorSpaceExtent = {
                lRange: maxL - minL,
                aRange: maxA - minA,
                bRange: maxB - minB
            };
        }

        const adaptiveThreshold = PaletteOps._getAdaptiveSnapThreshold(
            snapThreshold, targetColors, isGrayscale, lRange, colorSpaceExtent
        );

        let snappedPaletteLab = PaletteOps.applyPerceptualSnap(
            initialPaletteLab, adaptiveThreshold, isGrayscale, vibrancyBoost,
            options.strategy || null, options.tuning || null
        );

        // Step 4: Palette reduction
        if (enablePaletteReduction && snappedPaletteLab.length > medianCutTarget) {
            const prunedPaletteLab = PaletteOps._prunePalette(snappedPaletteLab, paletteReduction, highlightThreshold, medianCutTarget, options.tuning || null, distanceMetric);
            if (prunedPaletteLab.length < snappedPaletteLab.length) {
                snappedPaletteLab = prunedPaletteLab;
            }
        }

        // Step 4a: Unconditional similarity prune
        if (enablePaletteReduction) {
            const dedupThreshold = Math.max(paletteReduction, 2.0);
            const dedupResult = PaletteOps._prunePalette(snappedPaletteLab, dedupThreshold, highlightThreshold, 0, options.tuning || null, distanceMetric);
            if (dedupResult.length < snappedPaletteLab.length) {
                logger.log(`[Mk1.5] Similarity prune (ΔE<${dedupThreshold}): ${snappedPaletteLab.length} → ${dedupResult.length}`);
                snappedPaletteLab = dedupResult;
            }
        }

        // Step 4.5: Hue gap analysis
        const enableHueGapAnalysis = options.enableHueGapAnalysis !== undefined
            ? options.enableHueGapAnalysis : false;

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
                const forcedColors = candidateColors.filter(candidate => {
                    const minDist = Math.min(
                        ...snappedPaletteLab.map(p => PaletteOps._labDistance(candidate, p))
                    );
                    return minDist >= MIN_GAP_DISTANCE;
                });

                if (forcedColors.length > 0) {
                    forcedColors.forEach(c => { c._minVolumeExempt = true; });
                    snappedPaletteLab = snappedPaletteLab.concat(forcedColors);
                    logger.log(`[Mk1.5] Hue gap rescue: injected ${forcedColors.length} colors for sectors [${gapsToFill.join(', ')}]`);
                } else {
                    logger.log(`[Mk1.5] Hue gap: ${gaps.length} gaps found but no candidates passed ΔE≥${MIN_GAP_DISTANCE} filter`);
                }
            }
        }

        // Anchor injection (after perceptual snap)
        const mergedPalette = [...snappedPaletteLab];
        let addedCount = 0;
        let skippedCount = 0;
        const anchorDuplicateThreshold = 3.0;

        for (const forced of forcedCentroids) {
            const isDuplicate = mergedPalette.some(color =>
                PaletteOps._labDistance(color, forced) < anchorDuplicateThreshold
            );

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
        let actuallyPreservedWhite = false;
        let actuallyPreservedBlack = false;
        let whiteIndex = -1;
        let blackIndex = -1;

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
                logger.log(`[Mk1.5] Final dedup: ${mergedPalette.length} → ${dedupFinal.length} (removed ${mergedPalette.length - dedupFinal.length} near-duplicates)`);
                mergedPalette.length = 0;
                mergedPalette.push(...dedupFinal);
                if (actuallyPreservedWhite) whiteIndex = mergedPalette.length + (preservedColors.indexOf(preservedColors.find(c => c.L === 100)));
                if (actuallyPreservedBlack) blackIndex = mergedPalette.length + (preservedColors.indexOf(preservedColors.find(c => c.L === 0)));
            }
        }

        const finalPaletteLab = [...mergedPalette, ...preservedColors];

        // Step 6: Pixel assignment
        const paletteRgb = finalPaletteLab.map(lab => LabEncoding.labToRgb(lab));
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
                        const preservedColorKey = [...preservedPixelMap.entries()].find(([_, indices]) => indices.has(pixelIndex));

                        if (preservedColorKey) {
                            const colorName = preservedColorKey[0];
                            if (colorName === 'white' && actuallyPreservedWhite) {
                                anchorAssignment = whiteIndex;
                            } else if (colorName === 'black' && actuallyPreservedBlack) {
                                anchorAssignment = blackIndex;
                            }
                        } else {
                            let minDistance = Infinity;
                            const idx = pixelIndex * 3;

                            const pL = labPixels[idx];
                            const pA = labPixels[idx + 1];
                            const pB = labPixels[idx + 2];

                            for (let j = 0; j < paletteLength; j++) {
                                const target = finalPaletteLab[j];

                                let dist;
                                if (grayscaleOnly) {
                                    const dL = pL - target.L;
                                    dist = dL * dL;
                                } else {
                                    if (assignDistanceMetric === 'cie76') {
                                        dist = LabDistance.cie76SquaredInline(pL, pA, pB, target.L, target.a, target.b);
                                    } else if (assignDistanceMetric === 'cie94') {
                                        const C1 = Math.sqrt(pA * pA + pB * pB);
                                        dist = LabDistance.cie94SquaredInline(pL, pA, pB, target.L, target.a, target.b, C1);
                                    } else if (assignDistanceMetric === 'cie2000') {
                                        dist = LabDistance.cie2000SquaredInline(pL, pA, pB, target.L, target.a, target.b);
                                    } else {
                                        const dL = pL - target.L;
                                        const dA = pA - target.a;
                                        const dB = pB - target.b;
                                        const dC = Math.sqrt(dA * dA + dB * dB);
                                        dist = (lWeight * dL * dL) + (cWeight * dC * dC);
                                    }
                                }

                                if (dist < minDistance) {
                                    minDistance = dist;
                                    anchorAssignment = j;
                                }
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
        const duration = ((endTime - startTime) / 1000).toFixed(3);

        // Apply density floor
        let finalPaletteLabFiltered = finalPaletteLab;
        let assignmentsFiltered = assignments;

        if (densityFloor > 0) {
            const protectedIndices = new Set();
            if (actuallyPreservedWhite) protectedIndices.add(whiteIndex);
            if (actuallyPreservedBlack) protectedIndices.add(blackIndex);

            const densityResult = PaletteOps._applyDensityFloor(
                assignments, finalPaletteLab, densityFloor, protectedIndices
            );

            if (densityResult.actualCount < finalPaletteLab.length) {
                finalPaletteLabFiltered = densityResult.palette;
                assignmentsFiltered = densityResult.assignments;
            }
        }

        const paletteRgbFiltered = finalPaletteLabFiltered.map(lab => LabEncoding.labToRgb(lab));

        return {
            palette: paletteRgbFiltered,
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
                detectedPeaks: detectedPeaks.map(p => ({
                    L: p.L.toFixed(1),
                    a: p.a.toFixed(1),
                    b: p.b.toFixed(1),
                    chroma: p.chroma.toFixed(1),
                    volume: (p.volume * 100).toFixed(2) + '%'
                })),
                snapThreshold,
                duration: parseFloat(duration),
                engineType: 'reveal-mk1.5'
            }
        };
    }

    /**
     * HIGHLIGHT RESCUE: Detect bright warm highlights that median cut missed.
     * @private
     */
    static _rescueHighlights(initialPaletteLab, pixelSource, highlightRescueThreshold) {
        const hlPixels = [];
        const pixelTotal = pixelSource.length / 3;

        for (let i = 0; i < pixelSource.length; i += 3) {
            const L = pixelSource[i];
            const a = pixelSource[i + 1];
            const b = pixelSource[i + 2];
            if (L > highlightRescueThreshold && b > 40 && a >= 0 && a < 20) {
                hlPixels.push({ L, a, b });
            }
        }

        const hlCount = hlPixels.length;
        const hlFraction = hlCount / pixelTotal;
        if (hlCount === 0 || hlFraction <= 0.005) return;

        const sortedB = hlPixels.map(p => p.b).sort((a, b) => a - b);
        const p90Idx = Math.min(sortedB.length - 1, Math.floor(sortedB.length * 0.90));
        const bTarget = sortedB[p90Idx];

        let hlSumL = 0, hlSumA = 0;
        for (const p of hlPixels) {
            hlSumL += p.L;
            hlSumA += p.a;
        }
        const hlCentroid = {
            L: hlSumL / hlCount,
            a: hlSumA / hlCount,
            b: bTarget
        };
        const hlC = Math.sqrt(hlCentroid.a ** 2 + hlCentroid.b ** 2);
        const hlH = ((Math.atan2(hlCentroid.b, hlCentroid.a) * 180 / Math.PI) + 360) % 360;

        let nearestDE = Infinity;
        for (let j = 0; j < initialPaletteLab.length; j++) {
            const p = initialPaletteLab[j];
            const dL = hlCentroid.L - p.L;
            const da = hlCentroid.a - p.a;
            const db = hlCentroid.b - p.b;
            const de = Math.sqrt(dL * dL + da * da + db * db);
            if (de < nearestDE) nearestDE = de;
        }

        if (nearestDE <= 20) return;

        // Quick coverage count: find lowest-coverage slot to replace
        const palLen = initialPaletteLab.length;
        const slotCounts = new Array(palLen).fill(0);
        for (let pi = 0; pi < pixelSource.length; pi += 3) {
            const pL = pixelSource[pi], pa = pixelSource[pi + 1], pb = pixelSource[pi + 2];
            let bestD = Infinity, bestJ = 0;
            for (let j = 0; j < palLen; j++) {
                const c = initialPaletteLab[j];
                const d = (pL - c.L) ** 2 + (pa - c.a) ** 2 + (pb - c.b) ** 2;
                if (d < bestD) { bestD = d; bestJ = j; }
            }
            slotCounts[bestJ]++;
        }

        let minCount = Infinity, minIdx = -1;
        for (let j = 0; j < palLen; j++) {
            if (slotCounts[j] < minCount) {
                minCount = slotCounts[j];
                minIdx = j;
            }
        }

        if (minIdx >= 0) {
            const replaced = initialPaletteLab[minIdx];
            const repC = Math.sqrt(replaced.a ** 2 + replaced.b ** 2);
            const repPct = (minCount / pixelTotal * 100).toFixed(1);
            logger.log(`[Mk1.5] Highlight rescue: ${hlCount} golden pixels (${(hlFraction * 100).toFixed(1)}%), centroid L=${hlCentroid.L.toFixed(1)} a=${hlCentroid.a.toFixed(1)} b=${hlCentroid.b.toFixed(1)} C=${hlC.toFixed(1)} H=${hlH.toFixed(1)}° → replacing Prod ${minIdx + 1} (${repPct}% coverage, C=${repC.toFixed(1)}), nearestDE=${nearestDE.toFixed(1)}`);
            initialPaletteLab[minIdx] = hlCentroid;
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = RevealMk15Engine;
}
