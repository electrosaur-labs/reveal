const BlackSnap = require('../../lib/preprocessing/BlackSnap');
const { perceptualToEngine16, engine16ToPerceptual } = require('../../lib/color/LabEncoding');

function makeLab16(width, height, fillFn) {
    const data = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const { L, a, b } = fillFn(x, y);
            const e = perceptualToEngine16(L, a, b);
            const i = (y * width + x) * 3;
            data[i] = e.L16;
            data[i + 1] = e.a16;
            data[i + 2] = e.b16;
        }
    }
    return data;
}

function readPerceptual(labData, width, x, y) {
    const i = (y * width + x) * 3;
    return engine16ToPerceptual(labData[i], labData[i + 1], labData[i + 2]);
}

describe('BlackSnap.radiusPxFromMm', () => {
    it('matches the documented 0.2mm @ 300dpi ~= 2px example', () => {
        expect(BlackSnap.radiusPxFromMm(0.2, 300)).toBe(2);
    });

    it('scales with dpi so the same physical radius holds at other resolutions', () => {
        const px300 = BlackSnap.radiusPxFromMm(0.2, 300);
        const px600 = BlackSnap.radiusPxFromMm(0.2, 600);
        expect(px600).toBeGreaterThan(px300);
    });

    it('never returns less than 1px', () => {
        expect(BlackSnap.radiusPxFromMm(0.001, 72)).toBe(1);
    });
});

describe('BlackSnap.applyBlackSnap', () => {
    const width = 30, height = 30;

    it('snaps a thin near-black line against a light background to pure black', () => {
        // Light gray background, with a 1px-wide dark gray line through the middle.
        const labData = makeLab16(width, height, (x, y) => {
            if (y === 15) return { L: 25, a: 0, b: 0 }; // near-black line
            return { L: 90, a: 0, b: 0 }; // light background
        });

        const result = BlackSnap.applyBlackSnap(labData, width, height, { dpi: 300 });

        expect(result.snappedPixels).toBeGreaterThan(0);
        const p = readPerceptual(labData, width, 15, 15);
        expect(p.L).toBeCloseTo(0, 1);
        expect(p.a).toBeCloseTo(0, 1);
        expect(p.b).toBeCloseTo(0, 1);
    });

    it('leaves the INTERIOR of a large flat dark fill untouched (not an edge)', () => {
        // A big dark gray square — interior pixels have no local lightness jump.
        const labData = makeLab16(width, height, (x, y) => {
            if (x >= 5 && x < 25 && y >= 5 && y < 25) return { L: 20, a: 0, b: 0 };
            return { L: 90, a: 0, b: 0 };
        });

        BlackSnap.applyBlackSnap(labData, width, height, { dpi: 300 });

        // Center of the fill is far from any edge — must be unchanged.
        const center = readPerceptual(labData, width, 15, 15);
        expect(center.L).toBeCloseTo(20, 1);
    });

    it('snaps the BOUNDARY of a dark fill (edge pixels), leaving a thin rim', () => {
        const labData = makeLab16(width, height, (x, y) => {
            if (x >= 5 && x < 25 && y >= 5 && y < 25) return { L: 20, a: 0, b: 0 };
            return { L: 90, a: 0, b: 0 };
        });

        BlackSnap.applyBlackSnap(labData, width, height, { dpi: 300 });

        // Edge pixel of the fill (right at the boundary) should snap.
        const edge = readPerceptual(labData, width, 5, 15);
        expect(edge.L).toBeCloseTo(0, 1);
    });

    it('does NOT snap a saturated dark color (high chroma) even on a strong edge', () => {
        // Deep red (low L, but high chroma) against a light background.
        const labData = makeLab16(width, height, (x, y) => {
            if (y === 15) return { L: 25, a: 45, b: 30 }; // deep saturated red
            return { L: 90, a: 0, b: 0 };
        });

        BlackSnap.applyBlackSnap(labData, width, height, { dpi: 300 });

        const p = readPerceptual(labData, width, 15, 15);
        // Should be untouched — still red, not snapped to pure black.
        expect(p.a).toBeCloseTo(45, 0);
        expect(p.b).toBeCloseTo(30, 0);
    });

    it('does NOT snap a light/mid-tone edge (fails the near-black L* test)', () => {
        const labData = makeLab16(width, height, (x, y) => {
            if (y === 15) return { L: 60, a: 0, b: 0 }; // mid-gray line, not near-black
            return { L: 95, a: 0, b: 0 };
        });

        const result = BlackSnap.applyBlackSnap(labData, width, height, { dpi: 300 });
        expect(result.snappedPixels).toBe(0);
    });

    it('is a no-op on a uniformly near-black flat image (no edges anywhere)', () => {
        const labData = makeLab16(width, height, () => ({ L: 20, a: 0, b: 0 }));
        const result = BlackSnap.applyBlackSnap(labData, width, height, { dpi: 300 });
        expect(result.snappedPixels).toBe(0);
    });

    it('reports snappedPercent consistent with snappedPixels / total', () => {
        const labData = makeLab16(width, height, (x, y) => {
            if (y === 15) return { L: 25, a: 0, b: 0 };
            return { L: 90, a: 0, b: 0 };
        });
        const result = BlackSnap.applyBlackSnap(labData, width, height, { dpi: 300 });
        expect(result.snappedPercent).toBeCloseTo((result.snappedPixels / (width * height)) * 100, 5);
    });
});

describe('BlackSnap.evaluateBlackSnapCandidacy', () => {
    const width = 30, height = 30;

    it('does not mutate labData (read-only)', () => {
        const labData = makeLab16(width, height, (x, y) => {
            if (y === 15) return { L: 25, a: 0, b: 0 };
            return { L: 90, a: 0, b: 0 };
        });
        const before = Uint16Array.from(labData);
        BlackSnap.evaluateBlackSnapCandidacy(labData, width, height, { dpi: 300 });
        expect(labData).toEqual(before);
    });

    it('reports the same snappedPercent applyBlackSnap would produce', () => {
        const makeFixture = () => makeLab16(width, height, (x, y) => {
            if (y === 15) return { L: 25, a: 0, b: 0 };
            return { L: 90, a: 0, b: 0 };
        });

        const report = BlackSnap.evaluateBlackSnapCandidacy(makeFixture(), width, height, { dpi: 300 });
        const applied = BlackSnap.applyBlackSnap(makeFixture(), width, height, { dpi: 300 });
        expect(report.snappedPercent).toBeCloseTo(applied.snappedPercent, 5);
    });

    it('reports zero candidacy for a mid-tone edge (not near-black)', () => {
        const labData = makeLab16(width, height, (x, y) => {
            if (y === 15) return { L: 60, a: 0, b: 0 };
            return { L: 95, a: 0, b: 0 };
        });
        const report = BlackSnap.evaluateBlackSnapCandidacy(labData, width, height, { dpi: 300 });
        expect(report.snappedPercent).toBe(0);
        expect(report.meanLDelta).toBe(0);
    });

    it('meanLDelta reflects how far the qualifying pixels are from true black', () => {
        const nearlyBlack = makeLab16(width, height, (x, y) => {
            if (y === 15) return { L: 2, a: 0, b: 0 }; // already almost pure black
            return { L: 90, a: 0, b: 0 };
        });
        const borderline = makeLab16(width, height, (x, y) => {
            if (y === 15) return { L: 30, a: 0, b: 0 }; // just under the lMax=32 ceiling
            return { L: 90, a: 0, b: 0 };
        });

        const nearlyBlackReport = BlackSnap.evaluateBlackSnapCandidacy(nearlyBlack, width, height, { dpi: 300 });
        const borderlineReport = BlackSnap.evaluateBlackSnapCandidacy(borderline, width, height, { dpi: 300 });

        expect(nearlyBlackReport.snappedPercent).toBeGreaterThan(0);
        expect(borderlineReport.snappedPercent).toBeGreaterThan(0);
        expect(borderlineReport.meanLDelta).toBeGreaterThan(nearlyBlackReport.meanLDelta);
    });
});
