#!/usr/bin/env node
/**
 * Download LOC Performing Arts Posters for SP-100 dataset
 *
 * Usage: node scripts/download-loc-posters.js [count]
 * Default: 50 images
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '../data/SP100/input');
const DEFAULT_COUNT = 50;

async function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Follow redirect
                return fetchJSON(res.headers.location).then(resolve).catch(reject);
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse JSON: ${e.message}`));
                }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function downloadFile(url, filepath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(filepath);

        protocol.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                fs.unlinkSync(filepath);
                return downloadFile(res.headers.location, filepath).then(resolve).catch(reject);
            }

            if (res.statusCode !== 200) {
                file.close();
                fs.unlinkSync(filepath);
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            res.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
            file.on('error', (err) => {
                fs.unlinkSync(filepath);
                reject(err);
            });
        }).on('error', (err) => {
            file.close();
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
            reject(err);
        });
    });
}

function getBestImageUrl(item) {
    // Try to get highest resolution image
    if (item.image_url && item.image_url.length > 0) {
        // LOC typically provides multiple sizes, last one is often largest
        // Look for 'master' or largest available
        const urls = item.image_url;

        // Prefer master/full resolution
        const masterUrl = urls.find(u => u.includes('/master/') || u.includes('_full.'));
        if (masterUrl) return masterUrl;

        // Otherwise get the last (usually largest) jpg
        const jpgUrls = urls.filter(u => u.endsWith('.jpg') || u.endsWith('.jpeg'));
        if (jpgUrls.length > 0) return jpgUrls[jpgUrls.length - 1];

        return urls[urls.length - 1];
    }
    return null;
}

async function main() {
    const targetCount = parseInt(process.argv[2]) || DEFAULT_COUNT;

    console.log(`LOC Performing Arts Posters Downloader`);
    console.log(`Target: ${targetCount} images`);
    console.log(`Output: ${OUTPUT_DIR}\n`);

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    let downloaded = 0;
    let page = 1;
    const perPage = 50;

    while (downloaded < targetCount) {
        const apiUrl = `https://www.loc.gov/collections/performing-arts-posters/?fo=json&c=${perPage}&sp=${page}`;
        console.log(`Fetching page ${page}...`);

        let data;
        try {
            data = await fetchJSON(apiUrl);
        } catch (err) {
            console.error(`Failed to fetch page ${page}: ${err.message}`);
            break;
        }

        const results = data.results || [];
        if (results.length === 0) {
            console.log('No more results available');
            break;
        }

        for (const item of results) {
            if (downloaded >= targetCount) break;

            const imageUrl = getBestImageUrl(item);
            if (!imageUrl) {
                console.log(`  Skipping: No image URL for "${item.title}"`);
                continue;
            }

            // Generate filename from item ID or title
            const itemId = item.id ? path.basename(item.id.replace(/\/$/, '')) : `item_${downloaded + 1}`;
            const ext = path.extname(imageUrl) || '.jpg';
            const filename = `loc_${itemId}${ext}`;
            const filepath = path.join(OUTPUT_DIR, filename);

            // Skip if already exists
            if (fs.existsSync(filepath)) {
                console.log(`  Exists: ${filename}`);
                downloaded++;
                continue;
            }

            try {
                process.stdout.write(`  Downloading ${downloaded + 1}/${targetCount}: ${filename}...`);
                await downloadFile(imageUrl, filepath);
                console.log(' OK');
                downloaded++;
            } catch (err) {
                console.log(` FAILED: ${err.message}`);
            }

            // Small delay to be polite to the server
            await new Promise(r => setTimeout(r, 200));
        }

        page++;
    }

    console.log(`\nComplete: ${downloaded} images downloaded to ${OUTPUT_DIR}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
