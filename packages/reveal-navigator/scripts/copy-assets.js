#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const distDir = path.join(__dirname, '..', 'dist');
const srcDir = path.join(__dirname, '..', 'src');

if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

// Copy manifest.json → dist/
const manifestSrc = path.join(__dirname, '..', 'manifest.json');
const manifestDst = path.join(distDir, 'manifest.json');
if (fs.existsSync(manifestSrc)) {
    const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8'));
    manifest.main = 'index.html';
    fs.writeFileSync(manifestDst, JSON.stringify(manifest, null, 2));
    console.log('✓ Copied manifest.json');
}

// Copy src/index.html → dist/
const htmlSrc = path.join(srcDir, 'index.html');
const htmlDst = path.join(distDir, 'index.html');
if (fs.existsSync(htmlSrc)) {
    fs.copyFileSync(htmlSrc, htmlDst);
    console.log('✓ Copied index.html');
}

// Copy src/Anton-Regular.ttf → dist/
const fontSrc = path.join(srcDir, 'Anton-Regular.ttf');
const fontDst = path.join(distDir, 'Anton-Regular.ttf');
if (fs.existsSync(fontSrc)) {
    fs.copyFileSync(fontSrc, fontDst);
    console.log('✓ Copied Anton-Regular.ttf');
}

console.log('Asset copying complete!');
