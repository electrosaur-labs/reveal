/**
 * PeakFinder Unit Tests
 * Test automatic identity peak detection for Reveal Mk 1.5
 */

import { describe, it, expect } from 'vitest';
import PeakFinder from '../../lib/analysis/PeakFinder.js';

describe('PeakFinder - Identity Peak Detection', () => {
    describe('High chroma detection', () => {
        it('should detect high-chroma pixels (C > 30)', () => {
            const peakFinder = new PeakFinder({ chromaThreshold: 30, volumeThreshold: 1.0 });

            // Create synthetic Lab array with high chroma blue
            // 10 pixels: 9 gray (C=0) + 1 blue (C=50)
            const labPixels = new Float32Array([
                // 9 gray pixels (L=50, a=0, b=0)
                50, 0, 0,
                50, 0, 0,
                50, 0, 0,
                50, 0, 0,
                50, 0, 0,
                50, 0, 0,
                50, 0, 0,
                50, 0, 0,
                50, 0, 0,
                // 1 blue pixel (L=50, a=10, b=-48) → C = sqrt(10^2 + 48^2) ≈ 49
                50, 10, -48
            ]);

            const peaks = peakFinder.findIdentityPeaks(labPixels);

            // Should detect the blue pixel as a high-chroma candidate
            expect(peaks.length).toBeGreaterThan(0);
            expect(peaks[0].chroma).toBeGreaterThan(30);
        });

        it('should NOT detect low-chroma pixels (C < 30)', () => {
            const peakFinder = new PeakFinder({ chromaThreshold: 30, volumeThreshold: 1.0 });

            // 10 pixels: all low chroma (C < 30)
            const labPixels = new Float32Array([
                50, 5, 5,   // C ≈ 7
                50, 10, 10, // C ≈ 14
                50, 15, 15, // C ≈ 21
                50, 20, 5,  // C ≈ 21
                50, 0, 0,   // C = 0
                50, 0, 0,
                50, 0, 0,
                50, 0, 0,
                50, 0, 0,
                50, 0, 0
            ]);

            const peaks = peakFinder.findIdentityPeaks(labPixels);

            // Should NOT detect any peaks (all below threshold)
            expect(peaks.length).toBe(0);
        });
    });

    describe('Low volume filtering', () => {
        it('should detect low-volume outliers (< 5%)', () => {
            const peakFinder = new PeakFinder({ chromaThreshold: 30, volumeThreshold: 0.05 });

            // 1000 pixels: 990 gray + 10 blue (1% volume)
            const labPixels = new Float32Array(1000 * 3);

            // Fill with gray
            for (let i = 0; i < 990 * 3; i += 3) {
                labPixels[i] = 50;     // L
                labPixels[i + 1] = 0;  // a
                labPixels[i + 2] = 0;  // b
            }

            // Add 10 blue pixels at the end (C=50, volume=1%)
            for (let i = 990 * 3; i < 1000 * 3; i += 3) {
                labPixels[i] = 50;
                labPixels[i + 1] = 10;
                labPixels[i + 2] = -48;
            }

            const peaks = peakFinder.findIdentityPeaks(labPixels);

            // Should detect blue as identity peak (low volume + high chroma)
            expect(peaks.length).toBeGreaterThan(0);
            expect(peaks[0].volume).toBeLessThan(0.05);
            expect(peaks[0].chroma).toBeGreaterThan(30);
        });

        it('should NOT detect high-volume colors (> 5%)', () => {
            const peakFinder = new PeakFinder({ chromaThreshold: 30, volumeThreshold: 0.05 });

            // 100 pixels: 50 gray + 50 blue (50% volume - dominant, not outlier)
            const labPixels = new Float32Array(100 * 3);

            for (let i = 0; i < 50 * 3; i += 3) {
                labPixels[i] = 50;
                labPixels[i + 1] = 0;
                labPixels[i + 2] = 0;
            }

            for (let i = 50 * 3; i < 100 * 3; i += 3) {
                labPixels[i] = 50;
                labPixels[i + 1] = 10;
                labPixels[i + 2] = -48;
            }

            const peaks = peakFinder.findIdentityPeaks(labPixels);

            // Should NOT detect peaks (blue is dominant, not an outlier)
            expect(peaks.length).toBe(0);
        });
    });

    describe('Top 3 sorting', () => {
        it('should return top 3 peaks by chroma', () => {
            const peakFinder = new PeakFinder({ chromaThreshold: 30, volumeThreshold: 1.0, maxPeaks: 3 });

            // Create 5 candidate peaks with different chroma values
            const labPixels = new Float32Array([
                // Peak 1: C=35
                50, 20, 28,
                // Peak 2: C=50
                50, 30, 40,
                // Peak 3: C=45
                50, 25, 38,
                // Peak 4: C=40
                50, 20, 35,
                // Peak 5: C=55 (highest)
                50, 35, 42
            ]);

            const peaks = peakFinder.findIdentityPeaks(labPixels);

            // Should return max 3 peaks
            expect(peaks.length).toBeLessThanOrEqual(3);

            // Should be sorted by chroma (descending)
            if (peaks.length > 1) {
                for (let i = 0; i < peaks.length - 1; i++) {
                    expect(peaks[i].chroma).toBeGreaterThanOrEqual(peaks[i + 1].chroma);
                }
            }
        });
    });

    describe('No false positives', () => {
        it('should return empty array for uniform image', () => {
            const peakFinder = new PeakFinder({ chromaThreshold: 30, volumeThreshold: 0.05 });

            // 100 pixels: all identical gray
            const labPixels = new Float32Array(100 * 3);
            for (let i = 0; i < labPixels.length; i += 3) {
                labPixels[i] = 50;
                labPixels[i + 1] = 0;
                labPixels[i + 2] = 0;
            }

            const peaks = peakFinder.findIdentityPeaks(labPixels);

            expect(peaks.length).toBe(0);
        });
    });

    describe('Grid bucketing', () => {
        it('should group nearby Lab values into buckets', () => {
            const peakFinder = new PeakFinder({ chromaThreshold: 30, volumeThreshold: 1.0, gridSize: 5 });

            // Create pixels with similar Lab values
            // L=40±2, a=5±1, b=-45±2
            const labPixels = new Float32Array([
                40, 5, -45,
                41, 6, -44,
                39, 5, -46,
                40, 4, -45,
                42, 5, -43
            ]);

            const peaks = peakFinder.findIdentityPeaks(labPixels);

            // Should detect high-chroma peaks (C > 30)
            expect(peaks.length).toBeGreaterThan(0);
            expect(peaks[0].chroma).toBeGreaterThan(30);
        });
    });
});

describe('PeakFinder - Jethro Monroe Test Case', () => {
    it('should detect Monroe blue as identity peak', () => {
        const peakFinder = new PeakFinder({ chromaThreshold: 30, volumeThreshold: 0.05 });

        // Simulate Jethro Monroe:
        // - 32% gray fur (dominant)
        // - 2% blue eyes (high chroma, low volume)
        // - 66% white background
        const totalPixels = 1000;
        const grayCount = 320;  // 32%
        const blueCount = 20;   // 2%
        const whiteCount = 660; // 66%

        const labPixels = new Float32Array(totalPixels * 3);
        let idx = 0;

        // Gray fur (C~10, low chroma)
        for (let i = 0; i < grayCount; i++) {
            labPixels[idx++] = 30;  // L
            labPixels[idx++] = 5;   // a
            labPixels[idx++] = 8;   // b (C ≈ 9.4)
        }

        // Blue eyes (C~50, high chroma)
        for (let i = 0; i < blueCount; i++) {
            labPixels[idx++] = 45;  // L
            labPixels[idx++] = 10;  // a
            labPixels[idx++] = -48; // b (C ≈ 49)
        }

        // White background (C=0)
        for (let i = 0; i < whiteCount; i++) {
            labPixels[idx++] = 100;
            labPixels[idx++] = 0;
            labPixels[idx++] = 0;
        }

        const peaks = peakFinder.findIdentityPeaks(labPixels);

        // Should detect blue eyes as identity peak
        expect(peaks.length).toBeGreaterThan(0);

        const bluePeak = peaks[0];
        expect(bluePeak.chroma).toBeGreaterThan(30);
        expect(bluePeak.volume).toBeLessThan(0.05);
        expect(bluePeak.volume).toBeCloseTo(0.02, 2); // 2% volume
    });
});
