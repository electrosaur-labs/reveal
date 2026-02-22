/**
 * ArchetypeCarousel - Horizontal card strip for archetype navigation
 *
 * Two-phase rendering:
 *   1. carouselReady — builds cards immediately with DNA scores (~400ms)
 *   2. scoringComplete — rebuilds with ΔE-sorted order (~7-18s background)
 *
 * Active card shows real palette swatches from proxy separation.
 * Vanilla+ pattern: subscribes to SessionState events.
 */

const Reveal = require("@reveal/core");

// Sector → approximate hue for visual indicator
const SECTOR_HUES = {
    red: 0, orange: 30, yellow: 60, chartreuse: 90,
    green: 120, cyan: 180, azure: 210, blue: 240,
    purple: 270, magenta: 300, pink: 330, rose: 345
};

class ArchetypeCarousel {

    /**
     * @param {HTMLElement} container - DOM element to render cards into
     * @param {import('../state/SessionState')} sessionState
     */
    constructor(container, sessionState) {
        this._container = container;
        this._session = sessionState;
        this._cards = [];           // Ranked archetype data
        this._activeId = null;      // Currently active archetype
        this._hoveredId = null;

        this._bindEvents();
    }

    _bindEvents() {
        // Build carousel immediately when top-match preview is ready (DNA scores only).
        this._session.on('carouselReady', (data) => {
            this._rebuild(data.scores);
        });
        // Update individual card ΔE as each archetype is scored in the background.
        this._session.on('archetypeScored', (data) => {
            this._updateCardDeltaE(data.id, data.meanDeltaE);
        });
        // All scored — sort by displayed ΔE (includes live values from clicked cards).
        this._session.on('scoringComplete', () => {
            this.sortByDisplayedDeltaE();
        });
        this._session.on('archetypeChanged', (data) => {
            this._activeId = data.archetypeId;
            this._updateActiveCard();
        });
        this._session.on('configChanged', (config) => {
            if (config.id && config.id !== this._activeId) {
                this._activeId = config.id;
                this._updateActiveCard();
            }
        });
        // Rebuild swatches AFTER posterization completes (not before)
        this._session.on('previewUpdated', (data) => this._refreshActiveSwatches(data));

        // Dirty indicator — orange dot when knobs OR palette surgery is customized
        this._session.on('knobsCustomizedChanged', () => {
            this._updateCustomizedBadge(this._session.isCustomized());
        });
        this._session.on('paletteChanged', () => {
            this._updateCustomizedBadge(this._session.isCustomized());
        });
    }

    /**
     * Rebuild the full card strip from scored archetypes.
     * @param {Array} [scores] - Pre-sorted scores (by DNA or ΔE).
     */
    _rebuild(scores) {
        if (!scores) scores = this._session.getAllArchetypeScores();
        if (!scores || scores.length === 0) return;

        const archetypes = Reveal.ArchetypeLoader.loadArchetypes();
        const archetypeMap = new Map(archetypes.map(a => [a.id, a]));

        // Active archetype from session state
        const state = this._session.getState();
        this._activeId = state.activeArchetypeId;

        this._cards = scores;

        this._container.innerHTML = '';

        for (let i = 0; i < scores.length; i++) {
            const match = scores[i];
            // Chameleon is synthetic — not in ArchetypeLoader
            const archetype = archetypeMap.get(match.id) || match._synthetic;
            if (!archetype) continue;

            const card = this._createCard(match, archetype, i);
            this._container.appendChild(card);
        }

        // Scroll active card into view
        this._scrollToActive();
    }

    /**
     * Create a single archetype card element.
     * All cards start with hue indicators; only the active card
     * gets real swatches via _refreshActiveSwatches after posterization.
     */
    _createCard(match, archetype, sortIndex) {
        const isActive = match.id === this._activeId;
        const card = document.createElement('div');
        card.className = 'carousel-card' + (isActive ? ' active' : '');
        card.dataset.id = match.id;

        // Score bar — show ΔE when available, otherwise DNA score
        const hasDE = match.meanDeltaE != null;
        const scoreLabel = hasDE ? match.meanDeltaE.toFixed(1) : match.score.toFixed(0);
        const scorePercent = hasDE
            ? Math.min(100, Math.max(0, 100 - match.meanDeltaE * 4))  // Lower ΔE = fuller bar
            : Math.min(100, Math.max(0, match.score));

        // Store hue indicator HTML for reverting when card becomes inactive
        const hueIndicator = this._buildHueIndicator(archetype);
        card.dataset.hueHtml = hueIndicator;

        const de = match.meanDeltaE != null ? match.meanDeltaE.toFixed(1) : '?';
        card.innerHTML =
            `<div class="card-debug-de" style="background:#ff0;color:#000;font-size:14px;font-weight:bold;text-align:center;">${String(sortIndex + 1).padStart(2, '0')} ΔE=${de}</div>` +
            `<div class="card-name">${archetype.name}</div>` +
            `<div class="card-score-row">` +
                `<div class="card-score-bar"><div class="card-score-fill" style="width:${scorePercent}%"></div></div>` +
                `<span class="card-score-val">${scoreLabel}</span>` +
            `</div>` +
            `<div class="card-hue">${hueIndicator}</div>`;

        // Click → swap archetype
        // Use pointerup instead of click: UXP scrollable containers consume
        // the first click for focus, requiring a double-click to activate.
        card.addEventListener('pointerup', (e) => {
            if (match.id !== this._activeId) {
                this._session.swapArchetype(match.id);
            }
        });

        // Hover highlight only (no auto-swap)
        card.addEventListener('mouseenter', () => {
            this._hoveredId = match.id;
        });

        card.addEventListener('mouseleave', () => {
            this._hoveredId = null;
        });

        return card;
    }

    /**
     * Build a small hue dot strip from archetype preferred_sectors.
     */
    _buildHueIndicator(archetype) {
        const sectors = archetype.preferred_sectors || [];
        if (sectors.length === 0) {
            return '<span class="card-swatch" style="background:#666"></span>';
        }
        return sectors.slice(0, 5).map(sector => {
            const hue = SECTOR_HUES[sector] !== undefined ? SECTOR_HUES[sector] : 0;
            return `<span class="card-swatch" style="background:hsl(${hue},60%,50%)"></span>`;
        }).join('');
    }

    /**
     * Get RGB palette colors that have at least one pixel assigned.
     * Filters out zero-coverage slots left by minVolume/merge so the
     * active card swatches match what PaletteSurgeon displays.
     */
    _getActiveRgbPalette() {
        const proxy = this._session.proxyEngine;
        if (!proxy || !proxy.separationState) return null;
        const { rgbPalette, colorIndices } = proxy.separationState;
        if (!rgbPalette || !colorIndices) return null;

        const counts = new Uint32Array(rgbPalette.length);
        for (let i = 0, len = colorIndices.length; i < len; i++) counts[colorIndices[i]]++;

        return rgbPalette.filter((_, i) => counts[i] > 0);
    }

    /**
     * Update a single card's displayed ΔE from a background scoring event.
     * Skips the active card — its ΔE is synced to the live value by previewUpdated.
     */
    _updateCardDeltaE(id, meanDeltaE) {
        const card = this._container.querySelector(`.carousel-card[data-id="${id}"]`);
        if (!card) return;

        const de = meanDeltaE.toFixed(1);
        const scoreVal = card.querySelector('.card-score-val');
        if (scoreVal) scoreVal.textContent = de;
        const scoreFill = card.querySelector('.card-score-fill');
        if (scoreFill) scoreFill.style.width = Math.min(100, Math.max(0, 100 - meanDeltaE * 4)) + '%';
        const debugDiv = card.querySelector('.card-debug-de');
        if (debugDiv) {
            const idx = debugDiv.textContent.split(' ')[0];
            debugDiv.textContent = `${idx} ΔE=${de}`;
        }
    }

    /**
     * Update which card has the 'active' highlight.
     * Does NOT refresh swatches — that's done by previewUpdated after
     * posterization completes with correct palette data.
     */
    _updateActiveCard() {
        const cards = this._container.querySelectorAll('.carousel-card');
        cards.forEach(card => {
            card.classList.toggle('active', card.dataset.id === this._activeId);
        });
        this._scrollToActive();
    }

    /**
     * Refresh swatches + stats on the active card AFTER posterization completes.
     * Also reverts all non-active cards back to hue indicators.
     *
     * @param {Object} data - previewUpdated event data (palette, elapsedMs, accuracyDeltaE)
     */
    _refreshActiveSwatches(data) {
        const cards = this._container.querySelectorAll('.carousel-card');

        cards.forEach(card => {
            const isActive = card.classList.contains('active');

            if (isActive) {
                // Active card: show real palette swatches
                const rgbPalette = this._getActiveRgbPalette();
                if (!rgbPalette || rgbPalette.length === 0) return;

                // Remove hue indicator
                const hueRow = card.querySelector('.card-hue');
                if (hueRow) hueRow.remove();

                // Create or update swatch row
                let swatchRow = card.querySelector('.card-swatches');
                if (!swatchRow) {
                    swatchRow = document.createElement('div');
                    swatchRow.className = 'card-swatches';
                    card.appendChild(swatchRow);
                }
                swatchRow.innerHTML = rgbPalette.map(c =>
                    `<span class="card-swatch" style="background:rgb(${c.r},${c.g},${c.b})"></span>`
                ).join('');

            } else {
                // Non-active card: keep real swatches if already generated,
                // otherwise restore hue indicator
                if (!card.querySelector('.card-swatches')) {
                    // No real swatches yet — ensure hue indicator is present
                    if (!card.querySelector('.card-hue')) {
                        const hueDiv = document.createElement('div');
                        hueDiv.className = 'card-hue';
                        hueDiv.innerHTML = card.dataset.hueHtml || '';
                        card.appendChild(hueDiv);
                    }
                }
            }
        });
    }

    /**
     * Show or remove the orange "customized" dot on the active card's name.
     * @param {boolean} customized
     */
    _updateCustomizedBadge(customized) {
        const activeCard = this._container.querySelector('.carousel-card.active');
        if (!activeCard) return;

        const nameEl = activeCard.querySelector('.card-name');
        if (!nameEl) return;

        // Remove existing badge if any
        const existing = nameEl.querySelector('.card-customized');
        if (existing) existing.remove();

        if (customized) {
            const dot = document.createElement('span');
            dot.className = 'card-customized';
            dot.textContent = '\u2022';
            nameEl.appendChild(dot);
        }
    }

    /**
     * Re-sort carousel cards in DOM order by their currently displayed ΔE.
     * Reads the value from each card's .card-score-val text.
     */
    sortByDisplayedDeltaE() {
        const cards = Array.from(this._container.querySelectorAll('.carousel-card'));
        if (cards.length === 0) return;

        cards.sort((a, b) => {
            const aVal = parseFloat(a.querySelector('.card-score-val')?.textContent) || 999;
            const bVal = parseFloat(b.querySelector('.card-score-val')?.textContent) || 999;
            return aVal - bVal;
        });

        // Re-insert in sorted order and update debug sort indices
        for (let i = 0; i < cards.length; i++) {
            this._container.appendChild(cards[i]);
            const debugDiv = cards[i].querySelector('.card-debug-de');
            if (debugDiv) {
                const de = cards[i].querySelector('.card-score-val')?.textContent || '?';
                debugDiv.textContent = `${String(i + 1).padStart(2, '0')} ΔE=${de}`;
            }
        }

        this._scrollToActive();
    }

    _scrollToActive() {
        const activeCard = this._container.querySelector('.carousel-card.active');
        if (activeCard) {
            activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
    }
}

module.exports = ArchetypeCarousel;
