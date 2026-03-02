/**
 * ImageHeuristicAnalyzer - Unit Tests
 *
 * Tests for artistic signature detection: halftone/noir, vibrant graphic,
 * pastel/high-key, standard default. Tests both 8-bit and 16-bit inputs.
 */

import { describe, it, expect } from 'vitest';

const ImageHeuristicAnalyzer = require('../../lib/analysis/ImageHeuristicAnalyzer');

// --- Helpers ---

/** Create uniform 8-bit Lab image (L:0-255, a/b:0-255, neutral=128) */
const make8bitImage = (L, a, b, width, height) => {
    const buf = new Uint8Array(width * height * 3);
    for (let i = 0; i < buf.length; i += 3) {
        buf[i]     = L;
        buf[i + 1] = a;
        buf[i + 2] = b;
    }
    return buf;
};

/** Create uniform 16-bit Lab image (L:0-32768, a/b:0-32768, neutral=16384) */
const make16bitImage = (L16, a16, b16, width, height) => {
    const buf = new Uint16Array(width * height * 3);
    for (let i = 0; i < buf.length; i += 3) {
        buf[i]     = L16;
        buf[i + 1] = a16;
        buf[i + 2] = b16;
    }
    return buf;
};

describe('ImageHeuristicAnalyzer', () => {

    describe('input validation', () => {
        it('rejects null pixels', () => {
            expect(() => ImageHeuristicAnalyzer.analyze(null, 10, 10))
                .toThrow('pixels must be a typed array');
        });

        it('rejects invalid dimensions', () => {
            const px = make8bitImage(127, 128, 128, 10, 10);
            expect(() => ImageHeuristicAnalyzer.analyze(px, 0, 10))
                .toThrow('positive integers');
        });

        it('rejects array too short for dimensions', () => {
            const px = new Uint8Array(10);
            expect(() => ImageHeuristicAnalyzer.analyze(px, 10, 10))
                .toThrow('pixel array too short');
        });
    });

    describe('8-bit signature detection', () => {
        it('detects "Deep Shadow / Noir" for dark images', () => {
            // Most pixels very dark (L<13 → perceptual L<5)
            const px = make8bitImage(5, 128, 128, 100, 100);
            const result = ImageHeuristicAnalyzer.analyze(px, 100, 100, { bitDepth: 8 });
            expect(result.presetId).toBe('deep-shadow-noir');
        });

        it('detects "Vibrant Graphic" for high-chroma images', () => {
            // High chroma: a=200 → perceptual a=72, b=128 → 0
            // chroma = sqrt(72²) = 72 > 45
            const px = make8bitImage(127, 200, 128, 100, 100);
            const result = ImageHeuristicAnalyzer.analyze(px, 100, 100, { bitDepth: 8 });
            expect(result.presetId).toBe('vibrant-graphic');
        });

        it('detects "Pastel / High-Key" for bright images', () => {
            // Very bright: L=230 → perceptual L≈90 > 80
            // Low chroma: a=128 b=128 → neutral → no vibrant or noir override
            const px = make8bitImage(230, 128, 128, 100, 100);
            const result = ImageHeuristicAnalyzer.analyze(px, 100, 100, { bitDepth: 8 });
            expect(result.presetId).toBe('pastel-high-key');
        });

        it('returns "Standard Default" for mid-range images', () => {
            // Medium L, low chroma
            const px = make8bitImage(127, 135, 135, 100, 100);
            const result = ImageHeuristicAnalyzer.analyze(px, 100, 100, { bitDepth: 8 });
            expect(result.presetId).toBe('standard-image');
        });
    });

    describe('16-bit signature detection', () => {
        it('detects "Deep Shadow / Noir" for 16-bit dark images', () => {
            // L=800 → perceptual L = 800/32768*100 = 2.4 < 5
            // a/b neutral
            const px = make16bitImage(800, 16384, 16384, 100, 100);
            const result = ImageHeuristicAnalyzer.analyze(px, 100, 100, { bitDepth: 16 });
            expect(result.presetId).toBe('deep-shadow-noir');
        });

        it('detects "Vibrant Graphic" for 16-bit high-chroma images', () => {
            // a = 16384 + 60*128 = 24064 → perceptual a = (24064-16384)*(128/16384) = 60
            // b = neutral → chroma = 60 > 45
            const px = make16bitImage(16384, 24064, 16384, 100, 100);
            const result = ImageHeuristicAnalyzer.analyze(px, 100, 100, { bitDepth: 16 });
            expect(result.presetId).toBe('vibrant-graphic');
        });

        it('auto-detects 16-bit from Uint16Array', () => {
            const px = make16bitImage(16384, 16384, 16384, 50, 50);
            const result = ImageHeuristicAnalyzer.analyze(px, 50, 50);
            // Should succeed without specifying bitDepth
            expect(result).toHaveProperty('presetId');
            expect(result).toHaveProperty('label');
        });
    });

    describe('return structure', () => {
        it('returns label, presetId, and timing', () => {
            const px = make8bitImage(127, 128, 128, 50, 50);
            const result = ImageHeuristicAnalyzer.analyze(px, 50, 50, { bitDepth: 8 });
            expect(result).toHaveProperty('label');
            expect(result).toHaveProperty('presetId');
            expect(result).toHaveProperty('timing');
            expect(typeof result.label).toBe('string');
            expect(typeof result.presetId).toBe('string');
            expect(typeof result.timing).toBe('number');
        });

        it('timing is a reasonable value (< 1000ms for 100x100)', () => {
            const px = make8bitImage(127, 128, 128, 100, 100);
            const result = ImageHeuristicAnalyzer.analyze(px, 100, 100, { bitDepth: 8 });
            expect(result.timing).toBeLessThan(1000);
        });
    });
});
