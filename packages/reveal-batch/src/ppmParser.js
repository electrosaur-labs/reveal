/**
 * P6 Binary PPM Parser
 *
 * Parses P6 (binary) PPM files and returns RGB pixel data.
 * Format: Magic number (P6) + dimensions + max value + binary RGB data
 */

const fs = require('fs');

/**
 * Parse a P6 binary PPM file
 *
 * @param {string} filePath - Path to PPM file
 * @returns {Object} Parsed image data
 * @returns {number} returns.width - Image width
 * @returns {number} returns.height - Image height
 * @returns {number} returns.maxValue - Maximum color value (usually 255)
 * @returns {Buffer} returns.pixels - RGB pixel data (3 bytes per pixel)
 */
function parsePPM(filePath) {
    const buffer = fs.readFileSync(filePath);
    let offset = 0;

    // Helper to read next token (skip whitespace and comments)
    function readToken() {
        const tokens = [];
        let inComment = false;

        while (offset < buffer.length) {
            const byte = buffer[offset];
            const char = String.fromCharCode(byte);

            if (inComment) {
                if (char === '\n') {
                    inComment = false;
                }
                offset++;
                continue;
            }

            if (char === '#') {
                inComment = true;
                offset++;
                continue;
            }

            if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
                if (tokens.length > 0) {
                    // Found end of token
                    offset++;
                    return tokens.join('');
                }
                offset++;
                continue;
            }

            tokens.push(char);
            offset++;
        }

        if (tokens.length > 0) {
            return tokens.join('');
        }

        return null;
    }

    // 1. Read magic number (P6)
    const magic = readToken();
    if (magic !== 'P6') {
        throw new Error(`Invalid PPM format: expected P6, got ${magic}`);
    }

    // 2. Read width
    const widthStr = readToken();
    const width = parseInt(widthStr, 10);
    if (isNaN(width) || width <= 0) {
        throw new Error(`Invalid width: ${widthStr}`);
    }

    // 3. Read height
    const heightStr = readToken();
    const height = parseInt(heightStr, 10);
    if (isNaN(height) || height <= 0) {
        throw new Error(`Invalid height: ${heightStr}`);
    }

    // 4. Read max value
    const maxValueStr = readToken();
    const maxValue = parseInt(maxValueStr, 10);
    if (isNaN(maxValue) || maxValue <= 0 || maxValue > 255) {
        throw new Error(`Invalid max value: ${maxValueStr} (must be 1-255)`);
    }

    // 5. Read binary RGB pixel data
    const expectedSize = width * height * 3;  // 3 bytes per pixel (R, G, B)
    const pixels = buffer.slice(offset, offset + expectedSize);

    if (pixels.length !== expectedSize) {
        throw new Error(
            `Incomplete pixel data: expected ${expectedSize} bytes, got ${pixels.length} bytes`
        );
    }

    return {
        width,
        height,
        maxValue,
        pixels
    };
}

module.exports = { parsePPM };
