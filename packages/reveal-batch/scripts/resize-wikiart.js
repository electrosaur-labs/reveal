#!/usr/bin/env node
/**
 * Resize WikiArt images to max 1024px on longest edge
 * to prevent memory issues during processing
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const INPUT_DIR = path.join(__dirname, '../data/SP100/input/wikiart');
const MAX_DIM = 1024;

async function main() {
    const files = fs.readdirSync(INPUT_DIR)
        .filter(f => /\.(jpg|jpeg|png)$/i.test(f));

    console.log(`Resizing ${files.length} WikiArt images to max ${MAX_DIM}px...`);

    for (const file of files) {
        const filepath = path.join(INPUT_DIR, file);
        const metadata = await sharp(filepath).metadata();

        if (metadata.width > MAX_DIM || metadata.height > MAX_DIM) {
            console.log(`  ${file}: ${metadata.width}×${metadata.height} → resizing...`);

            const resized = await sharp(filepath)
                .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
                .toBuffer();

            fs.writeFileSync(filepath, resized);

            const newMeta = await sharp(filepath).metadata();
            console.log(`    → ${newMeta.width}×${newMeta.height}`);
        } else {
            console.log(`  ${file}: ${metadata.width}×${metadata.height} (OK)`);
        }
    }

    console.log('Done.');
}

main().catch(console.error);
