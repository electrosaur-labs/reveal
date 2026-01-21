/**
 * LOC Master TIFF Downloader
 *
 * Downloads high-resolution archival TIFFs from Library of Congress collections.
 *
 * Usage: node scripts/downloadLOCMasterTiffs.js [options]
 *
 * Options:
 *   --collection=CODE   Collection code (pos, spcw, var, wwipos, yan) or 'all'
 *   --limit=N           Max items to download per collection (default: 10)
 *   --min-size=N        Minimum TIFF size in MB (default: 50)
 *   --output=DIR        Output directory (default: data/SP100/input/loc/tiff)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// Collections to process
const COLLECTIONS = {
    pos: { name: 'Artist Posters', code: 'pos' },
    spcw: { name: 'Spanish Civil War Posters', code: 'spcw' },
    var: { name: 'Performing Arts Posters', code: 'var' },
    wwipos: { name: 'WW I Posters', code: 'wwipos' },
    yan: { name: 'Yanker Collection Posters', code: 'yan' }
};

// Parse args
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, val] = arg.replace('--', '').split('=');
    acc[key] = val || true;
    return acc;
}, {});

const targetCollection = args.collection || 'all';
const limitPerCollection = parseInt(args.limit) || 10;
const minSizeMB = parseInt(args['min-size']) || 50;
const outputDir = args.output || path.join(__dirname, '../data/SP100/input/loc/tiff');

// Rate limiting settings - LOC is aggressive about rate limiting
const API_DELAY_MS = 2000;       // Delay between API calls (increased from 500)
const DOWNLOAD_DELAY_MS = 5000;  // Delay between downloads (increased from 2000)
const MAX_RETRIES = 5;           // Max retries per request
const RETRY_DELAY_MS = 30000;    // Wait 30s before retry after rate limit
const MAX_CONSECUTIVE_RATE_LIMITS = 10; // Give up on collection after this many consecutive rate limits

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch JSON from URL with retry logic
 */
async function fetchJson(url, retries = MAX_RETRIES) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (LOC Poster Downloader)' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                return fetchJson(res.headers.location, retries).then(resolve).catch(reject);
            }

            // Rate limited - retry with backoff
            if (res.statusCode === 429 || res.statusCode === 503) {
                if (retries > 0) {
                    console.log(`    Rate limited, waiting ${RETRY_DELAY_MS/1000}s...`);
                    return sleep(RETRY_DELAY_MS)
                        .then(() => fetchJson(url, retries - 1))
                        .then(resolve)
                        .catch(reject);
                }
                return reject(new Error(`Rate limited after ${MAX_RETRIES} retries`));
            }

            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
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
        }).on('error', reject);
    });
}

/**
 * Download file with progress and retry logic
 */
function downloadFile(url, destPath, retries = MAX_RETRIES) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const protocol = url.startsWith('https') ? https : http;

        protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (LOC Poster Downloader)' } }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                file.close();
                try { fs.unlinkSync(destPath); } catch (e) {}
                return downloadFile(res.headers.location, destPath, retries).then(resolve).catch(reject);
            }

            // Rate limited - retry with backoff
            if (res.statusCode === 429 || res.statusCode === 503) {
                file.close();
                try { fs.unlinkSync(destPath); } catch (e) {}
                if (retries > 0) {
                    console.log(`\n    Rate limited, waiting ${RETRY_DELAY_MS/1000}s...`);
                    return sleep(RETRY_DELAY_MS)
                        .then(() => downloadFile(url, destPath, retries - 1))
                        .then(resolve)
                        .catch(reject);
                }
                return reject(new Error(`Rate limited after ${MAX_RETRIES} retries`));
            }

            if (res.statusCode !== 200) {
                file.close();
                try { fs.unlinkSync(destPath); } catch (e) {}
                return reject(new Error(`HTTP ${res.statusCode}`));
            }

            const totalSize = parseInt(res.headers['content-length'], 10);
            let downloaded = 0;
            let lastProgress = 0;

            res.on('data', chunk => {
                downloaded += chunk.length;
                const progress = Math.floor(downloaded / totalSize * 100);
                if (progress >= lastProgress + 10) {
                    process.stdout.write(`\r    Downloading: ${progress}% (${(downloaded/1024/1024).toFixed(1)} MB)`);
                    lastProgress = progress;
                }
            });

            res.pipe(file);

            file.on('finish', () => {
                file.close();
                console.log(`\r    Downloaded: ${(downloaded/1024/1024).toFixed(1)} MB                    `);
                resolve(downloaded);
            });
        }).on('error', (err) => {
            file.close();
            fs.unlinkSync(destPath);
            reject(err);
        });
    });
}

/**
 * Get items from a collection that have master TIFFs available
 */
async function getCollectionItems(collectionCode, maxItems) {
    const items = [];
    let page = 1;
    const perPage = 50;
    let consecutiveRateLimits = 0;

    console.log(`  Scanning collection for items with TIFFs...`);

    while (items.length < maxItems) {
        const searchUrl = `https://www.loc.gov/pictures/search?st=grid&co=${collectionCode}&fo=json&c=${perPage}&sp=${page}`;

        try {
            const searchData = await fetchJson(searchUrl);
            consecutiveRateLimits = 0; // Reset on success

            if (!searchData.results || searchData.results.length === 0) {
                break;
            }

            for (const result of searchData.results) {
                if (items.length >= maxItems) break;

                // Check if we've been rate limited too many times
                if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
                    console.log(`    ⚠️ Too many rate limits, stopping collection scan`);
                    return items;
                }

                // Get resource details to find TIFF URL
                const resourceUrl = `${result.links.resource}?fo=json`;
                try {
                    const resourceData = await fetchJson(resourceUrl);
                    consecutiveRateLimits = 0; // Reset on success

                    if (resourceData.resource && resourceData.resource.larger &&
                        resourceData.resource.larger.endsWith('.tif')) {

                        const tiffUrl = resourceData.resource.larger;
                        const tiffSize = resourceData.resource.larger_s || 0;
                        const sizeMB = tiffSize / 1024 / 1024;

                        // Only include if meets minimum size
                        if (sizeMB >= minSizeMB) {
                            items.push({
                                id: result.pk,
                                title: result.title,
                                tiffUrl,
                                sizeMB: sizeMB.toFixed(1),
                                collection: collectionCode
                            });
                            console.log(`    Found: ${result.pk} (${sizeMB.toFixed(1)} MB)`);
                        }
                    }
                } catch (e) {
                    if (e.message.includes('Rate limited')) {
                        consecutiveRateLimits++;
                        console.log(`    ⚠️ Rate limited (${consecutiveRateLimits}/${MAX_CONSECUTIVE_RATE_LIMITS})`);
                        if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
                            console.log(`    ⚠️ Too many rate limits, stopping collection scan`);
                            return items;
                        }
                    }
                    // Skip items without accessible resources
                }

                // Rate limiting between API calls
                await sleep(API_DELAY_MS);
            }

            page++;

            // Safety limit
            if (page > 100) break;

        } catch (e) {
            if (e.message.includes('Rate limited')) {
                consecutiveRateLimits++;
                console.log(`  ⚠️ Rate limited on page fetch (${consecutiveRateLimits}/${MAX_CONSECUTIVE_RATE_LIMITS})`);
                if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
                    console.log(`  ⚠️ Too many rate limits, stopping collection scan`);
                    break;
                }
                await sleep(RETRY_DELAY_MS);
                continue; // Retry same page
            }
            console.error(`  Error fetching page ${page}: ${e.message}`);
            break;
        }
    }

    return items;
}

/**
 * Main function
 */
async function main() {
    console.log('');
    console.log('═'.repeat(70));
    console.log('LOC Master TIFF Downloader');
    console.log('═'.repeat(70));
    console.log('');
    console.log(`Output directory: ${outputDir}`);
    console.log(`Limit per collection: ${limitPerCollection}`);
    console.log(`Minimum TIFF size: ${minSizeMB} MB`);
    console.log('');

    const collectionsToProcess = targetCollection === 'all'
        ? Object.keys(COLLECTIONS)
        : [targetCollection];

    const allItems = [];

    for (const code of collectionsToProcess) {
        if (!COLLECTIONS[code]) {
            console.log(`Unknown collection: ${code}`);
            continue;
        }

        console.log('─'.repeat(70));
        console.log(`Collection: ${COLLECTIONS[code].name} (${code})`);
        console.log('─'.repeat(70));

        const items = await getCollectionItems(code, limitPerCollection);
        allItems.push(...items);

        console.log(`  Found ${items.length} items with TIFFs >= ${minSizeMB} MB`);
        console.log('');
    }

    console.log('═'.repeat(70));
    console.log(`Total items to download: ${allItems.length}`);
    console.log('═'.repeat(70));
    console.log('');

    // Download TIFFs
    let downloaded = 0;
    let failed = 0;

    for (let i = 0; i < allItems.length; i++) {
        const item = allItems[i];
        const filename = `loc_${item.collection}_${item.id}.tif`;
        const destPath = path.join(outputDir, filename);

        console.log(`[${i + 1}/${allItems.length}] ${item.title.substring(0, 50)}...`);
        console.log(`    ID: ${item.id}, Size: ${item.sizeMB} MB`);

        if (fs.existsSync(destPath)) {
            console.log(`    Skipped: Already exists`);
            downloaded++;
            continue;
        }

        try {
            await downloadFile(item.tiffUrl, destPath);
            downloaded++;
        } catch (e) {
            console.log(`    Failed: ${e.message}`);
            failed++;
        }

        // Rate limiting between downloads (longer delay for large files)
        await sleep(DOWNLOAD_DELAY_MS);
    }

    console.log('');
    console.log('═'.repeat(70));
    console.log('Summary');
    console.log('═'.repeat(70));
    console.log(`  Downloaded: ${downloaded}`);
    console.log(`  Failed: ${failed}`);
    console.log(`  Output: ${outputDir}`);
    console.log('');
}

main().catch(console.error);
