/**
 * Smoke tests — posterize each fixture PSD and verify palette stability.
 *
 * Each fixture has a sidecar JSON from a known-good benchmark run.
 * We re-posterize the same input and assert the palette matches
 * within a ΔE tolerance.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { posterizePsd } = require('../src/posterize-psd');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const PALETTE_DE_TOLERANCE = 2.0;  // max ΔE per swatch before failing

// CIE76 ΔE — simple Euclidean in Lab
function deltaE(a, b) {
    return Math.sqrt(
        (a.L - b.L) ** 2 +
        (a.a - b.a) ** 2 +
        (a.b - b.b) ** 2
    );
}

/**
 * Match two palettes by nearest Lab color (greedy).
 * Returns array of { expected, actual, dE } pairs.
 */
function matchPalettes(expected, actual) {
    const remaining = actual.map((c, i) => ({ ...c, _idx: i }));
    const pairs = [];

    for (const exp of expected) {
        let bestIdx = 0;
        let bestDE = Infinity;
        for (let i = 0; i < remaining.length; i++) {
            const dE = deltaE(exp.lab, remaining[i].lab);
            if (dE < bestDE) {
                bestDE = dE;
                bestIdx = i;
            }
        }
        pairs.push({
            expected: exp,
            actual: remaining[bestIdx],
            dE: bestDE
        });
        remaining.splice(bestIdx, 1);
    }

    return pairs;
}

// Discover fixture pairs: <name>.psd + <name>.json
const fixtures = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith('.psd'))
    .map(f => {
        const base = f.replace('.psd', '');
        const jsonPath = path.join(FIXTURES_DIR, base + '.json');
        if (!fs.existsSync(jsonPath)) return null;
        // Parse arch-dataset-image from filename
        const match = base.match(/^(.+?)-(cq100|testimages|sp100)-(.+)$/);
        return {
            name: base,
            archetype: match ? match[1] : 'unknown',
            dataset: match ? match[2] : 'unknown',
            image: match ? match[3] : base,
            psdPath: path.join(FIXTURES_DIR, f),
            expectedJson: JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
        };
    })
    .filter(Boolean);

let tmpDir;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-smoke-'));
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('fixture smoke tests', () => {
    for (const fixture of fixtures) {
        describe(fixture.name, () => {
            let result;
            let outputJson;

            beforeAll(async () => {
                const outDir = path.join(tmpDir, fixture.name);
                fs.mkdirSync(outDir, { recursive: true });

                const bitDepth = fixture.expectedJson.meta?.inputBitDepth || 8;
                result = await posterizePsd(fixture.psdPath, outDir, bitDepth);

                // Read the sidecar JSON that posterizePsd wrote
                const jsonPath = path.join(outDir, fixture.name + '.json');
                outputJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            }, 60_000);

            it('should match the expected archetype', () => {
                const actualArch = outputJson.archetype?.id ||
                    outputJson.configuration?.meta?.archetypeId;
                expect(actualArch).toBe(fixture.archetype);
            });

            it('should produce the same number of colors', () => {
                expect(outputJson.palette.length).toBe(fixture.expectedJson.palette.length);
            });

            it(`should have all palette swatches within ΔE ${PALETTE_DE_TOLERANCE}`, () => {
                const pairs = matchPalettes(
                    fixture.expectedJson.palette,
                    outputJson.palette
                );

                const failures = pairs.filter(p => p.dE > PALETTE_DE_TOLERANCE);
                if (failures.length > 0) {
                    const detail = failures.map(f =>
                        `  ${f.expected.hex} → ${f.actual.hex} (ΔE=${f.dE.toFixed(2)})`
                    ).join('\n');
                    expect.fail(
                        `${failures.length}/${pairs.length} swatches exceeded ΔE ${PALETTE_DE_TOLERANCE}:\n${detail}`
                    );
                }
            });
        });
    }
});
