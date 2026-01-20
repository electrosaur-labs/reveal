#!/usr/bin/env node
/**
 * Download WikiArt Poster Genre images for SP-100 dataset
 *
 * Usage: node scripts/download-wikiart-posters.js [count]
 * Default: 50 images
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '../data/SP100/input/wikiart');
const DEFAULT_COUNT = 50;
const PAGE_SIZE = 60;

async function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; SP100-Dataset/1.0)',
                'Accept': 'application/json'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchJSON(res.headers.location).then(resolve).catch(reject);
            }

            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse JSON: ${e.message}\nData: ${data.substring(0, 200)}`));
                }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function downloadFile(url, filepath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : require('http');

        protocol.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; SP100-Dataset/1.0)',
                'Referer': 'https://www.wikiart.org/'
            }
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location, filepath).then(resolve).catch(reject);
            }

            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                return;
            }

            const file = fs.createWriteStream(filepath);
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
            file.on('error', (err) => {
                fs.unlinkSync(filepath);
                reject(err);
            });
        }).on('error', reject);
    });
}

function sanitizeFilename(str) {
    return str.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 100);
}

async function main() {
    const targetCount = parseInt(process.argv[2]) || DEFAULT_COUNT;

    console.log(`WikiArt Poster Downloader`);
    console.log(`Target: ${targetCount} images`);
    console.log(`Output: ${OUTPUT_DIR}\n`);

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    let downloaded = 0;
    let page = 1;

    while (downloaded < targetCount) {
        const apiUrl = `https://www.wikiart.org/en/paintings-by-genre/poster?json=2&page=${page}`;
        console.log(`Fetching page ${page}...`);

        let data;
        try {
            data = await fetchJSON(apiUrl);
        } catch (err) {
            console.error(`Failed to fetch page ${page}: ${err.message}`);
            break;
        }

        const paintings = data.Paintings || [];
        if (paintings.length === 0) {
            console.log('No more results available');
            break;
        }

        console.log(`  Found ${paintings.length} paintings on page ${page}`);

        for (const painting of paintings) {
            if (downloaded >= targetCount) break;

            const imageUrl = painting.image;
            if (!imageUrl) {
                console.log(`  Skipping: No image URL for "${painting.title}"`);
                continue;
            }

            // Generate filename
            const artist = sanitizeFilename(painting.artistName || 'unknown');
            const title = sanitizeFilename(painting.title || 'untitled');
            const year = painting.year || 'undated';
            const filename = `wikiart_${artist}_${title}_${year}.jpg`;
            const filepath = path.join(OUTPUT_DIR, filename);

            // Skip if already exists
            if (fs.existsSync(filepath)) {
                console.log(`  Exists: ${filename}`);
                downloaded++;
                continue;
            }

            try {
                process.stdout.write(`  Downloading ${downloaded + 1}/${targetCount}: ${filename.substring(0, 60)}...`);
                await downloadFile(imageUrl, filepath);
                console.log(' OK');
                downloaded++;
            } catch (err) {
                console.log(` FAILED: ${err.message}`);
            }

            // Polite delay
            await new Promise(r => setTimeout(r, 300));
        }

        page++;

        // Safety check
        if (page > 20) {
            console.log('Reached page limit');
            break;
        }
    }

    console.log(`\nComplete: ${downloaded} images downloaded to ${OUTPUT_DIR}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
