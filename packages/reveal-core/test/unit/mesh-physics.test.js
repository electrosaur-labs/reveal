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

describe('MeshPhysics SAATI (TPI - µm) presets & open-area scaling', () => {
    it('exports all 20 SAATI_MESH_PRESETS with DEFAULT_MESH_TPI=355 and DEFAULT_THREAD_UM=31', () => {
        expect(MeshPhysics.DEFAULT_MESH_TPI).toBe(355);
        expect(MeshPhysics.DEFAULT_THREAD_UM).toBe(31);
        expect(MeshPhysics.SAATI_MESH_PRESETS).toHaveLength(20);
        expect(MeshPhysics.SAATI_MESH_PRESETS[0]).toMatchObject({ id: '110-80', meshTpi: 110, threadDiaUm: 80 });
        expect(MeshPhysics.SAATI_MESH_PRESETS.find(p => p.id === '230-48')).toMatchObject({
            meshTpi: 230,
            threadDiaUm: 48,
            openAreaPct: 32,
        });
        expect(MeshPhysics.SAATI_MESH_PRESETS.find(p => p.id === '355-31')).toMatchObject({
            meshTpi: 355,
            threadDiaUm: 31,
            openAreaPct: 32,
            label: '355-31 (32% open · Hi-R)',
        });
        expect(MeshPhysics.SAATI_MESH_PRESETS[19]).toMatchObject({ id: '420-27', meshTpi: 420, threadDiaUm: 27 });
    });

    it('resolves getDefaultThreadDiaUm for catalog TPIs, non-catalog TPIs, and <= 0', () => {
        expect(MeshPhysics.getDefaultThreadDiaUm(110)).toBe(80);
        expect(MeshPhysics.getDefaultThreadDiaUm(230)).toBe(48);
        expect(MeshPhysics.getDefaultThreadDiaUm(355)).toBe(31);
        expect(MeshPhysics.getDefaultThreadDiaUm(420)).toBe(27);
        expect(MeshPhysics.getDefaultThreadDiaUm(250)).toBeGreaterThanOrEqual(15);
        expect(MeshPhysics.getDefaultThreadDiaUm(0)).toBe(0);
        expect(MeshPhysics.getDefaultThreadDiaUm(-10)).toBe(0);
    });

    it('anchors F_OPEN_REF to 230-48 (openAreaScale = 1.0) and scales thicker threads >= Hi-R thin threads', () => {
        expect(MeshPhysics.computeOpenArea(230, 48)).toBeCloseTo(MeshPhysics.F_OPEN_REF, 10);
        // 230-48 has exact 1.0x scaling -> identical to unscaled 3-arg call
        expect(MeshPhysics.minDotPx(230, 300, 7.0, 48)).toBe(MeshPhysics.minDotPx(230, 300, 7.0));

        // 355-31 Hi-R at 300 DPI: N=4.0 -> 4, N=7.0 -> 6, N=10.0 -> 9
        expect(MeshPhysics.minDotPx(355, 300, 4.0, 31)).toBe(4);
        expect(MeshPhysics.minDotPx(355, 300, 7.0, 31)).toBe(6);
        expect(MeshPhysics.minDotPx(355, 300, 10.0, 31)).toBe(9);

        // Thicker 305-40 thread has smaller open area than 305-31 Hi-R -> requires >= dot floor
        const thick305 = MeshPhysics.minDotPx(305, 600, 7.0, 40);
        const hiR305 = MeshPhysics.minDotPx(305, 600, 7.0, 31);
        expect(thick305).toBeGreaterThan(hiR305);
    });
});
