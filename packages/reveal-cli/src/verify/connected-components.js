/**
 * connected-components.js — 8-connected component labeling & inscribed disk analysis
 *
 * Used by the Pre-Flight Inspector to audit physical dot retention and line art continuity.
 */

'use strict';

const { euclideanDistanceTransform } = require('./edt');

/**
 * Connected Component Labeling using Two-Pass Disjoint Set (Union-Find) with 8-connectivity.
 *
 * @param {Uint8Array} mask - Binary mask (0 = background, >0 = foreground)
 * @param {number} width - Mask width
 * @param {number} height - Mask height
 * @returns {Array<Object>} List of components with geometric and EDT metrics
 */
function labelConnectedComponents(mask, width, height) {
    const totalPixels = width * height;
    const labels = new Int32Array(totalPixels);
    const parent = [0]; // 1-based labels

    function find(i) {
        let root = i;
        while (parent[root] !== root) {
            root = parent[root];
        }
        let curr = i;
        while (curr !== root) {
            const next = parent[curr];
            parent[curr] = root;
            curr = next;
        }
        return root;
    }

    function union(i, j) {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) {
            if (rootI < rootJ) {
                parent[rootJ] = rootI;
            } else {
                parent[rootI] = rootJ;
            }
        }
    }

    let nextLabel = 1;

    // Pass 1: Assign preliminary labels and record equivalences
    for (let y = 0; y < height; y++) {
        const rowOffset = y * width;
        for (let x = 0; x < width; x++) {
            const idx = rowOffset + x;
            if (mask[idx] === 0) continue;

            // Check 8-connected preceding neighbors:
            // (x-1, y-1), (x, y-1), (x+1, y-1), (x-1, y)
            const neighbors = [];

            if (y > 0) {
                const prevRow = rowOffset - width;
                if (x > 0 && labels[prevRow + x - 1] > 0) neighbors.push(labels[prevRow + x - 1]);
                if (labels[prevRow + x] > 0) neighbors.push(labels[prevRow + x]);
                if (x < width - 1 && labels[prevRow + x + 1] > 0) neighbors.push(labels[prevRow + x + 1]);
            }
            if (x > 0 && labels[rowOffset + x - 1] > 0) {
                neighbors.push(labels[rowOffset + x - 1]);
            }

            if (neighbors.length === 0) {
                labels[idx] = nextLabel;
                parent.push(nextLabel);
                nextLabel++;
            } else {
                let minL = neighbors[0];
                for (let k = 1; k < neighbors.length; k++) {
                    if (neighbors[k] < minL) minL = neighbors[k];
                }
                labels[idx] = minL;
                for (let k = 0; k < neighbors.length; k++) {
                    union(minL, neighbors[k]);
                }
            }
        }
    }

    // Flatten disjoint sets and build components map
    const compMap = new Map();

    for (let i = 0; i < totalPixels; i++) {
        if (labels[i] > 0) {
            const root = find(labels[i]);
            labels[i] = root;

            const x = i % width;
            const y = (i / width) | 0;

            let comp = compMap.get(root);
            if (!comp) {
                comp = {
                    id: root,
                    pixelCount: 0,
                    minX: x,
                    maxX: x,
                    minY: y,
                    maxY: y,
                    pixels: []
                };
                compMap.set(root, comp);
            }

            comp.pixelCount++;
            if (x < comp.minX) comp.minX = x;
            if (x > comp.maxX) comp.maxX = x;
            if (y < comp.minY) comp.minY = y;
            if (y > comp.maxY) comp.maxY = y;
            comp.pixels.push(i);
        }
    }

    // Compute EDT for the entire mask (distance from foreground pixels to nearest background)
    // Here: 1 for foreground, 0 for background. EDT measures distance to 0.
    const edtMap = euclideanDistanceTransform(mask, width, height, false);

    const components = [];

    for (const comp of compMap.values()) {
        const w = comp.maxX - comp.minX + 1;
        const h = comp.maxY - comp.minY + 1;
        const bboxDiagonal = Math.sqrt(w * w + h * h);

        let maxInscribedRadius = 0;
        let pinchRunLength = 0;
        let maxPinchRunLength = 0;

        for (let k = 0; k < comp.pixels.length; k++) {
            const p = comp.pixels[k];
            const dist = edtMap[p];
            if (dist > maxInscribedRadius) {
                maxInscribedRadius = dist;
            }

            // Check for pinch points: local thickness <= 1.0 px (1px single strand)
            if (dist <= 1.0) {
                pinchRunLength++;
                if (pinchRunLength > maxPinchRunLength) {
                    maxPinchRunLength = pinchRunLength;
                }
            } else {
                pinchRunLength = 0;
            }
        }

        components.push({
            id: comp.id,
            pixelCount: comp.pixelCount,
            minX: comp.minX,
            maxX: comp.maxX,
            minY: comp.minY,
            maxY: comp.maxY,
            width: w,
            height: h,
            bboxDiagonal,
            inscribedRadius: maxInscribedRadius,
            maxPinchRunLength
        });
    }

    return components;
}

module.exports = {
    labelConnectedComponents
};
