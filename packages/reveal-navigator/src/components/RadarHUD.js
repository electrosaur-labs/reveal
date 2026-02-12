/**
 * RadarHUD - 7D DNA radar chart rendered as inline SVG
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
 * Vanilla+ pattern: subscribes to SessionState 'imageLoaded' event.
 */

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
const SVG_SIZE = 100;
const CENTER = SVG_SIZE / 2;
const RADIUS = 36;
const LABEL_RADIUS = RADIUS + 12;

class RadarHUD {

    /**
     * @param {HTMLElement} container - DOM element to render SVG into
     * @param {import('../state/SessionState')} sessionState
     */
    constructor(container, sessionState) {
        this._container = container;
        this._session = sessionState;
        this._svgNS = 'http://www.w3.org/2000/svg';

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

    /**
     * Render the radar for a DNA v2.0 object.
     * @param {Object} dna - DNA with .global containing 7D values
     */
    render(dna) {
        if (!dna || !dna.global) {
            this._renderEmpty();
            return;
        }

        const g = dna.global;
        const values = AXES.map(axis => {
            let raw = g[axis.key] || 0;
            if (axis.offset !== undefined) raw = (raw + axis.offset) * axis.scale;
            return Math.max(0, Math.min(1, raw / axis.max));
        });

        this._container.innerHTML = '';
        const svg = this._createSVG();

        // Grid rings (25%, 50%, 75%, 100%)
        for (let ring = 1; ring <= 4; ring++) {
            const r = RADIUS * (ring / 4);
            svg.appendChild(this._createRing(r, ring === 4 ? '#555' : '#3a3a3a'));
        }

        // Axis lines + labels
        for (let i = 0; i < AXIS_COUNT; i++) {
            const angle = this._axisAngle(i);
            const x = CENTER + RADIUS * Math.sin(angle);
            const y = CENTER - RADIUS * Math.cos(angle);
            svg.appendChild(this._createLine(CENTER, CENTER, x, y, '#444'));

            // Label
            const lx = CENTER + LABEL_RADIUS * Math.sin(angle);
            const ly = CENTER - LABEL_RADIUS * Math.cos(angle);
            svg.appendChild(this._createLabel(lx, ly, AXES[i].label));
        }

        // Data polygon
        const points = values.map((v, i) => {
            const angle = this._axisAngle(i);
            const r = RADIUS * v;
            return `${CENTER + r * Math.sin(angle)},${CENTER - r * Math.cos(angle)}`;
        }).join(' ');

        const polygon = document.createElementNS(this._svgNS, 'polygon');
        polygon.setAttribute('points', points);
        polygon.setAttribute('fill', 'rgba(77, 166, 255, 0.2)');
        polygon.setAttribute('stroke', '#4da6ff');
        polygon.setAttribute('stroke-width', '1.5');
        svg.appendChild(polygon);

        // Data points
        values.forEach((v, i) => {
            const angle = this._axisAngle(i);
            const r = RADIUS * v;
            const cx = CENTER + r * Math.sin(angle);
            const cy = CENTER - r * Math.cos(angle);
            const dot = document.createElementNS(this._svgNS, 'circle');
            dot.setAttribute('cx', cx);
            dot.setAttribute('cy', cy);
            dot.setAttribute('r', '3');
            dot.setAttribute('fill', '#4da6ff');
            svg.appendChild(dot);
        });

        this._container.appendChild(svg);
    }

    _renderEmpty() {
        this._container.innerHTML = '';
        const svg = this._createSVG();

        // Just the grid + labels, no data polygon
        for (let ring = 1; ring <= 4; ring++) {
            const r = RADIUS * (ring / 4);
            svg.appendChild(this._createRing(r, ring === 4 ? '#444' : '#3a3a3a'));
        }

        for (let i = 0; i < AXIS_COUNT; i++) {
            const angle = this._axisAngle(i);
            const x = CENTER + RADIUS * Math.sin(angle);
            const y = CENTER - RADIUS * Math.cos(angle);
            svg.appendChild(this._createLine(CENTER, CENTER, x, y, '#3a3a3a'));

            const lx = CENTER + LABEL_RADIUS * Math.sin(angle);
            const ly = CENTER - LABEL_RADIUS * Math.cos(angle);
            svg.appendChild(this._createLabel(lx, ly, AXES[i].label, '#555'));
        }

        this._container.appendChild(svg);
    }

    _createSVG() {
        const svg = document.createElementNS(this._svgNS, 'svg');
        svg.setAttribute('width', SVG_SIZE);
        svg.setAttribute('height', SVG_SIZE);
        svg.setAttribute('viewBox', `0 0 ${SVG_SIZE} ${SVG_SIZE}`);
        return svg;
    }

    _axisAngle(index) {
        return (2 * Math.PI * index) / AXIS_COUNT;
    }

    _createRing(r, color) {
        const circle = document.createElementNS(this._svgNS, 'circle');
        circle.setAttribute('cx', CENTER);
        circle.setAttribute('cy', CENTER);
        circle.setAttribute('r', r);
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', color);
        circle.setAttribute('stroke-width', '0.5');
        return circle;
    }

    _createLine(x1, y1, x2, y2, color) {
        const line = document.createElementNS(this._svgNS, 'line');
        line.setAttribute('x1', x1);
        line.setAttribute('y1', y1);
        line.setAttribute('x2', x2);
        line.setAttribute('y2', y2);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', '0.5');
        return line;
    }

    _createLabel(x, y, text, color) {
        const label = document.createElementNS(this._svgNS, 'text');
        label.setAttribute('x', x);
        label.setAttribute('y', y);
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('dominant-baseline', 'central');
        label.setAttribute('font-size', '7');
        label.setAttribute('fill', color || '#888');
        label.textContent = text;
        return label;
    }
}

module.exports = RadarHUD;
