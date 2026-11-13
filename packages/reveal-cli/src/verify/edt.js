/**
 * edt.js — Exact Euclidean Distance Transform in O(N) linear time
 *
 * Implements the Felzenszwalb-Huttenlocher algorithm (Theory of Computing 2012):
 * "Distance Transforms of Sampled Functions"
 *
 * For a 2D binary grid, computes the exact Euclidean distance from every pixel
 * to the nearest boundary/target pixel with zero approximations.
 */

'use strict';

const INF = 1e12;

/**
 * 1D squared distance transform along an array of size n.
 *
 * @param {Float64Array} f - Input 1D cost/distance array
 * @param {number} n - Length of the array
 * @param {Float64Array} d - Output array for squared distances
 * @param {Int32Array} v - Scratch array for parabola vertices (size n)
 * @param {Float64Array} z - Scratch array for parabola boundaries (size n + 1)
 */
function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;

    for (let q = 1; q < n; q++) {
        const fq = f[q];
        let s = ((fq + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
            k--;
            s = ((fq + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = INF;
    }

    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q) {
            k++;
        }
        const dx = q - v[k];
        d[q] = dx * dx + f[v[k]];
    }
}

/**
 * 2D Euclidean Distance Transform.
 *
 * Computes for each pixel the distance to the nearest target pixel (where target = 0).
 *
 * @param {Uint8Array|Int32Array|Float64Array} binaryGrid - 1 for foreground, 0 for target/boundary
 * @param {number} width - Grid width
 * @param {number} height - Grid height
 * @param {boolean} [invert=false] - If true, computes distance from 0 to nearest 1
 * @returns {Float32Array} Exact Euclidean distances (in pixels)
 */
function euclideanDistanceTransform(binaryGrid, width, height, invert = false) {
    const totalPixels = width * height;
    const f = new Float64Array(totalPixels);
    const d = new Float64Array(totalPixels);

    const targetVal = invert ? 1 : 0;

    // Initialize: 0 at target pixels, INF everywhere else
    for (let i = 0; i < totalPixels; i++) {
        const isTarget = invert ? (binaryGrid[i] > 0) : (binaryGrid[i] === 0);
        f[i] = isTarget ? 0 : INF;
    }

    const maxDim = Math.max(width, height);
    const v = new Int32Array(maxDim);
    const z = new Float64Array(maxDim + 1);

    // Pass 1: Along columns
    const colIn = new Float64Array(height);
    const colOut = new Float64Array(height);

    for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
            colIn[y] = f[y * width + x];
        }
        edt1d(colIn, height, colOut, v, z);
        for (let y = 0; y < height; y++) {
            d[y * width + x] = colOut[y];
        }
    }

    // Pass 2: Along rows
    const rowIn = new Float64Array(width);
    const rowOut = new Float64Array(width);
    const result = new Float32Array(totalPixels);

    for (let y = 0; y < height; y++) {
        const rowOffset = y * width;
        for (let x = 0; x < width; x++) {
            rowIn[x] = d[rowOffset + x];
        }
        edt1d(rowIn, width, rowOut, v, z);
        for (let x = 0; x < width; x++) {
            result[rowOffset + x] = Math.sqrt(rowOut[x]);
        }
    }

    return result;
}

module.exports = {
    euclideanDistanceTransform,
    edt1d
};
