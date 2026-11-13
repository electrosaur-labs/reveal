/**
 * Integration tests for reveal CLI
 *
 * Runs the actual CLI binary against a synthetic test image
 * and verifies outputs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const CLI = path.resolve(import.meta.dirname, '../../bin/reveal.js');
let tmpDir;
let testImage;

/**
 * Create a small synthetic test image (50x50 RGB gradient).
 */
async function createTestImage(outputPath) {
    const w = 50, h = 50;
    const buf = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 3;
            buf[i] = Math.round((x / w) * 255);
            buf[i + 1] = Math.round((y / h) * 255);
            buf[i + 2] = 128;
        }
    }
    await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
        .png()
        .toFile(outputPath);
}

// spawnSync gives separate, always-correct stdout/stderr buffers regardless
// of exit code (execFileSync only returns stdout on success and discards it
// in the catch path, which made real stderr content unobservable on a
// successful run — needed to verify warnings like the DPI fallback notice).
function runCli(args) {
    const result = spawnSync('node', [CLI, ...args], {
        encoding: 'utf8',
        timeout: 30000,
    });
    return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.status,
    };
}

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reveal-cli-test-'));
    testImage = path.join(tmpDir, 'test.png');
    await createTestImage(testImage);
});

afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CLI basics', () => {
    it('--help prints usage', () => {
        const { stdout } = runCli(['--help']);
        expect(stdout).toContain('Color separation engine');
        expect(stdout).toContain('--archetype');
        expect(stdout).toContain('--format');
    });

    it('--list-archetypes lists groups', () => {
        const { stdout } = runCli(['--list-archetypes']);
        expect(stdout).toContain('ADAPTIVE:');
        expect(stdout).toContain('chameleon');
        expect(stdout).toContain('distilled');
        expect(stdout).toContain('salamander');
    });

    it('rejects missing input file', () => {
        const { stderr, exitCode } = runCli(['/nonexistent/image.png']);
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('File not found');
    });

    it('rejects unsupported format', () => {
        const badFile = path.join(tmpDir, 'test.bmp');
        fs.writeFileSync(badFile, 'fake');
        const { stderr, exitCode } = runCli([badFile]);
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('Unsupported format');
    });

    it('rejects --compare with --archetype', () => {
        const { stderr, exitCode } = runCli([testImage, '--compare', '--archetype', 'cinematic']);
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('mutually exclusive');
    });
});

describe('single mode', () => {
    it('produces flat output by default', () => {
        const outDir = path.join(tmpDir, 'single-flat');
        runCli([testImage, '-o', outDir, '-q']);

        const flat = path.join(outDir, 'test_reveal.png');
        expect(fs.existsSync(flat)).toBe(true);
        expect(fs.statSync(flat).size).toBeGreaterThan(100);
    });

    it('produces JSON sidecar by default', () => {
        const outDir = path.join(tmpDir, 'single-json');
        runCli([testImage, '-o', outDir, '-q']);

        const jsonPath = path.join(outDir, 'test_reveal.json');
        expect(fs.existsSync(jsonPath)).toBe(true);

        const sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        expect(sidecar.meta.width).toBe(50);
        expect(sidecar.meta.height).toBe(50);
        expect(sidecar.palette.length).toBeGreaterThan(0);
        expect(sidecar.archetype).toBeDefined();
        expect(sidecar.parameters).toBeDefined();
    });

    it('suppresses JSON with --no-json', () => {
        const outDir = path.join(tmpDir, 'single-nojson');
        runCli([testImage, '-o', outDir, '-q', '--no-json']);

        const jsonPath = path.join(outDir, 'test_reveal.json');
        expect(fs.existsSync(jsonPath)).toBe(false);
    });

    it('produces PSD with --format psd', () => {
        const outDir = path.join(tmpDir, 'single-psd');
        runCli([testImage, '-o', outDir, '-q', '--format', 'psd', '--no-json']);

        const psdPath = path.join(outDir, 'test_reveal.psd');
        expect(fs.existsSync(psdPath)).toBe(true);
        // PSD magic bytes: "8BPS"
        const magic = fs.readFileSync(psdPath).subarray(0, 4).toString('ascii');
        expect(magic).toBe('8BPS');
    });

    it('produces ORA with --format ora', () => {
        const outDir = path.join(tmpDir, 'single-ora');
        runCli([testImage, '-o', outDir, '-q', '--format', 'ora', '--no-json']);

        const oraPath = path.join(outDir, 'test_reveal.ora');
        expect(fs.existsSync(oraPath)).toBe(true);

        // ORA is a ZIP — first entry should be "mimetype" containing "image/openraster"
        const buf = fs.readFileSync(oraPath);
        expect(buf.readUInt32LE(0)).toBe(0x04034b50);
        const nameLen = buf.readUInt16LE(26);
        const name = buf.subarray(30, 30 + nameLen).toString('utf8');
        expect(name).toBe('mimetype');
    });

    it('produces screens with --format screens', () => {
        const outDir = path.join(tmpDir, 'single-screens');
        runCli([testImage, '-o', outDir, '-q', '--format', 'screens', '--no-json']);

        const screens = fs.readdirSync(outDir).filter(f => f.includes('_screen_'));
        expect(screens.length).toBeGreaterThan(0);

        for (const screen of screens) {
            const magic = fs.readFileSync(path.join(outDir, screen)).subarray(0, 4);
            expect(magic[0]).toBe(0x89);
            expect(magic[1]).toBe(0x50);
        }
    });

    it('supports deprecated --format plates alias', () => {
        const outDir = path.join(tmpDir, 'single-plates-alias');
        runCli([testImage, '-o', outDir, '-q', '--format', 'plates', '--no-json']);

        const screens = fs.readdirSync(outDir).filter(f => f.includes('_screen_'));
        expect(screens.length).toBeGreaterThan(0);
    });

    it('respects --colors override', () => {
        const outDir = path.join(tmpDir, 'single-colors');
        runCli([testImage, '-o', outDir, '-q', '-c', '3']);

        const jsonPath = path.join(outDir, 'test_reveal.json');
        const sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        expect(sidecar.palette.length).toBeLessThanOrEqual(3);
    });

    it('accepts explicit archetype', () => {
        const outDir = path.join(tmpDir, 'single-arch');
        runCli([testImage, '-o', outDir, '-q', '-a', 'chameleon']);

        const jsonPath = path.join(outDir, 'test_reveal.json');
        const sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        expect(sidecar.archetype.id).toBe('chameleon');
    });

    it('accepts comma-separated --format', () => {
        const outDir = path.join(tmpDir, 'single-comma');
        runCli([testImage, '-o', outDir, '-q', '--format', 'psd,ora', '--no-json']);

        expect(fs.existsSync(path.join(outDir, 'test_reveal.psd'))).toBe(true);
        expect(fs.existsSync(path.join(outDir, 'test_reveal.ora'))).toBe(true);
    });

    it('accepts repeated --format flags', () => {
        const outDir = path.join(tmpDir, 'single-repeat');
        runCli([testImage, '-o', outDir, '-q', '--format', 'psd', '--format', 'screens', '--no-json']);

        expect(fs.existsSync(path.join(outDir, 'test_reveal.psd'))).toBe(true);
        const screens = fs.readdirSync(outDir).filter(f => f.includes('_screen_'));
        expect(screens.length).toBeGreaterThan(0);
    });

    it('rejects unknown format', () => {
        const { stderr, exitCode } = runCli([testImage, '-q', '--format', 'svg']);
        expect(exitCode).not.toBe(0);
        expect(stderr).toContain('Unknown format "svg"');
    });
});

describe('compare mode', () => {
    it('produces subdirectories for each archetype', () => {
        const outDir = path.join(tmpDir, 'compare');
        runCli([testImage, '-o', outDir, '-q', '--compare', '--no-json']);

        const parentDir = path.join(outDir, 'test_reveal');
        expect(fs.existsSync(parentDir)).toBe(true);

        const subdirs = fs.readdirSync(parentDir);
        expect(subdirs).toContain('chameleon');
        expect(subdirs).toContain('distilled');
        expect(subdirs).toContain('salamander');
        expect(subdirs.length).toBeGreaterThanOrEqual(3);
    });

    it('each subdir has a flat image', () => {
        const outDir = path.join(tmpDir, 'compare-flat');
        runCli([testImage, '-o', outDir, '-q', '--compare', '--no-json']);

        const parentDir = path.join(outDir, 'test_reveal');
        const subdirs = fs.readdirSync(parentDir);

        for (const sub of subdirs) {
            const flat = path.join(parentDir, sub, 'test.png');
            expect(fs.existsSync(flat)).toBe(true);
        }
    });
});

describe('dpi resolution', () => {
    async function createTestImageWithDpi(outputPath, dpi) {
        const w = 50, h = 50;
        const buf = Buffer.alloc(w * h * 3, 128);
        await sharp(buf, { raw: { width: w, height: h, channels: 3 } })
            .withMetadata({ density: dpi })
            .png()
            .toFile(outputPath);
    }

    it('falls back to 300 with a visible warning when the file has no resolution metadata', () => {
        const outDir = path.join(tmpDir, 'dpi-fallback');
        const { stderr } = runCli([testImage, '-o', outDir]);

        expect(stderr).toContain('no embedded resolution metadata');
        expect(stderr).toContain('assuming 300 DPI');

        const sidecar = JSON.parse(fs.readFileSync(path.join(outDir, 'test_reveal.json'), 'utf8'));
        expect(sidecar.parameters.dpi).toBe(300);
    });

    it('reads DPI from embedded file metadata when present', async () => {
        const dpiImage = path.join(tmpDir, 'dpi-600.png');
        await createTestImageWithDpi(dpiImage, 600);

        const outDir = path.join(tmpDir, 'dpi-from-file');
        const { stderr } = runCli([dpiImage, '-o', outDir, '-v']);

        expect(stderr).not.toContain('no embedded resolution metadata');
        expect(stderr).toContain('DPI: 600 (read from file)');

        const sidecar = JSON.parse(fs.readFileSync(path.join(outDir, 'dpi-600_reveal.json'), 'utf8'));
        expect(sidecar.parameters.dpi).toBe(600);
    });

    it('--dpi overrides embedded file metadata', async () => {
        const dpiImage = path.join(tmpDir, 'dpi-300-override.png');
        await createTestImageWithDpi(dpiImage, 300);

        const outDir = path.join(tmpDir, 'dpi-override');
        const { stderr } = runCli([dpiImage, '-o', outDir, '-v', '--dpi', '600']);

        expect(stderr).toContain('DPI: 600 (explicit --dpi / recipe override)');

        const sidecar = JSON.parse(fs.readFileSync(path.join(outDir, 'dpi-300-override_reveal.json'), 'utf8'));
        expect(sidecar.parameters.dpi).toBe(600);
    });

    it('--dpi overrides the no-metadata fallback (no warning)', () => {
        const outDir = path.join(tmpDir, 'dpi-override-fallback');
        const { stderr } = runCli([testImage, '-o', outDir, '--dpi', '150']);

        expect(stderr).not.toContain('no embedded resolution metadata');

        const sidecar = JSON.parse(fs.readFileSync(path.join(outDir, 'test_reveal.json'), 'utf8'));
        expect(sidecar.parameters.dpi).toBe(150);
    });
});

describe('recipe', () => {
    it('--save-recipe writes recipe file', () => {
        const outDir = path.join(tmpDir, 'recipe-save');
        const recipePath = path.join(tmpDir, 'saved.json');
        runCli([testImage, '-o', outDir, '-q', '--save-recipe', recipePath]);

        expect(fs.existsSync(recipePath)).toBe(true);
        const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
        expect(recipe.archetype).toBeDefined();
        expect(recipe.colors).toBeGreaterThan(0);
    });

    it('--recipe loads and applies recipe', () => {
        const recipePath = path.join(tmpDir, 'test-recipe.json');
        fs.writeFileSync(recipePath, JSON.stringify({
            archetype: 'chameleon',
            colors: 4,
        }));

        const outDir = path.join(tmpDir, 'recipe-load');
        runCli([testImage, '-o', outDir, '-q', '--recipe', recipePath]);

        const jsonPath = path.join(outDir, 'test_reveal.json');
        const sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        expect(sidecar.archetype.id).toBe('chameleon');
    });
});
