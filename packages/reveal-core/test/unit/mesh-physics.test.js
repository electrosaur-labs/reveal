const MeshPhysics = require('../../lib/utils/MeshPhysics');

describe('MeshPhysics.minDotPx', () => {
    it('matches the documented 230 TPI / 300 DPI example: ceil(7*300/230) = 10', () => {
        expect(MeshPhysics.minDotPx(230, 300)).toBe(10);
    });

    it('defaults to 355 TPI / 300 DPI when both args are omitted', () => {
        expect(MeshPhysics.minDotPx()).toBe(MeshPhysics.minDotPx(355, 300));
    });

    it('defaults meshTPI only, honoring an explicit dpi', () => {
        // ceil(7*600/355) = 12
        expect(MeshPhysics.minDotPx(0, 600)).toBe(12);
    });

    it('defaults dpi only, honoring an explicit meshTPI', () => {
        // ceil(7*300/305) = 7
        expect(MeshPhysics.minDotPx(305, 0)).toBe(7);
    });

    it('treats negative values the same as missing (falls back to defaults)', () => {
        expect(MeshPhysics.minDotPx(-1, -1)).toBe(MeshPhysics.minDotPx());
    });

    it('scales inversely with mesh TPI (finer mesh -> smaller minimum dot)', () => {
        const coarse = MeshPhysics.minDotPx(110, 300); // low TPI = coarse mesh = big openings
        const fine = MeshPhysics.minDotPx(305, 300);   // high TPI = fine mesh = small openings
        expect(coarse).toBeGreaterThan(fine);
    });

    it('never returns less than 1px even at absurdly fine mesh / low dpi', () => {
        expect(MeshPhysics.minDotPx(100000, 1)).toBe(1);
    });

    it('exports DEFAULT_RULE_OF_N as 7.0', () => {
        expect(MeshPhysics.DEFAULT_RULE_OF_N).toBe(7.0);
    });

    it('scales proportionally with ruleOfN', () => {
        // At 300 DPI / 300 TPI: ceil(N * 300 / 300) = ceil(N)
        expect(MeshPhysics.minDotPx(300, 300, 4.0)).toBe(4);
        expect(MeshPhysics.minDotPx(300, 300, 5.5)).toBe(6);
        expect(MeshPhysics.minDotPx(300, 300, 7.0)).toBe(7);
        expect(MeshPhysics.minDotPx(300, 300, 10.0)).toBe(10);
    });

    it('falls back to 7.0 when ruleOfN is omitted, zero, or negative', () => {
        const baseline = MeshPhysics.minDotPx(355, 300);
        expect(MeshPhysics.minDotPx(355, 300, 0)).toBe(baseline);
        expect(MeshPhysics.minDotPx(355, 300, -5)).toBe(baseline);
        expect(MeshPhysics.minDotPx(355, 300, undefined)).toBe(baseline);
    });
});
