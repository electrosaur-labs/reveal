/**
 * Convert Uint8Array to base64 using btoa() — proven UXP-safe pattern.
 * Uses chunked String.fromCharCode.apply to avoid call stack overflow
 * on large buffers (JPEG-encoded images can be 100KB+).
 */

const CHUNK_SIZE = 0x8000; // 32KB chunks for String.fromCharCode.apply

function uint8ToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
    }
    return btoa(binary);
}

module.exports = { uint8ToBase64 };
