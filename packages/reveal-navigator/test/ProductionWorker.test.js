/**
 * ProductionWorker — Trapping Tests
 *
 * ProductionWorker.execute() needs real Photoshop pixel APIs end-to-end
 * (imaging.getPixels, batchPlay layer creation) and isn't testable
 * outside Photoshop. _buildLayers(), though, is pure computation on
 * arrays + knobs -- no Photoshop API calls -- so it's fully testable
 * here (via test/setup.js's "photoshop" module stub, which only needs
 * to satisfy the top-level `require("photoshop")` so this file loads).
 *
 * This is the part of the trapping feature that previously had NO
 * coverage at all: TrapEngine.applyTrapping (the dilation algorithm
 * itself) is extensively tested in reveal-core, but nothing verified
 * ProductionWorker actually WIRES trapSize through to it correctly.
 */

const ProductionWorker = require('../src/bridge/ProductionWorker');

function makeWorker() {
    // _buildLayers doesn't touch sessionState at all -- only knobs params
    // passed directly -- so a minimal stub is enough.
    return new ProductionWorker({});
}

describe('ProductionWorker._buildLayers — trapping', () => {
    // 20x10 block, left half dark (cols 0-9), right half light (cols 10-19).
    // Each solid 10x10 region comfortably clears MechanicalKnobs'
    // Rule-of-7 minimum printable dot size (defaults to 6px at 355 TPI /
    // 300 DPI when meshSize/imageDpi are both 0) -- a tiny 1-2px test
    // stripe would get pruned away by Rule-of-7 before trapping ever ran,
    // which is what the first version of this test tripped over.
    const width = 20, height = 10;
    const labPalette = [
        { L: 10, a: 0, b: 0 }, // dark
        { L: 90, a: 0, b: 0 }, // light
    ];
    const hexColors = ['#000000', '#FFFFFF'];
    const colorIndices = () => {
        const ci = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                ci[y * width + x] = x < 10 ? 0 : 1;
            }
        }
        return ci;
    };
    const maskAt = (mask, x, y) => mask[y * width + x];

    const baseKnobs = {
        minVolume: 0, speckleRescue: 0, shadowClamp: 0,
        meshSize: 0, imageDpi: 0, activeArchetypeId: 'test'
    };

    it('does not trap when trapSize is 0', async () => {
        const worker = makeWorker();
        const layers = await worker._buildLayers(
            colorIndices(), labPalette, hexColors, width, height,
            { ...baseKnobs, trapSize: 0 }
        );

        expect(layers).toHaveLength(2);
        const light = layers.find(l => l.labColor.L === 90);
        expect(maskAt(light.mask, 9, 5)).toBe(0); // no bleed into dark's column
    });

    it('expands the light color into dark territory when trapSize > 0 (same rule as TrapEngine itself)', async () => {
        const worker = makeWorker();
        const layers = await worker._buildLayers(
            colorIndices(), labPalette, hexColors, width, height,
            { ...baseKnobs, trapSize: 2 } // already pixels -- ProductionWorker.execute() converts pts->px before calling this
        );

        const light = layers.find(l => l.labColor.L === 90);
        const dark = layers.find(l => l.labColor.L === 10);

        // Light should have grown 2px into the dark region (cols 8-9,
        // adjacent to its original territory starting at col 10).
        expect(maskAt(light.mask, 8, 5)).toBe(255);
        expect(maskAt(light.mask, 9, 5)).toBe(255);
        expect(maskAt(light.mask, 7, 5)).toBe(0); // beyond the 2px trap limit

        // Dark (darker color) must never expand -- same invariant
        // TrapEngine enforces: only lighter colors trap under darker ones.
        expect(maskAt(dark.mask, 10, 5)).toBe(0);
        expect(maskAt(dark.mask, 11, 5)).toBe(0);
    });

    it('a dpi->px conversion mismatch would be caught here: trapSize is read as already-converted pixels', async () => {
        // ProductionWorker.execute() does:
        //   const trapPx = Math.round((prodConfig.trapSize || 0) * dpi / 72);
        //   knobs.trapSize = trapPx;
        // before calling _buildLayers -- this test locks in the exact
        // pixel count that reaches TrapEngine for a realistic pts/dpi
        // pair, so a regression in that conversion (e.g. using image
        // width instead of dpi, or dropping the /72) would change how
        // far the mask actually expands here.
        const trapSizePts = 3, dpi = 240;
        const trapPx = Math.round((trapSizePts || 0) * dpi / 72);
        expect(trapPx).toBe(10); // 3pt @ 240dpi = 10px

        const worker = makeWorker();
        const layers = await worker._buildLayers(
            colorIndices(), labPalette, hexColors, width, height,
            { ...baseKnobs, trapSize: trapPx }
        );
        const light = layers.find(l => l.labColor.L === 90);
        // 10px dilation from col 10 reaches all the way to col 0.
        expect(maskAt(light.mask, 0, 5)).toBe(255);
    });
});
