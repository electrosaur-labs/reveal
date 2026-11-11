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
const SeparationEngine = require('../../lib/engines/SeparationEngine');

function makeMask(width, height, fillFn) {
    const mask = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (fillFn(x, y)) mask[y * width + x] = 255;
        }
    }
    return mask;
}

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

describe('SeparationEngine._pruneUnsupportedFilaments — Architect-approved additive pass (2026-11-10)', () => {
    // 355 TPI @ 300 dpi -> minSpanPx=6, dotRadius=3, maxSpanPx=6
    const minSpanPx = 6;

    it('prunes a filament stretch far from any anchor, keeps the part near the anchor', () => {
        const width = 60, height = 20;
        const mask = makeMask(width, height, (x, y) => {
            // Anchor blob: 20x16 solid square — easily dot-span-qualifying.
            if (x >= 2 && x < 22 && y >= 2 && y < 18) return true;
            // 1px-wide filament extending right from the anchor's edge.
            if (y === 10 && x >= 22 && x < 55) return true;
            return false;
        });

        const result = SeparationEngine._pruneUnsupportedFilaments(mask, width, height, minSpanPx);

        expect(result.pixelsPruned).toBeGreaterThan(0);
        expect(mask[10 * width + 24]).toBe(255); // near the anchor — survives
        expect(mask[10 * width + 50]).toBe(0);   // far from the anchor — pruned
    });

    it('leaves a uniformly thin component with no anchor anywhere untouched', () => {
        const width = 60, height = 20;
        // Perfectly 1px-wide line, never reaches dot-width anywhere.
        const mask = makeMask(width, height, (x, y) => y === 10 && x >= 5 && x < 55);
        const before = Uint8Array.from(mask);

        const result = SeparationEngine._pruneUnsupportedFilaments(mask, width, height, minSpanPx);

        expect(result.pixelsPruned).toBe(0);
        expect(mask).toEqual(before);
    });

    it('is a no-op when minSpanPx <= 1', () => {
        const width = 20, height = 20;
        const mask = makeMask(width, height, (x, y) => y === 10);
        const result = SeparationEngine._pruneUnsupportedFilaments(mask, width, height, 1);
        expect(result.pixelsPruned).toBe(0);
    });
});

describe('MechanicalKnobs.enforceMeshRuleOfSeven — filament pruning integration', () => {
    it('prunes unsupported filament pixels and cleans up resulting debris (no orphans after healing)', () => {
        const width = 60, height = 20;
        const colorIndices = new Uint8Array(width * height); // 0 = background
        for (let y = 2; y < 18; y++) for (let x = 2; x < 22; x++) colorIndices[y * width + x] = 1;
        for (let x = 22; x < 55; x++) colorIndices[10 * width + x] = 1;
        const masks = MechanicalKnobs.rebuildMasks(colorIndices, 2, width * height);

        const result = MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, width, height, {
            meshTPI: 355, imageDpi: 300
        });

        expect(result.pixelsPruned).toBeGreaterThan(0);
        expect(masks[1][10 * width + 50]).toBe(0); // far end of the filament pruned

        // No orphans: every pixel belongs to exactly one mask after healing.
        for (let i = 0; i < width * height; i++) {
            let covered = 0;
            for (const m of masks) if (m[i] > 0) covered++;
            expect(covered).toBe(1);
        }
    });

    it('does not prune a thin, anchor-less line that survives via the LINE rule', () => {
        // 3px-thick strip: locally wide enough to pass the LINE rule's width
        // test (sqDist reaches lineSqRadius=2.25 at its center row) but never
        // reaches dot-width (dotSqRadius=9) anywhere — exactly the "no anchor
        // anywhere" case the pruning pass must leave alone.
        const width = 60, height = 20;
        const colorIndices = new Uint8Array(width * height);
        for (let y = 9; y <= 11; y++) {
            for (let x = 5; x < 55; x++) colorIndices[y * width + x] = 1;
        }
        const masks = MechanicalKnobs.rebuildMasks(colorIndices, 2, width * height);

        const result = MechanicalKnobs.enforceMeshRuleOfSeven(masks, colorIndices, width, height, {
            meshTPI: 355, imageDpi: 300
        });

        expect(result.pixelsPruned).toBe(0);
        expect(masks[1][10 * width + 30]).toBe(255);
    });
});
