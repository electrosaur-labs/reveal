#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '../data/SP100/input');
const files = fs.readdirSync(dir);

for (const file of files) {
    if (file.includes('#')) {
        const newName = file.split('#')[0];
        const oldPath = path.join(dir, file);
        const newPath = path.join(dir, newName);
        fs.renameSync(oldPath, newPath);
        console.log(`${file} -> ${newName}`);
    }
}
console.log('Done');
