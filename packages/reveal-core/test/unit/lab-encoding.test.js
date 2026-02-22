/**
 * Tests for LabEncoding.js — centralized Lab color encoding conversions
 */
const {
    LAB16_L_MAX,
    LAB16_AB_NEUTRAL,
    L_SCALE,
    AB_SCALE,
    LAB8_AB_NEUTRAL,
    PSD16_SCALE,
    convert8bitTo16bitLab,
    convertPsd16bitToEngineLab,
    convertPsd16bitTo8bitLab,
    convertEngine16bitTo8bitLab,
    perceptualToEngine16,
    engine16ToPerceptual,
    lab8bitToRgb,
    rgbToHex
} = require('../../lib/color/LabEncoding');

describe('LabEncoding Constants', () => {
    it('has correct encoding constants', () => {
        expect(LAB16_L_MAX).toBe(32768);
        expect(LAB16_AB_NEUTRAL).toBe(16384);
        expect(L_SCALE).toBeCloseTo(327.68, 2);
        expect(AB_SCALE).toBe(128);
        expect(LAB8_AB_NEUTRAL).toBe(128);
        expect(PSD16_SCALE).toBe(257);
    });
});

describe('convert8bitTo16bitLab', () => {
    it('converts neutral grey (L=50, a=0, b=0)', () => {
        // L=50% → 8-bit L=128, a=0 → 8-bit a=128, b=0 → 8-bit b=128
        const lab8 = new Uint8Array([128, 128, 128]);
        const lab16 = convert8bitTo16bitLab(lab8, 1);

        // L=128 → 128 * 32768/255 ≈ 16448
        expect(lab16[0]).toBe(Math.round(128 * 32768 / 255));
        // a=128 (neutral) → 16384
        expect(lab16[1]).toBe(LAB16_AB_NEUTRAL);
        // b=128 (neutral) → 16384
        expect(lab16[2]).toBe(LAB16_AB_NEUTRAL);
    });

    it('converts black (L=0, a=0, b=0)', () => {
        const lab8 = new Uint8Array([0, 128, 128]);
        const lab16 = convert8bitTo16bitLab(lab8, 1);

        expect(lab16[0]).toBe(0);
        expect(lab16[1]).toBe(LAB16_AB_NEUTRAL);
        expect(lab16[2]).toBe(LAB16_AB_NEUTRAL);
    });

    it('converts white (L=100, a=0, b=0)', () => {
        const lab8 = new Uint8Array([255, 128, 128]);
        const lab16 = convert8bitTo16bitLab(lab8, 1);

        expect(lab16[0]).toBe(LAB16_L_MAX);
        expect(lab16[1]).toBe(LAB16_AB_NEUTRAL);
        expect(lab16[2]).toBe(LAB16_AB_NEUTRAL);
    });

    it('converts max red (a=+127)', () => {
        const lab8 = new Uint8Array([128, 255, 128]);
        const lab16 = convert8bitTo16bitLab(lab8, 1);

        // a=255 → (255-128)*128 + 16384 = 127*128+16384 = 32640
        expect(lab16[1]).toBe(127 * 128 + 16384);
    });

    it('converts max green (a=-128)', () => {
        const lab8 = new Uint8Array([128, 0, 128]);
        const lab16 = convert8bitTo16bitLab(lab8, 1);

        // a=0 → (0-128)*128 + 16384 = -16384+16384 = 0
        expect(lab16[1]).toBe(0);
    });

    it('handles multiple pixels', () => {
        const lab8 = new Uint8Array([0, 128, 128, 255, 128, 128]);
        const lab16 = convert8bitTo16bitLab(lab8, 2);

        expect(lab16[0]).toBe(0);        // First pixel L=0
        expect(lab16[3]).toBe(LAB16_L_MAX); // Second pixel L=max
    });
});

describe('convertPsd16bitToEngineLab', () => {
    it('converts neutral point', () => {
        // PSD ICC neutral a/b = 32768
        const psd16 = new Uint16Array([32768, 32768, 32768]);
        const lab16 = convertPsd16bitToEngineLab(psd16, 1);

        // L=32768 >> 1 = 16384
        expect(lab16[0]).toBe(16384);
        // a/b neutral: 32768 >> 1 = 16384
        expect(lab16[1]).toBe(LAB16_AB_NEUTRAL);
        expect(lab16[2]).toBe(LAB16_AB_NEUTRAL);
    });

    it('converts maximum values', () => {
        const psd16 = new Uint16Array([65535, 65535, 65535]);
        const lab16 = convertPsd16bitToEngineLab(psd16, 1);

        // 65535 >> 1 = 32767 (off by 1 from 32768 — documented precision limit)
        expect(lab16[0]).toBe(32767);
    });

    it('converts zero values', () => {
        const psd16 = new Uint16Array([0, 0, 0]);
        const lab16 = convertPsd16bitToEngineLab(psd16, 1);

        expect(lab16[0]).toBe(0);
        expect(lab16[1]).toBe(0);
        expect(lab16[2]).toBe(0);
    });
});

describe('convertPsd16bitTo8bitLab', () => {
    it('converts neutral grey using /257 (ICC standard)', () => {
        // PSD ICC 16-bit neutral a/b = 32768
        const psd16 = new Uint16Array([32768, 32768, 32768]);
        const lab8 = convertPsd16bitTo8bitLab(psd16, 1);

        // L: 32768/257 ≈ 127.5 → 128
        expect(lab8[0]).toBe(128);
        // a/b neutral: 32768/257 ≈ 127.5 → 128
        expect(lab8[1]).toBe(128);
        expect(lab8[2]).toBe(128);
    });

    it('converts max values', () => {
        const psd16 = new Uint16Array([65535, 65535, 65535]);
        const lab8 = convertPsd16bitTo8bitLab(psd16, 1);

        expect(lab8[0]).toBe(255);
    });
});

describe('convertEngine16bitTo8bitLab', () => {
    it('converts neutral grey correctly', () => {
        // Engine neutral: L=16384 (~50%), a=16384 (neutral), b=16384 (neutral)
        const lab16 = new Uint16Array([16384, 16384, 16384]);
        const lab8 = convertEngine16bitTo8bitLab(lab16, 1);

        // L: 16384 * 255/32768 ≈ 127.5 → 128
        expect(lab8[0]).toBe(128);
        // a/b: (16384-16384)/128 + 128 = 128
        expect(lab8[1]).toBe(128);
        expect(lab8[2]).toBe(128);
    });

    it('converts black correctly', () => {
        const lab16 = new Uint16Array([0, 16384, 16384]);
        const lab8 = convertEngine16bitTo8bitLab(lab16, 1);

        expect(lab8[0]).toBe(0);
        expect(lab8[1]).toBe(128);
        expect(lab8[2]).toBe(128);
    });

    it('converts white correctly', () => {
        const lab16 = new Uint16Array([32768, 16384, 16384]);
        const lab8 = convertEngine16bitTo8bitLab(lab16, 1);

        expect(lab8[0]).toBe(255);
        expect(lab8[1]).toBe(128);
        expect(lab8[2]).toBe(128);
    });

    it('converts max a (red) correctly', () => {
        // a=+127 in engine 16-bit: 127*128 + 16384 = 32640
        const lab16 = new Uint16Array([16384, 32640, 16384]);
        const lab8 = convertEngine16bitTo8bitLab(lab16, 1);

        // a: (32640-16384)/128 + 128 = 127 + 128 = 255
        expect(lab8[1]).toBe(255);
    });

    it('converts min a (green) correctly', () => {
        // a=-128 in engine 16-bit: (-128)*128 + 16384 = 0
        const lab16 = new Uint16Array([16384, 0, 16384]);
        const lab8 = convertEngine16bitTo8bitLab(lab16, 1);

        // a: (0-16384)/128 + 128 = -128 + 128 = 0
        expect(lab8[1]).toBe(0);
    });

    it('is NOT the same as dividing by 257', () => {
        // This was the old bug: using /257 on engine 16-bit values
        // Engine neutral a/b = 16384 should map to 8-bit 128
        const lab16 = new Uint16Array([16384, 16384, 16384]);

        // Wrong way (old code): 16384/257 = 63.8 → 64 (NOT 128!)
        const wrongA = Math.round(16384 / 257);
        expect(wrongA).toBe(64);

        // Right way (this module): 128
        const lab8 = convertEngine16bitTo8bitLab(lab16, 1);
        expect(lab8[1]).toBe(128);
    });
});

describe('Round-trip conversions', () => {
    it('8-bit → 16-bit → 8-bit round-trips within ±1', () => {
        const original = new Uint8Array([50, 100, 200]);
        const lab16 = convert8bitTo16bitLab(original, 1);
        const roundtrip = convertEngine16bitTo8bitLab(lab16, 1);

        expect(Math.abs(roundtrip[0] - original[0])).toBeLessThanOrEqual(1);
        expect(Math.abs(roundtrip[1] - original[1])).toBeLessThanOrEqual(1);
        expect(Math.abs(roundtrip[2] - original[2])).toBeLessThanOrEqual(1);
    });

    it('perceptual → engine16 → perceptual round-trips precisely', () => {
        const L = 50, a = -30, b = 60;
        const { L16, a16, b16 } = perceptualToEngine16(L, a, b);
        const back = engine16ToPerceptual(L16, a16, b16);

        expect(back.L).toBeCloseTo(L, 1);
        expect(back.a).toBeCloseTo(a, 1);
        expect(back.b).toBeCloseTo(b, 1);
    });

    it('PSD ICC 16-bit → engine 16-bit → 8-bit matches PSD ICC 16-bit → 8-bit', () => {
        const psd16 = new Uint16Array([40000, 32768, 20000]);

        // Path A: PSD ICC → 8-bit directly
        const direct8 = convertPsd16bitTo8bitLab(psd16, 1);

        // Path B: PSD ICC → engine → 8-bit
        const engine = convertPsd16bitToEngineLab(psd16, 1);
        const via_engine8 = convertEngine16bitTo8bitLab(engine, 1);

        // Should be within ±1 (rounding)
        expect(Math.abs(direct8[0] - via_engine8[0])).toBeLessThanOrEqual(1);
        expect(Math.abs(direct8[1] - via_engine8[1])).toBeLessThanOrEqual(1);
        expect(Math.abs(direct8[2] - via_engine8[2])).toBeLessThanOrEqual(1);
    });
});

describe('perceptualToEngine16', () => {
    it('maps L=50, a=0, b=0 to correct 16-bit', () => {
        const result = perceptualToEngine16(50, 0, 0);

        expect(result.L16).toBe(Math.round(50 * L_SCALE));
        expect(result.a16).toBe(LAB16_AB_NEUTRAL);
        expect(result.b16).toBe(LAB16_AB_NEUTRAL);
    });

    it('maps L=0 to 0', () => {
        expect(perceptualToEngine16(0, 0, 0).L16).toBe(0);
    });

    it('maps L=100 to 32768', () => {
        expect(perceptualToEngine16(100, 0, 0).L16).toBe(LAB16_L_MAX);
    });

    it('maps a=-128 to 0', () => {
        expect(perceptualToEngine16(50, -128, 0).a16).toBe(0);
    });
});

describe('engine16ToPerceptual', () => {
    it('maps neutral to L=50, a=0, b=0', () => {
        // L=16384 = 50%
        const result = engine16ToPerceptual(16384, 16384, 16384);

        expect(result.L).toBe(50);
        expect(result.a).toBe(0);
        expect(result.b).toBe(0);
    });

    it('maps L=0 to 0', () => {
        expect(engine16ToPerceptual(0, 16384, 16384).L).toBe(0);
    });

    it('maps L=32768 to 100', () => {
        expect(engine16ToPerceptual(32768, 16384, 16384).L).toBe(100);
    });
});

describe('rgbToHex', () => {
    it('converts red', () => {
        expect(rgbToHex(255, 0, 0)).toBe('#ff0000');
    });

    it('converts green', () => {
        expect(rgbToHex(0, 255, 0)).toBe('#00ff00');
    });

    it('converts blue', () => {
        expect(rgbToHex(0, 0, 255)).toBe('#0000ff');
    });

    it('converts white', () => {
        expect(rgbToHex(255, 255, 255)).toBe('#ffffff');
    });

    it('converts black', () => {
        expect(rgbToHex(0, 0, 0)).toBe('#000000');
    });

    it('pads single-digit hex values', () => {
        expect(rgbToHex(1, 2, 3)).toBe('#010203');
    });
});

describe('lab8bitToRgb', () => {
    it('converts white (L=100, a=0, b=0) to near-white RGB', () => {
        const lab8 = new Uint8Array([255, 128, 128]);
        const rgb = lab8bitToRgb(lab8, 1);

        // White Lab should map to white RGB
        expect(rgb[0]).toBeGreaterThan(250);
        expect(rgb[1]).toBeGreaterThan(250);
        expect(rgb[2]).toBeGreaterThan(250);
    });

    it('converts black (L=0, a=0, b=0) to near-black RGB', () => {
        const lab8 = new Uint8Array([0, 128, 128]);
        const rgb = lab8bitToRgb(lab8, 1);

        expect(rgb[0]).toBeLessThan(5);
        expect(rgb[1]).toBeLessThan(5);
        expect(rgb[2]).toBeLessThan(5);
    });

    it('produces 3 bytes per pixel', () => {
        const lab8 = new Uint8Array([128, 128, 128, 200, 100, 150]);
        const rgb = lab8bitToRgb(lab8, 2);

        expect(rgb.length).toBe(6);
    });
});
