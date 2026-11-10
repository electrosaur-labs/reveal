/**
 * Rule of 7 — unit tests for the mesh-opening enforcement contract.
 *
 * Two functions share this responsibility, deliberately split:
 *   - applySpeckleRescue: the artist's creative despeckle knob. Zero slider
 *     + zero mesh info is a deliberate no-op — ProxyEngine's preview/undo
 *     machinery depends on "zero knobs" reproducing the clean baseline.
 *   - enforceMeshRuleOfSeven: the hard physical floor on committed output.
 *     Always applies, regardless of input — meshTPI/imageDpi default to
 *     355 TPI / 300 DPI when unspecified.
 */

const MechanicalKnobs = require('../../lib/engines/MechanicalKnobs');
const MeshPhysics = require('../../lib/utils/MeshPhysics');

function makeSinglePixelSpeckle(width, height, x, y) {
    const colorIndices = new Uint8Array(width * height);
    colorIndices[y * width + x] = 1; // color 1 = speckle, color 0 = background
    return MechanicalKnobs.rebuildMasks(colorIndices, 2, width * height);
}

describe('MechanicalKnobs.applySpeckleRescue — creative knob (unchanged contract)', () => {
    it('is a true no-op when sliderPx=0 and meshTPI=0 (ProxyEngine "zero knobs" contract)', () => {
        const width = 20, height = 20;
        const masks = makeSinglePixelSpeckle(width, height, 10, 10);
        const colorIndices = new Uint8Array(width * height);
        colorIndices[10 * width + 10] = 1;

        MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, 0);

        // Nothing changed — the isolated speckle survives untouched.
        expect(masks[1][10 * width + 10]).toBe(255);
        expect(colorIndices[10 * width + 10]).toBe(1);
    });

    it('auto-computes from meshTPI when sliderPx=0 but meshTPI>0', () => {
        const width = 20, height = 20;
        const masks = makeSinglePixelSpeckle(width, height, 10, 10);
        const colorIndices = new Uint8Array(width * height);
        colorIndices[10 * width + 10] = 1;

        MechanicalKnobs.applySpeckleRescue(masks, colorIndices, width, height, 0, 0, 230, 300);

        // 1px speckle is far below the ~10px mesh floor — removed and healed.
        expect(masks[1][10 * width + 10]).toBe(0);
        expect(colorIndices[10 * width + 10]).toBe(0);
    });
});

describe('MechanicalKnobs.enforceMeshRuleOfSeven — hard physical floor', () => {
    it('removes a sub-minimum isolated speckle with NO options at all (defaults apply)', () => {
        const width = 20, height = 20;
        const masks = makeSinglePixelSpeckle(width, height, 10, 10);
        const colorIndices = new Uint8Array(width * height);
        colorIndices[10 * width + 10] = 1;

        const result = MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, width, height);

        expect(result.clustersRemoved).toBeGreaterThan(0);
        expect(masks[1][10 * width + 10]).toBe(0);
        expect(colorIndices[10 * width + 10]).toBe(0); // healed into background
    });

    it('is never skippable: explicit meshTPI=0/imageDpi=0 still falls back to the 355/300 default floor', () => {
        const width = 20, height = 20;
        const masks = makeSinglePixelSpeckle(width, height, 10, 10);
        const colorIndices = new Uint8Array(width * height);
        colorIndices[10 * width + 10] = 1;

        const result = MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, width, height, {
            meshTPI: 0, imageDpi: 0
        });

        expect(result.clustersRemoved).toBe(1);
        expect(masks[1][10 * width + 10]).toBe(0);
    });

    it('keeps a dot that already meets the mesh floor', () => {
        const meshTPI = 230, dpi = 300;
        const floorPx = MeshPhysics.minDotPx(meshTPI, dpi); // 10
        const width = floorPx + 10, height = floorPx + 10;
        const colorIndices = new Uint8Array(width * height);
        for (let y = 2; y < 2 + floorPx; y++) {
            for (let x = 2; x < 2 + floorPx; x++) colorIndices[y * width + x] = 1;
        }
        const masks = MechanicalKnobs.rebuildMasks(colorIndices, 2, width * height);

        MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, width, height, { meshTPI, imageDpi: dpi });

        expect(masks[1][5 * width + 5]).toBe(255);
    });

    it('always preserves full mask coverage (every pixel assigned exactly one color) after healing', () => {
        const width = 30, height = 30;
        const colorIndices = new Uint8Array(width * height); // all background (0)
        // Scatter several isolated speckles of color 1, all sub-minimum.
        for (const [x, y] of [[3, 3], [10, 20], [25, 5], [15, 15]]) {
            colorIndices[y * width + x] = 1;
        }
        const masks = MechanicalKnobs.rebuildMasks(colorIndices, 2, width * height);

        MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, width, height);

        for (let i = 0; i < width * height; i++) {
            let covered = 0;
            for (const mask of masks) if (mask[i] > 0) covered++;
            expect(covered).toBe(1);
        }
    });

    it('scales the floor down correctly for a proxy (originalWidth > width)', () => {
        // Full-res floor at 230 TPI / 300 DPI is 10px. At 2x downscale (proxy
        // half the original width), the proxy floor should be ~5px.
        const meshTPI = 230, dpi = 300;
        const fullWidth = 40;
        const width = 20, height = 20; // proxy is half size
        const colorIndices = new Uint8Array(width * height);
        // 4x4 block — would survive a 5px proxy floor? No: 4 < 5, should be removed.
        for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) colorIndices[y * width + x] = 1;
        const masks = MechanicalKnobs.rebuildMasks(colorIndices, 2, width * height);

        MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, width, height, {
            meshTPI, imageDpi: dpi, originalWidth: fullWidth
        });

        expect(masks[1][3 * width + 3]).toBe(0);
    });
});
