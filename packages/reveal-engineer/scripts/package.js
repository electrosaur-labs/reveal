#!/usr/bin/env node

/**
 * Package the plugin into a .ccx file for distribution.
 * A .ccx file is a ZIP archive of the dist/ directory.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const version = packageJson.version;
const outputFile = path.join(__dirname, '..', `reveal-v${version}.ccx`);

if (!fs.existsSync(path.join(__dirname, '..', 'dist'))) {
    console.error('dist/ directory not found. Run "npm run build" first.');
    process.exit(1);
}

if (fs.existsSync(outputFile)) {
    fs.unlinkSync(outputFile);
}

try {
    execSync(`cd "${path.join(__dirname, '..', 'dist')}" && zip -r "${outputFile}" *`, {
        stdio: 'inherit'
    });

    const stats = fs.statSync(outputFile);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log(`Packaged: ${path.basename(outputFile)} (${sizeKB} KB)`);
} catch (error) {
    console.error('Packaging failed:', error.message);
    process.exit(1);
}
