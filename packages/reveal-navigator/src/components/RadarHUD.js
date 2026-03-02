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
const { uint8ToBase64 } = require('../utils/base64');
const { BG_COLOR } = require('../utils/pixelProcessing');

const AXES = [
    { key: 'l',                     label: 'L',       max: 100 },
    { key: 'c',                     label: 'C',       max: 80  },
    { key: 'hue_entropy',           label: 'Entropy',  max: 1   },
    { key: 'temperature_bias',      label: 'Temp',     max: 1, offset: 1, scale: 0.5 }, // -1..+1 → 0..1
    { key: 'l_std_dev',             label: '\u03C3L',  max: 40  },
    { key: 'primary_sector_weight', label: 'Sector',   max: 1   },
    { key: 'k',                     label: 'K',        max: 100 }
];

// Maps each radar axis to a draggable SessionState parameter.
// Outward = increase value. Axis indices match AXES array above.
const DRAG_MAP = [
    { key: 'lWeight',       min: 0.5, max: 3.0,  step: 0.1, tip: 'Lightness (drag to favor light/dark differences)' },
    { key: 'cWeight',       min: 0.5, max: 6.0,  step: 0.1, tip: 'Color Intensity (drag to favor color saturation)' },
    { key: 'targetColors',  min: 3,   max: 10,   step: 1,   tip: 'Screens (drag to add/remove screens)' },
    { key: 'shadowClamp',   min: 0,   max: 40,   step: 0.5, tip: 'Shadow Floor (drag to control ink body)' },
    { key: 'speckleRescue', min: 0,   max: 30,   step: 1,   tip: 'Dust Removal (drag to clean halftone)' },
    { key: 'minVolume',     min: 0,   max: 5,    step: 0.1, tip: 'Ghost Screen Removal (drag to remove ghost plates)' },
    { key: 'blackBias',     min: 0,   max: 10,   step: 0.5, tip: 'Black Pull (drag to pull toward black plate)' }
];

const AXIS_COUNT = AXES.length;
const SIZE = 300;               // Pixel buffer and display size
const CENTER = SIZE / 2;
const RADIUS = 108;
const LABEL_RADIUS = RADIUS + 24;
const HANDLE_SIZE = 14;         // Drag handle diameter in pixels

// Background matches panel: #323232
const BG_R = BG_COLOR, BG_G = BG_COLOR, BG_B = BG_COLOR;

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

        // Draggable handles overlaid on green polygon vertices
        this._effectivePoints = null;
        this._dragAxisIndex = -1;
        this._handles = this._createHandles();
        this._bindDragEvents();

        this._bindEvents();
        this._renderEmpty();
    }

    _bindEvents() {
        this._session.on('imageLoaded', (data) => this.render(data.dna));
        this._session.on('archetypeChanged', () => {
            const dna = this._session.getDNA();
            if (dna) this.render(dna);
        });
        // Re-render after every knob/structural change so the effective
        // polygon tracks the live posterization result
        this._session.on('previewUpdated', () => {
            const dna = this._session.getDNA();
            if (dna) this.render(dna);
        });
    }

    // ─── Render ─────────────────────────────────────────────

    /**
     * Render the radar for a DNA v2.0 object.
     * Three layers (back to front):
     *   1. Gold polygon   — archetype centroid target
     *   2. Blue polygon   — source image DNA (fixed)
     *   3. Green polygon  — effective posterization result (tracks knobs)
     *
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

        // 2. Archetype centroid polygon (gold, behind everything)
        this._drawArchetypeOverlay(buf);

        // 3. Source DNA polygon fill (semi-transparent blue)
        this._fillPolygon(buf, points, 77, 166, 255, 51);
        this._strokePolygon(buf, points, 77, 166, 255);

        // 4. Effective posterization polygon (green, tracks live knob state)
        this._drawEffectiveOverlay(buf);

        // 5. Source DNA data point dots (filled blue circles, on top)
        for (const pt of points) {
            this._fillCircle(buf, pt.x, pt.y, 6, 77, 166, 255);
        }

        this._display(buf);
        this._positionHandles(this._effectivePoints);
        this._setLabelColors('#888');
    }

    _renderEmpty() {
        const buf = this._newBuffer();
        this._drawGrid(buf, true);
        this._display(buf);
        this._hideHandles();
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

    // ─── Effective Posterization Overlay ─────────────────────

    /**
     * Draw a green polygon showing the 7D profile of the current
     * posterized output. Computed from palette + pixel counts so it
     * responds in real time to mechanical knob changes.
     */
    _drawEffectiveOverlay(buf) {
        const sep = this._session.getSeparationState();
        if (!sep) return;

        const { palette, colorIndices } = sep;
        if (!palette || !colorIndices || palette.length === 0) return;

        const totalPixels = colorIndices.length;

        // Count pixels per color
        const counts = new Array(palette.length).fill(0);
        for (let i = 0; i < totalPixels; i++) {
            const ci = colorIndices[i];
            if (ci < counts.length) counts[ci]++;
        }

        // Weighted stats from palette
        let sumL = 0, sumC = 0, sumB = 0;
        let minL = 100;
        for (let i = 0; i < palette.length; i++) {
            const w = counts[i] / totalPixels;
            const L = palette[i].L;
            const a = palette[i].a;
            const b = palette[i].b;
            const C = Math.sqrt(a * a + b * b);

            sumL += w * L;
            sumC += w * C;
            sumB += w * b;
            if (counts[i] > 0 && L < minL) minL = L;
        }

        // σL: weighted standard deviation of lightness
        let sumSqDev = 0;
        for (let i = 0; i < palette.length; i++) {
            const w = counts[i] / totalPixels;
            const dL = palette[i].L - sumL;
            sumSqDev += w * dL * dL;
        }

        // Hue entropy: -Σ(p_i * ln(p_i)) normalized to 0-1
        // Max entropy = ln(palette.length)
        let entropy = 0;
        const activeColors = palette.filter((_, i) => counts[i] > 0).length;
        if (activeColors > 1) {
            const maxEnt = Math.log(activeColors);
            for (let i = 0; i < palette.length; i++) {
                const p = counts[i] / totalPixels;
                if (p > 0) entropy -= p * Math.log(p);
            }
            entropy = maxEnt > 0 ? entropy / maxEnt : 0;
        }

        // Primary sector weight: largest single-color proportion
        let maxProp = 0;
        for (let i = 0; i < palette.length; i++) {
            const p = counts[i] / totalPixels;
            if (p > maxProp) maxProp = p;
        }

        // Temperature bias: weighted average b* normalized to -1..+1
        // b > 0 = warm, b < 0 = cool
        const tempBias = Math.max(-1, Math.min(1, sumB / 60));

        const effective = {
            l: sumL,
            c: sumC,
            hue_entropy: entropy,
            temperature_bias: tempBias,
            l_std_dev: Math.sqrt(sumSqDev),
            primary_sector_weight: maxProp,
            k: minL
        };

        const values = this._normalizeValues(effective);
        const points = this._valuesToPoints(values);

        // Store for handle positioning
        this._effectivePoints = points;

        // Green fill + outline
        this._fillPolygon(buf, points, 100, 220, 130, 51);
        this._strokePolygon(buf, points, 100, 220, 130);

        // White ring affordances at vertices (visual hint: these are grabbable)
        for (const pt of points) {
            this._strokeCircle(buf, pt.x, pt.y, 5, 255, 255, 255);
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

        this._img.src = 'data:image/jpeg;base64,' + uint8ToBase64(jpegData.data);
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
            el.style.fontSize = '11px';
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

    // ─── Draggable Handles ─────────────────────────────────

    /**
     * Create 7 absolutely-positioned div elements as drag handles.
     * Hidden until first render positions them.
     */
    _createHandles() {
        const handles = [];

        // Shared tooltip element (one for all handles, repositioned on hover)
        this._tooltip = document.createElement('span');
        this._tooltip.setAttribute('style',
            'position: absolute; display: none; pointer-events: none; z-index: 10; ' +
            'font-size: 10px; color: #fff; background: rgba(0,0,0,0.8); ' +
            'padding: 3px 6px; border-radius: 3px; white-space: nowrap;'
        );
        this._container.appendChild(this._tooltip);

        for (let i = 0; i < AXIS_COUNT; i++) {
            const el = document.createElement('div');
            el.setAttribute('style',
                'position: absolute; width: ' + HANDLE_SIZE + 'px; height: ' + HANDLE_SIZE + 'px; ' +
                'border-radius: 50%; background: rgba(255,255,255,0.85); ' +
                'border: 2px solid #4da6ff; cursor: grab; display: none; ' +
                'box-sizing: border-box; z-index: 5;'
            );

            // Show tooltip on hover
            const tip = DRAG_MAP[i].tip;
            el.addEventListener('pointerenter', () => {
                if (this._dragAxisIndex >= 0) return; // Hide during drag
                this._tooltip.textContent = tip;
                // Position above the handle, centered horizontally.
                // UXP ignores CSS transform, so offset manually.
                const left = parseFloat(el.style.left || 0);
                const top = parseFloat(el.style.top || 0);
                // Estimate text width (~6px per char) to center without transform
                const estWidth = tip.length * 5.5;
                const tipLeft = left + HANDLE_SIZE / 2 - estWidth / 2;
                this._tooltip.setAttribute('style',
                    'position: absolute; display: block; pointer-events: none; z-index: 10; ' +
                    'font-size: 10px; color: #fff; background: rgba(0,0,0,0.8); ' +
                    'padding: 3px 6px; border-radius: 3px; white-space: nowrap; ' +
                    'left: ' + Math.max(0, tipLeft) + 'px; top: ' + (top - 20) + 'px;'
                );
            });
            el.addEventListener('pointerleave', () => {
                this._tooltip.setAttribute('style',
                    'position: absolute; display: none; pointer-events: none; z-index: 10; ' +
                    'font-size: 10px; color: #fff; background: rgba(0,0,0,0.8); ' +
                    'padding: 3px 6px; border-radius: 3px; white-space: nowrap;'
                );
            });

            this._container.appendChild(el);
            handles.push(el);
        }
        return handles;
    }

    /**
     * Position handles at the green polygon vertex locations.
     * Skips the axis currently being dragged (that tracks the pointer).
     */
    _positionHandles(points) {
        if (!points || !this._handles) return;
        const half = HANDLE_SIZE / 2;
        for (let i = 0; i < AXIS_COUNT; i++) {
            if (i === this._dragAxisIndex) continue;
            const h = this._handles[i];
            const pt = points[i];
            if (!pt) continue;
            h.setAttribute('style',
                'position: absolute; width: ' + HANDLE_SIZE + 'px; height: ' + HANDLE_SIZE + 'px; ' +
                'border-radius: 50%; background: rgba(255,255,255,0.85); ' +
                'border: 2px solid #4da6ff; cursor: grab; display: block; ' +
                'box-sizing: border-box; z-index: 5; ' +
                'left: ' + (pt.x - half) + 'px; top: ' + (pt.y - half) + 'px;'
            );
        }
    }

    /** Hide all handles (e.g. when rendering empty state). */
    _hideHandles() {
        if (!this._handles) return;
        for (const h of this._handles) {
            h.setAttribute('style',
                'position: absolute; width: ' + HANDLE_SIZE + 'px; height: ' + HANDLE_SIZE + 'px; ' +
                'border-radius: 50%; background: rgba(255,255,255,0.85); ' +
                'border: 2px solid #4da6ff; cursor: grab; display: none; ' +
                'box-sizing: border-box; z-index: 5;'
            );
        }
    }

    /**
     * Bind pointer events for dragging handles along their axis radials.
     * pointermove projects the cursor position onto the axis direction
     * vector, maps the radial fraction to the parameter range, and calls
     * sessionState.updateParameter().
     */
    _bindDragEvents() {
        if (!this._handles) return;

        for (let i = 0; i < AXIS_COUNT; i++) {
            const handle = this._handles[i];
            const axisIndex = i;

            handle.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // Hide tooltip during drag
                if (this._tooltip) this._tooltip.setAttribute('style',
                    'position: absolute; display: none; pointer-events: none; z-index: 10; ' +
                    'font-size: 10px; color: #fff; background: rgba(0,0,0,0.8); ' +
                    'padding: 3px 6px; border-radius: 3px; white-space: nowrap;'
                );

                this._dragAxisIndex = axisIndex;
                handle.setAttribute('style', handle.getAttribute('style').replace('cursor: grab', 'cursor: grabbing'));

                const onMove = (ev) => {
                    ev.preventDefault();
                    const rect = this._container.getBoundingClientRect();
                    const localX = ev.clientX - rect.left;
                    const localY = ev.clientY - rect.top;

                    // Axis direction vector (from center outward)
                    const angle = this._axisAngle(axisIndex);
                    const dirX = Math.sin(angle);
                    const dirY = -Math.cos(angle);

                    // Vector from center to cursor
                    const dx = localX - CENTER;
                    const dy = localY - CENTER;

                    // Project onto axis direction (dot product / RADIUS → 0..1+)
                    const projection = (dx * dirX + dy * dirY) / RADIUS;
                    const clamped = Math.max(0, Math.min(1, projection));

                    // Map to parameter range with step snapping
                    const dm = DRAG_MAP[axisIndex];
                    let value = dm.min + clamped * (dm.max - dm.min);
                    value = Math.round(value / dm.step) * dm.step;
                    value = Math.max(dm.min, Math.min(dm.max, value));

                    // Integer snap for targetColors
                    if (dm.step >= 1) value = Math.round(value);

                    // Position handle at the projected point on the axis
                    const r = clamped * RADIUS;
                    const hx = CENTER + r * dirX;
                    const hy = CENTER + r * dirY;
                    const half = HANDLE_SIZE / 2;
                    handle.setAttribute('style',
                        'position: absolute; width: ' + HANDLE_SIZE + 'px; height: ' + HANDLE_SIZE + 'px; ' +
                        'border-radius: 50%; background: rgba(255,255,255,0.95); ' +
                        'border: 2px solid #64dc78; cursor: grabbing; display: block; ' +
                        'box-sizing: border-box; z-index: 5; ' +
                        'left: ' + (hx - half) + 'px; top: ' + (hy - half) + 'px;'
                    );

                    // Update parameter (debounced internally by SessionState)
                    this._session.updateParameter(dm.key, value);
                };

                const onUp = () => {
                    this._dragAxisIndex = -1;
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                };

                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
            });
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
