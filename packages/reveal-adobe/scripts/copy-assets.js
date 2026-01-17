#!/usr/bin/env node
/**
 * Copy assets to dist folder after webpack build
 */
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const srcDir = path.join(__dirname, '..', 'src');

// Ensure dist exists
if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

// Copy manifest.json
const manifestSrc = path.join(__dirname, '..', 'manifest.json');
const manifestDst = path.join(distDir, 'manifest.json');
if (fs.existsSync(manifestSrc)) {
    const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8'));
    manifest.main = 'index.html';  // Ensure correct main path
    fs.writeFileSync(manifestDst, JSON.stringify(manifest, null, 2));
    console.log('✓ Copied manifest.json');
}

// Copy index.html
const htmlSrc = path.join(srcDir, 'index.html');
const htmlDst = path.join(distDir, 'index.html');
if (fs.existsSync(htmlSrc)) {
    fs.copyFileSync(htmlSrc, htmlDst);
    console.log('✓ Copied index.html');
}

// Copy icons directory
const iconsSrc = path.join(srcDir, 'icons');
const iconsDst = path.join(distDir, 'icons');
if (fs.existsSync(iconsSrc)) {
    fs.cpSync(iconsSrc, iconsDst, { recursive: true });
    console.log('✓ Copied icons/');
}

// Copy presets directory (for runtime access)
const presetsSrc = path.join(srcDir, 'presets');
const presetsDst = path.join(distDir, 'presets');
if (fs.existsSync(presetsSrc)) {
    fs.cpSync(presetsSrc, presetsDst, { recursive: true });
    console.log('✓ Copied presets/');
}

console.log('Asset copying complete!');
