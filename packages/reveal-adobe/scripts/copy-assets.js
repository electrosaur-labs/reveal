#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const distDir = path.join(__dirname, '..', 'dist');
const srcDir = path.join(__dirname, '..', 'src');
function copyDirRecursive(src, dest) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
        else if (entry.isFile()) fs.copyFileSync(srcPath, destPath);
    }
}
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
const manifestSrc = path.join(__dirname, '..', 'manifest.json');
const manifestDst = path.join(distDir, 'manifest.json');
if (fs.existsSync(manifestSrc)) {
    const manifest = JSON.parse(fs.readFileSync(manifestSrc, 'utf8'));
    manifest.main = 'index.html';
    fs.writeFileSync(manifestDst, JSON.stringify(manifest, null, 2));
    console.log('✓ Copied manifest.json');
}
const htmlSrc = path.join(srcDir, 'index.html');
const htmlDst = path.join(distDir, 'index.html');
if (fs.existsSync(htmlSrc)) {
    fs.copyFileSync(htmlSrc, htmlDst);
    console.log('✓ Copied index.html');
}
const iconsSrc = path.join(srcDir, 'icons');
const iconsDst = path.join(distDir, 'icons');
if (fs.existsSync(iconsSrc)) {
    copyDirRecursive(iconsSrc, iconsDst);
    console.log('✓ Copied icons/');
}
const presetsSrc = path.join(__dirname, '..', '..', 'reveal-core', 'presets');
const presetsDst = path.join(distDir, 'presets');
if (fs.existsSync(presetsSrc)) {
    copyDirRecursive(presetsSrc, presetsDst);
    console.log('✓ Copied presets/ from @reveal/core');
}
console.log('Asset copying complete!');
