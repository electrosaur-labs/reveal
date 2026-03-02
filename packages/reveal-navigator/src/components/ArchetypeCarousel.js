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
        this._activeFilter = 'all'; // Current group filter
        this._activeSort = 'score'; // Current sort axis
        this._sortAscending = true; // Sort direction

        // Listener bookkeeping for destroy() cleanup
        this._chipListeners = [];   // [{element, event, handler}]
        this._sessionListeners = []; // [{event, handler}]

        this._initFilterChips();
        this._initSortChips();
        this._initTooltip();
        this._bindEvents();
    }

    /**
     * Clean up all event listeners and DOM content.
     * Call before discarding the carousel instance.
     */
    destroy() {
        // Remove DOM chip listeners
        for (const { element, event, handler } of this._chipListeners) {
            element.removeEventListener(event, handler);
        }
        this._chipListeners = [];

        // Remove session event listeners
        for (const { event, handler } of this._sessionListeners) {
            this._session.off(event, handler);
        }
        this._sessionListeners = [];

        // Clear card DOM (implicitly removes card-level listeners)
        this._container.innerHTML = '';
        this._cards = [];
    }

    /**
     * Initialize filter chip click handlers.
     */
    _initFilterChips() {
        this._filtersContainer = document.getElementById('carousel-filters');
        if (!this._filtersContainer) return;

        const chips = this._filtersContainer.querySelectorAll('.filter-chip');
        chips.forEach(chip => {
            const handler = () => this._setFilter(chip.dataset.group);
            chip.addEventListener('pointerup', handler);
            this._chipListeners.push({ element: chip, event: 'pointerup', handler });
        });
    }

    /**
     * Initialize sort chip click handlers.
     */
    _initSortChips() {
        this._sortContainer = document.getElementById('carousel-sort');
        if (!this._sortContainer) return;

        const chips = this._sortContainer.querySelectorAll('.sort-chip');
        chips.forEach(chip => {
            const handler = () => {
                const axis = chip.dataset.sort;
                if (axis === this._activeSort) {
                    // Same chip: toggle direction
                    this._sortAscending = !this._sortAscending;
                } else {
                    // New chip: default direction per axis
                    this._activeSort = axis;
                    // DNA: higher is better (descending), others: lower is better (ascending)
                    this._sortAscending = axis !== 'dna';
                }
                this._applySortChipState();
                this._sortCards();
            };
            chip.addEventListener('pointerup', handler);
            this._chipListeners.push({ element: chip, event: 'pointerup', handler });
        });
    }

    /**
     * Update sort chip visual state (active + arrow direction).
     */
    _applySortChipState() {
        if (!this._sortContainer) return;
        const chips = this._sortContainer.querySelectorAll('.sort-chip');
        chips.forEach(chip => {
            const isActive = chip.dataset.sort === this._activeSort;
            chip.classList.toggle('active', isActive);
            const arrow = chip.querySelector('.sort-arrow');
            if (arrow) arrow.textContent = isActive ? (this._sortAscending ? '\u25B2' : '\u25BC') : '';
        });
    }

    /**
     * Sort cards in the DOM by the active sort axis.
     */
    _sortCards() {
        const cards = Array.from(this._container.querySelectorAll('.carousel-card'));
        if (cards.length === 0) return;

        const axis = this._activeSort;
        const asc = this._sortAscending;

        // Pin order for meta-archetypes (always at top regardless of sort axis)
        const PIN_ORDER = { 'dynamic_interpolator': 0, 'distilled': 1 };

        cards.sort((a, b) => {
            const aPin = PIN_ORDER[a.dataset.id];
            const bPin = PIN_ORDER[b.dataset.id];
            const aPinned = aPin !== undefined;
            const bPinned = bPin !== undefined;
            // Pinned cards always sort to top, in their fixed order
            if (aPinned && bPinned) return aPin - bPin;
            if (aPinned) return -1;
            if (bPinned) return 1;

            let aVal, bVal;
            if (axis === 'score') {
                aVal = parseFloat(a.dataset.sortScore) || 999;
                bVal = parseFloat(b.dataset.sortScore) || 999;
            } else if (axis === 'de') {
                aVal = parseFloat(a.dataset.deltaE) || 999;
                bVal = parseFloat(b.dataset.deltaE) || 999;
            } else if (axis === 'dna') {
                aVal = parseFloat(a.dataset.dnaScore) || 0;
                bVal = parseFloat(b.dataset.dnaScore) || 0;
            } else if (axis === 'screens') {
                aVal = parseInt(a.dataset.screenCount) || 999;
                bVal = parseInt(b.dataset.screenCount) || 999;
            }
            const primary = asc ? aVal - bVal : bVal - aVal;
            if (primary !== 0) return primary;
            // Tiebreak by sortScore ascending (best composite quality first)
            const aScore = parseFloat(a.dataset.sortScore) || 999;
            const bScore = parseFloat(b.dataset.sortScore) || 999;
            return aScore - bScore;
        });

        // Re-insert sorted, update debug indices, apply recommended badges
        let recommendedCount = 0;
        for (let i = 0; i < cards.length; i++) {
            this._container.appendChild(cards[i]);

            // Recommended badges only when sorted by score (the composite metric)
            const oldBadge = cards[i].querySelector('.recommended-badge');
            if (oldBadge) oldBadge.remove();
            cards[i].classList.remove('recommended');
            if (axis === 'score') {
                const sortVal = parseFloat(cards[i].dataset.sortScore);
                if (!isNaN(sortVal) && sortVal < 900 && recommendedCount < 3) {
                    cards[i].classList.add('recommended');
                    const badge = document.createElement('div');
                    badge.className = 'recommended-badge';
                    badge.textContent = '\u2605 Top Pick';
                    cards[i].insertBefore(badge, cards[i].firstChild);
                    recommendedCount++;
                }
            }

            const debugDiv = cards[i].querySelector('.card-debug-de');
            if (debugDiv) {
                const parts = debugDiv.textContent.match(/^\d+\s(.+)$/);
                const rest = parts ? parts[1] : debugDiv.textContent;
                debugDiv.textContent = `${String(i + 1).padStart(2, '0')} ${rest}`;
            }
        }

        this._scrollToActive();
    }

    /**
     * Apply a group filter to the carousel cards.
     * @param {string} group - 'all', 'faithful', 'graphic', or 'dramatic'
     */
    _setFilter(group) {
        this._activeFilter = group;

        // Update chip highlight
        if (this._filtersContainer) {
            const chips = this._filtersContainer.querySelectorAll('.filter-chip');
            chips.forEach(chip => {
                chip.classList.toggle('active', chip.dataset.group === group);
            });
        }

        // Show/hide cards based on group
        const cards = this._container.querySelectorAll('.carousel-card');
        cards.forEach(card => {
            const cardGroup = card.dataset.group;
            const visible = group === 'all' || cardGroup === group;
            card.setAttribute('style', visible ? '' : 'display: none;');
        });
    }

    /**
     * Create a shared tooltip element for description hover.
     */
    _initTooltip() {
        this._tooltipEl = document.createElement('div');
        this._tooltipEl.className = 'archetype-tooltip';
        this._tooltipEl.setAttribute('style', 'display: none;');
    }

    /**
     * Show tooltip above a card element.
     * @param {HTMLElement} card
     * @param {string} text
     */
    _showTooltip(card, text) {
        if (!text || !this._tooltipEl) return;
        this._tooltipEl.textContent = text;
        card.style.position = 'relative';
        card.appendChild(this._tooltipEl);
        this._tooltipEl.setAttribute('style', 'display: block;');
    }

    /**
     * Hide the tooltip.
     */
    _hideTooltip() {
        if (!this._tooltipEl) return;
        this._tooltipEl.setAttribute('style', 'display: none;');
        if (this._tooltipEl.parentNode) {
            this._tooltipEl.parentNode.removeChild(this._tooltipEl);
        }
    }

    /**
     * Derive trait badges from archetype parameters.
     * @param {Object} archetype
     * @returns {string[]} Trait names
     */
    _deriveTraits(archetype) {
        const params = archetype.parameters;
        if (!params) return [];

        const traits = [];
        if (params.blackBias > 5) traits.push('High Contrast');
        if (params.vibrancyBoost > 1.3) traits.push('Vivid');
        if (params.vibrancyBoost < 1.0 ||
            (params.vibrancyMode === 'linear' && params.blackBias < 3)) {
            traits.push('Soft');
        }
        if (params.vibrancyMode === 'linear' && params.paletteReduction >= 10) {
            traits.push('Flat');
        }
        return traits;
    }

    _bindEvents() {
        const on = (event, handler) => {
            this._session.on(event, handler);
            this._sessionListeners.push({ event, handler });
        };

        // Build carousel immediately when top-match preview is ready (DNA scores only).
        on('carouselReady', (data) => {
            this._rebuild(data.scores);
        });
        // Update individual card ΔE as each archetype is scored in the background.
        on('archetypeScored', (data) => {
            this._updateCardDeltaE(data.id, data.meanDeltaE, data.targetColors, data.sortScore);
        });
        // All scored — sort by displayed ΔE (includes live values from clicked cards).
        on('scoringComplete', () => {
            this.sortByDisplayedDeltaE();
        });
        on('archetypeChanged', (data) => {
            this._activeId = data.archetypeId;
            this._updateActiveCard();
        });
        on('configChanged', (config) => {
            if (config.id && config.id !== this._activeId) {
                this._activeId = config.id;
                this._updateActiveCard();
            }
        });
        // Rebuild swatches AFTER posterization completes (not before)
        on('previewUpdated', (data) => this._refreshActiveSwatches(data));

        // Dirty indicator — orange dot when knobs OR palette surgery is customized
        on('knobsCustomizedChanged', () => {
            this._updateCustomizedBadge(this._session.isCustomized());
        });
        on('paletteChanged', () => {
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

        // Show filter and sort chips now that cards exist
        if (this._filtersContainer) {
            this._filtersContainer.setAttribute('style', 'display: flex;');
        }
        if (this._sortContainer) {
            this._sortContainer.setAttribute('style', 'display: flex;');
        }

        // Apply current filter
        if (this._activeFilter !== 'all') {
            this._setFilter(this._activeFilter);
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
        const isSynthetic = match.id === 'dynamic_interpolator' || match.id === 'distilled';
        const isActive = match.id === this._activeId;
        const card = document.createElement('div');
        card.className = 'carousel-card' + (isActive ? ' active' : '');
        card.dataset.id = match.id;
        card.dataset.group = isSynthetic ? 'specialist' : (archetype.group || 'all');

        // Score bar — ΔE drives the bar when available, otherwise DNA score
        const hasDE = match.meanDeltaE != null;
        const hasScore = match.score != null;
        const scorePercent = hasDE
            ? Math.min(100, Math.max(0, 100 - match.meanDeltaE * 4))  // Lower ΔE = fuller bar
            : hasScore ? Math.min(100, Math.max(0, match.score)) : 0;

        // Store hue indicator HTML for reverting when card becomes inactive
        const hueIndicator = this._buildHueIndicator(archetype);
        card.dataset.hueHtml = hueIndicator;

        // Trait badges
        const traits = this._deriveTraits(archetype);
        const traitsHtml = traits.length > 0
            ? `<div class="card-traits">${traits.map(t => `<span class="trait-badge">${t}</span>`).join('')}</div>`
            : '';

        const deStr = hasDE ? match.meanDeltaE.toFixed(1) : '-';
        const colorsStr = match.targetColors ? `${match.targetColors}c` : '';
        const deDisplay = hasDE && colorsStr ? `${deStr} (${colorsStr})` : deStr;
        const dnaStr = match.score != null ? match.score.toFixed(0) : '-';
        const debugBg = hasDE ? '#ff0' : '#888';
        if (match.sortScore != null) card.dataset.sortScore = match.sortScore.toFixed(2);
        if (match.meanDeltaE != null) card.dataset.deltaE = match.meanDeltaE.toFixed(2);
        if (match.score != null) card.dataset.dnaScore = match.score.toFixed(2);
        if (match.targetColors != null) card.dataset.screenCount = match.targetColors;
        const debugTitle = `${archetype.name} \u00b7 \u0394E ${deStr} \u00b7 ${colorsStr || '?c'} \u00b7 DNA ${dnaStr}`;
        card.innerHTML =
            `<div class="card-debug-de" title="${debugTitle}" style="background:${debugBg};color:#000;font-size:14px;font-weight:bold;text-align:center;">${String(sortIndex + 1).padStart(2, '0')} \u0394E=${deStr} ${colorsStr} DNA=${dnaStr}</div>` +
            `<div class="card-name">${archetype.name}</div>` +
            traitsHtml +
            `<div class="card-score-row">` +
                `<div class="card-score-bar"><div class="card-score-fill" style="width:${scorePercent}%"></div></div>` +
                `<span class="card-score-val">${deDisplay}</span>` +
            `</div>` +
            `<div class="card-hue">${hueIndicator}</div>` +
            (!isActive && !hasDE ? `<div class="card-explore-hint">Click to explore</div>` : '');

        // Store description for tooltip
        const description = archetype.description || '';
        card.dataset.description = description;

        // Click → swap archetype
        // Use pointerup instead of click: UXP scrollable containers consume
        // the first click for focus, requiring a double-click to activate.
        card.addEventListener('pointerup', (e) => {
            if (match.id !== this._activeId) {
                this._session.swapArchetype(match.id)
                    .catch(err => console.error(`[ArchetypeCarousel] swapArchetype failed: ${err.message}`));
            }
        });

        // Hover: tooltip + highlight
        card.addEventListener('mouseenter', () => {
            this._hoveredId = match.id;
            if (description) this._showTooltip(card, description);
        });

        card.addEventListener('mouseleave', () => {
            this._hoveredId = null;
            this._hideTooltip();
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
        const sep = this._session.getSeparationState();
        if (!sep) return null;
        const { rgbPalette, colorIndices } = sep;
        if (!rgbPalette || !colorIndices) return null;

        const counts = new Uint32Array(rgbPalette.length);
        for (let i = 0, len = colorIndices.length; i < len; i++) counts[colorIndices[i]]++;

        return rgbPalette.filter((_, i) => counts[i] > 0);
    }

    /**
     * Update a single card's displayed ΔE from a background scoring event.
     * Skips the active card — its ΔE is synced to the live value by previewUpdated.
     */
    _updateCardDeltaE(id, meanDeltaE, targetColors, sortScore) {
        const card = this._container.querySelector(`.carousel-card[data-id="${id}"]`);
        if (!card) return;

        const de = meanDeltaE.toFixed(1);
        const colorsStr = targetColors ? `${targetColors}c` : '';
        const scoreVal = card.querySelector('.card-score-val');
        if (scoreVal) scoreVal.textContent = colorsStr ? `${de} (${colorsStr})` : de;
        if (sortScore != null) card.dataset.sortScore = sortScore.toFixed(2);
        card.dataset.deltaE = meanDeltaE.toFixed(2);
        if (targetColors != null) card.dataset.screenCount = targetColors;
        const scoreFill = card.querySelector('.card-score-fill');
        if (scoreFill) scoreFill.style.width = Math.min(100, Math.max(0, 100 - meanDeltaE * 4)) + '%';
        const debugDiv = card.querySelector('.card-debug-de');
        if (debugDiv) {
            // Preserve sort index and DNA value, update ΔE + screen count
            const parts = debugDiv.textContent.match(/^(\d+)\s.*DNA=(.+)$/);
            const idx = parts ? parts[1] : '??';
            const dna = parts ? parts[2] : '-';
            debugDiv.textContent = `${idx} \u0394E=${de} ${colorsStr} DNA=${dna}`;
            debugDiv.style.background = '#ff0';
            // Update hover with archetype name + scores
            const name = card.querySelector('.card-name')?.textContent || '?';
            debugDiv.title = `${name} \u00b7 \u0394E ${de} \u00b7 ${colorsStr || '?c'} \u00b7 DNA ${dna}`;
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

                // Remove hue indicator and explore hint
                const hueRow = card.querySelector('.card-hue');
                if (hueRow) hueRow.remove();
                const hint = card.querySelector('.card-explore-hint');
                if (hint) hint.remove();

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
     * Re-sort carousel cards after scoring completes.
     * Switches to score sort (the composite metric) and re-sorts.
     */
    sortByDisplayedDeltaE() {
        this._activeSort = 'score';
        this._sortAscending = true;
        this._applySortChipState();
        this._sortCards();
    }

    _scrollToActive() {
        const activeCard = this._container.querySelector('.carousel-card.active');
        if (activeCard) {
            activeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
    }
}

module.exports = ArchetypeCarousel;
