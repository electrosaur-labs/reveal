/**
 * Unit Tests for Density Floor (Ghost Color Removal)
 *
 * Tests the post-processing filter that removes palette colors with < 0.5% pixel coverage.
 * This eliminates sparse/outlier colors without modifying the median cut algorithm.
 */

import { describe, test, expect } from 'vitest';

const PaletteOps = require('../../lib/engines/PaletteOps');

describe('Density Floor (Ghost Color Removal)', () => {
    describe('Basic Filtering', () => {
        test('should remove colors with < 0.5% coverage', () => {
            // Create test data: 1000 pixels, 5 colors
            // Color at index 2 has only 3 pixels (0.3%)
            const palette = [
                { L: 50, a: 0, b: 0 },      // Index 0 - 250 pixels (25%)
                { L: 60, a: 10, b: 10 },    // Index 1 - 250 pixels (25%)
                { L: 70, a: -20, b: 30 },   // Index 2 - SPARSE (3 pixels, 0.3%)
                { L: 80, a: 5, b: -15 },    // Index 3 - 247 pixels (24.7%)
                { L: 90, a: 0, b: 0 }       // Index 4 - 250 pixels (25%)
            ];

            // Assignments: mostly 0, 1, 3, 4, with only 3 pixels of color 2
            const assignments = new Uint8Array(1000);
            for (let i = 0; i < 250; i++) assignments[i] = 0;
            for (let i = 250; i < 500; i++) assignments[i] = 1;
            assignments[500] = 2; // Only 3 pixels
            assignments[501] = 2;
            assignments[502] = 2;
            for (let i = 503; i < 750; i++) assignments[i] = 3;
            for (let i = 750; i < 1000; i++) assignments[i] = 4;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005  // 0.5%
            );

            expect(result.palette.length).toBe(4);  // One removed
            expect(result.actualCount).toBe(4);
            expect(result.assignments.length).toBe(1000);

            // Verify sparse color's pixels were reassigned (not index 2)
            expect(result.assignments[500]).not.toBe(2);
            expect(result.assignments[501]).not.toBe(2);
            expect(result.assignments[502]).not.toBe(2);
        });

        test('should not modify if all colors meet threshold', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },
                { L: 70, a: 10, b: 10 }
            ];

            // Each color has 500 pixels (50%)
            const assignments = new Uint8Array(1000);
            for (let i = 0; i < 500; i++) assignments[i] = 0;
            for (let i = 500; i < 1000; i++) assignments[i] = 1;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005
            );

            expect(result.palette.length).toBe(2);
            expect(result.actualCount).toBe(2);
            expect(result.palette).toEqual(palette);
            expect(result.assignments).toBe(assignments); // Same reference
        });

        test('should handle multiple sparse colors', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // Index 0 - 400 pixels (40%)
                { L: 60, a: 10, b: 10 },    // Index 1 - SPARSE (2 pixels, 0.2%)
                { L: 70, a: -20, b: 30 },   // Index 2 - 400 pixels (40%)
                { L: 80, a: 5, b: -15 },    // Index 3 - SPARSE (3 pixels, 0.3%)
                { L: 90, a: 0, b: 0 }       // Index 4 - 195 pixels (19.5%)
            ];

            const assignments = new Uint8Array(1000);
            for (let i = 0; i < 400; i++) assignments[i] = 0;
            assignments[400] = 1; // 2 sparse pixels
            assignments[401] = 1;
            for (let i = 402; i < 802; i++) assignments[i] = 2;
            assignments[802] = 3; // 3 sparse pixels
            assignments[803] = 3;
            assignments[804] = 3;
            for (let i = 805; i < 1000; i++) assignments[i] = 4;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005
            );

            // Two colors should be removed (indices 1 and 3)
            expect(result.palette.length).toBe(3);
            expect(result.actualCount).toBe(3);

            // Verify sparse pixels were reassigned
            expect(result.assignments[400]).not.toBe(1);
            expect(result.assignments[401]).not.toBe(1);
            expect(result.assignments[802]).not.toBe(3);
            expect(result.assignments[803]).not.toBe(3);
            expect(result.assignments[804]).not.toBe(3);
        });
    });

    describe('Nearest Color Reassignment', () => {
        test('should find nearest surviving color correctly', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // Black-ish
                { L: 55, a: 5, b: 5 },      // Very close to black - SPARSE
                { L: 90, a: 0, b: 0 }       // White
            ];

            // Sparse color (index 1) has < 0.5%
            const assignments = new Uint8Array(1000);
            for (let i = 0; i < 496; i++) assignments[i] = 0;
            for (let i = 496; i < 500; i++) assignments[i] = 1; // 4 pixels (0.4% - below threshold)
            for (let i = 500; i < 1000; i++) assignments[i] = 2;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005
            );

            // Color 1 should be removed, pixels reassigned to color 0 (nearest)
            expect(result.palette.length).toBe(2);

            // Verify reassignment to nearest (index 0, not index 2)
            // After remapping, color 0 is still at index 0
            expect(result.assignments[495]).toBe(0);
            expect(result.assignments[496]).toBe(0);
            expect(result.assignments[497]).toBe(0);
            expect(result.assignments[498]).toBe(0);
            expect(result.assignments[499]).toBe(0);
        });

        test('should use Euclidean distance in Lab space', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // Index 0
                { L: 60, a: 20, b: 30 },    // Index 1 - SPARSE (close to index 2)
                { L: 65, a: 25, b: 35 },    // Index 2 - closest to index 1
                { L: 90, a: 0, b: 0 }       // Index 3 - far from index 1
            ];

            const assignments = new Uint8Array(1000);
            for (let i = 0; i < 300; i++) assignments[i] = 0;
            for (let i = 300; i < 304; i++) assignments[i] = 1; // 4 sparse pixels (0.4%)
            for (let i = 304; i < 700; i++) assignments[i] = 2;
            for (let i = 700; i < 1000; i++) assignments[i] = 3;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005
            );

            // Index 1 removed, pixels should map to index 2 (closest)
            // After removal: [0, 2, 3] → indices [0, 1, 2]
            expect(result.palette.length).toBe(3);

            // The sparse pixels should be reassigned to what was originally index 2
            // which is now at index 1 in the clean palette
            expect(result.assignments[300]).toBe(1);
            expect(result.assignments[301]).toBe(1);
            expect(result.assignments[302]).toBe(1);
            expect(result.assignments[303]).toBe(1);
        });
    });

    describe('Index Remapping', () => {
        test('should correctly remap indices for surviving colors', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // Index 0 → stays 0
                { L: 60, a: 10, b: 10 },    // Index 1 - SPARSE (removed)
                { L: 70, a: -20, b: 30 },   // Index 2 → becomes 1
                { L: 80, a: 5, b: -15 }     // Index 3 → becomes 2
            ];

            const assignments = new Uint8Array(1000);
            for (let i = 0; i < 400; i++) assignments[i] = 0;
            assignments[400] = 1; // Sparse pixel
            for (let i = 401; i < 700; i++) assignments[i] = 2;
            for (let i = 700; i < 1000; i++) assignments[i] = 3;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005
            );

            expect(result.palette.length).toBe(3);

            // Check remapping
            expect(result.assignments[0]).toBe(0);      // Index 0 → 0
            expect(result.assignments[500]).toBe(1);    // Index 2 → 1
            expect(result.assignments[800]).toBe(2);    // Index 3 → 2
        });

        test('should handle non-contiguous removals', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // Index 0 → stays 0
                { L: 60, a: 10, b: 10 },    // Index 1 → stays 1
                { L: 70, a: -20, b: 30 },   // Index 2 - SPARSE (removed)
                { L: 80, a: 5, b: -15 },    // Index 3 → becomes 2
                { L: 85, a: 0, b: 20 },     // Index 4 - SPARSE (removed)
                { L: 90, a: 0, b: 0 }       // Index 5 → becomes 3
            ];

            const assignments = new Uint8Array(1200);
            for (let i = 0; i < 200; i++) assignments[i] = 0;
            for (let i = 200; i < 400; i++) assignments[i] = 1;
            assignments[400] = 2; // Sparse (1 pixel)
            for (let i = 401; i < 700; i++) assignments[i] = 3;
            assignments[700] = 4; // Sparse (1 pixel)
            for (let i = 701; i < 1200; i++) assignments[i] = 5;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005
            );

            expect(result.palette.length).toBe(4);

            // Check remapping of surviving colors
            expect(result.assignments[100]).toBe(0);    // Index 0 → 0
            expect(result.assignments[300]).toBe(1);    // Index 1 → 1
            expect(result.assignments[500]).toBe(2);    // Index 3 → 2
            expect(result.assignments[900]).toBe(3);    // Index 5 → 3
        });
    });

    describe('Custom Thresholds', () => {
        test('should respect custom threshold (1%)', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // Index 0 - 900 pixels (90%)
                { L: 60, a: 10, b: 10 },    // Index 1 - 8 pixels (0.8% - below 1%)
                { L: 70, a: -20, b: 30 }    // Index 2 - 92 pixels (9.2%)
            ];

            const assignments = new Uint8Array(1000);
            for (let i = 0; i < 900; i++) assignments[i] = 0;
            for (let i = 900; i < 908; i++) assignments[i] = 1;
            for (let i = 908; i < 1000; i++) assignments[i] = 2;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.01  // 1% threshold
            );

            // Index 1 should be removed (0.8% < 1%)
            expect(result.palette.length).toBe(2);
            expect(result.actualCount).toBe(2);
        });

        test('should respect custom threshold (0.1%)', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // Index 0 - 998 pixels (99.8%)
                { L: 60, a: 10, b: 10 }     // Index 1 - 2 pixels (0.2%)
            ];

            const assignments = new Uint8Array(1000);
            for (let i = 0; i < 998; i++) assignments[i] = 0;
            assignments[998] = 1;
            assignments[999] = 1;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.001  // 0.1% threshold
            );

            // Index 1 should survive (0.2% > 0.1%)
            expect(result.palette.length).toBe(2);
            expect(result.actualCount).toBe(2);
        });
    });

    describe('Transparent Pixel Handling', () => {
        test('should skip transparent pixels (assignment = 255)', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // Index 0 - 400 pixels
                { L: 70, a: 10, b: 10 }     // Index 1 - 400 pixels
            ];

            // 1000 pixels: 400 color 0, 400 color 1, 200 transparent
            const assignments = new Uint8Array(1000);
            for (let i = 0; i < 400; i++) assignments[i] = 0;
            for (let i = 400; i < 800; i++) assignments[i] = 1;
            for (let i = 800; i < 1000; i++) assignments[i] = 255; // Transparent pixels

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005
            );

            // Both colors should survive (each has 40% of non-transparent pixels)
            expect(result.palette.length).toBe(2);

            // Verify transparent pixels preserved
            expect(result.assignments[800]).toBe(255);
            expect(result.assignments[900]).toBe(255);
            expect(result.assignments[999]).toBe(255);
        });

        test('should calculate coverage as percentage of total pixels (including transparent)', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // Index 0 - 990 pixels
                { L: 70, a: 10, b: 10 }     // Index 1 - 10 pixels
            ];

            // 10000 pixels: 990 color 0, 10 color 1, 9000 transparent
            const assignments = new Uint8Array(10000);
            for (let i = 0; i < 990; i++) assignments[i] = 0;
            for (let i = 990; i < 1000; i++) assignments[i] = 1;
            for (let i = 1000; i < 10000; i++) assignments[i] = 255;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005  // 0.5%
            );

            // Color 1 has 10/10000 = 0.1% of total pixels (< 0.5%)
            // So color 1 should be removed
            expect(result.palette.length).toBe(1);
            expect(result.palette[0]).toEqual({ L: 50, a: 0, b: 0 });
        });
    });

    describe('Edge Cases', () => {
        test('should handle empty assignments', () => {
            const palette = [
                { L: 50, a: 0, b: 0 }
            ];

            const assignments = new Uint8Array(0);

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005
            );

            // With 0 pixels, we can't calculate meaningful coverage
            // The edge case handler returns original palette (safe fallback)
            expect(result.palette.length).toBe(1);
            expect(result.assignments.length).toBe(0);
        });

        test('should handle single pixel', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },
                { L: 70, a: 10, b: 10 }
            ];

            const assignments = new Uint8Array([0]);

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005
            );

            // Index 0 has 100%, index 1 has 0% (should be removed)
            expect(result.palette.length).toBe(1);
            expect(result.assignments[0]).toBe(0);
        });

        test('should handle boundary value (exactly 0.5%)', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // 995 pixels
                { L: 70, a: 10, b: 10 }     // 5 pixels (exactly 0.5%)
            ];

            const assignments = new Uint8Array(1000);
            for (let i = 0; i < 995; i++) assignments[i] = 0;
            for (let i = 995; i < 1000; i++) assignments[i] = 1;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005  // 0.5%
            );

            // 5/1000 = 0.005 (exactly 0.5%), should meet threshold
            expect(result.palette.length).toBe(2);
            expect(result.actualCount).toBe(2);
        });

        test('should handle boundary value - 1 pixel (just below 0.5%)', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },      // 996 pixels
                { L: 70, a: 10, b: 10 }     // 4 pixels (0.4%, below threshold)
            ];

            const assignments = new Uint8Array(1000);
            for (let i = 0; i < 996; i++) assignments[i] = 0;
            for (let i = 996; i < 1000; i++) assignments[i] = 1;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005  // 0.5%
            );

            // 4/1000 = 0.004 (0.4%), should be removed
            expect(result.palette.length).toBe(1);
            expect(result.actualCount).toBe(1);
        });

        test('should handle very small dataset where all colors are actually viable', () => {
            const palette = [
                { L: 50, a: 0, b: 0 },
                { L: 70, a: 10, b: 10 },
                { L: 90, a: -10, b: -10 }
            ];

            // Each color has 1 pixel out of 3 total (33.3% each - well above 0.5%)
            const assignments = new Uint8Array([0, 1, 2]);

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005  // 0.5%
            );

            // All colors have 33.3% coverage (>> 0.5%), so all survive
            expect(result.palette.length).toBe(3);
            expect(result.actualCount).toBe(3);
        });

    });

    describe('Large Dataset Performance', () => {
        test('should handle large datasets efficiently', () => {
            const pixelCount = 100000;
            const palette = [
                { L: 50, a: 0, b: 0 },
                { L: 60, a: 10, b: 10 },
                { L: 70, a: -20, b: 30 },
                { L: 80, a: 5, b: -15 }
            ];

            const assignments = new Uint8Array(pixelCount);
            // Color 0: 40%, Color 1: 40%, Color 2: 0.1% (sparse), Color 3: 19.9%
            for (let i = 0; i < 40000; i++) assignments[i] = 0;
            for (let i = 40000; i < 80000; i++) assignments[i] = 1;
            for (let i = 80000; i < 80100; i++) assignments[i] = 2;
            for (let i = 80100; i < 100000; i++) assignments[i] = 3;

            const startTime = performance.now();
            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005
            );
            const duration = performance.now() - startTime;

            expect(result.palette.length).toBe(3);
            expect(duration).toBeLessThan(100); // Should complete in < 100ms
        });
    });

    describe('Real-World Scenario: 16-bit Lab Sparse Color', () => {
        test('should remove the problematic (81, -1, 64) color at 0.03%', () => {
            // Simulated scenario from user's 16-bit Lab document
            const palette = [
                { L: 85, a: 128, b: 128 },  // White-ish
                { L: 80, a: 130, b: 190 },  // Yellow
                { L: 81, a: 127, b: 192 },  // The problematic sparse color (81, -1, 64 in signed)
                { L: 78, a: 128, b: 185 },  // Another yellow
                { L: 10, a: 128, b: 128 }   // Black-ish
            ];

            // 10000 pixels total, sparse color has 3 pixels (0.03%)
            const assignments = new Uint8Array(10000);
            for (let i = 0; i < 3000; i++) assignments[i] = 0;
            for (let i = 3000; i < 6000; i++) assignments[i] = 1;
            assignments[6000] = 2; // Only 3 pixels
            assignments[6001] = 2;
            assignments[6002] = 2;
            for (let i = 6003; i < 8000; i++) assignments[i] = 3;
            for (let i = 8000; i < 10000; i++) assignments[i] = 4;

            const result = PaletteOps._applyDensityFloor(
                assignments,
                palette,
                0.005  // 0.5%
            );

            // Sparse color (index 2) should be removed
            expect(result.palette.length).toBe(4);
            expect(result.actualCount).toBe(4);

            // Verify the sparse color is not in the final palette
            expect(result.palette).not.toContainEqual({ L: 81, a: 127, b: 192 });

            // Verify sparse pixels were reassigned (probably to index 1 or 3, nearby yellows)
            expect(result.assignments[6000]).not.toBe(2);
            expect(result.assignments[6001]).not.toBe(2);
            expect(result.assignments[6002]).not.toBe(2);
        });
    });
});
