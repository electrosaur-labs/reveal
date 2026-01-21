/**
 * Download full-resolution posters from WikiArt
 *
 * Artists sampled (vintage poster artists):
 * - Henri de Toulouse-Lautrec (French, Art Nouveau posters)
 * - Jules Cheret (French, "father of the modern poster")
 * - Alphonse Mucha (Czech, Art Nouveau)
 * - Theophile Steinlen (Swiss-French, cabaret posters)
 * - Pierre Bonnard (French, lithographic posters)
 * - Leonetto Cappiello (Italian-French, modern advertising)
 *
 * Usage: node downloadWikiArt.js [--limit=N] [--artist=NAME]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const OUTPUT_DIR = path.join(__dirname, '../data/SP100/input/wikiart/jpg');

// Configuration
const MIN_FILE_SIZE = 50000;  // 50KB minimum
const MIN_WIDTH = 1000;       // Minimum width for "high-res"
const MIN_HEIGHT = 1000;      // Minimum height for "high-res"
const DEFAULT_TARGET_PER_ARTIST = 15;

// Poster artists to download from
const POSTER_ARTISTS = [
    'henri-de-toulouse-lautrec',
    'jules-cheret',
    'alphonse-mucha',
    'theophile-steinlen',
    'pierre-bonnard',
    'leonetto-cappiello'
];

// Keywords that indicate poster/lithograph artworks (vs paintings)
const POSTER_KEYWORDS = [
    'poster', 'affiche', 'moulin', 'rouge', 'jane', 'avril', 'divan',
    'ambassadeur', 'bruant', 'chat', 'noir', 'job', 'gismonda',
    'champagne', 'absinthe', 'chocolat', 'theatre', 'cabaret',
    'folies', 'bergere', 'casino', 'palais', 'cirque', 'revue',
    'blanche', 'salon', 'cent', 'lait', 'pur', 'clinique', 'motocycle'
];

/**
 * Get image dimensions using sips (macOS) or identify (ImageMagick)
 */
function getImageDimensions(filepath) {
    try {
        // Try sips first (macOS native)
        const output = execSync(`sips -g pixelWidth -g pixelHeight "${filepath}" 2>/dev/null`, { encoding: 'utf8' });
        const widthMatch = output.match(/pixelWidth:\s*(\d+)/);
        const heightMatch = output.match(/pixelHeight:\s*(\d+)/);
        if (widthMatch && heightMatch) {
            return { width: parseInt(widthMatch[1]), height: parseInt(heightMatch[1]) };
        }
    } catch (e) {
        // sips not available, try ImageMagick identify
        try {
            const output = execSync(`identify -format "%w %h" "${filepath}" 2>/dev/null`, { encoding: 'utf8' });
            const [width, height] = output.trim().split(' ').map(Number);
            if (width && height) return { width, height };
        } catch (e2) {
            // Neither available
        }
    }
    return null;
}

/**
 * Fetch URL with timeout
 */
function fetchUrl(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            },
            timeout: timeoutMs
        }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });

        setTimeout(() => {
            req.destroy();
            reject(new Error(`Timeout after ${timeoutMs}ms`));
        }, timeoutMs);
    });
}

/**
 * Download file to disk with timeout
 */
function downloadFile(url, destPath, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        let finished = false;

        const cleanup = () => {
            if (!finished) {
                finished = true;
                file.close();
            }
        };

        const timeout = setTimeout(() => {
            cleanup();
            fs.unlink(destPath, () => {});
            reject(new Error(`Timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                'Referer': 'https://www.wikiart.org/'
            },
            timeout: timeoutMs
        }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                clearTimeout(timeout);
                cleanup();
                try { fs.unlinkSync(destPath); } catch (e) {}
                return downloadFile(res.headers.location, destPath, timeoutMs).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                clearTimeout(timeout);
                cleanup();
                fs.unlink(destPath, () => {});
                return reject(new Error(`HTTP ${res.statusCode}`));
            }

            res.pipe(file);
            file.on('finish', () => {
                clearTimeout(timeout);
                finished = true;
                file.close();
                resolve();
            });
        });

        req.on('error', (err) => {
            clearTimeout(timeout);
            cleanup();
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

/**
 * Get list of artwork slugs for an artist
 */
async function getArtworkList(artist) {
    console.log(`\nFetching artwork list for ${artist}...`);
    const url = `https://www.wikiart.org/en/${artist}/all-works/text-list`;

    try {
        const html = await fetchUrl(url);
        const matches = html.match(new RegExp(`href="/en/${artist}/([^"]+)"`, 'g')) || [];

        const slugs = matches
            .map(m => m.match(/href="\/en\/[^/]+\/([^"]+)"/)?.[1])
            .filter(Boolean)
            .filter(slug => !slug.includes('all-works')); // Remove navigation links

        console.log(`  Found ${slugs.length} artworks`);
        return [...new Set(slugs)]; // Remove duplicates
    } catch (e) {
        console.log(`  Error: ${e.message}`);
        return [];
    }
}

/**
 * Get image URL from artwork page
 */
async function getImageUrl(artist, slug) {
    const url = `https://www.wikiart.org/en/${artist}/${slug}`;

    try {
        const html = await fetchUrl(url, 10000);
        const match = html.match(/property="og:image"\s+content="([^"]+)"/);

        if (match) {
            let imageUrl = match[1];
            // Strip size suffix to get full resolution
            if (imageUrl.includes('!')) {
                imageUrl = imageUrl.split('!')[0];
            }
            // Skip if it's the favicon (page not found)
            if (imageUrl.includes('favicon')) {
                return null;
            }
            return imageUrl;
        }
    } catch (e) {
        // Page fetch failed
    }
    return null;
}

/**
 * Check if slug looks like a poster (vs painting)
 */
function isPosterLike(slug) {
    const lower = slug.toLowerCase();
    return POSTER_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Parse CLI arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        limit: DEFAULT_TARGET_PER_ARTIST,
        artist: null
    };

    for (const arg of args) {
        if (arg.startsWith('--limit=')) {
            options.limit = parseInt(arg.split('=')[1]) || DEFAULT_TARGET_PER_ARTIST;
        } else if (arg.startsWith('--artist=')) {
            options.artist = arg.split('=')[1];
        }
    }

    return options;
}

/**
 * Main function
 */
async function main() {
    const options = parseArgs();

    console.log('=== WikiArt Poster Downloader ===\n');
    console.log(`Target per artist: ${options.limit}`);
    if (options.artist) console.log(`Filtering to artist: ${options.artist}`);

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const downloaded = [];
    const failed = [];
    const artists = options.artist
        ? POSTER_ARTISTS.filter(a => a.includes(options.artist))
        : POSTER_ARTISTS;

    for (const artist of artists) {
        console.log(`\n${'='.repeat(50)}`);
        console.log(`Processing: ${artist}`);
        console.log('='.repeat(50));

        const allSlugs = await getArtworkList(artist);

        // Filter to poster-like artworks
        const posterSlugs = allSlugs.filter(isPosterLike);
        console.log(`  ${posterSlugs.length} poster-like artworks found`);

        let downloadedForArtist = 0;

        for (const slug of posterSlugs) {
            if (downloadedForArtist >= options.limit) {
                console.log(`  Reached target of ${options.limit} for ${artist}`);
                break;
            }

            const filename = `wikiart_${artist}_${slug}.jpg`;
            const destPath = path.join(OUTPUT_DIR, filename);

            // Skip if already exists
            if (fs.existsSync(destPath)) {
                const stats = fs.statSync(destPath);
                if (stats.size > MIN_FILE_SIZE) {
                    console.log(`  ⏭️  Skip: ${slug} (exists, ${(stats.size/1024).toFixed(0)} KB)`);
                    downloadedForArtist++;
                    continue;
                }
                fs.unlinkSync(destPath); // Remove empty/small file
            }

            // Get image URL
            const imageUrl = await getImageUrl(artist, slug);
            if (!imageUrl) {
                console.log(`  ⚠️  No image: ${slug}`);
                continue;
            }

            // Download
            try {
                await downloadFile(imageUrl, destPath);
                const stats = fs.statSync(destPath);

                if (stats.size > MIN_FILE_SIZE) {
                    // Check dimensions
                    const dims = getImageDimensions(destPath);
                    const dimStr = dims ? `${dims.width}×${dims.height}` : 'unknown';
                    const isHighRes = dims && (dims.width >= MIN_WIDTH || dims.height >= MIN_HEIGHT);

                    if (isHighRes) {
                        console.log(`  ✓ HIGH-RES: ${slug} (${(stats.size/1024).toFixed(0)} KB, ${dimStr})`);
                    } else if (dims) {
                        console.log(`  ⚠️ LOW-RES: ${slug} (${(stats.size/1024).toFixed(0)} KB, ${dimStr})`);
                    } else {
                        console.log(`  ✓ Downloaded: ${slug} (${(stats.size/1024).toFixed(0)} KB)`);
                    }

                    downloaded.push({
                        artist,
                        slug,
                        filename,
                        size: stats.size,
                        width: dims?.width,
                        height: dims?.height,
                        highRes: isHighRes
                    });
                    downloadedForArtist++;
                } else {
                    console.log(`  ⚠️  Too small: ${slug} (${stats.size} bytes)`);
                    fs.unlinkSync(destPath);
                }
            } catch (e) {
                console.log(`  ✗ Failed: ${slug} - ${e.message}`);
                failed.push({ artist, slug, error: e.message });
            }

            // Rate limit
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // Summary
    const highResCount = downloaded.filter(d => d.highRes).length;
    const lowResCount = downloaded.filter(d => d.highRes === false).length;

    console.log(`\n${'='.repeat(50)}`);
    console.log('SUMMARY');
    console.log('='.repeat(50));
    console.log(`Downloaded: ${downloaded.length} images`);
    console.log(`  High-res (≥${MIN_WIDTH}px): ${highResCount}`);
    console.log(`  Low-res (<${MIN_WIDTH}px): ${lowResCount}`);
    console.log(`  Unknown dimensions: ${downloaded.length - highResCount - lowResCount}`);
    console.log(`Failed: ${failed.length} images`);
    console.log(`Output: ${OUTPUT_DIR}`);

    // Save manifest
    const manifest = {
        timestamp: new Date().toISOString(),
        config: {
            minFileSize: MIN_FILE_SIZE,
            minWidth: MIN_WIDTH,
            minHeight: MIN_HEIGHT
        },
        stats: {
            total: downloaded.length,
            highRes: highResCount,
            lowRes: lowResCount,
            failed: failed.length
        },
        files: downloaded
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('Manifest saved.');
}

main().catch(console.error);
