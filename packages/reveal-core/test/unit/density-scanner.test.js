/**
 * DensityScanner - Unit Tests
 *
 * Tests flood-fill-based connected component analysis for detecting
 * unprintable pixel clusters (density floor breaches).
 */

import { describe, it, expect } from 'vitest';

const DensityScanner = require('../../lib/metrics/DensityScanner');

describe('DensityScanner.scan', () => {

    describe('basic cluster detection', () => {
        it('reports zero breaches for empty mask', () => {
            const mask = new Uint8Array(25); // 5x5, all zero
            const result = DensityScanner.scan(mask, 5, 5, 4);
            expect(result.breachCount).toBe(0);
            expect(result.breachVolume).toBe(0);
        });

        it('reports zero breaches for fully solid mask', () => {
            const mask = new Uint8Array(25).fill(255);
            const result = DensityScanner.scan(mask, 5, 5, 4);
            expect(result.breachCount).toBe(0);
            expect(result.breachVolume).toBe(0);
        });

        it('detects single-pixel breach', () => {
            const mask = new Uint8Array(25);
            mask[12] = 255; // single pixel at center
            const result = DensityScanner.scan(mask, 5, 5, 4);
            expect(result.breachCount).toBe(1);
            expect(result.breachVolume).toBe(1);
        });

        it('detects multiple isolated single-pixel breaches', () => {
            // 5x5 mask: 3 isolated pixels at corners
            const mask = new Uint8Array(25);
            mask[0] = 255;  // (0,0)
            mask[4] = 255;  // (4,0)
            mask[24] = 255; // (4,4)
            const result = DensityScanner.scan(mask, 5, 5, 4);
            expect(result.breachCount).toBe(3);
            expect(result.breachVolume).toBe(3);
        });
    });

    describe('cluster connectivity', () => {
        it('counts 4-connected horizontal pair as one cluster', () => {
            const mask = new Uint8Array(25);
            mask[11] = 255; // (1,2)
            mask[12] = 255; // (2,2)
            const result = DensityScanner.scan(mask, 5, 5, 4);
            // 2-pixel cluster < threshold 4 → 1 breach
            expect(result.breachCount).toBe(1);
            expect(result.breachVolume).toBe(2);
        });

        it('uses 8-connectivity (diagonal neighbors)', () => {
            const mask = new Uint8Array(9); // 3x3
            mask[0] = 255; // (0,0)
            mask[4] = 255; // (1,1) — diagonal neighbor
            const result = DensityScanner.scan(mask, 3, 3, 4);
            // Should be 1 cluster of size 2 (diagonal connected)
            expect(result.breachCount).toBe(1);
            expect(result.breachVolume).toBe(2);
        });

        it('large cluster above threshold is not a breach', () => {
            // 3x3 solid block = 9 pixels, threshold 4
            const mask = new Uint8Array(25);
            for (let y = 1; y <= 3; y++) {
                for (let x = 1; x <= 3; x++) {
                    mask[y * 5 + x] = 255;
                }
            }
            const result = DensityScanner.scan(mask, 5, 5, 4);
            expect(result.breachCount).toBe(0);
        });

        it('separates two distinct clusters', () => {
            // 10x1 row: two 2-pixel clusters with a gap between
            const mask = new Uint8Array(10);
            mask[0] = 255; mask[1] = 255; // cluster 1 (2px)
            mask[8] = 255; mask[9] = 255; // cluster 2 (2px)
            const result = DensityScanner.scan(mask, 10, 1, 4);
            expect(result.breachCount).toBe(2);
            expect(result.breachVolume).toBe(4);
        });
    });

    describe('threshold behavior', () => {
        it('threshold=1 reports zero breaches (every cluster ≥ 1)', () => {
            const mask = new Uint8Array(9);
            mask[4] = 255; // single pixel
            const result = DensityScanner.scan(mask, 3, 3, 1);
            expect(result.breachCount).toBe(0);
        });

        it('threshold=2 catches single-pixel clusters', () => {
            const mask = new Uint8Array(9);
            mask[0] = 255;
            mask[8] = 255; // far corner, not connected
            const result = DensityScanner.scan(mask, 3, 3, 2);
            expect(result.breachCount).toBe(2);
            expect(result.breachVolume).toBe(2);
        });

        it('default threshold is 4', () => {
            const mask = new Uint8Array(25);
            // 3-pixel L-shape: (0,0), (1,0), (0,1)
            mask[0] = 255;
            mask[1] = 255;
            mask[5] = 255;
            const result = DensityScanner.scan(mask, 5, 5);
            expect(result.breachCount).toBe(1); // 3 < 4
        });
    });

    describe('mask value handling', () => {
        it('treats any non-zero mask value as active', () => {
            const mask = new Uint8Array(9);
            mask[4] = 1; // barely visible
            const result = DensityScanner.scan(mask, 3, 3, 4);
            expect(result.breachCount).toBe(1);
        });

        it('handles mixed mask values in a cluster', () => {
            const mask = new Uint8Array(9);
            mask[3] = 128; // (0,1)
            mask[4] = 255; // (1,1)
            mask[5] = 64;  // (2,1)
            const result = DensityScanner.scan(mask, 3, 3, 4);
            expect(result.breachCount).toBe(1); // 3 < 4
            expect(result.breachVolume).toBe(3);
        });
    });
});
