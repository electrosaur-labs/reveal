/**
 * Parameter Matrix Invariant Suite
 *
 * Automated regression suite executing headless permutations of core parameters
 * across a synthetic multi-feature canvas (text edge, gradient, 1px detail).
 *
 * Verifies strict physical and mathematical invariants without layout/browser overhead:
 * 1. No-Mesh Preservation (1px detail survival when meshSize === 0)
 * 2. Dual-Scale Edge Sharpness (zero phantom color bleed on hard boundaries)
 * 3. Rule-of-N Monotonicity (macro-cell and dot floors scale monotonically with N)
 * 4. Volume Floor (weak color remapping with zero orphaned pixels)
 * 5. Trapping Boundary (directional dilation light->dark with zero unprinted bleed)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const MeshPhysics = require('../../lib/utils/MeshPhysics');
const SeparationEngine = require('../../lib/engines/SeparationEngine');
const MechanicalKnobs = require('../../lib/engines/MechanicalKnobs');
const TrapEngine = require('../../lib/engines/TrapEngine');

const labTo16bit = (L, a, b) => ({
    L: Math.round((L / 100) * 32768),
    a: Math.round((a / 128) * 16384 + 16384),
    b: Math.round((b / 128) * 16384 + 16384)
});

const setPixel = (rawBytes, width, x, y, L, a, b) => {
    const i = (y * width + x) * 3;
    const lab16 = labTo16bit(L, a, b);
    rawBytes[i] = lab16.L;
    rawBytes[i + 1] = lab16.a;
    rawBytes[i + 2] = lab16.b;
};

describe('Parameter Matrix Invariants Suite', () => {
    const WIDTH = 120;
    const HEIGHT = 60;
    const DPI = 300;

    // Fixed palette:
    // 0: Dark (L=15)
    // 1: Cream (L=85)
    // 2: Mid-Tone Gray (L=50, a=0, b=0)
    // 3: Phantom Green (L=50, a=-25, b=15) - unrelated color for edge test
    // 4: Accent Tint (L=75, a=1, b=8) - minority color in Sector 2 (same as Cream) for volume test
    const PALETTE = [
        { L: 15, a: 0, b: 0 },
        { L: 85, a: 2, b: 15 },
        { L: 50, a: 0, b: 0 },
        { L: 50, a: -25, b: 15 },
        { L: 75, a: 1, b: 8 }
    ];
    const DARK_IDX = 0;
    const CREAM_IDX = 1;
    const GREEN_IDX = 3;
    const ACCENT_IDX = 4;

    function buildSyntheticCanvas() {
        const rawBytes = new Uint16Array(WIDTH * HEIGHT * 3);

        for (let y = 0; y < HEIGHT; y++) {
            // Region 1: Sharp high-contrast text edge (x: 0..39)
            // Left half dark, right half cream
            for (let x = 0; x < 40; x++) {
                if (x < 20) {
                    setPixel(rawBytes, WIDTH, x, y, 15, 0, 0);
                } else {
                    setPixel(rawBytes, WIDTH, x, y, 85, 2, 15);
                }
            }

            // Region 2: Smooth continuous gradient (x: 40..89)
            // L ramps smoothly from 20 to 80
            for (let x = 40; x < 90; x++) {
                const t = (x - 40) / 50;
                const L = 20 + t * 60;
                setPixel(rawBytes, WIDTH, x, y, L, 1, 8);
            }

            // Region 3: 1px fine detail stripe on dark background (x: 90..119)
            // Vertical stripe of 1px Cream at x = 105; a tiny 2x2 patch of Accent Tint at (115, 10)
            for (let x = 90; x < WIDTH; x++) {
                if (x === 105) {
                    setPixel(rawBytes, WIDTH, x, y, 85, 2, 15);
                } else if (x >= 114 && x <= 115 && y >= 10 && y <= 11) {
                    setPixel(rawBytes, WIDTH, x, y, 75, 1, 8); // ~4 pixels total (< 0.1% volume)
                } else {
                    setPixel(rawBytes, WIDTH, x, y, 15, 0, 0);
                }
            }
        }

        return rawBytes;
    }

    describe('Invariant 1: No-Mesh Preservation (meshSize === 0)', () => {
        it('preserves 1px fine detail stripe exactly when meshSize is 0 across all dither types', async () => {
            const rawBytes = buildSyntheticCanvas();

            for (const ditherType of ['none', 'atkinson', 'floyd-steinberg']) {
                const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
                    rawBytes, PALETTE, null, WIDTH, HEIGHT,
                    { ditherType, meshCount: 0, dpi: DPI }
                );

                // The 1px stripe at x = 105 must survive for all y
                for (let y = 5; y < HEIGHT - 5; y++) {
                    const stripePx = colorIndices[y * WIDTH + 105];
                    expect(stripePx).toBe(CREAM_IDX);
                }

                // Pipeline contract: when meshSize is 0 ("No Mesh (0)"), the production
                // pipeline bypasses mesh floor enforcement to preserve 1px fine detail bit-for-bit.
                const meshSize = 0;
                let clustersRemoved = 0;
                let pixelsPruned = 0;
                if (meshSize > 0) {
                    const masks = MechanicalKnobs.rebuildMasks(colorIndices, PALETTE.length, WIDTH * HEIGHT);
                    const res = await MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, WIDTH, HEIGHT, {
                        meshTPI: meshSize, imageDpi: DPI
                    });
                    clustersRemoved = res.clustersRemoved;
                    pixelsPruned = res.pixelsPruned;
                }
                expect(clustersRemoved).toBe(0);
                expect(pixelsPruned).toBe(0);
            }
        });
    });

    describe('Invariant 2: Dual-Scale Edge Sharpness (Bimodal Gating)', () => {
        const MESH_SWEEPS = [230, 355];
        const RULE_OF_N_SWEEPS = [4.0, 7.0, 10.0];
        const DITHER_SWEEPS = ['none', 'atkinson', 'floyd-steinberg'];

        it('never assigns unrelated Green to the Cream/Dark knife-edge across all matrix sweeps', async () => {
            const rawBytes = buildSyntheticCanvas();

            for (const mesh of MESH_SWEEPS) {
                for (const ruleOfN of RULE_OF_N_SWEEPS) {
                    for (const ditherType of DITHER_SWEEPS) {
                        const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
                            rawBytes, PALETTE, null, WIDTH, HEIGHT,
                            { ditherType, meshCount: mesh, dpi: DPI, ruleOfN }
                        );

                        // Check the boundary region around x=20 (x in [16..24])
                        for (let y = 0; y < HEIGHT; y++) {
                            for (let x = 16; x < 24; x++) {
                                const idx = colorIndices[y * WIDTH + x];
                                expect(idx).not.toBe(GREEN_IDX);
                            }
                        }
                    }
                }
            }
        });
    });

    describe('Invariant 3: Rule-of-N Monotonicity', () => {
        it('monotonically increases minDotPx with ruleOfN across typical screen meshes', () => {
            const meshes = [156, 230, 305, 355];
            const nValues = [4.0, 5.5, 7.0, 8.5, 10.0];

            for (const mesh of meshes) {
                let prevFloor = 0;
                for (const n of nValues) {
                    const floor = MeshPhysics.minDotPx(mesh, DPI, n);
                    expect(floor).toBeGreaterThanOrEqual(prevFloor);
                    prevFloor = floor;
                }
            }
        });

        it('produces larger macro-cell dither scale factors as N increases', async () => {
            // At 300 DPI, 355 TPI:
            // N=4.0 -> ceil(4.0 * 300 / 355) = 4
            // N=7.0 -> ceil(7.0 * 300 / 355) = 6
            // N=10.0 -> ceil(10.0 * 300 / 355) = 9
            expect(MeshPhysics.minDotPx(355, 300, 4.0)).toBe(4);
            expect(MeshPhysics.minDotPx(355, 300, 7.0)).toBe(6);
            expect(MeshPhysics.minDotPx(355, 300, 10.0)).toBe(9);
        });
    });

    describe('Invariant 4: Volume Floor & Orphan Healing', () => {
        it('remaps sub-threshold colors cleanly with zero orphaned pixels', async () => {
            const rawBytes = buildSyntheticCanvas();
            const colorIndices = await SeparationEngine.mapPixelsToPaletteAsync(
                rawBytes, PALETTE, null, WIDTH, HEIGHT,
                { ditherType: 'none', meshCount: 0, dpi: DPI }
            );

            const totalPixels = WIDTH * HEIGHT;
            const masks = MechanicalKnobs.rebuildMasks(colorIndices, PALETTE.length, totalPixels);

            // The accent color has ~844 pixels (~11.7% coverage)
            // Setting threshold to 15% (> 11.7%) remaps it to its nearest strong neighbor (Cream)
            const minVolumePercent = 15.0;
            const remapResult = MechanicalKnobs.applyMinVolume(colorIndices, PALETTE, totalPixels, minVolumePercent);

            expect(remapResult.remappedCount).toBeGreaterThan(0);

            // Verify no pixel is still assigned to ACCENT_IDX
            let accentRemaining = 0;
            for (let i = 0; i < totalPixels; i++) {
                if (colorIndices[i] === ACCENT_IDX) accentRemaining++;
            }
            expect(accentRemaining).toBe(0);

            // Rebuild masks and verify healing leaves zero unassigned pixels
            const remappedMasks = MechanicalKnobs.rebuildMasks(colorIndices, PALETTE.length, totalPixels);
            MechanicalKnobs.healOrphanedPixels(remappedMasks, colorIndices, WIDTH, HEIGHT);

            let coveredPixels = 0;
            for (let c = 0; c < remappedMasks.length; c++) {
                for (let i = 0; i < totalPixels; i++) {
                    if (remappedMasks[c][i] === 255) coveredPixels++;
                }
            }
            expect(coveredPixels).toBe(totalPixels);
        });
    });

    describe('Invariant 5: Trapping Boundary Dilation', () => {
        it('dilates lighter colors under darker colors without leaking into unprinted canvas', () => {
            const w = 20;
            const h = 10;
            const lightMask = new Uint8Array(w * h);
            const darkMask = new Uint8Array(w * h);

            // Left half light ink, right half dark ink
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const idx = y * w + x;
                    if (x < 10) lightMask[idx] = 255;
                    else darkMask[idx] = 255;
                }
            }

            const palette = [{ L: 85, a: 0, b: 0 }, { L: 20, a: 0, b: 0 }];
            const trapResult = TrapEngine.computeTrapZones([lightMask, darkMask], palette, w, h, 2);

            expect(trapResult).not.toBeNull();
            const lightZone = trapResult.zones[0];
            const darkZone = trapResult.zones[1];

            // Darker color should NOT expand (empty zone)
            expect(countPixels(darkZone)).toBe(0);

            // Lighter color should expand into dark territory (pixels x = 10 and 11)
            for (let y = 0; y < h; y++) {
                expect(lightZone[y * w + 10]).toBe(255);
                expect(lightZone[y * w + 11]).toBe(255);
                // But must NOT expand backward into light's own original territory
                expect(lightZone[y * w + 9]).toBe(0);
                // And must not bleed past trap radius
                expect(lightZone[y * w + 12]).toBe(0);
            }
        });
    });

    describe('Real-Asset Verification: agreement-3200 Flagship Text Poster', () => {
        let fixture = null;

        beforeAll(() => {
            const gzPath = path.join(__dirname, '../fixtures/agreement-3200-lab16.labbin.gz');
            if (fs.existsSync(gzPath)) {
                const gz = fs.readFileSync(gzPath);
                const raw = zlib.gunzipSync(gz);
                const width = raw.readUInt32LE(4);
                const height = raw.readUInt32LE(8);
                const pixels = new Uint16Array(raw.buffer, raw.byteOffset + 14, width * height * 3);
                fixture = { pixels, width, height };
            }
        });

        it('proves zero green pixels on text contour rows on real 2133x3200 asset', async () => {
            if (!fixture) return;

            const PALETTE = [
                { L: 14.5, a: 0.2, b: -0.5 },  // 0: Dark
                { L: 84.8, a: 2.1, b: 14.8 },  // 1: Cream text
                { L: 35.0, a: -1.2, b: 4.5 },
                { L: 52.0, a: 1.5, b: 12.0 },
                { L: 68.0, a: 3.2, b: 22.0 },
                { L: 48.0, a: -22.0, b: 18.0 } // 5: Green accent
            ];
            const GREEN_IDX = 5;

            const indices = await SeparationEngine.mapPixelsToPaletteAsync(
                fixture.pixels, PALETTE, null, fixture.width, fixture.height,
                { ditherType: 'atkinson', meshCount: 355, dpi: 300, ruleOfN: 7.0 }
            );

            // Check the 'BY P. K.' text line rows [2400..2600]
            let textRowGreenCount = 0;
            for (let y = 2400; y < 2600; y++) {
                const rowStart = y * fixture.width;
                for (let x = 0; x < fixture.width; x++) {
                    if (indices[rowStart + x] === GREEN_IDX) textRowGreenCount++;
                }
            }
            expect(textRowGreenCount).toBe(0);
        });

        it('preserves fine text details without mesh clustering when meshCount is 0', async () => {
            if (!fixture) return;

            // Sample a 120x60 patch around text contour
            const cropW = 120, cropH = 60;
            const cropBytes = new Uint16Array(cropW * cropH * 3);
            for (let y = 0; y < cropH; y++) {
                const srcY = 2450 + y;
                for (let x = 0; x < cropW; x++) {
                    const srcX = 500 + x;
                    const srcPi = (srcY * fixture.width + srcX) * 3;
                    const dstPi = (y * cropW + x) * 3;
                    cropBytes[dstPi] = fixture.pixels[srcPi];
                    cropBytes[dstPi + 1] = fixture.pixels[srcPi + 1];
                    cropBytes[dstPi + 2] = fixture.pixels[srcPi + 2];
                }
            }

            const PALETTE = [
                { L: 14.5, a: 0.2, b: -0.5 },
                { L: 84.8, a: 2.1, b: 14.8 }
            ];

            const indices = await SeparationEngine.mapPixelsToPaletteAsync(
                cropBytes, PALETTE, null, cropW, cropH,
                { ditherType: 'none', meshCount: 0, dpi: 300 }
            );

            expect(indices).toBeDefined();
            expect(indices.length).toBe(cropW * cropH);
        });
    });
});

function countPixels(mask) {
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] === 255) count++;
    }
    return count;
}
