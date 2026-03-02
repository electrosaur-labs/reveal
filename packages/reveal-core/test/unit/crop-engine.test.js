/**
 * CropEngine - Unit Tests
 *
 * Tests for viewport management, crop extraction, mechanical knobs application,
 * preview generation, and navigator map. Uses initializeWithSeparation (preferred path).
 */

import { describe, it, expect, beforeEach } from 'vitest';

const CropEngine = require('../../lib/engines/CropEngine');
const SeparationEngine = require('../../lib/engines/SeparationEngine');

// --- Helpers ---

/** Build a Uint16Array of 16-bit Lab pixels from perceptual values */
const createLab16Pixels = (values) => {
    const buf = new Uint16Array(values.length * 3);
    for (let i = 0; i < values.length; i++) {
        const { L, a, b } = values[i];
        buf[i * 3]     = Math.round((L / 100) * 32768);
        buf[i * 3 + 1] = Math.round((a / 128) * 16384 + 16384);
        buf[i * 3 + 2] = Math.round((b / 128) * 16384 + 16384);
    }
    return buf;
};

/** Create a pre-computed separation result for initializeWithSeparation */
const makeSeparationResult = (width, height, paletteSize) => {
    const palette = [];
    const rgbPalette = [];
    for (let i = 0; i < paletteSize; i++) {
        const v = Math.round((i / (paletteSize - 1)) * 100);
        palette.push({ L: v, a: 0, b: 0 });
        rgbPalette.push({ r: Math.round(v * 2.55), g: Math.round(v * 2.55), b: Math.round(v * 2.55) });
    }

    // Simple banded assignment
    const colorIndices = new Uint8Array(width * height);
    for (let i = 0; i < colorIndices.length; i++) {
        colorIndices[i] = i % paletteSize;
    }

    return { paletteLab: palette, rgbPalette, colorIndices };
};

describe('CropEngine', () => {
    let engine;

    beforeEach(() => {
        engine = new CropEngine();
    });

    describe('constructor and viewport', () => {
        it('initializes with default viewport', () => {
            expect(engine.viewportWidth).toBe(800);
            expect(engine.viewportHeight).toBe(800);
            expect(engine.viewMode).toBe('fit');
        });

        it('setViewportDimensions updates dimensions', () => {
            engine.setViewportDimensions(400, 300);
            expect(engine.viewportWidth).toBe(400);
            expect(engine.viewportHeight).toBe(300);
        });

        it('toggleViewMode switches between fit and 1:1', () => {
            expect(engine.toggleViewMode()).toBe('1:1');
            expect(engine.toggleViewMode()).toBe('fit');
        });
    });

    describe('initializeWithSeparation', () => {
        it('stores source buffer and separation state', async () => {
            const w = 20, h = 20;
            const pixels = createLab16Pixels(Array(w * h).fill({ L: 50, a: 0, b: 0 }));
            const sep = makeSeparationResult(w, h, 3);

            const result = await engine.initializeWithSeparation(pixels, w, h, sep, {});

            expect(result).toHaveProperty('palette');
            expect(result).toHaveProperty('rgbPalette');
            expect(result).toHaveProperty('dimensions');
            expect(result.dimensions.width).toBe(w);
            expect(result.dimensions.height).toBe(h);
            expect(result).toHaveProperty('elapsedMs');
        });

        it('centers viewport after initialization', async () => {
            const w = 1000, h = 800;
            const pixels = createLab16Pixels(Array(w * h).fill({ L: 50, a: 0, b: 0 }));
            const sep = makeSeparationResult(w, h, 2);
            engine.setViewportDimensions(400, 300);

            await engine.initializeWithSeparation(pixels, w, h, sep, {});

            expect(engine.viewportX).toBe(Math.floor((1000 - 400) / 2));
            expect(engine.viewportY).toBe(Math.floor((800 - 300) / 2));
        });
    });

    describe('panViewport', () => {
        it('moves viewport by delta', async () => {
            const w = 1000, h = 1000;
            const pixels = createLab16Pixels(Array(w * h).fill({ L: 50, a: 0, b: 0 }));
            const sep = makeSeparationResult(w, h, 2);
            engine.setViewportDimensions(200, 200);
            await engine.initializeWithSeparation(pixels, w, h, sep, {});

            const startX = engine.viewportX;
            const startY = engine.viewportY;
            engine.panViewport(50, -30);
            expect(engine.viewportX).toBe(startX + 50);
            expect(engine.viewportY).toBe(startY - 30);
        });

        it('clamps to image bounds', async () => {
            const w = 100, h = 100;
            const pixels = createLab16Pixels(Array(w * h).fill({ L: 50, a: 0, b: 0 }));
            const sep = makeSeparationResult(w, h, 2);
            engine.setViewportDimensions(50, 50);
            await engine.initializeWithSeparation(pixels, w, h, sep, {});

            engine.panViewport(-9999, -9999);
            expect(engine.viewportX).toBe(0);
            expect(engine.viewportY).toBe(0);

            engine.panViewport(9999, 9999);
            expect(engine.viewportX).toBeLessThanOrEqual(w - 50);
            expect(engine.viewportY).toBeLessThanOrEqual(h - 50);
        });
    });

    describe('jumpToPosition', () => {
        it('centers viewport on target position', async () => {
            const w = 1000, h = 1000;
            const pixels = createLab16Pixels(Array(w * h).fill({ L: 50, a: 0, b: 0 }));
            const sep = makeSeparationResult(w, h, 2);
            engine.setViewportDimensions(200, 200);
            await engine.initializeWithSeparation(pixels, w, h, sep, {});

            engine.jumpToPosition(500, 500);
            expect(engine.viewportX).toBe(400); // 500 - 200/2
            expect(engine.viewportY).toBe(400);
        });
    });

    describe('extractCrop', () => {
        it('throws if not initialized', async () => {
            await expect(engine.extractCrop()).rejects.toThrow('not initialized');
        });

        it('returns preview buffer with correct dimensions', async () => {
            const w = 100, h = 100;
            const pixels = createLab16Pixels(Array(w * h).fill({ L: 50, a: 0, b: 0 }));
            const sep = makeSeparationResult(w, h, 3);
            engine.setViewportDimensions(50, 50);
            await engine.initializeWithSeparation(pixels, w, h, sep, {});

            const crop = await engine.extractCrop({});
            expect(crop).toHaveProperty('previewBuffer');
            expect(crop).toHaveProperty('cropWidth');
            expect(crop).toHaveProperty('cropHeight');
            expect(crop.cropWidth).toBeLessThanOrEqual(50);
            expect(crop.cropHeight).toBeLessThanOrEqual(50);
            // RGBA buffer
            expect(crop.previewBuffer.length).toBe(crop.cropWidth * crop.cropHeight * 4);
        });

        it('applies speckleRescue without crashing', async () => {
            const w = 50, h = 50;
            const pixels = createLab16Pixels(Array(w * h).fill({ L: 50, a: 0, b: 0 }));
            const sep = makeSeparationResult(w, h, 2);
            engine.setViewportDimensions(50, 50);
            await engine.initializeWithSeparation(pixels, w, h, sep, {});

            const crop = await engine.extractCrop({ speckleRescue: 3, minVolume: 0, shadowClamp: 0 });
            expect(crop.previewBuffer.length).toBeGreaterThan(0);
        });

        it('applies shadowClamp without crashing', async () => {
            const w = 50, h = 50;
            const pixels = createLab16Pixels(Array(w * h).fill({ L: 50, a: 0, b: 0 }));
            const sep = makeSeparationResult(w, h, 2);
            engine.setViewportDimensions(50, 50);
            await engine.initializeWithSeparation(pixels, w, h, sep, {});

            const crop = await engine.extractCrop({ shadowClamp: 5, minVolume: 0, speckleRescue: 0 });
            expect(crop.previewBuffer.length).toBeGreaterThan(0);
        });
    });

    describe('getNavigatorMap', () => {
        it('returns thumbnail buffer and viewport bounds', async () => {
            const w = 200, h = 200;
            const pixels = createLab16Pixels(Array(w * h).fill({ L: 50, a: 0, b: 0 }));
            const sep = makeSeparationResult(w, h, 2);
            engine.setViewportDimensions(100, 100);
            await engine.initializeWithSeparation(pixels, w, h, sep, {});

            const map = engine.getNavigatorMap(100);
            expect(map).toHaveProperty('thumbnailBuffer');
            expect(map).toHaveProperty('thumbnailWidth');
            expect(map).toHaveProperty('thumbnailHeight');
            expect(map).toHaveProperty('viewportBounds');
            expect(map.thumbnailWidth).toBeLessThanOrEqual(100);
            expect(map.thumbnailHeight).toBeLessThanOrEqual(100);
            // RGBA thumbnail
            expect(map.thumbnailBuffer.length).toBe(map.thumbnailWidth * map.thumbnailHeight * 4);
        });
    });

    describe('getProductionConfig', () => {
        it('returns metadata with palette info', async () => {
            const w = 50, h = 50;
            const pixels = createLab16Pixels(Array(w * h).fill({ L: 50, a: 0, b: 0 }));
            const sep = makeSeparationResult(w, h, 4);
            await engine.initializeWithSeparation(pixels, w, h, sep, { bitDepth: 16 });

            const config = engine.getProductionConfig();
            expect(config).toHaveProperty('palette');
            expect(config).toHaveProperty('targetColors', 4);
            expect(config).toHaveProperty('bitDepth', 16);
        });
    });
});
