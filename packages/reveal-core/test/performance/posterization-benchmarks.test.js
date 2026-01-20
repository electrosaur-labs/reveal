/**
 * posterization-benchmarks.js
 * Performance baseline measurements for PosterizationEngine before optimization.
 *
 * PURPOSE: Establish timing baselines to measure the impact of stride optimization.
 *
 * CRITICAL METRICS:
 * - Full posterization workflow: Current ~3.3-4.0s for 800×800 images
 * - Assignment mapping: Current ~1.5-2.0s (40-50% of total time)
 * - Median cut: ~200-300ms with GRID_STRIDE=4
 * - Lab conversion: ~1.2-1.5s (35-40% of total time)
 *
 * OUTPUT: JSON file with timing data for regression testing
 */

import { describe, it, expect } from 'vitest';
import PosterizationEngine from '../../lib/engines/PosterizationEngine.js';
import fs from 'fs';
import path from 'path';

/**
 * Helper: Create test image data in Lab format (Photoshop byte encoding)
 * L: 0-255 (represents 0-100)
 * a: 0-255 (represents -128 to 127, neutral=128)
 * b: 0-255 (represents -128 to 127, neutral=128)
 */
function createLabImage(width, height, generator) {
    const pixels = new Uint8ClampedArray(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 3;
            const lab = generator(x, y, width, height);
            pixels[idx] = lab.L;
            pixels[idx + 1] = lab.a;
            pixels[idx + 2] = lab.b;
        }
    }
    return pixels;
}

/**
 * Helper: Measure performance of a function
 */
function measurePerformance(fn, label) {
    const startMemory = process.memoryUsage().heapUsed;
    const startTime = performance.now();

    const result = fn();

    const endTime = performance.now();
    const endMemory = process.memoryUsage().heapUsed;
    const duration = endTime - startTime;
    const memoryDelta = endMemory - startMemory;

    return {
        label,
        durationMs: Math.round(duration * 100) / 100,
        memoryDeltaMB: Math.round((memoryDelta / 1024 / 1024) * 100) / 100,
        result
    };
}

/**
 * Helper: Generate realistic photo-like image (varied luminance and chroma)
 */
function generatePhotoImage(width, height) {
    return createLabImage(width, height, (x, y, w, h) => {
        // Simulate photo with varied lighting and colors
        const centerX = w / 2;
        const centerY = h / 2;
        const distFromCenter = Math.sqrt(Math.pow(x - centerX, 2) + Math.pow(y - centerY, 2));
        const maxDist = Math.sqrt(Math.pow(centerX, 2) + Math.pow(centerY, 2));
        const normalizedDist = distFromCenter / maxDist;

        // Vignette effect (darker at edges)
        const L = Math.floor(200 - (normalizedDist * 100));

        // Color variation based on position
        const a = Math.floor(128 + Math.sin(x / 20) * 30);
        const b = Math.floor(128 + Math.cos(y / 20) * 30);

        return { L, a, b };
    });
}

/**
 * Helper: Generate high chroma image (saturated colors)
 */
function generateHighChromaImage(width, height) {
    return createLabImage(width, height, (x, y, w, h) => {
        // Create color bands with high saturation
        const band = Math.floor((x / w) * 6);
        const L = 128;

        // High chroma colors in Lab space
        const colors = [
            { a: 80, b: 70 },   // Red
            { a: -80, b: 70 },  // Yellow
            { a: -80, b: -70 }, // Green
            { a: 0, b: -80 },   // Blue
            { a: 80, b: -70 },  // Magenta
            { a: 80, b: 0 }     // Pink
        ];

        const color = colors[band];
        return { L, a: color.a + 128, b: color.b + 128 };
    });
}

/**
 * Helper: Generate grayscale gradient
 */
function generateGrayscaleImage(width, height) {
    return createLabImage(width, height, (x, y, w, h) => {
        const L = Math.floor((x / w) * 255);
        return { L, a: 128, b: 128 };
    });
}

// Global results object to collect all benchmark data
const benchmarkResults = {
    timestamp: new Date().toISOString(),
    system: {
        platform: process.platform,
        nodeVersion: process.version,
        arch: process.arch
    },
    benchmarks: {}
};

describe('PosterizationEngine - Performance Benchmarks', () => {

    describe('Full Workflow Benchmarks (800×800)', () => {
        const width = 800;
        const height = 800;
        const totalPixels = width * height;

        it('Baseline: Photo-like image with 8 colors', () => {
            const labPixels = generatePhotoImage(width, height);

            const measurement = measurePerformance(() => {
                return PosterizationEngine.posterize(labPixels, width, height, 8, {
                    engineType: 'reveal',
                    centroidStrategy: 'SALIENCY',
                    format: 'lab'
                });
            }, 'Full Workflow: Photo 8c');

            const { result, durationMs, memoryDeltaMB } = measurement;

            // Record baseline
            benchmarkResults.benchmarks.fullWorkflow_photo_8c = {
                width,
                height,
                totalPixels,
                targetColors: 8,
                durationMs,
                memoryDeltaMB,
                pixelsPerMs: Math.round(totalPixels / durationMs),
                paletteSize: result.palette.length
            };

            console.log(`\n📊 Full Workflow (Photo 8c): ${durationMs}ms (${Math.round(totalPixels / durationMs)} pixels/ms)`);
            console.log(`   Memory delta: ${memoryDeltaMB}MB`);
            console.log(`   Palette size: ${result.palette.length}`);

            // Verify result structure
            expect(result.palette.length).toBeGreaterThan(0);
            expect(result.assignments.length).toBe(totalPixels);

            // Expected baseline: 3.3-4.0s for 800×800
            // This is the BEFORE measurement
            console.log(`   ⚠️ BASELINE (BEFORE optimization): Target < 2000ms after stride fix`);
        });

        it('Baseline: High chroma image with 12 colors', () => {
            const labPixels = generateHighChromaImage(width, height);

            const measurement = measurePerformance(() => {
                return PosterizationEngine.posterize(labPixels, width, height, 12, {
                    engineType: 'reveal',
                    centroidStrategy: 'SALIENCY',
                    format: 'lab'
                });
            }, 'Full Workflow: High Chroma 12c');

            const { result, durationMs, memoryDeltaMB } = measurement;

            benchmarkResults.benchmarks.fullWorkflow_highChroma_12c = {
                width,
                height,
                totalPixels,
                targetColors: 12,
                durationMs,
                memoryDeltaMB,
                pixelsPerMs: Math.round(totalPixels / durationMs),
                paletteSize: result.palette.length
            };

            console.log(`\n📊 Full Workflow (High Chroma 12c): ${durationMs}ms (${Math.round(totalPixels / durationMs)} pixels/ms)`);
            console.log(`   Memory delta: ${memoryDeltaMB}MB`);
            console.log(`   Palette size: ${result.palette.length}`);

            expect(result.palette.length).toBeGreaterThan(0);
            expect(result.assignments.length).toBe(totalPixels);
        });

        it('Baseline: Grayscale image with 8 colors', () => {
            const labPixels = generateGrayscaleImage(width, height);

            const measurement = measurePerformance(() => {
                return PosterizationEngine.posterize(labPixels, width, height, 8, {
                    engineType: 'reveal',
                    centroidStrategy: 'SALIENCY',
                    format: 'lab'
                });
            }, 'Full Workflow: Grayscale 8c');

            const { result, durationMs, memoryDeltaMB } = measurement;

            benchmarkResults.benchmarks.fullWorkflow_grayscale_8c = {
                width,
                height,
                totalPixels,
                targetColors: 8,
                durationMs,
                memoryDeltaMB,
                pixelsPerMs: Math.round(totalPixels / durationMs),
                paletteSize: result.palette.length
            };

            console.log(`\n📊 Full Workflow (Grayscale 8c): ${durationMs}ms (${Math.round(totalPixels / durationMs)} pixels/ms)`);
            console.log(`   Memory delta: ${memoryDeltaMB}MB`);
            console.log(`   Palette size: ${result.palette.length}`);

            expect(result.palette.length).toBeGreaterThan(0);
            expect(result.assignments.length).toBe(totalPixels);
        });
    });

    describe('Image Size Scaling Benchmarks', () => {
        const sizes = [
            { width: 400, height: 400, label: '400×400' },
            { width: 600, height: 600, label: '600×600' },
            { width: 800, height: 800, label: '800×800' },
            { width: 1000, height: 1000, label: '1000×1000' }
        ];

        sizes.forEach(({ width, height, label }) => {
            it(`Scaling: ${label} photo-like image`, () => {
                const totalPixels = width * height;
                const labPixels = generatePhotoImage(width, height);

                const measurement = measurePerformance(() => {
                    return PosterizationEngine.posterize(labPixels, width, height, 8, {
                        engineType: 'reveal',
                        centroidStrategy: 'SALIENCY',
                        format: 'lab'
                    });
                }, `Scaling: ${label}`);

                const { result, durationMs, memoryDeltaMB } = measurement;

                benchmarkResults.benchmarks[`scaling_${label}`] = {
                    width,
                    height,
                    totalPixels,
                    targetColors: 8,
                    durationMs,
                    memoryDeltaMB,
                    pixelsPerMs: Math.round(totalPixels / durationMs),
                    msPerMegapixel: Math.round(durationMs / (totalPixels / 1000000))
                };

                console.log(`\n📊 Scaling ${label}: ${durationMs}ms (${Math.round(totalPixels / durationMs)} pixels/ms)`);
                console.log(`   ${Math.round(durationMs / (totalPixels / 1000000))}ms per megapixel`);
                console.log(`   Memory delta: ${memoryDeltaMB}MB`);

                expect(result.assignments.length).toBe(totalPixels);
            });
        });
    });

    describe('Color Count Scaling Benchmarks', () => {
        const width = 800;
        const height = 800;
        const totalPixels = width * height;
        const colorCounts = [4, 6, 8, 10, 12];

        colorCounts.forEach(targetColors => {
            it(`Color Count: ${targetColors} colors`, () => {
                const labPixels = generatePhotoImage(width, height);

                const measurement = measurePerformance(() => {
                    return PosterizationEngine.posterize(labPixels, width, height, targetColors, {
                        engineType: 'reveal',
                        centroidStrategy: 'SALIENCY',
                        format: 'lab'
                    });
                }, `Color Count: ${targetColors}c`);

                const { result, durationMs, memoryDeltaMB } = measurement;

                benchmarkResults.benchmarks[`colorCount_${targetColors}c`] = {
                    width,
                    height,
                    totalPixels,
                    targetColors,
                    durationMs,
                    memoryDeltaMB,
                    pixelsPerMs: Math.round(totalPixels / durationMs),
                    paletteSize: result.palette.length
                };

                console.log(`\n📊 Color Count ${targetColors}c: ${durationMs}ms`);
                console.log(`   Memory delta: ${memoryDeltaMB}MB`);

                expect(result.assignments.length).toBe(totalPixels);
            });
        });
    });

    describe('Memory Profiling', () => {
        it('Memory usage: Large image (1200×1200)', () => {
            const width = 1200;
            const height = 1200;
            const totalPixels = width * height;

            const labPixels = generatePhotoImage(width, height);

            // Force GC if available
            if (global.gc) {
                global.gc();
            }

            const startMemory = process.memoryUsage();
            const startTime = performance.now();

            const result = PosterizationEngine.posterize(labPixels, width, height, 8, {
                engineType: 'reveal',
                centroidStrategy: 'SALIENCY',
                format: 'lab'
            });

            const endTime = performance.now();
            const endMemory = process.memoryUsage();

            const duration = endTime - startTime;
            const heapDelta = endMemory.heapUsed - startMemory.heapUsed;
            const heapTotal = endMemory.heapTotal;
            const external = endMemory.external;

            benchmarkResults.benchmarks.memoryProfile_1200x1200 = {
                width,
                height,
                totalPixels,
                targetColors: 8,
                durationMs: Math.round(duration * 100) / 100,
                heapDeltaMB: Math.round((heapDelta / 1024 / 1024) * 100) / 100,
                heapTotalMB: Math.round((heapTotal / 1024 / 1024) * 100) / 100,
                externalMB: Math.round((external / 1024 / 1024) * 100) / 100,
                bytesPerPixel: Math.round(heapDelta / totalPixels)
            };

            console.log(`\n📊 Memory Profile (1200×1200):`);
            console.log(`   Duration: ${Math.round(duration)}ms`);
            console.log(`   Heap delta: ${Math.round(heapDelta / 1024 / 1024)}MB`);
            console.log(`   Heap total: ${Math.round(heapTotal / 1024 / 1024)}MB`);
            console.log(`   External: ${Math.round(external / 1024 / 1024)}MB`);
            console.log(`   Bytes per pixel: ${Math.round(heapDelta / totalPixels)}`);

            expect(result.assignments.length).toBe(totalPixels);
        });
    });

    // After all tests, write results to file
    describe('Results Export', () => {
        it('Write benchmark results to JSON file', () => {
            const outputDir = path.join(process.cwd(), 'test', 'performance', 'results');
            const outputFile = path.join(outputDir, `baseline-${Date.now()}.json`);

            // Create directory if it doesn't exist
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            // Write results
            fs.writeFileSync(outputFile, JSON.stringify(benchmarkResults, null, 2));

            console.log(`\n✅ Benchmark results written to: ${outputFile}`);
            console.log(`\n📈 SUMMARY:`);
            console.log(`   Total benchmarks: ${Object.keys(benchmarkResults.benchmarks).length}`);

            // Calculate average performance
            const fullWorkflowBenchmarks = Object.entries(benchmarkResults.benchmarks)
                .filter(([key]) => key.startsWith('fullWorkflow_'))
                .map(([_, data]) => data.durationMs);

            if (fullWorkflowBenchmarks.length > 0) {
                const avgDuration = fullWorkflowBenchmarks.reduce((a, b) => a + b, 0) / fullWorkflowBenchmarks.length;
                console.log(`   Average full workflow (800×800): ${Math.round(avgDuration)}ms`);
                console.log(`   Target after optimization: < 2000ms`);
                console.log(`   Expected speedup: 40-50% (assignment stride)`);
            }

            expect(fs.existsSync(outputFile)).toBe(true);
        });
    });
});
