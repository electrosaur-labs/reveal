/**
 * RadarHUD - 7D DNA radar chart rendered via pixel rasterization
 *
 * Axis mapping (clockwise from North):
 *   N   = Luminance (L)           0-100
 *   NE  = Chroma (C)              0-80 (capped)
 *   E   = Hue Entropy             0-1
 *   SE  = Temperature Bias        -1..+1 → normalized 0-1
 *   S   = L Std Dev (σL)          0-40 (capped)
 *   SW  = Primary Sector Weight   0-1
 *   W   = Black Point (K)         0-100
 *
 * UXP does not support: createElementNS (no SVG), canvas fillText,
 * canvas toDataURL, visible <canvas> in DOM, or CSS transform: rotate().
 *
 * This implementation manually rasterizes into an RGBA pixel buffer,
 * then encodes via jpeg-js → base64 data URL → <img>.src.
 * This is the ONE rendering path proven to work in UXP.
 *
 * Axis labels use absolutely-positioned <span> elements (HTML text works).
 *
 * Vanilla+ pattern: subscribes to SessionState 'imageLoaded' and 'archetypeChanged' events.
 */

const jpeg = require('jpeg-js');
const Reveal = require('@reveal/core');

const AXES = [
    { key: 'l',                     label: 'L',       max: 100 },
    { key: 'c',                     label: 'C',       max: 80  },
    { key: 'hue_entropy',           label: 'Entropy',  max: 1   },
    { key: 'temperature_bias',      label: 'Temp',     max: 1, offset: 1, scale: 0.5 }, // -1..+1 → 0..1
    { key: 'l_std_dev',             label: '\u03C3L',  max: 40  },
    { key: 'primary_sector_weight', label: 'Sector',   max: 1   },
    { key: 'k',                     label: 'K',        max: 100 }
];

const AXIS_COUNT = AXES.length;
const SIZE = 100;               // Pixel buffer and display size
const CENTER = SIZE / 2;
const RADIUS = 36;
const LABEL_RADIUS = RADIUS + 12;

// Background matches panel: #323232
const BG_R = 0x32, BG_G = 0x32, BG_B = 0x32;

class RadarHUD {

    /**
     * @param {HTMLElement} container - DOM element to render into (position: relative)
     * @param {import('../state/SessionState')} sessionState
     */
    constructor(container, sessionState) {
        this._container = container;
        this._session = sessionState;

        // Use existing img or create one
        this._img = container.querySelector('#radar-img') || container.querySelector('img');
        if (!this._img) {
            this._img = document.createElement('img');
            this._img.width = SIZE;
            this._img.height = SIZE;
            container.appendChild(this._img);
        }

        // Axis labels as HTML spans (UXP supports positioned text)
        this._labelEls = this._createLabelElements();

        this._bindEvents();
        this._renderEmpty();
    }

    _bindEvents() {
        this._session.on('imageLoaded', (data) => this.render(data.dna));
        this._session.on('archetypeChanged', () => {
            const dna = this._session.getDNA();
            if (dna) this.render(dna);
        });
    }

    // ─── Render ─────────────────────────────────────────────

    /**
     * Render the radar for a DNA v2.0 object.
     * @param {Object} dna - DNA with .global containing 7D values
     */
    render(dna) {
        if (!dna || !dna.global) {
            this._renderEmpty();
            return;
        }

        const buf = this._newBuffer();
        const values = this._normalizeValues(dna.global);
        const points = this._valuesToPoints(values);

        // 1. Grid (rings + axis lines)
        this._drawGrid(buf, false);

        // 2. Archetype centroid polygon (gold, behind DNA)
        this._drawArchetypeOverlay(buf);

        // 3. DNA polygon fill (semi-transparent blue)
        this._fillPolygon(buf, points, 77, 166, 255, 51);

        // 4. DNA polygon outline (solid blue)
        this._strokePolygon(buf, points, 77, 166, 255);

        // 5. Data point dots (filled blue circles)
        for (const pt of points) {
            this._fillCircle(buf, pt.x, pt.y, 3, 77, 166, 255);
        }

        this._display(buf);
        this._setLabelColors('#888');
    }

    _renderEmpty() {
        const buf = this._newBuffer();
        this._drawGrid(buf, true);
        this._display(buf);
        this._setLabelColors('#555');
    }

    // ─── Grid ───────────────────────────────────────────────

    _drawGrid(buf, dimmed) {
        // 4 concentric rings
        for (let ring = 1; ring <= 4; ring++) {
            const r = RADIUS * (ring / 4);
            const isOuter = (ring === 4);
            const c = dimmed
                ? (isOuter ? 0x44 : 0x3a)
                : (isOuter ? 0x55 : 0x3a);
            this._strokeCircle(buf, CENTER, CENTER, r, c, c, c);
        }

        // 7 axis lines from center to outer ring
        const c = dimmed ? 0x3a : 0x44;
        for (let i = 0; i < AXIS_COUNT; i++) {
            const angle = this._axisAngle(i);
            const x = CENTER + RADIUS * Math.sin(angle);
            const y = CENTER - RADIUS * Math.cos(angle);
            this._drawLine(buf, CENTER, CENTER, x, y, c, c, c);
        }
    }

    // ─── Archetype Centroid ─────────────────────────────────

    _drawArchetypeOverlay(buf) {
        const state = this._session.getState();
        const activeId = state.activeArchetypeId;
        if (!activeId) return;

        try {
            const archetypes = Reveal.ArchetypeLoader.loadArchetypes();
            const archetype = archetypes.find(a => a.id === activeId);
            if (!archetype || !archetype.centroid) return;

            const values = this._normalizeValues(archetype.centroid);
            const points = this._valuesToPoints(values);

            // Gold fill + outline
            this._fillPolygon(buf, points, 224, 201, 127, 64);
            this._strokePolygon(buf, points, 224, 201, 127);
        } catch (_) {
            // Non-fatal
        }
    }

    // ─── Polygon Helpers ────────────────────────────────────

    _strokePolygon(buf, points, r, g, b) {
        for (let i = 0; i < points.length; i++) {
            const j = (i + 1) % points.length;
            this._drawLine(buf, points[i].x, points[i].y, points[j].x, points[j].y, r, g, b);
        }
    }

    _fillPolygon(buf, points, r, g, b, a) {
        // Scanline fill algorithm
        const n = points.length;
        if (n < 3) return;

        let minY = SIZE, maxY = 0;
        for (const p of points) {
            minY = Math.min(minY, Math.floor(p.y));
            maxY = Math.max(maxY, Math.ceil(p.y));
        }
        minY = Math.max(0, minY);
        maxY = Math.min(SIZE - 1, maxY);

        for (let y = minY; y <= maxY; y++) {
            const xs = [];
            for (let i = 0; i < n; i++) {
                const j = (i + 1) % n;
                const yi = points[i].y, yj = points[j].y;
                if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
                    const t = (y - yi) / (yj - yi);
                    xs.push(points[i].x + t * (points[j].x - points[i].x));
                }
            }
            xs.sort((a, b) => a - b);
            for (let k = 0; k < xs.length - 1; k += 2) {
                const x0 = Math.max(0, Math.ceil(xs[k]));
                const x1 = Math.min(SIZE - 1, Math.floor(xs[k + 1]));
                for (let x = x0; x <= x1; x++) {
                    this._setPixel(buf, x, y, r, g, b, a);
                }
            }
        }
    }

    // ─── Pixel Rasterization Primitives ─────────────────────

    _newBuffer() {
        const buf = new Uint8ClampedArray(SIZE * SIZE * 4);
        for (let i = 0; i < SIZE * SIZE; i++) {
            const off = i * 4;
            buf[off] = BG_R;
            buf[off + 1] = BG_G;
            buf[off + 2] = BG_B;
            buf[off + 3] = 255;
        }
        return buf;
    }

    _setPixel(buf, x, y, r, g, b, a) {
        x = Math.round(x);
        y = Math.round(y);
        if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;

        const off = (y * SIZE + x) * 4;
        if (a !== undefined && a < 255) {
            // Alpha composite over existing pixel
            const sa = a / 255;
            const da = 1 - sa;
            buf[off]     = Math.round(r * sa + buf[off] * da);
            buf[off + 1] = Math.round(g * sa + buf[off + 1] * da);
            buf[off + 2] = Math.round(b * sa + buf[off + 2] * da);
        } else {
            buf[off] = r;
            buf[off + 1] = g;
            buf[off + 2] = b;
        }
        buf[off + 3] = 255;
    }

    /** Bresenham line */
    _drawLine(buf, x0, y0, x1, y1, r, g, b) {
        x0 = Math.round(x0); y0 = Math.round(y0);
        x1 = Math.round(x1); y1 = Math.round(y1);

        const dx = Math.abs(x1 - x0);
        const dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;

        while (true) {
            this._setPixel(buf, x0, y0, r, g, b);
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x0 += sx; }
            if (e2 < dx) { err += dx; y0 += sy; }
        }
    }

    /** Midpoint circle (outline) */
    _strokeCircle(buf, cx, cy, radius, r, g, b) {
        cx = Math.round(cx);
        cy = Math.round(cy);
        let x = Math.round(radius);
        let y = 0;
        let err = 1 - x;

        while (x >= y) {
            this._setPixel(buf, cx + x, cy + y, r, g, b);
            this._setPixel(buf, cx - x, cy + y, r, g, b);
            this._setPixel(buf, cx + x, cy - y, r, g, b);
            this._setPixel(buf, cx - x, cy - y, r, g, b);
            this._setPixel(buf, cx + y, cy + x, r, g, b);
            this._setPixel(buf, cx - y, cy + x, r, g, b);
            this._setPixel(buf, cx + y, cy - x, r, g, b);
            this._setPixel(buf, cx - y, cy - x, r, g, b);
            y++;
            if (err <= 0) {
                err += 2 * y + 1;
            } else {
                x--;
                err += 2 * (y - x) + 1;
            }
        }
    }

    /** Filled circle (for data dots) */
    _fillCircle(buf, cx, cy, radius, r, g, b) {
        const r2 = radius * radius;
        const ri = Math.ceil(radius);
        for (let dy = -ri; dy <= ri; dy++) {
            for (let dx = -ri; dx <= ri; dx++) {
                if (dx * dx + dy * dy <= r2) {
                    this._setPixel(buf, Math.round(cx) + dx, Math.round(cy) + dy, r, g, b);
                }
            }
        }
    }

    // ─── Encode & Display ───────────────────────────────────

    _display(buf) {
        const jpegData = jpeg.encode({
            data: buf,
            width: SIZE,
            height: SIZE
        }, 95);

        // btoa() + String.fromCharCode — proven pattern from Preview.js
        let binary = '';
        const bytes = jpegData.data;
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        this._img.src = 'data:image/jpeg;base64,' + btoa(binary);
    }

    // ─── HTML Labels ────────────────────────────────────────

    _createLabelElements() {
        const labels = [];
        for (let i = 0; i < AXIS_COUNT; i++) {
            const angle = this._axisAngle(i);
            const lx = CENTER + LABEL_RADIUS * Math.sin(angle);
            const ly = CENTER - LABEL_RADIUS * Math.cos(angle);

            const el = document.createElement('span');
            el.textContent = AXES[i].label;
            el.style.position = 'absolute';
            el.style.left = lx + 'px';
            el.style.top = ly + 'px';
            el.style.fontSize = '7px';
            el.style.color = '#888';
            el.style.pointerEvents = 'none';
            el.style.whiteSpace = 'nowrap';
            this._container.appendChild(el);
            labels.push(el);
        }
        return labels;
    }

    _setLabelColors(color) {
        if (!this._labelEls) return;
        for (const el of this._labelEls) {
            el.style.color = color;
        }
    }

    // ─── Geometry Helpers ───────────────────────────────────

    _axisAngle(index) {
        return (2 * Math.PI * index) / AXIS_COUNT;
    }

    _valuesToPoints(values) {
        return values.map((v, i) => {
            const angle = this._axisAngle(i);
            const r = RADIUS * v;
            return {
                x: CENTER + r * Math.sin(angle),
                y: CENTER - r * Math.cos(angle)
            };
        });
    }

    _normalizeValues(globals) {
        return AXES.map(axis => {
            let raw = globals[axis.key] || 0;
            if (axis.offset !== undefined) raw = (raw + axis.offset) * axis.scale;
            return Math.max(0, Math.min(1, raw / axis.max));
        });
    }
}

module.exports = RadarHUD;
