/**
 * Download high-resolution poster images from The Metropolitan Museum of Art
 *
 * Uses the Met's Open Access API (no key required)
 * https://metmuseum.github.io/
 *
 * Focus: Vintage posters, lithographs, and prints
 *
 * Usage: node downloadMetMuseum.js [--limit=N] [--min-size=MB]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const OUTPUT_DIR = path.join(__dirname, '../data/SP100/input/met/jpg');

// Configuration
const MIN_FILE_SIZE = 500000;    // 500KB minimum
const MIN_LONG_SIDE = 3000;      // Minimum longest dimension
const MIN_SHORT_SIDE = 2000;     // Minimum shortest dimension
const DEFAULT_LIMIT = 50;        // Default number of images to download
const RATE_LIMIT_MS = 100;       // Rate limit between requests (Met allows 80/sec)

// Search queries for paintings (high-res)
const SEARCH_QUERIES = [
    { q: 'oil painting', medium: 'Oil on canvas' },
    { q: 'Rembrandt' },
    { q: 'Vermeer' },
    { q: 'Van Gogh' },
    { q: 'Monet' },
    { q: 'landscape painting' },
    { q: 'portrait painting' },
    { q: 'still life painting' }
];

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
 * Fetch JSON from URL
 */
function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (poster-downloader)' }
        }, (res) => {
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
        https.get(url, {
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

/**
 * Search Met API
 */
async function searchMet(query, medium) {
    let url = `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&isPublicDomain=true&q=${encodeURIComponent(query)}`;
    if (medium) {
        url += `&medium=${encodeURIComponent(medium)}`;
    }

    const result = await fetchJson(url);
    return result.objectIDs || [];
}

/**
 * Get object details from Met API
 */
async function getObjectDetails(objectId) {
    const url = `https://collectionapi.metmuseum.org/public/collection/v1/objects/${objectId}`;
    return await fetchJson(url);
}

/**
 * Parse CLI arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        limit: DEFAULT_LIMIT,
        minSizeMB: MIN_FILE_SIZE / 1000000
    };

    for (const arg of args) {
        if (arg.startsWith('--limit=')) {
            options.limit = parseInt(arg.split('=')[1]) || DEFAULT_LIMIT;
        } else if (arg.startsWith('--min-size=')) {
            options.minSizeMB = parseFloat(arg.split('=')[1]) || 0.5;
        }
    }

    return options;
}

/**
 * Main function
 */
async function main() {
    const options = parseArgs();
    const minFileSize = options.minSizeMB * 1000000;

    console.log('=== Met Museum Poster Downloader ===\n');
    console.log(`Target: ${options.limit} images`);
    console.log(`Min file size: ${options.minSizeMB} MB`);
    console.log(`Min dimensions: ${MIN_SHORT_SIDE}×${MIN_LONG_SIDE}px\n`);

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Collect unique object IDs from all searches
    console.log('Searching Met collection...');
    const allObjectIds = new Set();

    for (const search of SEARCH_QUERIES) {
        const ids = await searchMet(search.q, search.medium);
        ids.forEach(id => allObjectIds.add(id));
        console.log(`  "${search.q}"${search.medium ? ` (${search.medium})` : ''}: ${ids.length} results`);
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }

    console.log(`\nTotal unique objects: ${allObjectIds.size}`);
    console.log('');

    const objectIds = Array.from(allObjectIds);
    const downloaded = [];
    const failed = [];
    let processed = 0;

    for (const objectId of objectIds) {
        if (downloaded.length >= options.limit) {
            console.log(`\nReached target of ${options.limit} images`);
            break;
        }

        processed++;

        try {
            // Get object details
            const obj = await getObjectDetails(objectId);

            if (!obj.primaryImage || !obj.isPublicDomain) {
                continue;
            }

            const imageUrl = obj.primaryImage;
            const title = obj.title || 'untitled';
            const artist = obj.artistDisplayName || 'unknown';
            const date = obj.objectDate || '';
            const shortTitle = title.substring(0, 50).replace(/[^a-zA-Z0-9]/g, '_');
            const filename = `met_${objectId}_${shortTitle}.jpg`;
            const destPath = path.join(OUTPUT_DIR, filename);

            // Skip if exists
            if (fs.existsSync(destPath)) {
                const stats = fs.statSync(destPath);
                if (stats.size > minFileSize) {
                    console.log(`⏭️  Skip: ${title.substring(0, 40)}... (exists)`);
                    downloaded.push({ objectId, filename, title, artist, size: stats.size });
                    continue;
                }
                fs.unlinkSync(destPath);
            }

            // Download image
            const buffer = await downloadToBuffer(imageUrl);

            if (buffer.length < minFileSize) {
                console.log(`✗ Too small: ${title.substring(0, 40)}... (${(buffer.length/1024/1024).toFixed(1)}MB < ${options.minSizeMB}MB)`);
                continue;
            }

            // Check dimensions
            const dims = getJpegDimensions(buffer);
            if (!dims) {
                console.log(`⚠️  Can't read dimensions: ${title.substring(0, 40)}...`);
                continue;
            }

            const longSide = Math.max(dims.width, dims.height);
            const shortSide = Math.min(dims.width, dims.height);

            if (longSide < MIN_LONG_SIDE || shortSide < MIN_SHORT_SIDE) {
                console.log(`✗ LOW-RES: ${title.substring(0, 30)}... (${dims.width}×${dims.height}) - need ${MIN_SHORT_SIDE}×${MIN_LONG_SIDE}+`);
                continue;
            }

            // Save file
            fs.writeFileSync(destPath, buffer);

            // Calculate effective DPI for 18x24" poster
            const effectiveDpi = Math.min(longSide / 24, shortSide / 18).toFixed(0);

            console.log(`✓ ${title.substring(0, 35)}... (${dims.width}×${dims.height}, ~${effectiveDpi} DPI)`);
            console.log(`   Artist: ${artist}, Date: ${date}`);

            downloaded.push({
                objectId,
                filename,
                title,
                artist,
                date,
                size: buffer.length,
                width: dims.width,
                height: dims.height,
                effectiveDpi: parseInt(effectiveDpi),
                url: `https://www.metmuseum.org/art/collection/search/${objectId}`
            });

        } catch (e) {
            failed.push({ objectId, error: e.message });
        }

        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
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
        source: 'Metropolitan Museum of Art Open Access',
        config: {
            minFileSize,
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
