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

// Copy src/squeegee.gif → dist/
const gifSrc = path.join(srcDir, 'squeegee.gif');
const gifDst = path.join(distDir, 'squeegee.gif');
if (fs.existsSync(gifSrc)) {
    fs.copyFileSync(gifSrc, gifDst);
    console.log('✓ Copied squeegee.gif');
}

console.log('Asset copying complete!');
