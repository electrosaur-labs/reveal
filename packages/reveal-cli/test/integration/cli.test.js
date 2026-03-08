/**
 * Integration tests for reveal CLI
 *
 * Runs the actual CLI binary against a synthetic test image
 * and verifies outputs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
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

function runCli(args) {
    try {
        const stderr = execFileSync('node', [CLI, ...args], {
            encoding: 'utf8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return { stdout: stderr, stderr: '', exitCode: 0 };
    } catch (err) {
        return {
            stdout: (err.stdout || '').toString(),
            stderr: (err.stderr || '').toString(),
            exitCode: err.status,
        };
    }
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
        expect(stdout).toContain('--psd');
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

    it('produces PSD with --psd', () => {
        const outDir = path.join(tmpDir, 'single-psd');
        runCli([testImage, '-o', outDir, '-q', '--psd', '--no-json']);

        const psdPath = path.join(outDir, 'test_reveal.psd');
        expect(fs.existsSync(psdPath)).toBe(true);
        // PSD magic bytes: "8BPS"
        const magic = fs.readFileSync(psdPath).subarray(0, 4).toString('ascii');
        expect(magic).toBe('8BPS');
    });

    it('produces ORA with --ora', () => {
        const outDir = path.join(tmpDir, 'single-ora');
        runCli([testImage, '-o', outDir, '-q', '--ora', '--no-json']);

        const oraPath = path.join(outDir, 'test_reveal.ora');
        expect(fs.existsSync(oraPath)).toBe(true);

        // ORA is a ZIP — first entry should be "mimetype" containing "image/openraster"
        const buf = fs.readFileSync(oraPath);
        expect(buf.readUInt32LE(0)).toBe(0x04034b50);
        const nameLen = buf.readUInt16LE(26);
        const name = buf.subarray(30, 30 + nameLen).toString('utf8');
        expect(name).toBe('mimetype');
    });

    it('produces plates with --plates', () => {
        const outDir = path.join(tmpDir, 'single-plates');
        runCli([testImage, '-o', outDir, '-q', '--plates', '--no-json']);

        const plates = fs.readdirSync(outDir).filter(f => f.includes('_plate_'));
        expect(plates.length).toBeGreaterThan(0);

        for (const plate of plates) {
            const magic = fs.readFileSync(path.join(outDir, plate)).subarray(0, 4);
            expect(magic[0]).toBe(0x89);
            expect(magic[1]).toBe(0x50);
        }
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
