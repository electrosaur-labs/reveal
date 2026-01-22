/**
 * Download high-resolution images from Rijksmuseum
 *
 * Uses the new Rijksmuseum Data Services API (no key required)
 * https://data.rijksmuseum.nl/docs/search
 *
 * Focus: Vintage posters, prints, and lithographs
 *
 * Usage: node downloadRijksmuseum.js [--limit=N]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUTPUT_DIR = path.join(__dirname, '../data/SP100/input/rijks/jpg');

// Configuration
const MIN_FILE_SIZE = 500000;    // 500KB minimum
const MIN_LONG_SIDE = 3000;      // Minimum longest dimension
const MIN_SHORT_SIDE = 2000;     // Minimum shortest dimension
const DEFAULT_LIMIT = 50;        // Default number of images to download
const RATE_LIMIT_MS = 300;       // Rate limit between requests

/**
 * Get JPEG dimensions from file buffer
 */
function getJpegDimensions(buffer) {
    let i = 2;
    while (i < buffer.length - 10) {
        if (buffer[i] === 0xFF) {
            const marker = buffer[i + 1];
            if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                return {
                    height: buffer.readUInt16BE(i + 5),
                    width: buffer.readUInt16BE(i + 7)
                };
            }
            const len = buffer.readUInt16BE(i + 2);
            i += 2 + len;
        } else {
            i++;
        }
    }
    return null;
}

/**
 * Fetch JSON from URL (supports HTTPS)
 */
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (poster-downloader)',
                'Accept': 'application/ld+json, application/json'
            }
        }, (res) => {
            // Handle all redirect types (301, 302, 303, 307, 308)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchJson(res.headers.location).then(resolve).catch(reject);
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
                    reject(new Error('Invalid JSON'));
                }
            });
        }).on('error', reject);
    });
}

/**
 * Download file to buffer
 */
function downloadToBuffer(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : require('http');
        protocol.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (poster-downloader)' }
        }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return downloadToBuffer(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

// Search queries - focus on large artworks likely to be high-res
const SEARCH_CONFIGS = [
    { type: 'painting', material: 'oil paint' },
    { type: 'painting', material: 'canvas' },
    { creator: 'Rembrandt' },
    { creator: 'Vermeer' },
    { creator: 'Jan Steen' },
    { creator: 'Frans Hals' },
    { type: 'painting', description: 'landscape' },
    { type: 'painting', description: 'portrait' }
];

/**
 * Search Rijksmuseum new API with filters
 */
async function searchRijks(config, pageToken = null) {
    let url = 'https://data.rijksmuseum.nl/search/collection?imageAvailable=true';

    if (config.type) url += `&type=${encodeURIComponent(config.type)}`;
    if (config.material) url += `&material=${encodeURIComponent(config.material)}`;
    if (config.creator) url += `&creator=${encodeURIComponent(config.creator)}`;
    if (config.description) url += `&description=${encodeURIComponent(config.description)}`;

    if (pageToken) {
        url += `&pageToken=${encodeURIComponent(pageToken)}`;
    }
    return await fetchJson(url);
}

/**
 * Get object details (Linked Art format)
 */
async function getObjectDetails(objectUrl) {
    return await fetchJson(objectUrl);
}

/**
 * Extract image URL from object by following Linked Art chain:
 * Object -> shows -> VisualItem -> digitally_shown_by -> DigitalObject -> access_point
 */
async function getImageUrl(objectData) {
    try {
        // Get visual item ID from "shows" field
        if (!objectData.shows || !objectData.shows[0]) return null;
        const visualItemId = objectData.shows[0].id;

        // Get visual item data
        const visualItem = await fetchJson(visualItemId);
        if (!visualItem.digitally_shown_by || !visualItem.digitally_shown_by[0]) return null;

        // Get digital object data
        const digitalObjectId = visualItem.digitally_shown_by[0].id;
        const digitalObject = await fetchJson(digitalObjectId);

        // Get access point (image URL)
        if (!digitalObject.access_point || !digitalObject.access_point[0]) return null;
        return digitalObject.access_point[0].id;
    } catch (e) {
        return null;
    }
}

/**
 * Extract title from object data
 */
function getTitle(obj) {
    if (!obj.identified_by) return 'untitled';
    const titleObj = obj.identified_by.find(i =>
        i.type === 'Name' &&
        i.classified_as?.some(c => c.id?.includes('300404670'))
    );
    if (titleObj) return titleObj.content;
    const nameObj = obj.identified_by.find(i => i.type === 'Name');
    return nameObj?.content || 'untitled';
}

/**
 * Extract object number from object data
 */
function getObjectNumber(obj) {
    if (!obj.identified_by) return null;
    const idObj = obj.identified_by.find(i =>
        i.type === 'Identifier' &&
        i.classified_as?.some(c => c.id?.includes('300312355'))
    );
    return idObj?.content || obj.id.split('/').pop();
}

/**
 * Parse CLI arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        limit: DEFAULT_LIMIT
    };

    for (const arg of args) {
        if (arg.startsWith('--limit=')) {
            options.limit = parseInt(arg.split('=')[1]) || DEFAULT_LIMIT;
        }
    }

    return options;
}

/**
 * Main function
 */
async function main() {
    const options = parseArgs();

    console.log('=== Rijksmuseum Poster Downloader ===\n');
    console.log('Using new Data Services API (no key required)');
    console.log(`Target: ${options.limit} images`);
    console.log(`Min file size: ${MIN_FILE_SIZE / 1000000} MB`);
    console.log(`Min dimensions: ${MIN_SHORT_SIDE}×${MIN_LONG_SIDE}px\n`);

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const downloaded = [];
    const failed = [];
    const seenIds = new Set();
    let processed = 0;

    console.log('Searching Rijksmuseum collection...\n');

    for (const config of SEARCH_CONFIGS) {
        if (downloaded.length >= options.limit) break;

        const configDesc = Object.entries(config).map(([k,v]) => `${k}=${v}`).join(', ');
        console.log(`\nSearching: ${configDesc}`);

        let pageToken = null;
        let pagesProcessed = 0;
        const MAX_PAGES_PER_CONFIG = 3; // Limit pages per search config

        while (downloaded.length < options.limit && pagesProcessed < MAX_PAGES_PER_CONFIG) {
            const searchResult = await searchRijks(config, pageToken);
            const items = searchResult.orderedItems || [];

            if (items.length === 0) break;

            console.log(`  Processing ${items.length} items (page ${pagesProcessed + 1})...`);

            for (const item of items) {
                if (downloaded.length >= options.limit) break;

                // Skip if already seen
                if (seenIds.has(item.id)) continue;
                seenIds.add(item.id);

                processed++;
                const objectId = item.id;

                try {
                    // Get object details
                    process.stdout.write(`  [${processed}/${downloaded.length}] Checking...`);
                    const obj = await getObjectDetails(objectId);
                    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));

                    const title = getTitle(obj);
                    const objectNumber = getObjectNumber(obj);
                    process.stdout.write(` "${title.substring(0, 30)}"...`);

                    // Get image URL (follows chain: Object -> VisualItem -> DigitalObject)
                    const imageUrl = await getImageUrl(obj);
                    if (!imageUrl) {
                        console.log(' no image');
                        continue;
                    }

                    const shortTitle = title.substring(0, 50).replace(/[^a-zA-Z0-9]/g, '_');
                    const filename = `rijks_${objectNumber}_${shortTitle}.jpg`;
                    const destPath = path.join(OUTPUT_DIR, filename);

                    // Skip if exists
                    if (fs.existsSync(destPath)) {
                        const stats = fs.statSync(destPath);
                        if (stats.size > MIN_FILE_SIZE) {
                            console.log(`  ⏭️  Skip: ${title.substring(0, 40)}... (exists)`);
                            downloaded.push({ objectNumber, filename, title, size: stats.size });
                            continue;
                        }
                        fs.unlinkSync(destPath);
                    }

                    // Download image
                    const buffer = await downloadToBuffer(imageUrl);

                    if (buffer.length < MIN_FILE_SIZE) {
                        console.log(` small (${(buffer.length/1024/1024).toFixed(1)}MB)`);
                        continue;
                    }

                    // Check dimensions
                    const dims = getJpegDimensions(buffer);
                    if (!dims) {
                        console.log(` can't read dims`);
                        continue;
                    }

                    const longSide = Math.max(dims.width, dims.height);
                    const shortSide = Math.min(dims.width, dims.height);

                    if (longSide < MIN_LONG_SIDE || shortSide < MIN_SHORT_SIDE) {
                        console.log(` low-res (${dims.width}×${dims.height})`);
                        continue;
                    }

                    // Save file
                    fs.writeFileSync(destPath, buffer);

                    // Calculate effective DPI for 18x24" poster
                    const effectiveDpi = Math.min(longSide / 24, shortSide / 18).toFixed(0);

                    console.log(` ✓ SAVED! (${dims.width}×${dims.height}, ~${effectiveDpi} DPI)`);

                    downloaded.push({
                        objectNumber,
                        filename,
                        title,
                        size: buffer.length,
                        width: dims.width,
                        height: dims.height,
                        effectiveDpi: parseInt(effectiveDpi),
                        url: `https://www.rijksmuseum.nl/en/collection/${objectNumber}`
                    });

                } catch (e) {
                    failed.push({ objectId, error: e.message });
                }

                await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
            }

            // Get next page token
            if (searchResult.next && searchResult.next.id) {
                const nextUrl = new URL(searchResult.next.id);
                pageToken = nextUrl.searchParams.get('pageToken');
                pagesProcessed++;
            } else {
                break;
            }
        }
    }

    // Summary
    const avgDpi = downloaded.filter(d => d.effectiveDpi).length > 0
        ? (downloaded.filter(d => d.effectiveDpi).reduce((sum, d) => sum + d.effectiveDpi, 0) / downloaded.filter(d => d.effectiveDpi).length).toFixed(0)
        : 'N/A';

    console.log(`\n${'='.repeat(50)}`);
    console.log('SUMMARY');
    console.log('='.repeat(50));
    console.log(`Downloaded: ${downloaded.length} poster-quality images`);
    console.log(`Processed: ${processed} objects`);
    console.log(`Average effective DPI (@ 18×24"): ${avgDpi}`);
    console.log(`Failed: ${failed.length}`);
    console.log(`Output: ${OUTPUT_DIR}`);

    // Save manifest
    const manifest = {
        timestamp: new Date().toISOString(),
        source: 'Rijksmuseum Data Services',
        config: {
            minFileSize: MIN_FILE_SIZE,
            minLongSide: MIN_LONG_SIDE,
            minShortSide: MIN_SHORT_SIDE
        },
        stats: {
            total: downloaded.length,
            avgEffectiveDpi: parseInt(avgDpi) || null,
            processed,
            failed: failed.length
        },
        files: downloaded
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('Manifest saved.');
}

main().catch(console.error);
